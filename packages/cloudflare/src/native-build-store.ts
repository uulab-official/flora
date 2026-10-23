import type { DurableObject } from 'cloudflare:workers';
import { CredentialVault, CredentialVaultError } from './credential-vault.js';
import { NativeBuildError, nativeCheck, nativeId, nativeInteger, nativeObject, nativePlatform, parseNativeArtifact, parseNativeJobInput, parseNativeLease } from './native-types.js';
import type { NativeJob, NativeLease, NativePlatform, NativeRunnerCredential, NativeRunnerSummary, NativeSource } from './native-types.js';
type Storage = ConstructorParameters<typeof DurableObject>[0]['storage'];
type Fence = () => void;
export interface NativeAuthority { runnerId: string; tokenHash: string; credentialEpoch: number; ownerEpoch: number }
const leaseMs = 120_000, attemptMs = 2 * 60 * 60 * 1000;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const encoder = new TextEncoder();
async function hash(value: string): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(b => b.toString(16).padStart(2, '0')).join(''); }
function summary(runner: NativeRunnerCredential): NativeRunnerSummary { const { tokenHash: _token, ...publicValue } = runner; return publicValue; }
const failureCodes = new Set(['NATIVE_BUILD_FAILED', 'NATIVE_SIGNING_FAILED', 'ARTIFACT_INVALID', 'CANCELLED', 'LEASE_EXPIRED', 'CREDENTIAL_CHANGED', 'RUNNER_REVOKED']);
/** Additive native authority lives with the Vault, so a final lease check,
 * credential revision check and use audit share one synchronous transaction. */
export class NativeBuildStore {
  constructor(private readonly storage: Storage, private readonly vault: CredentialVault) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS flora_native_runners (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, platform TEXT NOT NULL, owner_epoch INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS flora_native_jobs (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, request_key TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(app_id,request_key));
      CREATE TABLE IF NOT EXISTS flora_native_events (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, job_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS flora_native_credential_uses (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, job_id TEXT NOT NULL, attempt_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS flora_native_completions (job_id TEXT PRIMARY KEY, app_id TEXT NOT NULL, lease_json TEXT NOT NULL, artifact_json TEXT NOT NULL)`);
    // Idle polling must not reread completed history. These additive indexes
    // preserve the queue's FIFO order and the existing active-lease predicates.
    // Terminal jobs occupy neither index; existing stores are upgraded in place.
    storage.sql.exec(`CREATE INDEX IF NOT EXISTS flora_native_jobs_pending
      ON flora_native_jobs(app_id,json_extract(data,'$.platform'),json_extract(data,'$.createdAt'),id)
      WHERE json_extract(data,'$.state')='queued'`);
    storage.sql.exec(`CREATE INDEX IF NOT EXISTS flora_native_jobs_active_runner
      ON flora_native_jobs(app_id,json_extract(data,'$.lease.runnerId'),json_extract(data,'$.lease.expiresAt'),id)
      WHERE json_extract(data,'$.state') IN ('leased','cancel_requested')`);
  }
  private runner(runnerId: string): { ownerEpoch: number; value: NativeRunnerCredential } | null {
    const row = this.storage.sql.exec<{ owner_epoch: number; data: string }>('SELECT owner_epoch,data FROM flora_native_runners WHERE id=?', nativeId(runnerId)).toArray()[0];
    return row ? { ownerEpoch: row.owner_epoch, value: JSON.parse(row.data) as NativeRunnerCredential } : null;
  }
  getJob(appId: string, jobId: string): NativeJob | null {
    const row = this.storage.sql.exec<{ data: string }>('SELECT data FROM flora_native_jobs WHERE app_id=? AND id=?', nativeId(appId), nativeId(jobId)).toArray()[0];
    return row ? copy(JSON.parse(row.data) as NativeJob) : null;
  }
  private save(job: NativeJob): NativeJob {
    this.storage.sql.exec('UPDATE flora_native_jobs SET data=? WHERE app_id=? AND id=?', JSON.stringify(job), job.appId, job.id); return copy(job);
  }
  private event(job: NativeJob, action: string, runnerId: string | null = null) {
    const id = 'native_event_' + crypto.randomUUID(), value = { id, appId: job.appId, jobId: job.id, action, createdAt: job.updatedAt, runnerId, code: job.code };
    this.storage.sql.exec('INSERT INTO flora_native_events VALUES(?,?,?,?)', id, job.appId, job.id, JSON.stringify(value));
  }
  private expireStale(appId: string, fence: Fence): void {
    const now = Date.now();
    this.storage.transactionSync(() => {
      fence();
      const jobs = this.storage.sql.exec<{ data: string }>(`SELECT data FROM flora_native_jobs WHERE app_id=?
        AND json_extract(data,'$.state') IN ('leased','cancel_requested')`, appId).toArray().map(row => JSON.parse(row.data) as NativeJob);
      for (const job of jobs) if (job.lease && ['leased', 'cancel_requested'].includes(job.state)
        && (job.lease.expiresAt <= now || job.claimedAt !== null && job.claimedAt + attemptMs <= now)) {
        const cancelled = job.state === 'cancel_requested', next = this.save({ ...job, state: cancelled ? 'cancelled' : 'failed', lease: null,
          code: cancelled ? 'CANCELLED' : 'LEASE_EXPIRED', updatedAt: now });
        this.event(next, 'expired', job.lease.runnerId);
      }
    });
  }
  list(appId: string, fence: Fence = () => {}) {
    nativeId(appId); this.expireStale(appId, fence);
    const rows = (table: string) => this.storage.sql.exec<{ data: string }>(`SELECT data FROM ${table} WHERE app_id=? ORDER BY rowid DESC LIMIT 100`, appId).toArray().map(row => JSON.parse(row.data));
    return { appId, jobs: rows('flora_native_jobs'), runners: rows('flora_native_runners').map(value => summary(value)), events: rows('flora_native_events'), credentialUses: rows('flora_native_credential_uses') };
  }
  async enroll(appId: string, input: unknown, ownerEpoch: number, fence: Fence) {
    nativeId(appId); nativeInteger(ownerEpoch, 0); const value = nativeObject(input, ['name', 'platform']), platform = nativePlatform(value.platform);
    nativeCheck(typeof value.name === 'string' && value.name.trim().length > 0 && value.name.length <= 80 && !/[\x00-\x1f\x7f]/.test(value.name));
    const id = 'native_runner_' + crypto.randomUUID(), raw = crypto.getRandomValues(new Uint8Array(32));
    const token = id + '.' + btoa(String.fromCharCode(...raw)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); raw.fill(0);
    const tokenHash = await hash(token); fence();
    const runner: NativeRunnerCredential = { id, appId, platform, name: value.name.trim(), createdAt: Date.now(), credentialEpoch: 1, revokedAt: null, lastSeenAt: null, tokenHash };
    return this.storage.transactionSync(() => {
      fence(); nativeCheck(this.storage.sql.exec<{ count: number }>('SELECT count(*) AS count FROM flora_native_runners').one().count < 20, 409, 'NATIVE_CAPACITY');
      this.storage.sql.exec('INSERT INTO flora_native_runners VALUES(?,?,?,?,?)', id, appId, platform, ownerEpoch, JSON.stringify(runner));
      return { runner: summary(runner), token };
    });
  }
  async authorize(token: string, ownerEpoch: number, fence: Fence): Promise<NativeAuthority> {
    const match = /^(native_runner_[a-f0-9-]{36})\.[A-Za-z0-9_-]{43}$/.exec(token);
    nativeCheck(match, 401, 'UNAUTHENTICATED'); const tokenHash = await hash(token); fence();
    const row = this.runner(match[1]!);
    nativeCheck(row && row.ownerEpoch === ownerEpoch && row.value.revokedAt === null && row.value.tokenHash === tokenHash, 403, 'NATIVE_RUNNER_DENIED');
    return { runnerId: row.value.id, tokenHash, credentialEpoch: row.value.credentialEpoch, ownerEpoch };
  }
  private assertAuthority(authority: NativeAuthority) {
    const row = this.runner(authority.runnerId);
    nativeCheck(row && row.ownerEpoch === authority.ownerEpoch && row.value.tokenHash === authority.tokenHash
      && row.value.credentialEpoch === authority.credentialEpoch && row.value.revokedAt === null, 403, 'NATIVE_RUNNER_DENIED'); return row.value;
  }
  /** A native daemon learns one owner-approved job ID for its own capability.
   * Superseded credential pins are retired with history instead of blocking later
   * approved jobs. No lease or credential payload is granted by this operation. */
  pending(authority: NativeAuthority, fence: Fence): { jobId: string | null } {
    return this.storage.transactionSync(() => {
      fence(); const runner = this.assertAuthority(authority), now = Date.now();
      const active = this.storage.sql.exec<{ id: string }>(`SELECT id FROM flora_native_jobs WHERE app_id=?
        AND json_extract(data,'$.lease.runnerId')=? AND json_extract(data,'$.state') IN ('leased','cancel_requested')
        AND json_extract(data,'$.lease.expiresAt')>? LIMIT 1`, runner.appId, runner.id, now).toArray()[0];
      if (active) return { jobId: null };
      const rows = this.storage.sql.exec<{ data: string }>(`SELECT data FROM flora_native_jobs WHERE app_id=?
        AND json_extract(data,'$.platform')=? AND json_extract(data,'$.state')='queued'
        ORDER BY json_extract(data,'$.createdAt'),id LIMIT 100`, runner.appId, runner.platform).toArray();
      for (const row of rows) {
        fence(); this.assertAuthority(authority); const job = JSON.parse(row.data) as NativeJob;
        nativeCheck(job.appId === runner.appId && job.platform === runner.platform, 503, 'NATIVE_STORE_UNAVAILABLE');
        try { this.vault.assertNativePins(job.appId, job); }
        catch (error) {
          // Unavailability or malformed material is not evidence of rotation.
          // Roll back rather than falsely retiring jobs when Vault is unhealthy.
          if (!(error instanceof CredentialVaultError) || error.code !== 'CREDENTIAL_CONFLICT') throw error;
          fence(); this.assertAuthority(authority);
          const failed = this.save({ ...job, state: 'failed', code: 'CREDENTIAL_CHANGED', updatedAt: Date.now() });
          this.event(failed, 'failed', runner.id); continue;
        }
        fence(); this.assertAuthority(authority); return { jobId: job.id };
      }
      fence(); this.assertAuthority(authority); return { jobId: null };
    });
  }
  assertLease(authority: NativeAuthority, leaseInput: NativeLease, allowCancel = false): NativeJob {
    const lease = parseNativeLease(leaseInput), runner = this.assertAuthority(authority), job = this.getJob(lease.appId, lease.jobId), now = Date.now();
    nativeCheck(job && job.lease && (job.state === 'leased' || allowCancel && job.state === 'cancel_requested')
      && job.appId === runner.appId && job.platform === runner.platform && lease.platform === job.platform
      && lease.runnerId === runner.id && lease.credentialEpoch === runner.credentialEpoch
      && ['jobId', 'appId', 'platform', 'runnerId', 'attemptId', 'credentialEpoch', 'fence'].every(key => lease[key as keyof NativeLease] === job.lease![key as keyof NativeLease])
      && lease.expiresAt <= job.lease.expiresAt && job.lease.expiresAt > now && job.claimedAt !== null && job.claimedAt + attemptMs > now, 409, 'NATIVE_LEASE_STALE');
    return job;
  }
  async enqueue(appId: string, input: unknown, source: NativeSource, fence: Fence): Promise<NativeJob> {
    nativeId(appId); const selection = parseNativeJobInput(input); this.vault.assertNativePins(appId, selection); fence();
    const configDigest = await hash(JSON.stringify({ appId, ...selection, source })); fence(); this.vault.assertNativePins(appId, selection);
    return this.storage.transactionSync(() => {
      fence(); this.vault.assertNativePins(appId, selection);
      const existing = this.storage.sql.exec<{ data: string }>('SELECT data FROM flora_native_jobs WHERE app_id=? AND request_key=?', appId, selection.requestKey).toArray()[0];
      if (existing) { const job = JSON.parse(existing.data) as NativeJob; nativeCheck(job.configDigest === configDigest, 409, 'NATIVE_IDEMPOTENCY_CONFLICT'); return copy(job); }
      nativeCheck(this.storage.sql.exec<{ count: number }>('SELECT count(*) AS count FROM flora_native_jobs').one().count < 200
        && this.storage.sql.exec<{ count: number }>('SELECT count(*) AS count FROM flora_native_jobs WHERE app_id=?', appId).one().count < 100, 409, 'NATIVE_CAPACITY');
      const now = Date.now(), job: NativeJob = { ...selection, appId, id: 'native_job_' + crypto.randomUUID(), source: copy(source), configDigest,
        createdAt: now, updatedAt: now, state: 'queued', lease: null, claimedAt: null, code: null, artifact: null, artifactVerification: null };
      this.storage.sql.exec('INSERT INTO flora_native_jobs VALUES(?,?,?,?)', job.id, appId, job.requestKey, JSON.stringify(job)); this.event(job, 'queued'); return copy(job);
    });
  }
  claim(authority: NativeAuthority, input: unknown, fence: Fence) {
    const value = nativeObject(input, ['jobId']), jobId = nativeId(value.jobId);
    return this.storage.transactionSync(() => {
      fence(); const runner = this.assertAuthority(authority), job = this.getJob(runner.appId, jobId);
      nativeCheck(job && job.platform === runner.platform, 403, 'NATIVE_RUNNER_DENIED'); nativeCheck(job.state === 'queued', 409, 'NATIVE_JOB_CONFLICT'); this.vault.assertNativePins(job.appId, job);
      const active = this.storage.sql.exec<{ id: string }>(`SELECT id FROM flora_native_jobs WHERE app_id=?
        AND json_extract(data,'$.lease.runnerId')=? AND json_extract(data,'$.state') IN ('leased','cancel_requested')
        AND json_extract(data,'$.lease.expiresAt')>? LIMIT 1`, runner.appId, runner.id, Date.now()).toArray()[0];
      nativeCheck(!active, 409, 'NATIVE_RUNNER_BUSY');
      const now = Date.now(), lease: NativeLease = { jobId: job.id, appId: job.appId, platform: job.platform, runnerId: runner.id,
        attemptId: 'native_attempt_' + crypto.randomUUID(), credentialEpoch: runner.credentialEpoch, fence: 1, expiresAt: now + leaseMs };
      const claimed = this.save({ ...job, state: 'leased', lease, claimedAt: now, updatedAt: now }); this.event(claimed, 'claimed', runner.id); return { job: claimed, lease: copy(lease) };
    });
  }
  heartbeat(authority: NativeAuthority, lease: NativeLease, fence: Fence): NativeLease {
    return this.storage.transactionSync(() => { fence(); const job = this.assertLease(authority, lease); this.vault.assertNativePins(job.appId, job);
      const now = Date.now(), next = { ...job.lease!, expiresAt: Math.min(now + leaseMs, job.claimedAt! + attemptMs) }; this.save({ ...job, lease: next, updatedAt: now }); return copy(next); });
  }
  presence(authority: NativeAuthority, fence: Fence) {
    return this.storage.transactionSync(() => { fence(); const runner = this.assertAuthority(authority), now = Date.now();
      if (runner.lastSeenAt === null || now - runner.lastSeenAt >= 60_000) this.storage.sql.exec('UPDATE flora_native_runners SET data=? WHERE id=?', JSON.stringify({ ...runner, lastSeenAt: now }), runner.id);
      return { runnerId: runner.id, lastSeenAt: now }; });
  }
  async credentials(authority: NativeAuthority, lease: NativeLease, fence: Fence) {
    const live = () => { fence(); const job = this.assertLease(authority, lease); this.vault.assertNativePins(job.appId, job); };
    live(); const job = this.assertLease(authority, lease), credentials = await this.vault.grantNativeCredentials(job.appId, job, live); live();
    return this.storage.transactionSync(() => {
      live(); const current = this.assertLease(authority, lease);
      nativeCheck(this.storage.sql.exec<{ count: number }>('SELECT count(*) AS count FROM flora_native_credential_uses WHERE attempt_id=?', lease.attemptId).one().count < 3, 409, 'NATIVE_GRANT_LIMIT');
      const id = 'native_use_' + crypto.randomUUID(), use = { id, appId: job.appId, jobId: job.id, attemptId: lease.attemptId, runnerId: authority.runnerId,
        platform: job.platform, commitSha: job.commitSha, createdAt: Date.now(), credentials: credentials.map(({ kind, version, fingerprint }) => ({ kind, version, fingerprint })) };
      this.storage.sql.exec('INSERT INTO flora_native_credential_uses VALUES(?,?,?,?,?)', id, job.appId, job.id, lease.attemptId, JSON.stringify(use));
      return { jobId: job.id, appId: job.appId, platform: job.platform, commitSha: job.commitSha, expiresAt: current.lease!.expiresAt, credentials };
    });
  }
  complete(authority: NativeAuthority, lease: NativeLease, artifactInput: unknown, fence: Fence): NativeJob {
    const artifact = parseNativeArtifact(artifactInput);
    return this.storage.transactionSync(() => { fence(); const runner = this.assertAuthority(authority), previous = this.getJob(lease.appId, lease.jobId);
      if (previous?.state === 'succeeded') {
        const receipt = this.storage.sql.exec<{ lease_json: string; artifact_json: string }>('SELECT lease_json,artifact_json FROM flora_native_completions WHERE app_id=? AND job_id=?', lease.appId, lease.jobId).toArray()[0];
        nativeCheck(previous.appId === runner.appId && previous.platform === runner.platform && receipt && receipt.lease_json === JSON.stringify(parseNativeLease(lease))
          && receipt.artifact_json === JSON.stringify(artifact), 409, 'NATIVE_LEASE_STALE'); return previous;
      }
      const job = this.assertLease(authority, lease); this.vault.assertNativePins(job.appId, job);
      nativeCheck(artifact.appIdentifier === job.appIdentifier && artifact.platform === job.platform && artifact.teamId === job.teamId, 400, 'NATIVE_ARTIFACT_MISMATCH');
      nativeCheck(artifact.fileName === job.id + '.ipa' || job.platform === 'android' && [job.id + '.apk', job.id + '.aab'].includes(artifact.fileName), 400, 'NATIVE_ARTIFACT_MISMATCH');
      const grant = this.storage.sql.exec<{ data: string }>('SELECT data FROM flora_native_credential_uses WHERE job_id=? AND attempt_id=? ORDER BY rowid DESC LIMIT 1', job.id, lease.attemptId).toArray()[0];
      nativeCheck(grant, 409, 'NATIVE_GRANT_REQUIRED');
      const granted = JSON.parse(grant.data) as { credentials: Array<{ kind: string; fingerprint: string | null }> };
      const identity = granted.credentials.find(item => item.kind === (job.platform === 'ios' ? 'ios_distribution' : 'android_keystore'));
      nativeCheck(identity && (identity.fingerprint === null || identity.fingerprint === artifact.signerFingerprint), 400, 'NATIVE_ARTIFACT_MISMATCH');
      this.storage.sql.exec('INSERT INTO flora_native_completions VALUES(?,?,?,?)', job.id, job.appId, JSON.stringify(parseNativeLease(lease)), JSON.stringify(artifact));
      const completed = this.save({ ...job, state: 'succeeded', lease: null, updatedAt: Date.now(), artifact, artifactVerification: 'runner_reported' }); this.event(completed, 'succeeded', authority.runnerId); return completed; });
  }
  fail(authority: NativeAuthority, lease: NativeLease, codeInput: unknown, fence: Fence): NativeJob {
    nativeCheck(typeof codeInput === 'string' && failureCodes.has(codeInput));
    return this.storage.transactionSync(() => { fence(); const job = this.assertLease(authority, lease, codeInput === 'CANCELLED'), cancelled = codeInput === 'CANCELLED' || job.state === 'cancel_requested';
      const failed = this.save({ ...job, state: cancelled ? 'cancelled' : 'failed', lease: null, updatedAt: Date.now(), code: cancelled ? 'CANCELLED' : codeInput }); this.event(failed, failed.state, authority.runnerId); return failed; });
  }
  cancel(appId: string, jobId: string, fence: Fence): NativeJob {
    return this.storage.transactionSync(() => { fence(); const job = this.getJob(appId, jobId); nativeCheck(job, 404, 'NOT_FOUND');
      if (!['queued', 'leased'].includes(job.state)) return job;
      const next = this.save({ ...job, state: job.state === 'queued' ? 'cancelled' : 'cancel_requested', code: 'CANCELLED', updatedAt: Date.now() }); this.event(next, next.state); return next; });
  }
  revoke(appId: string, runnerId: string, fence: Fence): NativeRunnerSummary {
    return this.storage.transactionSync(() => { fence(); const row = this.runner(runnerId); nativeCheck(row && row.value.appId === nativeId(appId), 404, 'NOT_FOUND');
      const runner = row.value; if (runner.revokedAt !== null) return summary(runner);
      const revoked = { ...runner, credentialEpoch: runner.credentialEpoch + 1, revokedAt: Date.now() };
      this.storage.sql.exec('UPDATE flora_native_runners SET data=? WHERE id=?', JSON.stringify(revoked), runnerId);
      const jobs = this.storage.sql.exec<{ data: string }>('SELECT data FROM flora_native_jobs WHERE app_id=?', appId).toArray().map(row => JSON.parse(row.data) as NativeJob);
      for (const job of jobs) if (job.lease?.runnerId === runnerId && ['leased', 'cancel_requested'].includes(job.state)) {
        const next = this.save({ ...job, state: 'failed', code: 'RUNNER_REVOKED', lease: null, updatedAt: revoked.revokedAt }); this.event(next, 'failed', runnerId);
      }
      return summary(revoked); });
  }
}
