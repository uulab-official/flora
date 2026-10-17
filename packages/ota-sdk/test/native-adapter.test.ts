import test from "node:test";
import assert from "node:assert/strict";
import { createFloraClient } from "../dist/index.js";
import { createFloraNativeEngine, FloraNativeError } from "../dist/native-adapter.js";
import type { FloraNativeBridge } from "../dist/native-adapter.js";
const configuration = { appId: "app_native", url: "https://ota.example.test/updates/app_native", channel: "preview", runtimeVersion: "native-v1", platform: "ios" as const };
const update = { id: "11111111-1111-4111-8111-111111111111", appId: configuration.appId, channel: configuration.channel, runtimeVersion: configuration.runtimeVersion, platform: configuration.platform };
const secondId = "22222222-2222-4222-8222-222222222222";
function fixture(overrides: Partial<FloraNativeBridge> = {}) {
  const calls: unknown[] = [];
  const bridge: FloraNativeBridge = {
    async getNativeConfiguration() { return { ...configuration, enabled: true }; },
    async check() { return { available: true, update }; },
    async download() { return { downloaded: true, update }; },
    async reload(id) { calls.push(["reload", id]); },
    async getLaunchInfo() { return { appId: configuration.appId, runtimeVersion: configuration.runtimeVersion, source: "embedded", updateId: null, assets: {} }; },
    async markLaunchSuccessful(id) { calls.push(["ready", id]); },
    ...overrides,
  };
  return { bridge, engine: createFloraNativeEngine(bridge), calls };
}
const invalid = (error: unknown) => error instanceof FloraNativeError && error.code === "NATIVE_RESULT_INVALID";
test("own native engine runs core check/download/reload without Expo or a React Native import", async () => {
  const fake = fixture(), client = createFloraClient(configuration, fake.engine);
  assert.deepEqual(await client.checkForUpdate(), { available: true, update });
  assert.deepEqual(await client.downloadUpdate(), { downloaded: true, update });
  await client.reload();
  assert.deepEqual(fake.calls, [["reload", update.id]]);
  assert.equal(fake.engine.name, "flora-native");
});
test("missing native bridge and partial modules produce a safe linking error", () => {
  for (const bridge of [undefined, null, {}, { check() {} }]) {
    assert.throws(() => createFloraNativeEngine(bridge as any), (error: unknown) => error instanceof FloraNativeError && error.code === "NATIVE_MODULE_UNAVAILABLE");
  }
});
test("native exceptions never expose credential, path or response messages", async () => {
  const fake = fixture({ async check() { throw new Error("secret token /private/path response"); } });
  await assert.rejects(fake.engine.check(), (error: unknown) => error instanceof FloraNativeError && error.message === "NATIVE_OPERATION_FAILED" && !("cause" in error));
});
test("native result shapes and app/runtime/platform/channel identities fail closed", async () => {
  for (const result of [null, [], {}, { available: 1 }, { available: true }, { available: true, update: { ...update, id: "bad" } }, ...["appId", "runtimeVersion", "channel", "platform"].map(key => ({ available: true, update: { ...update, [key]: "foreign" } }))]) {
    await assert.rejects(fixture({ async check() { return result; } }).engine.check(), invalid);
  }
  await assert.rejects(fixture({ async download() { return { downloaded: "yes" }; } }).engine.download(), invalid);
});
test("installed configuration is validated and cannot change between bridge operations", async () => {
  let changed = false;
  const fake = fixture({ async getNativeConfiguration() { return { ...configuration, enabled: true, runtimeVersion: changed ? "native-v2" : configuration.runtimeVersion }; } });
  await fake.engine.getNativeConfiguration(); changed = true;
  await assert.rejects(fake.engine.getNativeConfiguration(), invalid);
  await assert.rejects(fixture({ async getNativeConfiguration() { return { ...configuration, enabled: true, url: "http://unsafe.test" }; } }).engine.getNativeConfiguration(), invalid);
});
test("launch readiness forwards the captured ID rather than reading a newer active launch", async () => {
  let activeId = update.id;
  const fake = fixture({
    async getLaunchInfo() { return { appId: configuration.appId, runtimeVersion: configuration.runtimeVersion, source: "update", updateId: activeId, assets: {} }; },
    async markLaunchSuccessful(id) { if (id !== activeId) throw new Error("STALE_LAUNCH"); },
  });
  const launch = await fake.engine.getLaunchInfo(); activeId = secondId;
  await assert.rejects(fake.engine.markLaunchSuccessful(launch.updateId), /NATIVE_OPERATION_FAILED/);
  await fake.engine.markLaunchSuccessful(secondId);
  const embedded = fixture(); await embedded.engine.markLaunchSuccessful(null);
  assert.deepEqual(embedded.calls, [["ready", null]]);
});
test("launch info returns immutable snapshots including private asset URIs and rollback", async () => {
  const assets = { logo: "file:///private/flora/logo.png" };
  const fake = fixture({ async getLaunchInfo() { return { appId: configuration.appId, runtimeVersion: configuration.runtimeVersion, source: "update", updateId: update.id, assets, rollback: { updateId: secondId, reason: "UNCONFIRMED_LAUNCH" } }; } });
  const launch = await fake.engine.getLaunchInfo(); assets.logo = "file:///changed.png";
  assert.equal(launch.assets.logo, "file:///private/flora/logo.png");
  assert.equal(launch.rollback?.updateId, secondId);
  assert.ok(Object.isFrozen(launch) && Object.isFrozen(launch.assets) && Object.isFrozen(launch.rollback));
});
test("launch metadata rejects cross-app data, invalid source/ID and network assets", async () => {
  const launch = { appId: configuration.appId, runtimeVersion: configuration.runtimeVersion, source: "embedded", updateId: null, assets: {} };
  for (const change of [{ appId: "app_other" }, { runtimeVersion: "native-other" }, { source: "remote" }, { updateId: update.id }, { source: "update", updateId: null }, { assets: { logo: "https://example.test/logo.png" } }, { rollback: true }, { rollback: { updateId: "bad", reason: "UNCONFIRMED_LAUNCH" } }]) {
    await assert.rejects(fixture({ async getLaunchInfo() { return { ...launch, ...change }; } }).engine.getLaunchInfo(), invalid);
  }
});
test("real app launch metadata preserves 46 assets, admits 64 and rejects 65", async () => {
  const launch = { appId: configuration.appId, runtimeVersion: configuration.runtimeVersion, source: "update", updateId: update.id };
  const assets = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`asset_${index}`, `file:///private/flora/asset-${index}.png`]));
  for (const count of [46, 64]) {
    const expected = assets(count);
    const result = await fixture({ async getLaunchInfo() { return { ...launch, assets: expected }; } }).engine.getLaunchInfo();
    assert.equal(Object.keys(result.assets).length, count);
    assert.equal(result.assets[`asset_${count - 1}`], `file:///private/flora/asset-${count - 1}.png`);
    assert.ok(Object.isFrozen(result.assets));
  }
  await assert.rejects(fixture({ async getLaunchInfo() { return { ...launch, assets: assets(65) }; } }).engine.getLaunchInfo(), invalid);
  await assert.rejects(fixture({ async getLaunchInfo() { return { ...launch, appId: "app_other", assets: assets(46) }; } }).engine.getLaunchInfo(), invalid);
  await assert.rejects(fixture({ async getLaunchInfo() { return { ...launch, assets: { ...assets(46), asset_45: "https://example.test/tampered.png" } }; } }).engine.getLaunchInfo(), invalid);
});
test("invalid readiness and reload IDs never reach the native bridge", async () => {
  const fake = fixture();
  await assert.rejects(fake.engine.reload("bad"), invalid);
  await assert.rejects(fake.engine.markLaunchSuccessful("bad"), invalid);
  assert.deepEqual(fake.calls, []);
});
