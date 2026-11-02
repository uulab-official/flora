import { nextBuildState, isBuildId, isRecord, snapshotBuildScope, snapshotBuildEvent } from './build-lifecycle.mjs';

// Reference-only memory ledger. Use durable-build-ledger.mjs for restart-safe local operations.
export class BuildJobLedger {
  #jobs = new Map();
  #keys = new Map();
  #locks = new Map();
  create(job) {
    if (!isRecord(job) || !isBuildId(job.appId) || !isBuildId(job.jobId)
        || job.status !== 'unconfigured' || job.version !== 0) throw new Error('BUILD_INITIAL_STATE_INVALID');
    const scope = snapshotBuildScope(job), id = JSON.stringify(scope);
    if (this.#jobs.has(id)) throw new Error('BUILD_JOB_ALREADY_EXISTS');
    const result = Object.freeze({ ...scope, status: 'unconfigured', version: 0 });
    this.#jobs.set(id, result); return result;
  }
  get(scope) {
    const result = this.#jobs.get(JSON.stringify(snapshotBuildScope(scope)));
    if (!result) throw new Error('BUILD_JOB_NOT_FOUND');
    return result;
  }
  async transition({ scope, event, expectedVersion }) {
    scope = snapshotBuildScope(scope); event = snapshotBuildEvent(event);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('BUILD_VERSION_INVALID');
    const id = JSON.stringify(scope), fingerprint = JSON.stringify([expectedVersion, event]);
    const previous = this.#locks.get(id) ?? Promise.resolve();
    let unlock;
    const next = new Promise(resolve => { unlock = resolve; }); this.#locks.set(id, next);
    await previous;
    try {
      const current = this.get(scope), key = JSON.stringify([id, event.idempotencyKey]), prior = this.#keys.get(key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error('BUILD_IDEMPOTENCY_CONFLICT');
        return Object.freeze({ ...prior.result, replayed: true });
      }
      if (current.version !== expectedVersion) throw new Error('BUILD_VERSION_CONFLICT');
      const result = nextBuildState(current, event, scope);
      this.#jobs.set(id, result); this.#keys.set(key, { fingerprint, result }); return result;
    } finally { unlock(); if (this.#locks.get(id) === next) this.#locks.delete(id); }
  }
}
