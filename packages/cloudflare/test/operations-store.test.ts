import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { D1Database } from "@cloudflare/workers-types";
import { canonicalJson } from "@app-ops/config";
import { DomainError } from "@app-ops/core";
import { createOperationsService, parseSourceBundle, parseBaselineBundle, assessReport, CONFIG_RUNTIME_SMOKE_V1 } from "@app-ops/dogfood";
import { bundleBytes, syntheticSourceBundle, syntheticBaseline } from "../../../tests/dogfood-fixtures.ts";
import type { GitHubDetection, OTAAsset, OTADeployment } from "@app-ops/dogfood";
import { createD1ImportStore } from "../dist/d1-import-store.js";
import { createD1OperationsStore } from "../dist/operations-store.js";
import { createTestRuntime } from "./runtime.ts";
const now = 1770000000000;
const config = { ownerId: "owner", ownerEmail: "owner@example.invalid", origin: "https://flora.example.com", dbIdentity: "fixture", setup: null };
const rejects = (code: string) => (error: unknown) => error instanceof Error && error.message === code;
async function migration(db: D1Database, name: string) {
  const sql = await readFile(new URL("../migrations/" + name, import.meta.url), "utf8");
  await db.exec(sql.replace(/^--.*$/gm, "").split(/;\s*(?=CREATE|INSERT|DROP|PRAGMA|$)/).filter(s => s.trim()).map(s => s.replace(/\s*\n\s*/g, " ").trim() + ";").join("\n"));
}
async function setup(t: test.TestContext, fence = () => {}, migrate = true) {
  const runtime = await createTestRuntime({ entrypoint: new URL("./fixtures/runtime-entry.ts", import.meta.url) }); t.after(() => runtime.dispose());
  const db = runtime.d1 as unknown as D1Database;
  await migration(db, "0001_private_imports.sql"); await migration(db, "0002_multi_app.sql");
  await db.prepare("INSERT INTO flora_deployment VALUES(1,?,?,?)").bind(config.ownerId, config.origin, config.dbIdentity).run();
  const store = createD1ImportStore(db, config, fence);
  const a = await store.applications!.registerApplication({ name: "A", repositoryId: "a", rootDirectory: "." }, now);
  const b = await store.applications!.registerApplication({ name: "B", repositoryId: "b", rootDirectory: "." }, now);
  if (migrate) await migration(db, "0003_github_ota.sql");
  return { db, store, operations: store.operations!, a, b };
}
async function detection(operations: ReturnType<typeof createD1ImportStore>["operations"], appId: string): Promise<GitHubDetection> {
  const connection = await operations!.saveGitHubConnection(appId, { expectedVersion: 0, installationId: 1, owner: "example", repository: "sample", ref: "main" }, now);
  return operations!.saveGitHubDetection({ id: "detection_" + appId, appId, connection, rootDirectory: ".", detectedAt: now,
    commitSha: "a".repeat(40), framework: "expo", expoVersion: "55.0.0", reactNativeVersion: "0.82.0", configSource: "app.json",
    runtimeVersion: "1", platforms: ["ios", "android"], updatesEnabled: true, updatesUrl: config.origin + "/updates/" + appId, reasons: [] });
}
async function asset(appId: string, size = 600000): Promise<{ asset: OTAAsset; bytes: Uint8Array }> {
  const bytes = new Uint8Array(size).fill(97); const hash = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)); const digest = hash.toString("hex");
  return { bytes, asset: { id: "asset_" + digest, appId, digest, hash: hash.toString("base64url"), key: "export-key", contentType: "application/javascript", fileExtension: ".js", size, createdAt: now } };
}
function deployment(detection: GitHubDetection, asset: OTAAsset): OTADeployment {
  return { id: crypto.randomUUID(), appId: detection.appId, requestKey: "same-key", detectionId: detection.id, commitSha: detection.commitSha,
    channel: "production", runtimeVersion: "1", platform: "ios", launchAssetId: asset.id, assetIds: [], launchAsset: asset, assets: [], createdAt: now };
}
async function rows(db: D1Database, table: string) { return (await db.prepare(`SELECT * FROM ${table}`).all()).results; }

test("manual rollback restores exact published artifact after reconnect without rewriting prior data", async t => {
  const { db, store, operations, a, b } = await setup(t);
  await migration(db, "0010_manual_ota_rollback.sql");
  const d = await detection(operations, a.id), uploaded = await asset(a.id, 32);
  await operations.saveOTAAsset(uploaded.asset, uploaded.bytes);
  const original = await operations.saveOTADeployment(deployment(d, uploaded.asset));
  const broken = await operations.saveOTADeployment({ ...original, id: crypto.randomUUID(), requestKey: "broken" });
  await operations.saveGitHubConnection(a.id, { expectedVersion: 1, installationId: 1, owner: "example", repository: "reconnected", ref: "next" }, now + 1);
  const tables = ["applications", "application_settings", "github_connections", "github_detections", "ota_assets", "ota_asset_chunks"];
  const before = await Promise.all(tables.map(table => rows(db, table)));
  const service = createOperationsService({ applications: store.applications!, operations }, undefined, () => now + 2, { publicOrigin: config.origin });
  const input = { requestKey: "rollback-one", fromDeploymentId: broken.id, targetDeploymentId: original.id, reason: "Restore stable bundle" };
  const restored = await service.rollback(a.id, input);
  assert.ok(restored.createdAt > broken.createdAt);
  assert.deepEqual(restored.launchAsset, original.launchAsset);
  assert.deepEqual(restored.rollback, { fromDeploymentId: broken.id, targetDeploymentId: original.id, reason: input.reason, requestedAt: now + 2 });
  assert.deepEqual(await operations.getOTADeployment(a.id, original.id), original);
  assert.equal(await operations.getOTADeployment(b.id, original.id), null);
  for (const [index, table] of tables.entries()) assert.deepEqual(await rows(db, table), before[index], table);
  assert.equal((await rows(db, "ota_deployments")).length, 3);
  const manifest = await (await service.getUpdate(a.id, { channel: "production", runtimeVersion: "1", platform: "ios" }, config.origin)).json() as { id: string; launchAsset: { hash: string } };
  assert.equal(manifest.id, restored.id); assert.equal(manifest.launchAsset.hash, original.launchAsset.hash);
  assert.deepEqual(await service.rollback(a.id, input), restored);
  await assert.rejects(service.rollback(a.id, { ...input, reason: "Changed request" }), rejects("IDEMPOTENCY_CONFLICT"));
  await assert.rejects(operations.saveOTADeployment({ ...restored, id: crypto.randomUUID(), requestKey: "regular-injection" }));
  await assert.rejects(service.rollback(a.id, { ...input, requestKey: "stale-source" }), rejects("CONFIG_CONFLICT"));
});

test("rollback migration changes only guards and raw mismatched rollback cannot bypass provenance", async t => {
  const { db, operations, a } = await setup(t);
  const d = await detection(operations, a.id), uploaded = await asset(a.id, 32);
  await operations.saveOTAAsset(uploaded.asset, uploaded.bytes);
  const original = await operations.saveOTADeployment(deployment(d, uploaded.asset));
  const current = await operations.saveOTADeployment({ ...original, id: crypto.randomUUID(), requestKey: "current" });
  const tables = ["flora_capacity", "ota_deployments", "ota_deployment_assets", "ota_assets", "ota_asset_chunks", "github_connections", "github_detections"];
  const before = await Promise.all(tables.map(table => rows(db, table)));
  await migration(db, "0010_manual_ota_rollback.sql");
  for (const [index, table] of tables.entries()) assert.deepEqual(await rows(db, table), before[index], table);
  const metadata = { fromDeploymentId: current.id, targetDeploymentId: original.id, reason: "Restore", requestedAt: now };
  for (const rollback of [
    { ...metadata, targetDeploymentId: current.id }, { ...metadata, targetDeploymentId: crypto.randomUUID() },
    { ...metadata, reason: " " }, { ...metadata, reason: "x".repeat(501) }, { ...metadata, requestedAt: -1 },
    { ...metadata, requestedAt: "untrusted" }, { ...metadata, requestedAt: current.createdAt + 100 },
    { ...metadata, extra: "unexpected" }, null,
  ]) {
    const forbidden = { ...original, id: crypto.randomUUID(), requestKey: "raw_" + crypto.randomUUID(), createdAt: current.createdAt + 1, rollback };
    const fields = [config.ownerId, a.id, forbidden.id, forbidden.requestKey, forbidden.channel, forbidden.runtimeVersion, forbidden.platform, forbidden.createdAt, canonicalJson(forbidden)];
    await assert.rejects(db.prepare("INSERT INTO ota_deployments(owner_id,app_id,id,request_key,channel,runtime_version,platform,created_at,data,stored_bytes) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(...fields, Buffer.byteLength(canonicalJson(fields))).run(), /rollback provenance mismatch/);
  }
  assert.deepEqual(await rows(db, "ota_deployments"), before[1]);
});

test("rollback source CAS is checked in the publication batch when a Runner wins the race", async t => {
  const { db, store, operations, a } = await setup(t);
  await migration(db, "0010_manual_ota_rollback.sql");
  const d = await detection(operations, a.id), uploaded = await asset(a.id, 32);
  await operations.saveOTAAsset(uploaded.asset, uploaded.bytes);
  const original = await operations.saveOTADeployment(deployment(d, uploaded.asset));
  const current = await operations.saveOTADeployment({ ...original, id: crypto.randomUUID(), requestKey: "before-race" });
  let winner: OTADeployment | undefined; let beforeRollback: unknown;
  const racing = new Proxy(db, { get(target, key) {
    if (key === "batch") return async (statements: Parameters<D1Database["batch"]>[0]) => {
      winner = await operations.saveOTADeployment({ ...current, id: crypto.randomUUID(), requestKey: "runner-winner" });
      beforeRollback = await rows(db, "flora_capacity");
      return target.batch(statements);
    };
    const member = Reflect.get(target, key); return typeof member === "function" ? member.bind(target) : member;
  } });
  const guarded = createD1OperationsStore(racing, config.ownerId, store.applications!, async () => {}, () => {});
  const input = { ...original, id: crypto.randomUUID(), requestKey: "losing-rollback", createdAt: now + 2,
    rollback: { fromDeploymentId: current.id, targetDeploymentId: original.id, reason: "Restore", requestedAt: now + 2 } };
  await assert.rejects(guarded.saveOTARollback(input), rejects("CONFIG_CONFLICT"));
  assert.equal((await operations.getLatestOTADeployment(a.id, { channel: "production", runtimeVersion: "1", platform: "ios" }))!.id, winner!.id);
  assert.equal(await operations.getOTADeploymentForRequest(a.id, input.requestKey), null);
  assert.equal((await rows(db, "ota_deployments")).length, 3);
  assert.equal((await rows(db, "ota_deployment_assets")).length, 3);
  assert.deepEqual(await rows(db, "flora_capacity"), beforeRollback);
});

test("failed source validation preserves both apps settings, OTA history and D1 capacity", async t => {
  const { db, store, operations, a, b } = await setup(t);
  for (const application of [a, b]) {
    const detected = await detection(operations, application.id), uploaded = await asset(application.id, 32);
    await operations.saveOTAAsset(uploaded.asset, uploaded.bytes);
    await operations.saveOTADeployment(deployment(detected, uploaded.asset));
    await store.applications!.updateApplicationSettings(application.id, { expectedVersion: 0, values: { APP_LABEL: application.name } }, now + 1);
  }
  const service = createOperationsService({ applications: store.applications!, operations }, { async detect() { throw new DomainError("GITHUB_ACCESS_DENIED"); } }, () => now + 2);
  const tables = ["flora_capacity", "applications", "application_settings", "github_connections", "github_detections", "ota_assets", "ota_asset_chunks", "ota_deployments", "ota_deployment_assets"];
  const before = await Promise.all(tables.map(table => rows(db, table))), states = await Promise.all([a, b].map(application => service.getState(application.id)));
  for (const application of [a, b]) {
    await assert.rejects(service.connect(application.id, { expectedVersion: 1, installationId: 1, owner: "example", repository: "unavailable", ref: "main" }), rejects("GITHUB_ACCESS_DENIED"));
  }
  for (const [index, table] of tables.entries()) assert.deepEqual(await rows(db, table), before[index], table);
  assert.deepEqual(await Promise.all([a, b].map(application => service.getState(application.id))), states);
});

test("operations_migration_preserves_old_rows_and_capacity_exactly", async t => {
  const { db, store } = await setup(t, () => {}, false);
  const snapshot = await store.saveInventory(await parseSourceBundle(bundleBytes(syntheticSourceBundle()), now));
  const evidence = await parseBaselineBundle(bundleBytes(syntheticBaseline(snapshot)), snapshot);
  const baseline = await store.persistBaseline({ snapshotId: snapshot.id, evidence, assessment: assessReport(evidence, CONFIG_RUNTIME_SMOKE_V1), now });
  await store.saveHeadObservation({ repositoryId: snapshot.repository.id, rootDirectory: snapshot.rootDirectory, headCommitSha: snapshot.commitSha, observedAt: snapshot.fetchedAt, evidenceOrigin: "operator-import" });
  const tables = ["flora_deployment", "flora_capacity", "applications", "application_settings", "inventory_snapshots", "baseline_imports", "source_head_observations"];
  const before = await Promise.all(tables.map(table => rows(db, table)));
  await migration(db, "0003_github_ota.sql");
  for (let index = 0; index < tables.length; index++) assert.deepEqual(await rows(db, tables[index]!), before[index]);
  assert.equal((await store.saveInventory(snapshot)).id, snapshot.id);
  assert.equal((await store.persistBaseline({ snapshotId: snapshot.id, evidence, assessment: assessReport(evidence, CONFIG_RUNTIME_SMOKE_V1), now })).id, baseline.id);
});

test("chunked_assets_are_private_until_publish_and_isolated_per_app", async t => {
  const { db, operations, a, b } = await setup(t);
  const da = await detection(operations, a.id), dbDetection = await detection(operations, b.id);
  const uploaded = await asset(a.id); await operations.saveOTAAsset(uploaded.asset, uploaded.bytes);
  assert.equal((await rows(db, "ota_asset_chunks")).length, 2);
  assert.equal(await operations.getPublishedOTAAsset(a.id, uploaded.asset.id), null);
  assert.equal(await operations.getOTAAsset(b.id, uploaded.asset.id), null);
  const first = await operations.saveOTADeployment(deployment(da, uploaded.asset));
  assert.deepEqual((await operations.getPublishedOTAAsset(a.id, uploaded.asset.id))!.bytes, uploaded.bytes);
  assert.equal(await operations.getPublishedOTAAsset(b.id, uploaded.asset.id), null);
  const other = { ...uploaded.asset, appId: b.id }; await operations.saveOTAAsset(other, uploaded.bytes);
  const second = await operations.saveOTADeployment(deployment(dbDetection, other));
  assert.notEqual(first.id, second.id);
  assert.equal((await operations.saveOTADeployment({ ...first, id: crypto.randomUUID(), createdAt: now + 1 })).id, first.id);
  await assert.rejects(operations.saveOTADeployment({ ...first, channel: "other" }), rejects("IDEMPOTENCY_CONFLICT"));
  assert.equal((await operations.getLatestOTADeployment(a.id, { channel: "production", runtimeVersion: "1", platform: "ios" }))!.id, first.id);
  assert.equal(await operations.getLatestOTADeployment(a.id, { channel: "production", runtimeVersion: "other", platform: "ios" }), null);
  const total = await db.prepare("SELECT payload_bytes FROM flora_capacity").first<{payload_bytes:number}>();
  const tables = ["applications", "application_settings", "github_connections", "github_detections", "ota_assets", "ota_asset_chunks", "ota_deployments", "ota_deployment_assets"];
  const sums = await Promise.all(tables.map(table => db.prepare(`SELECT coalesce(sum(stored_bytes),0) AS n FROM ${table}`).first<{n:number}>()));
  assert.equal(total!.payload_bytes, sums.reduce((sum, row) => sum + row!.n, 0));
});

test("connection_cas_and_detection_publication_provenance_fail_closed", async t => {
  const { operations, a, b } = await setup(t);
  const change = { expectedVersion: 0, installationId: 1, owner: "example", repository: "sample", ref: "main" };
  const race = await Promise.allSettled([operations.saveGitHubConnection(a.id, change, now), operations.saveGitHubConnection(a.id, change, now)]);
  assert.equal(race.filter(v => v.status === "fulfilled").length, 1);
  const dbDetection = await detection(operations, b.id);
  const uploaded = await asset(b.id); await operations.saveOTAAsset(uploaded.asset, uploaded.bytes);
  await assert.rejects(operations.saveOTADeployment({ ...deployment(dbDetection, uploaded.asset), appId: a.id }), rejects("NOT_FOUND"));
  await operations.saveGitHubConnection(b.id, { ...change, expectedVersion: 1, ref: "next" }, now + 1);
  await assert.rejects(operations.saveGitHubDetection({ ...dbDetection, id: "stale_detection" }), rejects("CONFLICT"));
  await assert.rejects(operations.saveOTADeployment(deployment(dbDetection, uploaded.asset)), rejects("CONFIG_CONFLICT"));
});

test("quota_failure_rolls_back_all_chunks_and_auth_fence_prevents_mutation", async t => {
  let allowed = true;
  const { db, operations, a } = await setup(t, () => { if (!allowed) throw new Error("revoked"); });
  const uploaded = await asset(a.id);
  const before = await rows(db, "flora_capacity");
  await db.exec("CREATE TRIGGER synthetic_quota BEFORE INSERT ON ota_asset_chunks WHEN NEW.chunk_index=1 BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;");
  await assert.rejects(operations.saveOTAAsset(uploaded.asset, uploaded.bytes), rejects("CONFLICT"));
  assert.deepEqual(await rows(db, "ota_assets"), []); assert.deepEqual(await rows(db, "ota_asset_chunks"), []);
  assert.deepEqual(await rows(db, "flora_capacity"), before);
  allowed = false;
  await assert.rejects(operations.saveOTAAsset(uploaded.asset, uploaded.bytes), /revoked/);
  await assert.rejects(operations.saveGitHubConnection(a.id, { expectedVersion: 0, installationId: 1, owner: "example", repository: "sample", ref: "main" }, now), /revoked/);
  assert.deepEqual(await rows(db, "flora_capacity"), before);
});

test("maximum_asset_uses_bounded_rows_and_immutable_guarded_references", async t => {
  const { db, operations, a, b } = await setup(t);
  const d = await detection(operations, a.id);
  const uploaded = await asset(a.id, 16 * 1024 * 1024);
  await operations.saveOTAAsset(uploaded.asset, uploaded.bytes);
  const chunks = await db.prepare("SELECT count(*) AS n,max(byte_length) AS largest,max(stored_bytes) AS charged FROM ota_asset_chunks").first<{n:number;largest:number;charged:number}>();
  assert.equal(chunks!.n, 32); assert.equal(chunks!.largest, 524288); assert.ok(chunks!.charged < 1048576);
  const read = await operations.getOTAAsset(a.id, uploaded.asset.id);
  assert.equal(read!.bytes.length, uploaded.bytes.length);
  assert.equal(Buffer.from(await crypto.subtle.digest("SHA-256", Uint8Array.from(read!.bytes))).toString("hex"), uploaded.asset.digest);
  await assert.rejects(operations.saveOTAAsset({ ...uploaded.asset, key: "different-key" }, uploaded.bytes), rejects("IDEMPOTENCY_CONFLICT"));
  const published = await operations.saveOTADeployment(deployment(d, uploaded.asset));
  const before = await rows(db, "flora_capacity");
  const fields = [config.ownerId, b.id, published.id, uploaded.asset.digest];
  await assert.rejects(db.prepare("INSERT INTO ota_deployment_assets(owner_id,app_id,deployment_id,hash,stored_bytes) VALUES(?,?,?,?,?)")
    .bind(...fields, Buffer.byteLength(canonicalJson(fields))).run());
  for (const table of ["github_connections", "github_detections", "ota_assets", "ota_asset_chunks", "ota_deployments", "ota_deployment_assets"]) {
    await assert.rejects(db.prepare(`UPDATE ${table} SET owner_id='other'`).run(), /immutable/);
    await assert.rejects(db.prepare(`DELETE FROM ${table}`).run(), /immutable/);
    await assert.rejects(db.prepare(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`).run(), /immutable|version|capacity|timestamp conflict/);
  }
  assert.deepEqual(await rows(db, "flora_capacity"), before);
});

test("revocation_blocks_detection_and_publication_and_failure_keeps_assets_private", async t => {
  let allowed = true;
  const { db, operations, a } = await setup(t, () => { if (!allowed) throw new Error("revoked"); });
  const d = await detection(operations, a.id); const uploaded = await asset(a.id); await operations.saveOTAAsset(uploaded.asset, uploaded.bytes);
  const before = await rows(db, "flora_capacity");
  await db.exec("CREATE TRIGGER synthetic_ref_quota BEFORE INSERT ON ota_deployment_assets BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;");
  await assert.rejects(operations.saveOTADeployment(deployment(d, uploaded.asset)), rejects("CONFLICT"));
  assert.deepEqual(await rows(db, "ota_deployments"), []); assert.deepEqual(await rows(db, "ota_deployment_assets"), []);
  assert.equal(await operations.getPublishedOTAAsset(a.id, uploaded.asset.id), null);
  assert.deepEqual(await rows(db, "flora_capacity"), before);
  allowed = false;
  await assert.rejects(operations.saveGitHubDetection({ ...d, id: "another_detection" }), /revoked/);
  await assert.rejects(operations.saveOTADeployment(deployment(d, uploaded.asset)), /revoked/);
  assert.deepEqual(await rows(db, "flora_capacity"), before);
});

test("app_asset_count_limit_is_atomic_and_duplicate_retry_is_free", async t => {
  const { db, operations, a } = await setup(t); let first: OTAAsset | undefined;
  for (let index = 0; index < 128; index++) {
    const bytes = new Uint8Array([index]); const hash = Buffer.from(await crypto.subtle.digest("SHA-256", bytes));
    const metadata: OTAAsset = { id: "asset_" + hash.toString("hex"), appId: a.id, digest: hash.toString("hex"), hash: hash.toString("base64url"), key: "k" + index, contentType: "application/javascript", fileExtension: ".js", size: 1, createdAt: now };
    await operations.saveOTAAsset(metadata, bytes); first ??= metadata;
  }
  assert.equal((await operations.listOTAAssets(a.id)).length, 128);
  const before = await rows(db, "flora_capacity"); const overflow = await asset(a.id, 2);
  await assert.rejects(operations.saveOTAAsset(overflow.asset, overflow.bytes), rejects("CONFLICT"));
  assert.equal((await operations.saveOTAAsset(first!, new Uint8Array([0]))).id, first!.id);
  assert.deepEqual(await rows(db, "flora_capacity"), before);
  assert.equal((await rows(db, "ota_asset_chunks")).length, 128);
});

test("database_guards_recheck_connection_after_final_reads", async t => {
  const { db, operations, a } = await setup(t);
  const original = await detection(operations, a.id);
  function racingStore(expectedVersion: number) {
    const racing = new Proxy(db, { get(target, key) {
      if (key === "batch") return async (statements: Parameters<D1Database["batch"]>[0]) => {
        await operations.saveGitHubConnection(a.id, { expectedVersion, installationId: 1, owner: "example", repository: "sample", ref: "branch" + expectedVersion }, now + expectedVersion);
        return target.batch(statements);
      };
      const member = Reflect.get(target, key); return typeof member === "function" ? member.bind(target) : member;
    } });
    return createD1ImportStore(racing, config, () => {}).operations!;
  }
  await assert.rejects(racingStore(1).saveGitHubDetection({ ...original, id: "raced_detection", detectedAt: now + 1 }), rejects("CONFLICT"));
  assert.equal(await operations.getGitHubDetection(a.id, "raced_detection"), null);
  const connection = (await operations.getGitHubConnection(a.id))!;
  const current = await operations.saveGitHubDetection({ ...original, id: "current_detection", connection, detectedAt: now + 2 });
  const uploaded = await asset(a.id); await operations.saveOTAAsset(uploaded.asset, uploaded.bytes);
  await assert.rejects(racingStore(2).saveOTADeployment({ ...deployment(current, uploaded.asset), createdAt: now + 3 }), rejects("CONFLICT"));
  assert.equal((await operations.listOTADeployments(a.id)).length, 0);
  assert.equal(await operations.getPublishedOTAAsset(a.id, uploaded.asset.id), null);
});

test("same_time_publications_allocate_increasing_client_timestamps", async t => {
  const { store, operations, a } = await setup(t); const d = await detection(operations, a.id);
  const uploaded = await asset(a.id); await operations.saveOTAAsset(uploaded.asset, uploaded.bytes);
  const first = await operations.saveOTADeployment({ ...deployment(d, uploaded.asset), id: "ffffffff-ffff-4fff-bfff-ffffffffffff", requestKey: "first" });
  const second = await operations.saveOTADeployment({ ...deployment(d, uploaded.asset), id: "00000000-0000-4000-8000-000000000000", requestKey: "second" });
  assert.ok(first.id > second.id);
  assert.equal(second.createdAt, first.createdAt + 1);
  const service = createOperationsService({ applications: store.applications!, operations }, undefined, () => now, { publicOrigin: config.origin });
  assert.equal((await operations.getLatestOTADeployment(a.id, { channel: "production", runtimeVersion: "1", platform: "ios" }))!.id, second.id);
  const manifest = await service.getUpdate(a.id, { channel: "production", runtimeVersion: "1", platform: "ios" }, config.origin);
  const body = await manifest.json() as { createdAt: string };
  assert.equal(Date.parse(body.createdAt), second.createdAt);
});

test("upper_bound_domain_requests_fit_free_d1_query_budget", async t => {
  const { db, operations, a } = await setup(t); const d = await detection(operations, a.id); let queries = 0;
  const observed = new Proxy(db, { get(target, key) {
    if (key === "prepare") return (sql: string) => { queries++; return target.prepare(sql); };
    const member = Reflect.get(target, key); return typeof member === "function" ? member.bind(target) : member;
  } });
  const store = createD1ImportStore(observed, config, () => {});
  const service = createOperationsService({ applications: store.applications!, operations: store.operations! }, undefined, () => now, { publicOrigin: config.origin });
  const budget = (name: string) => { t.diagnostic(name + ": " + queries + " D1 statements"); assert.ok(queries <= 45, name + " exceeded query budget: " + queries); queries = 0; };
  const launch = await service.uploadAsset(a.id, { key: "launch", contentType: "application/javascript", fileExtension: ".js" }, new Uint8Array(16 * 1024 * 1024).fill(97)); budget("16MiB upload");
  const assetIds: string[] = [];
  for (let index = 0; index < 64; index++) assetIds.push((await service.uploadAsset(a.id, { key: "asset" + index, contentType: "image/png", fileExtension: ".png" }, new Uint8Array([index]))).id);
  queries = 0;
  await service.publish(a.id, { requestKey: "upper-bound", detectionId: d.id, commitSha: d.commitSha, channel: "production", runtimeVersion: "1", platform: "ios", launchAssetId: launch.id, assetIds }); budget("65-file publication");
  const update = await service.getUpdate(a.id, { channel: "production", runtimeVersion: "1", platform: "ios" }, config.origin);
  assert.equal(update.status, 200); budget("manifest");
  const downloaded = await service.getPublishedAsset(a.id, launch.id); assert.equal(downloaded!.bytes.length, launch.size); budget("16MiB public download");
});

test("request_receipt_lookup_survives_reconnection_and_is_app_scoped", async t => {
  const { store, operations, a, b } = await setup(t);
  const d = await detection(operations, a.id); const uploaded = await asset(a.id);
  await operations.saveOTAAsset(uploaded.asset, uploaded.bytes);
  const receipt = await operations.saveOTADeployment(deployment(d, uploaded.asset));
  await operations.saveGitHubConnection(a.id, { expectedVersion: 1, installationId: 2, owner: "example", repository: "other", ref: "next" }, now + 1);
  assert.deepEqual(await operations.getOTADeploymentForRequest(a.id, receipt.requestKey), receipt);
  assert.equal(await operations.getOTADeploymentForRequest(b.id, receipt.requestKey), null);
  assert.equal(await operations.getOTADeploymentForRequest(a.id, "missing"), null);
  const service = createOperationsService({ applications: store.applications!, operations }, undefined, () => now + 2, { publicOrigin: config.origin });
  const request = { requestKey: receipt.requestKey, detectionId: receipt.detectionId, commitSha: receipt.commitSha, channel: receipt.channel,
    runtimeVersion: receipt.runtimeVersion, platform: receipt.platform, launchAssetId: receipt.launchAssetId, assetIds: receipt.assetIds };
  assert.deepEqual(await service.publish(a.id, request), receipt);
  await assert.rejects(service.publish(a.id, { ...request, channel: "changed" }), rejects("IDEMPOTENCY_CONFLICT"));
});

test("concurrent_timestamp_allocations_conflict_atomically_and_retry_monotonically", async t => {
  const { db, operations, a } = await setup(t); const d = await detection(operations, a.id);
  const uploaded = await asset(a.id); await operations.saveOTAAsset(uploaded.asset, uploaded.bytes);
  let reads = 0; let release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; });
  const racing = new Proxy(db, { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      const statement = target.prepare(sql); if (!sql.startsWith("SELECT max(created_at)")) return statement;
      return new Proxy(statement, { get(stmt, operation) {
        if (operation === "bind") return (...values: unknown[]) => {
          const bound = stmt.bind(...values);
          return new Proxy(bound, { get(selected, method) {
            if (method === "first") return async () => { const row = await selected.first(); reads++; if (reads === 2) release(); await ready; return row; };
            const member = Reflect.get(selected, method); return typeof member === "function" ? member.bind(selected) : member;
          } });
        };
        const member = Reflect.get(stmt, operation); return typeof member === "function" ? member.bind(stmt) : member;
      } });
    };
    const member = Reflect.get(target, key); return typeof member === "function" ? member.bind(target) : member;
  } });
  const concurrent = createD1ImportStore(racing, config, () => {}).operations!;
  const inputs = [ { ...deployment(d, uploaded.asset), requestKey: "race-a" }, { ...deployment(d, uploaded.asset), requestKey: "race-b" } ];
  const results = await Promise.allSettled(inputs.map(input => concurrent.saveOTADeployment(input)));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const loser = results.findIndex(result => result.status === "rejected");
  assert.ok(rejects("CONFLICT")((results[loser] as PromiseRejectedResult).reason));
  assert.equal((await rows(db, "ota_deployments")).length, 1); assert.equal((await rows(db, "ota_deployment_assets")).length, 1);
  const retry = await operations.saveOTADeployment(inputs[loser]!); assert.equal(retry.createdAt, now + 1);
  const before = await rows(db, "flora_capacity");
  for (const createdAt of [now, now + 1]) {
    const forbidden = { ...retry, id: crypto.randomUUID(), requestKey: "raw-time-" + createdAt, createdAt };
    const fields = [config.ownerId, a.id, forbidden.id, forbidden.requestKey, forbidden.channel, forbidden.runtimeVersion, forbidden.platform, createdAt, canonicalJson(forbidden)];
    await assert.rejects(db.prepare("INSERT INTO ota_deployments(owner_id,app_id,id,request_key,channel,runtime_version,platform,created_at,data,stored_bytes) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .bind(...fields, Buffer.byteLength(canonicalJson(fields))).run(), /deployment timestamp conflict/);
  }
  assert.deepEqual(await rows(db, "flora_capacity"), before);
});
