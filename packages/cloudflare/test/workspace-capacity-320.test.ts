import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
const migration = "0009_workspace_capacity_320mib.sql";
const mib = 1024 * 1024, ceiling = 320 * mib, previousCeiling = 256 * mib;

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
const normalize = (sql: string) => sql.replaceAll('"', '').replace(/\s+/g, " ").trim();
async function fixture(t: test.TestContext, baseMigrations: string[] = ["0005_workspace_capacity_192mib.sql", "0006_workspace_capacity_256mib.sql", "0007_incremental_capacity_accounting.sql", "0008_hosted_app_asset_capacity_96mib.sql"]) {
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

const fingerprint = (entries: Awaited<ReturnType<typeof schema>>) => createHash("sha256").update(canonicalJson(entries.map(row => ({ ...row, sql: normalize(row.sql) })))).digest("hex");
function observationInsert(db: D1Database, snapshot: Awaited<ReturnType<typeof fixture>>["snapshot"], size?: number) {
  const data = canonicalJson({ repositoryId: snapshot.repository.id, rootDirectory: snapshot.rootDirectory, headCommitSha: snapshot.commitSha, observedAt: snapshot.fetchedAt, evidenceOrigin: "operator-import", padding: "" });
  const fields = [config.ownerId, snapshot.repository.id, snapshot.rootDirectory, "000001767323045000000000", data], overhead = Buffer.byteLength(canonicalJson(fields));
  const bytes = size ?? overhead;
  assert.ok(bytes >= overhead && bytes <= 1048576);
  return db.prepare(`INSERT INTO source_head_observations(owner_id,repository_id,root_directory,observed_order,data,stored_bytes)
    SELECT ?,?,?,?,json_set(?,'$.padding',replace(hex(zeroblob((?-?)/2)),'00','xx')||substr('x',1,(?-?)%2)),?`).bind(...fields,bytes,overhead,bytes,overhead,bytes);
}
function stagedAsset(db: D1Database, appId: string, sequence: number, size: number) {
  const hash = sequence.toString(16).padStart(64,"0"), contentType = "application/javascript", chunkCount = Math.ceil(size/524288);
  const data = canonicalJson({ id:"asset_"+hash, appId, digest:hash, hash, key:"capacity_"+sequence, contentType, fileExtension:".js", size, createdAt:now });
  const fields = [config.ownerId,appId,hash,size,contentType,chunkCount,data];
  return db.prepare("INSERT INTO ota_assets(owner_id,app_id,hash,byte_length,content_type,chunk_count,data,stored_bytes) VALUES(?,?,?,?,?,?,?,?)").bind(...fields,Buffer.byteLength(canonicalJson(fields)));
}
async function immutableSnapshot(db: D1Database, compactLargeFixture = false) {
  // The boundary fixture contains >300 MiB of real canonical JSON. Its schema is
  // already proved unchanged by the byte-exact small fixture; do not transfer
  // the entire large history through the D1/HTTP bridge just to count it.
  const records = await Promise.all(tables.map(table => compactLargeFixture && table === "source_head_observations"
    ? db.prepare("SELECT count(*) row_count,coalesce(sum(stored_bytes),0) payload_bytes,sum(length(CAST(data AS BLOB))) json_bytes,min(sequence) first_sequence,max(sequence) last_sequence FROM source_head_observations").all().then(result => result.results)
    : rows(db,table)));
  return { rows: records, facts: await facts(db), ledger: await ledger(db), sequence: (await db.prepare("SELECT * FROM sqlite_sequence ORDER BY name").all()).results };
}

test("320 MiB migration preserves every source/history/accounting row and the exact incremental guard schema", async t => {
  const { db, store, ops, auto, a, b, snapshot, baseline, completed, asset, bytes } = await fixture(t);
  const before = await immutableSnapshot(db), beforeSchema = await schema(db);
  assert.ok(before.rows.every(values => values.length > 0), "All eighteen charged source/history tables contain real records");
  await migrate(db,migration);
  assert.deepEqual(await immutableSnapshot(db),before);
  const afterSchema = await schema(db);
  assert.equal(afterSchema.length,beforeSchema.length); assert.ok(beforeSchema.length >= 206);
  assert.equal(afterSchema.filter(row => row.type === "trigger").length,176);
  assert.equal(afterSchema.filter(row => row.type === "trigger" && /\bflora_capacity(?:_ledger)?\b/.test(row.sql)).length,45);
  const changed = beforeSchema.filter(previous => normalize(previous.sql) !== normalize(afterSchema.find(row => row.name === previous.name && row.type === previous.type)!.sql));
  assert.equal(changed.length,20,"Only two accounting CHECK constraints and eighteen workspace admission guards change");
  for (const previous of beforeSchema) {
    const actual = afterSchema.find(row => row.name === previous.name && row.type === previous.type)!;
    assert.ok(actual,previous.name); assert.equal(actual.tbl_name,previous.tbl_name,previous.name);
    assert.equal(normalize(actual.sql),normalize(previous.sql.replaceAll(String(previousCeiling),String(ceiling))),previous.name);
  }
  assert.doesNotMatch(afterSchema.find(row => row.name === "capacity_integrity")!.sql,/FROM inventory_snapshots|sum\(stored_bytes\)/);
  assert.match(afterSchema.find(row => row.name === "ota_app_capacity")!.sql,/>100663296/);
  t.diagnostic(`Normalized effective schema SHA256 before ${fingerprint(beforeSchema)}; after ${fingerprint(afterSchema)}`);
  t.diagnostic(`Runtime-managed schema objects: ${beforeSchema.filter(row => row.name.startsWith("_cf_")).map(row => row.name).join(", ") || "none"}`);
  assert.deepEqual(await ops.getOTADeploymentForRequest(a.id,completed.deployment.requestKey),completed.deployment);
  assert.deepEqual((await ops.getPublishedOTAAsset(a.id,asset.id))!.bytes,bytes);
  assert.deepEqual(await auto.getAutomationJob(a.id,completed.job.id),completed.job);
  assert.equal((await store.pageBaselines(snapshot.id,null,a.id)).items[0]!.id,baseline.id);
  // Reporting keys/certificates live in the existing DO, not these D1 tables.
  // This migration never addresses that namespace; live key checks are separate.
  for (let start=0;start<1024;start+=32) await db.batch(Array.from({length:32},()=>observationInsert(db,snapshot)));
  const measured = await observationInsert(db,snapshot).run();
  for (let start=0;start<1024;start+=32) await db.batch(Array.from({length:32},()=>observationInsert(db,snapshot)));
  const grown = await observationInsert(db,snapshot).run();
  assert.ok(measured.meta.rows_read <= 80); assert.equal(grown.meta.rows_read,measured.meta.rows_read);
  t.diagnostic(`Actual workerd insert reads ${measured.meta.rows_read}; double history ${grown.meta.rows_read}`);
  const sealed = await immutableSnapshot(db);
  await assert.rejects(db.prepare("UPDATE flora_capacity SET payload_bytes=payload_bytes-1").run(),/invalid capacity accounting/);
  await assert.rejects(db.prepare("DELETE FROM flora_capacity").run(),/immutable capacity/);
  await assert.rejects(db.prepare("UPDATE flora_capacity_ledger SET payload_bytes=payload_bytes-1 WHERE table_name='source_head_observations'").run(),/invalid capacity ledger/);
  await assert.rejects(db.prepare("DELETE FROM flora_capacity_ledger").run(),/immutable capacity ledger/);
  await assert.rejects(db.prepare("UPDATE flora_capacity_facts SET stored_bytes=stored_bytes+1").run(),/immutable capacity fact/);
  await assert.rejects(db.prepare("DELETE FROM flora_capacity_facts").run(),/immutable capacity fact/);
  await assert.rejects(db.prepare("UPDATE ota_assets SET byte_length=1 WHERE app_id=?").bind(a.id).run(),/immutable operations/);
  await assert.rejects(db.prepare("DELETE FROM ota_deployments").run(),/immutable operations/);
  assert.deepEqual(await immutableSnapshot(db),sealed,"Every rejected mutation rolls back without changing accounting or history");
  // Metadata-only legitimate staging rows exercise app guards without creating
  // complete/public artifacts or allocating another 96 MiB of test assets.
  for(let i=0;i<6;i++) await stagedAsset(db,a.id,100+i,16*mib-(i===5?3:0)).run();
  assert.equal((await db.prepare("SELECT sum(byte_length) n FROM ota_assets WHERE app_id=?").bind(a.id).first<{n:number}>())!.n,96*mib);
  await assert.rejects(stagedAsset(db,a.id,200,1).run(),/flora capacity exceeded/);
  for(let i=0;i<128;i++) await stagedAsset(db,b.id,300+i,1).run();
  await assert.rejects(stagedAsset(db,b.id,500,1).run(),/flora capacity exceeded/);
  const third=await store.applications!.registerApplication({name:"Size guard",repositoryId:"github:fixture/size",rootDirectory:"."},now);
  await assert.rejects(stagedAsset(db,third.id,501,16*mib+1).run(),/CHECK constraint failed/);
  await assertAccounting(db); assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results,[]);
});

test("320 MiB workspace admits above the old ceiling, races safely at the new exact ceiling and preserves rejected state", async t => {
  const { db, snapshot } = await fixture(t);
  const fill = async (target: number) => {
    const used=(await db.prepare("SELECT payload_bytes n FROM flora_capacity").first<{n:number}>())!.n;
    const count=Math.floor((target-used)/524288);
    for(let start=0;start<count;start+=8) await db.batch(Array.from({length:Math.min(8,count-start)},()=>observationInsert(db,snapshot,524288)));
    const remaining=target-(await db.prepare("SELECT payload_bytes n FROM flora_capacity").first<{n:number}>())!.n;
    assert.ok(remaining>1000 && remaining<524288); return remaining;
  };
  const oldRemaining=await fill(previousCeiling); await observationInsert(db,snapshot,oldRemaining).run();
  await assert.rejects(observationInsert(db,snapshot).run(),/flora capacity exceeded/);
  const before=await immutableSnapshot(db,true); await migrate(db,migration); assert.deepEqual(await immutableSnapshot(db,true),before);
  await observationInsert(db,snapshot).run(); assert.ok((await db.prepare("SELECT payload_bytes n FROM flora_capacity").first<{n:number}>())!.n>previousCeiling);
  const remaining=await fill(ceiling);
  const race=await Promise.allSettled([observationInsert(db,snapshot,remaining).run(),observationInsert(db,snapshot,remaining).run()]);
  assert.equal(race.filter(row=>row.status==="fulfilled").length,1);
  assert.equal((await db.prepare("SELECT payload_bytes n FROM flora_capacity").first<{n:number}>())!.n,ceiling);
  assert.ok((await db.prepare("SELECT payload_bytes n FROM flora_capacity_ledger WHERE table_name='source_head_observations'").first<{n:number}>())!.n>previousCeiling,"Ledger itself must support the increased shared ceiling");
  const full=await immutableSnapshot(db,true); await assert.rejects(observationInsert(db,snapshot).run(),/flora capacity exceeded/); assert.deepEqual(await immutableSnapshot(db,true),full);
  await assertAccounting(db);
  t.diagnostic(`Exact charged payload ceiling ${ceiling} bytes; concurrent loser and overflow both preserve all history/facts/ledgers`);
});

test("320 MiB migration fails closed and rolls back for missing incremental accounting, hosted app guard or dependent trigger", async t => {
  for(const missing of ["accounting","hosted-app","dependency"] as const) {
    const base=["0005_workspace_capacity_192mib.sql","0006_workspace_capacity_256mib.sql",...(missing==="accounting"?[]:["0007_incremental_capacity_accounting.sql"]),...(missing==="accounting"||missing==="hosted-app"?[]:["0008_hosted_app_asset_capacity_96mib.sql"])];
    const {db}=await fixture(t,base);
    if(missing==="dependency") await db.prepare("DROP TRIGGER head_account").run();
    const beforeSchema=await schema(db), sourceBefore=await Promise.all(tables.map(table=>rows(db,table)));
    const accountingBefore=missing==="accounting"?null:{facts:await facts(db),ledger:await ledger(db)};
    await assert.rejects(migrate(db,migration),/no such table|CHECK constraint failed|no such trigger/);
    assert.deepEqual(await schema(db),beforeSchema,missing+" schema rollback");
    assert.deepEqual(await Promise.all(tables.map(table=>rows(db,table))),sourceBefore,missing+" source/history rollback");
    if(accountingBefore) assert.deepEqual({facts:await facts(db),ledger:await ledger(db)},accountingBefore,missing+" accounting rollback");
  }
});
