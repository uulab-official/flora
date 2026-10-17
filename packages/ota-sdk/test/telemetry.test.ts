import test from "node:test";
import assert from "node:assert/strict";
import { createFloraTelemetry, floraTelemetryErrorCode, createFloraClient } from "../dist/index.js";
import { createFloraNativeEngine } from "../dist/native-adapter.js";
import type { FloraTelemetryOptions, FloraConfiguration, NativeUpdateEngine } from "../dist/index.js";
const config: FloraConfiguration = { appId: "app_fixture", url: "https://updates.fixture.test/updates/app_fixture", channel: "qa", runtimeVersion: "v1", platform: "android" };
const deployment = "11111111-1111-4111-8111-111111111111";
const launch = { appId: config.appId, runtimeVersion: "v1", source: "update" as const, updateId: deployment };
function harness() {
  let clock = 1700000000000, sequence = 0;
  const saved = new Map<string, string>(), requests: { url: string; body: any }[] = [];
  let offline = false, partial = false;
  const options: FloraTelemetryOptions = {
    createId: () => (++sequence).toString(16).padStart(8, "0") + "-1234-4123-8123-123456789012", environment: "android-emulator", now: () => clock,
    storage: { async getItem(key) { return saved.get(key) ?? null; }, async setItem(key, value) { saved.set(key, value); } },
    fetch: async (url, init) => {
      const body = JSON.parse(init!.body as string); requests.push({ url: String(url), body });
      if (offline) throw new Error("https://secret:token@example.com");
      return new Response(JSON.stringify(String(url).endsWith("/session") ? { token: "scoped-ticket", expiresAt: clock + 3600000 } : { acknowledged: partial ? [] : body.events.map((e: any) => e.id) }));
    },
  };
  return { options, saved, requests, offline(value: boolean) { offline = value; }, partial(value: boolean) { partial = value; }, advance(ms = 3600001) { clock += ms; } };
}
test("durable offline replay retains installation and event IDs, backoff prevents repeated requests", async () => {
  const h = harness(); h.offline(true); const reporter = createFloraTelemetry(config, h.options);
  await reporter.record(deployment, "downloaded"); await reporter.flush(); const before = JSON.parse([...h.saved.values()][0]!);
  await reporter.flush(); assert.equal(h.requests.length, 1);
  h.offline(false); const replacement = createFloraTelemetry(config, h.options); await replacement.flush();
  assert.equal(h.requests[1]!.body.installationId, before.installationId);
  assert.equal(h.requests[2]!.body.events[0].id, before.events[0].event.id);
  assert.equal(JSON.parse([...h.saved.values()][0]!).events.length, 0);
});
test("reload request and same-launch confirmation cannot fabricate restart; next native-confirmed launch can", async () => {
  const h = harness(); h.offline(true); const first = createFloraTelemetry(config, h.options);
  await first.beginLaunch(launch); await first.requestActivation(deployment); await first.confirmLaunch(deployment); await first.flush();
  let types = JSON.parse([...h.saved.values()][0]!).events.map((e: any) => e.event.type);
  assert.ok(types.includes("activation_requested")); assert.ok(types.includes("launch_confirmed")); assert.ok(!types.includes("restart_confirmed"));
  const second = createFloraTelemetry(config, h.options); await second.beginLaunch(launch); await second.confirmLaunch("22222222-2222-4222-8222-222222222222"); await second.flush();
  assert.ok(!JSON.parse([...h.saved.values()][0]!).events.some((e: any) => e.event.type === "restart_confirmed"));
  await second.confirmLaunch(deployment); await second.flush();
  types = JSON.parse([...h.saved.values()][0]!).events.map((e: any) => e.event.type); assert.ok(types.includes("restart_confirmed"));
});
test("tickets and storage keys stay app/runtime/channel/platform scoped; endpoints reject query and credentials", async () => {
  const h = harness(); const a = createFloraTelemetry(config, h.options); await a.record(deployment, "update_seen"); await a.flush();
  const b = createFloraTelemetry({ ...config, appId: "app_other", url: "https://updates.fixture.test/updates/app_other" }, h.options); await b.record(deployment, "update_seen"); await b.flush();
  assert.equal(h.saved.size, 2); assert.notEqual(h.requests[0]!.body.installationId, h.requests[2]!.body.installationId);
  for (const request of h.requests) assert.ok(request.url.startsWith("https://updates.fixture.test/updates/app_"));
  for (const url of [config.url + "?channel=qa", config.url.replace("https://", "https://secret@")]) assert.throws(() => createFloraTelemetry({ ...config, url }, h.options));
});
test("partial acknowledgements never lose queued events", async () => {
  const h = harness(); h.partial(true); const reporter = createFloraTelemetry(config, h.options); await reporter.record(deployment, "downloaded"); await reporter.flush();
  assert.equal(JSON.parse([...h.saved.values()][0]!).events.length, 1); h.partial(false); h.advance(); await reporter.flush(); assert.equal(JSON.parse([...h.saved.values()][0]!).events.length, 0);
});
test("concurrent writes survive in-flight acknowledgements", async () => {
  const h = harness(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const original = h.options.fetch!; h.options.fetch = async (url, init) => { if (!String(url).endsWith("/session")) await gate; return original(url, init); };
  const reporter = createFloraTelemetry(config, h.options); await reporter.record(deployment, "update_seen");
  await new Promise(resolve => setTimeout(resolve, 5)); await reporter.record(deployment, "downloaded"); release(); await reporter.flush();
  const persisted = JSON.parse([...h.saved.values()][0]!); assert.deepEqual(persisted.events.map((e: any) => e.event.type), []);
  await reporter.flush(); assert.equal(JSON.parse([...h.saved.values()][0]!).events.length, 0);
});
test("failure codes allow only exact safe codes; rollback retains prior deployment identity", async () => {
  assert.equal(floraTelemetryErrorCode({ message: "NETWORK_TIMEOUT" }, "UNKNOWN"), "TIMEOUT");
  assert.equal(floraTelemetryErrorCode({ message: "SIGNATURE_INVALID token=secret" }, "UNKNOWN"), "UNKNOWN");
  const h = harness(); h.offline(true); const reporter = createFloraTelemetry(config, h.options);
  await reporter.beginLaunch({ ...launch, source: "embedded", updateId: null, rollback: { updateId: deployment, reason: "UNCONFIRMED_LAUNCH" } }); await reporter.flush();
  const event = JSON.parse([...h.saved.values()][0]!).events[0]; assert.equal(event.deploymentId, deployment); assert.equal(event.event.type, "rolled_back"); assert.equal(event.event.code, "UNCONFIRMED_LAUNCH");
});
test("telemetry storage timeout never prevents native operations and emits no reload success", async () => {
  const h = harness(); h.options.storage = { getItem: () => new Promise(() => {}), setItem: () => new Promise(() => {}) }; h.options.storageTimeoutMs = 10;
  const reporter = createFloraTelemetry(config, h.options), identity = { ...config, id: deployment };
  let reloaded = false;
  const engine: NativeUpdateEngine = { name: "test", protocol: "expo-updates-v1", trust: "native-engine", async getNativeConfiguration() { return { ...config, enabled: true }; }, async check() { return { available: true, update: identity }; }, async download() { return { downloaded: true, update: identity }; }, async reload() { reloaded = true; } };
  const client = createFloraClient(config, engine, { telemetry: reporter }); await client.checkForUpdate(); await client.downloadUpdate(); await client.reload(); assert.equal(reloaded, true); await reporter.flush();
  assert.equal(h.requests.length, 0);
});
test("native readiness failure cannot report launch success; sanitized native failure preserves facade error", async () => {
  const h = harness(); h.offline(true); const reporter = createFloraTelemetry(config, h.options);
  const bridge = { async getNativeConfiguration() { return { ...config, enabled: true }; }, async check() { return { available: true, update: { ...config, id: deployment } }; }, async download() { throw new Error("ASSET_HASH_MISMATCH"); }, async reload() {}, async getLaunchInfo() { return { ...launch, assets: {} }; }, async markLaunchSuccessful() { throw new Error("private native message"); } };
  const engine = createFloraNativeEngine(bridge, { telemetry: reporter }); const client = createFloraClient(config, engine, { telemetry: reporter });
  await engine.getLaunchInfo(); await assert.rejects(engine.markLaunchSuccessful(deployment), /NATIVE_OPERATION_FAILED/); await client.checkForUpdate(); await assert.rejects(client.downloadUpdate(), /NATIVE_OPERATION_FAILED/); await reporter.flush();
  const events = JSON.parse([...h.saved.values()][0]!).events.map((e: any) => e.event);
  assert.ok(!events.some((e: any) => e.type === "launch_confirmed")); assert.ok(events.some((e: any) => e.code === "ASSET_HASH_MISMATCH")); assert.ok(events.some((e: any) => e.code === "LAUNCH_CONFIRMATION_FAILED")); assert.ok(!JSON.stringify(events).includes("private"));
});
test("outbox remains bounded and ticket is reused until expiry", async () => {
  const h = harness(); h.offline(true); const reporter = createFloraTelemetry(config, h.options);
  for (let i = 1; i <= 80; i++) await reporter.record(i.toString(16).padStart(8, "0") + "-1111-4111-8111-111111111111", "update_seen");
  await reporter.flush(); assert.equal(JSON.parse([...h.saved.values()][0]!).events.length, 64);
  const fresh = harness(), second = createFloraTelemetry(config, fresh.options); await second.record(deployment, "update_seen"); await second.flush(); await second.record(deployment, "downloaded"); await second.flush();
  assert.equal(fresh.requests.filter(r => r.url.endsWith("/session")).length, 1);
  fresh.advance(); await second.record(deployment, "failed", { stage: "activation", code: "ACTIVATION_FAILED" }); await second.flush(); assert.equal(fresh.requests.filter(r => r.url.endsWith("/session")).length, 2);
});
test("unknown environment stays unknown, and foreign captured launches cannot be confirmed", async () => {
  const h = harness(); h.options.environment = "unknown"; const reporter = createFloraTelemetry(config, h.options);
  await reporter.beginLaunch({ ...launch, appId: "app_other" }); await reporter.confirmLaunch(deployment); await reporter.flush(); assert.equal(h.requests.length, 0);
  await reporter.record(deployment, "downloaded"); await reporter.flush(); assert.equal(h.requests[0]!.body.environment, "unknown");
  assert.throws(() => createFloraTelemetry({ ...config, platform: "ios" }, { ...h.options, environment: "android-emulator" }));
});
test("a verified download applied on next cold start proves restart without requiring reload", async () => {
  const h = harness(); h.offline(true); const first = createFloraTelemetry(config, h.options);
  await first.record(deployment, "downloaded"); await first.flush();
  const second = createFloraTelemetry(config, h.options); await second.beginLaunch(launch); await second.confirmLaunch(deployment); await second.flush();
  assert.ok(JSON.parse([...h.saved.values()][0]!).events.some((e: any) => e.event.type === "restart_confirmed"));
});
test("every emitted event matches the strict success/failure protocol including replay", async () => {
  const h = harness(); h.offline(true); const first = createFloraTelemetry(config, h.options);
  await first.beginLaunch(launch);
  await first.record(deployment, "update_seen", { stage: "check", code: "UNKNOWN" });
  await first.record(deployment, "downloaded", { stage: "download" });
  await first.requestActivation(deployment);
  await first.record(deployment, "failed", { stage: "download", code: "ASSET_HASH_MISMATCH" }); await first.flush();
  const second = createFloraTelemetry(config, h.options); await second.beginLaunch({ ...launch, rollback: { updateId: deployment, reason: "UNCONFIRMED_LAUNCH" } }); await second.confirmLaunch(deployment); await second.flush();
  h.offline(false); h.advance(); await second.flush();
  const sent = h.requests.filter(request => request.url.endsWith("/telemetry")).flatMap(request => request.body.events);
  assert.deepEqual(new Set(sent.map(event => event.type)), new Set(["update_seen", "downloaded", "activation_requested", "launch_confirmed", "restart_confirmed", "failed", "rolled_back"]));
  for (const event of sent) assert.deepEqual(Object.keys(event).sort(), ["failed", "rolled_back"].includes(event.type) ? ["code", "id", "observedAt", "stage", "type"] : ["id", "observedAt", "type"]);
});
test("environment change renews scoped tickets without replacing installation identity", async () => {
  const h = harness(); h.options.environment = "unknown"; const first = createFloraTelemetry(config, h.options); await first.record(deployment, "update_seen"); await first.flush();
  const second = createFloraTelemetry(config, { ...h.options, environment: "physical-device" }); await second.record(deployment, "downloaded"); await second.flush();
  const sessions = h.requests.filter(request => request.url.endsWith("/session")); assert.equal(sessions.length, 2); assert.equal(sessions[0]!.body.installationId, sessions[1]!.body.installationId); assert.equal(sessions[1]!.body.environment, "physical-device");
});
test("events and launch proofs older than seven days cannot poison fresh batches", async () => {
  const h = harness(); h.offline(true); const reporter = createFloraTelemetry(config, h.options); await reporter.record(deployment, "downloaded"); await reporter.requestActivation(deployment); await reporter.flush();
  h.advance(8 * 24 * 60 * 60 * 1000); h.offline(false);
  const freshDeployment = "22222222-2222-4222-8222-222222222222"; await reporter.record(freshDeployment, "update_seen"); await reporter.flush();
  const batches = h.requests.filter(request => request.url.endsWith("/telemetry")); assert.equal(batches.length, 1); assert.deepEqual(batches[0]!.body.events.map((event: any) => event.type), ["update_seen"]);
  const saved = JSON.parse([...h.saved.values()][0]!); assert.equal(saved.events.length, 0); assert.equal(saved.pending, undefined); assert.equal(saved.downloaded, undefined);
});
test("a revoked cached ticket is renewed once and preserves queued event IDs", async () => {
  const h = harness(), original = h.options.fetch!; let rejected = false;
  h.options.fetch = async (url, init) => { if (String(url).endsWith("/telemetry") && !rejected) { rejected = true; return new Response("{}", { status: 401 }); } return original(url, init); };
  const reporter = createFloraTelemetry(config, h.options); await reporter.record(deployment, "downloaded"); await reporter.flush();
  assert.equal(h.requests.filter(request => request.url.endsWith("/session")).length, 2); assert.equal(JSON.parse([...h.saved.values()][0]!).events.length, 0);
});
test("clock rollback cannot establish new success from a future pending observation", async () => {
  const h = harness(); h.offline(true); const reporter = createFloraTelemetry(config, h.options); await reporter.record(deployment, "downloaded"); await reporter.flush(); h.advance(-3600000); await reporter.beginLaunch(launch); await reporter.confirmLaunch(deployment); await reporter.flush();
  assert.ok(!JSON.parse([...h.saved.values()][0]!).events.some((entry: any) => entry.event.type === "launch_confirmed" || entry.event.type === "restart_confirmed"));
});
test("failure dedup preserves stages and missing failure fields normalize to strict safe defaults", async () => {
  const h = harness(); h.offline(true); const reporter = createFloraTelemetry(config, h.options);
  await reporter.record(deployment, "failed", { stage: "check", code: "NETWORK_UNAVAILABLE" }); await reporter.record(deployment, "failed", { stage: "download", code: "NETWORK_UNAVAILABLE" }); await reporter.record(deployment, "failed"); await reporter.flush();
  h.offline(false); h.advance(); await reporter.flush(); const events = h.requests.find(request => request.url.endsWith("/telemetry"))!.body.events;
  assert.equal(events.length, 3); assert.deepEqual(events.map((event: any) => [event.stage, event.code]), [["check", "NETWORK_UNAVAILABLE"], ["download", "NETWORK_UNAVAILABLE"], ["launch", "UNKNOWN"]]);
  for (const event of events) assert.deepEqual(Object.keys(event).sort(), ["code", "id", "observedAt", "stage", "type"]);
});
test("the default storage budget tolerates a 250 ms cold native filesystem read", async () => {
  const h = harness(), storage = h.options.storage;
  h.options.storage = { async getItem(key) { await new Promise(resolve => setTimeout(resolve, 250)); return storage.getItem(key); }, setItem: storage.setItem };
  const reporter = createFloraTelemetry(config, h.options); await reporter.record(deployment, "downloaded"); await reporter.flush();
  assert.equal(h.requests.filter(request => request.url.endsWith("/session")).length, 1);
  assert.equal(h.requests.find(request => request.url.endsWith("/telemetry"))!.body.events[0].type, "downloaded");
  assert.equal(JSON.parse([...h.saved.values()][0]!).events.length, 0);
});
test("launch confirmation appended during a boot flush drains without another lifecycle event", async () => {
  const h = harness(); h.offline(true); const previous = createFloraTelemetry(config, h.options);
  await previous.record(deployment, "downloaded"); await previous.requestActivation(deployment); await previous.flush(); h.offline(false);
  let release!: () => void, entered!: () => void; const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const original = h.options.fetch!; let batches = 0;
  h.options.fetch = async (url, init) => { if (String(url).endsWith("/telemetry") && ++batches === 1) { entered(); await held; } return original(url, init); };
  const current = createFloraTelemetry(config, h.options); await current.beginLaunch(launch); await started;
  await current.confirmLaunch(deployment); release(); await current.flush();
  const reports = h.requests.filter(request => request.url.endsWith("/telemetry"));
  assert.equal(reports.length, 2); assert.deepEqual(reports[1]!.body.events.map((event: any) => event.type), ["launch_confirmed", "restart_confirmed"]);
  assert.equal(JSON.parse([...h.saved.values()][0]!).events.length, 0);
  await current.flush(); assert.equal(h.requests.filter(request => request.url.endsWith("/telemetry")).length, 2);
});
test("draining concurrent work retains the four-batch traffic budget", async () => {
  const h = harness(); h.offline(true); const reporter = createFloraTelemetry(config, h.options);
  for (let i = 1; i <= 8; i++) await reporter.record(i.toString(16).padStart(8, "0") + "-1111-4111-8111-111111111111", "update_seen"); await reporter.flush();
  h.offline(false); h.advance(); await reporter.flush();
  assert.equal(h.requests.filter(request => request.url.endsWith("/telemetry")).length, 4); assert.equal(JSON.parse([...h.saved.values()][0]!).events.length, 4);
});
test("native confirmation arriving during the last boot batch is reported without another launch or flush", async () => {
  const h = harness(); h.offline(true); const previous = createFloraTelemetry(config, h.options);
  for (let i = 2; i <= 4; i++) await previous.record(i.toString(16).padStart(8, "0") + "-1111-4111-8111-111111111111", "update_seen");
  await previous.record(deployment, "downloaded"); await previous.requestActivation(deployment); await previous.flush(); h.offline(false);
  let release!: () => void, entered!: () => void; const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const original = h.options.fetch!; let batches = 0;
  h.options.fetch = async (url, init) => { if (String(url).endsWith("/telemetry") && ++batches === 4) { entered(); await held; } return original(url, init); };
  const current = createFloraTelemetry(config, h.options); await current.beginLaunch(launch); await started;
  await current.confirmLaunch(deployment); release();
  // Observe the background lifecycle kick, without another flush or native launch
  // that could otherwise hide a lost wakeup at the bounded batch boundary.
  await new Promise<void>(resolve => setImmediate(resolve));
  const reports = h.requests.filter(request => request.url.endsWith("/telemetry"));
  assert.equal(reports.length, 5);
  assert.deepEqual(reports[4]!.body.events.map((event: any) => event.type), ["launch_confirmed", "restart_confirmed"]);
  assert.equal(JSON.parse([...h.saved.values()][0]!).events.length, 0);
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(h.requests.filter(request => request.url.endsWith("/telemetry")).length, 5);
});
test("transient launch reporting retries after backoff in the same session with stable event and installation IDs", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(), original = h.options.fetch!; let firstReport = true;
  h.options.fetch = async (url, init) => {
    if (String(url).endsWith("/telemetry") && firstReport) { firstReport = false; h.offline(true); try { return await original(url, init); } finally { h.offline(false); } }
    return original(url, init);
  };
  const reporter = createFloraTelemetry(config, h.options); await reporter.beginLaunch(launch); await reporter.confirmLaunch(deployment); await reporter.flush();
  const pending = JSON.parse([...h.saved.values()][0]!); assert.equal(pending.events.length, 1); assert.equal(h.requests.length, 2);
  h.advance(59_999); t.mock.timers.tick(59_999); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(h.requests.length, 2);
  h.advance(1); t.mock.timers.tick(1); await new Promise<void>(resolve => setImmediate(resolve));
  const reports = h.requests.filter(request => request.url.endsWith("/telemetry"));
  assert.equal(reports.length, 2); assert.deepEqual(reports[1]!.body.events, reports[0]!.body.events);
  const persisted = JSON.parse([...h.saved.values()][0]!); assert.equal(persisted.installationId, pending.installationId); assert.equal(persisted.events.length, 0);
  h.advance(); t.mock.timers.tick(3_600_001); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(h.requests.length, 3);
});
test("autonomous retry is capped at two attempts and new work preserves the exponential backoff", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(); h.offline(true); const reporter = createFloraTelemetry(config, h.options);
  await reporter.record(deployment, "update_seen"); await reporter.flush(); assert.equal(h.requests.length, 1);
  for (const [delay, count] of [[60_000, 2], [120_000, 3], [120_000, 3]] as const) { h.advance(delay); t.mock.timers.tick(delay); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(h.requests.length, count); }
  // A later lifecycle event can rearm the bounded retry budget, but cannot
  // create an immediate retry storm while a backoff window is still active.
  h.offline(false); await reporter.record(deployment, "downloaded"); await reporter.flush();
  assert.equal(h.requests.length, 3);
  h.advance(119_999); t.mock.timers.tick(119_999); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(h.requests.length, 3);
  h.advance(1); t.mock.timers.tick(1); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(h.requests.length, 5); assert.equal(JSON.parse([...h.saved.values()][0]!).events.length, 0);
  h.advance(); t.mock.timers.tick(3_600_001); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(h.requests.length, 5);
});
test("pending lifecycle wakes never bypass a failed request's backoff", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(); let release!: () => void, entered!: () => void; const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const original = h.options.fetch!; let first = true;
  h.options.fetch = async (url, init) => { if (first) { first = false; entered(); await held; h.offline(true); try { return await original(url, init); } finally { h.offline(false); } } return original(url, init); };
  const reporter = createFloraTelemetry(config, h.options); await reporter.record(deployment, "update_seen"); await started;
  await reporter.record(deployment, "downloaded"); release(); await reporter.flush();
  assert.equal(h.requests.length, 1); assert.equal(JSON.parse([...h.saved.values()][0]!).events.length, 2);
  h.advance(59_999); t.mock.timers.tick(59_999); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(h.requests.length, 1);
  h.advance(1); t.mock.timers.tick(1); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(h.requests.length, 3); assert.equal(JSON.parse([...h.saved.values()][0]!).events.length, 0);
});
test("an explicitly extended cold-storage budget retains the persisted installation identity", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(); h.offline(true); const previous = createFloraTelemetry(config, h.options); await previous.record(deployment, "downloaded"); await previous.flush();
  const before = JSON.parse([...h.saved.values()][0]!); h.offline(false);
  const storage = h.options.storage; h.options.storageTimeoutMs = 5_000;
  h.options.storage = { async getItem(key) { await new Promise(resolve => setTimeout(resolve, 1_250)); return storage.getItem(key); }, setItem: storage.setItem };
  const current = createFloraTelemetry(config, h.options), reporting = current.beginLaunch(launch);
  await new Promise<void>(resolve => setImmediate(resolve)); t.mock.timers.tick(1_250); await reporting; await current.confirmLaunch(deployment); await current.flush();
  assert.equal(h.requests.filter(request => request.url.endsWith("/session")).length, 2);
  assert.equal(h.requests.at(-2)!.body.installationId, before.installationId);
  const persisted = JSON.parse([...h.saved.values()][0]!); assert.equal(persisted.installationId, before.installationId); assert.equal(persisted.events.length, 0);
  assert.ok(h.requests.filter(request => request.url.endsWith("/telemetry")).flatMap(request => request.body.events).some((event: any) => event.type === "restart_confirmed"));
});
test("current native confirmation takes priority over a deeper persisted backlog without draining it unboundedly", async () => {
  const h = harness(); h.offline(true); const previous = createFloraTelemetry(config, h.options);
  for (let i = 2; i <= 9; i++) await previous.record(i.toString(16).padStart(8, "0") + "-1111-4111-8111-111111111111", "update_seen");
  await previous.record(deployment, "downloaded"); await previous.requestActivation(deployment); await previous.flush(); h.offline(false);
  let release!: () => void, entered!: () => void; const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const original = h.options.fetch!; let batches = 0;
  h.options.fetch = async (url, init) => { if (String(url).endsWith("/telemetry") && ++batches === 4) { entered(); await held; } return original(url, init); };
  const current = createFloraTelemetry(config, h.options); await current.beginLaunch(launch); await started;
  await current.confirmLaunch(deployment); release(); await new Promise<void>(resolve => setImmediate(resolve));
  const reports = h.requests.filter(request => request.url.endsWith("/telemetry")); assert.equal(reports.length, 8);
  assert.deepEqual(reports[4]!.body.events.map((event: any) => event.type), ["downloaded", "activation_requested", "launch_confirmed", "restart_confirmed"]);
  const pending = JSON.parse([...h.saved.values()][0]!).events; assert.equal(pending.length, 1); assert.notEqual(pending[0].deploymentId, deployment);
});
test("authentication, invalid reports, and unavailable storage never start autonomous retries", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const status of [200, 400, 401, 403]) {
    const h = harness(), original = h.options.fetch!;
    h.options.fetch = async (url, init) => { const response = await original(url, init); return String(url).endsWith("/telemetry") ? new Response("{}", { status }) : response; };
    const reporter = createFloraTelemetry(config, h.options); await reporter.record(deployment, "downloaded"); await reporter.flush(); const count = h.requests.length;
    h.advance(60_000); t.mock.timers.tick(60_000); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(h.requests.length, count);
    assert.equal(JSON.parse([...h.saved.values()][0]!).events.length, 1);
  }
  const h = harness(); h.options.storage = { async getItem() { throw new Error("STORAGE_UNAVAILABLE"); }, async setItem() { throw new Error("STORAGE_UNAVAILABLE"); } };
  const reporter = createFloraTelemetry(config, h.options); await reporter.record(deployment, "downloaded"); await reporter.flush();
  h.advance(60_000); t.mock.timers.tick(60_000); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(h.requests.length, 0);
});
test("transient HTTP responses retry once recovered and cancel all idle retry traffic", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const status of [408, 429, 503]) {
    const h = harness(), original = h.options.fetch!; let fail = true;
    h.options.fetch = async (url, init) => { const response = await original(url, init); if (String(url).endsWith("/telemetry") && fail) { fail = false; return new Response("{}", { status }); } return response; };
    const reporter = createFloraTelemetry(config, h.options); await reporter.record(deployment, "downloaded"); await reporter.flush(); assert.equal(h.requests.length, 2);
    h.advance(60_000); t.mock.timers.tick(60_000); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(h.requests.length, 3); assert.equal(JSON.parse([...h.saved.values()][0]!).events.length, 0);
    h.advance(); t.mock.timers.tick(3_600_001); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(h.requests.length, 3);
  }
});
test("a flush caller arriving during final acknowledgement handoff never loses its requested pass", async () => {
  // Exercise each microtask boundary around persistence, serial completion,
  // the four-batch exit, and single-flight finalization without wall-clock races.
  for (let turns = 0; turns <= 12; turns++) {
    const h = harness(); h.offline(true); const previous = createFloraTelemetry(config, h.options);
    for (let i = 2; i <= 9; i++) await previous.record(i.toString(16).padStart(8, "0") + "-1111-4111-8111-111111111111", "update_seen");
    await previous.flush(); h.offline(false);
    const storage = h.options.storage; let scheduled = false, requested: Promise<void> | undefined, current: ReturnType<typeof createFloraTelemetry>;
    h.options.storage = { getItem: storage.getItem, async setItem(key, value) {
      await storage.setItem(key, value);
      if (!scheduled && JSON.parse(value).events.length === 4) {
        scheduled = true;
        const enqueue = (remaining: number) => queueMicrotask(() => { if (remaining) enqueue(remaining - 1); else requested = current.flush(); }); enqueue(turns);
      }
    } };
    current = createFloraTelemetry(config, h.options); await current.beginLaunch({ ...launch, source: "embedded", updateId: null });
    await new Promise<void>(resolve => setImmediate(resolve)); await requested;
    assert.equal(h.requests.filter(request => request.url.endsWith("/telemetry")).length, 8, "microtask boundary " + turns);
    assert.equal(JSON.parse([...h.saved.values()][0]!).events.length, 0);
  }
});
test("exhausting the extended storage budget preserves durable state and never reports an ephemeral identity", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(); h.offline(true); const previous = createFloraTelemetry(config, h.options);
  await previous.record(deployment, "downloaded"); await previous.requestActivation(deployment); await previous.flush();
  const before = [...h.saved.entries()], requests = h.requests.length; h.offline(false);
  h.options.storageTimeoutMs = 5_000; h.options.storage = { getItem: () => new Promise(() => {}), async setItem() { assert.fail("unread persistent state must never be overwritten"); } };
  const current = createFloraTelemetry(config, h.options), launching = current.beginLaunch(launch);
  await new Promise<void>(resolve => setImmediate(resolve)); t.mock.timers.tick(5_000); await launching;
  await current.confirmLaunch(deployment); await current.flush();
  h.advance(); t.mock.timers.tick(3_600_001); await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual([...h.saved.entries()], before); assert.equal(h.requests.length, requests);
});
