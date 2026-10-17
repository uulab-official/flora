# Flora

2026-10-17 verification record: all six Isso, Promise and Reward iOS Simulator / Android Emulator combinations passed GitHub commit → PC Runner export and OTA publication → interrupted download → retry, activation and restart → recovery displayed in Flora. Each verified deployment had one reporting installation. This is dated evidence, not physical-device validation, a population-wide adoption rate or a guarantee of current service health. See the [network failure and recovery evidence (Korean)](docs/development/github-release-ota-network-2026-10-17.ko.md). This path uses no EAS, GitHub Actions or R2 subscription.

[한국어](README.md) · [English](README.en.md)

The multi-app foundation includes GitHub detection, Flora's native OTA engine and an automatic export Runner. Jobs pin a commit, app configuration and toolchain, then record app-scoped attempts and OTA history. Metro is the default; the open-source Expo CLI export adapter is optional. No EAS account or API is required. Two bare RN apps passed download, activation and full process restart in iOS and Android Release builds; see the [local native evidence (Korean)](docs/development/native-ota-evidence.ko.md), [native integration guide](docs/development/native-ota.ko.md), [Flora SDK](packages/ota-sdk/README.md) and [Runner](packages/ota-runner/README.md).

**Open Source App Operations Platform**

Your apps. Your runners. Your cloud. Your control.

Flora is an Apache-2.0 project working toward a shared control plane for iOS, Android and Web app configuration, builds, releases and operational history. Cloudflare is the intended control-plane platform; execution will use portable organization-owned or cloud runners. Flora is a provisional product name.

## What works today

A TypeScript/SQLite foundation and protected loopback dashboard provide app registration, configuration, fenced jobs, imports and immutable history. The Cloudflare control plane provides single-owner password login, GitHub push admission and app-scoped OTA orchestration over SQLite DO/D1. Export runs on a separate Runner host.

Additive migrations preserve existing imports, settings and OTA records. Local Foundation simulations and real OTA operation have separate requirements and evidence. The UULab deployment has verified GitHub connections, app-scoped policies/history, PC Runner publication and signed OTA recovery for three apps. The [initial native evidence](docs/development/native-ota-evidence.ko.md) and [latest real-app evidence](docs/development/github-release-ota-network-2026-10-17.ko.md) identify their dates, targets and environments; they do not establish readiness for every installation or certify the full product roadmap.

For real operation, follow [hosting preparation](docs/development/password-hosting.ko.md), [PC Runner operations](docs/development/local-pc-runner.ko.md) and the [GitHub Release asset storage guide](docs/development/github-release-ota-storage.ko.md). Export requires an awake PC. Downloads of confirmed GitHub-hosted assets do not depend on that PC staying online. Free-tier eligibility and provider limits must be checked for your own account.

Web AI code editing is now a user-approved product priority. The [detailed milestone proposal](docs/proposals/web-ai/next-slice-spec.ko.md) and [architecture addendum](docs/proposals/web-ai/architecture-addendum.ko.md), currently in Korean, still await design review; their publication does not mean those features shipped.

## Try the local foundation

### 1. Prerequisites

- [Node.js **24.19.0**](https://nodejs.org/en/download/archive/v24.19.0), with npm available. Use the repository's pinned version, not whichever version is currently labeled “latest”
- [Git](https://git-scm.com/install/) and an internet connection for the clone and public dependency downloads
- A writable directory and temporary directory

No account, API key, `.env`, Xcode, Java, Docker, Cloudflare or Expo subscription is needed for these simulations. The commands use **pnpm 11.19.0 through npm exec**, so no global pnpm install or administrator shell is required.

Use a terminal on macOS/Linux, or PowerShell/Command Prompt on Windows. Run one line at a time; stop if a command fails.

```sh
node --version
npm --version
git --version
git clone https://github.com/uulab-official/flora.git
cd flora
npm exec --yes --package=pnpm@11.19.0 -- pnpm --version
npm exec --yes --package=pnpm@11.19.0 -- pnpm install --frozen-lockfile --ignore-scripts
npm exec --yes --package=pnpm@11.19.0 -- pnpm check
```

The Node version should be `v24.19.0`; the pnpm version should be `11.19.0`. `check` builds the packages, typechecks them and runs the test suite. Expect zero failures; test counts vary by revision and OS. The historical Foundation-only revision `02269503` reported 48/48, before the dogfood workflow was added. Run it before the CLI because a source clone does not include compiled `dist` files.

On Windows, if PowerShell blocks `npm.ps1`, use `npm.cmd` instead of `npm` in these commands. You do not need to weaken PowerShell's execution policy. A Git clone is recommended instead of “Download ZIP”: the clean-install verification below relies on Git's tracked-file list.

### 2. Inspect your environment and configuration

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm platform doctor --strict --json
npm exec --yes --package=pnpm@11.19.0 -- pnpm platform config validate --file examples/local-workflow.json
```

`doctor --strict --json` checks Node **24.19.0**, pnpm **11.19.0** and Git. When `readiness.ready` is `true`, it exits 0. A required tool that is missing, unsupported or cannot complete its probe makes readiness fail and strict mode exit 1. Use `readiness.issues[].code` and `.remediation`, then rerun the command. For example, `PNPM_NOT_VERIFIED` means the trusted entry could not be verified, not that pnpm is necessarily uninstalled. `--json --strict` also works. Existing `doctor` and `doctor --json` retain report-only behavior: a readiness failure alone does not make them exit 1.

Use the complete pinned pnpm prefix: pnpm detection validates the entry provided by the package manager, so calling the compiled CLI directly may report pnpm unavailable even if a global executable exists. Doctor does not install tools or change configuration. Xcode/Java being `unavailable`, or Xcode being `unsupported` on Linux/Windows, does **not** block this local demo. `nativeBuildVerified: false` is expected; readiness covers the local Foundation toolchain, not native builds or provider connections.

For the unchanged example, configuration validation returns `mode: "local"` and this snapshot ID:

```text
cfg_93168f5527f4bab730a0efbc52230e1130ef4205635765a25c7b620052714747
```

It prints keys and secret **version references**, not secret values. The sample's `production` and `ios` names are test data; they do not connect to production or compile iOS on your machine.

### 3. Run the three scenarios

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm platform job simulate --file examples/local-workflow.json --scenario happy-path
npm exec --yes --package=pnpm@11.19.0 -- pnpm platform job simulate --file examples/local-workflow.json --scenario runner-replacement
npm exec --yes --package=pnpm@11.19.0 -- pnpm platform job simulate --file examples/local-workflow.json --scenario unsafe-expiry
```

All three should exit successfully and report `mode: "local-simulation"`. Inspect these JSON fields:

| Scenario | Expected result |
| --- | --- |
| `happy-path` | `summary.jobs[0].status` is `success`; attempt count/fence are `1`; one synthetic artifact |
| `runner-replacement` | Job is `success`; attempt count/fence are `2`; `rejectedOperations[0].code` is `LEASE_STALE` |
| `unsafe-expiry` | Job is `waiting`; `waitingReason` is `reconciliation_required`; no artifact |

`LEASE_STALE` is the expected rejection of the old simulated Runner. `waiting` is the expected safe outcome for the uncertain simulated Store action; no Store API is called. Generated job IDs, attempt IDs, timestamps and artifact digests vary per run.

Each scenario uses its own temporary SQLite database and removes it when the command finishes. The terminal JSON is the result; it does not save an app binary or a persistent release database.

### 4. Check the pinned toolchain and a clean installation

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm doctor:toolchain
npm exec --yes --package=pnpm@11.19.0 -- pnpm verify:clean
```

Expect `Toolchain verified: Node 24.19.0 / pnpm 11.19.0`. Run the clean check when validating a complete Git-tracked revision, not as proof that this working tree is release-ready. The clean check copies Git-tracked files into a temporary directory, uses an empty pnpm store, repeats installation/tests/CLI smoke checks and verifies source hashes. Its final JSON includes `cleanInstall: "passed"`, `isolatedStore: true` and `originalUnchanged: true`. The source-file count is revision-dependent. Untracked files are excluded. Before the temporary installation, the check requires tracked workspace package manifests to satisfy the root and transitive `workspace:` dependencies; missing packages stop it with `WORKSPACE_SOURCE_INCOMPLETE`. Include SDK/Runner source and public test fixtures in the source revision, while keeping credentials, caches and operational state outside Git. This temporary copy is not a real Git clone and does not isolate the entire user environment. Follow the [actual-clone procedure with an empty private HOME and package-manager caches (Korean)](docs/development/clean-clone-source.ko.md) to verify a specific source URL and revision. A local build or this procedure alone does not prove package publication, deployment or device adoption. The check may download dependencies again and removes its temporary copy afterward.

## Try the local app dashboard

After the install and check steps above, use the dedicated synthetic demo store:

```sh
node scripts/dogfood-demo.mjs
node scripts/dogfood-demo.mjs --status
node scripts/dogfood-demo.mjs --serve
```

Open the one-time URL printed by serve in a browser on the same computer. Keep that URL private. The demo imports the two clearly fictional `examples/dogfood-*.synthetic.json` files and automatically passes the returned inventory ID to the baseline import. Expect `mode: "synthetic-dogfood-demo"`, a passed imported baseline with 2 files / 4 tests, `evidenceOrigin: "operator-import"`, and `isolatedExecution: "not_run"`. This does not execute app source or certify a real run. A UI run request records `blocked` because no verified isolated provider is configured.

The demo uses `.flora/dogfood/demo.db` under `os.homedir()`, outside the source checkout. Your real-app CLI uses a separate default `.flora/dogfood/state.db`, so trying the example does not bind your real-app store. One store supports multiple repository/root apps. The synthetic demo retains its own conflict guard to avoid mixing demo data with an unrelated app. If the demo path already contains another app, it stops with CONFLICT; choose a new private path rather than deleting history. The demo accepts `--db <private-path>`; pass the same option with its --status and --serve modes. POSIX custom paths need an owner-private existing parent or one new private leaf. Windows custom paths must remain within the profile's dedicated `.flora/dogfood` directory and inherit its access; Flora does not modify Windows ACLs.

For compatible source and baseline bundles, run the following from the repository root, replacing the filenames and the complete returned `inventory_` ID. The source install does not create a global `flora` command. You can also select these JSON files in the UI.

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm flora dogfood import-source --file source-bundle.json
npm exec --yes --package=pnpm@11.19.0 -- pnpm flora dogfood import-baseline --snapshot inventory_00000000-0000-0000-0000-000000000000 --file baseline-bundle.json
```

The zero-filled ID is a placeholder; use the first command’s returned ID. Source and baseline inputs allow at most 2 MiB; both legacy workflow limits remain 1 MiB. Hash/provenance validation checks imported evidence for internal consistency, not live GitHub freshness or independent execution authenticity. Unknown freshness is not current. Browser OS does not determine execution OS; iOS still requires a verified macOS/Xcode runner.

Ctrl+C closes the local service/server/database. A second live server returns `STORE_IN_USE` without recovering the first server's work. `PRIVATE_STORE_UNSAFE` rejects unsafe existing access/link/owner metadata without changing it; `INPUT_TOO_LARGE` rejects before database changes. The bootstrap expires after five minutes and can be used once; restart serve for a new URL if necessary. Imports and status do not perform startup recovery.

The [full dogfood guide](docs/development/dogfood.ko.md) documents evidence formats and limits in Korean. This local Node server is not a Cloudflare deployment or a user-accessible cloud service. Private hosting, authentication, storage and execution-lifetime suitability require separate validation.

## Self-hosting status

The Cloudflare path is an operator-managed preview. After the pinned install/build above, follow the [hosting preparation sequence](docs/development/password-hosting.ko.md#self-host-준비-순서). It requires an existing authorized Cloudflare management session, an owner-controlled HTTPS hostname, a completed private Wrangler config, and a dedicated D1 database. Applying the SQL migration creates schema only; the immutable deployment identity must be provisioned separately before app access works. Owner password enrollment is a separate, locked-by-default step. The repository does not yet provide a general setup-capability issuer or a safe offline authentication-database restore tool. Management APIs require login; `/login` is the sign-in entry. Keep demo data separate from the real-app database. The UULab deployment at `flora.uulab.co.kr` is an existing owner-managed installation, not an automatically provisioned public demo. Its latest three-app, two-platform OTA recovery evidence is [recorded separately](docs/development/github-release-ota-network-2026-10-17.ko.md). R2 is optional: the verified PC path stores new assets in private GitHub Releases without EAS or Actions. GitHub/Cloudflare limits, PC power/network and store accounts still apply; no unlimited or zero-cost guarantee is made.

## Troubleshooting

- **Wrong Node version / unsupported engine:** select Node 24.19.0, reopen the terminal, then rerun `node --version`. Do not disable `engine-strict` or replace the lockfile to work around a version mismatch
- **pnpm not found:** use the complete `npm exec --yes --package=pnpm@11.19.0 -- pnpm` prefix above. `npm --version` and `pnpm --version` are different tools
- **Missing `dist` module / package not found:** from the repository root, complete the pinned install and `check` steps before calling the CLI
- **Strict doctor exits 1:** inspect `readiness.issues` and its recovery hints. Restore the required pinned toolchain or Git access and rerun. Use report-only `doctor --json` when a diagnostic report without a readiness exit gate is desired
- **`USAGE_ERROR` / exit code 2:** check command order and the exact scenario names above. `--help` lists supported commands
- **`INPUT_OR_OPERATION_FAILED` / exit code 1:** confirm the file exists, the working directory is the cloned repository, and the JSON is valid UTF-8. Try the unchanged example first; domain validation can return a more specific safe error
- **Install/network failure:** restore access to GitHub and the package registry and rerun the same frozen install. Do not paste tokens into an issue, disable TLS verification, or delete the lockfile
- **`WORKSPACE_SOURCE_INCOMPLETE`:** include each required workspace package in the source revision, including transitive dependencies; do not remove dependencies or relax the lockfile to bypass the check
- **`verify:clean` cannot list tracked files:** use a Git clone. A source ZIP may run the CLI after building, but it cannot perform this Git-based check
- **`unsafe-expiry` stays `waiting`:** this is the intended result, not a stuck background process. Each invocation finishes and creates a fresh simulation

For an issue report, include your OS/architecture, Node/npm/pnpm versions, `git rev-parse HEAD`, the exact command and a sanitized error. Never include credentials or real secret values. [Report an issue](https://github.com/uulab-official/flora/issues)

## Verification and documentation

For continuing development on another PC, see the [PC handoff and prioritized checklist (Korean)](docs/development/pc-handoff.ko.md) and [integration status (Korean)](docs/development/integration-status.ko.md). They distinguish implemented code, imported/synthetic evidence, and verified operational connections.

On 2026-10-07, the sequence above was exercised on Linux with a new HOME, npm cache and pnpm data/cache directories against source revision `02269503`. That historical Foundation-only suite passed 48/48 tests; all three scenarios, toolchain check and clean installation passed. This is local Foundation evidence, not provider or native-build certification.

The repository [CI workflow](.github/workflows/ci.yml) is separate from the PC OTA path and is optional for self-hosters; it is not required to publish OTA updates. It runs the npm-exec recipe, Foundation checks, CLI examples and clean-install verification on Linux, macOS and Windows. Check the [actual run for your revision](https://github.com/uulab-official/flora/actions/workflows/ci.yml); workflow configuration alone is not a successful run.

- [Korean getting started](docs/getting-started.ko.md)
- [Detailed CLI/data/security reference, Korean](docs/development/local-foundation.ko.md)
- [Product intent](docs/product/intent.ko.md), [complete product plan](docs/product/integrated-plan.ko.md), [requirements](docs/product/requirements.ko.md), [roadmap](docs/roadmap/milestones.ko.md) (Korean)
- [License](LICENSE) and [NOTICE](NOTICE)

Core, official adapters, team security and self-hosting are intended to remain open source. Third-party APIs, model inference, cloud usage, store accounts and necessary hardware can still cost money.
