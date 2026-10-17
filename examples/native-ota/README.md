# Two independent bare React Native OTA fixtures

These are isolated acceptance fixtures for the Flora native engine. They use React Native 0.86.3 and React 19.2.3 without Expo or EAS. The generator verifies the official template archive SHA-256 and refuses to overwrite either generated Git repository.

Generate a backend acceptance configuration and local TLS/signing certificates first, then run:

```sh
node scripts/native-qa/generate-apps.mjs /tmp/flora-native-qa/config.json
node scripts/native-qa/build-app.mjs /tmp/flora-native-qa/config.json a android
node scripts/native-qa/build-app.mjs /tmp/flora-native-qa/config.json b ios
```

The configuration supplies two distinct registered application IDs, Android/iOS package IDs, signing certificate, local HTTPS certificate, and the freshly packed `@flora/ota` SDK tarball. Generated repositories live under `/tmp/flora-native-qa/apps/a` and `b`; existing user apps and databases are not modified.

Release builds contain an embedded V1 bundle. Set each repository's `fixture.json` version to V2, export each platform with its pinned Metro CLI, and publish through the acceptance backend. The visible button or `floraqa://update` link checks, downloads, and applies the signed app-scoped update. Each launch displays its exact native update ID and asset URI and acknowledges that ID after rendering. `noReady: true` deliberately leaves the candidate unacknowledged to test rollback on the next process launch.

Only these QA binaries trust the generated local HTTPS certificate for `127.0.0.1`. Their engines retain normal HTTPS validation, signature checks, and app/runtime boundaries. Never reuse this QA trust configuration in a production app.

For a machine with little disk space, `temporaryRoot` may point to an explicitly created temporary volume. The build driver directs Xcode derived data, CocoaPods cache, and temporary downloads there. Set `sdkAlreadyInstalled: true` only after extracting the verified SDK tarball into the generated apps' shared dependency directory; npm removes a symlinked `node_modules` when installing. `gradleUserHome` can select a compatible existing Gradle cache. The driver applies a small task-name selector fix to the generated fixture's React Native Gradle plugin because its published formatting-task class reference is unavailable with the selected plugin version. It does not modify sibling projects.

After building the embedded V1 binaries, commit their final SDK dependency lock and native host integration before exporting OTA bundles:

```sh
node scripts/native-qa/export-bundle.mjs /tmp/flora-native-qa/config.json a android V2
node scripts/native-qa/export-bundle.mjs /tmp/flora-native-qa/config.json b ios V2
```

Each exported bundle records a real Git commit SHA. Test all four app/platform combinations separately. Keep the APKs, simulator `.app` bundles, signed OTA output, screenshots, launch telemetry, and backend verification report as distinct evidence. Native launch telemetry contains the running JavaScript bundle version, so a cache pointer change cannot stand in for a successful V2 runtime.

Before removing a temporary volume, preserve both Git repositories without dependency/build intermediates:

```sh
node scripts/native-qa/preserve-fixtures.mjs /tmp/flora-native-qa/config.json
```

This copies tracked source and Git history into `/tmp/flora-native-qa/repositories/{a,b}` and refuses to overwrite an existing snapshot. Copy final APKs and `.app` bundles into durable artifact directories separately.

Paths default to the configuration file’s directory, and `qaDirectory`, `output`, or each app’s `repositoryDirectory` can place fixtures in a fresh isolated root. Tool discovery uses the current Node installation for npm, `ANDROID_HOME`/`ANDROID_SDK_ROOT` for the SDK, and `JAVA_HOME` or the platform’s Java installation. CocoaPods uses `POD_BINARY`, then PATH, then a user Ruby gem installation. iOS builds still require macOS and Xcode.
