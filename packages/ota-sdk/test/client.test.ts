import test from "node:test";
import assert from "node:assert/strict";
import { createFloraClient, FloraOTAError } from "../dist/index.js";
import type { FloraConfiguration, NativeUpdateEngine, UpdateIdentity } from "../dist/index.js";
const configuration: FloraConfiguration = { appId: "app_fixture", url: "https://updates.fixture.test/updates/app_fixture", channel: "preview", runtimeVersion: "native-v1", platform: "ios" };
const identity: UpdateIdentity = { id: "11111111-1111-4111-8111-111111111111", appId: configuration.appId, channel: "preview", runtimeVersion: "native-v1", platform: "ios" };
function engine(overrides: Partial<NativeUpdateEngine> = {}) {
  const calls: string[] = [];
  const adapter: NativeUpdateEngine = {
    name: "fixture-native-engine", protocol: "expo-updates-v1", trust: "native-engine",
    async getNativeConfiguration() { return { ...configuration, enabled: true }; },
    async check() { calls.push("check"); return { available: true, update: identity }; },
    async download() { calls.push("download"); return { downloaded: true, update: identity }; },
    async reload(updateId) { calls.push("reload:" + updateId); }, ...overrides,
  };
  return { adapter, calls };
}
test("Flora facade checks/downloads/reloads through the native engine only", async () => {
  const fake = engine(); const client = createFloraClient(configuration, fake.adapter);
  assert.deepEqual(await client.checkForUpdate(), { available: true, update: identity });
  assert.deepEqual(await client.downloadUpdate(), { downloaded: true, update: identity });
  await client.reload(); assert.deepEqual(fake.calls, ["check", "download", "reload:" + identity.id]);
});
test("rejects non-HTTPS and foreign app-bound endpoints before invoking an engine", () => {
  for (const url of ["http://updates.fixture.test/updates/app_fixture", "https://updates.fixture.test/updates/app_other", "https://secret@updates.fixture.test/updates/app_fixture", configuration.url + "?channel=production"]) assert.throws(() => createFloraClient({ ...configuration, url }, engine().adapter), FloraOTAError);
});
test("fails closed on installed native runtime/platform/app/channel/URL mismatch", async () => {
  for (const change of [{ runtimeVersion: "other" }, { platform: "android" }, { appId: "app_other" }, { channel: "production" }, { url: "https://other.fixture.test/updates/app_fixture" }, { enabled: false }]) {
    const fake = engine({ async getNativeConfiguration() { return { ...configuration, enabled: true, ...change } as any; } });
    await assert.rejects(createFloraClient(configuration, fake.adapter).checkForUpdate(), FloraOTAError); assert.deepEqual(fake.calls, []);
  }
});
test("foreign app/channel/runtime/platform update receipts cannot download or reload", async () => {
  for (const change of [{ appId: "app_other" }, { channel: "production" }, { runtimeVersion: "other" }, { platform: "android" }]) {
    const fake = engine({ async check() { return { available: true, update: { ...identity, ...change } as UpdateIdentity }; } }); const client = createFloraClient(configuration, fake.adapter);
    await assert.rejects(client.checkForUpdate(), FloraOTAError); await assert.rejects(client.downloadUpdate(), FloraOTAError); assert.deepEqual(fake.calls, []);
  }
});
test("download changing update identity cannot enable reload", async () => {
  const fake = engine({ async download() { return { downloaded: true, update: { ...identity, id: "22222222-2222-4222-8222-222222222222" } }; } });const client = createFloraClient(configuration, fake.adapter);
  await client.checkForUpdate(); await assert.rejects(client.downloadUpdate(), FloraOTAError); await assert.rejects(client.reload(), FloraOTAError);
});
test("revalidates native configuration before reload and serializes concurrent actions", async () => {
  let altered = false; let unblock!: () => void; const gate = new Promise<void>(done => { unblock = done; });
  const fake = engine({ async check() { await gate; return { available: true, update: identity }; }, async getNativeConfiguration() { return { ...configuration, runtimeVersion: altered ? "changed" : configuration.runtimeVersion, enabled: true }; } });const client = createFloraClient(configuration, fake.adapter);
  const checking = client.checkForUpdate(); await assert.rejects(client.checkForUpdate(), (e: unknown) => e instanceof FloraOTAError && e.code === "BUSY");unblock();await checking;await client.downloadUpdate();altered = true;await assert.rejects(client.reload(), FloraOTAError);assert.ok(!fake.calls.some(call => call.startsWith("reload")));
});

test("native signature/download failures propagate without enabling executable reload", async () => {
  const fake = engine({ async download() { throw new Error("NATIVE_SIGNATURE_REJECTED"); } });const client = createFloraClient(configuration, fake.adapter);
  await client.checkForUpdate();await assert.rejects(client.downloadUpdate(), /NATIVE_SIGNATURE_REJECTED/);await assert.rejects(client.reload(), FloraOTAError);assert.ok(!fake.calls.some(call => call.startsWith("reload")));
});
test("configuration and checked receipts are copied so caller mutations cannot change app binding", async () => {
  const input = { ...configuration };const original = { ...identity };const fake = engine({ async check() { return { available: true, update: original }; } });const client = createFloraClient(input, fake.adapter);
  input.appId = "app_other";await client.checkForUpdate();original.appId = "app_other";await client.downloadUpdate();await client.reload();assert.equal(client.configuration.appId, "app_fixture");
});
