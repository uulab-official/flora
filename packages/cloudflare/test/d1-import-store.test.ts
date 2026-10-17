import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { canonicalJson } from "@app-ops/config";
import { assessReport, CONFIG_RUNTIME_SMOKE_V1, parseBaselineBundle, parseSourceBundle } from "@app-ops/dogfood";
import type { InventorySnapshot } from "@app-ops/dogfood";
import type { D1Database } from "@cloudflare/workers-types";
import { bundleBytes, syntheticBaseline, syntheticSourceBundle } from "../../../tests/dogfood-fixtures.ts";
import { createD1ImportStore, verifyD1Identity } from "../dist/d1-import-store.js";
import type { FloraConfig } from "../src/contracts.ts";
import { createTestRuntime } from "./runtime.ts";
import { observeD1Capacity } from "./d1-capacity-diagnostics.ts";

const config: FloraConfig = { ownerId: "owner-fixture", ownerEmail: "owner@example.invalid", origin: "https://flora.example.com", dbIdentity: "fixture-identity", setup: null };
const now = 1770000000000;
async function setup(t: test.TestContext, beforeCommit: () => void = () => {}, identity = config, seed = true, multiApp = true) {
  const runtime = await createTestRuntime({ entrypoint: new URL("./fixtures/runtime-entry.ts", import.meta.url) });
  t.after(() => runtime.dispose());
  const db = runtime.d1 as unknown as D1Database;
  const migration = await readFile(new URL("../migrations/0001_private_imports.sql", import.meta.url), "utf8");
  // D1 exec consumes one statement per line, including whole trigger bodies.
  await db.exec(migration.replace(/^--.*$/gm, "").split(/;\s*(?=CREATE|INSERT|PRAGMA|$)/).filter(s => s.trim()).map(s => s.replace(/\s*\n\s*/g, " ").trim() + ";").join("\n"));
  if (multiApp) {
    const multi = await readFile(new URL("../migrations/0002_multi_app.sql", import.meta.url), "utf8");
    await db.exec(multi.replace(/^--.*$/gm, "").split(/;\s*(?=CREATE|INSERT|DROP|PRAGMA|$)/).filter(s => s.trim()).map(s => s.replace(/\s*\n\s*/g, " ").trim() + ";").join("\n"));
  }
  if (seed) await db.prepare("INSERT INTO flora_deployment(singleton,owner_id,origin,db_identity) VALUES(1,?,?,?)")
    .bind(identity.ownerId, identity.origin, identity.dbIdentity).run();
  return { db, store: createD1ImportStore(db, identity, beforeCommit) };
}
async function snapshot(n = 0) {
  return parseSourceBundle(bundleBytes({ ...syntheticSourceBundle(), commitSha: n.toString(16).padStart(40, "a") }), now);
}
async function prepared(value: InventorySnapshot, key = "attempt", changed: Record<string, unknown> = {}) {
  const evidence = await parseBaselineBundle(bundleBytes({ ...syntheticBaseline(value), attemptKey: key, ...changed }), value);
  return { snapshotId: value.id, evidence, assessment: assessReport(evidence, CONFIG_RUNTIME_SMOKE_V1), now };
}
const code = (expected: string) => (error: unknown) => error instanceof Error && error.message === expected;
async function count(db: D1Database, table: string) { return (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n; }

// Replacing conditional insert/unique handling with a read-then-write loses this race.
test("source_duplicate_race_returns_one_id", async t => {
  const { db, store } = await setup(t);
  const a = await snapshot();
  const b = await parseSourceBundle(bundleBytes({ ...syntheticSourceBundle(), commitSha: a.commitSha, fetchedAt: "2026-02-02T03:04:05.000Z", files: syntheticSourceBundle().files.reverse() }), now + 1);
  assert.equal(a.digest, b.digest);
  const results = await Promise.all([store.saveInventory(a), store.saveInventory(b)]);
  assert.equal(results[0].id, results[1].id);
  assert.equal(await count(db, "inventory_snapshots"), 1);
  assert.deepEqual(results[0].files, a.files);
  assert.ok(Object.isFrozen(results[0].files));
  assert.equal((await db.prepare("SELECT snapshot_count FROM flora_capacity").first<{ snapshot_count: number }>())!.snapshot_count, 1);
});

test("baseline_key_changed_bytes_conflicts", async t => {
  const { db, store } = await setup(t);
  const value = await store.saveInventory(await snapshot());
  const input = await prepared(value);
  const [a, b] = await Promise.all([store.persistBaseline(input), store.persistBaseline(input)]);
  assert.equal(a.id, b.id);
  assert.equal(a.evidence!.evidenceDigest, input.evidence.evidenceDigest);
  await assert.rejects(store.persistBaseline(await prepared(value, "attempt", { log: "different bytes" })), code("IDEMPOTENCY_CONFLICT"));
  await assert.rejects(store.persistBaseline({ ...input, evidence: structuredClone(input.evidence) }), code("INVALID_INPUT"));
  await assert.rejects(store.persistBaseline({ ...input, assessment: { ...input.assessment, passed: 0 } }), code("INVALID_INPUT"));
  assert.equal(await count(db, "baseline_imports"), 1);
});

test("raw_sql_guards_reject_cross_app_or_mutation", async t => {
  const { db, store } = await setup(t);
  const value = await store.saveInventory(await snapshot());
  await store.persistBaseline(await prepared(value));
  await store.saveHeadObservation({ repositoryId: value.repository.id, rootDirectory: value.rootDirectory, headCommitSha: value.commitSha, observedAt: value.fetchedAt, evidenceOrigin: "operator-import" });
  for (const table of ["inventory_snapshots", "baseline_imports", "source_head_observations", "flora_deployment"]) {
    await assert.rejects(db.prepare(`UPDATE ${table} SET owner_id='other-owner'`).run());
    await assert.rejects(db.prepare(`DELETE FROM ${table}`).run());
  }
  await assert.rejects(db.prepare("UPDATE flora_capacity SET payload_bytes=0").run());
  const row = await db.prepare("SELECT * FROM inventory_snapshots").first<Record<string, unknown>>();
  const keys = Object.keys(row!);
  const changed = { ...JSON.parse(String(row!.data)), id: "inventory-other" };
  const wrong: Record<string, unknown> = { ...row!, owner_id: "other-owner", id: changed.id, data: canonicalJson(changed) };
  wrong.stored_bytes = Buffer.byteLength(canonicalJson([wrong.owner_id, wrong.id, wrong.digest, wrong.repository_id, wrong.root_directory, wrong.commit_sha, wrong.imported_at, wrong.data]));
  await assert.rejects(db.prepare(`INSERT INTO inventory_snapshots(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`).bind(...keys.map(k => wrong[k])).run(), /unknown app|FOREIGN KEY/);
  assert.equal(await count(db, "inventory_snapshots"), 1);
});

test("batch_failure_rolls_back", async t => {
  const { db, store } = await setup(t);
  const value = await store.saveInventory(await snapshot());
  const before = await db.prepare("SELECT * FROM flora_capacity").first();
  const observation = { repositoryId: value.repository.id, rootDirectory: value.rootDirectory, headCommitSha: value.commitSha, observedAt: value.fetchedAt, evidenceOrigin: "operator-import" };
  const fields = [config.ownerId, value.repository.id, value.rootDirectory, "0".repeat(24), canonicalJson(observation)];
  const insert = db.prepare("INSERT INTO source_head_observations(owner_id,repository_id,root_directory,observed_order,data,stored_bytes) VALUES(?,?,?,?,?,?)");
  await assert.rejects(db.batch([insert.bind(...fields, Buffer.byteLength(canonicalJson(fields))), insert.bind(...fields, 1)]));
  assert.equal(await count(db, "source_head_observations"), 0);
  assert.deepEqual(await db.prepare("SELECT * FROM flora_capacity").first(), before);
});

test("lost_response_retry_returns_receipt_at_capacity", async t => {
  const { db, store } = await setup(t);
  const first = await store.saveInventory(await snapshot());
  const input = await prepared(first);
  let lost = true;
  const lossy = new Proxy(db, { get(target, key) {
    if (key === "batch") return async (statements: Parameters<D1Database["batch"]>[0]) => {
      const result = await target.batch(statements);
      if (lost) { lost = false; throw new Error("synthetic lost response"); }
      return result;
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  await assert.rejects(createD1ImportStore(lossy, config, () => {}).persistBaseline(input), /synthetic lost response/);
  const receipt = await db.prepare("SELECT id FROM baseline_imports").first<{ id: string }>();
  for (let n = 1; n < 100; n++) await store.saveInventory(await snapshot(n));
  for (let n = 1; n < 500; n++) await store.persistBaseline(await prepared(first, "attempt-" + n));
  assert.equal((await store.saveInventory(first)).id, first.id);
  assert.equal((await store.persistBaseline(input)).id, receipt!.id);
  await assert.rejects(store.saveInventory(await snapshot(100)), code("CONFLICT"));
  await assert.rejects(store.persistBaseline(await prepared(first, "overflow")), code("CONFLICT"));
  assert.equal(await count(db, "inventory_snapshots"), 100);
  assert.equal(await count(db, "baseline_imports"), 500);
});

test("wrong_database_marker_fails_closed", async t => {
  const { db, store } = await setup(t);
  await verifyD1Identity(db, config);
  for (const change of [{ ownerId: "other" }, { origin: "https://other.example.com" }, { dbIdentity: "other" }]) {
    const wrong = { ...config, ...change };
    await assert.rejects(verifyD1Identity(db, wrong), code("CONFIG_CONFLICT"));
    await assert.rejects(createD1ImportStore(db, wrong, () => {}).pageInventory(null), code("CONFIG_CONFLICT"));
    await assert.rejects(createD1ImportStore(db, wrong, () => {}).saveInventory(await snapshot()), code("CONFIG_CONFLICT"));
  }
  assert.equal(await count(db, "inventory_snapshots"), 0);
  assert.deepEqual((await store.pageInventory(null)).items, []);
});

// Stored-byte overhead includes duplicate columns and JSON escaping, not just input length.
function inventoryBytes(value: InventorySnapshot) {
  return Buffer.byteLength(canonicalJson([config.ownerId, value.id, value.digest, value.repository.id, value.rootDirectory, value.commitSha, value.importedAt, canonicalJson(value)]));
}
function sizedSnapshot(value: InventorySnapshot, size: number) {
  const result = structuredClone(value);
  result.flavors[0]!.appName.value = "";
  result.flavors[0]!.appName.value = "x".repeat(size - inventoryBytes(result));
  assert.equal(inventoryBytes(result), size);
  return result;
}
test("stored_row_expansion_is_rejected", async t => {
  const { db, store } = await setup(t);
  const exact = sizedSnapshot(await snapshot(), 524288);
  assert.equal((await store.saveInventory(exact)).id, exact.id);
  await assert.rejects(store.saveInventory(sizedSnapshot(await snapshot(1), 524289)), code("INPUT_TOO_LARGE"));
  assert.equal(await count(db, "inventory_snapshots"), 1);
  const row = await db.prepare("SELECT stored_bytes FROM inventory_snapshots").first<{ stored_bytes: number }>();
  assert.equal(row!.stored_bytes, 524288);
});

test("keyset_ties_visit_every_row_once", async t => {
  const { store } = await setup(t);
  const snapshots = [];
  for (let n = 0; n < 41; n++) snapshots.push(await store.saveInventory(await snapshot(n)));
  const first = snapshots[0]!;
  const baselines = [];
  for (let n = 0; n < 41; n++) baselines.push(await store.persistBaseline(await prepared(first, "attempt-" + n)));
  for (const [all, page] of [
    [snapshots, (cursor: string | null) => store.pageInventory(cursor)],
    [baselines, (cursor: string | null) => store.pageBaselines(first.id, cursor)],
  ] as const) {
    let cursor: string | null = null; const ids: string[] = []; const sizes = [];
    do { const result: { items: { id: string }[]; nextCursor: string | null } = await page(cursor); sizes.push(result.items.length); ids.push(...result.items.map(v => v.id)); cursor = result.nextCursor; } while (cursor);
    assert.deepEqual(sizes, [20, 20, 1]);
    assert.deepEqual(ids, all.map(v => v.id).sort().reverse());
  }
  const inventoryCursor = (await store.pageInventory(null)).nextCursor!;
  const baselineCursor = (await store.pageBaselines(first.id, null)).nextCursor!;
  for (const invalid of ["!", "a".repeat(513), inventoryCursor + "=", Buffer.from('{}').toString("base64url"), baselineCursor]) {
    await assert.rejects(store.pageInventory(invalid), code("INVALID_INPUT"));
  }
  await assert.rejects(store.pageBaselines(snapshots[1]!.id, baselineCursor), code("INVALID_INPUT"));
  const forged = JSON.parse(Buffer.from(inventoryCursor, "base64url").toString());
  forged.owner = "other";
  await assert.rejects(store.pageInventory(Buffer.from(JSON.stringify(forged)).toString("base64url")), code("INVALID_INPUT"));
});

test("history_projection_never_selects_evidence_or_log", async t => {
  const { db, store } = await setup(t);
  const value = await store.saveInventory(await snapshot());
  const record = await store.persistBaseline(await prepared(value, "attempt", { log: "\x1b[31m" + "한".repeat(25000) }));
  const queries: string[] = [];
  const observed = new Proxy(db, { get(target, key) {
    if (key === "prepare") return (sql: string) => { queries.push(sql); return target.prepare(sql); };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const reader = createD1ImportStore(observed, config, () => {});
  const history = await reader.pageBaselines(value.id, null);
  await reader.pageInventory(null);
  for (const sql of queries.filter(q => /^SELECT.*FROM (?:baseline_imports|inventory_snapshots)/is.test(q))) {
    assert.doesNotMatch(sql.split(/\bFROM\b/i)[0]!, /\*|\bevidence\b|\bdata\b|\bsafe_log\b/i);
    assert.match(sql, /LIMIT 21/);
  }
  assert.equal(history.items[0]!.logTruncated, true);
  queries.length = 0;
  const log = await reader.getSafeLog(record.id);
  assert.equal(log!.safeLog, record.evidence!.safeLog);
  assert.ok(Buffer.byteLength(log!.safeLog) <= 65536);
  const logSql = queries.find(q => q.includes("FROM baseline_imports"))!;
  assert.match(logSql, /SELECT id,safe_log,log_truncated/);
  assert.doesNotMatch(logSql, /\bevidence\b|\bdata\b/);
});

test("before_commit_rechecks_after_async_reads_and_blocks_submission", async t => {
  let allowed = true; let calls = 0;
  const { db, store } = await setup(t, () => { calls++; if (!allowed) throw new Error("revoked"); });
  const value = await store.saveInventory(await snapshot());
  allowed = false;
  await assert.rejects(store.persistBaseline(await prepared(value)), /revoked/);
  await assert.rejects(store.saveHeadObservation({ repositoryId: value.repository.id, rootDirectory: value.rootDirectory, headCommitSha: value.commitSha, observedAt: value.fetchedAt, evidenceOrigin: "operator-import" }), /revoked/);
  assert.equal(await count(db, "baseline_imports"), 0);
  assert.equal(await count(db, "source_head_observations"), 0);
  assert.equal(calls, 3);
});

test("head_observations_keep_nanosecond_order_and_one_app_binding", async t => {
  const { store } = await setup(t);
  const value = await store.saveInventory(await snapshot());
  const observation = { repositoryId: value.repository.id, rootDirectory: value.rootDirectory, headCommitSha: value.commitSha, observedAt: "2026-02-02T00:00:00.000000002Z", evidenceOrigin: "operator-import" as const };
  await store.saveHeadObservation(observation);
  await store.saveHeadObservation({ ...observation, observedAt: "2026-02-02T00:00:00.000000001Z" });
  assert.deepEqual(await store.getHeadObservation(value), observation);
  await assert.rejects(store.saveHeadObservation({ ...observation, repositoryId: "other" }), code("CONFLICT"));
  await assert.rejects(store.saveHeadObservation({ ...observation, observedAt: "2026-02-30T00:00:00Z" }), code("INVALID_INPUT"));
});


test("sealed_config_identifiers_fit_marker_and_bounded_cursors", async t => {
  const identity = { ...config, ownerId: "a".repeat(256), dbIdentity: "b".repeat(256) };
  const { store } = await setup(t, () => {}, identity);
  for (let n = 0; n < 21; n++) await store.saveInventory(await snapshot(n));
  const first = await store.pageInventory(null);
  assert.ok(first.nextCursor && first.nextCursor.length <= 512);
  assert.equal((await store.pageInventory(first.nextCursor)).items.length, 1);
});

test("missing_database_marker_is_never_provisioned_by_a_request", async t => {
  const { db, store } = await setup(t, () => {}, config, false);
  await assert.rejects(store.saveInventory(await snapshot()), code("CONFIG_CONFLICT"));
  await assert.rejects(store.pageInventory(null), code("CONFIG_CONFLICT"));
  assert.equal(await count(db, "flora_deployment"), 0);
  assert.equal(await count(db, "inventory_snapshots"), 0);
});

test("baseline_prepared_assessment_is_revalidated_after_final_read", async t => {
  const { db, store } = await setup(t);
  const value = await store.saveInventory(await snapshot());
  const input = await prepared(value);
  const mutating = new Proxy(db, { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      const statement = target.prepare(sql);
      if (!sql.includes("FROM baseline_imports")) return statement;
      return new Proxy(statement, { get(stmt, property) {
        if (property === "bind") return (...values: unknown[]) => {
          const bound = stmt.bind(...values);
          return new Proxy(bound, { get(boundStmt, operation) {
            if (operation === "first") return async () => { const row = await boundStmt.first(); input.assessment.passed = 0; return row; };
            const member = Reflect.get(boundStmt, operation); return typeof member === "function" ? member.bind(boundStmt) : member;
          } });
        };
        const member = Reflect.get(stmt, property); return typeof member === "function" ? member.bind(stmt) : member;
      } });
    };
    const member = Reflect.get(target, key); return typeof member === "function" ? member.bind(target) : member;
  } });
  await assert.rejects(createD1ImportStore(mutating, config, () => {}).persistBaseline(input), code("INVALID_INPUT"));
  assert.equal(await count(db, "baseline_imports"), 0);
});

// Fill the real 128MiB budget in SQL using public synthetic padding, without 128MiB host buffers.
test("payload_capacity_is_atomic_and_sql_checks_actual_utf8_bytes", async t => {
  const { db, store } = await setup(t);
  const value = await store.saveInventory(await snapshot());
  const observation = { repositoryId: value.repository.id, rootDirectory: value.rootDirectory, headCommitSha: value.commitSha,
    observedAt: value.fetchedAt, evidenceOrigin: "operator-import", padding: "" };
  const order = "000001767323045000000000".padStart(24, "0");
  const base = canonicalJson(observation);
  const fields = [config.ownerId, value.repository.id, value.rootDirectory, order, base];
  const overhead = Buffer.byteLength(canonicalJson(fields));
  const sql = `INSERT INTO source_head_observations(owner_id,repository_id,root_directory,observed_order,data,stored_bytes)
    SELECT ?,?,?,?,json_set(?, '$.padding',replace(hex(zeroblob((?-?)/2)),'00','xx')||substr('x',1,(?-?)%2)),?`;
  const insertSize = (size: number) => db.prepare(sql).bind(...fields, size, overhead, size, overhead, size);
  await assert.rejects(insertSize(524289).run(), /CHECK constraint failed/);
  await assert.rejects(db.prepare("INSERT INTO source_head_observations(owner_id,repository_id,root_directory,observed_order,data,stored_bytes) VALUES(?,?,?,?,?,1)").bind(...fields).run(), /CHECK constraint failed/);
  const diagnostics = observeD1Capacity(message => t.diagnostic(message));
  try {
    for (let i = 0; i < 255; i += 3) {
      diagnostics.beginBatch(i / 3 + 1, i);
      try {
        const pending = db.batch([insertSize(524288), insertSize(524288), insertSize(524288)]);
        diagnostics.submitted();
        await pending;
      } catch (error) { diagnostics.rethrow(error); }
    }
  } finally { diagnostics.dispose(); }
  const used = (await db.prepare("SELECT payload_bytes FROM flora_capacity").first<{ payload_bytes: number }>())!.payload_bytes;
  const remaining = 134217728 - used;
  assert.ok(remaining > overhead && remaining < 524288);
  const race = await Promise.allSettled([insertSize(remaining).run(), insertSize(remaining).run()]);
  assert.equal(race.filter(r => r.status === "fulfilled").length, 1);
  assert.equal((await db.prepare("SELECT payload_bytes FROM flora_capacity").first<{ payload_bytes: number }>())!.payload_bytes, 134217728);
  assert.equal(await count(db, "source_head_observations"), 256);
  const app = (await store.applications!.getApplicationForSnapshot(value.id))!;
  await assert.rejects(store.applications!.registerApplication({ name: "Full", repositoryId: "full", rootDirectory: "." }, now), code("CONFLICT"));
  await assert.rejects(store.applications!.updateApplicationSettings(app.id, { expectedVersion: 0, values: {} }, now), code("CONFLICT"));
  assert.equal(await count(db, "applications"), 1);
  assert.equal(await count(db, "application_settings"), 1);
  await assert.rejects(store.saveInventory(await snapshot(1)), code("CONFLICT"));
  assert.equal((await store.saveInventory(value)).id, value.id);
});

test("raw_replace_cannot_bypass_immutable_history_or_deployment", async t => {
  const { db, store } = await setup(t);
  const value = await store.saveInventory(await snapshot());
  await store.persistBaseline(await prepared(value));
  await store.saveHeadObservation({ repositoryId: value.repository.id, rootDirectory: value.rootDirectory, headCommitSha: value.commitSha, observedAt: value.fetchedAt, evidenceOrigin: "operator-import" });
  for (const table of ["flora_deployment", "flora_capacity", "inventory_snapshots", "baseline_imports", "source_head_observations"]) {
    await assert.rejects(db.prepare(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`).run(), /immutable|replace|capacity/i, table);
  }
  assert.equal(await count(db, "inventory_snapshots"), 1);
});

test("multiple_apps_have_isolated_snapshots_settings_and_logs", async t => {
  const { db, store } = await setup(t);
  assert.ok(store.applications);
  const registry = store.applications!;
  const first = await store.saveInventory(await snapshot());
  const a = (await registry.getApplicationForSnapshot(first.id))!;
  const b = await registry.registerApplication({ name: "Second", repositoryId: "other", rootDirectory: first.rootDirectory }, now);
  assert.deepEqual((await store.pageInventory(null, b.id)).items, []);
  const second = await store.saveInventory(await parseSourceBundle(bundleBytes({ ...syntheticSourceBundle(), commitSha: first.commitSha,
    repository: { id: "other", fullName: "example/other", visibility: "private" } }), now));
  assert.notEqual(first.digest, second.digest);
  assert.equal((await registry.getApplicationForSnapshot(second.id))!.id, b.id);
  await assert.rejects(registry.registerApplication({ name: "Ignored", repositoryId: "other", rootDirectory: first.rootDirectory }, now + 1), code("CONFLICT"));
  assert.equal((await registry.getApplication(b.id))!.name, "Second");
  const updated = await registry.updateApplicationSettings(b.id, { expectedVersion: 0, values: { APP_NAME: "Second" } }, now + 1);
  assert.equal(updated.settings.version, 1);
  await assert.rejects(registry.updateApplicationSettings(b.id, { expectedVersion: 0, values: {} }, now + 2), code("CONFLICT"));
  assert.equal((await registry.getApplication(a.id))!.settings.version, 0);
  assert.equal(await count(db, "application_settings"), 3);
  const record = await store.persistBaseline(await prepared(first));
  assert.equal(await store.getSafeLog(record.id, b.id), null);
  await assert.rejects(store.pageBaselines(first.id, null, b.id), code("NOT_FOUND"));
  assert.deepEqual((await store.pageInventory(null, b.id)).items.map(v => v.id), [second.id]);
  assert.equal((await registry.listApplications()).length, 2);
  for (let n = 1; n < 21; n++) await store.saveInventory(await snapshot(n));
  const cursor = (await store.pageInventory(null, a.id)).nextCursor!;
  assert.ok(cursor);
  await assert.rejects(store.pageInventory(cursor, b.id), code("INVALID_INPUT"));
  await assert.rejects(store.pageInventory(cursor), code("INVALID_INPUT"));
});

test("additive_migration_preserves_legacy_rows_capacity_and_receipts", async t => {
  const { db, store } = await setup(t, () => {}, config, true, false);
  const value = await snapshot();
  const source = [config.ownerId, value.id, value.digest, value.repository.id, value.rootDirectory, value.commitSha, value.importedAt, canonicalJson(value)];
  await db.prepare("INSERT INTO inventory_snapshots(owner_id,id,digest,repository_id,root_directory,commit_sha,imported_at,data,stored_bytes) VALUES(?,?,?,?,?,?,?,?,?)")
    .bind(...source, Buffer.byteLength(canonicalJson(source))).run();
  const input = await prepared(value); const e = input.evidence; const a = input.assessment;
  const recordId = "verification_legacy";
  const record = [config.ownerId, recordId, value.id, e.sourceDigest, e.sourceDigest + ":" + e.attemptKey, now, a.status, a.code,
    e.platform, e.runtime.node, e.exitCode, e.evidenceDigest, e.logTruncated ? 1 : 0, canonicalJson(a), e.safeLog, canonicalJson(e)];
  await db.prepare(`INSERT INTO baseline_imports(owner_id,id,snapshot_id,source_digest,request_key,created_at,state,code,platform,node,exit_code,evidence_digest,log_truncated,assessment,safe_log,evidence,stored_bytes) VALUES(${Array(17).fill("?").join(",")})`)
    .bind(...record, Buffer.byteLength(canonicalJson(record))).run();
  const observation = { repositoryId: value.repository.id, rootDirectory: value.rootDirectory, headCommitSha: value.commitSha, observedAt: value.fetchedAt, evidenceOrigin: "operator-import" as const };
  await store.saveHeadObservation(observation);
  const tables = ["flora_deployment", "flora_capacity", "inventory_snapshots", "baseline_imports", "source_head_observations"];
  const before = await Promise.all(tables.map(table => db.prepare(`SELECT * FROM ${table}`).all()));
  const migration = await readFile(new URL("../migrations/0002_multi_app.sql", import.meta.url), "utf8");
  await db.exec(migration.replace(/^--.*$/gm, "").split(/;\s*(?=CREATE|INSERT|DROP|PRAGMA|$)/).filter(s => s.trim()).map(s => s.replace(/\s*\n\s*/g, " ").trim() + ";").join("\n"));
  for (let n = 0; n < tables.length; n++) assert.deepEqual((await db.prepare(`SELECT * FROM ${tables[n]}`).all()).results, before[n]!.results);
  assert.equal((await store.saveInventory(value)).id, value.id);
  assert.equal((await store.persistBaseline(input)).id, recordId);
  assert.deepEqual(await store.getInventory(value.id), value);
  assert.deepEqual(await store.getHeadObservation(value), observation);
  const app = (await store.applications!.getApplicationForSnapshot(value.id))!;
  assert.equal(app.id, "application_" + value.digest);
  assert.equal(app.settings.version, 0);
  const priorBytes = Number((before[1]!.results[0] as { payload_bytes: number }).payload_bytes);
  await store.applications!.updateApplicationSettings(app.id, { expectedVersion: 0, values: { APP_NAME: "Legacy" } }, now + 1);
  const bytes = await db.prepare("SELECT sum(stored_bytes) AS n FROM application_settings").first<{ n: number }>();
  assert.equal((await db.prepare("SELECT payload_bytes FROM flora_capacity").first<{ payload_bytes: number }>())!.payload_bytes, priorBytes + bytes!.n);
  for (const table of ["applications", "application_settings", ...tables]) {
    await assert.rejects(db.prepare(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`).run(), /immutable|capacity|version/i);
  }
});

test("application_settings_are_atomic_bounded_and_commit_fenced", async t => {
  let allowed = true;
  const { db, store } = await setup(t, () => { if (!allowed) throw new Error("revoked"); });
  const registry = store.applications!;
  const input = { name: "Empty", repositoryId: "empty", rootDirectory: "." };
  const race = await Promise.all([registry.registerApplication(input, now), registry.registerApplication(input, now)]);
  assert.equal(race[0].id, race[1].id);
  const appId = race[0].id;
  const updates = await Promise.allSettled([
    registry.updateApplicationSettings(appId, { expectedVersion: 0, values: { APP_NAME: "A" } }, now + 1),
    registry.updateApplicationSettings(appId, { expectedVersion: 0, values: { APP_NAME: "B" } }, now + 1),
  ]);
  assert.equal(updates.filter(v => v.status === "fulfilled").length, 1);
  assert.equal(await count(db, "application_settings"), 2);
  const before = await db.prepare("SELECT * FROM flora_capacity").first();
  allowed = false;
  await assert.rejects(registry.updateApplicationSettings(appId, { expectedVersion: 1, values: {} }, now + 2), /revoked/);
  await assert.rejects(registry.registerApplication({ ...input, repositoryId: "new" }, now), /revoked/);
  assert.deepEqual(await db.prepare("SELECT * FROM flora_capacity").first(), before);
  for (const table of ["applications", "application_settings"]) {
    await assert.rejects(db.prepare(`UPDATE ${table} SET owner_id='other'`).run(), /immutable/);
    await assert.rejects(db.prepare(`DELETE FROM ${table}`).run(), /immutable/);
  }
});

test("registry_limit_keeps_existing_registration_retryable", async t => {
  const { db, store } = await setup(t);
  const registry = store.applications!;
  const first = await registry.registerApplication({ name: "First", repositoryId: "r0", rootDirectory: "." }, now);
  for (let n = 1; n < 100; n++) await registry.registerApplication({ name: "App", repositoryId: "r" + n, rootDirectory: "." }, now);
  assert.equal((await registry.listApplications()).length, 100);
  const before = await db.prepare("SELECT * FROM flora_capacity").first();
  await assert.rejects(registry.registerApplication({ name: "Overflow", repositoryId: "r100", rootDirectory: "." }, now), code("CONFLICT"));
  assert.equal((await registry.registerApplication({ name: "First", repositoryId: "r0", rootDirectory: "." }, now)).id, first.id);
  assert.deepEqual(await db.prepare("SELECT * FROM flora_capacity").first(), before);
  assert.equal(await count(db, "application_settings"), 100);
});

test("first_source_sql_failure_rolls_back_registry_settings_and_capacity", async t => {
  let submissions = 0;
  const { db, store } = await setup(t, () => { submissions++; });
  const value = await snapshot();
  const before = await db.prepare("SELECT * FROM flora_capacity").first();
  // Invalid input never submits. A late SQL rejection, including a capacity or
  // constraint failure, must undo earlier registration statements in the batch.
  await assert.rejects(store.saveInventory({ ...value, connection: "one-shot-source-snapshot", evidenceOrigin: "operator-import", id: "" }));
  assert.equal(submissions, 0);
  await db.exec("CREATE TRIGGER synthetic_source_failure BEFORE INSERT ON inventory_snapshots BEGIN SELECT RAISE(ABORT,'synthetic source failure'); END;");
  await assert.rejects(store.saveInventory(value), /synthetic source failure/);
  assert.equal(submissions, 1);
  for (const table of ["applications", "application_settings", "inventory_snapshots"]) assert.equal(await count(db, table), 0);
  assert.deepEqual(await db.prepare("SELECT * FROM flora_capacity").first(), before);
});

test("settings_reject_backwards_timestamps_and_registration_name_conflicts", async t => {
  const { db, store } = await setup(t);
  const registry = store.applications!;
  const input = { name: "Named", repositoryId: "named", rootDirectory: "." };
  const app = await registry.registerApplication(input, now);
  const before = await db.prepare("SELECT * FROM flora_capacity").first();
  await assert.rejects(registry.registerApplication({ ...input, name: "Other" }, now), code("CONFLICT"));
  await assert.rejects(registry.updateApplicationSettings(app.id, { expectedVersion: 0, values: {} }, now - 1), code("INVALID_INPUT"));
  assert.deepEqual(await db.prepare("SELECT * FROM flora_capacity").first(), before);
  assert.equal((await registry.updateApplicationSettings(app.id, { expectedVersion: 0, values: {} }, now)).settings.version, 1);
});
