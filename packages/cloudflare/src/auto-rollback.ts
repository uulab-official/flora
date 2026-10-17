import type { DurableObject } from "cloudflare:workers";
import { canonicalJson } from "@app-ops/config";
import { id, object, text } from "@app-ops/core";
import { HttpFailure } from "./http.js";

type Storage = ConstructorParameters<typeof DurableObject>[0]["storage"];
type Platform = "ios" | "android";
export interface AutoRollbackPolicyInput {
  expectedVersion: number;
  enabled: boolean;
  failureRatePercent: number;
  minInstallations: number;
  windowMinutes: number;
  channel: string;
  targets: { ios: string | null; android: string | null };
}
export interface AutoRollbackPolicy extends Omit<AutoRollbackPolicyInput, "expectedVersion"> {
  appId: string;
  version: number;
  updatedAt: number;
}
export interface AutoRollbackObservation {
  ownerId: string; appId: string; deploymentId: string; platform: Platform;
  channel: string; runtimeVersion: string; publishedAt: number; isRollback: boolean;
  installationHash: string;
  events: Array<{ type: string; observedAt: number; stage?: string; code?: string }>;
}
export interface AutoRollbackDecision {
  id: string; requestKey: string; ownerId: string; appId: string;
  sourceDeploymentId: string; targetDeploymentId: string; rollbackDeploymentId: string | null;
  platform: Platform; channel: string; runtimeVersion: string; publishedAt: number;
  policyVersion: number; policy: AutoRollbackPolicy;
  attemptedInstallations: number; failedInstallations: number; failureRatePercent: number;
  status: "queued" | "executing" | "retrying" | "succeeded" | "failed" | "skipped";
  triggeredAt: number; updatedAt: number; nextAttemptAt: number | null;
  attemptCount: number; claimVersion: number; lastErrorCode: string | null; reason: string;
  confirmationDelaySeconds?: 120;
  cancellation?: AutoRollbackCancellation;
}
/** Server-time terminal recheck, separate from the immutable triggering snapshot.
 * Cancellation alone never establishes a healthy launch or successful recovery. */
export interface AutoRollbackCancellation {
  checkedAt: number;
  attemptedInstallations: number;
  failedInstallations: number;
  confirmedHealthyInstallations: number;
  failureRatePercent: number | null;
}
export interface AutoRollbackClaim extends AutoRollbackDecision { policyCurrent: boolean }
export interface AutoRollbackState {
  appId: string; policy: AutoRollbackPolicy | null; decisions: AutoRollbackDecision[]; capacityLimited: boolean;
  eligibleInstallations: number;
  installationHistory: AutoRollbackInstallationChange[];
}
export interface AutoRollbackInstallationChange {
  id: string; installationLabel: string; enabled: boolean; previousEnabled: boolean | null; changedAt: number;
}
interface AuthorizedInstallation { enabled: boolean; label: string; version: number; createdAt: number; updatedAt: number }
interface ScopeCounts { attemptedInstallations: number; failedInstallations: number; smallSample?: true; confirmationReadyAt?: number; capacityLimited?: true }
interface SmallSampleEvidence { activationAt: number; rollbackAt: number; successAt: number }
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const activeStatuses = ["queued", "executing", "retrying"];
const maximumInstallations = 20_000, maximumSources = 2_000, maximumDecisions = 2_000, executionLease = 60_000;
const invalid = (): never => { throw new HttpFailure(400, "INVALID_AUTO_ROLLBACK_POLICY"); };
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return invalid();
  return value;
}
function deploymentId(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) return invalid();
  return value;
}
function safeText(value: unknown, length: number): string {
  const parsed = text(value, length);
  if (!parsed.trim() || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(parsed)) return invalid();
  return parsed;
}
export function parseAutoRollbackPolicyInput(input: unknown): AutoRollbackPolicyInput {
  const value = object(input, ["expectedVersion", "enabled", "failureRatePercent", "minInstallations", "windowMinutes", "channel", "targets"]);
  const targets = object(value.targets, ["ios", "android"]);
  if (typeof value.enabled !== "boolean") return invalid();
  const parsed: AutoRollbackPolicyInput = {
    expectedVersion: integer(value.expectedVersion, 0, Number.MAX_SAFE_INTEGER - 1),
    enabled: value.enabled,
    failureRatePercent: integer(value.failureRatePercent, 1, 100),
    minInstallations: integer(value.minInstallations, 1, 10_000),
    windowMinutes: integer(value.windowMinutes, 1, 1_440),
    channel: safeText(value.channel, 128),
    targets: { ios: targets.ios === null ? null : deploymentId(targets.ios), android: targets.android === null ? null : deploymentId(targets.android) },
  };
  if (parsed.enabled && parsed.minInstallations < 5 && parsed.failureRatePercent !== 100) return invalid();
  if (parsed.enabled && !parsed.targets.ios && !parsed.targets.android) return invalid();
  return parsed;
}

/** Additive DO-only policy and unique-installation accounting. observe is synchronous
 * so its accounting and intent commit in the caller's accepted SDK transaction.
 * No history is backfilled, no app is polled, and a full budget fails safe without
 * rejecting an SDK report or deleting an older policy, decision, or event. */
export class AutoRollbackStore {
  constructor(private readonly storage: Storage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS flora_auto_rollback_meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS flora_auto_rollback_policies(owner_id TEXT NOT NULL,app_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(owner_id,app_id));
      CREATE TABLE IF NOT EXISTS flora_auto_rollback_sources(owner_id TEXT NOT NULL,app_id TEXT NOT NULL,deployment_id TEXT NOT NULL,policy_version INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(owner_id,app_id,deployment_id,policy_version));
      CREATE TABLE IF NOT EXISTS flora_auto_rollback_installations(owner_id TEXT NOT NULL,app_id TEXT NOT NULL,deployment_id TEXT NOT NULL,policy_version INTEGER NOT NULL,installation_hash TEXT NOT NULL,failed INTEGER NOT NULL,PRIMARY KEY(owner_id,app_id,deployment_id,policy_version,installation_hash));
      CREATE TABLE IF NOT EXISTS flora_auto_rollback_small_evidence(owner_id TEXT NOT NULL,app_id TEXT NOT NULL,deployment_id TEXT NOT NULL,policy_version INTEGER NOT NULL,installation_hash TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(owner_id,app_id,deployment_id,policy_version,installation_hash));
      CREATE TABLE IF NOT EXISTS flora_auto_rollback_authorized(owner_id TEXT NOT NULL,app_id TEXT NOT NULL,installation_hash TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(owner_id,app_id,installation_hash));
      CREATE TABLE IF NOT EXISTS flora_auto_rollback_authorization_history(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,app_id TEXT NOT NULL,changed_at INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS flora_auto_rollback_authorization_history_page ON flora_auto_rollback_authorization_history(owner_id,app_id,changed_at DESC,id DESC);
      CREATE TABLE IF NOT EXISTS flora_auto_rollback_decisions(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,app_id TEXT NOT NULL,source_deployment_id TEXT NOT NULL,rollback_deployment_id TEXT,status TEXT NOT NULL,next_attempt_at INTEGER,triggered_at INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(owner_id,app_id,source_deployment_id));
      CREATE INDEX IF NOT EXISTS flora_auto_rollback_decisions_due ON flora_auto_rollback_decisions(status,next_attempt_at,id);
      CREATE INDEX IF NOT EXISTS flora_auto_rollback_decisions_history ON flora_auto_rollback_decisions(owner_id,app_id,triggered_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS flora_auto_rollback_decisions_result ON flora_auto_rollback_decisions(owner_id,app_id,rollback_deployment_id);`);
  }
  private policy(ownerId: string, appId: string): AutoRollbackPolicy | null {
    const row = this.storage.sql.exec<{ data: string }>("SELECT data FROM flora_auto_rollback_policies WHERE owner_id=? AND app_id=?", ownerId, appId).toArray()[0];
    return row ? JSON.parse(row.data) as AutoRollbackPolicy : null;
  }
  private count(key: string): number {
    return this.storage.sql.exec<{ value: number }>("SELECT value FROM flora_auto_rollback_meta WHERE key=?", key).toArray()[0]?.value ?? 0;
  }
  private increment(key: string): void {
    this.storage.sql.exec("INSERT INTO flora_auto_rollback_meta(key,value) VALUES(?,1) ON CONFLICT(key) DO UPDATE SET value=value+1", key);
  }
  private capacity(): { queued: false; capacityLimited: true } {
    this.storage.sql.exec("INSERT INTO flora_auto_rollback_meta(key,value) VALUES('capacity-limited',1) ON CONFLICT(key) DO UPDATE SET value=1");
    return { queued: false, capacityLimited: true };
  }
  get(ownerId: string, appId: string): AutoRollbackState {
    text(ownerId, 256); id(appId);
    const decisions = this.storage.sql.exec<{ data: string }>("SELECT data FROM flora_auto_rollback_decisions WHERE owner_id=? AND app_id=? ORDER BY triggered_at DESC,id DESC LIMIT 20", ownerId, appId).toArray().map(row => JSON.parse(row.data) as AutoRollbackDecision);
    const installationHistory = this.storage.sql.exec<{ data: string }>("SELECT data FROM flora_auto_rollback_authorization_history WHERE owner_id=? AND app_id=? ORDER BY changed_at DESC,id DESC LIMIT 20", ownerId, appId).toArray().map(row => JSON.parse(row.data) as AutoRollbackInstallationChange);
    return { appId, policy: this.policy(ownerId, appId), decisions, capacityLimited: this.count("capacity-limited") !== 0, eligibleInstallations: this.count(this.eligibleCountKey(ownerId, appId)), installationHistory };
  }
  private eligibleCountKey(ownerId: string, appId: string): string { return canonicalJson(["eligible-installations", ownerId, appId]); }
  private authorization(ownerId: string, appId: string, installationHash: string): AuthorizedInstallation | null {
    const row = this.storage.sql.exec<{ data: string }>("SELECT data FROM flora_auto_rollback_authorized WHERE owner_id=? AND app_id=? AND installation_hash=?", ownerId, appId, installationHash).toArray()[0];
    return row ? JSON.parse(row.data) as AuthorizedInstallation : null;
  }
  isInstallationAllowed(ownerId: string, appId: string, installationHash: string): boolean {
    return this.authorization(ownerId, appId, installationHash)?.enabled === true;
  }
  /** Called only by the owner's authenticated route after resolving an existing
   * app-bound sealed installation reference. A public SDK session is insufficient. */
  setInstallation(ownerId: string, appId: string, installationHash: string, enabled: boolean, now: number): AutoRollbackState {
    text(ownerId, 256); id(appId); safeText(installationHash, 128); integer(now, 0, Number.MAX_SAFE_INTEGER);
    if (typeof enabled !== "boolean") invalid();
    this.storage.transactionSync(() => {
      const previous = this.authorization(ownerId, appId, installationHash);
      if ((previous?.enabled ?? false) === enabled) return;
      const revoking = previous?.enabled === true && enabled === false;
      // The grant budget must never trap an owner into retaining update
      // authority. At most 2,000 grants can produce at most 2,000 revocations.
      if (!revoking && (!previous && this.count("authorized-installations") >= maximumInstallations || this.count("authorization-changes") >= 2_000)) throw new HttpFailure(429, "AUTO_ROLLBACK_AUTHORIZATION_CAPACITY");
      const authorization: AuthorizedInstallation = {
        enabled, label: previous?.label ?? "설치 " + crypto.randomUUID().slice(0, 8), version: (previous?.version ?? 0) + 1,
        createdAt: previous?.createdAt ?? now, updatedAt: now,
      };
      const change: AutoRollbackInstallationChange = {
        id: "auto_installation_" + crypto.randomUUID(), installationLabel: authorization.label,
        enabled, previousEnabled: previous?.enabled ?? null, changedAt: now,
      };
      this.storage.sql.exec("INSERT INTO flora_auto_rollback_authorized(owner_id,app_id,installation_hash,data) VALUES(?,?,?,?) ON CONFLICT(owner_id,app_id,installation_hash) DO UPDATE SET data=excluded.data", ownerId, appId, installationHash, canonicalJson(authorization));
      this.storage.sql.exec("INSERT INTO flora_auto_rollback_authorization_history(id,owner_id,app_id,changed_at,data) VALUES(?,?,?,?,?)", change.id, ownerId, appId, now, canonicalJson(change));
      this.storage.sql.exec("INSERT INTO flora_auto_rollback_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=value+excluded.value", this.eligibleCountKey(ownerId, appId), Number(enabled) - Number(previous?.enabled ?? false));
      if (!previous) this.increment("authorized-installations");
      this.increment("authorization-changes");
      // Changing which identities may influence update authority is itself a
      // policy change. Fence old counts/claims without deleting their snapshots.
      const policy = this.policy(ownerId, appId);
      if (policy) {
        if (policy.version >= Number.MAX_SAFE_INTEGER) throw new HttpFailure(409, "AUTO_ROLLBACK_POLICY_CONFLICT");
        this.storage.sql.exec("UPDATE flora_auto_rollback_policies SET data=? WHERE owner_id=? AND app_id=?", canonicalJson({ ...policy, version: policy.version + 1, updatedAt: Math.max(now, policy.updatedAt) }), ownerId, appId);
      }
    });
    return this.get(ownerId, appId);
  }
  save(ownerId: string, appId: string, input: unknown, now: number): AutoRollbackState {
    text(ownerId, 256); id(appId); integer(now, 0, Number.MAX_SAFE_INTEGER);
    const parsed = parseAutoRollbackPolicyInput(input);
    this.storage.transactionSync(() => {
      const previous = this.policy(ownerId, appId);
      if ((previous?.version ?? 0) !== parsed.expectedVersion) throw new HttpFailure(409, "AUTO_ROLLBACK_POLICY_CONFLICT");
      const { expectedVersion, ...settings } = parsed;
      const policy: AutoRollbackPolicy = { ...settings, appId, version: expectedVersion + 1, updatedAt: now };
      this.storage.sql.exec("INSERT INTO flora_auto_rollback_policies(owner_id,app_id,data) VALUES(?,?,?) ON CONFLICT(owner_id,app_id) DO UPDATE SET data=excluded.data", ownerId, appId, canonicalJson(policy));
    });
    return this.get(ownerId, appId);
  }
  observe(input: AutoRollbackObservation, now: number): { queued: boolean; decisionId?: string; capacityLimited?: boolean } {
    const policy = this.policy(input.ownerId, input.appId);
    if (!policy?.enabled || input.isRollback !== false || input.channel !== policy.channel || input.publishedAt <= policy.updatedAt || input.publishedAt > now) return { queued: false };
    if (policy.minInstallations < 5 && policy.failureRatePercent !== 100) return { queued: false };
    // An anonymous SDK caller can mint many installation UUIDs. Only an identity
    // explicitly enrolled by the owner may influence automated update authority.
    if (!this.isInstallationAllowed(input.ownerId, input.appId, input.installationHash)) return { queued: false };
    const target = policy.targets[input.platform];
    if (!target || target === input.deploymentId) return { queued: false };
    const deadline = input.publishedAt + policy.windowMinutes * 60_000;
    if (policy.minInstallations < 5) return this.observeSmallSample(input, policy, target, deadline, now);
    if (now > deadline) return { queued: false };
    // Decisions are unique per source across policy edits and survive every retry.
    if (this.storage.sql.exec("SELECT id FROM flora_auto_rollback_decisions WHERE owner_id=? AND app_id=? AND source_deployment_id=?", input.ownerId, input.appId, input.deploymentId).toArray().length) return { queued: false };
    let attempted = false, failed = false;
    for (const event of input.events) {
      if (!Number.isSafeInteger(event.observedAt) || event.observedAt < Math.max(0, input.publishedAt - 120_000) || event.observedAt > deadline || event.observedAt > now + 120_000) continue;
      if (["activation_requested", "launch_confirmed", "restart_confirmed"].includes(event.type)) attempted = true;
      const activationFailure = event.type === "failed" && ["activation", "launch"].includes(event.stage ?? "") && !["NETWORK_UNAVAILABLE", "TIMEOUT"].includes(event.code ?? "");
      if (activationFailure || event.type === "rolled_back") { attempted = true; failed = true; }
    }
    if (!attempted) return { queued: false };
    const scope = [input.ownerId, input.appId, input.deploymentId, policy.version];
    const previous = this.storage.sql.exec<{ failed: number }>("SELECT failed FROM flora_auto_rollback_installations WHERE owner_id=? AND app_id=? AND deployment_id=? AND policy_version=? AND installation_hash=?", ...scope, input.installationHash).toArray()[0];
    if (previous && (!failed || previous.failed === 1)) return { queued: false };
    const source = this.storage.sql.exec<{ data: string }>("SELECT data FROM flora_auto_rollback_sources WHERE owner_id=? AND app_id=? AND deployment_id=? AND policy_version=?", ...scope).toArray()[0];
    if (!previous && this.count("installations") >= maximumInstallations || !source && this.count("sources") >= maximumSources) return this.capacity();
    const counts: ScopeCounts = source ? JSON.parse(source.data) as ScopeCounts : { attemptedInstallations: 0, failedInstallations: 0 };
    if (!previous) { counts.attemptedInstallations++; this.increment("installations"); }
    if (!source) this.increment("sources");
    if (failed && previous?.failed !== 1) counts.failedInstallations++;
    this.storage.sql.exec("INSERT INTO flora_auto_rollback_installations(owner_id,app_id,deployment_id,policy_version,installation_hash,failed) VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,app_id,deployment_id,policy_version,installation_hash) DO UPDATE SET failed=MAX(failed,excluded.failed)", ...scope, input.installationHash, failed ? 1 : 0);
    this.storage.sql.exec("INSERT INTO flora_auto_rollback_sources(owner_id,app_id,deployment_id,policy_version,data) VALUES(?,?,?,?,?) ON CONFLICT(owner_id,app_id,deployment_id,policy_version) DO UPDATE SET data=excluded.data", ...scope, canonicalJson(counts));
    if (counts.attemptedInstallations < policy.minInstallations || counts.failedInstallations * 100 < counts.attemptedInstallations * policy.failureRatePercent) return { queued: false };
    if (this.count("decisions") >= maximumDecisions) return this.capacity();
    const decisionId = "auto_rollback_" + crypto.randomUUID();
    const rate = counts.failedInstallations * 100 / counts.attemptedInstallations;
    const decision: AutoRollbackDecision = {
      id: decisionId, requestKey: decisionId, ownerId: input.ownerId, appId: input.appId,
      sourceDeploymentId: input.deploymentId, targetDeploymentId: target, rollbackDeploymentId: null,
      platform: input.platform, channel: input.channel, runtimeVersion: input.runtimeVersion, publishedAt: input.publishedAt,
      policyVersion: policy.version, policy, ...counts, failureRatePercent: rate,
      status: "queued", triggeredAt: now, updatedAt: now, nextAttemptAt: now, attemptCount: 0, claimVersion: 0, lastErrorCode: null,
      reason: `Automatic rollback: ${counts.failedInstallations}/${counts.attemptedInstallations} reported installations failed (${rate.toFixed(2)}%; threshold ${policy.failureRatePercent}%, minimum ${policy.minInstallations}, window ${policy.windowMinutes} minutes).`,
    };
    this.storage.sql.exec("INSERT INTO flora_auto_rollback_decisions(id,owner_id,app_id,source_deployment_id,rollback_deployment_id,status,next_attempt_at,triggered_at,data) VALUES(?,?,?,?,NULL,?,?,?,?)", decision.id, decision.ownerId, decision.appId, decision.sourceDeploymentId, decision.status, decision.nextAttemptAt, decision.triggeredAt, canonicalJson(decision));
    this.increment("decisions");
    return { queued: true, decisionId };
  }
  private observeSmallSample(input: AutoRollbackObservation, policy: AutoRollbackPolicy, target: string, deadline: number, now: number): { queued: boolean; decisionId?: string; capacityLimited?: boolean } {
    const decisionRow = this.storage.sql.exec<{ data: string }>("SELECT data FROM flora_auto_rollback_decisions WHERE owner_id=? AND app_id=? AND source_deployment_id=?", input.ownerId, input.appId, input.deploymentId).toArray()[0];
    const decision = decisionRow ? JSON.parse(decisionRow.data) as AutoRollbackDecision : null;
    if (decision && (decision.policyVersion !== policy.version || decision.confirmationDelaySeconds !== 120 || !activeStatuses.includes(decision.status))) return { queued: false };
    if (!decision && now > deadline) return { queued: false };
    const scope = [input.ownerId, input.appId, input.deploymentId, policy.version];
    const bind = [...scope, input.installationHash];
    const stored = this.storage.sql.exec<{ data: string }>("SELECT data FROM flora_auto_rollback_small_evidence WHERE owner_id=? AND app_id=? AND deployment_id=? AND policy_version=? AND installation_hash=?", ...bind).toArray()[0];
    const evidence: SmallSampleEvidence = stored ? JSON.parse(stored.data) as SmallSampleEvidence : { activationAt: 0, rollbackAt: 0, successAt: 0 };
    const before = canonicalJson(evidence);
    for (const event of input.events) {
      // Once armed, later recovery remains relevant even after the original
      // publication observation window. A fresh decision still requires that window.
      const success = ["launch_confirmed", "restart_confirmed"].includes(event.type);
      // Match the SDK ticket's bounded clock allowance. Keep raw client times
      // for causal comparisons; publication and confirmation use server time.
      if (!Number.isSafeInteger(event.observedAt) || event.observedAt < Math.max(0, input.publishedAt - 120_000) || event.observedAt > deadline && (!decision || !success) || event.observedAt > now + 120_000) continue;
      if (event.type === "activation_requested") evidence.activationAt = Math.max(evidence.activationAt, event.observedAt);
      if (["launch_confirmed", "restart_confirmed"].includes(event.type)) evidence.successAt = Math.max(evidence.successAt, event.observedAt);
      if (event.type === "rolled_back" && event.stage === "launch" && event.code === "UNCONFIRMED_LAUNCH") evidence.rollbackAt = Math.max(evidence.rollbackAt, event.observedAt);
    }
    if (before === canonicalJson(evidence)) return { queued: false };
    const previous = this.storage.sql.exec<{ failed: number }>("SELECT failed FROM flora_auto_rollback_installations WHERE owner_id=? AND app_id=? AND deployment_id=? AND policy_version=? AND installation_hash=?", ...bind).toArray()[0];
    const source = this.storage.sql.exec<{ data: string }>("SELECT data FROM flora_auto_rollback_sources WHERE owner_id=? AND app_id=? AND deployment_id=? AND policy_version=?", ...scope).toArray()[0];
    const counts: ScopeCounts = source ? JSON.parse(source.data) as ScopeCounts : { attemptedInstallations: 0, failedInstallations: 0, smallSample: true };
    // Older saved counters remain readable; they do not establish the stricter
    // causal native evidence required to grant small-sample update authority.
    if (source && counts.smallSample !== true) return { queued: false };
    if (!previous && this.count("installations") >= maximumInstallations || !source && this.count("sources") >= maximumSources) {
      // Dropping a newly reported healthy installation must not leave a queued
      // 1/1 failure authoritative. Quarantine incomplete source accounting.
      if (source && !counts.capacityLimited) this.storage.sql.exec("UPDATE flora_auto_rollback_sources SET data=? WHERE owner_id=? AND app_id=? AND deployment_id=? AND policy_version=?", canonicalJson({ ...counts, capacityLimited: true }), ...scope);
      return this.capacity();
    }
    const previouslyCrossed = this.smallThreshold(counts, policy);
    const failed = evidence.activationAt > evidence.successAt && evidence.rollbackAt >= evidence.activationAt ? 1 : 0;
    if (!previous) { counts.attemptedInstallations++; this.increment("installations"); }
    if (!source) this.increment("sources");
    counts.failedInstallations += failed - (previous?.failed ?? 0);
    const crossed = this.smallThreshold(counts, policy);
    if (!previouslyCrossed && crossed) counts.confirmationReadyAt = now + 120_000;
    // Evidence rows share the same installation admission budget and scope key.
    // They never rewrite the SDK's append-only raw event journal.
    this.storage.sql.exec("INSERT INTO flora_auto_rollback_small_evidence(owner_id,app_id,deployment_id,policy_version,installation_hash,data) VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,app_id,deployment_id,policy_version,installation_hash) DO UPDATE SET data=excluded.data", ...bind, canonicalJson(evidence));
    this.storage.sql.exec("INSERT INTO flora_auto_rollback_installations(owner_id,app_id,deployment_id,policy_version,installation_hash,failed) VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,app_id,deployment_id,policy_version,installation_hash) DO UPDATE SET failed=excluded.failed", ...bind, failed);
    this.storage.sql.exec("INSERT INTO flora_auto_rollback_sources(owner_id,app_id,deployment_id,policy_version,data) VALUES(?,?,?,?,?) ON CONFLICT(owner_id,app_id,deployment_id,policy_version) DO UPDATE SET data=excluded.data", ...scope, canonicalJson(counts));
    if (decision) {
      // Re-entering the failure threshold requires a fresh server-time wait.
      // Stale/duplicate evidence does not extend it, and uncertain executions
      // retain their receipt-recovery lease rather than becoming a new action.
      if (!previouslyCrossed && crossed && ["queued", "retrying"].includes(decision.status)) this.writeDecision({ ...decision, nextAttemptAt: now + 120_000, updatedAt: now });
      return { queued: false };
    }
    if (!crossed) return { queued: false };
    if (this.count("decisions") >= maximumDecisions) return this.capacity();
    const decisionId = "auto_rollback_" + crypto.randomUUID();
    const value: AutoRollbackDecision = {
      id: decisionId, requestKey: decisionId, ownerId: input.ownerId, appId: input.appId,
      sourceDeploymentId: input.deploymentId, targetDeploymentId: target, rollbackDeploymentId: null,
      platform: input.platform, channel: input.channel, runtimeVersion: input.runtimeVersion, publishedAt: input.publishedAt,
      policyVersion: policy.version, policy, attemptedInstallations: counts.attemptedInstallations, failedInstallations: counts.failedInstallations, failureRatePercent: 100,
      status: "queued", triggeredAt: now, updatedAt: now, nextAttemptAt: now + 120_000, attemptCount: 0, claimVersion: 0, lastErrorCode: null,
      confirmationDelaySeconds: 120,
      reason: `Automatic rollback: ${counts.failedInstallations}/${counts.attemptedInstallations} owner-authorized installations reported native UNCONFIRMED_LAUNCH after activation_requested (100%; minimum ${policy.minInstallations}, window ${policy.windowMinutes} minutes; 120 seconds server confirmation and recovery recheck).`,
    };
    this.storage.sql.exec("INSERT INTO flora_auto_rollback_decisions(id,owner_id,app_id,source_deployment_id,rollback_deployment_id,status,next_attempt_at,triggered_at,data) VALUES(?,?,?,?,NULL,?,?,?,?)", value.id, value.ownerId, value.appId, value.sourceDeploymentId, value.status, value.nextAttemptAt, value.triggeredAt, canonicalJson(value));
    this.increment("decisions"); return { queued: true, decisionId };
  }
  private smallThreshold(counts: ScopeCounts, policy: AutoRollbackPolicy): boolean {
    return counts.smallSample === true && counts.capacityLimited !== true && policy.failureRatePercent === 100 && counts.attemptedInstallations >= policy.minInstallations && counts.failedInstallations === counts.attemptedInstallations;
  }
  private evidenceInvalidation(decision: AutoRollbackDecision): "AUTO_ROLLBACK_RECOVERED" | "AUTO_ROLLBACK_ACCOUNTING_CAPACITY" | null {
    if (decision.confirmationDelaySeconds !== 120) return null;
    const row = this.storage.sql.exec<{ data: string }>("SELECT data FROM flora_auto_rollback_sources WHERE owner_id=? AND app_id=? AND deployment_id=? AND policy_version=?", decision.ownerId, decision.appId, decision.sourceDeploymentId, decision.policyVersion).toArray()[0];
    const counts = row ? JSON.parse(row.data) as ScopeCounts : null;
    if (counts?.capacityLimited) return "AUTO_ROLLBACK_ACCOUNTING_CAPACITY";
    return !counts || !this.smallThreshold(counts, decision.policy) ? "AUTO_ROLLBACK_RECOVERED" : null;
  }
  pending(now: number, limit = 10): AutoRollbackDecision[] {
    integer(now, 0, Number.MAX_SAFE_INTEGER); integer(limit, 1, 20);
    return this.storage.sql.exec<{ data: string }>("SELECT data FROM flora_auto_rollback_decisions WHERE status IN ('queued','retrying','executing') AND next_attempt_at<=? ORDER BY next_attempt_at,id LIMIT ?", now, limit).toArray().map(row => JSON.parse(row.data) as AutoRollbackDecision);
  }
  nextPendingAt(): number | null {
    return this.storage.sql.exec<{ next_attempt_at: number }>("SELECT next_attempt_at FROM flora_auto_rollback_decisions WHERE status IN ('queued','retrying','executing') ORDER BY next_attempt_at,id LIMIT 1").toArray()[0]?.next_attempt_at ?? null;
  }
  private decision(decisionId: string): AutoRollbackDecision | null {
    id(decisionId);
    const row = this.storage.sql.exec<{ data: string }>("SELECT data FROM flora_auto_rollback_decisions WHERE id=?", decisionId).toArray()[0];
    return row ? JSON.parse(row.data) as AutoRollbackDecision : null;
  }
  private currentPolicy(decision: AutoRollbackDecision): boolean {
    const policy = this.policy(decision.ownerId, decision.appId);
    return policy?.enabled === true && policy.version === decision.policyVersion;
  }
  private writeDecision(decision: AutoRollbackDecision): void {
    this.storage.sql.exec("UPDATE flora_auto_rollback_decisions SET rollback_deployment_id=?,status=?,next_attempt_at=?,data=? WHERE id=?", decision.rollbackDeploymentId, decision.status, decision.nextAttemptAt, canonicalJson(decision), decision.id);
  }
  private skipped(decision: AutoRollbackDecision, code: string, now: number): AutoRollbackDecision {
    const cancellation = code === "AUTO_ROLLBACK_RECOVERED" && decision.confirmationDelaySeconds === 120 ? this.cancellationSnapshot(decision, now) : undefined;
    return { ...decision, status: "skipped", updatedAt: now, nextAttemptAt: null, lastErrorCode: code, ...(cancellation ? { cancellation } : {}) };
  }
  private cancellationSnapshot(decision: AutoRollbackDecision, now: number): AutoRollbackCancellation {
    const scope = [decision.ownerId, decision.appId, decision.sourceDeploymentId, decision.policyVersion];
    const row = this.storage.sql.exec<{ data: string }>("SELECT data FROM flora_auto_rollback_sources WHERE owner_id=? AND app_id=? AND deployment_id=? AND policy_version=?", ...scope).toArray()[0];
    const counts = row ? JSON.parse(row.data) as ScopeCounts : { attemptedInstallations: 0, failedInstallations: 0 };
    // Only the terminal cancellation reads the bounded evidence cohort. The
    // scoped prefix and existing admission budget bound it to 20,000 rows; the
    // matching installation lookup uses the full primary key. No D1 is queried.
    const confirmedHealthyInstallations = row ? this.storage.sql.exec<{ healthy: number }>(`SELECT count(*) AS healthy FROM (
      SELECT e.installation_hash FROM flora_auto_rollback_small_evidence e
      JOIN flora_auto_rollback_installations i ON i.owner_id=e.owner_id AND i.app_id=e.app_id AND i.deployment_id=e.deployment_id AND i.policy_version=e.policy_version AND i.installation_hash=e.installation_hash
      WHERE e.owner_id=? AND e.app_id=? AND e.deployment_id=? AND e.policy_version=? AND i.failed=0
      AND json_extract(e.data,'$.successAt')>0
      AND json_extract(e.data,'$.successAt')>=json_extract(e.data,'$.activationAt')
      AND json_extract(e.data,'$.successAt')>=json_extract(e.data,'$.rollbackAt') LIMIT ?
    )`, ...scope, maximumInstallations).one().healthy : 0;
    return {
      checkedAt: now, attemptedInstallations: counts.attemptedInstallations, failedInstallations: counts.failedInstallations,
      confirmedHealthyInstallations, failureRatePercent: counts.attemptedInstallations > 0 ? counts.failedInstallations * 100 / counts.attemptedInstallations : null,
    };
  }
  claim(decisionId: string, now: number): AutoRollbackClaim | null {
    integer(now, 0, Number.MAX_SAFE_INTEGER);
    return this.storage.transactionSync(() => {
      const decision = this.decision(decisionId);
      if (!decision || !activeStatuses.includes(decision.status) || decision.nextAttemptAt === null || decision.nextAttemptAt > now) return null;
      const policyCurrent = this.currentPolicy(decision);
      // An expired execution may already have committed to D1. Always allow its
      // stable-key receipt to be reconciled before deciding a changed policy skip.
      if (!policyCurrent && decision.status !== "executing") {
        this.writeDecision(this.skipped(decision, "AUTO_ROLLBACK_POLICY_CHANGED", now));
        return null;
      }
      const evidenceInvalidation = policyCurrent && decision.status !== "executing" ? this.evidenceInvalidation(decision) : null;
      if (evidenceInvalidation) {
        this.writeDecision(this.skipped(decision, evidenceInvalidation, now));
        return null;
      }
      const claimed: AutoRollbackDecision = { ...decision, status: "executing", updatedAt: now, nextAttemptAt: now + executionLease, attemptCount: decision.attemptCount + 1, claimVersion: decision.claimVersion + 1 };
      this.writeDecision(claimed);
      return { ...claimed, policyCurrent };
    });
  }
  isCurrent(decisionId: string, claimVersion: number, now = Date.now()): boolean {
    return this.invalidationReason(decisionId, claimVersion, now) === null;
  }
  confirmationReadyAt(decisionId: string): number | null {
    const decision = this.decision(decisionId);
    if (!decision || decision.confirmationDelaySeconds !== 120) return null;
    const row = this.storage.sql.exec<{ data: string }>("SELECT data FROM flora_auto_rollback_sources WHERE owner_id=? AND app_id=? AND deployment_id=? AND policy_version=?", decision.ownerId, decision.appId, decision.sourceDeploymentId, decision.policyVersion).toArray()[0];
    return row ? (JSON.parse(row.data) as ScopeCounts).confirmationReadyAt ?? null : null;
  }
  invalidationReason(decisionId: string, claimVersion: number, now = Date.now()): "AUTO_ROLLBACK_POLICY_CHANGED" | "AUTO_ROLLBACK_RECOVERED" | "AUTO_ROLLBACK_CONFIRMATION_PENDING" | "AUTO_ROLLBACK_ACCOUNTING_CAPACITY" | null {
    const decision = this.decision(decisionId);
    if (decision?.status !== "executing" || decision.claimVersion !== claimVersion || !this.currentPolicy(decision)) return "AUTO_ROLLBACK_POLICY_CHANGED";
    const evidenceInvalidation = this.evidenceInvalidation(decision);
    if (evidenceInvalidation) return evidenceInvalidation;
    const readyAt = this.confirmationReadyAt(decisionId);
    return readyAt !== null && readyAt > now ? "AUTO_ROLLBACK_CONFIRMATION_PENDING" : null;
  }
  succeed(decisionId: string, rollbackDeploymentId: string, now: number, claimVersion: number): AutoRollbackDecision | null {
    deploymentId(rollbackDeploymentId); integer(now, 0, Number.MAX_SAFE_INTEGER);
    return this.transition(decisionId, claimVersion, decision => ({ ...decision, rollbackDeploymentId, status: "succeeded", updatedAt: now, nextAttemptAt: null, lastErrorCode: null }));
  }
  fail(decisionId: string, code: string, now: number, claimVersion: number, retryAt?: number): AutoRollbackDecision | null {
    this.failureCode(code); integer(now, 0, Number.MAX_SAFE_INTEGER);
    if (retryAt !== undefined) integer(retryAt, now + 1, Number.MAX_SAFE_INTEGER);
    return this.transition(decisionId, claimVersion, decision => ({ ...decision, status: retryAt === undefined ? "failed" : "retrying", updatedAt: now, nextAttemptAt: retryAt ?? null, lastErrorCode: code }));
  }
  /** The D1 response is ambiguous. Preserve executing so a policy change cannot
   * suppress receipt reconciliation on the next lease, and retain only safe codes. */
  defer(decisionId: string, code: string, now: number, claimVersion: number, retryAt: number): AutoRollbackDecision | null {
    this.failureCode(code); integer(now, 0, Number.MAX_SAFE_INTEGER); integer(retryAt, now + 1, Number.MAX_SAFE_INTEGER);
    return this.transition(decisionId, claimVersion, decision => ({ ...decision, status: "executing", updatedAt: now, nextAttemptAt: retryAt, lastErrorCode: code }));
  }
  skip(decisionId: string, code: string, now: number, claimVersion?: number): AutoRollbackDecision | null {
    this.failureCode(code); integer(now, 0, Number.MAX_SAFE_INTEGER);
    return this.transition(decisionId, claimVersion, decision => this.skipped(decision, code, now));
  }
  private failureCode(code: string): void { if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(code)) invalid(); }
  private transition(decisionId: string, claimVersion: number | undefined, change: (decision: AutoRollbackDecision) => AutoRollbackDecision): AutoRollbackDecision | null {
    return this.storage.transactionSync(() => {
      const decision = this.decision(decisionId);
      if (!decision || !activeStatuses.includes(decision.status) || claimVersion !== undefined && (decision.status !== "executing" || decision.claimVersion !== claimVersion)) return null;
      const changed = change(decision); this.writeDecision(changed); return changed;
    });
  }
  annotations(ownerId: string, appId: string, deploymentIds: string[]): Map<string, AutoRollbackDecision> {
    text(ownerId, 256); id(appId);
    if (!Array.isArray(deploymentIds) || deploymentIds.length > 200) invalid();
    for (const value of deploymentIds) deploymentId(value);
    const result = new Map<string, AutoRollbackDecision>();
    if (!deploymentIds.length) return result;
    const query = canonicalJson(deploymentIds);
    const rows = this.storage.sql.exec<{ deployment_id: string; data: string }>(`SELECT d.source_deployment_id AS deployment_id,d.data FROM json_each(?) j JOIN flora_auto_rollback_decisions d ON d.owner_id=? AND d.app_id=? AND d.source_deployment_id=j.value
      UNION ALL SELECT d.rollback_deployment_id AS deployment_id,d.data FROM json_each(?) j JOIN flora_auto_rollback_decisions d ON d.owner_id=? AND d.app_id=? AND d.rollback_deployment_id=j.value`, query, ownerId, appId, query, ownerId, appId).toArray();
    for (const row of rows) result.set(row.deployment_id, JSON.parse(row.data) as AutoRollbackDecision);
    return result;
  }
}
