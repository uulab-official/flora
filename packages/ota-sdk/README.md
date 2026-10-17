# Flora OTA SDK

`@flora/ota` includes Flora's own iOS/Android update engine and a JavaScript facade for replaceable native engines. The optional `@flora/ota/native` entry targets React Native 0.86.3; Expo and EAS are not required. The core import has no React Native runtime dependency. JavaScript delegates executable downloads and loading to native code.

The installed binary must include an update engine configured with its Flora HTTPS URL, app ID, channel, native runtime version and platform. Changing those native settings requires a new binary. The engine owns manifest/signature trust, asset hashes, persistence, rollback and executable loading. Give the facade exclusive control of the engine while an update is pending.

## Install into another app repository

The SDK is currently a local preview and is not published to an npm registry.
Build an installable tarball from a Flora checkout with its
locked development dependencies installed:

```sh
# In the Flora repository; Node 24.19.0 and the pinned pnpm are required.
pnpm sdk:pack --out /absolute/path/to/sdk-packages
# The JSON result provides the archive path and its SHA-256.

# In each separate app repository, install that exact local artifact.
npm install --ignore-scripts --no-audit --no-fund /absolute/path/to/sdk-packages/flora-ota-0.3.2.tgz
```

The pack command builds fresh public SDK files and includes the schema, type
declarations and Apache license. It excludes tests, workspace dependencies and
unrelated files in `dist`. It never publishes or requires npm/Expo/EAS login.
Choose a new output directory for each candidate: existing artifacts are never
overwritten. Commit the app lockfile and make the exact artifact available to
its Runner (for example, as a checked-in vendor tarball referenced with a
relative `file:` dependency). A path to your personal computer will not resolve
inside an independent checkout. Installation proves JavaScript package
availability; the native engine and configuration bridge described below still
need to be compiled into the app binary. React Native is an optional peer so
core-only consumers do not install it automatically.

## Flora native engine

Autolink the SDK's `FloraOta.podspec` and Android library, then install Pods for
iOS. Configure the binary's immutable app binding and signing certificate and
connect the host's startup bundle selector. See the complete
[native integration guide](../../docs/development/native-ota.ko.md).

- iOS: populate `FloraOTAAppId`, `FloraOTAUpdateURL`, `FloraOTAChannel`,
  `FloraOTARuntimeVersion`, `FloraOTACertificate` and `FloraOTAKeyId` in
  `Info.plist`. Import `FloraOta` and call
  `FloraOTAController.bundleURL(embedded:)` inside the React Native delegate's
  dynamic `bundleURL()` implementation.
- Android: compile `flora_ota_config.json` into app assets with `appId`, `url`,
  `channel`, `runtimeVersion`, PEM `certificate` and `keyId`. Create the app's
  `reactHost` with `FloraReactHost.create(applicationContext, PackageList(this).packages)`.
  This production host selects the verified bundle on each reload and falls back
  to the embedded asset. A startup-only bundle selector does not support release reload.

The engine requires HTTPS, verifies the exact manifest bytes with the installed
RSA signing certificate (at least 2048 bits), validates platform/app/channel/runtime,
and hashes every downloaded file. Verified files and activation state live in
private app storage. Activation is atomic; an unconfirmed update falls back to
the previous confirmed bundle or embedded bundle on the next process start.
Each update supports up to 64 ancillary assets plus its launch bundle; the
16 MiB per-file and 64 MiB total verified-download limits still apply.

Android 0.3.2 retains one fully verified downloaded candidate across process
starts when the app's startup deadline expires before activation. This cache
never selects itself: a fresh server check and matching download still precede
reload. Invalid or blocked caches are discarded while confirmed launch state
is preserved. The optional cache field remains compatible with existing v1
state files. Apps compiled with 0.3.1 need one native binary update to receive
this Kotlin fix; publishing JavaScript alone cannot replace the installed engine.

```ts
import { createFloraClient } from '@flora/ota';
import { createFloraNativeEngine } from '@flora/ota/native';

const nativeEngine = createFloraNativeEngine();
const launch = await nativeEngine.getLaunchInfo();
const ota = createFloraClient(await nativeEngine.getNativeConfiguration(), nativeEngine);

// After this launch renders and completes the application's readiness checks:
await nativeEngine.markLaunchSuccessful(launch.updateId);

const checked = await ota.checkForUpdate();
if (checked.available) {
  const downloaded = await ota.downloadUpdate();
  if (downloaded.downloaded) await ota.reload();
}
```

The installed configuration reader obtains native settings, rather than echoing
JavaScript configuration. Flora rejects foreign app/channel/runtime/platform
receipts and downloads that differ from the checked update ID.

Capture `launch.updateId` once at startup. Never read a newer launch ID inside an
old asynchronous readiness callback: native code rejects stale confirmations.
`getLaunchInfo()` also exposes verified ancillary assets as bundler-key-to-`file://`
URI mappings and optional rollback details. This preview does not automatically
remap arbitrary bundler output; use the returned URI explicitly for custom exports.
Expo 57 exports can install the verified asset resolver below before app imports
so ordinary image and font `require()` calls use the downloaded files.
For another native bridge, `@flora/ota/native-adapter` accepts an injected bridge
without importing React Native.

## Expo 57 apps using the Flora engine

An existing Expo 57 / React Native 0.86.3 app can keep Expo's OSS modules and
startup lifecycle while using Flora's own update engine. Add the config plugin
with the **public connection settings returned by your Flora server**:

```js
// app.config.js: public app-bound configuration; safe to keep with source.
const flora = require('./flora-native.json');
module.exports = ({ config }) => ({
  ...config,
  plugins: [...(config.plugins ?? []), ['@flora/ota/plugin', {
    ...flora,
    disableExpoUpdates: true,
  }]],
});
```

`flora-native.json` contains `appId`, HTTPS `url`, `channel`, `runtimeVersion`,
PEM `certificate` and `keyId`. The certificate is the **public manifest-signing
certificate** supplied by the Flora server; developers never need its private
key or a locally issued TLS certificate. Do not put GitHub credentials, signing
private keys or access tokens in this file. The plugin rejects extra fields and
requires an explicit `disableExpoUpdates: true` before disabling the competing
loader. It preserves other `updates` settings, plist keys and Android metadata.

Run the consuming app's pinned `expo prebuild --no-install` to apply the plugin,
then compile a new native binary. The plugin supports Swift `ExpoAppDelegate`
and Kotlin `ExpoReactHostFactory` templates from Expo 57; unknown host layouts
fail with a stable error instead of silently replacing lifecycle code.

- iOS: only the release `bundleURL()` is wrapped with Flora's verified selector.
  Expo modules, deep links and application delegates remain in place.
- Android: an optional `ReactNativeHostHandler` selects Flora's verified bundle
  whenever the Expo release host loads or reloads JavaScript. Only that registered
  dynamic host can apply an OTA. The bridge is added to the existing package list.
  Expo lifecycle dispatch stays in place; bare React Native consumers compile no
  Expo code and keep `FloraReactHost.create(...)`.
- Both: use `@flora/ota/native` with the facade shown above. Development bundles
  keep their normal Metro selection. Changing the public trust, channel or native
  runtime requires a new binary; an OTA cannot change these bindings.

For exported images and fonts, initialize the synchronous resolver **before**
the router or app components import their assets:

```js
// index.js, in a native binary built with the Flora plugin.
const { installFloraAssetResolver } = require('@flora/ota/native');
const { Asset } = require('expo-asset');
installFloraAssetResolver({ expoAsset: Asset });
require('expo-router/entry');
```

The initializer reads native constants derived from the verified current launch,
without awaiting JavaScript or delaying AppRegistry registration. For a Flora
OTA it matches Expo's selected `fileHashes` scale to the signed asset key, installs
the React Native image transformer and supplies verified local files through
Expo Asset's public `fromModule`/`fromMetadata` methods. Unknown or ambiguous
asset metadata fails closed. Embedded launches preserve the existing asset
resolution; explicit remote asset objects keep the app's normal behavior.
This entry imports React Native, while the core SDK has no Expo dependency.

No EAS login, account or update service is used. Config-plugin transformations
and unit tests do not replace Release build and device verification.

## Optional expo-updates engine

The optional adapter accepts the installed OSS module and an immutable native configuration reader. It makes no EAS calls and never overrides the engine's URL or headers at runtime.

```ts
import * as Updates from 'expo-updates';
import { createExpoUpdatesAdapter } from '@flora/ota/expo-updates';

const nativeEngine = createExpoUpdatesAdapter(
  Updates,
  () => nativeBinding.readInstalledFloraConfiguration(),
);
```

`nativeBinding` is the application's configuration bridge for this optional Expo adapter; the Flora-native bridge is supplied by `@flora/ota/native`. The module must be enabled in the release binary. The adapter uses the documented [`checkForUpdateAsync`, `fetchUpdateAsync`, and `reloadAsync` APIs](https://docs.expo.dev/versions/latest/sdk/updates/) and binds Flora manifest metadata to the installed configuration. Other native engines can implement the same contract against Flora's update protocol.

## Source and Runner configuration

Commit `flora.config.json` in the registered app root. The accompanying `flora.config.schema.json` declares public compatibility and a fixed export recipe; credentials and arbitrary shell commands are excluded.

```json
{
  "schemaVersion": 1,
  "ota": {
    "runtimeVersion": "native-v1", "platforms": ["ios", "android"],
    "url": "https://your-flora.example/updates/app_your_registry_id"
  },
  "export": {
    "bundler": "metro", "entryFile": "index.js", "nodeVersion": "24.19.0",
    "packageManager": { "name": "pnpm", "version": "11.19.0" }
  }
}
```

`metro` declares a plain React Native Metro job; `expo` selects the optional OSS export tool. The Runner must pin the commit/config/toolchain and publish its real output through Flora. A declaration alone does not prove that the native binary is configured, a build succeeded, or a device installed an update. JavaScript tests verify the facade/adapter contract; native engine tests additionally exercise signatures, hashes, storage and rollback. Device verification is a separate check; see the native integration guide.

### Opt-in device outcome reporting

`createFloraTelemetry` is exported from `@flora/ota`. Supply persistent app storage,
a cryptographically random UUID v4 factory, and an explicit environment classification.
Use `unknown` when the host cannot establish whether it is a physical device or a
simulator; the SDK never infers physical-device evidence from a successful request.

```ts
const telemetry = createFloraTelemetry(configuration, {
  storage: AsyncStorage,
  createId: () => Crypto.randomUUID(),
  environment: "unknown",
});
const engine = createFloraNativeEngine(nativeBridge, { telemetry });
const client = createFloraClient(configuration, engine, { telemetry });
const launch = await engine.getLaunchInfo();
// Confirm only after the actual application is ready, using this captured ID.
await engine.markLaunchSuccessful(launch.updateId);
```

The reporter uses only the configured HTTPS origin and app-bound
`/updates/<appId>/telemetry/session` and `/updates/<appId>/telemetry` endpoints.
Telemetry configuration requires a URL without query parameters. It sends a
random installation identifier, deployment scope, environment, outcome timestamps,
and whitelisted failure codes; it sends no hardware identifiers, account details,
asset paths, native messages, or stack traces. Server tickets are scope-bound and
stored privately alongside the outbox, never included in outcome metadata.

Storage operations have a bounded one-second default timeout. Hosts with slower
native filesystem initialization can set `storageTimeoutMs` up to five seconds.
The outbox holds at most 64 events and expires observations and launch receipts
after seven days, matching the server acceptance window. Networking runs in the background, reuses
unexpired tickets, renews a rejected ticket at most once per flush, acknowledges
complete batches of exact event IDs, and retries transient failures in the same
app execution at most twice after the existing 60-second and 120-second backoff.
One failure-driven timer runs only while eligible reports remain queued; idle
outboxes never poll. New lifecycle work can rearm this limited retry budget but
cannot bypass backoff. Authentication, invalid responses and storage failures do
not start automatic retries. Lifecycle activity or an explicit `telemetry.flush()`
can still attempt remaining work. Each requested pass processes at most four
batches and hands off requests arriving during its final acknowledgement or
completion. The current launch's reports take priority over older queued
deployments. If persistent storage fails,
reporting pauses for that reporter instance while native OTA operations continue.
The adapter records application only after native launch confirmation succeeds;
restart additionally requires a persisted activation request or verified download
from a different JS launch. Returning from `reload()` alone never establishes application or restart.
Events are best-effort observations, not a substitute for native signature and
asset verification or proof of every installation in the fleet.
