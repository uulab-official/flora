import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import type { D1Database } from "@cloudflare/workers-types";
import { canonicalJson } from "@app-ops/config";
import { automationDigest, prepareOTAAsset, parseSourceBundle, parseBaselineBundle, assessReport, CONFIG_RUNTIME_SMOKE_V1 } from "@app-ops/dogfood";
import type { AutomationJob } from "@app-ops/dogfood";
import { bundleBytes, syntheticSourceBundle, syntheticBaseline } from "../../../tests/dogfood-fixtures.ts";
import { createD1ImportStore } from "../dist/d1-import-store.js";
import { createTestRuntime } from "./runtime.ts";

const now = 1770000000000;
const config = { ownerId: "owner", ownerEmail: "owner@example.invalid", origin: "https://flora.example.com", dbIdentity: "fixture", setup: null };
const chargedTables = ["inventory_snapshots", "baseline_imports", "source_head_observations", "applications", "application_settings", "github_connections", "github_detections", "ota_assets", "ota_asset_chunks", "ota_deployments", "ota_deployment_assets", "automation_runners", "automation_jobs", "automation_transitions", "automation_guards", "automation_asset_refs", "automation_policies", "automation_publications"];
const tables = ["flora_deployment", "flora_capacity", ...chargedTables];
const accountingMigration = "0007_incremental_capacity_accounting.sql";
const legacyMigrations = ["0005_workspace_capacity_192mib.sql", "0006_workspace_capacity_256mib.sql"];
const conflict = (error: unknown) => error instanceof Error && error.message === "CONFLICT";
async function statements(name: string) {
  const sql = await readFile(new URL("../migrations/" + name, import.meta.url), "utf8");
  return Array.from(sql.replace(/^--.*$/gm, "").matchAll(/\s*(CREATE TRIGGER\b[\s\S]*?\bEND\s*;|[^;]+;)/g), match => match[1]!.trim());
}
async function migrate(db: D1Database, name: string) {
  await db.batch((await statements(name)).map(sql => db.prepare(sql)));
}
async function rows(db: D1Database, table: string) { return (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results; }
async function ledger(db: D1Database) { return (await db.prepare("SELECT * FROM flora_capacity_ledger ORDER BY table_name").all<{ table_name: string; row_count: number; payload_bytes: number; witness_bytes: number; last_sequence: number | null }>()).results; }
async function facts(db: D1Database) { return (await db.prepare("SELECT * FROM flora_capacity_facts ORDER BY sequence").all<{ sequence: number; table_name: string; record_key: string; stored_bytes: number; witness_bytes: number }>()).results; }
async function assertAccounting(db: D1Database) {
  const totals = await ledger(db); assert.equal(totals.length, 18);
  for (const fact of await facts(db)) assert.equal(fact.witness_bytes, Buffer.byteLength(JSON.stringify([fact.table_name, fact.record_key, fact.stored_bytes])), "Canonical persisted TEXT witness charge");
  for (const table of chargedTables) {
    const actual = (await db.prepare(`SELECT count(*) row_count,coalesce(sum(stored_bytes),0) payload_bytes FROM ${table}`).first())!;
    const tracked = totals.find(row => row.table_name === table)!;
    assert.deepEqual({ row_count: tracked.row_count, payload_bytes: tracked.payload_bytes }, actual, table);
    const witness = (await db.prepare("SELECT count(*) n,coalesce(sum(witness_bytes),0) bytes,max(sequence) last FROM flora_capacity_facts WHERE table_name=?").bind(table).first<{ n: number; bytes: number; last: number | null }>())!;
    assert.deepEqual({ n: tracked.row_count, bytes: tracked.witness_bytes, last: tracked.last_sequence }, witness, table + " witness");
  }
  assert.deepEqual(await db.prepare("SELECT snapshot_count,baseline_count,payload_bytes FROM flora_capacity").first(), {
    snapshot_count: totals.find(row => row.table_name === "inventory_snapshots")!.row_count,
    baseline_count: totals.find(row => row.table_name === "baseline_imports")!.row_count,
    payload_bytes: totals.reduce((sum, row) => sum + row.payload_bytes, 0),
  });
}
async function schema(db: D1Database) {
  return (await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all<{ type: string; name: string; tbl_name: string; sql: string }>()).results;
}
const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
async function fixture(t: test.TestContext, baseMigrations: string[] = ["0005_workspace_capacity_192mib.sql", "0006_workspace_capacity_256mib.sql", "0007_incremental_capacity_accounting.sql"]) {
  const runtime = await createTestRuntime({ entrypoint: new URL("./fixtures/runtime-entry.ts", import.meta.url) });
  t.after(() => runtime.dispose()); const db = runtime.d1 as unknown as D1Database;
  for (const name of ["0001_private_imports.sql", "0002_multi_app.sql", "0003_github_ota.sql", "0004_automation.sql", ...baseMigrations]) await migrate(db, name);
  await db.prepare("INSERT INTO flora_deployment VALUES(1,?,?,?)").bind(config.ownerId, config.origin, config.dbIdentity).run();
  const store = createD1ImportStore(db, config, () => {}), ops = store.operations!, auto = store.automation!;
  const snapshot = await store.saveInventory(await parseSourceBundle(bundleBytes(syntheticSourceBundle()), now));
  const evidence = await parseBaselineBundle(bundleBytes(syntheticBaseline(snapshot)), snapshot);
  const baseline = await store.persistBaseline({ snapshotId: snapshot.id, evidence, assessment: assessReport(evidence, CONFIG_RUNTIME_SMOKE_V1), now });
  await store.saveHeadObservation({ repositoryId: snapshot.repository.id, rootDirectory: snapshot.rootDirectory, headCommitSha: snapshot.commitSha, observedAt: snapshot.fetchedAt, evidenceOrigin: "operator-import" });
  const a = (await store.applications!.getApplicationForSnapshot(snapshot.id))!;
  const b = await store.applications!.registerApplication({ name: "Other", repositoryId: "github:other", rootDirectory: "." }, now);
  for (const app of [a, b]) await store.applications!.updateApplicationSettings(app.id, { expectedVersion: 0, values: { APP_LABEL: app.name } }, now);
  const connection = await ops.saveGitHubConnection(a.id, { expectedVersion: 0, installationId: 1, owner: "fixture", repository: "sample", ref: "main" }, now);
  const recipe = { schemaVersion: 1 as const, bundler: "expo" as const, entryFile: "index.js", toolchain: { nodeVersion: "24.19.0", packageManager: { name: "pnpm" as const, version: "11.19.0" } }, runtimeVersion: "1", platforms: ["ios" as const, "android" as const], updatesUrl: config.origin + "/updates/" + a.id };
  const detection = await ops.saveGitHubDetection({ id: "github_fixture", appId: a.id, connection, rootDirectory: a.rootDirectory, detectedAt: now, commitSha: "a".repeat(40), framework: "expo", expoVersion: "55.0.0", reactNativeVersion: "0.82.0", configSource: "app.json", runtimeVersion: "1", platforms: ["ios", "android"], updatesEnabled: true, updatesUrl: recipe.updatesUrl, reasons: [], automationConfig: recipe });
  const runner = { id: "runner_fixture", name: "Fixture", appIds: [a.id], createdAt: now, credentialEpoch: 1, revokedAt: null, tokenHash: "a".repeat(64) };
  await auto.registerRunner(runner); const authority = { runnerId: runner.id, credentialEpoch: runner.credentialEpoch, tokenHash: runner.tokenHash };
  await auto.updateAutomationPolicy(a.id, { expectedVersion: 0, enabled: true, channel: "verification", platforms: ["ios", "android"] }, now);
  const job: AutomationJob = { id: "job_fixture", appId: a.id, requestKey: "queue-fixture", detectionId: detection.id, channel: "verification", runtimeVersion: "1", platform: "ios", config: recipe, detection, commitSha: detection.commitSha, rootDirectory: a.rootDirectory, connection, configDigest: await automationDigest(recipe), toolchainDigest: await automationDigest(recipe.toolchain), createdAt: now, updatedAt: now, state: "queued", attemptCount: 0, lease: null, code: null, deploymentId: null, receipt: null };
  await auto.enqueueAutomationJob(job, 1); const claimed = (await auto.claimAutomationJob(authority, now, 5000))!;
  const bytes = new Uint8Array([1, 2, 3]), asset = await prepareOTAAsset(a.id, { key: "launch", contentType: "application/javascript", fileExtension: ".js" }, bytes, now);
  const saved = await auto.saveAutomationAsset(authority, claimed.lease, asset, bytes, now);
  const receiptFields = { jobId: job.id, attemptId: claimed.lease.attemptId, commitSha: job.commitSha, configDigest: job.configDigest, toolchainDigest: job.toolchainDigest, sourceArchiveDigest: "b".repeat(64), launchAssetId: saved.id, assetIds: [] as string[] };
  const { id, digest, hash, key, contentType, fileExtension, size } = saved;
  const receipt = { ...receiptFields, artifactDigest: await automationDigest({ receipt: receiptFields, assets: [{ id, digest, hash, key, contentType, fileExtension, size }] }) };
  const completed = await auto.finalizeAutomationJob(authority, claimed.lease, { receipt, deployment: { id: crypto.randomUUID(), appId: a.id, requestKey: job.id, detectionId: job.detectionId, commitSha: job.commitSha, channel: job.channel, runtimeVersion: job.runtimeVersion, platform: job.platform, launchAssetId: saved.id, assetIds: [], launchAsset: saved, assets: [], createdAt: now } }, now);
  return { db, store, ops, auto, a, b, snapshot, baseline, evidence, job, completed, asset, bytes, authority };
}


function observationInsert(db: D1Database, snapshot: Awaited<ReturnType<typeof fixture>>["snapshot"], padding = "", rowid?: number) {
  const data = canonicalJson({ repositoryId: snapshot.repository.id, rootDirectory: snapshot.rootDirectory, headCommitSha: snapshot.commitSha, observedAt: snapshot.fetchedAt, evidenceOrigin: "operator-import", padding });
  const fields = [config.ownerId, snapshot.repository.id, snapshot.rootDirectory, "000001767323045000000000", data];
  return db.prepare(`INSERT INTO source_head_observations(${rowid === undefined ? "" : "sequence,"}owner_id,repository_id,root_directory,observed_order,data,stored_bytes) VALUES(${rowid === undefined ? "" : "?,"}?,?,?,?,?,?)`).bind(...(rowid === undefined ? [] : [rowid]), ...fields, Buffer.byteLength(canonicalJson(fields)));
}
test("a charged insert has a constant row-read budget despite growing immutable history", async t => {
  const { db, snapshot } = await fixture(t, legacyMigrations);
  for (let start = 0; start < 1024; start += 32) await db.batch(Array.from({ length: 32 }, () => observationInsert(db, snapshot)));
  const legacy = await observationInsert(db, snapshot).run();
  assert.ok(legacy.meta.rows_read > 1024, "Control confirms the full-history read amplification");
  await migrate(db, accountingMigration);
  const measured = await observationInsert(db, snapshot).run();
  for (let start = 0; start < 1024; start += 32) await db.batch(Array.from({ length: 32 }, () => observationInsert(db, snapshot)));
  const grown = await observationInsert(db, snapshot).run();
  t.diagnostic(`Real D1 accounting reads: legacy ${legacy.meta.rows_read}; migrated ${measured.meta.rows_read}; double history ${grown.meta.rows_read}. Migrated writes: ${measured.meta.rows_written}`);
  assert.ok(measured.meta.rows_read <= 80, "Accounting must not rescan immutable history for every append; read " + measured.meta.rows_read + " rows");
  assert.equal(grown.meta.rows_read, measured.meta.rows_read, "Read cost is independent of accumulated history");
  assert.ok(measured.meta.rows_read * 10 < legacy.meta.rows_read, "At least 90% fewer reads in this measured workload");
  await assertAccounting(db);
  const maxPlan = (await db.prepare("EXPLAIN QUERY PLAN SELECT sequence FROM flora_capacity_facts WHERE table_name=? ORDER BY sequence DESC LIMIT 1").bind("source_head_observations").all<{ detail: string }>()).results;
  const rowPlan = (await db.prepare("EXPLAIN QUERY PLAN SELECT stored_bytes FROM flora_capacity_facts WHERE sequence=?").bind(1).all<{ detail: string }>()).results;
  assert.ok(rowPlan.some(row => /SEARCH .* USING INTEGER PRIMARY KEY \(rowid=\?\)/.test(row.detail)));
  assert.ok(maxPlan.some(row => /USING COVERING INDEX capacity_facts_table_sequence/.test(row.detail)));
  assert.ok(maxPlan.every(row => !row.detail.includes("USE TEMP B-TREE")));
});

test("migration preserves all 18 charged histories, counters, receipts and existing safety guards", async t => {
  const { db, store, ops, auto, a, b, snapshot, baseline, completed, asset, bytes } = await fixture(t, legacyMigrations);
  const before = await Promise.all(tables.map(table => rows(db, table))), beforeSchema = await schema(db);
  assert.ok(before.every(values => values.length > 0), "Each existing data table contains real fixture evidence");
  await migrate(db, accountingMigration);
  for (const [index, table] of tables.entries()) assert.deepEqual(await rows(db, table), before[index], table);
  const afterSchema = await schema(db);
  for (const previous of beforeSchema) {
    if (previous.name === "capacity_integrity" || previous.name.endsWith("_account")) continue;
    const actual = afterSchema.find(entry => entry.type === previous.type && entry.name === previous.name)!;
    assert.ok(actual, previous.name); assert.equal(normalize(actual.sql), normalize(previous.sql), previous.name);
  }
  assert.equal(beforeSchema.filter(entry => entry.type === "trigger" && /\bflora_capacity\b/.test(entry.sql)).length, 39);
  assert.equal(afterSchema.filter(entry => entry.type === "trigger" && /\bflora_capacity\b/.test(entry.sql)).length, 39);
  assert.equal(afterSchema.filter(entry => entry.type === "trigger" && /payload_bytes\+NEW\.stored_bytes<=268435456/.test(entry.sql)).length, 18);
  assert.equal(afterSchema.filter(entry => entry.type === "trigger" && entry.tbl_name === "flora_capacity_ledger").length, 4);
  await assertAccounting(db);
  assert.deepEqual(await ops.getOTADeploymentForRequest(a.id, completed.deployment.requestKey), completed.deployment);
  assert.deepEqual((await ops.getPublishedOTAAsset(a.id, asset.id))!.bytes, bytes);
  assert.deepEqual(await auto.getAutomationJob(a.id, completed.job.id), completed.job);
  assert.equal((await store.getInventory(snapshot.id))!.digest, snapshot.digest);
  assert.equal((await store.pageBaselines(snapshot.id, null, a.id)).items[0]!.id, baseline.id);
  assert.deepEqual((await store.applications!.getApplication(b.id))!.settings.values, { APP_LABEL: b.name });
  assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  await assert.rejects(migrate(db, accountingMigration), /already exists/);
  assert.deepEqual(await schema(db), afterSchema);
  for (const [index, table] of tables.entries()) assert.deepEqual(await rows(db, table), before[index], table);
});

test("sealed ledger rejects direct edits, missing witnesses, replay, replacement and fabricated capacity", async t => {
  const { db } = await fixture(t);
  const before = await Promise.all(tables.map(table => rows(db, table))), tracked = await ledger(db);
  for (const table of chargedTables) {
    for (const change of ["row_count=row_count+1", "payload_bytes=payload_bytes+1", "witness_bytes=witness_bytes+1", "last_sequence=last_sequence+1", "row_count=row_count+1,last_sequence=last_sequence+1,payload_bytes=payload_bytes+1", "row_count=row_count+2,last_sequence=last_sequence+1", "row_count=row_count-1", "last_sequence=last_sequence", "table_name='other'"]) {
      await assert.rejects(db.prepare(`UPDATE flora_capacity_ledger SET ${change} WHERE table_name=?`).bind(table).run(), /(?:invalid|immutable) capacity ledger/, table + " " + change);
    }
    await assert.rejects(db.prepare("DELETE FROM flora_capacity_ledger WHERE table_name=?").bind(table).run(), /immutable capacity ledger/);
    await assert.rejects(db.prepare("INSERT OR REPLACE INTO flora_capacity_ledger SELECT * FROM flora_capacity_ledger WHERE table_name=?").bind(table).run(), /immutable capacity ledger/);
    const columns = (await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results.map(column => column.name).join(",");
    await assert.rejects(db.prepare(`INSERT OR REPLACE INTO ${table}(${columns}) SELECT ${columns} FROM ${table}`).run(), /SQLITE_CONSTRAINT/);
    await assert.rejects(db.prepare(`UPDATE ${table} SET stored_bytes=stored_bytes`).run(), /immutable/);
    await assert.rejects(db.prepare(`DELETE FROM ${table}`).run(), /immutable/);
  }
  for (const update of ["payload_bytes=payload_bytes+1", "payload_bytes=payload_bytes-1", "snapshot_count=snapshot_count+1", "baseline_count=baseline_count+1"])
    await assert.rejects(db.prepare(`UPDATE flora_capacity SET ${update}`).run(), /invalid capacity accounting/);
  await assert.rejects(db.prepare("DELETE FROM flora_capacity").run(), /immutable capacity/);
  await assert.rejects(db.prepare("INSERT OR REPLACE INTO flora_capacity SELECT * FROM flora_capacity").run(), /immutable capacity/);
  for (const [index, table] of tables.entries()) assert.deepEqual(await rows(db, table), before[index], table);
  assert.deepEqual(await ledger(db), tracked); await assertAccounting(db);
});

test("hidden rowid collisions roll back while noncolliding rowid order cannot affect stable accounting", async t => {
  const { db, snapshot, store, b } = await fixture(t);
  await db.prepare("PRAGMA recursive_triggers=OFF").run();
  const before = await rows(db, "applications"), tracked = await ledger(db), counter = await rows(db, "flora_capacity");
  const columns = "owner_id,id,name,repository_id,root_directory,created_at,stored_bytes";
  const fields = [config.ownerId, "application_hidden_rowid", "Hidden", "hidden", ".", now];
  const bytes = Buffer.byteLength(canonicalJson(fields));
  const collision = (await db.prepare("SELECT min(rowid) id FROM applications").first<{ id: number }>())!.id;
  await assert.rejects(db.prepare(`INSERT OR REPLACE INTO applications(rowid,${columns}) VALUES(?,?,?,?,?,?,?,?)`).bind(collision, ...fields, bytes).run(), /immutable capacity source rowid/);
  assert.deepEqual(await rows(db, "applications"), before); assert.deepEqual(await ledger(db), tracked); assert.deepEqual(await rows(db, "flora_capacity"), counter);
  // Noncolliding source rowids may move backwards. The stable witness uses the
  // logical PK and its own declared INTEGER PRIMARY KEY sequence instead.
  await db.prepare(`INSERT INTO applications(rowid,${columns}) VALUES(?,?,?,?,?,?,?,?)`).bind(-10, ...fields, bytes).run();
  const protectedRows = await rows(db, "applications"), protectedFacts = await facts(db), protectedLedger = await ledger(db);
  const minusOne = [config.ownerId, "application_new_minus_one", "Minus", "new-minus-one", ".", now];
  await assert.rejects(db.prepare(`INSERT INTO applications(rowid,${columns}) VALUES(?,?,?,?,?,?,?,?)`).bind(-1, ...minusOne, Buffer.byteLength(canonicalJson(minusOne))).run(), /unsupported capacity source rowid/);
  assert.deepEqual(await rows(db, "applications"), protectedRows); assert.deepEqual(await facts(db), protectedFacts); assert.deepEqual(await ledger(db), protectedLedger);
  const headMax = (await db.prepare("SELECT max(rowid) id FROM source_head_observations").first<{ id: number }>())!.id;
  await observationInsert(db, snapshot, "monotonic gap", headMax + 10).run();
  await observationInsert(db, snapshot, "fill gap", headMax + 5).run();
  assert.equal((await store.applications!.getApplication(b.id))!.name, b.name);
  await assertAccounting(db);
});

test("migration and subsequent inserts are atomic under concurrent writers", async t => {
  const { db, snapshot } = await fixture(t, legacyMigrations);
  const initial = (await db.prepare("SELECT count(*) n FROM source_head_observations").first<{ n: number }>())!.n;
  const pending = [db.batch(Array.from({ length: 16 }, () => observationInsert(db, snapshot, "before"))), migrate(db, accountingMigration), db.batch(Array.from({ length: 16 }, () => observationInsert(db, snapshot, "after")))];
  await Promise.all(pending);
  assert.equal((await db.prepare("SELECT count(*) n FROM source_head_observations").first<{ n: number }>())!.n, initial + 32);
  await assertAccounting(db);
});

test("a failed final audit rolls back new ledger, all trigger changes and counters", async t => {
  const { db } = await fixture(t, legacyMigrations);
  const before = await Promise.all(tables.map(table => rows(db, table))), beforeSchema = await schema(db);
  await assert.rejects(db.batch([...(await statements(accountingMigration)).map(sql => db.prepare(sql)), db.prepare("UPDATE flora_capacity SET payload_bytes=payload_bytes+1")]), /invalid capacity accounting/);
  assert.deepEqual(await schema(db), beforeSchema);
  for (const [index, table] of tables.entries()) assert.deepEqual(await rows(db, table), before[index], table);
  assert.equal((await db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'flora_capacity_ledger%'").first<{ n: number }>())!.n, 0);
});

test("a failed migration leaves concurrent existing writes committed under the intact old guard", async t => {
  const { db, snapshot } = await fixture(t, legacyMigrations);
  const before = await rows(db, "source_head_observations"), oldSchema = await schema(db);
  const failure = db.batch([...(await statements(accountingMigration)).map(sql => db.prepare(sql)), db.prepare("UPDATE flora_capacity SET payload_bytes=payload_bytes+1")]);
  const write = db.batch(Array.from({ length: 16 }, () => observationInsert(db, snapshot, "concurrent rollback proof")));
  const results = await Promise.allSettled([failure, write]);
  assert.equal(results[0]!.status, "rejected"); assert.equal(results[1]!.status, "fulfilled");
  assert.deepEqual(await schema(db), oldSchema);
  const after = await rows(db, "source_head_observations"); assert.equal(after.length, before.length + 16); assert.deepEqual(after.slice(0, before.length), before);
  await db.prepare("UPDATE flora_capacity SET payload_bytes=payload_bytes").run();
});

test("migration fails closed on a mismatched legacy counter or missing 256 MiB prerequisite", async t => {
  const { db } = await fixture(t, legacyMigrations);
  const originalGuard = (await schema(db)).find(entry => entry.name === "capacity_integrity")!.sql;
  await db.prepare("DROP TRIGGER capacity_integrity").run();
  await db.prepare("UPDATE flora_capacity SET payload_bytes=payload_bytes-1").run();
  await db.prepare(originalGuard).run();
  const before = await Promise.all(tables.map(table => rows(db, table))), beforeSchema = await schema(db);
  await assert.rejects(migrate(db, accountingMigration), /invalid capacity accounting|CHECK constraint failed/);
  assert.deepEqual(await schema(db), beforeSchema);
  for (const [index, table] of tables.entries()) assert.deepEqual(await rows(db, table), before[index], table);
  const old = await fixture(t, ["0005_workspace_capacity_192mib.sql"]), oldSchema = await schema(old.db);
  await assert.rejects(migrate(old.db, accountingMigration), /CHECK constraint failed/);
  assert.deepEqual(await schema(old.db), oldSchema);
});

test("every charged table advances exactly once per new fact through real import, app and OTA flows", async t => {
  const { db, store, auto, ops, a, job, completed } = await fixture(t, legacyMigrations);
  const beforeRows = await Promise.all(chargedTables.map(table => rows(db, table)));
  await migrate(db, accountingMigration); const beforeLedger = await ledger(db);
  const nextSnapshot = await store.saveInventory(await parseSourceBundle(bundleBytes({ ...syntheticSourceBundle(), commitSha: "b".repeat(40) }), now + 1));
  const evidence = await parseBaselineBundle(bundleBytes(syntheticBaseline(nextSnapshot)), nextSnapshot);
  await store.persistBaseline({ snapshotId: nextSnapshot.id, evidence, assessment: assessReport(evidence, CONFIG_RUNTIME_SMOKE_V1), now: now + 1 });
  await observationInsert(db, nextSnapshot, "new evidence").run();
  const c = await store.applications!.registerApplication({ name: "Third", repositoryId: "github:third", rootDirectory: "." }, now + 1);
  await store.applications!.updateApplicationSettings(c.id, { expectedVersion: 0, values: { APP_LABEL: "Third" } }, now + 1);
  const connection = await ops.saveGitHubConnection(a.id, { expectedVersion: 1, installationId: 1, owner: "fixture", repository: "sample", ref: "main" }, now + 1);
  const detection = await ops.saveGitHubDetection({ ...job.detection, id: "github_next", connection, commitSha: "b".repeat(40), detectedAt: now + 1 });
  const runner = { id: "runner_next", name: "Next", appIds: [a.id], createdAt: now + 1, credentialEpoch: 1, revokedAt: null, tokenHash: "c".repeat(64) };
  await auto.registerRunner(runner); const authority = { runnerId: runner.id, credentialEpoch: 1, tokenHash: runner.tokenHash };
  await auto.updateAutomationPolicy(a.id, { expectedVersion: 1, enabled: true, channel: "verification", platforms: ["ios", "android"] }, now + 1);
  const nextJob: AutomationJob = { ...job, id: "job_next", requestKey: "queue-next", detectionId: detection.id, detection, connection, commitSha: detection.commitSha, createdAt: now + 1, updatedAt: now + 1 };
  await auto.enqueueAutomationJob(nextJob, 2);
  const claim = (await auto.claimAutomationJob(authority, now + 1, 5000))!;
  await auto.heartbeatAutomationJob(authority, claim.lease, now + 2, 5000);
  const bytes = new Uint8Array([5, 6, 7]), asset = await prepareOTAAsset(a.id, { key: "next_launch", contentType: "application/javascript", fileExtension: ".js" }, bytes, now + 2);
  const saved = await auto.saveAutomationAsset(authority, claim.lease, asset, bytes, now + 2);
  const receiptFields = { jobId: nextJob.id, attemptId: claim.lease.attemptId, commitSha: nextJob.commitSha, configDigest: nextJob.configDigest, toolchainDigest: nextJob.toolchainDigest, sourceArchiveDigest: "c".repeat(64), launchAssetId: saved.id, assetIds: [] as string[] };
  const { id, digest, hash, key, contentType, fileExtension, size } = saved;
  const receipt = { ...receiptFields, artifactDigest: await automationDigest({ receipt: receiptFields, assets: [{ id, digest, hash, key, contentType, fileExtension, size }] }) };
  const publication = await auto.finalizeAutomationJob(authority, claim.lease, { receipt, deployment: { id: crypto.randomUUID(), appId: a.id, requestKey: nextJob.id, detectionId: detection.id, commitSha: detection.commitSha, channel: nextJob.channel, runtimeVersion: nextJob.runtimeVersion, platform: nextJob.platform, launchAssetId: saved.id, assetIds: [], launchAsset: saved, assets: [], createdAt: now + 2 } }, now + 2);
  assert.equal(publication.job.state, "succeeded"); assert.deepEqual(await ops.getOTADeploymentForRequest(a.id, completed.deployment.requestKey), completed.deployment);
  const afterLedger = await ledger(db);
  for (const [index, table] of chargedTables.entries()) {
    assert.ok(afterLedger.find(row => row.table_name === table)!.row_count > beforeLedger.find(row => row.table_name === table)!.row_count, table + " advanced");
    assert.deepEqual((await rows(db, table)).slice(0, beforeRows[index]!.length), beforeRows[index], table + " prior facts preserved");
  }
  await assertAccounting(db); assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
});

test("incremental accounting retains the exact 256 MiB ceiling and atomically rejects a raced overflow", async t => {
  const { db, snapshot, ops, a, completed } = await fixture(t);
  const ceiling = 268435456;
  const observation = { repositoryId: snapshot.repository.id, rootDirectory: snapshot.rootDirectory, headCommitSha: snapshot.commitSha, observedAt: snapshot.fetchedAt, evidenceOrigin: "operator-import", padding: "" };
  const fields = [config.ownerId, snapshot.repository.id, snapshot.rootDirectory, "000001767323045000000000", canonicalJson(observation)], overhead = Buffer.byteLength(canonicalJson(fields));
  const sql = `INSERT INTO source_head_observations(owner_id,repository_id,root_directory,observed_order,data,stored_bytes)
    SELECT ?,?,?,?,json_set(?, '$.padding',replace(hex(zeroblob((?-?)/2)),'00','xx')||substr('x',1,(?-?)%2)),?`;
  const insertSize = (size: number) => db.prepare(sql).bind(...fields, size, overhead, size, overhead, size);
  await assert.rejects(insertSize(524289).run(), /CHECK constraint failed/);
  const count = Math.floor(ceiling / 524288) - 1;
  for (let index = 0; index < count; index += 8) await db.batch(Array.from({ length: Math.min(8, count - index) }, () => insertSize(524288)));
  const used = (await db.prepare("SELECT payload_bytes n FROM flora_capacity").first<{ n: number }>())!.n, remaining = ceiling - used;
  assert.ok(remaining > overhead && remaining < 524288);
  const results = await Promise.allSettled([insertSize(remaining).run(), insertSize(remaining).run()]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((await db.prepare("SELECT payload_bytes n FROM flora_capacity").first<{ n: number }>())!.n, ceiling);
  const fullLedger = await ledger(db);
  await assert.rejects(insertSize(overhead + 1).run(), /flora capacity exceeded/);
  await assert.rejects(db.prepare("UPDATE flora_capacity SET payload_bytes=payload_bytes-1").run(), /invalid capacity accounting/);
  assert.deepEqual(await ledger(db), fullLedger); await assertAccounting(db);
  assert.deepEqual(await ops.getOTADeploymentForRequest(a.id, completed.deployment.requestKey), completed.deployment);
});

test("per-app 64 MiB and 128-asset limits remain independent after the accounting migration", async t => {
  const { db, ops, a, b } = await fixture(t);
  const bytes = new Uint8Array(16 * 1024 * 1024);
  for (let index = 0; index < 4; index++) {
    bytes.fill(index + 16); const input = index === 3 ? bytes.subarray(3) : bytes;
    await ops.saveOTAAsset(await prepareOTAAsset(a.id, { key: "large_" + index, contentType: "application/javascript", fileExtension: ".js" }, input, now + 1), input);
  }
  assert.equal((await db.prepare("SELECT sum(byte_length) n FROM ota_assets WHERE app_id=?").bind(a.id).first<{ n: number }>())!.n, 67108864);
  const overflow = new Uint8Array([99]), extra = await prepareOTAAsset(a.id, { key: "overflow", contentType: "application/javascript", fileExtension: ".js" }, overflow, now + 2);
  const before = await ledger(db); await assert.rejects(ops.saveOTAAsset(extra, overflow), conflict); assert.deepEqual(await ledger(db), before);
  for (let index = 0; index < 128; index++) {
    const input = new Uint8Array([index]); await ops.saveOTAAsset(await prepareOTAAsset(b.id, { key: "small_" + index, contentType: "application/javascript", fileExtension: ".js" }, input, now + 1), input);
  }
  const another = new Uint8Array([1, 2]), metadata = await prepareOTAAsset(b.id, { key: "another", contentType: "application/javascript", fileExtension: ".js" }, another, now + 2);
  const full = await ledger(db); await assert.rejects(ops.saveOTAAsset(metadata, another), conflict); assert.deepEqual(await ledger(db), full);
  assert.equal((await db.prepare("SELECT count(*) n FROM ota_assets WHERE app_id=?").bind(b.id).first<{ n: number }>())!.n, 128);
  await assertAccounting(db);
});

test("snapshot, baseline and application row limits retain exact bounded counters", async t => {
  const { db, store, snapshot } = await fixture(t);
  for (let index = 0; index < 99; index++) await store.saveInventory(await parseSourceBundle(bundleBytes({ ...syntheticSourceBundle(), commitSha: (1000 + index).toString(16).padStart(40, "0") }), now + 1));
  const extraSnapshot = await parseSourceBundle(bundleBytes({ ...syntheticSourceBundle(), commitSha: "c".repeat(40) }), now + 2);
  await assert.rejects(store.saveInventory(extraSnapshot), conflict);
  for (let index = 0; index < 499; index++) {
    const evidence = await parseBaselineBundle(bundleBytes({ ...syntheticBaseline(snapshot), attemptKey: "count-limit-" + index }), snapshot);
    await store.persistBaseline({ snapshotId: snapshot.id, evidence, assessment: assessReport(evidence, CONFIG_RUNTIME_SMOKE_V1), now: now + 1 });
  }
  const extraBaseline = await parseBaselineBundle(bundleBytes({ ...syntheticBaseline(snapshot), attemptKey: "count-overflow" }), snapshot);
  await assert.rejects(store.persistBaseline({ snapshotId: snapshot.id, evidence: extraBaseline, assessment: assessReport(extraBaseline, CONFIG_RUNTIME_SMOKE_V1), now: now + 2 }), conflict);
  for (let index = 0; index < 98; index++) await store.applications!.registerApplication({ name: "Bounded " + index, repositoryId: "bounded-" + index, rootDirectory: "." }, now + 1);
  const full = await ledger(db); await assert.rejects(store.applications!.registerApplication({ name: "Overflow", repositoryId: "overflow", rootDirectory: "." }, now + 2), conflict);
  assert.deepEqual(await ledger(db), full);
  assert.equal((await db.prepare("SELECT snapshot_count n FROM flora_capacity").first<{ n: number }>())!.n, 100);
  assert.equal((await db.prepare("SELECT baseline_count n FROM flora_capacity").first<{ n: number }>())!.n, 500);
  assert.equal((await db.prepare("SELECT count(*) n FROM applications").first<{ n: number }>())!.n, 100);
  await assertAccounting(db);
});

test("migration preserves zero-charge legacy registry rows and negative existing rowids", async t => {
  const { db: seeded, snapshot } = await fixture(t, legacyMigrations);
  const inventory = (await seeded.prepare("SELECT * FROM inventory_snapshots").first<Record<string, string | number>>())!;
  const runtime = await createTestRuntime({ entrypoint: new URL("./fixtures/runtime-entry.ts", import.meta.url) }); t.after(() => runtime.dispose());
  const db = runtime.d1 as unknown as D1Database;
  await migrate(db, "0001_private_imports.sql");
  await db.prepare("INSERT INTO flora_deployment VALUES(1,?,?,?)").bind(config.ownerId, config.origin, config.dbIdentity).run();
  const columns = Object.keys(inventory);
  await db.prepare(`INSERT INTO inventory_snapshots(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).bind(...columns.map(column => inventory[column])).run();
  await observationInsert(db, snapshot, "negative legacy rowid", -10).run();
  for (const name of ["0002_multi_app.sql", "0003_github_ota.sql", "0004_automation.sql", ...legacyMigrations]) await migrate(db, name);
  const oldApp = (await db.prepare("SELECT id,stored_bytes FROM applications").first<{ id: string; stored_bytes: number }>())!;
  assert.equal(oldApp.stored_bytes, 0);
  const before = await Promise.all(tables.map(table => rows(db, table)));
  await migrate(db, accountingMigration);
  for (const [index, table] of tables.entries()) assert.deepEqual(await rows(db, table), before[index], table);
  const tracked = await ledger(db);
  assert.equal(tracked.find(row => row.table_name === "applications")!.row_count, 1);
  assert.equal(tracked.find(row => row.table_name === "applications")!.payload_bytes, 0);
  assert.ok(tracked.find(row => row.table_name === "source_head_observations")!.last_sequence! > 0);
  await observationInsert(db, snapshot, "first automatic positive rowid").run();
  const store = createD1ImportStore(db, config, () => {});
  await store.applications!.updateApplicationSettings(oldApp.id, { expectedVersion: 0, values: { LABEL: "Preserved" } }, now + 1);
  await assertAccounting(db);
});

test("stable witnesses reject fabricated, duplicate, noncanonical and replayed source credit", async t => {
  const { db } = await fixture(t);
  const tracked = await ledger(db), witness = await facts(db), counter = await rows(db, "flora_capacity");
  const insertFact = (table: string, key: string, bytes: number, sequence?: number) => db.prepare(`INSERT INTO flora_capacity_facts(${sequence === undefined ? "" : "sequence,"}table_name,record_key,stored_bytes,witness_bytes) VALUES(${sequence === undefined ? "" : "?,"}?,?,?,?)`).bind(...(sequence === undefined ? [] : [sequence]), table, key, bytes, Buffer.byteLength(JSON.stringify([table, key, bytes])));
  for (const row of witness) {
    await assert.rejects(insertFact(row.table_name, row.record_key, row.stored_bytes).run(), /immutable capacity fact/);
    await assert.rejects(insertFact(row.table_name, JSON.stringify(JSON.parse(row.record_key), null, 1), row.stored_bytes).run(), /invalid capacity fact/);
    await assert.rejects(insertFact(row.table_name, row.record_key, row.stored_bytes + 1).run(), /(?:immutable|invalid) capacity fact/);
  }
  const settings = witness.find(row => row.table_name === "application_settings" && JSON.parse(row.record_key)[2] === 1)!;
  const numericAlias = settings.record_key.slice(0, -2) + "1.0]";
  assert.equal(JSON.parse(numericAlias)[2], 1);
  await assert.rejects(insertFact(settings.table_name, numericAlias, settings.stored_bytes).run(), /invalid capacity fact/);
  await assert.rejects(insertFact("applications", '["owner","application_missing"]', 1).run(), /invalid capacity fact/);
  await assert.rejects(insertFact("unknown", "[]", 1).run(), /CHECK constraint failed/);
  await assert.rejects(db.prepare("UPDATE flora_capacity_facts SET stored_bytes=stored_bytes").run(), /immutable capacity fact/);
  await assert.rejects(db.prepare("DELETE FROM flora_capacity_facts").run(), /immutable capacity fact/);
  await assert.rejects(db.prepare("INSERT OR REPLACE INTO flora_capacity_facts SELECT * FROM flora_capacity_facts").run(), /immutable capacity fact/);
  await assert.rejects(db.prepare("UPDATE flora_capacity_ledger SET row_count=row_count+1,payload_bytes=payload_bytes+?,witness_bytes=witness_bytes+?,last_sequence=? WHERE table_name=?").bind(witness[0]!.stored_bytes, witness[0]!.witness_bytes, witness[0]!.sequence, witness[0]!.table_name).run(), /invalid capacity ledger/);
  assert.deepEqual(await ledger(db), tracked); assert.deepEqual(await facts(db), witness); assert.deepEqual(await rows(db, "flora_capacity"), counter);
  await assertAccounting(db);
});

test("stable source keys and explicit fact sequences survive source-rowid renumbering and real SQLite VACUUM", async t => {
  const { db, a } = await fixture(t);
  const fields = [config.ownerId, "application_before_vacuum", "Before", "before-vacuum", ".", now];
  await db.prepare("INSERT INTO applications(rowid,owner_id,id,name,repository_id,root_directory,created_at,stored_bytes) VALUES(-10,?,?,?,?,?,?,?)").bind(...fields, Buffer.byteLength(canonicalJson(fields))).run();
  const sourceIds = (await db.prepare("SELECT rowid,id FROM applications ORDER BY id").all()).results;
  const oldFacts = await facts(db), oldCounter = (await rows(db, "flora_capacity"))[0]!, oldSchema = await schema(db);
  const sql = new DatabaseSync(":memory:"); t.after(() => sql.close());
  // Rehydrate the actual D1 fixture without copying hidden source rowids. This
  // models a storage rebuild and deliberately changes applications' rowids,
  // while preserving each logical source column, fact sequence and counter.
  sql.exec("PRAGMA foreign_keys=OFF");
  for (const entry of oldSchema.filter(row => row.type === "table")) sql.exec(entry.sql);
  for (const table of [...tables, "flora_capacity_facts", "flora_capacity_ledger"]) {
    const columns = sql.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name));
    const insert = sql.prepare(`INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`);
    const values = table === "flora_capacity_facts" ? oldFacts : table === "flora_capacity_ledger" ? await ledger(db) : await rows(db, table);
    for (const value of values) {
      const record = value as Record<string, string | number | null>;
      insert.run(...columns.map(column => record[column]!));
    }
  }
  for (const entry of oldSchema.filter(row => row.type !== "table")) sql.exec(entry.sql);
  sql.exec("PRAGMA foreign_keys=ON");
  const rebuiltIds = sql.prepare("SELECT rowid,id FROM applications ORDER BY id").all();
  assert.notDeepEqual(JSON.parse(JSON.stringify(rebuiltIds)), sourceIds, "Physical source rowids actually changed");
  sql.exec("VACUUM");
  assert.deepEqual(JSON.parse(JSON.stringify(sql.prepare("SELECT * FROM flora_capacity_facts ORDER BY sequence").all())), oldFacts);
  sql.exec("UPDATE flora_capacity SET payload_bytes=payload_bytes");
  const next = [config.ownerId, "application_after_vacuum", "After", "after-vacuum", ".", now + 1], charge = Buffer.byteLength(canonicalJson(next));
  sql.prepare("INSERT INTO applications(owner_id,id,name,repository_id,root_directory,created_at,stored_bytes) VALUES(?,?,?,?,?,?,?)").run(...next, charge);
  const published = sql.prepare("SELECT * FROM flora_capacity_facts ORDER BY sequence").all();
  assert.deepEqual(JSON.parse(JSON.stringify(published.slice(0, oldFacts.length))), oldFacts);
  assert.equal(published.length, oldFacts.length + 1);
  assert.equal(published.at(-1)!.sequence, oldFacts.at(-1)!.sequence + 1);
  assert.equal(sql.prepare("SELECT payload_bytes n FROM flora_capacity").get()!.n, Number(oldCounter.payload_bytes) + charge);
  assert.equal(sql.prepare("SELECT name FROM applications WHERE id=?").get(a.id)!.name, a.name);
  assert.deepEqual(sql.prepare("PRAGMA foreign_key_check").all(), []);
});

test("an out-of-contract oversized legacy key aborts the migration without truncating existing data", async t => {
  const { db, a } = await fixture(t, legacyMigrations);
  const id = "runner_" + "x".repeat(16384), runner = { id, name: "Legacy", appIds: [a.id], createdAt: now, credentialEpoch: 1, revokedAt: null, tokenHash: "a".repeat(64) };
  const fields = [config.ownerId, id, 1, canonicalJson(runner)];
  // Old SQL has a bounded whole-row charge but no explicit ID-length CHECK;
  // normal API IDs are limited to96. Preserve such manual legacy rows on fail.
  await db.prepare("INSERT INTO automation_runners(owner_id,id,version,data,stored_bytes) VALUES(?,?,?,?,?)").bind(...fields, Buffer.byteLength(canonicalJson(fields))).run();
  const before = await Promise.all(tables.map(table => rows(db, table))), beforeSchema = await schema(db);
  await assert.rejects(migrate(db, accountingMigration), /CHECK constraint failed/);
  assert.deepEqual(await schema(db), beforeSchema);
  for (const [index, table] of tables.entries()) assert.deepEqual(await rows(db, table), before[index], table);
});

test("manual legacy rowid minus1 fails before schema changes and preserves existing facts", async t => {
  const { db } = await fixture(t, legacyMigrations);
  const fields = [config.ownerId, "application_manual_minus_one", "Manual", "manual-minus-one", ".", now];
  await db.prepare("INSERT INTO applications(rowid,owner_id,id,name,repository_id,root_directory,created_at,stored_bytes) VALUES(-1,?,?,?,?,?,?,?)").bind(...fields, Buffer.byteLength(canonicalJson(fields))).run();
  const before = await Promise.all(tables.map(table => rows(db, table))), beforeSchema = await schema(db);
  await assert.rejects(migrate(db, accountingMigration), /invalid capacity accounting/);
  assert.deepEqual(await schema(db), beforeSchema);
  for (const [index, table] of tables.entries()) assert.deepEqual(await rows(db, table), before[index], table);
  assert.equal((await db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'flora_capacity_facts%' OR name LIKE 'flora_capacity_ledger%'").first<{ n: number }>())!.n, 0);
});
