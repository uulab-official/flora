import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import withFloraOTA from "../plugin/index.cjs";

const require = createRequire(import.meta.url);
type NativeConfig = { appId: string; url: string; channel: string; runtimeVersion: string; certificate: string; keyId: string };
const transforms = require("../plugin/transforms.cjs") as {
  nativeConfiguration(options: unknown): NativeConfig;
  applyInfoPlist(plist: Record<string, unknown>, native: NativeConfig): Record<string, unknown>;
  disableAndroidUpdates(manifest: { manifest: { application: Array<Record<string, unknown>> } }): unknown;
  applyAppDelegate(contents: string): string;
  applyMainApplication(contents: string): string;
};
const certificate = await readFile(new URL("./fixtures/plugin-public-cert.pem", import.meta.url), "utf8");
const options: withFloraOTA.FloraOTAPluginOptions = { appId: "app_isso", url: "https://flora.example/updates/app_isso", channel: "flora-validation",
  runtimeVersion: "isso-native-1", certificate, keyId: "server-1", disableExpoUpdates: true };

const appDelegate = `internal import Expo
import React
import ReactAppDependencyProvider
@main
class AppDelegate: ExpoAppDelegate {
  // Existing app lifecycle and deep-link handlers must remain verbatim.
  func applicationDidBecomeActive() { productSession.resume() }
}
class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? { bridge.bundleURL ?? bundleURL() }
  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
`;
const mainApplication = `package kr.co.uulab.isso
import android.app.Application
import com.facebook.react.PackageList
import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ExpoReactHostFactory
class MainApplication : Application(), ReactApplication {
  override val reactHost: ReactHost by lazy {
    ExpoReactHostFactory.getDefaultReactHost(
      context = applicationContext,
      packageList = PackageList(this).packages.apply { add(ProductPackage()) }
    )
  }
  override fun onCreate() { super.onCreate(); loadReactNative(this); ApplicationLifecycleDispatcher.onApplicationCreate(this) }
}
`;

test("Flora plugin accepts only public app-bound HTTPS native trust settings", () => {
  const native = transforms.nativeConfiguration(options);
  assert.equal(native.appId, "app_isso");
  assert.equal(native.certificate, certificate);
  assert.equal(Object.keys(native).length, 6);
  assert.ok(!("disableExpoUpdates" in native));
  assert.equal(transforms.nativeConfiguration({ ...options, certificate: certificate.replaceAll("\n", "\r\n") }).certificate, certificate);
  assert.equal(transforms.nativeConfiguration({ ...options, url: options.url + "?channel=flora-validation" }).url, options.url + "?channel=flora-validation");
});

test("Flora plugin rejects foreign app, insecure origins, credentials and implicit loader replacement", () => {
  for (const invalid of [
    { ...options, appId: "app_promise" }, { ...options, url: "http://flora.example/updates/app_isso" },
    { ...options, url: "https://admin:password@flora.example/updates/app_isso" },
    { ...options, url: options.url + "?channel=production" }, { ...options, url: options.url + "#trust" },
    { ...options, url: options.url + "/" }, { ...options, url: "https://flora.example/a/../updates/app_isso" },
    { ...options, channel: "a/b" }, { ...options, keyId: "server\nkey" }, { ...options, runtimeVersion: "rn\0v1" }, { ...options, runtimeVersion: "가".repeat(43) },
    { ...options, disableExpoUpdates: false }, { ...options, disableExpoUpdates: undefined },
    { ...options, privateKey: "never-accept-server-private-material" }, { ...options, token: "never-accept-credentials" },
    { ...options, certificate: certificate + certificate }, { ...options, certificate: "-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----" },
  ]) assert.throws(() => transforms.nativeConfiguration(invalid), /FLORA_PLUGIN_CONFIGURATION_INVALID/);
});

test("Flora plugin rejects weak RSA and other signature algorithms", async () => {
  for (const file of ["plugin-weak-public-cert.pem", "plugin-ec-public-cert.pem"]) {
    const value = await readFile(new URL("./fixtures/" + file, import.meta.url), "utf8");
    assert.throws(() => transforms.nativeConfiguration({ ...options, certificate: value }), /FLORA_PLUGIN_CONFIGURATION_INVALID/);
  }
});

test("iOS app identity and trust configuration preserves unrelated native keys", () => {
  const existing = { CFBundleDisplayName: "Isso", NSCameraUsageDescription: "Scan product codes", ProductConfiguration: { storage: "existing" }, FloraOTAChannel: "former" };
  const result = transforms.applyInfoPlist(existing, transforms.nativeConfiguration(options));
  assert.equal(result.CFBundleDisplayName, "Isso");
  assert.equal(result.NSCameraUsageDescription, "Scan product codes");
  assert.deepEqual(result.ProductConfiguration, existing.ProductConfiguration);
  assert.equal(result.FloraOTAChannel, "flora-validation");
  assert.equal(result.FloraOTAAppId, "app_isso");
  assert.equal(result.FloraOTACertificate, certificate);
  assert.equal(existing.FloraOTAChannel, "former", "Never mutate the source configuration object");
});

test("iOS Expo plugin wraps only the release selector and is idempotent", () => {
  const result = transforms.applyAppDelegate(appDelegate);
  assert.equal((result.match(/^import FloraOta$/gm) ?? []).length, 1);
  assert.match(result, /return FloraOTAController\.bundleURL\(embedded: floraEmbeddedBundle\)/);
  assert.ok(result.includes('return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")'));
  assert.ok(result.includes('func applicationDidBecomeActive() { productSession.resume() }'));
  assert.ok(result.includes('override func sourceURL(for bridge: RCTBridge) -> URL? { bridge.bundleURL ?? bundleURL() }'));
  assert.equal(transforms.applyAppDelegate(result), result);
});

test("iOS plugin fails closed for unsupported or ambiguous selectors", () => {
  assert.throws(() => transforms.applyAppDelegate(appDelegate.replace("ExpoAppDelegate", "RCTAppDelegate")), /IOS_HOST_UNSUPPORTED/);
  assert.throws(() => transforms.applyAppDelegate(appDelegate.replace('"main"', '"product"')), /IOS_BUNDLE_SELECTOR_UNSUPPORTED/);
  assert.throws(() => transforms.applyAppDelegate(appDelegate + '\nreturn Bundle.main.url(forResource: "main", withExtension: "jsbundle")'), /IOS_BUNDLE_SELECTOR_UNSUPPORTED/);
});

test("Android Expo plugin registers the bridge and retains factory and lifecycle", () => {
  const result = transforms.applyMainApplication(mainApplication);
  assert.equal((result.match(/add\(FloraOtaPackage\(\)\)/g) ?? []).length, 1);
  assert.ok(result.includes("ExpoReactHostFactory.getDefaultReactHost("));
  assert.ok(result.includes("ApplicationLifecycleDispatcher.onApplicationCreate(this)"));
  assert.ok(result.includes("add(ProductPackage())"));
  assert.ok(result.includes("package kr.co.uulab.isso"));
  assert.equal(transforms.applyMainApplication(result), result);
});

test("Android Expo plugin rejects unrelated hosts and ambiguous package lists", () => {
  assert.throws(() => transforms.applyMainApplication(mainApplication.replace("ExpoReactHostFactory.getDefaultReactHost(", "DefaultReactHost.getDefaultReactHost(")), /ANDROID_HOST_UNSUPPORTED/);
  assert.throws(() => transforms.applyMainApplication(mainApplication.replace("PackageList(this).packages.apply {", "manualPackages.apply {")), /ANDROID_PACKAGE_LIST_UNSUPPORTED/);
  assert.throws(() => transforms.applyMainApplication(mainApplication + "\nPackageList(this).packages.apply { }"), /ANDROID_PACKAGE_LIST_UNSUPPORTED/);
});

test("Android plugin disables competing expo-updates while preserving other manifest metadata", () => {
  const manifest = { manifest: { application: [{ $: { "android:name": ".MainApplication" },
    "meta-data": [{ $: { "android:name": "product.analytics", "android:value": "existing-id" } },
      { $: { "android:name": "expo.modules.updates.ENABLED", "android:value": "true" } },
      { $: { "android:name": "expo.modules.updates.ENABLED", "android:value": "true" } }] }] } };
  transforms.disableAndroidUpdates(manifest);
  const metadata = manifest.manifest.application[0]!['meta-data'];
  assert.equal(metadata.length, 2);
  assert.equal(metadata[0]!.$['android:value'], "existing-id");
  assert.deepEqual(metadata[1], { $: { "android:name": "expo.modules.updates.ENABLED", "android:value": "false" } });
  const first = JSON.stringify(manifest);
  transforms.disableAndroidUpdates(manifest);
  assert.equal(JSON.stringify(manifest), first);
});
