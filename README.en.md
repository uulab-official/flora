# Flora

[한국어](README.md) · [English](README.en.md) · [Apache-2.0](LICENSE)

**An open-source app management and OTA platform, run with your apps, GitHub and PC.**

Connect each app and GitHub repository in Flora. An awake PC Runner exports commits and publishes app-scoped OTA updates. Install the Flora SDK, including its own iOS and Android engines, in your apps. **No EAS account, EAS API or GitHub Actions is required.**

```text
GitHub push → Flora's app-scoped policy and job queue → Docker export on your PC
            → OTA publication → installed app downloads, applies and restarts → app history
```

Flora is currently a single-owner self-hosting preview. The SDK is not published to npm. A local CLI and authenticated web wizard guide initial installation. This guide uses **D1 asset storage and an independent PC Runner**. It does not assume UULab's dedicated GitHub Release repository or LaunchAgent is a general installation feature.

## Follow the path to your first OTA

| Step | Completion check |
| --- | --- |
| 1. Install Flora | Build succeeds; doctor reports `readiness.ready: true` |
| 2. Prepare the server | Owner can sign in at your HTTPS address and open the project list |
| 3. Register GitHub and the app | The intended repository and app root are connected |
| 4. Integrate the SDK and native engine | A Release binary with the public configuration is installed |
| 5. Register the PC Runner | App-specific token and Docker image are ready; actual presence arrives |
| 6. Publish automatically | That commit's iOS and Android jobs each show `OTA 게시 완료` |
| 7. Verify the device | The same deployment's details show download, application and restart results |

This guide connects an existing **React Native 0.86.3 app**. Do not assume other RN versions are supported. Expo 57 apps can use the optional plugin without EAS. Creating a new app or obtaining store developer accounts is outside this installation procedure.

### 1. Clone and build Flora

Prepare Node **24.19.0**, npm, Git and an internet connection. A global pnpm installation is unnecessary. Run these from the repository root, one command at a time; stop when a command fails.

```sh
node --version
npm --version
git --version
git clone https://github.com/uulab-official/flora.git
cd flora
npm exec --yes --package=pnpm@11.19.0 -- pnpm install --frozen-lockfile --ignore-scripts
npm exec --yes --package=pnpm@11.19.0 -- pnpm build
npm exec --yes --package=pnpm@11.19.0 -- pnpm flora doctor --strict --json
```

Node must report `v24.19.0`. Check for `readiness.ready: true` and exit code 0. `nativeBuildVerified: false` is expected: doctor does not certify a cloud connection or native build. On Windows, use `npm.cmd` if PowerShell blocks `npm.ps1`; do not weaken the execution policy. The local web/CLI demo works on Windows, but the PC export controller requires a **non-root macOS/Linux user and working Docker**. Deployment/Runner shell and heredoc examples below are for macOS/Linux.

To inspect a fictional example without an account, seed it with `node scripts/dogfood-demo.mjs`, then run `node scripts/dogfood-demo.mjs --serve` and open its one-time URL. This synthetic demo does not connect real GitHub or OTA; a `blocked` run is expected. It uses a separate demo database instead of your operational database. Stop it with Ctrl+C.

### 2. Start the installation wizard

From the built Flora checkout, sign into pinned Wrangler and start setup. A new server needs your Cloudflare account, free-plan usage headroom and a domain you control.

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm --filter @app-ops/cloudflare exec wrangler login
npm exec --yes --package=pnpm@11.19.0 -- pnpm flora setup
```

- `new`: enter the account ID, zone ID, new HTTPS origin and owner email. Unique suffixes keep new Worker/D1 names separate. Review the exact scope and current free-plan headroom. After schema, locked deployment and HTTPS checks, setup writes a **10-minute first-owner approval code** to a new private directory on your PC. The terminal displays its path, never the code. Open that file yourself and enter the code at the HTTPS `/setup` page. Set the password only in that page; keep code/password/callback URLs out of Git and logs.
- `existing`: enter your existing HTTPS origin and continue to `/login?returnTo=%2Fonboarding`. Existing data, owner, keys and history stay intact. `flora.uulab.co.kr` is UULab's installation, not a public demo.
- `runner`: configure an app-scoped PC Runner as described in step 5.

After you verify sign-in using the new password, acknowledge it in the CLI. Setup removes only `FLORA_SETUP` to close initial enrollment. Open `/onboarding` (**Flora 시작하기**) for owner → GitHub → app/SDK → PC Runner → first OTA. Do not type a password or Cloudflare credential into the CLI. Existing Wrangler auth is captured privately in memory only for fixed Cloudflare read APIs, with disk logging disabled. Fixed Wrangler commands perform mutations.

To inspect or resume, use the **same** private journal path printed during setup:

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm flora setup inspect --state /ABSOLUTE/PRIVATE/journal.json --json
npm exec --yes --package=pnpm@11.19.0 -- pnpm flora setup --resume /ABSOLUTE/PRIVATE/journal.json
```

Pending/`unknown` means a mutation result needs reconciliation. Do not create a replacement installation or token. Expiry, lost replies, changed source or provider drift stop safely; consult the [manual/recovery reference](#self-host-a-new-server). Unknown mutations are not replayed automatically. Unverified permissions, usage headroom or public DNS/TLS are incomplete setup.

**If only the approval code expired before enrollment**, explicitly renew using the same journal. If you already enrolled, check `/login` first.

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm flora setup renew --state /ABSOLUTE/PRIVATE/journal.json
```

`renew` requires matching Worker/D1/DO, deployment fingerprints and immutable identity. A fixed read-only Cloudflare SQL query must confirm an unclaimed owner, no active sessions and a closed prior window. Existing Wrangler auth stays in memory; no password verifier or session value is retrieved. Old code/configuration files and issuance history remain intact; a new 10-minute generation is written to `approval-code-g2.txt`, and so on. Old codes cannot enroll. Renewal is never automatic and is limited to six explicit renewals. Enrolled owners, missing journals/old code files, drift, and pending/unknown operations are refused. After enrollment and verified sign-in, use the same `--resume` command to close setup. This does not recover existing owner passwords or adopt existing servers.

### 3. Connect GitHub and register apps in the web wizard

1. In `/onboarding`, choose **GitHub 연결·프로젝트 등록**. Leave the organization blank for a personal account and choose **GitHub에서 연결 앱 만들기**.
2. Complete GitHub sign-in, reauthentication, App creation and repository installation approval yourself. Choose **Flora에서 연결 완료** on callback to return to the wizard. GitHub login and the App's repository access scope are separate.
3. Select repository, project name and root: `.` for a single app, or an app folder such as `apps/mobile`. An existing repository/root reuses its app; two repositories register as two separate apps.
4. Connect a verification ref on the source page. Preserve production branches/channels. If a repository is missing, add it in the GitHub App installation while retaining existing selections, then refresh Flora's list.

### 4. Commit the SDK/configuration and build the first binary

In the **Flora repository**, create an SDK tarball. The output directory must be a new path.

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm sdk:pack --out /ABSOLUTE/NEW/sdk-packages
```

Check the archive path and SHA-256 in the output JSON. Copy `flora-ota-0.3.2.tgz` into `vendor/` in the **app repository**, then install it with that app's package manager. For an npm app:

```sh
# Run at the app repository root.
npm install --ignore-scripts --no-audit --no-fund ./vendor/flora-ota-0.3.2.tgz
```

Check that the SDK dependency in `package.json` uses a relative `file:vendor/...` path. **Commit the tarball, manifest and lockfile together.** An absolute `file:/Users/...` path or Flora workspace dependency cannot be installed by an independent Runner. Do not convert an existing pnpm/Yarn app to npm or delete its lockfile. Select a supported preparation path from the Runner table below.

In the wizard's **앱·SDK**, review runtime, channel, platforms, entry and tool versions, then choose **설정 확인·공개 파일 생성**. Download `flora.connection.json` and `flora.config.json` to the app root. Public certificate and key ID are included automatically; no DevTools or manual JSON authoring is needed. Review existing files before replacing them. File generation does not install the SDK or prepare the first binary.

Defaults are Node/npm 24.19.0/10.9.8 and Metro/index.js. Match your actual lockfile and entry. Check the supported pnpm workspace conditions in step 5.

**Installing the SDK does not add an OTA engine to an existing binary.** For a bare RN app, integrate the following native hooks, then install a new binary using the app's existing Xcode/Gradle Release build procedure. iOS builds need a Mac, Xcode and CocoaPods; Android builds need the app's compatible JDK and Android SDK. OTA export itself does not require Xcode or store signing keys.

| Location | Configuration |
| --- | --- |
| iOS `Info.plist` | Set `FloraOTAAppId`, `FloraOTAUpdateURL`, `FloraOTAChannel`, `FloraOTARuntimeVersion`, `FloraOTACertificate` and `FloraOTAKeyId` to match the public connection |
| iOS RN delegate | `import FloraOta`; make `bundleURL()` return `FloraOTAController.bundleURL(embedded: embeddedBundleURL)` on every call. After SDK autolinking, run `pod install`; include the embedded JS bundle |
| Android `android/app/src/main/assets/flora_ota_config.json` | Use the same six fields as `flora.connection.json` |
| Android `reactHost` | Use `FloraReactHost.create(applicationContext, PackageList(this).packages)`. Changing the bundle path only at startup is insufficient for a Release restart |

In JS, run this flow once after the first screen and essential initialization have succeeded. Confirm the current launch before downloading; one engine must own update processing.

```ts
import { createFloraClient } from '@flora/ota';
import { createFloraNativeEngine } from '@flora/ota/native';

export async function updateAfterAppIsReady() {
  const engine = createFloraNativeEngine();
  const launch = await engine.getLaunchInfo();
  const ota = createFloraClient(await engine.getNativeConfiguration(), engine);
  await engine.markLaunchSuccessful(launch.updateId);
  const checked = await ota.checkForUpdate();
  if (!checked.available) return;
  const downloaded = await ota.downloadUpdate();
  if (downloaded.downloaded) await ota.reload();
}
```

In a real app, surface failures in the UI and offer a later retry. Do not mark every launch successful before rendering/essential initialization, or retry indefinitely. Expo 57 apps use the same public configuration with `@flora/ota/plugin` and `disableExpoUpdates: true`, then require a new binary. Complete Swift/Kotlin and Expo examples are in the [native integration guide (Korean)](docs/development/native-ota.ko.md) and [SDK README](packages/ota-sdk/README.md).

Review and commit the SDK, public configuration, lockfile and native/JS changes to the app repository's **verification branch**, then push. Exclude private keys and avoid `git add .`. Use `[skip ci]` in the commit message to skip push/PR Actions workflows; Flora's push webhook is separate. In Flora, choose **Sync GitHub source · Detect app** (`GitHub 소스 동기화 · 앱 인식`) and confirm the SHA, runtime, platforms and neutral export configuration were detected.

### 5. Configure an app-scoped PC Runner

Use a non-root macOS/Linux user, running Docker and at least 2 GiB free disk. Check [Docker installation and free-use terms](https://docs.docker.com/engine/install/) for your account. Your PC needs no public port, Tunnel or EAS login.

In **PC Runner → 현재 앱에 Runner 등록**, obtain the one-time token and download its public binding file. Keep the same app's `flora.connection.json` ready, then run in the Flora checkout:

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm flora setup runner
```

Enter absolute paths to the binding/SDK files and a new private runtime directory. Token input has no echo; files use 0600 and directories 0700. App/origin/Runner mismatches are rejected before claim. Only a validated local Unix Docker socket is supported; remote TCP daemons are rejected.

| Preparation | Supported conditions |
| --- | --- |
| `npm-registry` | Node 24.19.0 / npm 10.9.8, app-root v3 package-lock, validated registry/vendor tarballs |
| `pnpm-registry` | Node 24.19.0 / pnpm **11.10.0**, supported repository-root workspace and app importer |
| Other | Outside automatic wizard preparation; consult the [Runner reference](packages/ota-runner/README.md) |

Enter a previously verified immutable `sha256:` image ID, or leave blank to build from Flora's fixed public-tool Dockerfile. App source, secrets and tokens never enter the image. Flora development pnpm 11.19.0 and app Runner pnpm 11.10.0 are separate pins. After image/tool and exact Runner presence checks, explicitly choose foreground execution.

Polling starts at 30 seconds and backs off to five minutes when idle. Presence does not prove export/publication success. Ctrl-C stops only this execution. Reuse the same files/directory to verify fingerprints and scope without issuing a new token. Existing config, recovery journals and `fatal-stop` are preserved.

A powered-off/sleeping PC or closed terminal cannot process jobs. The generic wizard does not install an autostart service. UULab's specific LaunchAgent is an [operator reference](docs/development/local-pc-runner.ko.md); review its names/paths before adapting it.

### 6. Publish iOS and Android OTA from a commit

1. In the app's **PC Runner**, enable **Automatic OTA on GitHub push** (`GitHub push 시 자동 OTA`), select `iOS + Android` and channel `preview`, then choose **Save GitHub push policy** (`GitHub push 정책 저장`). Resolve any missing source detection or active Runner first.
2. Change JS, such as screen text, without changing native configuration. The selected root, ref, runtime and channel must match the binary installed in step 4.
3. This example assumes `App.tsx` and branch `flora-onboarding`. Substitute the actual file and branch connected in Flora, and stage **only those changes**.

```sh
git add -- App.tsx
git diff --cached --stat
git commit -m "feat: verify Flora OTA [skip ci]"
git push origin HEAD:flora-onboarding
```

In Flora's **PC Runner**, check both iOS and Android jobs for that SHA. Expect **Waiting for Runner → Runner working → OTA published** (`Runner 대기 → Runner 작업 중 → OTA 게시 완료`). Do not force-update the branch. Use GitHub's [official workflow-skip rules](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs); do not dispatch workflows manually.

### 7. Verify publication and device adoption separately

Open the installed Release app and execute the step 4 update flow. Under **OTA deployments → that deployment** (`OTA 배포 → 해당 배포`), confirm the app, platform, SHA, runtime and channel, then inspect each installation's download, application and restart results. `OTA 게시 완료` alone does not establish device adoption.

For a failure, inspect the cause and later recovery events in the same details. Restore connectivity before retrying `NETWORK_UNAVAILABLE`/`TIMEOUT`. For `SIGNATURE_INVALID`/`ASSET_HASH_MISMATCH`, resolve the certificate or download integrity issue before applying. Do not estimate a success rate without device reports. You can roll a problematic deployment back to an earlier successful deployment while preserving the original failure/recovery history.

For two apps, create separate project IDs, signing settings, Runner tokens/directories and policies. Check that one app's OTA does not appear in the other app's list or devices. Device validation requires a compatible installed binary on each platform.

## Self-host a new server

The following is a manual configuration/recovery reference. New installations should start with `flora setup` above. Do not mix manual reissuance with the wizard journal for the same installation.

Skip this procedure if your installation already supports owner login. This is an **operator-managed manual preview**, with no general safe setup-token CLI or authentication-database restore tool yet. First-owner enrollment below is only for **a new dedicated database and new Worker**. For an existing installation, use the [operations/recovery guide (Korean)](docs/development/password-hosting.ko.md).

Prepare a Cloudflare account and an active zone/HTTPS hostname you control. Check SQLite DO/D1 availability on Workers Free and the account-wide free limits. A paid upgrade, R2 subscription or payment is not required. Review [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [D1 commands](https://developers.cloudflare.com/d1/wrangler-commands/) and [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) for your account. Domains, PC power, developer accounts and quotas are not guaranteed to be free or unlimited.

**Server A — private configuration and dedicated database.** From the Flora repository, sign into Wrangler yourself and create a dedicated D1 database. Choose a name unique in your account. Do not apply this example to an existing database.

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm --dir packages/cloudflare exec wrangler login
npm exec --yes --package=pnpm@11.19.0 -- pnpm --dir packages/cloudflare exec wrangler whoami
npm exec --yes --package=pnpm@11.19.0 -- pnpm --dir packages/cloudflare exec wrangler d1 create flora-first
export FLORA_PRIVATE="$HOME/.flora-first-server"
```

This documentation recipe only creates a new private directory and configuration; it refuses an existing path. After running it, use a local editor to change `name` to a new, unused Worker name in your account, then fill in the account ID, D1 name/UUID, owner email and an unused exact HTTPS hostname/origin. Do not overwrite an existing Worker named `flora-first`. Do not change the owner/database identity UUIDs after creation.

```sh
node --input-type=module <<'JS'
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
const dir = resolve(process.env.FLORA_PRIVATE);
const checkout = resolve('.');
if (dir === checkout || dir.startsWith(checkout + sep)) throw Error('PRIVATE_CONFIG_OUTSIDE_CHECKOUT_REQUIRED');
await mkdir(dir, { mode: 0o700 }); // No recursive creation: reject existing paths.
const cfg = JSON.parse(await readFile('packages/cloudflare/wrangler.example.jsonc', 'utf8'));
delete cfg.$schema;
delete cfg.build; // Build explicitly below.
cfg.name = 'flora-first';
cfg.account_id = 'REPLACE_WITH_ACCOUNT_ID';
cfg.main = resolve('packages/cloudflare/dist/hosted/worker.js');
cfg.assets.directory = resolve('packages/cloudflare/dist/hosted/public');
cfg.d1_databases[0].migrations_dir = resolve('packages/cloudflare/migrations');
cfg.d1_databases[0].database_name = 'REPLACE_WITH_CREATED_D1_NAME';
cfg.d1_databases[0].database_id = 'REPLACE_WITH_CREATED_D1_UUID';
cfg.vars = { FLORA_ORIGIN: 'https://YOUR_FLORA_HOST', FLORA_OWNER_EMAIL: 'OWNER@YOUR_DOMAIN',
  FLORA_OWNER_ID: randomUUID(), FLORA_DB_IDENTITY: randomUUID() };
cfg.routes = [];
await writeFile(join(dir, 'wrangler.json'), JSON.stringify(cfg, null, 2), { mode: 0o600, flag: 'wx' });
JS
```

**Server B — schema and immutable identity.** Once you fill in the values, run the following. `--remote` changes your actual resources. Stop on an error and resolve its cause on the same resource.

```sh
node scripts/build-cloudflare.mjs --deployment-config "$FLORA_PRIVATE/wrangler.json"
npm exec --yes --package=pnpm@11.19.0 -- pnpm --dir packages/cloudflare exec wrangler deploy --dry-run --config "$FLORA_PRIVATE/wrangler.json" --outdir "$FLORA_PRIVATE/dry-run"
npm exec --yes --package=pnpm@11.19.0 -- pnpm --dir packages/cloudflare exec wrangler d1 migrations list FLORA_DB --remote --config "$FLORA_PRIVATE/wrangler.json"
npm exec --yes --package=pnpm@11.19.0 -- pnpm --dir packages/cloudflare exec wrangler d1 migrations apply FLORA_DB --remote --config "$FLORA_PRIVATE/wrangler.json"
npm exec --yes --package=pnpm@11.19.0 -- pnpm --dir packages/cloudflare exec wrangler d1 execute FLORA_DB --remote --config "$FLORA_PRIVATE/wrangler.json" --command 'SELECT singleton,owner_id,origin,db_identity FROM flora_deployment;'
```

**Only if the new database has no marker row**, put the following in private `identity.sql`, using the exact `FLORA_OWNER_ID`, `FLORA_ORIGIN` and `FLORA_DB_IDENTITY` values from `wrangler.json`. If a row exists, only compare it and skip the INSERT. If any value differs, stop; do not deploy or change identifiers. Do not UPDATE, REPLACE or delete it.

```sql
INSERT INTO flora_deployment(singleton, owner_id, origin, db_identity)
VALUES (1, 'ACTUAL_OWNER_UUID', 'https://ACTUAL_FLORA_HOST', 'ACTUAL_DB_IDENTITY_UUID');
```

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm --dir packages/cloudflare exec wrangler d1 execute FLORA_DB --remote --config "$FLORA_PRIVATE/wrangler.json" --file "$FLORA_PRIVATE/identity.sql"
npm exec --yes --package=pnpm@11.19.0 -- pnpm --dir packages/cloudflare exec wrangler deploy --config "$FLORA_PRIVATE/wrangler.json"
```

This first deploy has no route and therefore no public address. Add one Custom Domain for your origin to `routes` in the private configuration and deploy again, for example: `[{"pattern":"ACTUAL_FLORA_HOST","zone_id":"ACTUAL_ZONE_ID","custom_domain":true}]`. Keep `workers_dev: false`, `preview_urls: false`, `run_worker_first: true` and the SQLite DO binding/migration. Check `/login` returns 200 and unauthenticated `/api/state` returns 401, using GET rather than HEAD.

**Server C — enroll the first owner.** Once DNS/TLS is ready, run this recipe locally yourself. It writes the token only to a private file, does not print it and expires it after ten minutes. `generation: 1` is only for this new installation's first issuance. Do not reuse it for an installation with prior issuance/enrollment or for renewal after expiration.

```sh
node --input-type=module <<'JS'
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
const file = join(process.env.FLORA_PRIVATE, 'wrangler.json');
const cfg = JSON.parse(await readFile(file, 'utf8'));
if (cfg.vars.FLORA_SETUP !== undefined) throw Error('SETUP_WINDOW_ALREADY_PRESENT');
const bytes = randomBytes(32), issuedAt = Date.now();
const setup = { digest: createHash('sha256').update(bytes).digest('hex'), issuedAt,
  expiresAt: issuedAt + 600000, generation: 1, purpose: 'enroll' };
await writeFile(join(process.env.FLORA_PRIVATE, 'first-owner.json'),
  JSON.stringify({ token: bytes.toString('base64url'), setup }, null, 2), { mode: 0o600, flag: 'wx' });
cfg.vars.FLORA_SETUP = setup;
await writeFile(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
JS
node scripts/build-cloudflare.mjs --deployment-config "$FLORA_PRIVATE/wrangler.json"
npm exec --yes --package=pnpm@11.19.0 -- pnpm --dir packages/cloudflare exec wrangler deploy --config "$FLORA_PRIVATE/wrangler.json"
```

Within ten minutes, open your HTTPS `/setup`. Choose **Initial enrollment** (`최초 등록`) and personally enter the configured owner email, the token read in a local editor from `first-owner.json`, and a new password of **at least 15 characters**, twice. Do not put accounts, tokens or passwords into chat, URLs or public logs. The recipe ensures the server configuration receives the decoded 32-byte token's SHA-256, not a hash of the encoded token string.

After a successful login, remove **only `vars.FLORA_SETUP`** from the private configuration, then build and deploy. Preserve the private issuance record. If you lost the response, check `/login` before trying enrollment again. Do not bypass an expired ten-minute window, existing generation or authentication-database recovery by reinitializing anything; follow the [enrollment/recovery procedure (Korean)](docs/development/password-hosting.ko.md#등록복구와-운영-중단-조건). `/setup` does not issue tokens.

Start with default D1 storage, without external asset variables or an R2 binding. Each file is limited to 16 MiB; app/shared storage caps and D1's free daily quotas also apply. The large-asset GitHub Releases path is currently a preview pinned to UULab repositories; it does not support arbitrary repositories as a general installation feature. Do not delete history or automatically upgrade to a paid tier when a limit is reached.

Return to [step 2](#2-start-the-installation-wizard) and connect GitHub. Actual Free-account CPU/memory/usage and public DNS/TLS must be checked separately from local tests.

## Troubleshooting and verification scope

See the [installation wizard verification record](docs/development/installation-wizard-verification-2026-10-18.ko.md) for current evidence and remaining steps.

| Symptom | Check |
| --- | --- |
| `PNPM_NOT_VERIFIED` / strict doctor fails | Full pinned `npm exec ... pnpm` prefix and Node/Git versions; never delete the lockfile or bypass TLS |
| `WORKSPACE_SOURCE_INCOMPLETE` / missing `dist` | Clone the default main branch, then complete install and build |
| Demo `PRIVATE_STORE_UNSAFE` | Owner-private 0600 database/0700 directories, no shared-writable ancestry or symlinks; canonicalize temporary HOME with realpath. Never delete an existing DB or relax its permissions |
| Setup `SETUP_PROVIDER_DNS_READ_REQUIRED` | Supply a token limited to DNS Read on the target zone through the CLI's hidden input. The pinned Wrangler OAuth lacks this scope. The token stays in memory for that zone's DNS GET only; blank input stops. Resume the same private journal |
| GitHub repository missing | App installation scope, organization approval and selected ref/root; refresh after permission changes |
| `INVALID_RUNNER_CONFIG` | Actual image ID, HTTPS origin, token, allowed JSON fields, 0600 file/0700 parents and no symlinks |
| Waiting jobs / offline Runner | Awake PC/daemon, presence, Docker socket and 2 GiB free space; a successful `--once` does not establish online status |
| `DEPENDENCY_*` / export failure | App lockfile, supported package-manager version, vendor tarball, image version, Metro entry and supported workspace importer |
| `CONFIG_CHANGED` / blocked deployment | Config at the pinned SHA matches the installed binary's URL, app ID, channel, runtime and public certificate |
| Published but app unchanged | Initial SDK binary is installed, Release mode, new SHA differs from the prior deployment, and detailed device reports |
| Daily quota / `fatal-stop` | UI error code and reset/recovery guidance; preserve journals, history and keys |

The command checks, fresh-HOME installation and real Docker preparation results are in the [2026-10-18 verification record (Korean)](docs/development/first-run-verification-2026-10-18.ko.md).

To verify source and documentation, run `npm exec --yes --package=pnpm@11.19.0 -- pnpm check` at the Flora root. `verify:clean` checks a copy of tracked files; distinguish it from the [actual fresh-clone procedure (Korean)](docs/development/clean-clone-source.ko.md).

Account authentication, installation approval, public deployment and installing the first native binary in this README are operator steps. A local fixture pass does not establish those real steps were completed. Historical OTA/network-recovery evidence for UULab's six Simulator/Emulator app/platform combinations is in the [2026-10-17 record (Korean)](docs/development/github-release-ota-network-2026-10-17.ko.md). It is not physical-device evidence or a guarantee of current service health.

## Further reading

- [Local demo, CLI and existing data (Korean)](docs/getting-started.ko.md), [PC Runner operations (Korean)](docs/development/local-pc-runner.ko.md), [SDK](packages/ota-sdk/README.md)
- [Product intent](docs/product/intent.ko.md), [integrated plan](docs/product/integrated-plan.ko.md), [requirements](docs/product/requirements.ko.md), [roadmap](docs/roadmap/milestones.ko.md) (Korean)
- [Contribution/development handoff (Korean)](docs/development/pc-handoff.ko.md), [License](LICENSE), [NOTICE](NOTICE), [Report an issue](https://github.com/uulab-official/flora/issues)

Core, CLI, Dashboard, SDK, Runner, official adapters, security, audit and self-hosting code are intended to remain open source. Documentation or local simulations do not establish that an unimplemented app feature has shipped.
