// These validators are not authentication. Callers must resolve an authorized job first.
const transitions = Object.freeze({
  unconfigured: ['authorized'], authorized: ['queued', 'unconfigured'],
  queued: ['running', 'cancelled', 'failed', 'unknown'],
  running: ['succeeded', 'failed', 'cancelled', 'unknown'],
  unknown: ['running', 'succeeded', 'failed', 'cancelled'],
  succeeded: [], failed: [], cancelled: [],
});
export const isBuildId = value => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) && !/\s/.test(value);
export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function snapshotBuildScope(scope) {
  if (!isRecord(scope) || !isBuildId(scope.appId) || !isBuildId(scope.jobId)) throw new Error('BUILD_SCOPE_MISMATCH');
  return Object.freeze({ appId: scope.appId, jobId: scope.jobId });
}
export function snapshotBuildEvent(event) {
  if (!isRecord(event) || typeof event.status !== 'string' || !Object.hasOwn(transitions, event.status))
    throw new Error('BUILD_TRANSITION_DENIED');
  if (typeof event.idempotencyKey !== 'string' || !/^[a-f0-9]{32,64}$/.test(event.idempotencyKey)
      || /\s/.test(event.idempotencyKey)) throw new Error('BUILD_IDEMPOTENCY_REQUIRED');
  for (const name of ['artifactIntegrityVerified', 'executionVerified']) {
    if (event[name] !== undefined && typeof event[name] !== 'boolean') throw new Error('BUILD_EVIDENCE_INVALID');
  }
  const codes = ['BUILD_PROCESS_FAILED', 'BUILD_PROCESS_TIMEOUT', 'BUILD_PROCESS_OUTPUT_LIMIT',
    'BUILD_PROCESS_START_FAILED', 'BUILD_PROCESS_ABORTED', 'BUILD_RESULT_RECONCILIATION_REQUIRED'];
  if (event.failureCode !== undefined && (!['failed', 'unknown', 'cancelled'].includes(event.status) || !codes.includes(event.failureCode)))
    throw new Error('BUILD_EVIDENCE_INVALID');
  return Object.freeze({ status: event.status, idempotencyKey: event.idempotencyKey,
    ...(event.failureCode !== undefined ? { failureCode: event.failureCode } : {}),
    artifactIntegrityVerified: event.artifactIntegrityVerified === true, executionVerified: event.executionVerified === true });
}
export function nextBuildState(current, event, scope) {
  if (!isRecord(current) || !Number.isSafeInteger(current.version) || current.version < 0
      || current.version >= Number.MAX_SAFE_INTEGER) throw new Error('BUILD_STATE_INVALID');
  const identity = snapshotBuildScope(scope), input = snapshotBuildEvent(event);
  if (identity.appId !== current.appId || identity.jobId !== current.jobId) throw new Error('BUILD_SCOPE_MISMATCH');
  if (typeof current.status !== 'string' || !Object.hasOwn(transitions, current.status)
      || !transitions[current.status].includes(input.status)) throw new Error('BUILD_TRANSITION_DENIED');
  if (input.status === 'succeeded' && !input.artifactIntegrityVerified) throw new Error('BUILD_ARTIFACT_NOT_VERIFIED');
  if (input.status === 'succeeded' && !input.executionVerified) throw new Error('BUILD_EXECUTION_NOT_VERIFIED');
  return Object.freeze({ ...identity, version: current.version + 1, status: input.status,
    idempotencyKey: input.idempotencyKey, artifactIntegrityVerified: input.status === 'succeeded',
    signatureVerified: false, installVerified: false, failureCode: input.failureCode ?? null });
}
export function isTerminalBuildState(status) {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}
