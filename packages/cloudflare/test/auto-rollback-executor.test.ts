import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { D1Database } from "@cloudflare/workers-types";
import type { OTADeployment } from "@app-ops/dogfood";
import { createOperationsService } from "@app-ops/dogfood";
import { createD1ImportStore } from "../dist/d1-import-store.js";
import { createTestRuntime } from "./runtime.ts";

const now = 1_800_000_000_000;
const config = { ownerId: "owner_a", ownerEmail: "owner@example.invalid", origin: "https://rollback.example.test", dbIdentity: "fixture", setup: null };
async function fixture(t: test.TestContext, options: { small?: boolean } = {}) {
  const runtime = await createTestRuntime({ entrypoint: new URL("./fixtures/auto-rollback-executor-entry.ts", import.meta.url), durableObjects: { AUTO: "AutoRollbackExecutorFixture" } });
  t.after(() => runtime.dispose());
  const db = runtime.d1 as unknown as D1Database;
  for (const name of ["0001_private_imports.sql", "0002_multi_app.sql", "0003_github_ota.sql", "0010_manual_ota_rollback.sql"]) {
    const sql = await readFile(new URL("../migrations/" + name, import.meta.url), "utf8");
    await db.exec(sql.replace(/^--.*$/gm, "").split(/;\s*(?=CREATE|INSERT|DROP|PRAGMA|$)/).filter(s => s.trim()).map(s => s.replace(/\s*\n\s*/g, " ").trim() + ";").join("\n"));
  }
  await db.prepare("INSERT INTO flora_deployment VALUES(1,?,?,?)").bind(config.ownerId, config.origin, config.dbIdentity).run();
  const store = createD1ImportStore(db, config, () => {}), operations = store.operations!;
  const app = await store.applications!.registerApplication({ name: "A", repositoryId: "a", rootDirectory: "." }, now - 1000);
  const other = await store.applications!.registerApplication({ name: "B", repositoryId: "b", rootDirectory: "." }, now - 1000);
  const connection = await operations.saveGitHubConnection(app.id, { expectedVersion: 0, installationId: 1, owner: "example", repository: "sample", ref: "main" }, now - 1000);
  const detection = await operations.saveGitHubDetection({ id: "detection_first", appId: app.id, connection, rootDirectory: ".", detectedAt: now - 1000, commitSha: "a".repeat(40), framework: "expo", expoVersion: "55.0.0", reactNativeVersion: "0.82.0", configSource: "app.json", runtimeVersion: "1", platforms: ["ios", "android"], updatesEnabled: true, updatesUrl: config.origin + "/updates/" + app.id, reasons: [] });
  const bytes = new TextEncoder().encode("globalThis.version='healthy'");
  const hash = Buffer.from(await crypto.subtle.digest("SHA-256", bytes));
  const asset = { id: "asset_" + hash.toString("hex"), appId: app.id, digest: hash.toString("hex"), hash: hash.toString("base64url"), key: "healthy", contentType: "application/javascript", fileExtension: ".js", size: bytes.length, createdAt: now - 1000 };
  await operations.saveOTAAsset(asset, bytes);
  const target = await operations.saveOTADeployment({ id: crypto.randomUUID(), appId: app.id, requestKey: "healthy", detectionId: detection.id, commitSha: detection.commitSha, channel: "verification", runtimeVersion: "1", platform: "android", launchAssetId: asset.id, assetIds: [], launchAsset: asset, assets: [], createdAt: now });
  const source = await operations.saveOTADeployment({ ...target, id: crypto.randomUUID(), requestKey: "broken", createdAt: now + 1 });
  const call = async (op: string, extra: Record<string, unknown> = {}) => {
    const response = await runtime.fetch(config.origin, { method: "POST", body: JSON.stringify({ op, appId: app.id, ...extra }) });
    return { status: response.status, value: await response.json() as any };
  };
  const queued = (await call("queue", { source, target, now: now + 2, small: options.small === true })).value;
  const report = (events: any[], receivedAt: number) => call("report", { input: { ownerId: config.ownerId, appId: app.id, deploymentId: source.id, platform: source.platform, channel: source.channel, runtimeVersion: source.runtimeVersion, publishedAt: source.createdAt, isRollback: false, installationHash: "anonymous_installation", events }, now: receivedAt });
  return { runtime, db, app, other, target, source, queued, store, operations, call, report };
}

test("automatic executor publishes the exact prior artifact once and links its durable decision", async t => {
  const { call, operations, queued, app, other, target, source, db } = await fixture(t);
  const preserved = (await db.prepare("SELECT * FROM ota_assets").all()).results;
  const result = await call("execute", { id: queued.id });
  assert.equal(result.status, 200); assert.equal(result.value.status, "succeeded");
  const receipt = await operations.getOTADeploymentForRequest(app.id, queued.requestKey);
  assert.ok(receipt); assert.deepEqual(receipt.launchAsset, target.launchAsset); assert.equal(receipt.rollback?.fromDeploymentId, source.id); assert.equal(receipt.rollback?.targetDeploymentId, target.id);
  assert.equal(result.value.rollbackDeploymentId, receipt.id);
  assert.equal((await call("execute", { id: queued.id })).value, null);
  assert.equal((await operations.listOTADeployments(app.id)).length, 3);
  assert.equal(await operations.getOTADeployment(other.id, receipt.id), null);
  assert.deepEqual((await db.prepare("SELECT * FROM ota_assets").all()).results, preserved);
});

test("automatic executor refuses a newer Runner head and leaves all prior publications intact", async t => {
  const { call, operations, queued, app, source } = await fixture(t);
  const winner = await operations.saveOTADeployment({ ...source, id: crypto.randomUUID(), requestKey: "runner_winner", createdAt: now + 3 });
  const result = (await call("execute", { id: queued.id })).value;
  assert.equal(result.status, "skipped"); assert.equal(result.lastErrorCode, "AUTO_ROLLBACK_SOURCE_STALE");
  assert.equal(await operations.getOTADeploymentForRequest(app.id, queued.requestKey), null);
  assert.equal((await operations.getLatestOTADeployment(app.id, { platform: "android", channel: "verification", runtimeVersion: "1" }))?.id, winner.id);
});

test("automatic executor rejects unhealthy targets, mismatched scope and rollback loops without publishing", async t => {
  for (const flags of [{ unhealthy: true }, { sourceScopeMismatch: true }, { sourceIsRollback: true }]) {
    const { call, operations, queued, app } = await fixture(t);
    const result = (await call("execute", { id: queued.id, ...flags })).value;
    assert.equal(result.status, "failed");
    assert.equal(await operations.getOTADeploymentForRequest(app.id, queued.requestKey), null);
    assert.equal((await operations.listOTADeployments(app.id)).length, 2);
  }
});

test("automatic executor checks a policy change across asynchronous reads before any publication", async t => {
  const { call, operations, queued, app } = await fixture(t);
  const result = (await call("execute", { id: queued.id, disableDuringRead: true })).value;
  assert.equal(result.status, "skipped"); assert.equal(result.lastErrorCode, "AUTO_ROLLBACK_POLICY_CHANGED");
  assert.equal(await operations.getOTADeploymentForRequest(app.id, queued.requestKey), null);
});

test("automatic executor reconciles a lost D1 commit response without another rollback", async t => {
  const { call, operations, queued, app } = await fixture(t);
  const result = (await call("execute", { id: queued.id, throwAfterCommit: true })).value;
  assert.equal(result.status, "succeeded"); assert.ok(result.rollbackDeploymentId);
  assert.equal((await operations.listOTADeployments(app.id)).length, 3);
  assert.equal((await call("get")).value.decisions[0].status, "succeeded");
});

test("automatic executor recovers a committed receipt after policy disable and validates its full scope", async t => {
  const { call, operations, queued, app, store, target, source } = await fixture(t);
  const first = (await call("execute", { id: queued.id, unavailableBeforeCommit: true })).value;
  assert.equal(first.status, "executing"); assert.equal(first.lastErrorCode, "AUTO_ROLLBACK_EXECUTION_UNCERTAIN");
  const service = createOperationsService({ applications: store.applications!, operations }, undefined, () => now + 12, { publicOrigin: config.origin });
  const committed: OTADeployment = await service.rollback(app.id, { requestKey: queued.requestKey, fromDeploymentId: source.id, targetDeploymentId: target.id, reason: queued.reason });
  await call("disable", { now: now + 13 });
  const result = (await call("execute", { id: queued.id, now: first.nextAttemptAt })).value;
  assert.equal(result.status, "succeeded"); assert.equal(result.rollbackDeploymentId, committed.id);
  assert.equal((await operations.listOTADeployments(app.id)).length, 3);
});

test("automatic executor persists uncertainty and caps executions while preserving receipt recovery", async t => {
  const { call, operations, queued, app } = await fixture(t);
  let clock = now + 10;
  for (let attempt = 1; attempt <= 8; attempt++) {
    const result = (await call("execute", { id: queued.id, now: clock, unavailableBeforeCommit: true })).value;
    assert.equal(result.attemptCount, attempt);
    if (attempt < 8) { assert.equal(result.status, "executing"); clock = result.nextAttemptAt; }
    else { assert.equal(result.status, "failed"); assert.equal(result.lastErrorCode, "AUTO_ROLLBACK_ATTEMPTS_EXHAUSTED"); }
  }
  assert.equal(await operations.getOTADeploymentForRequest(app.id, queued.requestKey), null);
  assert.equal((await operations.listOTADeployments(app.id)).length, 2);
});

test("automatic executor rejects an unrelated idempotency receipt without accepting or republishing it", async t => {
  const { call, operations, queued, app, store, target, source } = await fixture(t);
  const service = createOperationsService({ applications: store.applications!, operations }, undefined, () => now + 3, { publicOrigin: config.origin });
  await service.rollback(app.id, { requestKey: queued.requestKey, fromDeploymentId: source.id, targetDeploymentId: target.id, reason: queued.reason });
  const result = (await call("execute", { id: queued.id, receiptScopeMismatch: true })).value;
  assert.equal(result.status, "failed"); assert.equal(result.lastErrorCode, "AUTO_ROLLBACK_RECEIPT_CONFLICT");
  assert.equal(result.rollbackDeploymentId, null); assert.equal((await operations.listOTADeployments(app.id)).length, 3);
});

test("automatic executor does not publish while receipt lookup is unavailable and resumes only after its durable due time", async t => {
  const { call, operations, queued, app } = await fixture(t);
  const first = (await call("execute", { id: queued.id, receiptUnavailable: true })).value;
  assert.equal(first.status, "executing"); assert.equal(first.lastErrorCode, "AUTO_ROLLBACK_RECEIPT_UNAVAILABLE");
  assert.equal(await operations.getOTADeploymentForRequest(app.id, queued.requestKey), null);
  assert.equal((await call("execute", { id: queued.id, now: first.nextAttemptAt - 1 })).value, null);
  const final = (await call("execute", { id: queued.id, now: first.nextAttemptAt })).value;
  assert.equal(final.status, "succeeded"); assert.equal((await operations.listOTADeployments(app.id)).length, 3);
});

test("automatic executor retains an uncertain write across simultaneous policy disable until a later receipt reconciliation", async t => {
  const { call, operations, queued, app } = await fixture(t);
  const first = (await call("execute", { id: queued.id, disableBeforeUncertainWrite: true })).value;
  assert.equal(first.status, "executing"); assert.equal(first.lastErrorCode, "AUTO_ROLLBACK_EXECUTION_UNCERTAIN");
  assert.equal((await call("get")).value.policy.enabled, false);
  assert.equal(await operations.getOTADeploymentForRequest(app.id, queued.requestKey), null);
  const settled = (await call("execute", { id: queued.id, now: first.nextAttemptAt })).value;
  assert.equal(settled.status, "skipped"); assert.equal(settled.lastErrorCode, "AUTO_ROLLBACK_POLICY_CHANGED");
  assert.equal((await operations.listOTADeployments(app.id)).length, 2);
});

test("small sample executor cannot publish until its server confirmation deadline", async t => {
  const { call, operations, queued, app } = await fixture(t, { small: true });
  assert.equal(queued.nextAttemptAt, now + 120_002);
  assert.equal((await call("execute", { id: queued.id, now: queued.nextAttemptAt - 1 })).value, null);
  assert.equal(await operations.getOTADeploymentForRequest(app.id, queued.requestKey), null);
  const result = (await call("execute", { id: queued.id, now: queued.nextAttemptAt })).value;
  assert.equal(result.status, "succeeded"); assert.equal((await operations.listOTADeployments(app.id)).length, 3);
});

test("small sample executor fences recovery arriving during asynchronous source reads", async t => {
  const { call, operations, queued, app } = await fixture(t, { small: true });
  const result = (await call("execute", { id: queued.id, now: queued.nextAttemptAt, recoverDuringRead: true })).value;
  assert.equal(result.status, "skipped"); assert.equal(result.lastErrorCode, "AUTO_ROLLBACK_RECOVERED");
  assert.deepEqual(result.cancellation, { checkedAt: queued.nextAttemptAt, attemptedInstallations: 1, failedInstallations: 0, confirmedHealthyInstallations: 1, failureRatePercent: 0 });
  assert.equal(result.attemptedInstallations, 1); assert.equal(result.failedInstallations, 1);
  assert.equal(await operations.getOTADeploymentForRequest(app.id, queued.requestKey), null);
});

test("small sample executor defers a renewed failure during D1 reads for a fresh confirmation with the same key", async t => {
  const { call, operations, queued, app } = await fixture(t, { small: true });
  const deferred = (await call("execute", { id: queued.id, now: queued.nextAttemptAt, reenterDuringRead: true })).value;
  assert.equal(deferred.status, "executing"); assert.equal(deferred.lastErrorCode, "AUTO_ROLLBACK_CONFIRMATION_PENDING");
  assert.equal(deferred.nextAttemptAt, queued.nextAttemptAt + 120_000); assert.equal(deferred.requestKey, queued.requestKey);
  assert.equal(await operations.getOTADeploymentForRequest(app.id, queued.requestKey), null);
  assert.equal((await call("execute", { id: queued.id, now: deferred.nextAttemptAt - 1 })).value, null);
  const result = (await call("execute", { id: queued.id, now: deferred.nextAttemptAt })).value;
  assert.equal(result.status, "succeeded"); assert.equal((await operations.listOTADeployments(app.id)).length, 3);
});

test("small sample executor reconciles a committed receipt before treating later recovery as cancellation", async t => {
  const { call, operations, queued, app, store, target, source, report } = await fixture(t, { small: true });
  const uncertain = (await call("execute", { id: queued.id, now: queued.nextAttemptAt, unavailableBeforeCommit: true })).value;
  assert.equal(uncertain.status, "executing");
  const service = createOperationsService({ applications: store.applications!, operations }, undefined, () => queued.nextAttemptAt + 1, { publicOrigin: config.origin });
  const committed = await service.rollback(app.id, { requestKey: queued.requestKey, fromDeploymentId: source.id, targetDeploymentId: target.id, reason: queued.reason });
  await report([{ type: "launch_confirmed", observedAt: queued.nextAttemptAt + 2 }], queued.nextAttemptAt + 3);
  const result = (await call("execute", { id: queued.id, now: uncertain.nextAttemptAt })).value;
  assert.equal(result.status, "succeeded"); assert.equal(result.rollbackDeploymentId, committed.id);
  assert.equal(result.cancellation, undefined);
  assert.equal((await operations.listOTADeployments(app.id)).length, 3);
});

test("small sample executor cannot publish with incomplete accounting discovered during asynchronous reads", async t => {
  const { call, operations, queued, app } = await fixture(t, { small: true });
  const result = (await call("execute", { id: queued.id, now: queued.nextAttemptAt, capacityDuringRead: true })).value;
  assert.equal(result.status, "skipped"); assert.equal(result.lastErrorCode, "AUTO_ROLLBACK_ACCOUNTING_CAPACITY");
  assert.equal(await operations.getOTADeploymentForRequest(app.id, queued.requestKey), null);
  assert.equal((await operations.listOTADeployments(app.id)).length, 2);
});
