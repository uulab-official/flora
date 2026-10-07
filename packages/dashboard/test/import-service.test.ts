import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as dbapi from "@app-ops/db";
import { createDogfoodService } from "@app-ops/dashboard/service";
import { createImportService } from "@app-ops/dashboard/import-service";
import { assertParsedBaseline, assessReport, CONFIG_RUNTIME_SMOKE_V1, parseBaselineBundle } from "@app-ops/dogfood";
import type { PreparedBaselineImport } from "@app-ops/dogfood";
import { bundleBytes, syntheticBaseline, syntheticSourceBundle } from "../../../tests/dogfood-fixtures.ts";

test("portable_import_matches_local_receipt_and_frozen_evidence", async t => {
  const db = dbapi.openDatabase(":memory:"); dbapi.migrate(db);
  t.after(() => db.close());
  const store = dbapi.createSqliteDogfoodStore(db);
  let prepared: PreparedBaselineImport | undefined;
  const portable = createImportService({ ...store, async persistBaseline(input) {
    prepared = input;
    return store.persistBaseline(input);
  } }, () => 1234);
  const local = await createDogfoodService(store, [], () => 1234);
  t.after(() => local.close());
  const source = bundleBytes(syntheticSourceBundle());
  const snapshot = await portable.importSource(source);
  assert.deepEqual(await local.importSource(source), snapshot);
  const bytes = bundleBytes({ ...syntheticBaseline(snapshot), log: "synthetic\u001b[31m output\u0000\n" });
  const receipt = await portable.importBaseline(snapshot.id, bytes);
  assert.deepEqual(await local.importBaseline(snapshot.id, bytes), receipt);
  assert.ok(prepared);
  assertParsedBaseline(prepared.evidence, snapshot);
  assert.ok(Object.isFrozen(prepared.evidence));
  assert.ok(Object.isFrozen(prepared.evidence.runtime));
  assert.equal(prepared.evidence.evidenceDigest, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(prepared.assessment, assessReport(prepared.evidence, CONFIG_RUNTIME_SMOKE_V1));
  assert.equal(receipt.evidenceKind, "development-baseline");
  assert.equal(receipt.evidenceOrigin, "operator-import");
  assert.equal(receipt.evidence?.safeLog, "synthetic output\n");
  const observation = { repositoryId: snapshot.repository.id, rootDirectory: snapshot.rootDirectory,
    headCommitSha: snapshot.commitSha, observedAt: "2026-01-02T03:07:00.000Z", evidenceOrigin: "operator-import" as const };
  await portable.importHead(observation);
  assert.deepEqual(await store.getHeadObservation(snapshot), observation);
  assert.equal((await local.getState()).selectedSnapshotId, snapshot.id);
  await local.close();
  await assert.rejects(local.importSource(source), { code: "INVALID_TRANSITION" });
  await assert.rejects(local.importBaseline(snapshot.id, bytes), { code: "INVALID_TRANSITION" });
  await assert.rejects(local.importHead(observation), { code: "INVALID_TRANSITION" });
});

test("fabricated_or_cloned_evidence_is_rejected", async t => {
  const db = dbapi.openDatabase(":memory:"); dbapi.migrate(db);
  t.after(() => db.close());
  const store = dbapi.createSqliteDogfoodStore(db);
  const service = createImportService(store, () => 1234);
  const snapshot = await service.importSource(bundleBytes(syntheticSourceBundle()));
  const parsed = await parseBaselineBundle(bundleBytes(syntheticBaseline(snapshot)), snapshot);
  for (const evidence of [structuredClone(parsed), Object.freeze({ ...parsed })]) {
    await assert.rejects(store.persistBaseline({ snapshotId: snapshot.id, evidence,
      assessment: assessReport(evidence, CONFIG_RUNTIME_SMOKE_V1), now: 1234 }), { code: "INVALID_INPUT" });
    assert.deepEqual(await store.listVerifications(snapshot.id), []);
  }
});

test("portable_import_owns_baseline_bytes_before_storage_await", async t => {
  const db = dbapi.openDatabase(":memory:"); dbapi.migrate(db);
  t.after(() => db.close());
  const store = dbapi.createSqliteDogfoodStore(db);
  const snapshot = await store.saveInventory(await (await import("@app-ops/dogfood")).parseSourceBundle(bundleBytes(syntheticSourceBundle()), 1234));
  const bytes = bundleBytes(syntheticBaseline(snapshot));
  const expectedDigest = createHash("sha256").update(bytes).digest("hex");
  const service = createImportService({ ...store, async getInventory(id) {
    bytes.fill(0);
    return store.getInventory(id);
  } }, () => 1234);
  const receipt = await service.importBaseline(snapshot.id, bytes);
  assert.equal(receipt.evidence?.evidenceDigest, expectedDigest);
});
