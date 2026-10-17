import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { createAutomationService, automationArtifactPayload, automationDigest, prepareOTAAsset } from "@app-ops/dogfood";
import { createD1ImportStore } from "../dist/d1-import-store.js";
import { createTestRuntime } from "./runtime.ts";
const now = 1770000000000;
const config = { ownerId: "owner", ownerEmail: "owner@example.invalid", origin: "https://flora.example.com", dbIdentity: "fixture", setup: null };
async function migration(db: D1Database, name: string) {
  const sql = await readFile(new URL("../migrations/" + name, import.meta.url), "utf8");
  await db.exec(sql.replace(/^--.*$/gm, "").split(/;\s*(?=CREATE|INSERT|DROP|PRAGMA|$)/).filter(s => s.trim()).map(s => s.replace(/\s*\n\s*/g, " ").trim() + ";").join("\n"));
}
async function setup(t: test.TestContext) {
  const runtime = await createTestRuntime({ entrypoint: new URL("./fixtures/runtime-entry.ts", import.meta.url) }); t.after(() => runtime.dispose());
  const db = runtime.d1 as unknown as D1Database;
  for (const name of ["0001_private_imports.sql", "0002_multi_app.sql", "0003_github_ota.sql"]) await migration(db, name);
  await db.prepare("INSERT INTO flora_deployment VALUES(1,?,?,?)").bind(config.ownerId, config.origin, config.dbIdentity).run();
  const store = createD1ImportStore(db, config, () => {});
  const a = await store.applications!.registerApplication({ name: "A", repositoryId: "a", rootDirectory: "." }, now);
  return { db, store, a };
}
async function rows(db: D1Database, table: string) { return (await db.prepare(`SELECT * FROM ${table}`).all()).results; }
test("automation_migration_preserves_all_existing_rows_and_capacity", async t => {
  const { db, store, a } = await setup(t);
  const ops = store.operations!;
  const connection = await ops.saveGitHubConnection(a.id, { expectedVersion: 0, installationId: 1, owner: "fixture", repository: "sample", ref: "main" }, now);
  const detection = await ops.saveGitHubDetection({ id: "github_fixture", appId: a.id, connection, rootDirectory: ".", detectedAt: now,
    commitSha: "a".repeat(40), framework: "expo", expoVersion: "55.0.0", reactNativeVersion: "0.82.0", configSource: "app.json", runtimeVersion: "1",
    platforms: ["ios"], updatesEnabled: true, updatesUrl: config.origin + "/updates/" + a.id, reasons: [] });
  const bytes = new Uint8Array([1, 2, 3]); const asset = await prepareOTAAsset(a.id, { key: "launch", contentType: "application/javascript", fileExtension: ".js" }, bytes, now);
  await ops.saveOTAAsset(asset, bytes);
  const receipt = await ops.saveOTADeployment({ id: crypto.randomUUID(), appId: a.id, requestKey: "old-receipt", detectionId: detection.id,
    commitSha: detection.commitSha, channel: "production", runtimeVersion: "1", platform: "ios", launchAssetId: asset.id, assetIds: [], launchAsset: asset, assets: [], createdAt: now });
  const tables = ["flora_deployment", "flora_capacity", "applications", "application_settings", "inventory_snapshots", "baseline_imports", "source_head_observations", "github_connections", "github_detections", "ota_assets", "ota_asset_chunks", "ota_deployments", "ota_deployment_assets"];
  const before = await Promise.all(tables.map(table => rows(db, table)));
  await migration(db, "0004_automation.sql");
  for (let index = 0; index < tables.length; index++) assert.deepEqual(await rows(db, tables[index]!), before[index]);
  assert.deepEqual(await ops.getOTADeploymentForRequest(a.id, receipt.requestKey), receipt);
  assert.deepEqual((await ops.getPublishedOTAAsset(a.id, asset.id))!.bytes, bytes);
});

async function automationFixture(t: test.TestContext, fence = () => {}) {
  const { db, a } = await setup(t); await migration(db, "0004_automation.sql"); const store = createD1ImportStore(db, config, fence), ops = store.operations!, auto = store.automation!;
  const b = await store.applications!.registerApplication({ name: "B", repositoryId: "b", rootDirectory: "." }, now);
  const connection = await ops.saveGitHubConnection(a.id, { expectedVersion: 0, installationId: 1, owner: "fixture", repository: "sample", ref: "main" }, now);
  const recipe = { schemaVersion: 1 as const, bundler: "expo" as const, entryFile: "index.js", toolchain: { nodeVersion: "24.19.0", packageManager: { name: "pnpm" as const, version: "11.19.0" } }, runtimeVersion: "1", platforms: ["ios" as const, "android" as const], updatesUrl: config.origin + "/updates/" + a.id };
  const detection = await ops.saveGitHubDetection({ id: "github_fixture", appId: a.id, connection, rootDirectory: ".", detectedAt: now, commitSha: "a".repeat(40), framework: "expo", expoVersion: "55.0.0", reactNativeVersion: "0.82.0", configSource: "app.json", runtimeVersion: "1", platforms: ["ios", "android"], updatesEnabled: true, updatesUrl: config.origin + "/updates/" + a.id, reasons: [], automationConfig: recipe });
  const runner = { id: "runner_fixture", name: "Fixture", appIds: [a.id], createdAt: now, credentialEpoch: 1, revokedAt: null, tokenHash: "a".repeat(64) };
  await auto.registerRunner(runner); const authority = { runnerId: runner.id, credentialEpoch: runner.credentialEpoch, tokenHash: runner.tokenHash };
  async function enqueue(requestKey = "queue-one", overrides: Partial<import("@app-ops/dogfood").AutomationJob> = {}) {
    const job: import("@app-ops/dogfood").AutomationJob = { id: "job_" + crypto.randomUUID(), appId: a.id, requestKey, detectionId: detection.id, channel: "production", runtimeVersion: "1", platform: "ios", config: recipe, detection, commitSha: detection.commitSha, rootDirectory: ".", connection,
      configDigest: await automationDigest(recipe), toolchainDigest: await automationDigest(recipe.toolchain), createdAt: now, updatedAt: now, state: "queued", attemptCount: 0, lease: null, code: null, deploymentId: null, receipt: null, ...overrides };
    return auto.enqueueAutomationJob(job);
  }
  async function publication(job: import("@app-ops/dogfood").AutomationJob, lease: import("@app-ops/dogfood").AutomationLease, at: number) {
    const bytes = new Uint8Array([1, 2, 3]), asset = await prepareOTAAsset(a.id, { key: "launch", contentType: "application/javascript", fileExtension: ".js" }, bytes, at);
    const saved = await auto.saveAutomationAsset(authority, lease, asset, bytes, at);
    const receiptFields = { jobId: job.id, attemptId: lease.attemptId, commitSha: job.commitSha, configDigest: job.configDigest, toolchainDigest: job.toolchainDigest, sourceArchiveDigest: "b".repeat(64), launchAssetId: saved.id, assetIds: [] as string[] };
    const { id, digest, hash, key, contentType, fileExtension, size } = saved;
    const receipt = { ...receiptFields, artifactDigest: await automationDigest({ receipt: receiptFields, assets: [{ id, digest, hash, key, contentType, fileExtension, size }] }) };
    return { receipt, deployment: { id: crypto.randomUUID(), appId: a.id, requestKey: job.id, detectionId: job.detectionId, commitSha: job.commitSha, channel: job.channel, runtimeVersion: job.runtimeVersion, platform: job.platform, launchAssetId: saved.id, assetIds: [], launchAsset: saved, assets: [], createdAt: at } };
  }
  return { db, store, auto, ops, a, b, authority, enqueue, publication };
}
const code = (expected: string) => (error: unknown) => error instanceof Error && error.message === expected;

test("idle app-scoped claim uses the owner/app index without reading or leasing unrelated app history", async t => {
  const { db, store, auto, ops, a, b, authority, enqueue } = await automationFixture(t);
  const own = await enqueue("own-history"); await auto.cancelAutomationJob(a.id, own.id, now + 1);
  const connection = await ops.saveGitHubConnection(b.id, { expectedVersion: 0, installationId: 2, owner: "fixture", repository: "other", ref: "main" }, now);
  const recipe = { ...own.config, updatesUrl: config.origin + "/updates/" + b.id };
  const detection = await ops.saveGitHubDetection({ ...own.detection, id: "github_other", appId: b.id, connection, updatesUrl: recipe.updatesUrl, automationConfig: recipe });
  for (let index = 0; index < 64; index++) {
    const job = await auto.enqueueAutomationJob({ ...own, id: "job_other_" + String(index).padStart(3, "0"), appId: b.id, requestKey: "other-" + index,
      detectionId: detection.id, detection, connection, config: recipe, configDigest: await automationDigest(recipe), toolchainDigest: await automationDigest(recipe.toolchain) });
    if (index > 0) await auto.cancelAutomationJob(b.id, job.id, now + 1);
  }
  const before = await rows(db, "automation_transitions"), beforeJobs = await rows(db, "automation_jobs");
  const measurements: { rowsRead: number; plan: string[] }[] = [];
  const observed = new Proxy(db, { get(target, key) {
    if (key === "prepare") return (query: string) => {
      if (!query.startsWith("SELECT t.data,t.version FROM automation_jobs j JOIN automation_transitions t") || !query.includes("ORDER BY json_extract(t.data,'$.job.createdAt'),t.job_id LIMIT 1")) return target.prepare(query);
      const wrap = (statement: D1PreparedStatement, bindings: unknown[] = []): D1PreparedStatement => new Proxy(statement, { get(st, member) {
        if (member === "bind") return (...values: unknown[]) => wrap(st.bind(...values), values);
        if (member === "first") return async () => {
          // Execute the real SELECT with the same LIMIT and retain real D1 row
          // counters; the adapter otherwise discards metadata through first().
          const result = await st.all<Record<string, string | number | null>>();
          const explained = await target.prepare("EXPLAIN QUERY PLAN " + query).bind(...bindings).all<{ detail: string }>();
          measurements.push({ rowsRead: result.meta.rows_read, plan: explained.results.map(row => row.detail) });
          return result.results[0] ?? null;
        };
        const value = Reflect.get(st, member); return typeof value === "function" ? value.bind(st) : value;
      } });
      return wrap(target.prepare(query));
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const measured = createD1ImportStore(observed, config, () => {}).automation!;
  assert.equal(await measured.claimAutomationJob(authority, now + 2, 1000), null);
  assert.equal(measurements.length, 1); const result = measurements[0]!;
  t.diagnostic("Idle claim against 64 unrelated app jobs: " + result.rowsRead + " real D1 rows read; " + result.plan.join(" | "));
  assert.ok(result.rowsRead <= 16, "idle claim must read only the own job's latest fact and bounded lookup overhead, got " + result.rowsRead);
  assert.ok(result.plan.some(detail => /SEARCH j USING .*\(owner_id=\? AND app_id=\?\)/.test(detail)), "owner and registered app must both restrict the existing job index");
  assert.ok(result.plan.some(detail => /SEARCH t USING INTEGER PRIMARY KEY/.test(detail)), "only each job's latest transition is read");
  assert.deepEqual(await rows(db, "automation_transitions"), before); assert.deepEqual(await rows(db, "automation_jobs"), beforeJobs);
  // An explicit foreign scope cannot expand this Runner's registered apps.
  assert.equal(await auto.claimAutomationJob(authority, now + 2, 1000, { appId: b.id, commitSha: own.commitSha, platform: "ios" }), null);
  const multi = { id: "runner_multi", name: "Both", appIds: [a.id, b.id], createdAt: now, credentialEpoch: 1, revokedAt: null, tokenHash: "c".repeat(64) };
  await auto.registerRunner(multi); const multiAuthority = { runnerId: multi.id, credentialEpoch: 1, tokenHash: multi.tokenHash };
  const claimed = (await auto.claimAutomationJob(multiAuthority, now + 3, 1000))!; assert.equal(claimed.job.appId, b.id); assert.equal(claimed.job.id, "job_other_000");
  await assert.rejects(auto.requireAutomationLease(authority, claimed.lease, now + 4), code("PERMISSION_DENIED"));
  await assert.rejects(auto.claimAutomationJob({ ...multiAuthority, credentialEpoch: 99 }, now + 4, 1000), code("PERMISSION_DENIED"));
  assert.equal((await store.applications!.getApplication(a.id))!.id, a.id);
});

test("dual_policy_keeps_legacy_rows_and_sql_membership_fences_removed_platform", async t => {
  const { db, auto, a, b, enqueue } = await automationFixture(t);
  const legacy = await auto.updateAutomationPolicy(a.id, { expectedVersion: 0, enabled: true, channel: "production", platform: "ios" }, now);
  const oldRows = await rows(db, "automation_policies");
  const schema = (await db.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()).results;
  const dual = await auto.updateAutomationPolicy(a.id, { expectedVersion: 1, enabled: true, channel: "production", platforms: ["ios", "android"] }, now + 1);
  assert.deepEqual(dual, { appId: a.id, version: 2, enabled: true, channel: "production", platforms: ["ios", "android"], updatedAt: now + 1 });
  assert.deepEqual((await rows(db, "automation_policies")).filter(row => row.version === 1), oldRows);
  assert.deepEqual(JSON.parse(String(oldRows[0]!.data)), legacy);
  assert.deepEqual((await db.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()).results, schema);
  assert.equal((await auto.getAutomationPolicy(b.id)).version, 0);
  const seed = await enqueue("manual-template");
  for (const platform of ["ios", "android"] as const) {
    const candidate = { ...seed, id: "job_" + platform, requestKey: "dual_" + platform, platform, createdAt: now + 1, updatedAt: now + 1 };
    assert.equal((await auto.enqueueAutomationJob(candidate, 2)).platform, platform);
  }
  const candidate = { ...seed, id: "job_removed_android", requestKey: "removed_android", platform: "android" as const, createdAt: now + 2, updatedAt: now + 2 };
  const beforeJobs = await rows(db, "automation_jobs"), beforeTransitions = await rows(db, "automation_transitions");
  let pending = true;
  const racing = new Proxy(db, { get(target, key) {
    if (key === "batch") return async (statements: Parameters<D1Database["batch"]>[0]) => {
      if (pending) { pending = false; await auto.updateAutomationPolicy(a.id, { expectedVersion: 2, enabled: true, channel: "production", platforms: ["ios"] }, now + 2); }
      return target.batch(statements);
    };
    const member = Reflect.get(target, key); return typeof member === "function" ? member.bind(target) : member;
  } });
  await assert.rejects(createD1ImportStore(racing, config, () => {}).automation!.enqueueAutomationJob(candidate, 2), code("CONFIG_CONFLICT"));
  await assert.rejects(auto.enqueueAutomationJob(candidate, 3), code("CONFIG_CONFLICT"));
  assert.deepEqual(await rows(db, "automation_jobs"), beforeJobs); assert.deepEqual(await rows(db, "automation_transitions"), beforeTransitions);
});

test("platform_claim_and_failure_do_not_mutate_the_sibling_or_other_app", async t => {
  const { auto, ops, a, b, authority, enqueue, publication } = await automationFixture(t);
  const ios = await enqueue("dual_ios"), android = await enqueue("dual_android", { platform: "android" });
  const claimed = (await auto.claimAutomationJob(authority, now, 5000, { appId: a.id, commitSha: android.commitSha, platform: "android" }))!;
  assert.equal(claimed.job.id, android.id);
  assert.equal((await auto.getAutomationJob(a.id, ios.id))!.state, "queued");
  assert.equal(await auto.claimAutomationJob(authority, now, 5000, { appId: b.id, commitSha: android.commitSha, platform: "ios" }), null);
  assert.equal(await auto.claimAutomationJob(authority, now, 5000, { appId: a.id, commitSha: "b".repeat(40), platform: "ios" }), null);
  const payload = await publication(android, claimed.lease, now);
  const completed = await auto.finalizeAutomationJob(authority, claimed.lease, payload, now);
  const sibling = (await auto.claimAutomationJob(authority, now, 5000, { appId: a.id, commitSha: ios.commitSha, platform: "ios" }))!;
  await auto.failAutomationJob(authority, sibling.lease, "EXPORT_FAILED", now);
  assert.deepEqual(await auto.getAutomationJob(a.id, android.id), completed.job);
  assert.equal((await ops.listOTADeployments(a.id))[0]!.platform, "android");
  assert.deepEqual(await auto.listAutomationJobs(b.id), []); assert.deepEqual(await ops.listOTADeployments(b.id), []);
});

test("runner_scopes_leases_and_atomic_publication_bind_immutable_receipt", async t => {
  const { db, auto, ops, a, b, authority, enqueue, publication } = await automationFixture(t);
  const job = await enqueue(); const claimed = await auto.claimAutomationJob(authority, now, 1000); assert.ok(claimed); assert.equal(claimed.job.id, job.id);
  assert.equal(await auto.getAutomationJob(b.id, job.id), null);
  assert.equal((await auto.listRunners(a.id))[0]!.id, authority.runnerId); assert.deepEqual(await auto.listRunners(b.id), []);
  assert.ok(!("tokenHash" in (await auto.listRunners(a.id))[0]!));
  await assert.rejects(auto.requireAutomationLease({ ...authority, tokenHash: "b".repeat(64) }, claimed.lease, now), code("PERMISSION_DENIED"));
  await assert.rejects(auto.requireAutomationLease(authority, { ...claimed.lease, fence: 99 }, now), code("LEASE_STALE"));
  const renewed = await auto.heartbeatAutomationJob(authority, claimed.lease, now + 100, 1000); assert.equal(renewed.expiresAt, now + 1100);
  assert.equal((await auto.requireAutomationLease(authority, { ...claimed.lease, expiresAt: 1 }, now + 500)).lease!.expiresAt, renewed.expiresAt);
  const payload = await publication(claimed.job, renewed, now + 500);
  assert.equal(await ops.getPublishedOTAAsset(a.id, payload.receipt.launchAssetId), null);
  const done = await auto.finalizeAutomationJob(authority, renewed, payload, now + 500);
  assert.equal(done.job.state, "succeeded"); assert.equal(done.job.deploymentId, done.deployment.id); assert.deepEqual(done.job.receipt, payload.receipt);
  assert.ok(await ops.getPublishedOTAAsset(a.id, payload.receipt.launchAssetId));
  assert.deepEqual(await auto.finalizeAutomationJob(authority, renewed, payload, now + 2000), done);
  assert.equal((await auto.listAutomationAttempts(a.id, job.id))[0]!.outcome, "succeeded");
  assert.deepEqual((await auto.listAutomationEvents(a.id, job.id)).map(event => event.kind), ["queued", "claimed", "heartbeat", "succeeded"]);
  const chargedTables = ["inventory_snapshots", "baseline_imports", "source_head_observations", "applications", "application_settings", "github_connections", "github_detections", "ota_assets", "ota_asset_chunks", "ota_deployments", "ota_deployment_assets", "automation_runners", "automation_jobs", "automation_transitions", "automation_guards", "automation_asset_refs", "automation_policies", "automation_publications"];
  const accounted = await db.prepare("SELECT " + chargedTables.map(table => `(SELECT coalesce(sum(stored_bytes),0) FROM ${table})`).join("+") + " AS total").first<{ total: number }>();
  assert.equal((await rows(db, "flora_capacity"))[0]!.payload_bytes, accounted!.total);
});

test("cancel_revoke_expiry_and_stale_attempt_cannot_publish", async t => {
  const { auto, authority, a, enqueue, publication } = await automationFixture(t);
  const job = await enqueue(); const one = (await auto.claimAutomationJob(authority, now, 100))!;
  await auto.expireAutomationJob(a.id, job.id, now + 100);
  const two = (await auto.claimAutomationJob(authority, now + 100, 100))!; assert.equal(two.lease.fence, 2);
  await assert.rejects(auto.requireAutomationLease(authority, { ...one.lease, expiresAt: now + 10000 }, now + 101), code("LEASE_STALE"));
  const payload = await publication(two.job, two.lease, now + 101);
  await auto.cancelAutomationJob(a.id, job.id, now + 102);
  await assert.rejects(auto.finalizeAutomationJob(authority, two.lease, payload, now + 103), code("LEASE_STALE"));
  assert.equal((await auto.failAutomationJob(authority, two.lease, "CANCELLED", now + 103)).state, "cancelled");
  const another = await enqueue("second"); const claimed = (await auto.claimAutomationJob(authority, now + 200, 1000))!;
  assert.equal(claimed.job.id, another.id); await auto.revokeRunner(authority.runnerId, now + 201);
  assert.equal((await auto.getAutomationJob(a.id, another.id))!.code, "RUNNER_REVOKED");
  await assert.rejects(auto.requireAutomationLease(authority, claimed.lease, now + 202), code("PERMISSION_DENIED"));
});

test("latest_same_clock_intent_blocks_old_commit_even_when_new_intent_cancelled", async t => {
  const { db, auto, ops, a, authority, enqueue, publication } = await automationFixture(t);
  const old = await enqueue("old"); const first = (await auto.claimAutomationJob(authority, now, 10000))!;
  const oldPayload = await publication(first.job, first.lease, now + 1);
  const newerDetection = await ops.saveGitHubDetection({ ...old.detection, id: "github_newer", commitSha: "b".repeat(40) });
  const newer = await enqueue("new", { detectionId: newerDetection.id, detection: newerDetection, commitSha: newerDetection.commitSha });
  const second = (await auto.claimAutomationJob(authority, now + 2, 10000))!; assert.equal(second.job.id, newer.id);
  const newPayload = await publication(second.job, second.lease, now + 3);
  const completed = await auto.finalizeAutomationJob(authority, second.lease, newPayload, now + 4); assert.equal(completed.deployment.commitSha, newer.commitSha);
  const before = await rows(db, "flora_capacity");
  await assert.rejects(auto.finalizeAutomationJob(authority, first.lease, oldPayload, now + 5), code("CONFLICT"));
  assert.equal(await ops.getOTADeploymentForRequest(a.id, old.id), null); assert.equal((await rows(db, "ota_deployments")).length, 1);
  assert.deepEqual(await rows(db, "flora_capacity"), before); assert.equal((await auto.getAutomationJob(a.id, old.id))!.state, "leased");
  await auto.failAutomationJob(authority, first.lease, "CONFIG_CHANGED", now + 6);
  const third = await enqueue("third"); const thirdLease = (await auto.claimAutomationJob(authority, now + 7, 10000))!;
  const thirdPayload = await publication(thirdLease.job, thirdLease.lease, now + 8);
  const fourth = await enqueue("fourth"); await auto.cancelAutomationJob(a.id, fourth.id, now + 8);
  await assert.rejects(auto.finalizeAutomationJob(authority, thirdLease.lease, thirdPayload, now + 9), code("CONFLICT"));
  assert.equal(await ops.getOTADeploymentForRequest(a.id, third.id), null);
});

test("publication_failure_and_auth_revocation_roll_back_terminal_guard_and_ota", async t => {
  let allowed = true;
  const { db, auto, ops, a, authority, enqueue, publication } = await automationFixture(t, () => { if (!allowed) throw new Error("revoked"); });
  const job = await enqueue(); const claimed = (await auto.claimAutomationJob(authority, now, 10000))!;
  const payload = await publication(claimed.job, claimed.lease, now + 1); const before = await rows(db, "flora_capacity");
  await db.exec("CREATE TRIGGER synthetic_publication_quota BEFORE INSERT ON automation_publications BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;");
  await assert.rejects(auto.finalizeAutomationJob(authority, claimed.lease, payload, now + 2), code("CONFLICT"));
  assert.equal((await auto.getAutomationJob(a.id, job.id))!.state, "leased");
  for (const table of ["ota_deployments", "ota_deployment_assets", "automation_publications"]) assert.deepEqual(await rows(db, table), []);
  assert.equal(await ops.getPublishedOTAAsset(a.id, payload.receipt.launchAssetId), null); assert.deepEqual(await rows(db, "flora_capacity"), before);
  allowed = false;
  await assert.rejects(auto.heartbeatAutomationJob(authority, claimed.lease, now + 3, 10000), /revoked/);
  await assert.rejects(auto.finalizeAutomationJob(authority, claimed.lease, payload, now + 3), /revoked/);
  await assert.rejects(auto.updateAutomationPolicy(a.id, { expectedVersion: 0, enabled: true, channel: "production", platform: "ios" }, now + 3), /revoked/);
  assert.deepEqual(await rows(db, "flora_capacity"), before);
});

test("policy_cas_targets_scope_and_pinned_job_duplicate_races", async t => {
  const { db, auto, a, b, enqueue } = await automationFixture(t);
  assert.equal((await auto.getAutomationPolicy(a.id)).enabled, false);
  const race = await Promise.allSettled([0, 1].map(() => auto.updateAutomationPolicy(a.id, { expectedVersion: 0, enabled: true, channel: "production", platform: "ios" }, now)));
  assert.equal(race.filter(value => value.status === "fulfilled").length, 1);
  assert.deepEqual((await auto.findAutomationTargets({ installationId: 1, owner: "FIXTURE", repository: "sample", ref: "main" })).map(value => value.appId), [a.id]);
  assert.deepEqual(await auto.findAutomationTargets({ installationId: 2, owner: "fixture", repository: "sample", ref: "main" }), []);
  assert.equal((await auto.getAutomationPolicy(b.id)).version, 0);
  const jobs = await Promise.all([enqueue(), enqueue()]); assert.equal(jobs[0]!.id, jobs[1]!.id);
  assert.equal((await rows(db, "automation_jobs")).length, 1);
  await assert.rejects(enqueue("queue-one", { channel: "different" }), code("IDEMPOTENCY_CONFLICT"));
  for (const table of ["automation_jobs", "automation_transitions", "automation_runners", "automation_policies"]) {
    await assert.rejects(db.prepare(`DELETE FROM ${table}`).run(), /immutable/);
    await assert.rejects(db.prepare(`UPDATE ${table} SET owner_id='other'`).run(), /immutable/);
    await assert.rejects(db.prepare(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`).run());
  }
});

test("machine_upper_bounds_include_prebody_authorization_and_deadline_reads", async t => {
  const { db, a, enqueue } = await automationFixture(t); await enqueue(); let queries = 0;
  const observed = new Proxy(db, { get(target, key) {
    if (key === "prepare") return (sql: string) => { queries++; return target.prepare(sql); };
    const member = Reflect.get(target, key); return typeof member === "function" ? member.bind(target) : member;
  } });
  const store = createD1ImportStore(observed, config, () => {});
  const service = createAutomationService({ applications: store.applications!, operations: store.operations!, automation: store.automation! }, { now: () => now + 1, publicOrigin: config.origin, leaseMs: 120000 });
  const enrolled = await service.enrollRunner({ name: "Machine", appIds: [a.id] }); const claim = (await service.claim(enrolled.token))!;
  queries = 0; await service.authorizeRunner(enrolled.token, claim.lease);
  assert.ok((await store.automation!.getAutomationJob(a.id, claim.job.id))!.lease!.expiresAt > now + 1);
  const uploaded = await service.uploadAsset(enrolled.token, claim.lease, { key: "large-launch", contentType: "application/javascript", fileExtension: ".js" }, new Uint8Array(16 * 1024 * 1024).fill(97));
  t.diagnostic("16MiB Runner upload with prebody authorization: " + queries + " D1 statements"); assert.ok(queries <= 45, String(queries));
  const ancillary: import("@app-ops/dogfood").OTAAsset[] = [];
  for (let index = 0; index < 64; index++) ancillary.push(await service.uploadAsset(enrolled.token, claim.lease, { key: "asset" + index, contentType: "image/png", fileExtension: ".png" }, new Uint8Array([index])));
  const receiptFields = { jobId: claim.job.id, attemptId: claim.lease.attemptId, commitSha: claim.job.commitSha, configDigest: claim.job.configDigest, toolchainDigest: claim.job.toolchainDigest, sourceArchiveDigest: "a".repeat(64), launchAssetId: uploaded.id, assetIds: ancillary.map(asset => asset.id) };
  const receipt = { ...receiptFields, artifactDigest: await automationDigest(automationArtifactPayload(receiptFields, [uploaded, ...ancillary])) };
  queries = 0; await service.authorizeRunner(enrolled.token, claim.lease); await store.automation!.getAutomationJob(a.id, claim.job.id);
  const finished = await service.finalize(enrolled.token, claim.lease, receipt); assert.equal(finished.job.state, "succeeded");
  t.diagnostic("65-file Runner finalize with prebody authorization: " + queries + " D1 statements"); assert.ok(queries <= 45, String(queries));
});

// Includes the same storage reads/writes as main's pinned provider callback;
// external GitHub fetches do not consume D1 statements.
test("webhook_fanout_query_measurement", async t => {
  const { db, store: original, a, b } = await automationFixture(t); const apps = [a, b];
  for (let index = 2; index < 4; index++) apps.push(await original.applications!.registerApplication({ name: "Hook" + index, repositoryId: "hook" + index, rootDirectory: "." }, now));
  for (const app of apps) {
    if (app.id !== a.id) await original.operations!.saveGitHubConnection(app.id, { expectedVersion: 0, installationId: 1, owner: "fixture", repository: "sample", ref: "main" }, now);
    await original.automation!.updateAutomationPolicy(app.id, { expectedVersion: 0, enabled: true, channel: "production", platform: "ios" }, now);
  }
  let queries = 0;
  const observed = new Proxy(db, { get(target, key) {
    if (key === "prepare") return (sql: string) => { queries++; return target.prepare(sql); };
    const member = Reflect.get(target, key); return typeof member === "function" ? member.bind(target) : member;
  } });
  const store = createD1ImportStore(observed, config, () => {});
  const options: import("@app-ops/dogfood").AutomationServiceOptions = {
    now: () => now, publicOrigin: config.origin,
    async detectPushCommit(appId, commitSha) {
      const app = (await store.applications!.getApplication(appId))!, connection = (await store.operations!.getGitHubConnection(appId))!;
      const recipe = { schemaVersion: 1 as const, bundler: "expo" as const, entryFile: "index.js", toolchain: { nodeVersion: "24.19.0", packageManager: { name: "pnpm" as const, version: "11.19.0" } }, runtimeVersion: "1", platforms: ["ios" as const, "android" as const], updatesUrl: config.origin + "/updates/" + appId };
      return store.operations!.saveGitHubDetection({ id: "github_" + crypto.randomUUID(), appId, connection, rootDirectory: app.rootDirectory, detectedAt: now, commitSha, framework: "expo", expoVersion: "55.0.0", reactNativeVersion: "0.82.0", configSource: "app.json", runtimeVersion: "1", platforms: ["ios", "android"], updatesEnabled: true, updatesUrl: recipe.updatesUrl, reasons: [], automationConfig: recipe });
    },
  };
  const context = { applications: store.applications!, operations: store.operations!, automation: store.automation! };
  const hosted = createAutomationService(context, { ...options, maxWebhookTargets: 1 });
  const event = { deliveryId: "delivery-fixture", installationId: 1, owner: "fixture", repository: "sample", ref: "refs/heads/main", commitSha: "b".repeat(40) };
  await assert.rejects(hosted.handleGitHubPush(event), code("INPUT_TOO_LARGE"));
  assert.deepEqual(await rows(db, "automation_jobs"), []);
  t.diagnostic("Hosted fanout admission rejected before writes: " + queries + " D1 statements"); assert.ok(queries <= 45);
  queries = 0; const service = createAutomationService(context, options);
  const result = await service.handleGitHubPush({ deliveryId: "delivery-fixture", installationId: 1, owner: "fixture", repository: "sample", ref: "refs/heads/main", commitSha: "b".repeat(40) });
  assert.equal(result.jobs.length, 4); t.diagnostic("Local-profile 4-target GitHub push: " + queries + " D1 statements"); assert.ok(queries > 50);
});

test("hosted_dual_platform_push_leaves_room_for_github_within_the_existing_fifty_query_budget", async t => {
  const { db, store: original, a } = await automationFixture(t);
  await original.automation!.updateAutomationPolicy(a.id, { expectedVersion: 0, enabled: true, channel: "production", platforms: ["ios", "android"] }, now);
  let queries = 0, detections = 0;
  const observed = new Proxy(db, { get(target, key) {
    if (key === "prepare") return (sql: string) => { queries++; return target.prepare(sql); };
    const member = Reflect.get(target, key); return typeof member === "function" ? member.bind(target) : member;
  } });
  const store = createD1ImportStore(observed, config, () => {});
  const service = createAutomationService({ applications: store.applications!, operations: store.operations!, automation: store.automation! }, {
    now: () => now, publicOrigin: config.origin, maxWebhookTargets: 1,
    async detectPushCommit(appId, commitSha) {
      detections++;
      const app = (await store.applications!.getApplication(appId))!, connection = (await store.operations!.getGitHubConnection(appId))!;
      const recipe = { schemaVersion: 1 as const, bundler: "expo" as const, entryFile: "index.js", toolchain: { nodeVersion: "24.19.0", packageManager: { name: "pnpm" as const, version: "11.19.0" } }, runtimeVersion: "1", platforms: ["ios" as const, "android" as const], updatesUrl: config.origin + "/updates/" + appId };
      return store.operations!.saveGitHubDetection({ id: "github_" + crypto.randomUUID(), appId, connection, rootDirectory: app.rootDirectory, detectedAt: now, commitSha, framework: "expo", expoVersion: "55.0.0", reactNativeVersion: "0.82.0", configSource: "app.json", runtimeVersion: "1", platforms: ["ios", "android"], updatesEnabled: true, updatesUrl: recipe.updatesUrl, reasons: [], automationConfig: recipe });
    },
  });
  const event = { deliveryId: "delivery-dual-budget", installationId: 1, owner: "fixture", repository: "sample", ref: "refs/heads/main", commitSha: "b".repeat(40) };
  const result = await service.handleGitHubPush(event);
  assert.equal(result.jobs.length, 2); assert.equal(detections, 1);
  t.diagnostic("Hosted one-app dual-platform GitHub push: " + queries + " D1 statements"); assert.ok(queries <= 44, String(queries));
  queries = 0; assert.deepEqual(await service.handleGitHubPush(event), result); assert.equal(detections, 1);
  t.diagnostic("Dual-platform duplicate delivery: " + queries + " D1 statements"); assert.ok(queries <= 50, String(queries));
});

test("automatic_policy_version_is_checked_by_job_and_transition_sql", async t => {
  const { db, auto, a, enqueue } = await automationFixture(t);
  const seed = await enqueue("manual-seed"); await auto.updateAutomationPolicy(a.id, { expectedVersion: 0, enabled: true, channel: "production", platform: "ios" }, now);
  const candidate = { ...seed, id: "job_" + crypto.randomUUID(), requestKey: "policy-race" };
  const beforeJobs = await rows(db, "automation_jobs"), beforeTransitions = await rows(db, "automation_transitions");
  let pending = true;
  const racing = new Proxy(db, { get(target, key) {
    if (key === "batch") return async (statements: Parameters<D1Database["batch"]>[0]) => {
      if (pending) { pending = false; await auto.updateAutomationPolicy(a.id, { expectedVersion: 1, enabled: false, channel: "production", platform: "ios" }, now + 1); }
      return target.batch(statements);
    };
    const member = Reflect.get(target, key); return typeof member === "function" ? member.bind(target) : member;
  } });
  await assert.rejects(createD1ImportStore(racing, config, () => {}).automation!.enqueueAutomationJob(candidate, 1), code("CONFIG_CONFLICT"));
  assert.deepEqual(await rows(db, "automation_jobs"), beforeJobs); assert.deepEqual(await rows(db, "automation_transitions"), beforeTransitions);
  assert.equal(await auto.getAutomationJobForRequest(a.id, candidate.requestKey), null);
  await assert.rejects(auto.enqueueAutomationJob(candidate, 2), code("CONFIG_CONFLICT"));
  await auto.updateAutomationPolicy(a.id, { expectedVersion: 2, enabled: true, channel: "different", platform: "android" }, now + 2);
  await assert.rejects(auto.enqueueAutomationJob(candidate, 3), code("CONFIG_CONFLICT"));
  // An immutable receipt remains retryable; manual admission is independent of the automatic policy.
  assert.equal((await auto.enqueueAutomationJob(seed, 1)).id, seed.id);
  assert.equal((await auto.enqueueAutomationJob(candidate)).id, candidate.id);
});

test("intent_guard_does_not_cross_app_runtime_or_platform", async t => {
  for (const variant of ["app", "runtime", "platform"]) await t.test(variant, async sub => {
    const { auto, ops, a, b, authority, enqueue, publication } = await automationFixture(sub);
    const old = await enqueue("old"); const claim = (await auto.claimAutomationJob(authority, now, 10000))!;
    const payload = await publication(claim.job, claim.lease, now + 1);
    if (variant === "platform") await enqueue("unrelated", { platform: "android" });
    else {
      const appId = variant === "app" ? b.id : a.id;
      const recipe = { ...old.config, runtimeVersion: variant === "runtime" ? "2" : "1", updatesUrl: config.origin + "/updates/" + appId };
      const connection = variant === "app" ? await ops.saveGitHubConnection(b.id, { expectedVersion: 0, installationId: 1, owner: "fixture", repository: "sample", ref: "main" }, now) : old.connection;
      const detection = await ops.saveGitHubDetection({ ...old.detection, id: "github_other", appId, connection, commitSha: "c".repeat(40), runtimeVersion: recipe.runtimeVersion, updatesUrl: recipe.updatesUrl, automationConfig: recipe });
      await auto.enqueueAutomationJob({ ...old, id: "job_" + crypto.randomUUID(), requestKey: "unrelated", appId, connection, detectionId: detection.id, detection, commitSha: detection.commitSha, runtimeVersion: recipe.runtimeVersion, config: recipe, configDigest: await automationDigest(recipe) });
    }
    assert.equal((await auto.finalizeAutomationJob(authority, claim.lease, payload, now + 2)).job.state, "succeeded");
  });
});

test("expired_attempts_stop_after_three_and_late_runner_revocation_blocks_upload", async t => {
  const { db, auto, a, authority, enqueue } = await automationFixture(t); const job = await enqueue("exhaust");
  for (let attempt = 0; attempt < 3; attempt++) {
    const claim = (await auto.claimAutomationJob(authority, now + attempt * 100, 100))!; assert.equal(claim.lease.fence, attempt + 1);
    const expired = await auto.expireAutomationJob(a.id, job.id, now + (attempt + 1) * 100);
    assert.equal(expired.state, attempt < 2 ? "queued" : "failed");
  }
  assert.equal(await auto.claimAutomationJob(authority, now + 301, 100), null); assert.equal((await auto.listAutomationAttempts(a.id, job.id)).length, 3);
  const next = await enqueue("revoke-race"); const claim = (await auto.claimAutomationJob(authority, now + 400, 1000))!;
  assert.equal(claim.job.id, next.id);
  const bytes = new Uint8Array([99]), asset = await prepareOTAAsset(a.id, { key: "late", contentType: "application/javascript", fileExtension: ".js" }, bytes, now + 401);
  const racing = new Proxy(db, { get(target, key) {
    if (key === "batch") return async (statements: Parameters<D1Database["batch"]>[0]) => { await auto.revokeRunner(authority.runnerId, now + 401); return target.batch(statements); };
    const member = Reflect.get(target, key); return typeof member === "function" ? member.bind(target) : member;
  } });
  await assert.rejects(createD1ImportStore(racing, config, () => {}).automation!.saveAutomationAsset(authority, claim.lease, asset, bytes, now + 401), error => code("LEASE_STALE")(error) || code("PERMISSION_DENIED")(error));
  assert.equal(await createD1ImportStore(db, config, () => {}).operations!.getOTAAsset(a.id, asset.id), null);
});
