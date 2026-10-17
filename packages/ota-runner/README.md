# Flora Runner

`@flora/runner` is an outbound controller for Flora's automatic OTA jobs. It claims
an app-scoped job, verifies a pinned Git commit and committed `flora.config.json`,
exports inside Docker, uploads the actual bundle/assets, and submits a fenced
publication receipt. It does not use an EAS account, EAS Build, or EAS Update.

## Run

Build the workspace with its locked dependencies and Node 24.19.0. Enroll a runner
for the required app IDs through Flora's operator interface. The returned token
is shown once. Store it outside the source checkout in a private file:

```json
{
  "origin": "https://flora.example.com",
  "token": "REPLACE_WITH_ONE_TIME_RUNNER_ENROLLMENT_TOKEN",
  "dockerImage": "registry.example.com/flora-export@sha256:REPLACE_WITH_VERIFIED_IMAGE_DIGEST",
  "workDirectory": "/private/runner/work",
  "recoveryDirectory": "/private/runner/recovery"
}
```

```sh
chmod 600 /private/runner/runner.json
node packages/ota-runner/dist/main.js --config /private/runner/runner.json
# Process one job and exit (including an empty queue):
node packages/ota-runner/dist/main.js --config /private/runner/runner.json --once
```

The file must be a regular file owned by the controller, without group/other
permissions or symlinks. Run as an unprivileged Unix user with Docker access.
Docker availability is checked **before** claiming work. Windows and root-run
controllers fail closed. There is no host-process exporter fallback, command
field, environment override, or HTTP-supplied image choice.

## Export image and dependency installation

The operator supplies a trusted **digest-pinned** image containing the exact Node
and package-manager versions declared by the app. `examples/Dockerfile` is an
image template, not a prebuilt or tested image. Build it, inspect it, and use its
registry digest or immutable local `sha256:<64 hex>` image ID. Images must be
preloaded: both containers use `--pull=never`. The app itself must lock and include
its Metro dependency (or Expo CLI for the optional `expo` adapter).

Docker runs as the controller's nonzero UID/GID, with matching tmpfs ownership.
The source directory stays private (0700). The engine must map that identity to
the bind-mounted files. For rootless Docker/user namespace remapping, provision
compatible ID-mapped mounts; an unreadable source fails rather than relaxing
permissions. Only the verified source and a small public trusted helper directory
are mounted read-only. The Docker socket, controller files, credentials and home
directory are never mounted.

The default network is `none`. Seed `/opt/flora/cache` in the trusted image for
offline dependencies, using the package manager's cache format. A missing cache
fails installation. An optional operator-only `dockerNetwork` may name a separate
restricted egress network; `host`, `bridge`, and `default` are rejected. Such a
network must block the host, private networks and cloud metadata endpoints and
permit only the required registry. A Docker network name alone does not enforce
that policy.

Installation uses `npm ci`, `pnpm install --frozen-lockfile`, or Yarn's immutable /
frozen-lockfile mode. Install scripts and repository bundler/config code run only
in the bounded container. A regular lockfile is required at the app root. This
initial implementation supports an app-root lockfile; it does not infer a parent
monorepo workspace install.

The default container has a read-only root filesystem, no Linux capabilities, no new
privileges, 128 PIDs, 1 GiB memory (no additional swap), 2 CPUs, 768 MiB writable
workspace, 64 MiB temporary space and 65 MiB output space. Installation has a
10-minute deadline; export has 5 minutes; the whole Docker invocation has 15
minutes. Child diagnostics are bounded and are not echoed into controller logs.

### GitHub-hosted npm profile

The explicit operator configuration below enables preparation for an npm v3
lockfile and the bounded GitHub-hosted resource profile. Repository jobs cannot
choose these options or an image. The trusted image must contain exactly Node
24.19.0 and npm 10.9.8; preparation checks both before installation.

```json
{
  "origin": "https://flora.example.com",
  "token": "REPLACE_WITH_SHORT_LIVED_APP_SCOPED_TOKEN",
  "dockerImage": "sha256:REPLACE_WITH_VERIFIED_LOCAL_IMAGE_ID",
  "resourceProfile": "github-hosted",
  "dependencyPreparation": "npm-registry",
  "publicationRecovery": "remote-checkpoint",
  "recoveryDirectory": "/private/runner/recovery"
}
```

Each preparation/export container is limited to 4 GiB RAM with no additional
swap, 2 CPUs, 128 PIDs, a 3 GiB tmpfs workspace, 64 MiB temporary storage and
65 MiB output storage. The existing attempt deadline still bounds the complete
source/preparation/export/upload/publication attempt. Docker tmpfs counts against
the container's memory limit; the sizes are maxima, not allocated extra RAM.

The controller reads the already verified checkout without evaluating code. It
accepts at most 2,000 npm lock entries, an 8 MiB v3 lockfile, canonical SHA-512
integrity values and fixed HTTPS `registry.npmjs.org` tarball URLs. Git dependencies,
other origins, credentials/query parameters, workspace links, npm aliases and
ambiguous paths fail closed. Local tarballs must be bounded `vendor/*.tgz` files
with matching SHA-512 bytes (16 MiB each, 64 MiB total). Only a sanitized package
manifest, the audited lockfile and those vendor files enter preparation.

Preparation uses a separate container with the Docker bridge network and
`npm ci --ignore-scripts --no-audit --no-fund`. No repository JavaScript, Expo
configuration, `.npmrc`, controller token, GitHub token or Docker socket is mounted.
User/global npm configuration is disabled and the registry is fixed. This audits
the inputs and suppresses lifecycle scripts; it is **not an egress firewall** and
does not assert that Docker bridge networking independently restricts origins.
See [npm ci](https://docs.npmjs.com/cli/v10/commands/npm-ci/) for script behavior.

The npm cache is first written inside the bounded tmpfs workspace. After npm has
exited, the trusted helper rejects symlinks/non-files and limits the static cache
to 1 GiB and 12,000 entries before copying it into a fresh private cache directory.
That directory is the sole writable host bind during preparation. The compiler
mounts it read-only, copies it into tmpfs, runs `npm ci --offline`, and exports with
`--network=none`. Actual lifecycle scripts and bundler/config code run only there.
The source and small public helper are read-only; no host exporter fallback exists.
Both unique containers must be confirmed absent and temporary seed/cache/helper
directories are disposed after the attempt.

### Ephemeral CI recovery

Private disk fsync alone cannot preserve a receipt after a GitHub VM disappears.
`publicationRecovery: "remote-checkpoint"` requires the explicit GitHub-hosted
profile and a server admitting short-lived app-scoped runner sessions. Before any
claim or Docker execution, the CLI lists remote checkpoints, restores them as
validated private journals, and reconciles the original receipts.

Before the first publication call, the CLI fsyncs its private journal and waits
for server checkpoint acknowledgment. The server record contains only the exact
origin, fenced lease and receipt; it excludes tokens and source/export bytes.
Checkpoint failure stops before publication. A verified original publication
result precedes local journal removal and remote checkpoint clearing. Ambiguous
finalize responses retain proof for a fresh VM to reconcile with the same stable
runner identity and a new authorized session.

An authoritative HTTP 409 `LEASE_STALE`/`LEASE_EXPIRED` response allows only a
`checkpoint-clear` request with `expectedDisposition: "stale"`. The server must
prove the exact app/job/attempt and canonical receipt digest are permanently fenced
out. Only this validated stale proof removes a local unsubmitted journal. Active,
committed, absent, foreign and ambiguous results retain it and stop; an absent
checkpoint alone never proves that publication did not occur. The normal persistent
controller mode keeps its existing explicit local reconciliation behavior.

## Pinning and artifacts

The controller requests a repo-read installation token for the queued connection.
It uses fixed GitHub origins, refuses redirects, checks the complete tree before
fetching, fetches exactly the queued 40-character SHA, disables hooks/global Git
config/submodules, and verifies detached `HEAD`, a clean tree, the app root and the
committed neutral config. Symlinks, untracked changes and oversized trees fail.
The source token exists only in source-fetch controller/child memory; the export
container never receives it or the runner bearer token. GitHub's underlying token
lifetime may outlast a revoked Flora lease.

Source trees are limited to 64 MiB and 10,000 tracked entries. Git object storage
is monitored during fetch with a 100 ms polling guard and 8 MiB pack overhead
allowance. Use a quota-backed work volume for a hard disk cap: polling can
overshoot by bytes written during an interval and is not a strict network-byte
quota. The full tracked checkout is limited again after fetch.

Metro uses the app's actual Metro installation and emits its real asset metadata;
Expo uses the installed open-source CLI's `config --json` and `export` commands.
Resolved Expo runtime/update settings must match the queued config. No project
shell command is accepted. Every exported file must be a regular, non-symlink,
single-link file inside the output root. Metadata asset keys are preserved and
uploaded bytes are hashed with SHA-256. Limits are 16 MiB per file, 64 ancillary
assets, and 64 MiB total. Unsupported metadata, extensions, duplicate keys,
malformed bytes or a runtime/SHA mismatch stop publication.

For the Flora native engine, commit a public `flora.connection.json` containing
exactly `appId`, `url`, `channel`, `runtimeVersion`, `certificate`, and `keyId`.
The container snapshots that bounded file before dependency installation. The
resolved `@flora/ota/plugin` options must match all six fields and explicitly set
`disableExpoUpdates: true`; the app ID, HTTPS destination, channel, runtime and
requested platform must match the queued job. The public certificate must be a
single RSA certificate with a 2048–8192-bit key. Credentials, another app's URL,
missing or duplicate plugins, and competing EAS destinations fail closed.
`expo-updates` must resolve `enabled: false` for this path. The optional legacy
Expo update engine remains supported for sources without a Flora connection or
plugin, and still requires its exact queued update URL and runtime.

The receipt records the exact source SHA, config/toolchain digests, tracked-source
digest, uploaded asset IDs and a canonical artifact digest. It is a
Bearer-authenticated runner attestation outside the repository process, **not**
an independent build signature. Optional OTA manifest signing is a separate
server/native-engine trust mechanism.

## Lease and failure handling

Asset uploads retry only transport failures or HTTP 5xx, at most three times with
bounded backoff. Every retry uses the same bytes, asset metadata and captured
fenced lease; cancellation or insufficient lease time stops before another call.
Heartbeat continues while uploading. Authentication, scope, conflict, malformed
asset and other authoritative failures are not retried. Content-addressed server
storage makes a response lost after an accepted upload safe to replay.

Heartbeat failure cancels execution. Before finalization, the periodic heartbeat
is stopped/drained and the lease is renewed once with at least 35 seconds
remaining. Each finalization request has a 10-second transport deadline. Network
failures and HTTP 5xx retry the **same lease and exact receipt**, at most three
times with bounded backoff; no heartbeat runs during finalization. Authentication,
revocation and conflict errors are not retried. Transient claim failures also have
a three-attempt bounded budget; authoritative failures stop the daemon. The server verifies current scope, credential epoch, attempt,
fence and deadline atomically with asset/publication writes. A cancelled, revoked
or stale attempt cannot publish. The controller does not provide authority to
another app.

After every attempted Docker run, force removal is followed by a daemon query
proving that the unique container name is absent. If cleanup cannot be confirmed,
the daemon stops with `ISOLATION_CLEANUP_UNCONFIRMED`; the operator must resolve
the container/daemon before restarting.

Before publication, the production CLI exclusively writes and fsyncs a private
0600 recovery journal in an owner-only 0700 directory outside the export checkout.
It contains only schema version, origin, fenced lease and exact receipt: no runner
token, GitHub grant, source bytes or export bytes. `recoveryDirectory` is optional
in the private config and defaults to `recovery/` beside that config. Use a
persistent controller volume, outside any disposable build checkout. Library
callers must explicitly supply `recoveryDirectory` and a client identity to get
this durability guarantee; the production CLI always supplies them.

A verified successful response deletes and syncs the journal. If the outcome
remains uncertain or the response cannot prove the original app/job/receipt,
`publication_unknown` includes its absolute `recoveryJournal` path and the daemon
stops with `PUBLICATION_RECONCILIATION_REQUIRED`. Ordinary CLI startup also stops
when pending journals exist. It never silently overwrites a journal or claims a
new job while recovering:

```sh
node packages/ota-runner/dist/main.js --config /private/runner/runner.json \
  --reconcile /private/runner/recovery/job_ID.attempt_ID.json
```

Reconciliation validates an owner-only regular single-link file, rejects symlinks
and extra fields, binds its origin and runner ID to the private config, and sends
only the stored lease/receipt to the original finalization endpoint. It performs
no Docker check, claim, heartbeat, source download, export or upload. A server
that already committed the original receipt returns that publication even after
the lease expired, provided the original credential remains authorized. Only a
verified original success clears the journal. Auth/revocation/stale/conflict or
transport failures retain it and exit nonzero; resolve them through the operator
workflow rather than editing the record or automatically queueing another job.
Revoked credentials cannot be replaced with another runner identity for replay.

## Verification evidence

`test/e2e.test.ts` creates two real Git repositories, verifies their committed
Flora configs, sends signed GitHub push webhooks over a real local HTTP server,
checks delivery replay idempotency, runs actual Metro 0.84.5 in real Node child
processes, exports a PNG, uploads with app-scoped bearer credentials/lease headers,
finalizes through SQLite, and reads public manifests and exact bundle/asset bytes.
It checks original source SHA, actual Metro asset key and cross-app asset denial.
The same two-app HTTP/SQLite test commits a publication before intentionally
losing all three responses for one app, then reconciles the saved receipt with
exactly one deployment. The other app loses two committed responses and succeeds
on the third identical replay. Private-file, rejected reconciliation, restart
guards and bounded claim retry tests cover the recovery control flow.

That fixture's host executor and local Git source are **test-only** and cannot be
selected by the production CLI. The test reuses the installed Metro dependency;
it does not prove container dependency installation. Docker cleanup tests use a
fake Docker control executable to exercise failure semantics. Docker is absent
in the current verification environment, so actual container execution, external
GitHub authentication, a production runner image, and device/native-engine OTA
loading remain unverified. Multi-scale React Native assets require native-engine
integration testing. No EAS service or real credential is used by the tests.

`test/expo.test.ts` exercises native identity/trust substitutions and the optional
legacy gate. With `FLORA_RUNNER_EXPO_TEST_APP` pointing to an inspected Expo 57
app that already has `@flora/ota` installed, it also runs the real open-source
Expo CLI against a temporary minimal app, reads the emitted bundle, and confirms
that a stale EAS destination stops before export output is created. This opt-in
fixture uses the installed app's dependencies and has no operator credentials;
it proves the export helper, not Docker installation or native device loading.

GitHub-hosted compute for private applications must run in those applications'
repositories, subject to their included allowance and a zero-spend budget. A caller
push workflow can invoke an immutable trusted reusable Flora workflow. GitHub OIDC
is exchanged by the trusted controller for a short-lived per-app bearer session;
static Flora/GitHub/signing secrets are not placed in the app repository workflow.
The source compiler receives no OIDC or bearer credentials and remains in Docker.
A public controller repository is not a free-compute proxy for unrelated private
applications. Workflow installation, billing-budget readback and actual remote
container execution require separate live evidence; package unit tests do not
establish them.
