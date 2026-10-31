// Provider-independent, side-effect-free build lifecycle validation.
// Integrators must persist transitions atomically with optimistic version checks.
const transitions = Object.freeze({
  unconfigured: ["authorized"],
  authorized: ["queued", "unconfigured"],
  queued: ["running", "cancelled", "failed", "unknown"],
  running: ["succeeded", "failed", "cancelled", "unknown"],
  unknown: ["running", "succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
});
const MAX_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export function nextBuildState(current, event, scope) {
  if (!current || !scope || !Number.isSafeInteger(current.version) || current.version < 0)
    throw new Error("BUILD_STATE_INVALID");
  if (!MAX_ID.test(scope.appId ?? "") || !MAX_ID.test(scope.jobId ?? "") ||
      scope.appId !== current.appId || scope.jobId !== current.jobId)
    throw new Error("BUILD_SCOPE_MISMATCH");
  if (!event || typeof event !== "object" || !Object.hasOwn(transitions, current.status)
      || !transitions[current.status].includes(event.status))
    throw new Error("BUILD_TRANSITION_DENIED");
  if (typeof event.idempotencyKey !== "string" || !/^[a-f0-9]{32,64}$/.test(event.idempotencyKey))
    throw new Error("BUILD_IDEMPOTENCY_REQUIRED");
  if (event.status === "succeeded" && event.artifactIntegrityVerified !== true)
    throw new Error("BUILD_ARTIFACT_NOT_VERIFIED");
  if (event.status === "succeeded" && event.executionVerified !== true)
    throw new Error("BUILD_EXECUTION_NOT_VERIFIED");
  return Object.freeze({
    appId: current.appId,
    jobId: current.jobId,
    version: current.version + 1,
    status: event.status,
    idempotencyKey: event.idempotencyKey,
    // No raw credentials, logs, artifact paths or provider responses are copied.
    artifactIntegrityVerified: event.status === "succeeded",
    signatureVerified: false,
    installVerified: false,
  });
}
export function isTerminalBuildState(status) {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
