import { DomainError, ensure, object, text } from "@app-ops/core";
import { freeze } from "@app-ops/config";
import { assertParsedBaseline, assessReport, CONFIG_RUNTIME_SMOKE_V1, deriveFreshness } from "@app-ops/dogfood";
import type { DogfoodStore, Freshness, HeadObservation, InventorySnapshot, VerificationCompletion, VerificationFence, VerificationProfile, VerificationRecord } from "@app-ops/dogfood";
import { capabilities, selectProvider, VERIFICATION_CHECKS } from "@app-ops/runner-protocol";
import type { CapabilityReport, CleanupReport, ExecutionRequirements, ProviderResult, VerificationProvider } from "@app-ops/runner-protocol";
import { createImportService } from "./import-service.js";

export interface DashboardState {
  snapshots: InventorySnapshot[];
  selectedSnapshotId: string | null;
  freshness: Freshness;
  headObservation: HeadObservation | null;
  history: VerificationRecord[];
  profile: VerificationProfile;
  providers: CapabilityReport[];
}
export interface DogfoodService {
  importSource(bytes: Uint8Array): Promise<InventorySnapshot>;
  importBaseline(snapshotId: string, bytes: Uint8Array): Promise<VerificationRecord>;
  importHead(observation: HeadObservation): Promise<void>;
  getState(snapshotId?: string): Promise<DashboardState>;
  requestRun(snapshotId: string, requestKey: string): Promise<VerificationRecord>;
  cancelRun(recordId: string): Promise<VerificationRecord>;
  close(): Promise<void>;
}
const requirements: ExecutionRequirements = freeze({
  os: ["linux", "darwin", "win32"], capabilities: ["node"], nodeVersion: "24.19.0", isolationRequired: true,
  limits: { timeoutMs: 30000, cpuCores: 1, cpuTimeMs: 30000, memoryMiB: 512, pids: 64, diskMiB: 512, reportBytes: 1048576, logBytes: 65536 },
});
const CLEANUP_TIMEOUT_MS = 5_000;
function confirmed(cleanup: CleanupReport): boolean {
  try {
    object(cleanup, ["processTreeStopped", "workspaceRemoved", "outputBoundaryEnforced"]);
    return cleanup.processTreeStopped === true && cleanup.workspaceRemoved === true && cleanup.outputBoundaryEnforced === true;
  } catch { return false; }
}
function transitionLost(error: unknown): boolean {
  return error instanceof DomainError && (error.code === "LEASE_STALE" || error.code === "INVALID_TRANSITION");
}
async function preflight(provider: VerificationProvider): Promise<CapabilityReport> {
  try {
    const report = await provider.preflight(requirements);
    object(report, ["providerId", "os", "checks", "capabilities", "reasons"]);
    ensure(report.providerId === provider.id);
    ensure(report.os === null || requirements.os.includes(report.os));
    const checks = object(report.checks, VERIFICATION_CHECKS);
    ensure(Object.values(checks).every(value => value === "passed" || value === "failed" || value === "unknown"));
    capabilities(report.capabilities);
    ensure(Array.isArray(report.reasons) && report.reasons.length <= 64);
    report.reasons.forEach(reason => text(reason, 512));
    return freeze(structuredClone(report));
  } catch {
    return freeze({ providerId: provider.id, os: null, capabilities: [],
      checks: { toolchain: "unknown", filesystem: "unknown", network: "unknown", cpu: "unknown", resources: "unknown", processTreeCancel: "unknown", outputBoundary: "unknown", cleanup: "unknown" },
      reasons: ["Provider preflight could not verify the required execution conditions"],
    });
  }
}
interface Attempt {
  record: VerificationRecord;
  controller: AbortController;
  provider: VerificationProvider | null;
  fence: VerificationFence | null;
  stopping: boolean;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  cleanup: Promise<boolean> | null;
  cancellation: Promise<void> | null;
  expiry: Promise<void> | null;
  done: Promise<void>;
  resolve: () => void;
}

/**
 * Portable orchestration over atomic async storage. The caller owns storage and
 * startup recovery. In-process work is local only, not a Worker lifecycle adapter.
 * Production composition must register only createBlockedProvider(). Supported
 * branches exist solely for injected contract-test providers until adapter review.
 */
export async function createDogfoodService(store: DogfoodStore, providers: readonly VerificationProvider[], now: () => number): Promise<DogfoodService> {
  const imports = createImportService(store, now);
  const registered = [...providers];
  const identities = registered.map(provider => text(provider.id, 256));
  ensure(new Set(identities).size === identities.length);
  let reports = await Promise.all(registered.map(preflight));
  let closed = false;
  let closing: Promise<void> | null = null;
  let lastImportedId: string | null = null;
  let reportGeneration = 0;
  const attempts = new Map<string, Attempt>();
  const requests = new Set<Promise<VerificationRecord>>();
  // Lifecycle work can outlive removal of its attempt (for example, a storage
  // completion already in flight when cancellation wins). Drain it separately.
  const lifecycle = new Set<Promise<void>>();
  const errors: unknown[] = [];
  const open = () => ensure(!closed, "INVALID_TRANSITION");
  function stopTimer(attempt: Attempt): void {
    if (attempt.timer !== null) clearTimeout(attempt.timer);
    attempt.timer = null;
  }
  function settle(attempt: Attempt): void {
    stopTimer(attempt);
    attempt.settled = true;
    attempts.delete(attempt.record.id);
    attempt.resolve();
  }
  function background(attempt: Attempt, work: Promise<void>): void {
    const handled = work.catch(error => {
      errors.push(error);
      attempt.controller.abort();
      settle(attempt);
    });
    lifecycle.add(handled);
    void handled.then(() => lifecycle.delete(handled));
  }
  function cleanup(attempt: Attempt, attemptId: string): Promise<boolean> {
    if (attempt.cleanup) return attempt.cleanup;
    const provider = attempt.provider;
    if (!provider) return Promise.resolve(false);
    attempt.cleanup = new Promise(resolve => {
      let finished = false;
      const finish = (value: boolean) => {
        if (finished) return;
        finished = true; clearTimeout(timer); resolve(value);
      };
      const timer = setTimeout(() => finish(false), CLEANUP_TIMEOUT_MS);
      void Promise.resolve().then(() => provider.cancel(attemptId)).then(
        report => finish(confirmed(report)), () => finish(false),
      );
    });
    return attempt.cleanup;
  }
  async function lost(attempt: Attempt): Promise<void> {
    if (attempt.stopping || attempt.settled) return;
    // Another service/owner has invalidated the fence. Retire this local work too.
    attempt.stopping = true; stopTimer(attempt); attempt.controller.abort();
    if (attempt.fence) await cleanup(attempt, attempt.fence.attemptId);
    // A local cancellation may have joined the cleanup while it was pending.
    // Its dedicated finalizer owns settlement until its storage write finishes.
    if (attempt.cancellation) await attempt.cancellation;
    else settle(attempt);
  }
  function timeout(attempt: Attempt): Promise<void> {
    if (attempt.expiry) return attempt.expiry;
    if (attempt.stopping || attempt.settled || !attempt.fence) return Promise.resolve();
    const fence = attempt.fence;
    attempt.expiry = (async () => {
      try { await store.expireVerification(fence, now()); }
      catch (error) { if (!transitionLost(error)) throw error; await lost(attempt); return; }
      attempt.stopping = true; stopTimer(attempt);
      // Await atomic invalidation before either abort or provider cancellation.
      attempt.controller.abort();
      const clean = await cleanup(attempt, fence.attemptId);
      try { await store.finishTimeout(attempt.record.id, clean, now()); }
      catch (error) { if (!transitionLost(error)) throw error; }
      settle(attempt);
    })();
    return attempt.expiry;
  }
  async function finish(attempt: Attempt, completion: VerificationCompletion): Promise<void> {
    if (attempt.stopping || attempt.settled || !attempt.fence) return;
    const at = now(); // Sample after provider work/cleanup, immediately before storage.
    if (at >= attempt.fence.expiresAt) { await timeout(attempt); return; }
    try { await store.finishVerification(attempt.fence, completion, at); settle(attempt); }
    catch (error) { if (!transitionLost(error)) throw error; await lost(attempt); }
  }
  async function fail(attempt: Attempt, code: string): Promise<void> {
    if (attempt.stopping || attempt.settled || !attempt.fence) return;
    if (now() >= attempt.fence.expiresAt) { await timeout(attempt); return; }
    attempt.controller.abort();
    const clean = await cleanup(attempt, attempt.fence.attemptId);
    // The sealed completion port has no cleanupCode field. Normal failures expose
    // uncertainty through code; cancellation/timeout use their dedicated finalizers.
    await finish(attempt, { state: "failed", code: clean ? code : "CLEANUP_UNCONFIRMED", evidence: null, assessment: null });
  }
  async function result(attempt: Attempt, snapshot: InventorySnapshot, value: ProviderResult): Promise<void> {
    if (attempt.stopping || attempt.settled || !attempt.fence) return;
    if (now() >= attempt.fence.expiresAt) { await timeout(attempt); return; }
    let completion: VerificationCompletion | null = null;
    try {
      object(value, ["evidence", "cleanup"]);
      assertParsedBaseline(value.evidence, snapshot);
      ensure(value.evidence.attemptKey === attempt.fence.attemptId && value.evidence.profileId === attempt.record.profileId);
      if (confirmed(value.cleanup)) {
        const assessment = assessReport(value.evidence, CONFIG_RUNTIME_SMOKE_V1);
        completion = { state: assessment.status, code: assessment.code, evidence: value.evidence, assessment };
      }
    } catch { await fail(attempt, "INVALID_PROVIDER_RESULT"); return; }
    if (completion === null) { await fail(attempt, "CLEANUP_UNCONFIRMED"); return; }
    await finish(attempt, completion);
  }
  async function execute(attempt: Attempt): Promise<void> {
    try {
      if (attempt.stopping || attempt.settled) return;
      const snapshot = await store.getInventory(attempt.record.snapshotId);
      ensure(snapshot && snapshot.digest === attempt.record.sourceDigest && attempt.record.profileId === CONFIG_RUNTIME_SMOKE_V1.id);
      if (attempt.stopping || attempt.settled) return;
      const generation = ++reportGeneration;
      const currentReports = await Promise.race([
        Promise.all(registered.map(preflight)),
        attempt.done.then(() => null),
      ]);
      if (currentReports === null || attempt.stopping || attempt.settled) return;
      if (generation === reportGeneration) reports = currentReports;
      const selection = selectProvider(requirements, currentReports);
      const provider = registered.find(item => item.id === selection.providerId);
      if (!provider) {
        await store.blockVerification(attempt.record.id, "PROVIDER_UNSUPPORTED", now());
        settle(attempt); return;
      }
      attempt.provider = provider;
      attempt.fence = freeze(await store.beginVerification({
        recordId: attempt.record.id, attemptId: "attempt_" + globalThis.crypto.randomUUID(),
        runnerId: provider.id, now: now(), leaseMs: requirements.limits.timeoutMs,
      }));
      if (attempt.stopping || attempt.settled) return;
      if (now() >= attempt.fence.expiresAt) { await timeout(attempt); return; }
      attempt.timer = setTimeout(() => background(attempt, timeout(attempt)), Math.max(0, attempt.fence.expiresAt - now()));
      const input = freeze({ snapshot, profile: CONFIG_RUNTIME_SMOKE_V1, fence: attempt.fence, requirements });
      try {
        const pending = provider.run(input, attempt.controller.signal);
        // An unresponsive provider must not hold shutdown open. Only its result
        // handling, once started, owns lifecycle/storage work that close drains.
        void pending.then(value => {
          if (!attempt.stopping && !attempt.settled) background(attempt, result(attempt, snapshot, value));
        }, () => {
          if (!attempt.stopping && !attempt.settled) background(attempt, fail(attempt, "PROVIDER_ERROR"));
        });
      } catch { await fail(attempt, "PROVIDER_ERROR"); }
    } catch (error) { if (!transitionLost(error)) throw error; await lost(attempt); }
  }
  async function cancelRun(recordId: string): Promise<VerificationRecord> {
    // Retain local ownership even if lost-fence cleanup removes the map entry
    // before this asynchronous receipt is delivered.
    const attempt = attempts.get(recordId);
    const record = await store.requestCancellation(recordId, now());
    if (!attempt) {
      // No ownership of an external/live attempt is inferred from a stored row.
      const finalizing = store.finishCancellation(recordId, record.attemptId === null, now())
        .then(() => {}, error => { if (!transitionLost(error)) errors.push(error); });
      lifecycle.add(finalizing);
      void finalizing.then(() => lifecycle.delete(finalizing));
      return record;
    }
    if (!attempt.cancellation) {
      attempt.stopping = true; stopTimer(attempt); attempt.controller.abort();
      attempt.cancellation = (async () => {
        const clean = record.attemptId === null || await cleanup(attempt, record.attemptId);
        try { await store.finishCancellation(recordId, clean, now()); }
        catch (error) { if (!transitionLost(error)) throw error; }
        settle(attempt);
      })();
      background(attempt, attempt.cancellation);
    }
    return record;
  }
  function requestRun(snapshotId: string, requestKey: string): Promise<VerificationRecord> {
    const pending = (async () => {
      open();
      const receipt = await store.createVerification({ snapshotId, requestKey, now: now() });
      if (receipt.created) {
        let resolve!: () => void;
        const done = new Promise<void>(finish => { resolve = finish; });
        const attempt: Attempt = { record: receipt.record, controller: new AbortController(), provider: null, fence: null,
          stopping: false, settled: false, timer: null, cleanup: null, cancellation: null, expiry: null, done, resolve };
        attempts.set(receipt.record.id, attempt);
        if (closed) background(attempt, cancelRun(receipt.record.id).then(() => {}));
        else queueMicrotask(() => background(attempt, execute(attempt)));
      }
      return receipt.record;
    })();
    return trackRequest(pending);
  }
  function trackRequest(pending: Promise<VerificationRecord>): Promise<VerificationRecord> {
    requests.add(pending);
    void pending.then(() => requests.delete(pending), () => requests.delete(pending));
    return pending;
  }
  return {
    async importSource(bytes) {
      open();
      const snapshot = await imports.importSource(bytes);
      lastImportedId = snapshot.id;
      return snapshot;
    },
    async importBaseline(snapshotId, bytes) {
      open();
      return imports.importBaseline(snapshotId, bytes);
    },
    async importHead(observation) { open(); await imports.importHead(observation); },
    async getState(snapshotId) {
      const snapshots = await store.listInventory();
      const selectedSnapshotId = snapshotId ?? lastImportedId ?? snapshots.at(-1)?.id ?? null;
      const snapshot = snapshots.find(item => item.id === selectedSnapshotId);
      ensure(selectedSnapshotId === null || snapshot, "NOT_FOUND");
      const [headObservation, history] = snapshot
        ? await Promise.all([store.getHeadObservation(snapshot), store.listVerifications(snapshot.id)]) : [null, []];
      return freeze({ snapshots, selectedSnapshotId, freshness: snapshot ? deriveFreshness(snapshot, headObservation) : "freshness_unknown",
        headObservation, history, profile: CONFIG_RUNTIME_SMOKE_V1, providers: [...reports] });
    },
    requestRun,
    cancelRun(recordId) { return trackRequest((async () => { open(); return cancelRun(recordId); })()); },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        await Promise.allSettled([...requests]);
        const owned = [...attempts.values()];
        await Promise.all(owned.map(async attempt => {
          if (!attempt.stopping && !attempt.settled) {
            try { await cancelRun(attempt.record.id); }
            catch (error) { if (!transitionLost(error)) throw error; await lost(attempt); }
          }
          await attempt.done;
        }));
        // Completing one operation can enqueue another finalization. A map of
        // active attempts, or a single snapshot of pending work, is insufficient.
        while (lifecycle.size) await Promise.all([...lifecycle]);
        if (errors.length) throw new DomainError("CONFLICT");
      })();
      return closing;
    },
  };
}
