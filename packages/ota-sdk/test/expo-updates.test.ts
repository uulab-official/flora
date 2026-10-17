import test from "node:test";
import assert from "node:assert/strict";
import { createFloraClient } from "../dist/index.js";
import { createExpoUpdatesAdapter } from "../dist/expo-updates.js";
const binding = { appId: "app_fixture", url: "https://updates.fixture.test/updates/app_fixture", channel: "preview", runtimeVersion: "native-v1", platform: "ios" as const, enabled: true };
const manifest = { id: "11111111-1111-4111-8111-111111111111", runtimeVersion: "native-v1", metadata: { channel: "preview" }, extra: { flora: { appId: "app_fixture" } } };
test("optional Expo adapter uses OSS native methods and Flora manifest binding without EAS identifiers", async () => {
  const calls: string[] = []; const module = { isEnabled: true, runtimeVersion: "native-v1", async checkForUpdateAsync() { calls.push("check"); return { isAvailable: true, manifest }; }, async fetchUpdateAsync() { calls.push("fetch"); return { isNew: true, manifest }; }, async reloadAsync() { calls.push("reload"); } };
  const client = createFloraClient(binding, createExpoUpdatesAdapter(module, async () => binding));
  assert.equal((await client.checkForUpdate()).available, true); assert.equal((await client.downloadUpdate()).downloaded, true); await client.reload(); assert.deepEqual(calls, ["check", "fetch", "reload"]);
});
test("rejects an unbound Expo manifest and never reloads a foreign app", async () => {
  let reloaded = false;const module = { isEnabled: true, runtimeVersion: "native-v1", async checkForUpdateAsync() { return { isAvailable: true, manifest: { ...manifest, extra: { flora: { appId: "app_other" } } } }; }, async fetchUpdateAsync() { return { isNew: true, manifest }; }, async reloadAsync() { reloaded = true; } };
  const client = createFloraClient(binding, createExpoUpdatesAdapter(module, async () => binding));await assert.rejects(client.checkForUpdate());await assert.rejects(client.reload());assert.equal(reloaded, false);
});
test("disabled or conflicting native Expo runtime is rejected before download", async () => {
  let fetched = false;const module = { isEnabled: false, runtimeVersion: null, async checkForUpdateAsync() { return { isAvailable: false }; }, async fetchUpdateAsync() { fetched = true; return { isNew: false }; }, async reloadAsync() {} };
  const client = createFloraClient(binding, createExpoUpdatesAdapter(module, async () => binding));await assert.rejects(client.checkForUpdate());assert.equal(fetched, false);
});

test("native rollback responses never become a downloaded Flora update", async () => {
  let reloaded = false;const module = { isEnabled: true, runtimeVersion: "native-v1", async checkForUpdateAsync() { return { isAvailable: true, manifest }; }, async fetchUpdateAsync() { return { isRollBackToEmbedded: true }; }, async reloadAsync() { reloaded = true; } };
  const client = createFloraClient(binding, createExpoUpdatesAdapter(module, async () => binding));await client.checkForUpdate();assert.deepEqual(await client.downloadUpdate(), { downloaded: false });await assert.rejects(client.reload());assert.equal(reloaded, false);
});
test("malformed native method results fail closed instead of reporting no update", async () => {
  const module = { isEnabled: true, runtimeVersion: "native-v1", async checkForUpdateAsync() { return {}; }, async fetchUpdateAsync() { return {}; }, async reloadAsync() {} };
  const client = createFloraClient(binding, createExpoUpdatesAdapter(module, async () => binding));await assert.rejects(client.checkForUpdate());
});
