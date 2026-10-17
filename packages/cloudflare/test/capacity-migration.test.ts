import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { D1Database } from "@cloudflare/workers-types";
import { canonicalJson } from "@app-ops/config";
import { automationDigest, prepareOTAAsset, parseSourceBundle, parseBaselineBundle, assessReport, CONFIG_RUNTIME_SMOKE_V1 } from "@app-ops/dogfood";
import type { AutomationJob } from "@app-ops/dogfood";
import { bundleBytes, syntheticSourceBundle, syntheticBaseline } from "../../../tests/dogfood-fixtures.ts";
import { createD1ImportStore } from "../dist/d1-import-store.js";
import { createTestRuntime } from "./runtime.ts";

const now = 1770000000000;
const migrations = [
  { label: "192 MiB", ceiling: 201326592, previousCeiling: 134217728, migrationName: "0005_workspace_capacity_192mib.sql", baseMigrations: [] as string[] },
  { label: "256 MiB", ceiling: 268435456, previousCeiling: 201326592, migrationName: "0006_workspace_capacity_256mib.sql", baseMigrations: ["0005_workspace_capacity_192mib.sql"] },
];
const config = { ownerId: "owner", ownerEmail: "owner@example.invalid", origin: "https://flora.example.com", dbIdentity: "fixture", setup: null };
const chargedTables = ["inventory_snapshots", "baseline_imports", "source_head_observations", "applications", "application_settings", "github_connections", "github_detections", "ota_assets", "ota_asset_chunks", "ota_deployments", "ota_deployment_assets", "automation_runners", "automation_jobs", "automation_transitions", "automation_guards", "automation_asset_refs", "automation_policies", "automation_publications"];
const tables = ["flora_deployment", "flora_capacity", ...chargedTables];
const conflict = (error: unknown) => error instanceof Error && error.message === "CONFLICT";
async function statements(name: string) {
  const sql = await readFile(new URL("../migrations/" + name, import.meta.url), "utf8");
  return sql.replace(/^--.*$/gm, "").split(/;\s*(?=CREATE|INSERT|DROP|ALTER|UPDATE|SELECT|PRAGMA|$)/).filter(value => value.trim()).map(value => value.trim() + ";");
}
async function migrate(db: D1Database, name: string) {
  await db.batch((await statements(name)).map(sql => db.prepare(sql)));
}
async function rows(db: D1Database, table: string) { return (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results; }
async function schema(db: D1Database) {
  return (await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all<{ type: string; name: string; tbl_name: string; sql: string }>()).results;
}
const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
async function fixture(t: test.TestContext, baseMigrations: string[] = []) {
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

for (const { label, ceiling, previousCeiling, migrationName, baseMigrations } of migrations) {
test(`${label} capacity migration preserves every existing table, counter, receipt and guard`, async t => {
  const { db, store, ops, auto, a, b, snapshot, baseline, completed, asset, bytes } = await fixture(t, baseMigrations);
  const before = await Promise.all(tables.map(table => rows(db, table))), beforeSchema = await schema(db);
  assert.ok(before.every(values => values.length > 0), "Each counted table has actual existing evidence");
  await migrate(db, migrationName);
  for (const [index, table] of tables.entries()) assert.deepEqual(await rows(db, table), before[index], table);
  const afterSchema = await schema(db), newCapacity = afterSchema.find(entry => entry.name === "flora_capacity")!;
  assert.ok(normalize(newCapacity.sql).includes(`payload_bytes BETWEEN 0 AND ${ceiling}`));
  assert.equal(beforeSchema.filter(entry => entry.type === "trigger" && /\bflora_capacity\b/.test(entry.sql)).length, 39);
  assert.equal(afterSchema.filter(entry => entry.type === "trigger" && /\bflora_capacity\b/.test(entry.sql)).length, 39);
  assert.equal(afterSchema.filter(entry => entry.type === "trigger" && /payload_bytes\+NEW\.stored_bytes<=/.test(entry.sql)).length, 18);
  assert.equal(afterSchema.length, beforeSchema.length);
  for (const previous of beforeSchema.filter(entry => entry.name !== "flora_capacity")) {
    const actual = afterSchema.find(entry => entry.type === previous.type && entry.name === previous.name)!;
    assert.ok(actual, previous.name); assert.equal(normalize(actual.sql), normalize(previous.sql.replaceAll(String(previousCeiling), String(ceiling))), previous.name);
  }
  assert.deepEqual(await ops.getOTADeploymentForRequest(a.id, completed.deployment.requestKey), completed.deployment);
  assert.deepEqual((await ops.getPublishedOTAAsset(a.id, asset.id))!.bytes, bytes);
  assert.deepEqual(await auto.getAutomationJob(a.id, completed.job.id), completed.job);
  assert.equal((await store.getInventory(snapshot.id))!.digest, snapshot.digest);
  assert.equal((await store.pageBaselines(snapshot.id, null, a.id)).items[0]!.id, baseline.id);
  assert.deepEqual((await store.applications!.getApplication(b.id))!.settings.values, { APP_LABEL: b.name });
  assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  // A repeated SQL application also preserves the schema and rows. Wrangler
  // still records the version so normal operators apply this migration once.
  await migrate(db, migrationName);
  assert.deepEqual(await schema(db), afterSchema);
  for (const [index, table] of tables.entries()) assert.deepEqual(await rows(db, table), before[index], table);
});

test(`${label} capacity migration failure rolls back counter replacement and every trigger`, async t => {
  const { db } = await fixture(t, baseMigrations);
  const before = await Promise.all(tables.map(table => rows(db, table))), beforeSchema = await schema(db);
  const sql = await statements(migrationName);
  await assert.rejects(db.batch([...sql.map(value => db.prepare(value)), db.prepare("UPDATE flora_capacity SET payload_bytes=payload_bytes+1")]), /invalid capacity accounting/);
  assert.deepEqual(await schema(db), beforeSchema);
  for (const [index, table] of tables.entries()) assert.deepEqual(await rows(db, table), before[index], table);
});

test(`${label} migrated immutable accounting rejects REPLACE, deletion and fabricated counters`, async t => {
  const { db } = await fixture(t, baseMigrations); await migrate(db, migrationName);
  const before = await Promise.all(tables.map(table => rows(db, table)));
  for (const table of tables) {
    // table_info excludes the generated deployment_id column in transitions.
    const columns = (await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results.map(column => column.name).join(",");
    await assert.rejects(db.prepare(`INSERT OR REPLACE INTO ${table}(${columns}) SELECT ${columns} FROM ${table}`).run(), /SQLITE_CONSTRAINT/, table);
    await assert.rejects(db.prepare(`DELETE FROM ${table}`).run(), /immutable/, table);
  }
  await assert.rejects(db.prepare("UPDATE flora_capacity SET payload_bytes=payload_bytes-1").run(), /invalid capacity accounting/);
  await assert.rejects(db.prepare("UPDATE flora_capacity SET snapshot_count=snapshot_count-1").run(), /invalid capacity accounting/);
  for (const [index, table] of tables.entries()) assert.deepEqual(await rows(db, table), before[index], table);
});

test(`real ${label} ceiling admits one final raced insert and rejects new rows without losing receipts`, async t => {
  const { db, store, ops, auto, a, snapshot, baseline, completed, job } = await fixture(t, baseMigrations); await migrate(db, migrationName);
  const observation = { repositoryId: snapshot.repository.id, rootDirectory: snapshot.rootDirectory, headCommitSha: snapshot.commitSha, observedAt: snapshot.fetchedAt, evidenceOrigin: "operator-import", padding: "" };
  const fields = [config.ownerId, snapshot.repository.id, snapshot.rootDirectory, "000001767323045000000000".padStart(24, "0"), canonicalJson(observation)];
  const overhead = Buffer.byteLength(canonicalJson(fields));
  const sql = `INSERT INTO source_head_observations(owner_id,repository_id,root_directory,observed_order,data,stored_bytes)
    SELECT ?,?,?,?,json_set(?, '$.padding',replace(hex(zeroblob((?-?)/2)),'00','xx')||substr('x',1,(?-?)%2)),?`;
  const insertSize = (size: number) => db.prepare(sql).bind(...fields, size, overhead, size, overhead, size);
  await assert.rejects(insertSize(524289).run(), /CHECK constraint failed/);
  await assert.rejects(db.prepare("INSERT INTO source_head_observations(owner_id,repository_id,root_directory,observed_order,data,stored_bytes) VALUES(?,?,?,?,?,1)").bind(...fields).run(), /CHECK constraint failed/);
  assert.ok((await db.prepare("SELECT payload_bytes FROM flora_capacity").first<{ payload_bytes: number }>())!.payload_bytes < 524288);
  const fullRows = Math.floor(ceiling / 524288) - 1;
  for (let index = 0; index < fullRows; index += 3) await db.batch(Array.from({ length: Math.min(3, fullRows - index) }, () => insertSize(524288)));
  const used = (await db.prepare("SELECT payload_bytes FROM flora_capacity").first<{ payload_bytes: number }>())!.payload_bytes;
  assert.ok(used > previousCeiling, "Real charged rows now exceed the old ceiling");
  const remaining = ceiling - used; assert.ok(remaining > overhead && remaining < 524288);
  const race = await Promise.allSettled([insertSize(remaining).run(), insertSize(remaining).run()]);
  assert.equal(race.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((await db.prepare("SELECT payload_bytes FROM flora_capacity").first<{ payload_bytes: number }>())!.payload_bytes, ceiling);
  // Validate the same replacement at the full real payload size, rather than
  // only against a small seed. No padding is read back into host buffers.
  await migrate(db, migrationName);
  assert.equal((await db.prepare("SELECT payload_bytes FROM flora_capacity").first<{ payload_bytes: number }>())!.payload_bytes, ceiling);
  const counts = await Promise.all(tables.map(async table => (await db.prepare(`SELECT count(*) n FROM ${table}`).first<{ n: number }>())!.n));
  await assert.rejects(insertSize(overhead + 1).run(), /flora capacity exceeded/);
  await assert.rejects(store.applications!.registerApplication({ name: "Full", repositoryId: "full", rootDirectory: "." }, now + 1), conflict);
  await assert.rejects(store.applications!.updateApplicationSettings(a.id, { expectedVersion: 1, values: {} }, now + 1), conflict);
  await assert.rejects(ops.saveGitHubConnection(a.id, { expectedVersion: 1, installationId: 1, owner: "fixture", repository: "sample", ref: "next" }, now + 1), conflict);
  const assetBytes = new Uint8Array([44]), asset = await prepareOTAAsset(a.id, { key: "extra", contentType: "application/javascript", fileExtension: ".js" }, assetBytes, now + 1);
  await assert.rejects(ops.saveOTAAsset(asset, assetBytes), conflict);
  await assert.rejects(auto.registerRunner({ id: "runner_capacity", name: "Full", appIds: [a.id], createdAt: now + 1, credentialEpoch: 1, revokedAt: null, tokenHash: "c".repeat(64) }), conflict);
  await assert.rejects(auto.updateAutomationPolicy(a.id, { expectedVersion: 1, enabled: false, channel: "verification", platforms: ["ios", "android"] }, now + 1), conflict);
  await assert.rejects(auto.enqueueAutomationJob({ ...job, id: "job_capacity", requestKey: "queue-capacity", createdAt: now + 1, updatedAt: now + 1 }, 1), conflict);
  const extraEvidence = await parseBaselineBundle(bundleBytes({ ...syntheticBaseline(snapshot), attemptKey: "capacity-baseline" }), snapshot);
  await assert.rejects(store.persistBaseline({ snapshotId: snapshot.id, evidence: extraEvidence, assessment: assessReport(extraEvidence, CONFIG_RUNTIME_SMOKE_V1), now: now + 1 }), conflict);
  assert.deepEqual(await Promise.all(tables.map(async table => (await db.prepare(`SELECT count(*) n FROM ${table}`).first<{ n: number }>())!.n)), counts);
  assert.equal((await store.saveInventory(snapshot)).id, snapshot.id);
  assert.deepEqual(await ops.getOTADeploymentForRequest(a.id, completed.deployment.requestKey), completed.deployment);
  assert.deepEqual(await auto.getAutomationJob(a.id, completed.job.id), completed.job);
  assert.equal((await store.pageBaselines(snapshot.id, null, a.id)).items[0]!.id, baseline.id);
  assert.equal((await db.prepare("SELECT payload_bytes FROM flora_capacity").first<{ payload_bytes: number }>())!.payload_bytes, ceiling);
  t.diagnostic(`Preserved payload at the exact bounded ceiling: ${ceiling} bytes`);
});

test(`${label} workspace migration retains each app's 64 MiB and 128 asset caps`, async t => {
  const { db, ops, a, b } = await fixture(t, baseMigrations); await migrate(db, migrationName);
  // The fixture has a 3-byte asset: exactly 64 MiB must still be the app limit.
  const bytes = new Uint8Array(16 * 1024 * 1024);
  for (let index = 0; index < 4; index++) {
    bytes.fill(index + 16); const input = index === 3 ? bytes.subarray(3) : bytes;
    const asset = await prepareOTAAsset(a.id, { key: "large_" + index, contentType: "application/javascript", fileExtension: ".js" }, input, now + 1);
    await ops.saveOTAAsset(asset, input);
  }
  assert.equal((await db.prepare("SELECT sum(byte_length) n FROM ota_assets WHERE app_id=?").bind(a.id).first<{ n: number }>())!.n, 67108864);
  const overflow = new Uint8Array([99]), extra = await prepareOTAAsset(a.id, { key: "overflow", contentType: "application/javascript", fileExtension: ".js" }, overflow, now + 2);
  await assert.rejects(ops.saveOTAAsset(extra, overflow), conflict);
  for (let index = 0; index < 128; index++) {
    const input = new Uint8Array([index]), asset = await prepareOTAAsset(b.id, { key: "small_" + index, contentType: "application/javascript", fileExtension: ".js" }, input, now + 1);
    await ops.saveOTAAsset(asset, input);
  }
  const another = new Uint8Array([1, 2]), metadata = await prepareOTAAsset(b.id, { key: "another", contentType: "application/javascript", fileExtension: ".js" }, another, now + 2);
  await assert.rejects(ops.saveOTAAsset(metadata, another), conflict);
  assert.equal((await db.prepare("SELECT count(*) n FROM ota_assets WHERE app_id=?").bind(b.id).first<{ n: number }>())!.n, 128);
  assert.ok((await db.prepare("SELECT payload_bytes FROM flora_capacity").first<{ payload_bytes: number }>())!.payload_bytes < ceiling);
});

}
