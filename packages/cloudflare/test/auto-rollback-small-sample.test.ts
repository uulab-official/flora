import test from "node:test";
import assert from "node:assert/strict";
import { createTestRuntime } from "./runtime.ts";

const now = 1_800_000_000_000;
const source = "ba0ded11-d92f-4d64-b8e0-a98bc5693fee", target = "7e83448c-5391-4a65-87c9-05b9817e103e";
const policy = (changes: Record<string, unknown> = {}) => ({ expectedVersion: 0, enabled: true, failureRatePercent: 100, minInstallations: 1, windowMinutes: 1, channel: "verification", targets: { ios: target, android: target }, ...changes });
const event = (type: string, at: number, extra: Record<string, unknown> = {}) => ({ type, observedAt: at, ...extra });
const native = (at: number) => event("rolled_back", at, { stage: "launch", code: "UNCONFIRMED_LAUNCH" });
async function fixture(t: test.TestContext) {
  const runtime = await createTestRuntime({ entrypoint: new URL("./fixtures/auto-rollback-entry.ts", import.meta.url), durableObjects: { AUTO: "AutoRollbackFixture" } });
  t.after(() => runtime.dispose());
  const call = async (op: string, input: unknown = null, extra: Record<string, unknown> = {}) => {
    const response = await runtime.fetch("https://rollback.example.test", { method: "POST", body: JSON.stringify({ op, input, ...extra }) });
    return { status: response.status, value: await response.json() as any };
  };
  for (const hash of ["known_one", "known_two"]) await call("authorize", { hash, enabled: true });
  const report = (events: any[], receivedAt = now + 10, hash = "known_one", changes: Record<string, unknown> = {}) => call("observe", { ownerId: "owner_a", appId: "application_first", deploymentId: source, platform: "android", channel: "verification", runtimeVersion: "native-v1", publishedAt: now + 1, isRollback: false, installationHash: hash, events, ...changes }, { now: receivedAt });
  const arm = async () => {
    await call("save", policy());
    const value = (await report([event("activation_requested", now + 2), native(now + 3)])).value;
    return { id: value.decisionId, decision: (await call("get")).value.decisions[0] };
  };
  return { call, report, arm };
}

test("small samples reject thresholds below100 while retaining larger-sample configuration", async t => {
  const { call } = await fixture(t);
  for (const minInstallations of [1, 2, 3, 4]) {
    assert.equal((await call("save", policy({ minInstallations, failureRatePercent: 99 }))).status, 400);
  }
  assert.equal((await call("save", policy({ enabled: false, failureRatePercent: 50 }))).status, 200);
  assert.equal((await call("save", policy({ expectedVersion: 1, minInstallations: 5, failureRatePercent: 10 }))).status, 200);
});

test("small native-confirmed failure arms once and waits120 seconds from server receipt", async t => {
  const { call, report, arm } = await fixture(t);
  const { id, decision } = await arm();
  assert.ok(id); assert.equal(decision.nextAttemptAt, now + 120_010);
  assert.equal(decision.confirmationDelaySeconds, 120);
  assert.equal(decision.failedInstallations, 1); assert.equal(decision.attemptedInstallations, 1);
  assert.match(decision.reason, /120/); assert.match(decision.reason, /UNCONFIRMED_LAUNCH/);
  assert.equal((await call("claim", null, { id, now: now + 120_009 })).value, null);
  await report([native(now + 3), event("activation_requested", now + 2)], now + 20);
  assert.equal((await call("get")).value.decisions[0].nextAttemptAt, now + 120_010);
  const claim = (await call("claim", null, { id, now: now + 120_010 })).value;
  assert.equal(claim.status, "executing"); assert.equal(claim.policyCurrent, true);
});

test("small samples cannot arm on generic failures, downloads, networks, storage errors or native failure without activation", async t => {
  const { call, report } = await fixture(t);
  await call("save", policy());
  const ignored = [
    event("failed", now + 3, { stage: "activation", code: "ACTIVATION_FAILED" }),
    event("failed", now + 3, { stage: "launch", code: "UNCONFIRMED_LAUNCH" }),
    event("failed", now + 3, { stage: "download", code: "NETWORK_UNAVAILABLE" }),
    event("rolled_back", now + 3, { stage: "launch", code: "STORED_UPDATE_INVALID" }),
  ];
  for (const item of ignored) assert.equal((await report([event("activation_requested", now + 2), item])).value.queued, false);
  assert.equal((await report([native(now + 3)], now + 10, "known_two")).value.queued, false);
  assert.equal((await call("get")).value.decisions.length, 0);
  assert.equal((await report([native(now + 3)], now + 10)).value.queued, false);
  assert.equal((await report([event("activation_requested", now + 2)], now + 11, "known_two")).value.queued, true);
});

test("small sample evidence is causal and order-independent with success at or after failure cancelling it", async t => {
  const { call, report } = await fixture(t);
  await call("save", policy());
  await report([native(now + 3)]);
  await report([event("launch_confirmed", now + 3), event("restart_confirmed", now + 4)], now + 11);
  assert.equal((await report([event("activation_requested", now + 2)], now + 12)).value.queued, false);
  assert.equal((await call("get")).value.decisions.length, 0);
  // An activation newer than the old failure cannot establish its failed attempt.
  assert.equal((await report([event("activation_requested", now + 8), native(now + 7)], now + 13)).value.queued, false);
});

test("small sample recovery outside the observation window cancels the queued decision without rewriting its snapshot", async t => {
  const { call, report, arm } = await fixture(t);
  const { id, decision } = await arm();
  await report([event("launch_confirmed", now + 70_000), event("restart_confirmed", now + 70_001)], now + 70_010);
  assert.equal((await call("claim", null, { id, now: decision.nextAttemptAt })).value, null);
  const result = (await call("get")).value.decisions[0];
  assert.equal(result.status, "skipped"); assert.equal(result.lastErrorCode, "AUTO_ROLLBACK_RECOVERED");
  assert.equal(result.failedInstallations, 1); assert.equal(result.attemptedInstallations, 1);
  assert.equal(result.reason, decision.reason); assert.deepEqual(result.policy, decision.policy);
  assert.deepEqual(result.cancellation, { checkedAt: decision.nextAttemptAt, attemptedInstallations: 1, failedInstallations: 0, confirmedHealthyInstallations: 1, failureRatePercent: 0 });
  await call("restart");
  assert.deepEqual((await call("get")).value.decisions[0], result);
});

test("a second healthy installation breaks a small sample100percent threshold", async t => {
  const { call, report, arm } = await fixture(t);
  const { id, decision } = await arm();
  await report([event("launch_confirmed", now + 30)], now + 31, "known_two");
  assert.equal((await call("claim", null, { id, now: decision.nextAttemptAt })).value, null);
  const result = (await call("get")).value.decisions[0];
  assert.equal(result.lastErrorCode, "AUTO_ROLLBACK_RECOVERED");
  assert.deepEqual(result.cancellation, { checkedAt: decision.nextAttemptAt, attemptedInstallations: 2, failedInstallations: 1, confirmedHealthyInstallations: 1, failureRatePercent: 50 });
});

test("small sample recovery fences an in-flight execution while retaining uncertain receipt recovery", async t => {
  const { call, report, arm } = await fixture(t);
  const { id, decision } = await arm();
  const claim = (await call("claim", null, { id, now: decision.nextAttemptAt })).value;
  await report([event("launch_confirmed", now + 120_011)], now + 120_012);
  assert.equal((await call("current", null, { id, claimVersion: claim.claimVersion })).value, false);
  const reconcile = (await call("claim", null, { id, now: claim.nextAttemptAt })).value;
  assert.equal(reconcile.status, "executing"); // Receipt is checked before recovery skip.
});

test("small sample recovery followed by a new native failure restarts confirmation without extending stale reports", async t => {
  const { call, report, arm } = await fixture(t);
  const { decision } = await arm();
  await report([event("launch_confirmed", now + 20)], now + 21);
  await report([event("activation_requested", now + 30), native(now + 31)], now + 40);
  const renewed = (await call("get")).value.decisions[0];
  assert.equal(renewed.triggeredAt, decision.triggeredAt); assert.equal(renewed.reason, decision.reason);
  assert.equal(renewed.nextAttemptAt, now + 120_040);
  await report([native(now + 3)], now + 50);
  assert.equal((await call("get")).value.decisions[0].nextAttemptAt, now + 120_040);
});

test("small sample evidence stays app and platform scoped and cannot use client backdating to bypass confirmation", async t => {
  const { call, report } = await fixture(t);
  await call("save", policy({ windowMinutes: 30 }));
  const iosSource = "bb10d556-33ed-4c67-8686-9fa6135e6977";
  await report([event("activation_requested", now + 2)], now + 500_000, "known_one", { platform: "ios", deploymentId: iosSource });
  assert.equal((await report([native(now + 3)], now + 500_001)).value.queued, false);
  const armed = await report([event("activation_requested", now + 2)], now + 500_002);
  assert.equal(armed.value.queued, true);
  assert.equal((await call("get")).value.decisions[0].nextAttemptAt, now + 620_002);
});

test("a duplicate native callback after recovery cannot create a new failed attempt without a later activation", async t => {
  const { call, report, arm } = await fixture(t);
  const { id, decision } = await arm();
  await report([event("launch_confirmed", now + 20)], now + 21);
  await report([native(now + 30)], now + 31);
  assert.equal((await call("get")).value.decisions[0].nextAttemptAt, decision.nextAttemptAt);
  assert.equal((await call("claim", null, { id, now: decision.nextAttemptAt })).value, null);
  assert.equal((await call("get")).value.decisions[0].lastErrorCode, "AUTO_ROLLBACK_RECOVERED");
});

test("a recovery and renewed failure during execution must pass a new server confirmation even for an existing claim", async t => {
  const { call, report } = await fixture(t);
  await call("save", policy({ windowMinutes: 30 }));
  const id = (await report([event("activation_requested", now + 2), native(now + 3)])).value.decisionId;
  const claim = (await call("claim", null, { id, now: now + 120_010 })).value;
  await report([event("launch_confirmed", now + 120_011)], now + 120_012);
  await report([event("activation_requested", now + 120_013), native(now + 120_014)], now + 120_015);
  assert.equal((await call("invalidation", null, { id, claimVersion: claim.claimVersion, now: now + 120_016 })).value, "AUTO_ROLLBACK_CONFIRMATION_PENDING");
  assert.equal((await call("current", null, { id, claimVersion: claim.claimVersion, now: now + 240_014 })).value, false);
  assert.equal((await call("current", null, { id, claimVersion: claim.claimVersion, now: now + 240_015 })).value, true);
});

test("the confirmation grace accepts late recovery but never new failure evidence outside the publication window", async t => {
  const { call, report } = await fixture(t);
  await call("save", policy());
  const id = (await report([event("activation_requested", now + 58_000), native(now + 59_000)], now + 59_010)).value.decisionId;
  const original = (await call("get")).value.decisions[0];
  await report([event("launch_confirmed", now + 61_000)], now + 61_010);
  await report([event("activation_requested", now + 70_000), native(now + 71_000)], now + 71_010);
  assert.equal((await call("get")).value.decisions[0].nextAttemptAt, original.nextAttemptAt);
  assert.equal((await call("claim", null, { id, now: original.nextAttemptAt })).value, null);
  assert.equal((await call("get")).value.decisions[0].lastErrorCode, "AUTO_ROLLBACK_RECOVERED");
});

test("small sample accounting capacity cancels existing authority without rejecting or erasing new SDK reports", async t => {
  const { call, report, arm } = await fixture(t);
  const { id, decision } = await arm();
  const claim = (await call("claim", null, { id, now: decision.nextAttemptAt })).value;
  await call("debug", null, { sql: "UPDATE flora_auto_rollback_meta SET value=20000 WHERE key='installations'" });
  const result = await report([event("launch_confirmed", now + 120_020)], now + 120_021, "known_two");
  assert.equal(result.status, 200); assert.equal(result.value.capacityLimited, true);
  assert.equal((await call("invalidation", null, { id, claimVersion: claim.claimVersion, now: now + 120_022 })).value, "AUTO_ROLLBACK_ACCOUNTING_CAPACITY");
  assert.equal((await call("get")).value.decisions[0].failedInstallations, 1);
  // A later known installation report must not clear incomplete accounting.
  await report([event("activation_requested", now + 120_025)], now + 120_026);
  assert.equal((await call("current", null, { id, claimVersion: claim.claimVersion, now: now + 120_027 })).value, false);
});

test("legacy small-sample policy stays readable but cannot trigger and can be disabled immediately", async t => {
  const { call, report } = await fixture(t);
  await call("save", policy());
  await call("debug", null, { sql: "UPDATE flora_auto_rollback_policies SET data=json_set(data,'$.failureRatePercent',50)" });
  assert.equal((await call("get")).value.policy.failureRatePercent, 50);
  assert.equal((await report([event("activation_requested", now + 2), native(now + 3)])).value.queued, false);
  assert.equal((await call("get")).value.decisions.length, 0);
  assert.equal((await call("save", policy({ expectedVersion: 1, enabled: false, failureRatePercent: 50 }))).status, 200);
});

test("small sample activation may precede server publication by exactly120seconds without changing its raw timestamp", async t => {
  const { call, report } = await fixture(t);
  await call("save", policy());
  const activationAt = now + 1 - 120_000;
  const result = await report([event("activation_requested", activationAt), native(now + 3)]);
  assert.equal(result.value.queued, true);
  const decision = (await call("get")).value.decisions[0];
  assert.equal(decision.nextAttemptAt, now + 120_010);
  const rows = (await call("debug", null, { sql: "SELECT data FROM flora_auto_rollback_small_evidence" })).value;
  assert.equal(JSON.parse(rows[0].data).activationAt, activationAt);
});

test("small sample publication clock allowance stays bounded and never reverses native failure causality", async t => {
  for (const [activationAt, rollbackAt] of [[now + 1 - 120_001, now + 3], [now - 3_000, now - 3_001]]) {
    const { call, report } = await fixture(t);
    await call("save", policy());
    assert.equal((await report([event("activation_requested", activationAt!), native(rollbackAt!)])).value.queued, false);
    assert.equal((await call("get")).value.decisions.length, 0);
  }
});

test("small sample clock allowance never admits an old source policy or another app's activation", async t => {
  const { call, report } = await fixture(t);
  await call("save", policy());
  const events = [event("activation_requested", now - 3_000), native(now + 3)];
  assert.equal((await report(events, now + 10, "known_one", { publishedAt: now })).value.queued, false);
  assert.equal((await report(events, now + 10, "known_one", { appId: "application_other" })).value.queued, false);
  assert.equal((await report(events, now + 10, "known_one", { ownerId: "owner_other" })).value.queued, false);
  await report([event("activation_requested", now - 3_000)], now + 10, "known_one", { deploymentId: "bb10d556-33ed-4c67-8686-9fa6135e6977" });
  assert.equal((await report([native(now + 3)])).value.queued, false);
});

test("small sample clock-skewed success still cancels an earlier native failure before server publication", async t => {
  const { call, report } = await fixture(t);
  await call("save", policy());
  const result = await report([event("activation_requested", now - 30_000), native(now - 20_000), event("launch_confirmed", now - 10_000)]);
  assert.equal(result.value.queued, false); assert.equal((await call("get")).value.decisions.length, 0);
});

test("small sample threshold dilution without a successful launch never becomes confirmed recovery evidence", async t => {
  const { call, report, arm } = await fixture(t);
  const { id, decision } = await arm();
  await report([event("activation_requested", now + 30)], now + 31, "known_two");
  assert.equal((await call("claim", null, { id, now: decision.nextAttemptAt })).value, null);
  const result = (await call("get")).value.decisions[0];
  assert.deepEqual(result.cancellation, { checkedAt: decision.nextAttemptAt, attemptedInstallations: 2, failedInstallations: 1, confirmedHealthyInstallations: 0, failureRatePercent: 50 });
  assert.equal(result.failedInstallations, 1); assert.equal(result.attemptedInstallations, 1);
});

test("small sample cancellation evidence excludes stale success and other platform deployments", async t => {
  const { call, report, arm } = await fixture(t);
  const { id, decision } = await arm();
  const iosSource = "bb10d556-33ed-4c67-8686-9fa6135e6977";
  await report([event("launch_confirmed", now + 40)], now + 41, "known_two", { platform: "ios", deploymentId: iosSource });
  await report([event("launch_confirmed", now + 20), event("activation_requested", now + 30)], now + 42, "known_two");
  assert.equal((await call("claim", null, { id, now: decision.nextAttemptAt })).value, null);
  const result = (await call("get")).value.decisions[0];
  assert.equal(result.cancellation.confirmedHealthyInstallations, 0);
  assert.equal(result.cancellation.attemptedInstallations, 2);
  assert.equal(result.cancellation.failedInstallations, 1);
});

test("small sample cancellation never treats success older than the latest native rollback callback as confirmed healthy", async t => {
  const { call, report, arm } = await fixture(t);
  const { id, decision } = await arm();
  await report([event("launch_confirmed", now + 20), native(now + 30)], now + 31);
  assert.equal((await call("claim", null, { id, now: decision.nextAttemptAt })).value, null);
  const result = (await call("get")).value.decisions[0];
  assert.equal(result.cancellation.confirmedHealthyInstallations, 0);
  assert.equal(result.cancellation.failedInstallations, 0);
});

test("small sample cancellation represents missing current accounting with a null rate and no invented healthy confirmations", async t => {
  const { call, arm } = await fixture(t);
  const { id, decision } = await arm();
  await call("debug", null, { sql: "DELETE FROM flora_auto_rollback_sources" });
  assert.equal((await call("claim", null, { id, now: decision.nextAttemptAt })).value, null);
  const result = (await call("get")).value.decisions[0];
  assert.deepEqual(result.cancellation, { checkedAt: decision.nextAttemptAt, attemptedInstallations: 0, failedInstallations: 0, confirmedHealthyInstallations: 0, failureRatePercent: null });
  assert.equal(result.failedInstallations, 1); assert.equal(result.attemptedInstallations, 1);
});

test("reading an older terminal small sample cancellation never backfills a new evidence snapshot", async t => {
  const { call, report, arm } = await fixture(t);
  const { id, decision } = await arm();
  await report([event("launch_confirmed", now + 30)], now + 31);
  await call("claim", null, { id, now: decision.nextAttemptAt });
  await call("debug", null, { sql: "UPDATE flora_auto_rollback_decisions SET data=json_remove(data,'$.cancellation')" });
  const stored = JSON.parse((await call("debug", null, { sql: "SELECT data FROM flora_auto_rollback_decisions" })).value[0].data);
  await call("restart");
  const result = (await call("get")).value.decisions[0];
  assert.equal(result.cancellation, undefined); assert.deepEqual(result, stored);
});
