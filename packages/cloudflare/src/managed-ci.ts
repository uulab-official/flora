import type { DurableObject } from "cloudflare:workers";
import { canonicalJson } from "@app-ops/config";
import { applicationId, parseAutomationExportReceipt, parseAutomationLease, automationPolicyPlatforms } from "@app-ops/dogfood";
import type { AutomationExportReceipt, AutomationLease, GitHubConnection, RunnerEnrollment, RunnerSummary, OTAPlatform } from "@app-ops/dogfood";
import { integer, object, text } from "@app-ops/core";
import { AuthFailure } from "./auth-state.js";
import type { GitHubCIIdentity, GitHubCITrust } from "./github-oidc.js";
type Storage = ConstructorParameters<typeof DurableObject>[0]["storage"];
export interface CIBinding extends GitHubCITrust {
  appId: string; version: number; enabled: boolean; connectionVersion: number; runnerId: string; updatedAt: number;
}
export interface CIBindingUpdate extends Omit<GitHubCITrust, "repository"> { expectedVersion: number; enabled: boolean }
export interface CISession { tokenHash: string; appId: string; runnerId: string; bindingVersion: number; epoch: number; expiresAt: number; commitSha: string; admissionSequence: number; platforms?: OTAPlatform[] }
export interface RunnerCheckpoint { schemaVersion: 1; origin: string; lease: AutomationLease; receipt: AutomationExportReceipt }
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
export async function ciTokenHash(token: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))), byte => byte.toString(16).padStart(2, "0")).join("");
}
export function parseCIBindingUpdate(input: unknown): CIBindingUpdate {
  const data = object(input, ["expectedVersion", "enabled", "repositoryId", "repositoryOwnerId", "ref", "jobWorkflowRef", "jobWorkflowSha"]);
  const repositoryId = text(data.repositoryId, 20), repositoryOwnerId = text(data.repositoryOwnerId, 20);
  if (!/^[1-9][0-9]{0,19}$/.test(repositoryId) || !/^[1-9][0-9]{0,19}$/.test(repositoryOwnerId) || typeof data.enabled !== "boolean") throw new AuthFailure(400, "INVALID_INPUT");
  const ref = text(data.ref, 256), jobWorkflowSha = text(data.jobWorkflowSha, 40), jobWorkflowRef = text(data.jobWorkflowRef, 512);
  if (!/^refs\/heads\/[A-Za-z0-9_./-]+$/.test(ref) || ref.includes("..") || ref.includes("//") || ref.endsWith("/") || ref.endsWith(".lock") || !/^[a-f0-9]{40}$/.test(jobWorkflowSha)
    || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml@[a-f0-9]{40}$/.test(jobWorkflowRef) || !jobWorkflowRef.endsWith("@" + jobWorkflowSha)) throw new AuthFailure(400, "INVALID_INPUT");
  return { expectedVersion: integer(data.expectedVersion), enabled: data.enabled, repositoryId, repositoryOwnerId, ref, jobWorkflowRef, jobWorkflowSha };
}
export function parseRunnerCheckpoint(input: unknown): RunnerCheckpoint {
  const data = object(input, ["schemaVersion", "origin", "lease", "receipt"]);
  const origin = text(data.origin, 2048), lease = parseAutomationLease(data.lease), receipt = parseAutomationExportReceipt(data.receipt);
  if (data.schemaVersion !== 1 || new URL(origin).origin !== origin || receipt.jobId !== lease.jobId || receipt.attemptId !== lease.attemptId) throw new AuthFailure(400, "INVALID_INPUT");
  return { schemaVersion: 1, origin, lease, receipt };
}
/** Private additive DO state. Underlying machine credentials never leave this
 * object; short-lived session hashes are scoped to one binding/owner epoch. */
export class ManagedCI {
  constructor(private readonly storage: Storage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS flora_ci_bindings (app_id TEXT PRIMARY KEY, data TEXT NOT NULL, runner_token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS flora_ci_heads (app_id TEXT PRIMARY KEY, commit_sha TEXT NOT NULL, sequence INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS flora_ci_counter (id INTEGER PRIMARY KEY CHECK(id=1), sequence INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS flora_ci_sessions (token_hash TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS flora_ci_oidc_replays (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS flora_ci_checkpoints (runner_id TEXT NOT NULL, app_id TEXT NOT NULL, job_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
        data TEXT NOT NULL, PRIMARY KEY(runner_id,app_id,job_id,attempt_id))`);
    storage.sql.exec("INSERT INTO flora_ci_counter VALUES(1,0) ON CONFLICT(id) DO NOTHING");
  }
  binding(appId: string): CIBinding | null {
    applicationId(appId); const row = this.storage.sql.exec<{ data: string }>("SELECT data FROM flora_ci_bindings WHERE app_id=?", appId).toArray()[0];
    return row ? JSON.parse(row.data) as CIBinding : null;
  }
  credential(appId: string): string | null {
    return this.storage.sql.exec<{ runner_token: string }>("SELECT runner_token FROM flora_ci_bindings WHERE app_id=?", appId).toArray()[0]?.runner_token ?? null;
  }
  configure(appId: string, update: CIBindingUpdate, connection: GitHubConnection, enrollment: RunnerEnrollment | null, now: number, fence: () => void): CIBinding {
    fence(); const prior = this.binding(appId);
    if ((prior?.version ?? 0) !== update.expectedVersion) throw new AuthFailure(409, "CONFLICT");
    const runnerId = enrollment?.runner.id ?? prior?.runnerId, token = enrollment?.token ?? this.credential(appId);
    if (!runnerId || !token) throw new AuthFailure(503, "CI_UNAVAILABLE");
    const binding: CIBinding = { appId, version: (prior?.version ?? 0) + 1, enabled: update.enabled,
      repository: connection.owner + "/" + connection.repository, repositoryId: update.repositoryId, repositoryOwnerId: update.repositoryOwnerId,
      ref: update.ref, jobWorkflowRef: update.jobWorkflowRef, jobWorkflowSha: update.jobWorkflowSha, connectionVersion: connection.version, runnerId, updatedAt: now };
    this.storage.sql.exec("INSERT INTO flora_ci_bindings VALUES(?,?,?) ON CONFLICT(app_id) DO UPDATE SET data=excluded.data,runner_token=excluded.runner_token", appId, canonicalJson(binding), token);
    return binding;
  }
  disable(appId: string, update: CIBindingUpdate, now: number, fence: () => void): CIBinding {
    fence(); const prior = this.binding(appId);
    if (!prior) throw new AuthFailure(404, "NOT_FOUND");
    if (prior.version !== update.expectedVersion) throw new AuthFailure(409, "CONFLICT");
    const trustKeys = ["repositoryId", "repositoryOwnerId", "ref", "jobWorkflowRef", "jobWorkflowSha"] as const;
    if (update.enabled || trustKeys.some(key => prior[key] !== update[key])) throw new AuthFailure(400, "INVALID_INPUT");
    const binding = { ...prior, version: prior.version + 1, enabled: false, updatedAt: now };
    this.storage.sql.exec("UPDATE flora_ci_bindings SET data=? WHERE app_id=?", canonicalJson(binding), appId); return binding;
  }
  assertBinding(binding: CIBinding, connection?: GitHubConnection | null): void {
    const current = this.binding(binding.appId);
    if (!current?.enabled || current.version !== binding.version || current.runnerId !== binding.runnerId || connection !== undefined
      && (!connection || connection.version !== binding.connectionVersion || connection.owner + "/" + connection.repository !== binding.repository || "refs/heads/" + connection.ref !== binding.ref)) throw new AuthFailure(403, "CI_BINDING_REJECTED");
  }
  reserveAdmission(): number {
    return this.storage.sql.exec<{ sequence: number }>("UPDATE flora_ci_counter SET sequence=sequence+1 WHERE id=1 RETURNING sequence").one().sequence;
  }
  async issue(binding: CIBinding, identity: GitHubCIIdentity, jwt: string, runner: RunnerSummary, epoch: number, now: number, sequence: number, fence: () => void, selectedPlatforms: OTAPlatform[] = ["ios"]) {
    const platforms = [...automationPolicyPlatforms({ platforms: selectedPlatforms })];
    const token = runner.id + "." + encode(crypto.getRandomValues(new Uint8Array(32))), tokenHash = await ciTokenHash(token), jwtHash = await ciTokenHash(jwt);
    fence(); this.assertBinding(binding);
    if (identity.expiresAt <= Date.now()) throw new AuthFailure(403, "CI_IDENTITY_REJECTED");
    // Each admitted target has its existing bounded export budget. A singleton
    // keeps the prior lifetime; two sequential exports share a one-hour cap.
    const expiresAt = now + platforms.length * 1_800_000;
    this.storage.transactionSync(() => {
      const head = this.storage.sql.exec<{ sequence: number }>("SELECT sequence FROM flora_ci_heads WHERE app_id=?", binding.appId).toArray()[0];
      if (head && head.sequence > sequence) throw new AuthFailure(403, "CI_COMMIT_SUPERSEDED");
      this.storage.sql.exec("DELETE FROM flora_ci_sessions WHERE expires_at<=?", now); this.storage.sql.exec("DELETE FROM flora_ci_oidc_replays WHERE expires_at<=?", now);
      if (this.storage.sql.exec("SELECT 1 FROM flora_ci_oidc_replays WHERE token_hash=?", jwtHash).toArray().length) throw new AuthFailure(403, "CI_IDENTITY_REPLAYED");
      if (this.storage.sql.exec<{ total: number }>("SELECT count(*) AS total FROM flora_ci_sessions").one().total >= 100) throw new AuthFailure(409, "BUSY");
      const session: CISession = { tokenHash, appId: binding.appId, runnerId: runner.id, bindingVersion: binding.version, epoch, expiresAt, commitSha: identity.commitSha, admissionSequence: sequence, platforms };
      this.storage.sql.exec("INSERT INTO flora_ci_sessions VALUES(?,?,?)", tokenHash, canonicalJson(session), expiresAt);
      this.storage.sql.exec("INSERT INTO flora_ci_oidc_replays VALUES(?,?)", jwtHash, identity.expiresAt);
      this.storage.sql.exec("INSERT INTO flora_ci_heads VALUES(?,?,?) ON CONFLICT(app_id) DO UPDATE SET commit_sha=excluded.commit_sha,sequence=excluded.sequence", binding.appId, identity.commitSha, sequence);
    });
    return { runner, token, expiresAt, appId: binding.appId, commitSha: identity.commitSha, platforms };
  }
  async session(token: string): Promise<CISession | null> {
    const hash = await ciTokenHash(token), row = this.storage.sql.exec<{ data: string }>("SELECT data FROM flora_ci_sessions WHERE token_hash=?", hash).toArray()[0];
    return row ? JSON.parse(row.data) as CISession : null;
  }
  assertSession(session: CISession, epoch: number, now: number): CIBinding {
    const binding = this.binding(session.appId);
    if (!binding?.enabled || binding.version !== session.bindingVersion || binding.runnerId !== session.runnerId || session.epoch !== epoch || session.expiresAt <= now
      || !Number.isSafeInteger(session.admissionSequence) || session.admissionSequence < 1) throw new AuthFailure(403, "CI_SESSION_REJECTED");
    const head = this.storage.sql.exec<{ commit_sha: string; sequence: number }>("SELECT commit_sha,sequence FROM flora_ci_heads WHERE app_id=?", session.appId).toArray()[0];
    // A commit can recur. Only the latest successful admission retains authority.
    if (!head || head.commit_sha !== session.commitSha || head.sequence !== session.admissionSequence) throw new AuthFailure(403, "CI_COMMIT_SUPERSEDED");
    return binding;
  }
  checkpoints(session: CISession): RunnerCheckpoint[] {
    return this.storage.sql.exec<{ data: string }>("SELECT data FROM flora_ci_checkpoints WHERE runner_id=? AND app_id=? ORDER BY job_id,attempt_id LIMIT 100", session.runnerId, session.appId).toArray().map(row => parseRunnerCheckpoint(JSON.parse(row.data)));
  }
  checkpoint(session: CISession, jobId: string, attemptId: string): RunnerCheckpoint | null {
    const row = this.storage.sql.exec<{ data: string }>("SELECT data FROM flora_ci_checkpoints WHERE runner_id=? AND app_id=? AND job_id=? AND attempt_id=?", session.runnerId, session.appId, jobId, attemptId).toArray()[0];
    return row ? parseRunnerCheckpoint(JSON.parse(row.data)) : null;
  }
  saveCheckpoint(session: CISession, checkpoint: RunnerCheckpoint, fence: () => void): void {
    fence(); const { lease } = checkpoint;
    if (lease.appId !== session.appId || lease.runnerId !== session.runnerId) throw new AuthFailure(403, "CI_BINDING_REJECTED");
    const prior = this.checkpoint(session, lease.jobId, lease.attemptId), data = canonicalJson(checkpoint);
    if (prior) { if (canonicalJson(prior) !== data) throw new AuthFailure(409, "IDEMPOTENCY_CONFLICT"); return; }
    if (this.storage.sql.exec<{ total: number }>("SELECT count(*) AS total FROM flora_ci_checkpoints").one().total >= 100) throw new AuthFailure(409, "CHECKPOINT_CAPACITY");
    this.storage.sql.exec("INSERT INTO flora_ci_checkpoints VALUES(?,?,?,?,?)", session.runnerId, session.appId, lease.jobId, lease.attemptId, data);
  }
  clearCheckpoint(session: CISession, jobId: string, attemptId: string, fence: () => void): void {
    fence(); this.storage.sql.exec("DELETE FROM flora_ci_checkpoints WHERE runner_id=? AND app_id=? AND job_id=? AND attempt_id=?", session.runnerId, session.appId, jobId, attemptId);
  }
}
