# Flora

[한국어](README.md) · [English](README.en.md) · [Apache-2.0](LICENSE)

**An open-source app management and OTA platform, run with your apps, GitHub and PC.**

Connect each app and GitHub repository in Flora. An awake PC Runner exports commits and publishes app-scoped OTA updates. Install the Flora SDK, including its own iOS and Android engines, in your apps. **No EAS account, EAS API or GitHub Actions is required.**

```text
GitHub push → Flora's app-scoped policy and job queue → Docker export on your PC
            → OTA publication → installed app downloads, applies and restarts → app history
```

Flora is currently a single-owner self-hosting preview. The SDK is not published to npm, and first-owner enrollment is a manual operator procedure. This guide uses **D1 asset storage and an independent PC Runner**. It does not assume UULab's dedicated GitHub Release repository or LaunchAgent is a general installation feature.

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

To inspect the UI without an account, run `node scripts/dogfood-demo.mjs --serve` and open its one-time URL. This synthetic demo does not connect real GitHub or OTA; a `blocked` run is expected. It uses a separate demo database instead of your operational database. Stop it with Ctrl+C.

### 2. Prepare the Flora server and sign in

If an operator has already given you a Flora address and account, sign in at `https://YOUR_FLORA_HOST/login`. `flora.uulab.co.kr` is UULab's existing installation, not a public demo anyone can sign into. There is no shared default administrator password.

To operate a new server, complete [Self-host a new server](#self-host-a-new-server) in this README, then return here. GitHub requires an externally reachable, exact HTTPS origin and webhook address. A local demo's loopback URL is not a public server address.

**Completion check:** `/projects` opens after sign-in. Keep an existing installation intact; do not initialize it again with a new database, owner or keys.

### 3. Connect GitHub and register a project

1. Choose **Projects → Connect GitHub → Create connection app on GitHub** (`프로젝트 → GitHub 연결하기 → GitHub에서 연결 앱 만들기`). Leave the organization name empty for a personal account.
2. Sign in or reauthenticate on GitHub yourself and create the App. On the callback page, choose **Complete connection in Flora** (`Flora에서 연결 완료`). Do not share the callback URL's `code` or `state`.
3. Under **Allow repository access** (`저장소 접근 허용`), include only the repositories you intend to manage. The Flora App uses Contents/Metadata read access and push events. Signing into GitHub and granting an App access to repositories are separate steps.
4. Back in Flora, choose **New project → Check GitHub connection → Use selected repository** (`새 프로젝트 → GitHub 연결 확인 → 선택한 저장소 사용`), select the repository, then enter a project name and root. Use `.` for a single-app repository or an app folder such as `apps/mobile` for a monorepo.
5. In the app's **GitHub · Source** (`GitHub · 소스`), select a verification branch/ref. First use a separate app or verification channel; preserve existing production branches and settings. Register two repositories as **two separate Flora apps**.

If a repository is missing, open GitHub **Settings → Applications → Installed GitHub Apps → Flora App → Configure**, keep existing selections, add the repository and save. Refresh Flora's repository list. This is an installation-scoped GitHub App connection, not account-wide OAuth discovery of all private repositories.

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

In the app's **OTA deployments → Prepare OTA signing for this app** (`OTA 배포 → 이 앱의 OTA 서명 준비`), download the public certificate. The current UI does not display the key ID separately. In your browser's developer tools Network panel, inspect the **response JSON's `keyId`** for this action's `POST /api/apps/APP_ID/signing-key`. The response contains `appId`, `keyId`, `certificate` and `createdAt`; it is not a private key. Do not copy request cookies, headers or tokens.

Create a public `flora.connection.json` at the app root. Replace the app ID, URL, certificate and key ID below with **this app's actual values**. Put the entire downloaded PEM certificate in the JSON string. Do not put private keys or tokens in this file.

```json
{
  "appId": "app_REPLACE_WITH_REGISTERED_APP_ID",
  "url": "https://YOUR_FLORA_HOST/updates/app_REPLACE_WITH_REGISTERED_APP_ID",
  "channel": "preview",
  "runtimeVersion": "native-v1",
  "certificate": "PASTE_COMPLETE_PUBLIC_PEM_CERTIFICATE",
  "keyId": "COPY_PUBLIC_KEY_ID_FROM_RESPONSE"
}
```

Create `flora.config.json` at the same root. This default example is for an **npm 10.9.8 / Metro / index.js** app. The actual entry file, tool versions and root lockfile must match the declaration. The app's lockfile must include `@flora/ota` and Metro.

```json
{
  "schemaVersion": 1,
  "ota": {
    "runtimeVersion": "native-v1",
    "platforms": ["ios", "android"],
    "url": "https://YOUR_FLORA_HOST/updates/app_REPLACE_WITH_REGISTERED_APP_ID"
  },
  "export": {
    "bundler": "metro",
    "entryFile": "index.js",
    "nodeVersion": "24.19.0",
    "packageManager": { "name": "npm", "version": "10.9.8" }
  }
}
```

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

### 5. Register and run the PC Runner

Run the controller as a non-root macOS/Linux user with an already-running Docker daemon. Check [Docker installation](https://docs.docker.com/engine/install/) and the free-use terms for your account separately. Your PC needs no public port, Tunnel, GitHub certificate or EAS login.

| App dependency preparation | Currently supported conditions |
| --- | --- |
| Default npm path below | Node 24.19.0 / npm 10.9.8; v3 `package-lock.json` at the app root; pinned npm registry tarballs and validated `vendor/*.tgz` |
| pnpm workspace path | Node 24.19.0 / **pnpm 11.10.0**; `dependencyPreparation: "pnpm-registry"`; repository-root lock/workspace files and a supported app importer |
| Other | The operator must prepare the default offline cache path. Do not assume arbitrary pnpm versions or Yarn preparation work automatically |

Flora tooling uses pnpm **11.19.0**; the pnpm app Runner profile uses **11.10.0**. These are separate versions. Build an image with tools for the default npm path and supported pnpm path. Do not put app source, private keys or tokens into the image.

```sh
# Run in the Flora repository; do not run the Runner as root.
docker info
docker pull node:24.19.0-bookworm-slim
FLORA_BASE_IMAGE=$(docker image inspect node:24.19.0-bookworm-slim --format '{{index .RepoDigests 0}}')
docker build --build-arg BASE_IMAGE="$FLORA_BASE_IMAGE" --build-arg PNPM_VERSION=11.10.0 -f packages/ota-runner/examples/Dockerfile -t flora-export:local packages/ota-runner/examples
docker image inspect flora-export:local --format '{{.Id}}'
docker context inspect --format '{{.Endpoints.docker.Host}}'
```

Keep the image's actual `sha256:` ID with 64 hexadecimal digits. The controller rejects tags/`latest` and runs only an already-local pinned image. If you use a non-default `DOCKER_HOST`, put that actual `unix://...` address below instead of the context output.

In the app's **PC Runner**, choose **Register Runner for current app** (`현재 앱에 Runner 등록`). Save the **one-time token** in a private `runner.json` outside the checkout. Use a separate Runner token and directory for every app.

```sh
# Choose a new path. Stop if it exists and preserve the existing configuration.
FLORA_PC_DIR="$HOME/.flora-first-pc"
(umask 077; mkdir "$FLORA_PC_DIR" && mkdir "$FLORA_PC_DIR/scratch" "$FLORA_PC_DIR/scratch/work" "$FLORA_PC_DIR/recovery")
```

Save the following as `$FLORA_PC_DIR/runner.json` using a **local editor**, then run `chmod 600 "$FLORA_PC_DIR/runner.json"`. Do not put the token into shell commands, environment variables, Git or chat. `origin` is the HTTPS origin without a path.

```json
{
  "origin": "https://YOUR_FLORA_HOST",
  "token": "PASTE_ONE_TIME_APP_RUNNER_TOKEN_PRIVATELY",
  "dockerImage": "sha256:REPLACE_WITH_INSPECTED_LOCAL_IMAGE_ID",
  "resourceProfile": "github-hosted",
  "dependencyPreparation": "npm-registry",
  "workDirectory": "/ABSOLUTE/.flora-first-pc/scratch/work",
  "recoveryDirectory": "/ABSOLUTE/.flora-first-pc/recovery"
}
```

`github-hosted` is the existing container resource profile's name. It also runs on your PC and does not connect Actions. npm/pnpm preparation containers fetch only validated public registry dependencies. Actual app code, install scripts and export run in a separate container without network access. The export container does not receive Runner/GitHub tokens or the Docker socket.

Use the foreground supervisor to reduce free-tier reads while reporting idle presence. Save the following as `$FLORA_PC_DIR/service.json` and protect it with mode 0600. `nodePath`, `runnerMain` and `path` must use actual absolute paths; `dockerHost` is the socket verified above. If you do not use Lima, set `limaHome` to the same directory as `runtimeDirectory`.

```json
{
  "runtimeDirectory": "/ABSOLUTE/.flora-first-pc",
  "nodePath": "/ABSOLUTE/TO/node",
  "runnerMain": "/ABSOLUTE/TO/flora/packages/ota-runner/dist/main.js",
  "runnerConfigs": ["/ABSOLUTE/.flora-first-pc/runner.json"],
  "path": "/ABSOLUTE/DOCKER/BIN:/ABSOLUTE/NODE/BIN:/usr/bin:/bin:/usr/sbin:/sbin",
  "limaHome": "/ABSOLUTE/.flora-first-pc",
  "dockerHost": "unix:///ACTUAL/DOCKER/SOCKET",
  "pollIntervalMs": 30000
}
```

```sh
chmod 600 "$FLORA_PC_DIR/service.json"
node scripts/local-runner/supervisor.mjs "$FLORA_PC_DIR/service.json"
```

Open another terminal and check the app's PC Runner status. The supervisor sends actual presence separately and backs off empty-queue checks to at most five-minute intervals. `node packages/ota-runner/dist/main.js --config ... --once` is a one-shot diagnostic; it does not send idle presence automatically. **Online** (`온라인`) confirms connectivity, not a successful deployment. Also check Docker, 2 GiB free disk space and failure codes.

Stop with Ctrl+C. A powered-off/sleeping PC or closed terminal cannot process jobs. The reboot service installer, `service.mjs`, currently targets UULab's named macOS LaunchAgent and paths; this generic procedure does not install it. Operators needing it should review the [service guide (Korean)](docs/development/local-pc-runner.ko.md). Do not delete `fatal-stop` files or recovery journals before diagnosing their cause.

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

Return to [step 2](#2-prepare-the-flora-server-and-sign-in) and connect GitHub. Actual Free-account CPU/memory/usage and public DNS/TLS must be checked separately from local tests.

## Troubleshooting and verification scope

| Symptom | Check |
| --- | --- |
| `PNPM_NOT_VERIFIED` / strict doctor fails | Full pinned `npm exec ... pnpm` prefix and Node/Git versions; never delete the lockfile or bypass TLS |
| `WORKSPACE_SOURCE_INCOMPLETE` / missing `dist` | Clone the default main branch, then complete install and build |
| GitHub repository missing | App installation scope, organization approval and selected ref/root; refresh after permission changes |
| `INVALID_RUNNER_CONFIG` | Actual image ID, HTTPS origin, token, allowed JSON fields, 0600 file/0700 parents and no symlinks |
| Waiting jobs / offline Runner | Awake PC/daemon, presence, Docker socket and 2 GiB free space; a successful `--once` does not establish online status |
| `DEPENDENCY_*` / export failure | App lockfile, supported package-manager version, vendor tarball, image version, Metro entry and supported workspace importer |
| `CONFIG_CHANGED` / blocked deployment | Config at the pinned SHA matches the installed binary's URL, app ID, channel, runtime and public certificate |
| Published but app unchanged | Initial SDK binary is installed, Release mode, new SHA differs from the prior deployment, and detailed device reports |
| Daily quota / `fatal-stop` | UI error code and reset/recovery guidance; preserve journals, history and keys |

To verify source and documentation, run `npm exec --yes --package=pnpm@11.19.0 -- pnpm check` at the Flora root. `verify:clean` checks a copy of tracked files; distinguish it from the [actual fresh-clone procedure (Korean)](docs/development/clean-clone-source.ko.md).

Account authentication, installation approval, public deployment and installing the first native binary in this README are operator steps. A local fixture pass does not establish those real steps were completed. Historical OTA/network-recovery evidence for UULab's six Simulator/Emulator app/platform combinations is in the [2026-10-17 record (Korean)](docs/development/github-release-ota-network-2026-10-17.ko.md). It is not physical-device evidence or a guarantee of current service health.

## Further reading

- [Local demo, CLI and existing data (Korean)](docs/getting-started.ko.md), [PC Runner operations (Korean)](docs/development/local-pc-runner.ko.md), [SDK](packages/ota-sdk/README.md)
- [Product intent](docs/product/intent.ko.md), [integrated plan](docs/product/integrated-plan.ko.md), [requirements](docs/product/requirements.ko.md), [roadmap](docs/roadmap/milestones.ko.md) (Korean)
- [Contribution/development handoff (Korean)](docs/development/pc-handoff.ko.md), [License](LICENSE), [NOTICE](NOTICE), [Report an issue](https://github.com/uulab-official/flora/issues)

Core, CLI, Dashboard, SDK, Runner, official adapters, security, audit and self-hosting code are intended to remain open source. Documentation or local simulations do not establish that an unimplemented app feature has shipped.
