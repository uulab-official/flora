import { randomBytes } from 'node:crypto';
import { runLocalBuild, snapshotLocalRecipe } from './local-build-runner.mjs';
import { isRecord, isBuildId, snapshotBuildScope, snapshotBuildEvent } from './build-lifecycle.mjs';

const safeReason = error => /^(BUILD|ARTIFACT)_[A-Z_]{1,80}$/.test(error?.message ?? '') ? error.message : 'BUILD_RUNNER_FAILED';
function fields(input, keys) {
  if (!isRecord(input) || Object.keys(input).some(k => !keys.includes(k))) throw new Error('BUILD_REQUEST_INVALID');
}
export function snapshotBuildPresets(input, appIds) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 32) throw new Error('BUILD_PRESET_CONFIG_INVALID');
  const ids = new Set();
  return Object.freeze(input.map(p => {
    if (!isRecord(p) || Object.keys(p).some(k => !['id', 'label', 'recipe'].includes(k)) || !isBuildId(p.id) || ids.has(p.id)
        || typeof p.label !== 'string' || p.label.trim() !== p.label || !p.label || p.label.length > 80 || /[\x00-\x1f\x7f]/.test(p.label))
      throw new Error('BUILD_PRESET_CONFIG_INVALID');
    ids.add(p.id);
    let recipe; try { recipe = snapshotLocalRecipe(p.recipe); } catch { throw new Error('BUILD_PRESET_CONFIG_INVALID'); }
    if (!appIds.includes(recipe.appId) || !isBuildId(recipe.runnerId) || typeof recipe.repository !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(recipe.repository) || /\s/.test(recipe.repository)
        || !['ios', 'android'].includes(recipe.platform) || (recipe.platform === 'ios' ? recipe.format !== 'ipa' : recipe.format === 'ipa'))
      throw new Error('BUILD_PRESET_CONFIG_INVALID');
    return Object.freeze({ id: p.id, label: p.label, recipe });
  }));
}
// Not a remote runner or execution sandbox. Only operator-reviewed presets are accepted.
// Admission responses are bounded, process-local. Durable job CAS remains the execution gate.
export function createBuildController({ directory, service, presets, appIds, maxConcurrent = 1 }) {
  if (!Array.isArray(appIds) || !appIds.length || appIds.some(id => !isBuildId(id))
      || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4) throw new Error('BUILD_PRESET_CONFIG_INVALID');
  const allowed = new Set(appIds), registry = new Map(snapshotBuildPresets(presets, appIds).map(p => [p.id, p]));
  const records = new Map(), active = new Map(); let closing = false, closePromise;
  const scopeId = scope => JSON.stringify([scope.appId, scope.jobId]);
  function scoped(value) { const scope = snapshotBuildScope(value); if (!allowed.has(scope.appId)) throw new Error('BUILD_APP_FORBIDDEN'); return scope; }
  function publicRecord(r, replayed = false) {
    const status = service.show(r.scope).job.status;
    return Object.freeze({ id: r.id, presetId: r.presetId, appId: r.scope.appId, jobId: r.scope.jobId,
      phase: r.phase === 'starting' && status === 'running' ? 'running' : r.phase, status, canStop: !r.settled && !r.controller.signal.aborted,
      startedAt: r.startedAt, finishedAt: r.finishedAt ?? null, reason: r.reason ?? null, ...(replayed ? { replayed: true } : {}) });
  }
  function last(scope) { return [...records.values()].reverse().find(r => scopeId(r.scope) === scopeId(scope)); }
  function reserve() {
    if (records.size < 256) return;
    for (const [key, record] of records) if (record.settled) { records.delete(key); return; }
    throw new Error('BUILD_EXECUTION_LIMIT');
  }
  async function perform(record, recipe, expectedVersion) {
    try {
      const result = await runLocalBuild({ directory, scope: record.scope, recipe, expectedVersion, execute: true, signal: record.controller.signal });
      record.reason = result.reason ?? null; record.phase = 'finished';
    } catch (error) {
      record.reason = safeReason(error); record.phase = 'blocked';
      try {
        const current = service.show(record.scope).job;
        if (record.controller.signal.aborted && current.status === 'queued' && current.version === expectedVersion) {
          await service.transition({ scope: record.scope, expectedVersion, event: { status: 'cancelled', idempotencyKey: randomBytes(24).toString('hex'), failureCode: 'BUILD_PROCESS_ABORTED' } });
          record.phase = 'finished';

        }
      } catch { record.reason = 'BUILD_RESULT_RECONCILIATION_REQUIRED'; }
    } finally { record.settled = true; record.finishedAt = new Date().toISOString(); active.delete(scopeId(record.scope)); }
  }
  return Object.freeze({
    list(appId) {
      if (!allowed.has(appId)) throw new Error('BUILD_APP_FORBIDDEN');
      return [...registry.values()].filter(p => p.recipe.appId === appId).map(p => Object.freeze({
        id: p.id, label: p.label, appId, repository: p.recipe.repository, runnerId: p.recipe.runnerId, platform: p.recipe.platform, format: p.recipe.format,
      }));
    },
    state(value) { const scope = scoped(value); service.show(scope); const r = last(scope); return r ? publicRecord(r) : null; },
    start(input) {
      if (closing) throw new Error('BUILD_CONSOLE_CLOSING');
      fields(input, ['scope', 'presetId', 'expectedVersion', 'idempotencyKey']);
      const scope = scoped(input.scope), { presetId, expectedVersion, idempotencyKey } = input;
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion >= Number.MAX_SAFE_INTEGER) throw new Error('BUILD_VERSION_INVALID');
      snapshotBuildEvent({ status: 'running', idempotencyKey });
      const key = JSON.stringify([scopeId(scope), idempotencyKey]), existing = records.get(key);
      if (existing) {
        if (existing.presetId !== presetId || existing.expectedVersion !== expectedVersion) throw new Error('BUILD_IDEMPOTENCY_CONFLICT');
        return publicRecord(existing, true);
      }
      const preset = registry.get(presetId); if (!preset) throw new Error('BUILD_PRESET_NOT_FOUND');
      const job = service.show(scope).job;
      if (active.has(scopeId(scope))) throw new Error('BUILD_EXECUTION_ACTIVE');
      if (job.version !== expectedVersion) throw new Error('BUILD_VERSION_CONFLICT');
      if (job.status !== 'queued') throw new Error('BUILD_NOT_QUEUED');
      if (['appId', 'repository', 'runnerId', 'platform'].some(k => preset.recipe[k] !== job[k])) throw new Error('BUILD_RECIPE_SCOPE_MISMATCH');
      if (active.size >= maxConcurrent) throw new Error('BUILD_EXECUTION_LIMIT'); reserve();
      const record = { id: randomBytes(16).toString('hex'), scope, presetId, expectedVersion, controller: new AbortController(), phase: 'starting', settled: false, startedAt: new Date().toISOString() };
      records.set(key, record); active.set(scopeId(scope), record);
      record.task = Promise.resolve().then(() => perform(record, preset.recipe, expectedVersion));
      return publicRecord(record);
    },
    stop(input) {
      fields(input, ['scope', 'expectedVersion']); const scope = scoped(input.scope), current = service.show(scope).job;
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion !== current.version) throw new Error('BUILD_VERSION_CONFLICT');
      const record = active.get(scopeId(scope)); if (!record) throw new Error('BUILD_RUNNER_NOT_MANAGED');
      record.phase = 'stopping'; record.controller.abort(); return publicRecord(record);
    },
    close() {
      if (!closePromise) {
        closing = true;
        const tasks = [...active.values()];
        for (const record of tasks) { record.phase = 'stopping'; record.controller.abort(); }
        closePromise = Promise.allSettled(tasks.map(r => r.task)).then(() => undefined);
      }
      return closePromise;
    },
  });
}
