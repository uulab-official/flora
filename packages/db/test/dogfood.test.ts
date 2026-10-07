import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import * as dbapi from "@app-ops/db";
import { parseSourceBundle, parseBaselineBundle, assessReport, CONFIG_RUNTIME_SMOKE_V1 as profile } from "@app-ops/dogfood";
import type { VerificationCompletion, VerificationRecord } from "@app-ops/dogfood";
import { bundleBytes, syntheticSourceBundle, syntheticBaseline, syntheticReport, withReport, DOGFOOD_IMPORTED_AT as now } from "../../../tests/dogfood-fixtures.ts";

async function setup(path = ":memory:") {
  const db = dbapi.openDatabase(path); dbapi.migrate(db);
  const port = dbapi.createSqliteDogfoodStore(db);
  const snapshot = await port.saveInventory(await parseSourceBundle(bundleBytes(syntheticSourceBundle()), now));
  return { db, port, snapshot };
}
const blocked: VerificationCompletion = { state: "blocked", code: "RUNNER_UNAVAILABLE", evidence: null, assessment: null };

test("dashboard owner blocks a live or reused PID without recovering active work", async () => {
  const { db, port, snapshot } = await setup();
  try {
    assert.equal(typeof dbapi.acquireDashboardOwner, "function");
    const owner = { nonce: randomUUID(), pid: process.pid, host: hostname() };
    dbapi.acquireDashboardOwner(db, owner);
    const created = await port.createVerification({ snapshotId: snapshot.id, requestKey: "owner-running", now });
    await port.beginVerification({ recordId: created.record.id, attemptId: "owner-attempt", runnerId: "runner", now, leaseMs: 30_000 });
    const before = await port.getVerification(created.record.id);
    const ownerBefore = db.prepare("SELECT * FROM dashboard_server_owner").get();
    for (const next of [{ ...owner, nonce: randomUUID() }, owner, { ...owner, host: "different-synthetic-host", nonce: randomUUID() }]) {
      assert.throws(() => dbapi.acquireDashboardOwner(db, next), { code: "STORE_IN_USE", message: "STORE_IN_USE" });
      assert.deepEqual(await port.getVerification(created.record.id), before);
      assert.deepEqual(db.prepare("SELECT * FROM dashboard_server_owner").get(), ownerBefore);
    }
    // Import and status-style adapter reads never acquire ownership or interrupt attempts.
    await dbapi.importBaseline(db, snapshot.id, bundleBytes(syntheticBaseline(snapshot)), now + 1);
    assert.deepEqual(await dbapi.createSqliteDogfoodStore(db).getVerification(created.record.id), before);
    assert.deepEqual(db.prepare("SELECT * FROM dashboard_server_owner").get(), ownerBefore);
    dbapi.releaseDashboardOwner(db, randomUUID());
    assert.deepEqual(db.prepare("SELECT * FROM dashboard_server_owner").get(), ownerBefore);
    dbapi.releaseDashboardOwner(db, owner.nonce);
    assert.equal(db.prepare("SELECT * FROM dashboard_server_owner").get(), undefined);
    dbapi.releaseDashboardOwner(db, owner.nonce);
  } finally { db.close(); }
});

test("dashboard ownership replacement requires ESRCH inside the same immediate transaction", async t => {
  const { db } = await setup();
  try {
    assert.equal(typeof dbapi.acquireDashboardOwner, "function");
    const original = { nonce: randomUUID(), pid: process.pid, host: hostname() };
    dbapi.acquireDashboardOwner(db, original);
    const originalRow = db.prepare("SELECT * FROM dashboard_server_owner").get();
    const candidate = { ...original, nonce: randomUUID() };
    for (const code of ["EPERM", "EACCES", "EINVAL", "UNKNOWN", undefined]) {
      const kill = t.mock.method(process, "kill", (pid: number, signal: string | number) => {
        assert.equal(pid, original.pid); assert.equal(signal, 0); assert.equal(db.isTransaction, true);
        throw Object.assign(new Error("synthetic-private-details"), { code });
      });
      assert.throws(() => dbapi.acquireDashboardOwner(db, candidate), { code: "STORE_IN_USE", message: "STORE_IN_USE" });
      assert.deepEqual(db.prepare("SELECT * FROM dashboard_server_owner").get(), originalRow);
      kill.mock.restore();
    }
    const kill = t.mock.method(process, "kill", (pid: number, signal: string | number) => {
      assert.equal(pid, original.pid); assert.equal(signal, 0); assert.equal(db.isTransaction, true);
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    assert.throws(() => dbapi.acquireDashboardOwner(db, { ...candidate, host: "other-host" }), { code: "STORE_IN_USE" });
    assert.equal(kill.mock.callCount(), 0);
    dbapi.acquireDashboardOwner(db, candidate);
    const replaced = db.prepare("SELECT * FROM dashboard_server_owner").get()!;
    assert.equal(replaced.nonce, candidate.nonce);
    dbapi.releaseDashboardOwner(db, original.nonce);
    assert.deepEqual(db.prepare("SELECT * FROM dashboard_server_owner").get(), replaced);
  } finally { db.close(); }
});

test("dashboard owner validates positive process IDs before signal zero", async t => {
  const { db } = await setup();
  try {
    assert.equal(typeof dbapi.acquireDashboardOwner, "function");
    const kill = t.mock.method(process, "kill", () => { throw new Error("must not probe invalid PID"); });
    for (const pid of [0, -1, 1.1, Number.NaN, 2 ** 31]) {
      assert.throws(() => dbapi.acquireDashboardOwner(db, { nonce: randomUUID(), pid, host: hostname() }), { code: "INVALID_INPUT" });
    }
    assert.equal(kill.mock.callCount(), 0);
    assert.equal(db.prepare("SELECT * FROM dashboard_server_owner").get(), undefined);
  } finally { db.close(); }
});

test("an exited child owner is replaceable exactly once across concurrent connections", { timeout: 30_000 }, async () => {
  assert.equal(typeof dbapi.acquireDashboardOwner, "function");
  const directory = mkdtempSync(join(tmpdir(), "dogfood-owner-race-")), path = join(directory, "state.db");
  const child = spawn(process.execPath, ["-e", "process.send('ready'); setInterval(() => {}, 1000);"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const ready = once(child, "message");
  const { db, port, snapshot } = await setup(path);
  try {
    await ready; assert.ok(child.pid);
    const original = { nonce: randomUUID(), pid: child.pid, host: hostname() };
    dbapi.acquireDashboardOwner(db, original);
    assert.throws(() => dbapi.acquireDashboardOwner(db, { ...original, nonce: randomUUID(), pid: process.pid }), { code: "STORE_IN_USE" });
    const created = await port.createVerification({ snapshotId: snapshot.id, requestKey: "dead-owner-running", now });
    const fence = await port.beginVerification({ recordId: created.record.id, attemptId: "dead-owner-attempt", runnerId: "runner", now, leaseMs: 30_000 });
    const exited = once(child, "exit"); child.kill(); await exited;
    assert.throws(() => process.kill(original.pid, 0), { code: "ESRCH" });
    const barrier = new SharedArrayBuffer(8), signal = new Int32Array(barrier);
    const code = `(async () => {
      const { parentPort, workerData } = require('node:worker_threads');
      const api = await import(workerData.module); const db = api.openDatabase(workerData.path);
      const signal = new Int32Array(workerData.barrier); Atomics.add(signal, 0, 1); Atomics.notify(signal, 0); Atomics.wait(signal, 1, 0, 10000);
      try { api.acquireDashboardOwner(db, workerData.owner); parentPort.postMessage({ nonce: workerData.owner.nonce }); }
      catch (error) { parentPort.postMessage({ error: error.code || 'UNKNOWN' }); } finally { db.close(); }
    })();`;
    const workers = [0, 1].map(() => new Worker(code, { eval: true, workerData: {
      module: new URL("../dist/index.js", import.meta.url).href, path, barrier, owner: { nonce: randomUUID(), pid: process.pid, host: hostname() },
    } }));
    try {
      const results = workers.map(worker => new Promise<{ nonce?: string; error?: string }>((resolve, reject) => {
        worker.once("message", resolve); worker.once("error", reject);
        worker.once("exit", code => { if (code !== 0) reject(new Error(`Worker exit ${code}`)); });
      }));
      const deadline = Date.now() + 10_000;
      while (Atomics.load(signal, 0) < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
      assert.equal(Atomics.load(signal, 0), 2); Atomics.store(signal, 1, 1); Atomics.notify(signal, 1, 2);
      const owners = await Promise.all(results);
      assert.equal(owners.filter(result => result.nonce).length, 1);
      assert.deepEqual(owners.filter(result => result.error).map(result => result.error), ["STORE_IN_USE"]);
      assert.equal((await port.getVerification(created.record.id))!.state, "running");
      assert.equal(dbapi.interruptVerifications(db, now + 1), 1);
      assert.equal((await port.getVerification(created.record.id))!.fence, fence.fence + 1);
      dbapi.releaseDashboardOwner(db, original.nonce);
      assert.equal(db.prepare("SELECT nonce FROM dashboard_server_owner").get()!.nonce, owners.find(result => result.nonce)!.nonce);
    } finally { await Promise.all(workers.map(worker => worker.terminate())); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
    db.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("inventory binds one app, is immutable, and preserves source/history across reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dogfood-")); const path = join(dir, "state.db");
  try {
    const { db, port, snapshot } = await setup(path);
    const same = await parseSourceBundle(bundleBytes(syntheticSourceBundle()), now + 1);
    assert.equal((await port.saveInventory(same)).id, snapshot.id);
    const other = await parseSourceBundle(bundleBytes({ ...syntheticSourceBundle(), commitSha: "b".repeat(40) }), now + 2);
    await port.saveInventory(other);
    for (const b of [ { ...syntheticSourceBundle(), rootDirectory: "apps/other" }, { ...syntheticSourceBundle(), repository: { ...syntheticSourceBundle().repository, id: "other_repo" } } ]) {
      await assert.rejects(port.saveInventory(await parseSourceBundle(bundleBytes(b), now)), { code: "CONFLICT" });
    }
    const observation = { repositoryId: snapshot.repository.id, rootDirectory: snapshot.rootDirectory, headCommitSha: other.commitSha, observedAt: "2026-01-02T04:00:00Z", evidenceOrigin: "operator-import" as const };
    await port.saveHeadObservation(observation);
    await port.saveHeadObservation({ ...observation, observedAt: "2026-01-02T03:30:00Z", headCommitSha: snapshot.commitSha });
    assert.deepEqual(await port.getHeadObservation(snapshot), observation);
    assert.throws(() => db.exec("UPDATE inventory_snapshots SET data='{}'"));
    assert.throws(() => db.exec("DELETE FROM inventory_snapshots"));
    assert.throws(() => db.exec("UPDATE source_head_observations SET data='{}'"));
    assert.throws(() => db.exec("DELETE FROM source_head_observations"));
    const record = await dbapi.importBaseline(db, snapshot.id, bundleBytes(syntheticBaseline(snapshot)), now);
    const failBundle = { ...syntheticBaseline(snapshot), attemptKey: "second", exitCode: 1 };
    const fail = await dbapi.importBaseline(db, snapshot.id, bundleBytes(failBundle), now + 1);
    assert.notEqual(fail.state, "passed");
    db.close();
    const reopened = dbapi.openDatabase(path); dbapi.migrate(reopened); const second = dbapi.createSqliteDogfoodStore(reopened);
    assert.equal((await second.listInventory()).length, 2);
    assert.equal((await second.listVerifications(snapshot.id)).length, 2);
    assert.deepEqual(await second.getVerification(record.id), record);
    assert.equal((reopened.prepare("SELECT count(*) n FROM releases").get() as {n:number}).n, 0);
    assert.equal((reopened.prepare("SELECT count(*) n FROM jobs").get() as {n:number}).n, 0);
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("baseline persists valid failed/invalid reports and rejects envelopes without writes", async () => {
  const { db, port, snapshot: s } = await setup();
  try {
    const b = syntheticBaseline(s); const bytes = bundleBytes(b);
    const first = await dbapi.importBaseline(db, s.id, bytes, now);
    assert.equal(first.state, "passed"); assert.equal(first.evidenceKind, "development-baseline"); assert.equal(first.evidenceOrigin, "operator-import");
    assert.deepEqual(await dbapi.importBaseline(db, s.id, bytes, now + 1), first);
    for (const changed of [{ ...b, log: b.log + "extra" }, { ...b, log: "\u001b[0m" + b.log }]) await assert.rejects(dbapi.importBaseline(db, s.id, bundleBytes(changed), now), { code: "IDEMPOTENCY_CONFLICT" });
    await assert.rejects(dbapi.importBaseline(db, s.id, bundleBytes({ ...b, sourceHashesAfter: {} }), now), { code: "INVALID_INPUT" });
    assert.equal((await port.listVerifications(s.id)).length, 1);
    const invalid = await dbapi.importBaseline(db, s.id, bundleBytes(withReport({ ...b, attemptKey: "invalid" }, {})), now + 1);
    assert.equal(invalid.state, "invalid");
    const r = syntheticReport(); r.testResults[0]!.assertionResults[0]!.status = "failed"; r.testResults[0]!.status = "failed";
    Object.assign(r, { success: false, numPassedTests: 3, numFailedTests: 1, numPassedTestSuites: 3, numFailedTestSuites: 1 });
    assert.equal((await dbapi.importBaseline(db, s.id, bundleBytes(withReport({ ...b, attemptKey: "failed", exitCode: 1 }, r)), now)).state, "failed");
    const e = await parseBaselineBundle(bytes, s); const a = assessReport(e, profile);
    await assert.rejects(port.persistBaseline({ snapshotId: s.id, evidence: { ...e, sourceDigest: "b".repeat(64) }, assessment: a, now }), { code: "INVALID_INPUT" });
    await assert.rejects(port.persistBaseline({ snapshotId: s.id, evidence: e, assessment: { ...a, tests: 99 }, now }), { code: "INVALID_INPUT" });
  } finally { db.close(); }
});

test("atomic receipts isolate request namespaces and resolve concurrent duplicate requests", async () => {
  const { db, port, snapshot: s } = await setup();
  try {
    const b = syntheticBaseline(s); const imported = await dbapi.importBaseline(db, s.id, bundleBytes(b), now);
    const key = `${s.digest}:${b.attemptKey}`;
    const receipts = await Promise.all(Array.from({ length: 10 }, () => port.createVerification({ snapshotId: s.id, requestKey: key, now })));
    assert.equal(receipts.filter(r => r.created).length, 1);
    assert.equal(new Set(receipts.map(r => r.record.id)).size, 1);
    const run = receipts[0]!.record; assert.notEqual(run.id, imported.id);
    assert.equal(run.state, "queued"); assert.equal(run.evidence, null); assert.equal(run.evidenceOrigin, "flora-request");
    const other = await port.saveInventory(await parseSourceBundle(bundleBytes({ ...syntheticSourceBundle(), commitSha: "b".repeat(40) }), now));
    await assert.rejects(port.createVerification({ snapshotId: other.id, requestKey: key, now }), { code: "IDEMPOTENCY_CONFLICT" });
    assert.notEqual((await port.createVerification({ snapshotId: s.id, requestKey: "rerun", now })).record.id, run.id);
    assert.equal((await port.getVerification(run.id))!.state, "queued");
  } finally { db.close(); }
});

test("fences interrupted and duplicate attempts at exact lease boundaries", async () => {
  const { db, port, snapshot: s } = await setup();
  try {
    async function run(key: string, at = 0) {
      const { record } = await port.createVerification({ snapshotId: s.id, requestKey: key, now: at });
      const fence = await port.beginVerification({ recordId: record.id, attemptId: `attempt-${key}`, runnerId: "synthetic-runner", now: at, leaseMs: 30_000 });
      return { record, fence };
    }
    const { record, fence } = await run("one");
    assert.equal((await port.getVerification(record.id))!.evidenceOrigin, "flora-execution");
    await assert.rejects(port.beginVerification({ recordId: record.id, attemptId: "again", runnerId: "synthetic-runner", now: 1, leaseMs: 30_000 }), { code: "INVALID_TRANSITION" });
    await assert.rejects(port.blockVerification(record.id, "NO", 1), { code: "INVALID_TRANSITION" });
    for (const bad of [{ ...fence, runnerId: "other" }, { ...fence, attemptId: "other" }, { ...fence, fence: 2 }, { ...fence, expiresAt: 31_000 }]) await assert.rejects(port.finishVerification(bad, blocked, 1), { code: "LEASE_STALE" });
    const passedEvidence = await parseBaselineBundle(bundleBytes({ ...syntheticBaseline(s), attemptKey: fence.attemptId }), s);
    const passedCompletion: VerificationCompletion = { state: "passed", code: "PASSED", evidence: passedEvidence, assessment: assessReport(passedEvidence, profile) };
    assert.equal((await port.finishVerification(fence, passedCompletion, 29_999)).state, "passed");
    await assert.rejects(port.finishVerification(fence, blocked, 29_999), { code: "LEASE_STALE" });
    const timeout = await run("timeout");
    const lateEvidence = await parseBaselineBundle(bundleBytes({ ...syntheticBaseline(s), attemptKey: timeout.fence.attemptId }), s);
    const lateCompletion: VerificationCompletion = { state: "passed", code: "PASSED", evidence: lateEvidence, assessment: assessReport(lateEvidence, profile) };
    await assert.rejects(port.finishVerification(timeout.fence, lateCompletion, 30_000), { code: "LEASE_STALE" });
    await assert.rejects(port.expireVerification(timeout.fence, 29_999), { code: "LEASE_STALE" });
    const expired = await port.expireVerification(timeout.fence, 30_000);
    assert.equal(expired.state, "timing_out"); assert.equal(expired.fence, timeout.fence.fence + 1);
    await assert.rejects(port.finishVerification(timeout.fence, lateCompletion, 35_000), { code: "LEASE_STALE" });
    const final = await port.finishTimeout(timeout.record.id, false, 35_000);
    assert.equal(final.state, "failed"); assert.equal(final.code, "TIMEOUT"); assert.equal(final.cleanupCode, "CLEANUP_UNCONFIRMED");
    const cancel = await run("cancel"); const cancelling = await port.requestCancellation(cancel.record.id, 1);
    assert.equal(cancelling.state, "cancelling"); assert.equal(cancelling.fence, 2);
    await assert.rejects(port.finishVerification(cancel.fence, blocked, 2), { code: "LEASE_STALE" });
    const cancelled = await port.finishCancellation(cancel.record.id, true, 5001);
    assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.cleanupCode, null);
    await assert.rejects(port.finishCancellation(cancel.record.id, false, 5002), { code: "INVALID_TRANSITION" });
    const cancel2 = await run("cancel2"); await port.requestCancellation(cancel2.record.id, 1);
    assert.equal((await port.finishCancellation(cancel2.record.id, false, 5001)).cleanupCode, "CLEANUP_UNCONFIRMED");
    const queued = (await port.createVerification({ snapshotId: s.id, requestKey: "queued", now: 1 })).record;
    await port.requestCancellation(queued.id, 2);
    assert.equal((await port.finishCancellation(queued.id, false, 3)).cleanupCode, null);
    const q = (await port.createVerification({ snapshotId: s.id, requestKey: "blocked", now: 1 })).record;
    assert.equal((await port.blockVerification(q.id, "RUNNER_UNAVAILABLE", 2)).state, "blocked");
    for (const leaseMs of [4999, 120001]) await assert.rejects(port.beginVerification({ recordId: q.id, attemptId: "bad", runnerId: "runner", now: 1, leaseMs }), { code: "INVALID_INPUT" });
  } finally { db.close(); }
});

test("recovery preserves terminal history and never reruns interrupted work", async () => {
  const { db, port, snapshot: s } = await setup();
  try {
    const records: VerificationRecord[] = [];
    for (const key of ["queued", "running", "expired", "cancelling", "timing_out"]) {
      const { record } = await port.createVerification({ snapshotId: s.id, requestKey: key, now: 0 }); records.push(record);
      if (key === "queued") continue;
      const f = await port.beginVerification({ recordId: record.id, attemptId: `attempt-${key}`, runnerId: "runner", now: key === "running" ? 10_000 : 0, leaseMs: 30_000 });
      if (key === "cancelling") await port.requestCancellation(record.id, 1);
      if (key === "timing_out") await port.expireVerification(f, 30_000);
    }
    // Constructing the adapter and reading state never performs recovery.
    assert.equal((await dbapi.createSqliteDogfoodStore(db).getVerification(records[0]!.id))!.state, "queued");
    assert.equal(dbapi.interruptVerifications(db, 30_000), 5);
    for (const [i, key] of ["queued", "running", "expired", "cancelling", "timing_out"].entries()) {
      const r: VerificationRecord = (await port.getVerification(records[i]!.id))!;
      assert.equal(r.state, ["expired", "timing_out"].includes(key) ? "failed" : "interrupted");
      assert.equal(r.code, ["expired", "timing_out"].includes(key) ? "TIMEOUT" : "INTERRUPTED");
      assert.equal(r.cleanupCode, key === "queued" ? null : "CLEANUP_UNCONFIRMED");
    }
    assert.equal(dbapi.interruptVerifications(db, 35_000), 0);
    for (const table of ["verification_records", "verification_attempts"]) {
      assert.throws(() => db.exec(`UPDATE ${table} SET state='running'`));
      assert.throws(() => db.exec(`DELETE FROM ${table}`));
      assert.throws(() => db.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`));
    }
    assert.throws(() => db.exec("INSERT OR REPLACE INTO inventory_snapshots SELECT * FROM inventory_snapshots"));
  } finally { db.close(); }
});

test("completion requires source/profile/attempt-bound evidence and recomputed assessment", async () => {
  const { db, port, snapshot: s } = await setup();
  try {
    const { record } = await port.createVerification({ snapshotId: s.id, requestKey: "complete", now });
    const fence = await port.beginVerification({ recordId: record.id, attemptId: "exact-attempt", runnerId: "runner", now, leaseMs: 30_000 });
    await assert.rejects(port.finishVerification(fence, { ...blocked, state: "passed", code: "PASSED" }, now), { code: "INVALID_INPUT" });
    const evidence = await parseBaselineBundle(bundleBytes({ ...syntheticBaseline(s), attemptKey: fence.attemptId }), s);
    const assessment = assessReport(evidence, profile);
    const completion: VerificationCompletion = { state: assessment.status, code: assessment.code, evidence, assessment };
    await assert.rejects(port.finishVerification(fence, { ...completion, evidence: { ...evidence, attemptKey: "other" } }, now), { code: "INVALID_INPUT" });
    assert.equal((await port.finishVerification(fence, completion, now + 1)).state, "passed");
  } finally { db.close(); }
});

test("async import never hashes inside an open database transaction", async t => {
  const { db, snapshot: s } = await setup();
  try {
    const original = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    let calls = 0;
    t.mock.method(globalThis.crypto.subtle, "digest", async (...args: Parameters<typeof original>) => {
      assert.equal(db.isTransaction, false); calls++;
      await Promise.resolve();
      return original(...args);
    });
    await dbapi.importBaseline(db, s.id, bundleBytes(syntheticBaseline(s)), now);
    assert.equal(calls, 2); assert.equal(db.isTransaction, false);
  } finally { db.close(); }
});

test("SQLite constraints retain foreign keys and immutable terminal rows against raw SQL", async () => {
  const { db, port, snapshot: s } = await setup();
  try {
    const imported = await dbapi.importBaseline(db, s.id, bundleBytes(syntheticBaseline(s)), now);
    assert.equal((db.prepare("PRAGMA foreign_keys").get() as {foreign_keys:number}).foreign_keys, 1);
    for (const state of ["passed", "failed", "invalid", "blocked", "cancelled", "interrupted"]) {
      // Terminal baseline is independently guarded for all replacement targets.
      assert.throws(() => db.prepare("UPDATE verification_records SET state=? WHERE id=?").run(state, imported.id));
    }
    assert.throws(() => db.prepare("DELETE FROM verification_records WHERE id=?").run(imported.id));
    assert.throws(() => db.prepare("INSERT OR REPLACE INTO verification_records SELECT * FROM verification_records WHERE id=?").run(imported.id));
    const { record } = await port.createVerification({ snapshotId: s.id, requestKey: "integrity", now });
    const fence = await port.beginVerification({ recordId: record.id, attemptId: "integrity-attempt", runnerId: "runner", now, leaseMs: 30000 });
    await port.finishVerification(fence, blocked, now);
    for (const action of ["UPDATE verification_attempts SET state='running'", "DELETE FROM verification_attempts", "INSERT OR REPLACE INTO verification_attempts SELECT * FROM verification_attempts"]) assert.throws(() => db.exec(action));
    await port.saveHeadObservation({ repositoryId: s.repository.id, rootDirectory: s.rootDirectory, headCommitSha: s.commitSha, observedAt: s.fetchedAt, evidenceOrigin: "operator-import" });
    assert.throws(() => db.exec("INSERT OR REPLACE INTO source_head_observations SELECT * FROM source_head_observations"));
  } finally { db.close(); }
});

test("two-connection receipt races grant creation ownership exactly once", { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "dogfood-receipt-race-"));
  const path = join(directory, "state.db");
  const { db, port, snapshot: s } = await setup(path);
  const workerCode = `
    (async () => {
      const { workerData, parentPort } = require('node:worker_threads');
      const api = await import(workerData.module);
      const db = api.openDatabase(workerData.path);
      const signal = new Int32Array(workerData.barrier);
      Atomics.add(signal, 0, 1); Atomics.notify(signal, 0);
      Atomics.wait(signal, 1, 0, 10000);
      try {
        const value = await api.createSqliteDogfoodStore(db).createVerification(workerData.input);
        parentPort.postMessage({ value });
      } catch (error) { parentPort.postMessage({ error: error.code || 'UNKNOWN' }); }
      finally { db.close(); }
    })();
  `;
  try {
    for (let index = 0; index < 5; index++) {
      const barrier = new SharedArrayBuffer(8); const signal = new Int32Array(barrier);
      const workers = [0, 1].map(() => new Worker(workerCode, {
        eval: true, workerData: { module: new URL("../dist/index.js", import.meta.url).href, path, barrier, input: { snapshotId: s.id, requestKey: `race-${index}`, now } },
      }));
      try {
        const results = workers.map(worker => new Promise<{ value?: { created: boolean; record: VerificationRecord }; error?: string }>((resolve, reject) => {
          worker.once("message", resolve); worker.once("error", reject);
          worker.once("exit", code => { if (code !== 0) reject(new Error(`Worker exit ${code}`)); });
        }));
        const limit = Date.now() + 10_000;
        while (Atomics.load(signal, 0) < 2 && Date.now() < limit) await new Promise(resolve => setTimeout(resolve, 1));
        assert.equal(Atomics.load(signal, 0), 2);
        Atomics.store(signal, 1, 1); Atomics.notify(signal, 1, 2);
        const receipts = await Promise.all(results);
        assert.ok(receipts.every(receipt => !receipt.error));
        assert.equal(receipts.filter(receipt => receipt.value?.created).length, 1);
        assert.equal(new Set(receipts.map(receipt => receipt.value?.record.id)).size, 1);
        assert.ok(receipts.every(receipt => receipt.value?.record.state === "queued"));
      } finally { await Promise.all(workers.map(worker => worker.terminate())); }
    }
    assert.equal((await port.listVerifications(s.id)).length, 5);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("reopened timing-out and expired attempts recover only under explicit lifecycle control", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dogfood-recovery-")); const path = join(directory, "state.db");
  try {
    const first = await setup(path); const ids: string[] = [];
    for (const key of ["timing-out", "expired", "queued"]) {
      const { record } = await first.port.createVerification({ snapshotId: first.snapshot.id, requestKey: key, now: 0 }); ids.push(record.id);
      if (key !== "queued") {
        const fence = await first.port.beginVerification({ recordId: record.id, attemptId: key, runnerId: "runner", now: 0, leaseMs: 30_000 });
        if (key === "timing-out") await first.port.expireVerification(fence, 30_000);
      }
    }
    first.db.close();
    const db = dbapi.openDatabase(path); dbapi.migrate(db);
    try {
      const port = dbapi.createSqliteDogfoodStore(db);
      assert.equal((await port.getVerification(ids[0]!))!.state, "timing_out");
      assert.equal((await port.getVerification(ids[1]!))!.state, "running");
      assert.equal((await port.getVerification(ids[2]!))!.state, "queued");
      assert.equal(dbapi.interruptVerifications(db, 35_000), 3);
      for (const id of ids.slice(0, 2)) {
        const record = (await port.getVerification(id))!;
        assert.equal(record.state, "failed"); assert.equal(record.code, "TIMEOUT"); assert.equal(record.cleanupCode, "CLEANUP_UNCONFIRMED");
      }
      const queued = (await port.getVerification(ids[2]!))!;
      assert.equal(queued.state, "interrupted"); assert.equal(queued.cleanupCode, null);
      assert.equal((await port.createVerification({ snapshotId: first.snapshot.id, requestKey: "queued", now: 35_000 })).created, false);
    } finally { db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const [label, status] of [["object", { toString: null }], ["nested array", [[{ toString: null }]]]] as const) {
  test(`retains one invalid history row for malformed ${label} assertion status`, async () => {
    const { db, port, snapshot: s } = await setup();
    try {
      const report = syntheticReport();
      Object.assign(report.testResults[0]!.assertionResults[0]!, { status });
      const bytes = bundleBytes(withReport(syntheticBaseline(s), report));
      const record = await dbapi.importBaseline(db, s.id, bytes, now);
      assert.equal(record.state, "invalid");
      assert.equal(record.assessment?.status, "invalid");
      assert.deepEqual(await port.listVerifications(s.id), [record]);
      assert.deepEqual(await dbapi.importBaseline(db, s.id, bytes, now + 1), record);
      assert.equal((await port.listVerifications(s.id)).length, 1);
    } finally { db.close(); }
  });
}

for (const version of ["vite", "vitest"] as const) {
  test(`prepared baseline rechecks stored ${version} facts even for genuine parser evidence`, async () => {
    const { db, port, snapshot: s } = await setup();
    try {
      const clone = structuredClone(s);
      clone.runtime.versions[version]!.value = "999.0.0";
      assert.equal(clone.digest, s.digest);
      const baseline = syntheticBaseline(s); baseline.runtime[version] = "999.0.0";
      const evidence = await parseBaselineBundle(bundleBytes(baseline), clone);
      const assessment = assessReport(evidence, profile);
      assert.equal(assessment.status, "passed");
      await assert.rejects(port.persistBaseline({ snapshotId: s.id, evidence, assessment, now }), { code: "INVALID_INPUT" });
      assert.deepEqual(await port.listVerifications(s.id), []);
      assert.deepEqual(await port.getInventory(s.id), s);
    } finally { db.close(); }
  });

  test(`completion rechecks stored ${version} facts without altering running history`, async () => {
    const { db, port, snapshot: s } = await setup();
    try {
      const { record } = await port.createVerification({ snapshotId: s.id, requestKey: `facts-${version}`, now });
      const fence = await port.beginVerification({ recordId: record.id, attemptId: `facts-${version}`, runnerId: "runner", now, leaseMs: 30000 });
      const originalRecord = await port.getVerification(record.id);
      const originalAttempts = db.prepare("SELECT * FROM verification_attempts").all();
      const clone = structuredClone(s); clone.runtime.versions[version]!.value = "999.0.0";
      const baseline = { ...syntheticBaseline(s), attemptKey: fence.attemptId }; baseline.runtime[version] = "999.0.0";
      const evidence = await parseBaselineBundle(bundleBytes(baseline), clone);
      const assessment = assessReport(evidence, profile);
      assert.equal(assessment.status, "passed");
      await assert.rejects(port.finishVerification(fence, { state: "passed", code: "PASSED", evidence, assessment }, now + 1), { code: "INVALID_INPUT" });
      assert.deepEqual(await port.getVerification(record.id), originalRecord);
      assert.deepEqual(db.prepare("SELECT * FROM verification_attempts").all(), originalAttempts);
      assert.equal((await port.listVerifications(s.id)).length, 1);
    } finally { db.close(); }
  });
}
