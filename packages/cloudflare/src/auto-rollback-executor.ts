import { DomainError } from "@app-ops/core";
import type { OTADeployment, OperationsService, OperationsStore } from "@app-ops/dogfood";
import type { AutoRollbackClaim, AutoRollbackDecision, AutoRollbackStore } from "./auto-rollback.js";
import { HttpFailure } from "./http.js";

export interface AutoRollbackExecutorDependencies {
  autoRollback: AutoRollbackStore;
  decisionId: string;
  now: () => number;
  /** Read-only owner/config fenced lookup; policy changes must not hide a receipt. */
  readReceipt(claim: AutoRollbackClaim): Promise<OTADeployment | null>;
  /** The factory must compose guard with its owner/config fence before each D1
   * submission. In particular saveOTARollback must fence its final batch. */
  createOperations(claim: AutoRollbackClaim, guard: () => void): { operations: OperationsService; store: OperationsStore };
  isHealthy(ownerId: string, appId: string, deploymentId: string): boolean;
}
const maximumAttempts = 8;
function sameScope(deployment: OTADeployment, claim: AutoRollbackClaim): boolean {
  return deployment.appId === claim.appId && deployment.platform === claim.platform && deployment.channel === claim.channel && deployment.runtimeVersion === claim.runtimeVersion;
}
function receiptMatches(receipt: OTADeployment, claim: AutoRollbackClaim): boolean {
  return sameScope(receipt, claim) && receipt.requestKey === claim.requestKey && receipt.id !== claim.sourceDeploymentId && receipt.id !== claim.targetDeploymentId && receipt.createdAt > claim.publishedAt &&
    receipt.rollback?.fromDeploymentId === claim.sourceDeploymentId && receipt.rollback.targetDeploymentId === claim.targetDeploymentId && receipt.rollback.reason === claim.reason;
}
function failure(code: string): never { throw new HttpFailure(409, code); }

/** One durable decision, one immutable request key, no fleet reads or export. A
 * lost commit response is reconciled before every retry and terminal transition. */
export async function executeAutoRollback(deps: AutoRollbackExecutorDependencies): Promise<AutoRollbackDecision | null> {
  const auto = deps.autoRollback, claim = auto.claim(deps.decisionId, deps.now());
  if (!claim) return null;
  const finish = (receipt: OTADeployment): AutoRollbackDecision | null => receiptMatches(receipt, claim)
    ? auto.succeed(claim.id, receipt.id, deps.now(), claim.claimVersion)
    : auto.fail(claim.id, "AUTO_ROLLBACK_RECEIPT_CONFLICT", deps.now(), claim.claimVersion);
  const defer = (code: string): AutoRollbackDecision | null => {
    const now = deps.now();
    return auto.defer(claim.id, code, now, claim.claimVersion, now + Math.min(300_000, 60_000 * Math.max(1, claim.attemptCount)));
  };
  const pendingConfirmation = (): AutoRollbackDecision | null => {
    const now = deps.now(), readyAt = auto.confirmationReadyAt(claim.id) ?? now + 120_000;
    return auto.defer(claim.id, "AUTO_ROLLBACK_CONFIRMATION_PENDING", now, claim.claimVersion, Math.max(now + 1, readyAt));
  };
  const guard = (): void => {
    const reason = auto.invalidationReason(claim.id, claim.claimVersion, deps.now());
    if (reason) failure(reason);
  };
  let receipt: OTADeployment | null;
  try { receipt = await deps.readReceipt(claim); }
  catch { return defer("AUTO_ROLLBACK_RECEIPT_UNAVAILABLE"); }
  if (receipt) return finish(receipt);
  const invalid = auto.invalidationReason(claim.id, claim.claimVersion, deps.now());
  if (invalid === "AUTO_ROLLBACK_CONFIRMATION_PENDING") return pendingConfirmation();
  if (invalid) return auto.skip(claim.id, invalid, deps.now(), claim.claimVersion);
  if (claim.attemptCount > maximumAttempts) return auto.fail(claim.id, "AUTO_ROLLBACK_ATTEMPTS_EXHAUSTED", deps.now(), claim.claimVersion);
  try {
    guard();
    const { operations, store } = deps.createOperations(claim, guard);
    const [source, target] = await Promise.all([store.getOTADeployment(claim.appId, claim.sourceDeploymentId), store.getOTADeployment(claim.appId, claim.targetDeploymentId)]);
    guard();
    if (!source || !target) failure("AUTO_ROLLBACK_DEPLOYMENT_UNAVAILABLE");
    if (!sameScope(source, claim) || !sameScope(target, claim) || source.id !== claim.sourceDeploymentId || target.id !== claim.targetDeploymentId || source.createdAt !== claim.publishedAt || target.createdAt >= source.createdAt) failure("AUTO_ROLLBACK_SCOPE_MISMATCH");
    if (source.rollback) failure("AUTO_ROLLBACK_LOOP_BLOCKED");
    if (!deps.isHealthy(claim.ownerId, claim.appId, claim.targetDeploymentId)) failure("AUTO_ROLLBACK_TARGET_UNHEALTHY");
    const latest = await store.getLatestOTADeployment(claim.appId, { platform: claim.platform, channel: claim.channel, runtimeVersion: claim.runtimeVersion });
    guard();
    if (latest?.id !== claim.sourceDeploymentId) failure("AUTO_ROLLBACK_SOURCE_STALE");
    const published = await operations.rollback(claim.appId, { requestKey: claim.requestKey, fromDeploymentId: claim.sourceDeploymentId, targetDeploymentId: claim.targetDeploymentId, reason: claim.reason });
    return finish(published);
  } catch (error) {
    // A transport error can follow a committed D1 batch. Never turn such an
    // error into a second publication or hide it behind a disabled policy.
    try { receipt = await deps.readReceipt(claim); }
    catch { return defer("AUTO_ROLLBACK_RECEIPT_UNAVAILABLE"); }
    if (receipt) return finish(receipt);
    const code = error instanceof HttpFailure || error instanceof DomainError ? error.code : null;
    // A simultaneous disable does not resolve an in-flight ambiguous write.
    // Retain its lease until a later receipt read can settle it safely.
    const invalid = auto.invalidationReason(claim.id, claim.claimVersion, deps.now());
    if (invalid === "AUTO_ROLLBACK_CONFIRMATION_PENDING") return pendingConfirmation();
    if (invalid) return code
      ? auto.skip(claim.id, invalid, deps.now(), claim.claimVersion)
      : defer("AUTO_ROLLBACK_EXECUTION_UNCERTAIN");
    if (code === "CONFIG_CONFLICT" || code === "AUTO_ROLLBACK_SOURCE_STALE") return auto.skip(claim.id, "AUTO_ROLLBACK_SOURCE_STALE", deps.now(), claim.claimVersion);
    if (code && (code.startsWith("AUTO_ROLLBACK_") || error instanceof DomainError || error instanceof HttpFailure && error.status < 500)) return auto.fail(claim.id, code, deps.now(), claim.claimVersion);
    if (claim.attemptCount >= maximumAttempts) return auto.fail(claim.id, "AUTO_ROLLBACK_ATTEMPTS_EXHAUSTED", deps.now(), claim.claimVersion);
    return defer("AUTO_ROLLBACK_EXECUTION_UNCERTAIN");
  }
}
