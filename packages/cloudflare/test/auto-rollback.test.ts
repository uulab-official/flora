import test from "node:test";
import assert from "node:assert/strict";
import { createTestRuntime } from "./runtime.ts";

const now = 1_800_000_000_000;
const source = "ba0ded11-d92f-4d64-b8e0-a98bc5693fee", target = "7e83448c-5391-4a65-87c9-05b9817e103e", restored = "2c72ad7f-34f8-4982-8a48-3974d0f4abb3";
const policy = (changes: Record<string, unknown> = {}) => ({ expectedVersion: 0, enabled: true, failureRatePercent: 20, minInstallations: 5, windowMinutes: 30, channel: "verification", targets: { ios: target, android: target }, ...changes });
const observation = (installationHash: string, events: any[], changes: Record<string, unknown> = {}) => ({ ownerId: "owner_a", appId: "application_first", deploymentId: source, platform: "android", channel: "verification", runtimeVersion: "native-v1", publishedAt: now + 1, isRollback: false, installationHash, events, ...changes });
const event = (type: string, extra: Record<string, unknown> = {}) => ({ type, observedAt: now + 2, ...extra });
async function fixture(t: test.TestContext) {
  const runtime = await createTestRuntime({ entrypoint: new URL("./fixtures/auto-rollback-entry.ts", import.meta.url), durableObjects: { AUTO: "AutoRollbackFixture" } });
  t.after(() => runtime.dispose());
  const call = async (op: string, input: unknown = null, extra: Record<string, unknown> = {}) => {
    const response = await runtime.fetch("https://rollback.example.test", { method: "POST", body: JSON.stringify({ op, input, ...extra }) });
    return { status: response.status, value: await response.json() as any };
  };
  const observe = async (id: string, events: any[], changes: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
    await call("authorize", { hash: id, enabled: true }, { ownerId: changes.ownerId ?? "owner_a", appId: changes.appId ?? "application_first" });
    return call("observe", observation(id, events, changes), { now: now + 3, ...extra });
  };
  const prepareLarge = async (settings: Record<string, unknown> = {}, scopes: Record<string, unknown>[] = [{}], seeds = 3) => {
    for (const hash of ["installation_one", "installation_two", "one", "ignored", "shared-installation", "second", "third", "new-installation", ...Array.from({ length: seeds }, (_, index) => "healthy_" + index)]) await call("authorize", { hash, enabled: true });
    const saved = await call("save", policy(settings));
    assert.equal(saved.status, 200);
    for (const changes of scopes) for (let index = 0; index < seeds; index++) await observe("healthy_" + index, [event("launch_confirmed")], changes);
  };
  const queued = async () => {
    await prepareLarge();
    await observe("installation_one", [event("activation_requested")]);
    return (await observe("installation_two", [event("failed", { stage: "launch", code: "UNCONFIRMED_LAUNCH" })])).value;
  };
  return { runtime, call, observe, queued, prepareLarge };
}

test("automatic rollback counts each attempted installation once and snapshots one threshold decision", async t => {
  const { call, observe, prepareLarge } = await fixture(t);
  assert.deepEqual((await call("get")).value, { appId: "application_first", policy: null, decisions: [], capacityLimited: false, eligibleInstallations: 0, installationHistory: [] });
  await prepareLarge();
  assert.equal((await observe("installation_one", [event("update_seen"), event("downloaded"), event("failed", { stage: "download", code: "NETWORK_UNAVAILABLE" })])).value.queued, false);
  await observe("installation_one", [event("activation_requested"), event("launch_confirmed"), event("restart_confirmed")]);
  const result = await observe("installation_two", [event("failed", { stage: "activation", code: "ACTIVATION_FAILED" })]);
  assert.equal(result.value.queued, true);
  const decision = (await call("get")).value.decisions[0];
  assert.equal(decision.attemptedInstallations, 5); assert.equal(decision.failedInstallations, 1); assert.equal(decision.failureRatePercent, 20);
  assert.equal(decision.sourceDeploymentId, source); assert.equal(decision.targetDeploymentId, target); assert.equal(decision.policyVersion, 1);
  assert.equal(decision.policy.failureRatePercent, 20); assert.match(decision.requestKey, /^auto_rollback_[a-f0-9-]+$/);
  await observe("installation_two", [event("failed", { stage: "launch", code: "LAUNCH_CONFIRMATION_FAILED" }), event("rolled_back", { stage: "launch", code: "UNCONFIRMED_LAUNCH" })]);
  const preserved = (await call("get")).value.decisions;
  assert.equal(preserved.length, 1); assert.equal(preserved[0].attemptedInstallations, 5); assert.equal(preserved[0].failedInstallations, 1);
  assert.doesNotMatch(JSON.stringify(preserved), /installation_one|installation_two/);
});

test("automatic rollback requires a new published scope and excludes late, network and rollback reports", async t => {
  const { call, observe, prepareLarge } = await fixture(t);
  await prepareLarge({ failureRatePercent: 1 }, [{}], 5);
  const failure = event("failed", { stage: "launch", code: "UNCONFIRMED_LAUNCH" });
  for (const changes of [{ isRollback: true }, { isRollback: null }, { isRollback: undefined }, { channel: "other" }, { publishedAt: now }, { publishedAt: now - 1 }, { platform: "ios", deploymentId: target }]) {
    assert.equal((await observe("ignored", [failure], changes)).value.queued, false);
  }
  await observe("ignored", [event("failed", { stage: "activation", code: "NETWORK_UNAVAILABLE" })]);
  await observe("ignored", [event("failed", { stage: "check", code: "UNKNOWN" })]);
  await observe("ignored", [event("failed", { stage: "download", code: "ASSET_HASH_MISMATCH" })]);
  assert.equal((await observe("ignored", [failure], {}, { now: now + 30 * 60_000 + 2 })).value.queued, false);
  assert.equal((await call("get")).value.decisions.length, 0);
  assert.equal((await observe("one", [event("rolled_back", { stage: "launch", code: "UNCONFIRMED_LAUNCH" })])).value.queued, true);
});

test("automatic rollback scopes installation counts to platform deployments and ignores out of window observations", async t => {
  const { call, observe, prepareLarge } = await fixture(t);
  const iosSource = "bb10d556-33ed-4c67-8686-9fa6135e6977";
  await prepareLarge({}, [{}, { platform: "ios", deploymentId: iosSource }]);
  const fail = event("failed", { stage: "launch", code: "UNCONFIRMED_LAUNCH" });
  assert.equal((await observe("shared-installation", [event("activation_requested")])).value.queued, false);
  assert.equal((await observe("shared-installation", [fail], { platform: "ios", deploymentId: iosSource })).value.queued, false);
  assert.equal((await observe("second", [event("failed", { observedAt: now - 120_000, stage: "launch", code: "UNCONFIRMED_LAUNCH" })])).value.queued, false);
  assert.equal((await observe("third", [event("failed", { observedAt: now + 30 * 60_000 + 2, stage: "launch", code: "UNCONFIRMED_LAUNCH" })])).value.queued, false);
  assert.equal((await observe("second", [fail])).value.queued, true);
  assert.equal((await call("get")).value.decisions[0].platform, "android");
  assert.equal((await observe("second", [event("launch_confirmed")], { platform: "ios", deploymentId: iosSource })).value.queued, true);
  const decisions = (await call("get")).value.decisions;
  assert.equal(decisions.length, 2);
  assert.deepEqual(decisions.map((decision: any) => [decision.attemptedInstallations, decision.failedInstallations]), [[5, 1], [5, 1]]);
});

test("automatic rollback policy uses version CAS, separates owners and apps, and rejects malformed inputs", async t => {
  const { call } = await fixture(t);
  assert.equal((await call("save", policy())).status, 200);
  assert.equal((await call("save", policy())).value.code, "AUTO_ROLLBACK_POLICY_CONFLICT");
  for (const change of [{ failureRatePercent: 0 }, { failureRatePercent: 101 }, { minInstallations: 0 }, { windowMinutes: 0 }, { windowMinutes: 1441 }, { expectedVersion: -1 }, { enabled: "true" }, { targets: { ios: "bad", android: null } }, { channel: "\n" }, { extra: true }]) assert.equal((await call("save", policy({ expectedVersion: 1, ...change }))).status, 400);
  assert.equal((await call("get", null, { appId: "application_other" })).value.policy, null);
  assert.equal((await call("get", null, { ownerId: "owner_b" })).value.policy, null);
  const disabled = await call("save", policy({ expectedVersion: 1, enabled: false }));
  assert.equal(disabled.value.policy.version, 2); assert.equal(disabled.value.policy.enabled, false);
  assert.equal((await call("get")).value.decisions.length, 0);
});

test("automatic rollback threshold receipt is atomic with the SDK transaction and survives reconstruction", async t => {
  const { call, observe, prepareLarge } = await fixture(t);
  await prepareLarge({}, [{}], 4);
  const failure = [event("failed", { stage: "launch", code: "UNCONFIRMED_LAUNCH" })];
  assert.equal((await observe("one", failure, {}, { abort: true })).status, 409);
  assert.equal((await call("pending", null, { now: now + 3 })).value.length, 0);
  const first = await observe("one", failure); assert.equal(first.value.queued, true);
  await call("restart");
  assert.equal((await call("pending", null, { now: now + 3 })).value[0].id, first.value.decisionId);
  assert.equal((await observe("one", failure)).value.queued, false);
});

test("automatic rollback recovers an expired execution with the same idempotency key and fences stale claim results", async t => {
  const { call, queued } = await fixture(t);
  const id = (await queued()).decisionId;
  const first = (await call("claim", null, { id, now: now + 4 })).value;
  assert.equal(first.status, "executing"); assert.equal(first.claimVersion, 1); assert.equal(first.policyCurrent, true);
  assert.equal((await call("claim", null, { id, now: now + 5 })).value, null);
  assert.equal((await call("current", null, { id, claimVersion: 1 })).value, true);
  await call("restart");
  const recovered = (await call("claim", null, { id, now: now + 60_005 })).value;
  assert.equal(recovered.claimVersion, 2); assert.equal(recovered.requestKey, first.requestKey);
  assert.equal((await call("current", null, { id, claimVersion: 1 })).value, false);
  assert.equal((await call("succeed", null, { id, deploymentId: restored, claimVersion: 1, now: now + 60_006 })).value, null);
  const success = (await call("succeed", null, { id, deploymentId: restored, claimVersion: 2, now: now + 60_006 })).value;
  assert.equal(success.status, "succeeded"); assert.equal(success.rollbackDeploymentId, restored);
  assert.deepEqual((await call("pending", null, { now: now + 60_006 })).value, []);
  assert.equal((await call("next")).value, null);
  const annotations = (await call("annotations", [source, restored])).value;
  assert.equal(annotations[source].id, id); assert.equal(annotations[restored].id, id);
  assert.deepEqual((await call("annotations", [source, restored], { appId: "application_other" })).value, {});
});

test("automatic rollback stops stale policy decisions but permits committed receipt recovery after disable", async t => {
  const { call, queued } = await fixture(t);
  const id = (await queued()).decisionId;
  await call("save", policy({ expectedVersion: 1, enabled: false }), { now: now + 4 });
  assert.equal((await call("claim", null, { id, now: now + 5 })).value, null);
  const skipped = (await call("get")).value.decisions[0]; assert.equal(skipped.status, "skipped"); assert.equal(skipped.lastErrorCode, "AUTO_ROLLBACK_POLICY_CHANGED");
  await call("save", policy({ expectedVersion: 2 }), { now: now + 10 });
  const nextSource = "bb10d556-33ed-4c67-8686-9fa6135e6977";
  await call("authorize", { hash: "one", enabled: true });
  for (const hash of ["healthy_0", "healthy_1", "healthy_2", "installation_one"]) await call("observe", observation(hash, [event("launch_confirmed", { observedAt: now + 12 })], { deploymentId: nextSource, publishedAt: now + 11 }), { now: now + 13 });
  const next = await call("observe", observation("one", [event("failed", { observedAt: now + 12, stage: "launch", code: "UNCONFIRMED_LAUNCH" })], { deploymentId: nextSource, publishedAt: now + 11 }), { now: now + 13 });
  const nextId = next.value.decisionId;
  await call("claim", null, { id: nextId, now: now + 14 });
  await call("save", policy({ expectedVersion: 3, enabled: false }), { now: now + 15 });
  assert.equal((await call("current", null, { id: nextId, claimVersion: 1 })).value, false);
  const reconcile = (await call("claim", null, { id: nextId, now: now + 60_015 })).value;
  assert.equal(reconcile.policyCurrent, false);
  const result = (await call("succeed", null, { id: nextId, deploymentId: restored, claimVersion: reconcile.claimVersion, now: now + 60_016 })).value;
  assert.equal(result.status, "succeeded"); assert.equal(result.policy.enabled, true);
});

test("automatic rollback retries only an explicit due intent and preserves its terminal audit", async t => {
  const { call, queued } = await fixture(t);
  const id = (await queued()).decisionId;
  await call("claim", null, { id, now: now + 4 });
  const retry = (await call("fail", null, { id, claimVersion: 1, code: "SERVICE_UNAVAILABLE", now: now + 5, retryAt: now + 30_005 })).value;
  assert.equal(retry.status, "retrying"); assert.equal((await call("next")).value, now + 30_005);
  assert.equal((await call("pending", null, { now: now + 30_004 })).value.length, 0);
  assert.equal((await call("pending", null, { now: now + 30_005 })).value.length, 1);
  await call("claim", null, { id, now: now + 30_005 });
  const failed = (await call("fail", null, { id, claimVersion: 2, code: "OTA_ROLLBACK_SOURCE_STALE", now: now + 30_006 })).value;
  assert.equal(failed.status, "failed"); assert.equal(failed.attemptCount, 2); assert.equal(failed.lastErrorCode, "OTA_ROLLBACK_SOURCE_STALE");
  assert.equal((await call("get")).value.decisions[0].id, id);
});

test("automatic rollback capacity stops new actions without rejecting SDK reports or erasing existing history", async t => {
  const { call, observe, queued } = await fixture(t);
  const id = (await queued()).decisionId;
  await call("debug", null, { sql: "UPDATE flora_auto_rollback_meta SET value=20000 WHERE key='installations'" });
  const input = observation("new-installation", [event("failed", { stage: "launch", code: "UNCONFIRMED_LAUNCH" })], { deploymentId: "bb10d556-33ed-4c67-8686-9fa6135e6977" });
  await call("authorize", { hash: "new-installation", enabled: true });
  const result = await call("observe", input, { now: now + 3 });
  assert.equal(result.status, 200); assert.equal(result.value.queued, false); assert.equal(result.value.capacityLimited, true);
  assert.equal((await call("get")).value.capacityLimited, true); assert.equal((await call("get")).value.decisions[0].id, id);
  assert.equal((await observe("installation_one", [event("launch_confirmed")])).status, 200);
});

test("automatic rollback excludes arbitrarily minted installations until the owner authorizes the exact app-scoped identity", async t => {
  const { call } = await fixture(t);
  await call("save", policy({ failureRatePercent: 10, minInstallations: 20 }));
  for (let index = 0; index < 20; index++) {
    const report = observation("untrusted_" + index, [event("failed", { stage: "launch", code: "UNCONFIRMED_LAUNCH" })]);
    assert.equal((await call("observe", report, { now: now + 3 })).value.queued, false);
  }
  const empty = (await call("get")).value;
  assert.equal(empty.decisions.length, 0); assert.equal(empty.eligibleInstallations, 0);
  const counted = (await call("debug", null, { sql: "SELECT count(*) AS total FROM flora_auto_rollback_installations" })).value;
  assert.equal(counted[0].total, 0);
  await call("save", policy({ expectedVersion: 1, minInstallations: 1, failureRatePercent: 100 }));
  await call("authorize", { hash: "known_installation", enabled: true }, { appId: "application_other" });
  const known = observation("known_installation", [event("activation_requested"), event("rolled_back", { stage: "launch", code: "UNCONFIRMED_LAUNCH" })]);
  assert.equal((await call("observe", known, { now: now + 3 })).value.queued, false);
  const allowed = (await call("authorize", { hash: "known_installation", enabled: true })).value;
  assert.equal(allowed.eligibleInstallations, 1); assert.equal(allowed.installationHistory.length, 1);
  assert.equal(allowed.installationHistory[0].enabled, true); assert.equal(allowed.installationHistory[0].previousEnabled, null);
  assert.doesNotMatch(JSON.stringify(allowed), /known_installation|untrusted_/);
  assert.equal((await call("observe", known, { now: now + 3 })).value.queued, true);
});

test("automatic rollback authorization revocation preserves audit history and refuses subsequent reports", async t => {
  const { call } = await fixture(t);
  await call("save", policy({ minInstallations: 1, failureRatePercent: 100 }));
  await call("authorize", { hash: "known_installation", enabled: true });
  await call("authorize", { hash: "known_installation", enabled: true });
  assert.equal((await call("get")).value.installationHistory.length, 1);
  const revoked = (await call("authorize", { hash: "known_installation", enabled: false }, { now: now + 1 })).value;
  assert.equal(revoked.eligibleInstallations, 0); assert.equal(revoked.installationHistory.length, 2);
  assert.equal(revoked.installationHistory[0].previousEnabled, true);
  assert.equal((await call("observe", observation("known_installation", [event("failed", { stage: "launch", code: "UNCONFIRMED_LAUNCH" })]), { now: now + 3 })).value.queued, false);
  const rows = (await call("debug", null, { sql: "SELECT count(*) AS total FROM flora_auto_rollback_authorized" })).value;
  assert.equal(rows[0].total, 1);
  await call("debug", null, { sql: "UPDATE flora_auto_rollback_meta SET value=2000 WHERE key='authorization-changes'" });
  assert.equal((await call("authorize", { hash: "known_installation", enabled: true })).status, 429);
  assert.equal((await call("get")).value.eligibleInstallations, 0);
});

test("automatic rollback authorization changes fence queued actions and in-flight claims while preserving their snapshots", async t => {
  for (const inFlight of [false, true]) {
    const { call, queued } = await fixture(t);
    const id = (await queued()).decisionId;
    if (inFlight) await call("claim", null, { id, now: now + 4 });
    const changed = (await call("authorize", { hash: "installation_one", enabled: false }, { now: now + 5 })).value;
    assert.equal(changed.policy.version, 2); assert.equal(changed.policy.updatedAt, now + 5);
    assert.equal(changed.decisions[0].policyVersion, 1); assert.equal(changed.decisions[0].policy.enabled, true);
    if (inFlight) {
      assert.equal((await call("current", null, { id, claimVersion: 1 })).value, false);
      const reconcile = (await call("claim", null, { id, now: now + 60_005 })).value;
      assert.equal(reconcile.policyCurrent, false);
      assert.equal((await call("succeed", null, { id, deploymentId: restored, claimVersion: reconcile.claimVersion, now: now + 60_006 })).value.status, "succeeded");
    } else {
      assert.equal((await call("claim", null, { id, now: now + 6 })).value, null);
      assert.equal((await call("get")).value.decisions[0].status, "skipped");
    }
  }
});

test("automatic rollback authorization capacity always permits revocation and cannot create a disabled unknown identity", async t => {
  const { call, queued } = await fixture(t);
  const id = (await queued()).decisionId;
  await call("claim", null, { id, now: now + 4 });
  const before = (await call("get")).value;
  const ignored = (await call("authorize", { hash: "never_enrolled", enabled: false })).value;
  assert.equal(ignored.eligibleInstallations, before.eligibleInstallations);
  assert.equal(ignored.installationHistory.length, before.installationHistory.length);
  await call("debug", null, { sql: "UPDATE flora_auto_rollback_meta SET value=2000 WHERE key='authorization-changes'" });
  const revoked = await call("authorize", { hash: "installation_one", enabled: false }, { now: now + 5 });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.value.eligibleInstallations, before.eligibleInstallations - 1);
  assert.equal(revoked.value.installationHistory.length, before.installationHistory.length + 1);
  assert.equal((await call("current", null, { id, claimVersion: 1 })).value, false);
  assert.equal((await call("authorize", { hash: "installation_one", enabled: true })).status, 429);
  assert.equal((await call("authorize", { hash: "new_installation", enabled: true })).status, 429);
});

test("large sample event clock allowance includes exactly120seconds and rejects one millisecond beyond it", async t => {
  for (const [offset, expected] of [[120_000, true], [120_001, false]] as const) {
    const { call, observe, prepareLarge } = await fixture(t);
    await prepareLarge({}, [{}], 4);
    const report = await observe("one", [event("failed", { observedAt: now + 1 - offset, stage: "launch", code: "UNCONFIRMED_LAUNCH" })]);
    assert.equal(report.value.queued, expected);
    assert.equal((await call("get")).value.decisions.length, expected ? 1 : 0);
  }
});

test("large sample clock-skewed success remains in the denominator beside a later failure", async t => {
  const { call, observe, prepareLarge } = await fixture(t);
  await prepareLarge();
  await observe("installation_one", [event("launch_confirmed", { observedAt: now - 5_000 })]);
  assert.equal((await observe("installation_two", [event("failed", { stage: "launch", code: "UNCONFIRMED_LAUNCH" })])).value.queued, true);
  const decision = (await call("get")).value.decisions[0];
  assert.equal(decision.attemptedInstallations, 5); assert.equal(decision.failedInstallations, 1); assert.equal(decision.failureRatePercent, 20);
});
