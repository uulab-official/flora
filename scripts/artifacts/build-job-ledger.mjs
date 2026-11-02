import { nextBuildState } from "./build-lifecycle.mjs";

// An in-memory reference ledger for concurrency tests and local dry-run use.
// Production deployments MUST use durable storage with atomic CAS/uniqueness.
const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export class BuildJobLedger {
  #jobs = new Map();
  #keys = new Map();
  #locks = new Map();

  create(job) {
    if (!job || !VALID_ID.test(job.appId ?? "") || !VALID_ID.test(job.jobId ?? "") ||
        job.status !== "unconfigured" || job.version !== 0)
      throw new Error("BUILD_INITIAL_STATE_INVALID");
    const id = JSON.stringify([job.appId, job.jobId]);
    if (this.#jobs.has(id)) throw new Error("BUILD_JOB_ALREADY_EXISTS");
    const snapshot = Object.freeze({ appId: job.appId, jobId: job.jobId, status: "unconfigured", version: 0 });
    this.#jobs.set(id, snapshot);
    return snapshot;
  }

  get(scope) {
    const record = this.#jobs.get(JSON.stringify([scope?.appId, scope?.jobId]));
    if (!record) throw new Error("BUILD_JOB_NOT_FOUND");
    return record;
  }

  async transition({ scope, event, expectedVersion }) {
    const id = JSON.stringify([scope?.appId, scope?.jobId]);
    const previous = this.#locks.get(id) ?? Promise.resolve();
    let unlock;
    const next = new Promise(resolve => { unlock = resolve; });
    this.#locks.set(id, next);
    await previous;
    try {
      const current = this.get(scope);
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error("BUILD_VERSION_INVALID");
      const key = JSON.stringify([id, event?.idempotencyKey]);
      const deduped = this.#keys.get(key);
      if (deduped) {
        if (deduped.status !== event.status || deduped.artifactIntegrityVerified !== event.artifactIntegrityVerified || deduped.executionVerified !== event.executionVerified) throw new Error("BUILD_IDEMPOTENCY_CONFLICT");
        return Object.freeze({ ...deduped.result, replayed: true });
      }
      if (current.version !== expectedVersion) throw new Error("BUILD_VERSION_CONFLICT");
      const result = nextBuildState(current, event, scope);
      this.#jobs.set(id, result);
      this.#keys.set(key, { status: event.status, artifactIntegrityVerified: event.artifactIntegrityVerified, executionVerified: event.executionVerified, result });
      return result;
    } finally {
      unlock();
      if (this.#locks.get(id) === next) this.#locks.delete(id);
    }
  }
}
