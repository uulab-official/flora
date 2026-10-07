import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { setTimeout, clearTimeout } from "node:timers";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript";
import * as dbapi from "@app-ops/db";
import * as dashboard from "@app-ops/dashboard";
import { createDogfoodService as portableService } from "@app-ops/dashboard/service";
import { createBlockedProvider as portableBlocked } from "@app-ops/dashboard/blocked-provider";
import { parseBaselineBundle, parseSourceBundle } from "@app-ops/dogfood";
import type { DogfoodStore, VerificationRecord } from "@app-ops/dogfood";
import type { CapabilityReport, ProviderResult, RunInput, VerificationProvider } from "@app-ops/runner-protocol";
import { bundleBytes, syntheticBaseline, syntheticSourceBundle, syntheticVerificationProvider, syntheticProviderResult, verifiedSyntheticCapabilities } from "../../../tests/dogfood-fixtures.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
// Capture native watchdog timers before fake execution clocks are installed.
// They only bound broken tests; record observations are driven by committed writes.
const watchdog = { setTimeout, clearTimeout };
const changes = new WeakMap<DogfoodStore, Set<() => void>>();
function observedStore(store: DogfoodStore): DogfoodStore {
  const listeners = new Set<() => void>();
  function mutation<A extends unknown[], R>(operation: (...args: A) => Promise<R>) {
    return async (...args: A): Promise<R> => {
      const result = await operation(...args);
      for (const listener of listeners) listener();
      return result;
    };
  }
  const observed: DogfoodStore = { ...store,
    createVerification: mutation(store.createVerification),
    beginVerification: mutation(store.beginVerification),
    finishVerification: mutation(store.finishVerification),
    blockVerification: mutation(store.blockVerification),
    requestCancellation: mutation(store.requestCancellation),
    finishCancellation: mutation(store.finishCancellation),
    expireVerification: mutation(store.expireVerification),
    finishTimeout: mutation(store.finishTimeout),
  };
  changes.set(observed, listeners);
  return observed;
}
function clock(t: TestContext) { t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 }); }
async function setup(providers: readonly VerificationProvider[], wrap: (port: DogfoodStore) => DogfoodStore = port => port) {
  assert.equal(typeof dashboard.createDogfoodService, "function");
  const db = dbapi.openDatabase(":memory:"); dbapi.migrate(db);
  const port = observedStore(dbapi.createSqliteDogfoodStore(db));
  const service = await dashboard.createDogfoodService(wrap(port), providers, () => Date.now());
  const snapshot = await service.importSource(bundleBytes(syntheticSourceBundle()));
  return { db, port, service, snapshot };
}
function record(port: DogfoodStore, id: string, state: VerificationRecord["state"]): Promise<VerificationRecord> {
  const listeners = changes.get(port); assert.ok(listeners, "Expected an observed test store");
  return new Promise((resolve, reject) => {
    let lastState = "not-read"; let done = false; let reading = false; let dirty = false;
    const timer = watchdog.setTimeout(() => finish(new Error(`Record ${id}: expected ${state}, last observed ${lastState}`)), 5_000);
    function finish(error: unknown, value?: VerificationRecord): void {
      if (done) return;
      done = true; watchdog.clearTimeout(timer); listeners!.delete(changed);
      if (error) reject(error); else resolve(value!);
    }
    async function inspect(): Promise<void> {
      if (reading) return;
      reading = true;
      try {
        while (dirty && !done) {
          dirty = false;
          const current = await port.getVerification(id);
          lastState = current?.state ?? "missing";
          if (current?.state === state) finish(null, current);
        }
      } catch (error) { finish(error); }
      finally { reading = false; }
    }
    function changed(): void { dirty = true; void inspect(); }
    // Subscribe before reading so a concurrent commit cannot be lost.
    listeners.add(changed); changed();
  });
}
function delayedProvider() {
  const started = deferred<RunInput>(); const result = deferred<ProviderResult>();
  let signal: AbortSignal | undefined; let calls = 0; let cancels = 0;
  const provider = syntheticVerificationProvider({
    run: (input, abort) => { signal = abort; calls++; started.resolve(input); return result.promise; },
    cancel: async () => { cancels++; return { processTreeStopped: true, workspaceRemoved: true, outputBoundaryEnforced: true }; },
  });
  return { provider, started, result, get signal() { return signal; }, get calls() { return calls; }, get cancels() { return cancels; } };
}

test("blocked default explains every unverified condition and cannot run", async () => {
  assert.equal(typeof dashboard.createBlockedProvider, "function");
  const provider = dashboard.createBlockedProvider();
  const { db, port, service, snapshot } = await setup([provider]);
  try {
    const state = await service.getState();
    assert.equal(state.providers[0]!.os, null);
    assert.ok(Object.values(state.providers[0]!.checks).every(check => check === "unknown"));
    for (const word of ["toolchain", "filesystem", "network", "cpu", "resources", "processTreeCancel", "outputBoundary", "cleanup"]) assert.ok(state.providers[0]!.reasons.some(reason => reason.includes(word)));
    assert.ok(!JSON.stringify(state.providers).includes("NETLINK_ROUTE"));
    const queued = await service.requestRun(snapshot.id, "blocked"); assert.equal(queued.state, "queued");
    const blocked = (await record(port, queued.id, "blocked"))!;
    assert.equal(blocked.code, "PROVIDER_UNSUPPORTED"); assert.equal(blocked.evidence, null);
    assert.equal(blocked.evidenceOrigin, "flora-request"); assert.equal(blocked.attemptId, null);
    await assert.rejects(provider.run({} as RunInput, new AbortController().signal), { code: "PROVIDER_UNSUPPORTED" });
    assert.deepEqual(await provider.cancel("unknown"), { processTreeStopped: false, workspaceRemoved: false, outputBoundaryEnforced: false });
  } finally { await service.close(); db.close(); }
});

test("blocks without a fully verified provider and repeats preflight before beginning", async () => {
  assert.equal(typeof dashboard.createDogfoodService, "function");
  for (const check of Object.keys(verifiedSyntheticCapabilities().checks) as (keyof CapabilityReport["checks"])[]) {
    for (const value of ["unknown", "failed"] as const) {
      let preflights = 0; let runs = 0;
      const provider = syntheticVerificationProvider({ preflight: async () => {
        const report = verifiedSyntheticCapabilities();
        if (++preflights > 1) report.checks[check] = value;
        return report;
      }, run: async input => { runs++; return syntheticProviderResult(input); } });
      const { db, port, service, snapshot } = await setup([provider]);
      try {
        assert.equal((await service.getState()).providers[0]!.checks[check], "passed");
        const queued = await service.requestRun(snapshot.id, "blocked");
        await record(port, queued.id, "blocked"); assert.equal(runs, 0); assert.equal(preflights, 2);
        assert.equal((await service.getState()).providers[0]!.checks[check], value);
      } finally { await service.close(); db.close(); }
    }
  }
});

test("imports awaited immutable evidence and keeps freshness separate from execution", async () => {
  const { db, service, snapshot } = await setup([dashboard.createBlockedProvider()]);
  try {
    const baseline = await service.importBaseline(snapshot.id, bundleBytes(syntheticBaseline(snapshot)));
    assert.equal(baseline.state, "passed"); assert.equal(baseline.evidenceOrigin, "operator-import");
    assert.equal(baseline.evidenceKind, "development-baseline");
    const before = await service.getState(); assert.equal(before.freshness, "freshness_unknown");
    assert.equal(before.selectedSnapshotId, snapshot.id); assert.deepEqual(before.history, [baseline]);
    await service.importHead({ repositoryId: snapshot.repository.id, rootDirectory: snapshot.rootDirectory, headCommitSha: snapshot.commitSha, observedAt: "2026-01-03T03:04:05Z", evidenceOrigin: "operator-import" });
    assert.equal((await service.getState()).freshness, "observed_current");
    const newer = await service.importSource(bundleBytes({ ...syntheticSourceBundle(), commitSha: "b".repeat(40) }));
    assert.equal((await service.getState()).selectedSnapshotId, newer.id);
    assert.equal((await service.getState(snapshot.id)).selectedSnapshotId, snapshot.id);
    await assert.rejects(service.getState("missing"), { code: "NOT_FOUND" });
    assert.equal((db.prepare("SELECT count(*) n FROM releases").get() as {n:number}).n, 0);
    assert.equal((db.prepare("SELECT count(*) n FROM jobs").get() as {n:number}).n, 0);
  } finally { await service.close(); db.close(); }
});

test("atomic creation receipts prevent duplicate runs across service instances", async () => {
  const delayed = delayedProvider(); const { db, port, service, snapshot } = await setup([delayed.provider]);
  const second = await dashboard.createDogfoodService(port, [delayed.provider], Date.now);
  try {
    const rows = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? second : service).requestRun(snapshot.id, "same")));
    await delayed.started.promise;
    assert.equal(new Set(rows.map(row => row.id)).size, 1); assert.equal(delayed.calls, 1);
    delayed.result.resolve(await syntheticProviderResult(await delayed.started.promise));
    const passed = (await record(port, rows[0]!.id, "passed"))!;
    assert.equal(passed.evidenceOrigin, "flora-execution"); assert.equal(passed.evidenceKind, "isolated-runner-result");
    assert.deepEqual(await second.requestRun(snapshot.id, "same"), passed);
    assert.equal(delayed.calls, 1);
  } finally { await second.close(); await service.close(); db.close(); }
});

test("an existing queued receipt never authorizes scheduling or startup interruption", async () => {
  const delayed = delayedProvider(); const { db, port, service, snapshot } = await setup([delayed.provider]);
  try {
    const old = (await port.createVerification({ snapshotId: snapshot.id, requestKey: "orphan", now: Date.now() })).record;
    assert.deepEqual(await service.requestRun(snapshot.id, "orphan"), old);
    await service.getState(); await setImmediate(); assert.equal(delayed.calls, 0);
    assert.equal((await port.getVerification(old.id))!.state, "queued");
    await service.close(); assert.equal((await port.getVerification(old.id))!.state, "queued");
  } finally { await service.close(); db.close(); }
});

test("awaits storage receipts and preserves owned import bytes across asynchronous reads", async () => {
  const readGate = deferred<void>(); let gateReads = false;
  const createGate = deferred<void>(); let createWait = false;
  const delayed = delayedProvider();
  const { db, port, service, snapshot } = await setup([delayed.provider], port => ({ ...port,
    getInventory: async id => { if (gateReads) await readGate.promise; return port.getInventory(id); },
    createVerification: async input => { await createGate.promise; createWait = true; return port.createVerification(input); },
  }));
  try {
    gateReads = true;
    const bytes = bundleBytes(syntheticBaseline(snapshot));
    const imported = service.importBaseline(snapshot.id, bytes); bytes.fill(0);
    readGate.resolve(); assert.equal((await imported).state, "passed");
    const requested = service.requestRun(snapshot.id, "receipt");
    await setImmediate(); assert.equal(createWait, false); assert.equal(delayed.calls, 0);
    createGate.resolve(); const queued = await requested; await delayed.started.promise;
    delayed.result.resolve(await syntheticProviderResult(await delayed.started.promise));
    await record(port, queued.id, "passed");
  } finally { await service.close(); db.close(); }
});

test("cancellation invalidates the fence before abort and rejects late success", async t => {
  clock(t); const delayed = delayedProvider();
  const { db, port, service, snapshot } = await setup([delayed.provider]);
  try {
    const queued = await service.requestRun(snapshot.id, "cancel"); const input = await delayed.started.promise;
    const success = await syntheticProviderResult(input);
    let stateAtAbort: string | undefined;
    delayed.signal!.addEventListener("abort", () => { stateAtAbort = dbapi.getVerification(db, queued.id)!.state; });
    const cancelling = await service.cancelRun(queued.id);
    assert.equal(cancelling.state, "cancelling"); assert.equal(cancelling.fence, input.fence.fence + 1);
    await record(port, queued.id, "cancelled"); assert.equal(stateAtAbort, "cancelling");
    delayed.result.resolve(success); await setImmediate();
    assert.equal((await port.getVerification(queued.id))!.state, "cancelled"); assert.equal(delayed.cancels, 1);
  } finally { await service.close(); db.close(); }
});

test("29,999ms completion passes with the exact parser-owned evidence", async t => {
  clock(t); const delayed = delayedProvider(); const { db, port, service, snapshot } = await setup([delayed.provider]);
  try {
    const queued = await service.requestRun(snapshot.id, "before"); const input = await delayed.started.promise;
    const success = await syntheticProviderResult(input); t.mock.timers.tick(29_999); delayed.result.resolve(success);
    const passed = (await record(port, queued.id, "passed"))!; assert.equal(passed.updatedAt, 29_999);
    assert.equal(passed.evidence!.attemptKey, input.fence.attemptId);
    t.mock.timers.tick(1); await setImmediate(); assert.equal((await port.getVerification(queued.id))!.state, "passed");
  } finally { await service.close(); db.close(); }
});

for (const timerFirst of [true, false]) test(`30,000ms rejects success when ${timerFirst ? "timeout" : "result"} callback runs first`, async t => {
  clock(t); const delayed = delayedProvider(); const { db, port, service, snapshot } = await setup([delayed.provider]);
  try {
    const queued = await service.requestRun(snapshot.id, "boundary"); const input = await delayed.started.promise;
    const success = await syntheticProviderResult(input);
    if (timerFirst) t.mock.timers.tick(30_000); else t.mock.timers.setTime(30_000);
    delayed.result.resolve(success);
    const failed = (await record(port, queued.id, "failed"))!;
    assert.equal(failed.code, "TIMEOUT"); assert.equal(failed.evidence, null); assert.equal(failed.cleanupCode, null);
    assert.equal(delayed.signal!.aborted, true); assert.equal(delayed.cancels, 1);
  } finally { await service.close(); db.close(); }
});

test("35,000ms finishes unresponsive timeout cleanup and ignores every late callback", async t => {
  clock(t); const delayed = delayedProvider(); const cleanup = deferred<ProviderResult["cleanup"]>();
  delayed.provider.cancel = () => cleanup.promise;
  const { db, port, service, snapshot } = await setup([delayed.provider]);
  try {
    const queued = await service.requestRun(snapshot.id, "timeout"); const input = await delayed.started.promise;
    const success = await syntheticProviderResult(input);
    let stateAtAbort: string | undefined;
    delayed.signal!.addEventListener("abort", () => { stateAtAbort = dbapi.getVerification(db, queued.id)!.state; });
    t.mock.timers.tick(30_000); await record(port, queued.id, "timing_out");
    assert.equal(stateAtAbort, "timing_out"); assert.equal((await port.getVerification(queued.id))!.fence, input.fence.fence + 1);
    t.mock.timers.tick(4_999); await setImmediate(); assert.equal((await port.getVerification(queued.id))!.state, "timing_out");
    t.mock.timers.tick(1); const failed = (await record(port, queued.id, "failed"))!;
    assert.equal(failed.updatedAt, 35_000); assert.equal(failed.code, "TIMEOUT"); assert.equal(failed.cleanupCode, "CLEANUP_UNCONFIRMED");
    delayed.result.resolve(success); cleanup.resolve(success.cleanup); await setImmediate();
    assert.deepEqual(await port.getVerification(queued.id), failed);
  } finally { await service.close(); db.close(); }
});

test("cancellation cleanup is bounded to five seconds even when the provider never settles", async t => {
  clock(t); const delayed = delayedProvider(); delayed.provider.cancel = () => new Promise(() => {});
  const { db, port, service, snapshot } = await setup([delayed.provider]);
  try {
    const queued = await service.requestRun(snapshot.id, "cancel-timeout"); await delayed.started.promise;
    assert.equal((await service.cancelRun(queued.id)).state, "cancelling"); await setImmediate();
    t.mock.timers.tick(4_999); assert.equal((await port.getVerification(queued.id))!.state, "cancelling");
    t.mock.timers.tick(1); const cancelled = (await record(port, queued.id, "cancelled"))!;
    assert.equal(cancelled.cleanupCode, "CLEANUP_UNCONFIRMED"); assert.equal(cancelled.updatedAt, 5_000);
  } finally { await service.close(); db.close(); }
});

test("awaits cancellation and timeout fence writes before invoking provider cleanup", async t => {
  clock(t); const cancelGate = deferred<void>(); const expiryGate = deferred<void>(); const delayed = delayedProvider();
  const { db, port, service, snapshot } = await setup([delayed.provider], port => ({ ...port,
    requestCancellation: async (...args) => { await cancelGate.promise; return port.requestCancellation(...args); },
    expireVerification: async (...args) => { await expiryGate.promise; return port.expireVerification(...args); },
  }));
  try {
    const queued = await service.requestRun(snapshot.id, "delayed-cancel"); await delayed.started.promise;
    const cancelling = service.cancelRun(queued.id); await setImmediate();
    assert.equal(delayed.signal!.aborted, false); assert.equal(delayed.cancels, 0);
    cancelGate.resolve(); await cancelling; await record(port, queued.id, "cancelled");
    const other = await service.requestRun(snapshot.id, "delayed-expiry"); await record(port, other.id, "running");
    await setImmediate(); t.mock.timers.tick(30_000); await setImmediate();
    assert.equal(delayed.signal!.aborted, false); assert.equal(delayed.cancels, 1);
    expiryGate.resolve(); await record(port, other.id, "failed"); assert.equal(delayed.cancels, 2);
  } finally { await service.close(); db.close(); }
});

test("provider errors, incomplete cleanup and fabricated or reused evidence cannot pass", async t => {
  for (const scenario of ["exception", "cleanup", "attempt", "fabricated", "source"] as const) {
    let stage = "not-started";
    const provider = syntheticVerificationProvider({ run: async input => {
      if (scenario === "exception") throw new Error("secret provider diagnostic must not be stored");
      stage = "initial-evidence-hashing";
      const result = await syntheticProviderResult(input);
      stage = "initial-evidence-ready";
      if (scenario === "cleanup") result.cleanup.workspaceRemoved = false;
      if (scenario === "attempt") result.evidence = await parseBaselineBundle(bundleBytes(syntheticBaseline(input.snapshot)), input.snapshot);
      if (scenario === "fabricated") result.evidence = { ...result.evidence };
      if (scenario === "source") {
        stage = "other-source-hashing";
        const other = await parseSourceBundle(bundleBytes({ ...syntheticSourceBundle(), commitSha: "b".repeat(40) }), Date.now());
        stage = "other-evidence-hashing";
        result.evidence = await parseBaselineBundle(bundleBytes({ ...syntheticBaseline(other), attemptKey: input.fence.attemptId }), other);
      }
      stage = "result-ready";
      return result;
    } });
    const { db, port, service, snapshot } = await setup([provider]);
    try {
      const queued = await service.requestRun(snapshot.id, scenario);
      const failed = (await record(port, queued.id, "failed").catch(async error => {
        t.diagnostic(`scenario=${scenario}; stage=${stage}; persisted=${(await port.getVerification(queued.id))?.state}`);
        throw error;
      }))!;
      assert.equal(failed.code, scenario === "exception" ? "PROVIDER_ERROR" : scenario === "cleanup" ? "CLEANUP_UNCONFIRMED" : "INVALID_PROVIDER_RESULT");
      assert.equal(failed.evidence, null); assert.ok(!JSON.stringify(failed).includes("secret"));
    } finally { await service.close(); db.close(); }
  }
});

test("preflight exceptions and mismatched provider identities remain blocked", async () => {
  for (const fail of [true, false]) {
    let runs = 0;
    const provider = syntheticVerificationProvider({ preflight: async () => {
      if (fail) throw new Error("private preflight details");
      return verifiedSyntheticCapabilities("unregistered");
    }, run: async input => { runs++; return syntheticProviderResult(input); } });
    const { db, port, service, snapshot } = await setup([provider]);
    try {
      const queued = await service.requestRun(snapshot.id, "preflight"); await record(port, queued.id, "blocked");
      assert.equal(runs, 0); assert.ok(!JSON.stringify(await service.getState()).includes("private preflight"));
    } finally { await service.close(); db.close(); }
  }
});

test("close cancels owned work, remains bounded and leaves the caller database open", async t => {
  clock(t); const delayed = delayedProvider(); delayed.provider.cancel = () => new Promise(() => {});
  const { db, port, service, snapshot } = await setup([delayed.provider]);
  const queued = await service.requestRun(snapshot.id, "close"); await delayed.started.promise;
  const closing = service.close(); await record(port, queued.id, "cancelling"); await setImmediate();
  t.mock.timers.tick(5_000); await closing;
  assert.equal((await port.getVerification(queued.id))!.state, "cancelled");
  await assert.rejects(service.requestRun(snapshot.id, "closed"), { code: "INVALID_TRANSITION" });
  db.close();
});

test("service construction preserves timing_out on reopen until owner recovery", async () => {
  assert.equal(typeof dashboard.createDogfoodService, "function");
  const directory = mkdtempSync(join(tmpdir(), "dogfood-service-")); const path = join(directory, "state.db");
  try {
    const first = dbapi.openDatabase(path); dbapi.migrate(first); const port = dbapi.createSqliteDogfoodStore(first);
    const snapshot = await port.saveInventory(await parseSourceBundle(bundleBytes(syntheticSourceBundle()), 0));
    const queued = (await port.createVerification({ snapshotId: snapshot.id, requestKey: "reopen", now: 0 })).record;
    const fence = await port.beginVerification({ recordId: queued.id, attemptId: "reopen-attempt", runnerId: "synthetic-provider", now: 0, leaseMs: 30_000 });
    await port.expireVerification(fence, 30_000); first.close();
    const reopened = dbapi.openDatabase(path); dbapi.migrate(reopened);
    const service = await dashboard.createDogfoodService(dbapi.createSqliteDogfoodStore(reopened), [dashboard.createBlockedProvider()], () => 35_000);
    try {
      assert.equal((await service.getState()).history[0]!.state, "timing_out");
      assert.equal(dbapi.interruptVerifications(reopened, 35_000), 1);
      const failed = (await service.getState()).history[0]!;
      assert.equal(failed.code, "TIMEOUT"); assert.equal(failed.cleanupCode, "CLEANUP_UNCONFIRMED");
    } finally { await service.close(); reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("portable service runtime graph excludes Node, storage adapters and execution fallbacks", () => {
  assert.equal(portableService, dashboard.createDogfoodService);
  assert.equal(portableBlocked, dashboard.createBlockedProvider);
  const seen = new Set<string>();
  function visit(url: string): void {
    if (seen.has(url)) return;
    seen.add(url);
    const source = readFileSync(new URL(url), "utf8");
    const scanner = ts.createScanner(ts.ScriptTarget.ES2023, true, ts.LanguageVariant.Standard, source);
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
      if (token === ts.SyntaxKind.Identifier) assert.ok(!["Buffer", "process", "spawn", "execFile", "DatabaseSync", "require"].includes(scanner.getTokenText()), `${url}: ${scanner.getTokenText()}`);
    }
    function follow(specifier: string): void {
      assert.ok(specifier.startsWith(".") || specifier.startsWith("@app-ops/"), `Unexpected runtime import: ${specifier}`);
      assert.ok(!["@app-ops/db", "@app-ops/cli", "@app-ops/dashboard"].includes(specifier), `Nonportable barrel import: ${specifier}`);
      visit(specifier.startsWith(".") ? new URL(specifier, url).href : import.meta.resolve(specifier));
    }
    function inspect(node: ts.Node): void {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        assert.ok(ts.isStringLiteral(node.moduleSpecifier)); follow(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = node.arguments[0]; assert.ok(specifier && ts.isStringLiteral(specifier)); follow(specifier.text);
      }
      ts.forEachChild(node, inspect);
    }
    inspect(ts.createSourceFile(url, source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.JS));
  }
  visit(import.meta.resolve("@app-ops/dashboard/service"));
  visit(import.meta.resolve("@app-ops/dashboard/blocked-provider"));
  assert.ok(seen.size > 10);
});

test("close retires a local attempt already cancelled by another service without waiting for its deadline", async t => {
  clock(t); const delayed = delayedProvider(); const { db, port, service, snapshot } = await setup([delayed.provider]);
  const other = await dashboard.createDogfoodService(port, [delayed.provider], Date.now);
  let closing: Promise<void> | undefined;
  try {
    const queued = await service.requestRun(snapshot.id, "external-cancel"); await delayed.started.promise;
    await other.cancelRun(queued.id); await record(port, queued.id, "cancelled");
    closing = service.close(); let done = false; void closing.then(() => { done = true; });
    await setImmediate(); await setImmediate();
    assert.equal(done, true);
    assert.equal(delayed.signal!.aborted, true); assert.equal(delayed.cancels, 1);
    assert.equal((await port.getVerification(queued.id))!.cleanupCode, "CLEANUP_UNCONFIRMED");
  } finally {
    t.mock.timers.tick(35_000); await setImmediate();
    await closing; await other.close(); await service.close(); db.close();
  }
});

test("cleanup confirmation rejects accessor reports without invoking them", async () => {
  let accessed = false; const delayed = delayedProvider();
  delayed.provider.cancel = async () => ({ get processTreeStopped() { accessed = true; return true; }, workspaceRemoved: true, outputBoundaryEnforced: true });
  const { db, port, service, snapshot } = await setup([delayed.provider]);
  try {
    const queued = await service.requestRun(snapshot.id, "cleanup-accessor"); await delayed.started.promise;
    await service.cancelRun(queued.id);
    const cancelled = (await record(port, queued.id, "cancelled"))!;
    assert.equal(cancelled.cleanupCode, "CLEANUP_UNCONFIRMED"); assert.equal(accessed, false);
  } finally { await service.close(); db.close(); }
});

test("baseline envelope bounds apply before copying or awaiting storage", async () => {
  let reads = 0;
  const { db, service, snapshot } = await setup([], port => ({ ...port, getInventory: async id => { reads++; return port.getInventory(id); } }));
  try {
    await assert.rejects(service.importBaseline(snapshot.id, new Uint8Array(2 * 1024 * 1024 + 1)), { code: "INVALID_INPUT" });
    assert.equal(reads, 0);
  } finally { await service.close(); db.close(); }
});

test("queued cancellation prevents late preflight from launching an attempt", async () => {
  const gate = deferred<CapabilityReport>(); const preflightStarted = deferred<void>(); let preflights = 0; let runs = 0;
  const provider = syntheticVerificationProvider({
    preflight: async () => {
      if (++preflights === 1) return verifiedSyntheticCapabilities();
      preflightStarted.resolve(); return gate.promise;
    },
    run: async input => { runs++; return syntheticProviderResult(input); },
  });
  const { db, port, service, snapshot } = await setup([provider]);
  try {
    const queued = await service.requestRun(snapshot.id, "queued-cancel");
    await preflightStarted.promise;
    assert.equal((await service.cancelRun(queued.id)).state, "cancelling");
    const cancelled = (await record(port, queued.id, "cancelled"))!;
    assert.equal(cancelled.attemptId, null); assert.equal(cancelled.cleanupCode, null);
    gate.resolve(verifiedSyntheticCapabilities()); await setImmediate();
    assert.equal(runs, 0); assert.deepEqual(await port.getVerification(queued.id), cancelled);
  } finally { await service.close(); db.close(); }
});

test("a delayed begin receipt cannot launch after its committed lease expires", async t => {
  clock(t); const gate = deferred<void>(); const delayed = delayedProvider();
  const { db, port, service, snapshot } = await setup([delayed.provider], port => ({ ...port,
    beginVerification: async input => { const fence = await port.beginVerification(input); await gate.promise; return fence; },
  }));
  try {
    const queued = await service.requestRun(snapshot.id, "delayed-begin"); await record(port, queued.id, "running");
    t.mock.timers.setTime(30_000); gate.resolve();
    const failed = (await record(port, queued.id, "failed"))!;
    assert.equal(failed.code, "TIMEOUT"); assert.equal(delayed.calls, 0); assert.equal(delayed.cancels, 1);
  } finally { await service.close(); db.close(); }
});

test("close awaits an in-flight creation receipt and cancels it without starting work", async () => {
  const gate = deferred<void>(); const receiptCreated = deferred<void>(); const delayed = delayedProvider();
  const { db, port, service, snapshot } = await setup([delayed.provider], port => ({ ...port,
    createVerification: async input => { const receipt = await port.createVerification(input); receiptCreated.resolve(); await gate.promise; return receipt; },
  }));
  try {
    const requested = service.requestRun(snapshot.id, "closing-create");
    await receiptCreated.promise;
    const closing = service.close(); gate.resolve(); const queued = await requested; await closing;
    const cancelled = (await port.getVerification(queued.id))!;
    assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.attemptId, null); assert.equal(delayed.calls, 0);
  } finally { await service.close(); db.close(); }
});

test("valid failed and invalid evidence retain their assessed outcome and provenance", async () => {
  for (const invalid of [false, true]) {
    const provider = syntheticVerificationProvider({ run: async input => {
      const baseline = { ...syntheticBaseline(input.snapshot), attemptKey: input.fence.attemptId, exitCode: invalid ? null : 1 };
      return { evidence: await parseBaselineBundle(bundleBytes(baseline), input.snapshot), cleanup: { processTreeStopped: true, workspaceRemoved: true, outputBoundaryEnforced: true } };
    } });
    const { db, port, service, snapshot } = await setup([provider]);
    try {
      const queued = await service.requestRun(snapshot.id, "assessed");
      const assessed = (await record(port, queued.id, invalid ? "invalid" : "failed"))!;
      assert.equal(assessed.code, invalid ? "EXIT_UNCONFIRMED" : "TESTS_FAILED");
      assert.equal(assessed.evidenceOrigin, "flora-execution"); assert.ok(assessed.evidence); assert.ok(assessed.assessment);
    } finally { await service.close(); db.close(); }
  }
});

test("empty state has no inferred freshness and provider identities must be unique", async () => {
  const db = dbapi.openDatabase(":memory:"); dbapi.migrate(db); const port = dbapi.createSqliteDogfoodStore(db);
  const service = await dashboard.createDogfoodService(port, [], Date.now);
  try {
    const state = await service.getState();
    assert.equal(state.selectedSnapshotId, null); assert.equal(state.freshness, "freshness_unknown");
    assert.equal(state.headObservation, null); assert.deepEqual(state.history, []); assert.deepEqual(state.snapshots, []);
    assert.equal(state.profile.id, "config-runtime-smoke-v1");
    await assert.rejects(dashboard.createDogfoodService(port, [syntheticVerificationProvider(), syntheticVerificationProvider()], Date.now), { code: "INVALID_INPUT" });
  } finally { await service.close(); db.close(); }
});

test("close awaits cancellation writes for rows without a local attempt", async () => {
  const requestGate = deferred<void>(); const finishGate = deferred<void>();
  const { db, port, service, snapshot } = await setup([], port => ({ ...port,
    requestCancellation: async (...args) => { await requestGate.promise; return port.requestCancellation(...args); },
    finishCancellation: async (...args) => { await finishGate.promise; return port.finishCancellation(...args); },
  }));
  let closing: Promise<void> | undefined;
  try {
    const orphan = (await port.createVerification({ snapshotId: snapshot.id, requestKey: "external-queued", now: Date.now() })).record;
    const cancelling = service.cancelRun(orphan.id);
    closing = service.close(); let done = false; void closing.then(() => { done = true; });
    await setImmediate(); assert.equal(done, false, "wait for the cancellation receipt");
    requestGate.resolve(); assert.equal((await cancelling).state, "cancelling");
    await setImmediate(); assert.equal(done, false, "wait for the finalization write");
    finishGate.resolve(); await closing; assert.equal((await port.getVerification(orphan.id))!.state, "cancelled");
    await assert.rejects(service.cancelRun(orphan.id), { code: "INVALID_TRANSITION" });
  } finally {
    requestGate.resolve(); finishGate.resolve(); await closing; await setImmediate(); await service.close(); db.close();
  }
});

test("record observation waits for hashing completion rather than event-loop turns", async t => {
  clock(t);
  const provider = syntheticVerificationProvider();
  const { db, port, service, snapshot } = await setup([provider]);
  const hashing = deferred<void>(); const release = deferred<void>();
  const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  t.mock.method(globalThis.crypto.subtle, "digest", async (...args: Parameters<typeof digest>) => {
    hashing.resolve(); await release.promise; return digest(...args);
  });
  let observation: Promise<VerificationRecord | null> | undefined;
  try {
    const queued = await service.requestRun(snapshot.id, "deferred-hashing"); await hashing.promise;
    let settled = false; let error: unknown;
    observation = record(port, queued.id, "passed");
    void observation.then(() => { settled = true; }, reason => { settled = true; error = reason; });
    // Keep Web Crypto pending across more turns than the legacy observer budget.
    // Fake execution time remains zero; no lease or cleanup deadline has elapsed.
    for (let turn = 0; turn < 128; turn++) await setImmediate();
    assert.equal((await port.getVerification(queued.id))!.state, "running");
    assert.equal(Date.now(), 0);
    if (error) t.diagnostic(`hashing pending; persisted=running; observer=${String(error)}`);
    assert.equal(settled, false, "an unfinished hash is not a failed execution transition");
    release.resolve(); assert.equal((await observation)!.state, "passed");
  } finally { release.resolve(); await observation?.catch(() => {}); await service.close(); db.close(); }
});

// Count every port entry after successful service shutdown, including an entry
// resumed inside a deferred storage wrapper rather than just its initial call.
function watchClosedStore(port: DogfoodStore, isClosed: () => boolean, lateAccesses: string[]): DogfoodStore {
  return new Proxy(port, { get(target, key, receiver) {
    const operation: unknown = Reflect.get(target, key, receiver);
    if (typeof operation !== "function") return operation;
    return (...args: unknown[]) => {
      if (isClosed()) lateAccesses.push(String(key));
      return Reflect.apply(operation, target, args);
    };
  } });
}

for (const receiptFirst of [true, false]) test(`close drains cancellation finalization with its receipt ${receiptFirst ? "before" : "after"} lost-fence cleanup`, async () => {
  const cancellationCommitted = deferred<void>(); const deliverCancellation = deferred<void>();
  const cleanupStarted = deferred<void>(); const cleanupResult = deferred<ProviderResult["cleanup"]>();
  const finishStarted = deferred<void>(); const finishAllowed = deferred<void>();
  const delayed = delayedProvider();
  delayed.provider.cancel = async () => { cleanupStarted.resolve(); return cleanupResult.promise; };
  let storeClosed = false; const lateAccesses: string[] = [];
  const { db, port, service, snapshot } = await setup([delayed.provider], port => {
    const guarded = watchClosedStore(port, () => storeClosed, lateAccesses);
    return { ...guarded,
      requestCancellation: async (...args) => {
        const receipt = await guarded.requestCancellation(...args);
        cancellationCommitted.resolve(); await deliverCancellation.promise; return receipt;
      },
      finishCancellation: async (...args) => {
        finishStarted.resolve(); await finishAllowed.promise; return guarded.finishCancellation(...args);
      },
    };
  });
  let closing: Promise<void> | undefined;
  try {
    const queued = await service.requestRun(snapshot.id, "lost-and-cancel");
    const success = await syntheticProviderResult(await delayed.started.promise);
    const cancelling = service.cancelRun(queued.id); await cancellationCommitted.promise;
    delayed.result.resolve(success); await cleanupStarted.promise;
    if (receiptFirst) {
      deliverCancellation.resolve(); assert.equal((await cancelling).state, "cancelling");
      cleanupResult.resolve(success.cleanup);
    } else {
      cleanupResult.resolve(success.cleanup); await setImmediate();
      deliverCancellation.resolve(); assert.equal((await cancelling).state, "cancelling");
    }
    await finishStarted.promise;
    closing = service.close(); let closed = false; void closing.then(() => { closed = true; });
    await setImmediate();
    assert.equal((await port.getVerification(queued.id))!.state, "cancelling");
    assert.equal(closed, false, "lost-fence cleanup is not cancellation finalization");
    finishAllowed.resolve(); await closing;
    const cancelled = (await port.getVerification(queued.id))!;
    assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.cleanupCode, null);
    storeClosed = true; db.close(); await setImmediate(); assert.deepEqual(lateAccesses, []);
  } finally {
    deliverCancellation.resolve(); finishAllowed.resolve();
    cleanupResult.resolve({ processTreeStopped: true, workspaceRemoved: true, outputBoundaryEnforced: true });
    await closing; await service.close(); if (!storeClosed) db.close();
  }
});

test("close drains a started completion write after cancellation settles its attempt", async () => {
  const finishStarted = deferred<void>(); const finishAllowed = deferred<void>();
  const delayed = delayedProvider(); let completionError: unknown;
  let storeClosed = false; const lateAccesses: string[] = [];
  const { db, port, service, snapshot } = await setup([delayed.provider], port => {
    const guarded = watchClosedStore(port, () => storeClosed, lateAccesses);
    return { ...guarded, finishVerification: async (...args) => {
      finishStarted.resolve(); await finishAllowed.promise;
      try { return await guarded.finishVerification(...args); }
      catch (error) { completionError = error; throw error; }
    } };
  });
  let closing: Promise<void> | undefined;
  try {
    const queued = await service.requestRun(snapshot.id, "pending-completion");
    delayed.result.resolve(await syntheticProviderResult(await delayed.started.promise)); await finishStarted.promise;
    closing = service.close(); let closed = false; void closing.then(() => { closed = true; });
    await record(port, queued.id, "cancelled"); await setImmediate();
    assert.equal(closed, false, "settling the attempt does not finish its outstanding storage call");
    finishAllowed.resolve(); await closing;
    assert.equal((completionError as { code: string }).code, "LEASE_STALE");
    assert.equal((await port.getVerification(queued.id))!.state, "cancelled");
    storeClosed = true; db.close(); await setImmediate(); assert.deepEqual(lateAccesses, []);
  } finally { finishAllowed.resolve(); await closing; await service.close(); if (!storeClosed) db.close(); }
});

test("close does not wait for a queued provider preflight that never settles", async () => {
  const preflightStarted = deferred<void>(); const preflightResult = deferred<CapabilityReport>();
  let preflights = 0;
  const provider = syntheticVerificationProvider({ preflight: async () => {
    if (++preflights === 1) return verifiedSyntheticCapabilities();
    preflightStarted.resolve(); return preflightResult.promise;
  } });
  let storeClosed = false; const lateAccesses: string[] = [];
  const { db, port, service, snapshot } = await setup([provider], port => watchClosedStore(port, () => storeClosed, lateAccesses));
  let closing: Promise<void> | undefined;
  try {
    const queued = await service.requestRun(snapshot.id, "unresponsive-preflight"); await preflightStarted.promise;
    closing = service.close(); let closed = false; void closing.then(() => { closed = true; });
    await record(port, queued.id, "cancelled"); await setImmediate();
    assert.equal(closed, true, "an unresolved external preflight owns no pending storage write");
    await closing; storeClosed = true; db.close();
    preflightResult.resolve(verifiedSyntheticCapabilities()); await setImmediate(); assert.deepEqual(lateAccesses, []);
  } finally { preflightResult.resolve(verifiedSyntheticCapabilities()); await closing; await service.close(); if (!storeClosed) db.close(); }
});

test("late provider success and rejection after successful close never access storage", async () => {
  for (const rejects of [false, true]) {
    const started = deferred<RunInput>(); const returnAllowed = deferred<ProviderResult>(); const returned = deferred<void>();
    const provider = syntheticVerificationProvider({ run: async input => {
      started.resolve(input);
      try {
        const result = await returnAllowed.promise;
        if (rejects) throw new Error("late synthetic provider failure");
        return result;
      } finally { returned.resolve(); }
    } });
    let storeClosed = false; const lateAccesses: string[] = [];
    const { db, port, service, snapshot } = await setup([provider], port => watchClosedStore(port, () => storeClosed, lateAccesses));
    let result: ProviderResult | undefined;
    try {
      const queued = await service.requestRun(snapshot.id, `late-${rejects}`); result = await syntheticProviderResult(await started.promise);
      await service.close(); assert.equal((await port.getVerification(queued.id))!.state, "cancelled");
      storeClosed = true; db.close();
      returnAllowed.resolve(result); await returned.promise; await setImmediate(); assert.deepEqual(lateAccesses, []);
    } finally { if (result) returnAllowed.resolve(result); await service.close(); if (!storeClosed) db.close(); }
  }
});
