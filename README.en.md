# Flora

[한국어](README.md) · [English](README.en.md)

**Open Source App Operations Platform**

Your apps. Your runners. Your cloud. Your control.

Flora is an Apache-2.0 project working toward a shared control plane for iOS, Android and Web app configuration, builds, releases and operational history. Cloudflare is the intended control-plane platform; execution will use portable organization-owned or cloud runners. Flora is a provisional product name.

## What works today

**A local TypeScript/SQLite foundation and protected loopback dashboard**, including target validation, configuration snapshots, fenced jobs, static app inventory, imported development baselines and history. You can run the commands below today.

The dashboard binds only to 127.0.0.1 and uses a one-time bootstrap followed by a private local session. Organization authentication, real Runner registration/daemon, AI code editing, Vault, native builds, signing, Store uploads, OTA and Cloudflare deployments remain future work. The product execution provider is blocked; imported evidence and simulated success are not verified isolated execution or app deployment.

A separate Cloudflare path implements single-owner password login, private source/baseline imports and history, with local synthetic Worker/DO/D1 tests. Actual Free account capacity/performance, production deployment/domain/TLS, owner enrollment and private-file uploads remain unverified. See the [hosting development guide (Korean)](docs/development/password-hosting.ko.md) and [release evidence and open gates](docs/release/password-hosting-evidence.md). The hosted path does not run a Runner.

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
npm exec --yes --package=pnpm@11.19.0 -- pnpm platform doctor --json
npm exec --yes --package=pnpm@11.19.0 -- pnpm platform config validate --file examples/local-workflow.json
```

`doctor` reports your actual OS, Node and pnpm versions. `nativeBuildVerified` is always `false` here. Xcode/Java being `unavailable` or Xcode being `unsupported` on Linux/Windows does **not** block this local demo. The doctor is a report, not an installer or proof that native builds work.

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

Expect `Toolchain verified: Node 24.19.0 / pnpm 11.19.0`. The clean check copies Git-tracked files into a temporary directory, uses an empty pnpm store, repeats installation/tests/CLI smoke checks and verifies source hashes. Its final JSON includes `cleanInstall: "passed"`, `isolatedStore: true` and `originalUnchanged: true`. The source-file count is revision-dependent. It may download dependencies again and removes its temporary copy afterward.

## Try the local app dashboard

After the install and check steps above, use the dedicated synthetic demo store:

```sh
node scripts/dogfood-demo.mjs
node scripts/dogfood-demo.mjs --status
node scripts/dogfood-demo.mjs --serve
```

Open the one-time URL printed by serve in a browser on the same computer. Keep that URL private. The demo imports the two clearly fictional `examples/dogfood-*.synthetic.json` files and automatically passes the returned inventory ID to the baseline import. Expect `mode: "synthetic-dogfood-demo"`, a passed imported baseline with 2 files / 4 tests, `evidenceOrigin: "operator-import"`, and `isolatedExecution: "not_run"`. This does not execute app source or certify a real run. A UI run request records `blocked` because no verified isolated provider is configured.

The demo uses `.flora/dogfood/demo.db` under `os.homedir()`, outside the source checkout. Your real-app CLI uses a separate default `.flora/dogfood/state.db`, so trying the example does not bind your real-app store. One store belongs to one app. If the demo path already contains another app, it stops with CONFLICT; choose a new private path rather than deleting history. The demo accepts `--db <private-path>`; pass the same option with its --status and --serve modes. POSIX custom paths need an owner-private existing parent or one new private leaf. Windows custom paths must remain within the profile's dedicated `.flora/dogfood` directory and inherit its access; Flora does not modify Windows ACLs.

For your own data, use `flora dogfood import-source --file <bundle.json>` followed by `flora dogfood import-baseline --snapshot <returned-inventory-id> --file <bundle.json>`, or select JSON files in the UI. Keep the entire `inventory_` prefix and UUID. Source and baseline inputs allow at most 2 MiB; both legacy workflow limits remain 1 MiB. Hash/provenance validation checks imported evidence for internal consistency, not live GitHub freshness or independent execution authenticity. Unknown freshness is not current. Browser OS does not determine execution OS; iOS still requires a verified macOS/Xcode runner.

Ctrl+C closes the local service/server/database. A second live server returns `STORE_IN_USE` without recovering the first server's work. `PRIVATE_STORE_UNSAFE` rejects unsafe existing access/link/owner metadata without changing it; `INPUT_TOO_LARGE` rejects before database changes. The bootstrap expires after five minutes and can be used once; restart serve for a new URL if necessary. Imports and status do not perform startup recovery.

The [full dogfood guide](docs/development/dogfood.ko.md) documents evidence formats and limits in Korean. This local Node server is not a Cloudflare deployment or a user-accessible cloud service. Private hosting, authentication, storage and execution-lifetime suitability require separate validation.

## Troubleshooting

- **Wrong Node version / unsupported engine:** select Node 24.19.0, reopen the terminal, then rerun `node --version`. Do not disable `engine-strict` or replace the lockfile to work around a version mismatch
- **pnpm not found:** use the complete `npm exec --yes --package=pnpm@11.19.0 -- pnpm` prefix above. `npm --version` and `pnpm --version` are different tools
- **Missing `dist` module / package not found:** from the repository root, complete the pinned install and `check` steps before calling the CLI
- **`USAGE_ERROR` / exit code 2:** check command order and the exact scenario names above. `--help` lists supported commands
- **`INPUT_OR_OPERATION_FAILED` / exit code 1:** confirm the file exists, the working directory is the cloned repository, and the JSON is valid UTF-8. Try the unchanged example first; domain validation can return a more specific safe error
- **Install/network failure:** restore access to GitHub and the package registry and rerun the same frozen install. Do not paste tokens into an issue, disable TLS verification, or delete the lockfile
- **`verify:clean` cannot list tracked files:** use a Git clone. A source ZIP may run the CLI after building, but it cannot perform this Git-based check
- **`unsafe-expiry` stays `waiting`:** this is the intended result, not a stuck background process. Each invocation finishes and creates a fresh simulation

For an issue report, include your OS/architecture, Node/npm/pnpm versions, `git rev-parse HEAD`, the exact command and a sanitized error. Never include credentials or real secret values. [Report an issue](https://github.com/uulab-official/flora/issues)

## Verification and documentation

On 2026-10-07, the sequence above was exercised on Linux with a new HOME, npm cache and pnpm data/cache directories against source revision `02269503`. That historical Foundation-only suite passed 48/48 tests; all three scenarios, toolchain check and clean installation passed. This is local Foundation evidence, not provider or native-build certification.

The [CI workflow](.github/workflows/ci.yml) runs the npm-exec recipe, Foundation checks, CLI examples and clean-install verification on Linux, macOS and Windows. Check the [actual run for your revision](https://github.com/uulab-official/flora/actions/workflows/ci.yml); workflow configuration alone is not a successful run.

- [Korean getting started](docs/getting-started.ko.md)
- [Detailed CLI/data/security reference, Korean](docs/development/local-foundation.ko.md)
- [Product intent](docs/product/intent.ko.md), [complete product plan](docs/product/integrated-plan.ko.md), [requirements](docs/product/requirements.ko.md), [roadmap](docs/roadmap/milestones.ko.md) (Korean)
- [License](LICENSE) and [NOTICE](NOTICE)

Core, official adapters, team security and self-hosting are intended to remain open source. Third-party APIs, model inference, cloud usage, store accounts and necessary hardware can still cost money.
