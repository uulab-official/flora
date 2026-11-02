import { validateSignatureExpectation, validateSignatureEvidence, validateArtifactSigning } from './aab-signature-policy.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { isBuildId, isRecord, nextBuildState, snapshotBuildScope, snapshotBuildEvent } from './build-lifecycle.mjs';
import { validateArtifactMetadata } from './native-artifact-integrity.mjs';
import { privateDirectory, privateFile, syncDirectory } from './private-paths.mjs';

const APPLICATION_ID = 0x464c4f52, SCHEMA_VERSION = 1;
const artifactIdValid = value => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value) && value.length === 24;
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const parsed = text => freeze(JSON.parse(text));
function version(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) throw new Error('BUILD_VERSION_INVALID');
  return value;
}
function queryLimit(value = 100) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new Error('BUILD_QUERY_INVALID');
  return value;
}
function context(input) {
  const scope = snapshotBuildScope(input);
  if (!isRecord(input) || !isBuildId(input.runnerId) || typeof input.repository !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(input.repository)
      || /\s/.test(input.repository) || typeof input.sourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(input.sourceSha)
      || input.sourceSha.length !== 40 || !['android', 'ios'].includes(input.platform)) throw new Error('BUILD_JOB_CONTEXT_INVALID');
  return freeze({ ...scope, repository: input.repository, sourceSha: input.sourceSha,
    platform: input.platform, runnerId: input.runnerId, provider: 'local' });
}
function fingerprint(payload) { return createHash('sha256').update(JSON.stringify(payload)).digest('hex'); }

// The directory is a trust boundary owned by the local operator. This is not an HTTP authorization layer.
export async function openDurableBuildLedger({ directory, create = false, readOnly = false }) {
  if (typeof readOnly !== 'boolean' || (readOnly && create)) throw new Error('BUILD_ARGUMENT_INVALID');
  try { directory = await privateDirectory(directory, { create }); }
  catch (error) { if (error.code === 'ENOENT') throw new Error('BUILD_LEDGER_NOT_INITIALIZED'); throw error; }
  try { await lstat(join(directory, '.flora-incomplete')); throw new Error('BUILD_STATE_INCOMPLETE'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await lstat(join(directory, '.flora-backup')); throw new Error('BUILD_BACKUP_READ_ONLY'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const path = join(directory, 'builds.sqlite');
  if (!await privateFile(path, { optional: true })) {
    if (!create) throw new Error('BUILD_LEDGER_NOT_INITIALIZED');
    let handle;
    try { handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); await handle.sync(); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { await handle?.close(); }
    await syncDirectory(directory);
  }
  await privateFile(path);
  for (const suffix of ['-journal', '-wal', '-shm']) await privateFile(path + suffix, { optional: true });
  const db = new DatabaseSync(path, { readOnly });
  try {
    db.exec('PRAGMA busy_timeout=1500; PRAGMA foreign_keys=ON;');
    const schema = db.prepare('PRAGMA user_version').get().user_version;
    const application = db.prepare('PRAGMA application_id').get().application_id;
    if (schema === 0 && application === 0 && create) {
      db.exec('BEGIN IMMEDIATE');
      try {
        // Re-read under the writer lock: another initializer may have finished.
        const nowVersion = db.prepare('PRAGMA user_version').get().user_version;
        const nowApplication = db.prepare('PRAGMA application_id').get().application_id;
        if (nowVersion === 0 && nowApplication === 0) {
          if (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get().n !== 0)
            throw new Error('BUILD_SCHEMA_UNSUPPORTED');
          db.exec(`CREATE TABLE jobs (
            app_id TEXT NOT NULL, job_id TEXT NOT NULL, context TEXT NOT NULL, state TEXT NOT NULL,
            version INTEGER NOT NULL CHECK(version >= 0), PRIMARY KEY(app_id, job_id));
          CREATE TABLE requests (
            app_id TEXT NOT NULL, job_id TEXT NOT NULL, request_key TEXT NOT NULL,
            fingerprint TEXT NOT NULL, result TEXT NOT NULL,
            PRIMARY KEY(app_id, job_id, request_key), FOREIGN KEY(app_id, job_id) REFERENCES jobs(app_id, job_id));
          CREATE TABLE audit (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL, job_id TEXT NOT NULL,
            version INTEGER NOT NULL, status TEXT NOT NULL, event_type TEXT NOT NULL, created_at TEXT NOT NULL,
            FOREIGN KEY(app_id, job_id) REFERENCES jobs(app_id, job_id));
          CREATE INDEX audit_scope ON audit(app_id, job_id, sequence);
          CREATE TABLE artifacts (
            app_id TEXT NOT NULL, job_id TEXT NOT NULL, artifact_id TEXT NOT NULL, metadata TEXT NOT NULL,
            PRIMARY KEY(app_id, job_id, artifact_id), FOREIGN KEY(app_id, job_id) REFERENCES jobs(app_id, job_id));
          PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION};`);
        } else if (nowVersion !== SCHEMA_VERSION || nowApplication !== APPLICATION_ID) throw new Error('BUILD_SCHEMA_UNSUPPORTED');
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } else if (schema !== SCHEMA_VERSION || application !== APPLICATION_ID) throw new Error('BUILD_SCHEMA_UNSUPPORTED');
    // DELETE journaling keeps the storage footprint local and the commit recoverable.
    if (!readOnly) db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
    return new DurableBuildLedger(db, readOnly);
  } catch (error) { db.close(); throw error; }
}
class DurableBuildLedger {
  #db; #closed = false; #readOnly;
  constructor(db, readOnly) { this.#db = db; this.#readOnly = readOnly; }
  #assertOpen() { if (this.#closed) throw new Error('BUILD_LEDGER_CLOSED'); }
  #transaction(fn) {
    this.#assertOpen(); if (this.#readOnly) throw new Error('BUILD_LEDGER_READ_ONLY'); let begun = false;
    try { this.#db.exec('BEGIN IMMEDIATE'); begun = true; const result = fn(); this.#db.exec('COMMIT'); return result; }
    catch (error) {
      if (begun) this.#db.exec('ROLLBACK');
      if (error.errcode === 5 || error.errcode === 6) throw new Error('BUILD_LEDGER_BUSY');
      throw error;
    }
  }
  #audit(scope, state, eventType) {
    this.#db.prepare('INSERT INTO audit(app_id,job_id,version,status,event_type,created_at) VALUES(?,?,?,?,?,?)')
      .run(scope.appId, scope.jobId, state.version, state.status, eventType, new Date().toISOString());
  }
  create(input) {
    const job = context(input);
    return this.#transaction(() => {
      if (this.#db.prepare('SELECT 1 FROM jobs WHERE app_id=? AND job_id=?').get(job.appId, job.jobId))
        throw new Error('BUILD_JOB_ALREADY_EXISTS');
      const state = { appId: job.appId, jobId: job.jobId, version: 0, status: 'unconfigured',
        artifactIntegrityVerified: false, signatureVerified: false, installVerified: false };
      this.#db.prepare('INSERT INTO jobs(app_id,job_id,context,state,version) VALUES(?,?,?,?,?)')
        .run(job.appId, job.jobId, JSON.stringify(job), JSON.stringify(state), 0);
      this.#audit(job, state, 'created'); return freeze({ ...job, ...state });
    });
  }
  async retry({ scope, newJobId, expectedVersion, idempotencyKey }) {
    scope = snapshotBuildScope(scope); version(expectedVersion);
    if (!isBuildId(newJobId)) throw new Error('BUILD_SCOPE_MISMATCH');
    snapshotBuildEvent({ status: 'authorized', idempotencyKey });
    const digest = fingerprint(['retry', expectedVersion, newJobId]);
    return this.#transaction(() => {
      const parent = this.get(scope), prior = this.#replay(scope, idempotencyKey, digest);
      if (prior) return prior;
      if (parent.version !== expectedVersion) throw new Error('BUILD_VERSION_CONFLICT');
      if (!['failed', 'cancelled'].includes(parent.status)) throw new Error('BUILD_RETRY_DENIED');
      if (this.#db.prepare('SELECT 1 FROM jobs WHERE app_id=? AND job_id=?').get(scope.appId, newJobId))
        throw new Error('BUILD_JOB_ALREADY_EXISTS');
      const job = { ...context({ ...parent, jobId: newJobId }), parentJobId: parent.jobId };
      const state = { appId: job.appId, jobId: job.jobId, version: 0, status: 'unconfigured',
        artifactIntegrityVerified: false, signatureVerified: false, installVerified: false };
      const result = { ...job, ...state };
      this.#db.prepare('INSERT INTO jobs(app_id,job_id,context,state,version) VALUES(?,?,?,?,?)')
        .run(job.appId, job.jobId, JSON.stringify(job), JSON.stringify(state), 0);
      this.#db.prepare('INSERT INTO requests(app_id,job_id,request_key,fingerprint,result) VALUES(?,?,?,?,?)')
        .run(scope.appId, scope.jobId, idempotencyKey, digest, JSON.stringify(result));
      this.#audit(job, state, 'retry-created'); return freeze(result);
    });
  }
  overview({ appId }) {
    this.#assertOpen(); if (!isBuildId(appId)) throw new Error('BUILD_QUERY_INVALID');
    const states = {}; let total = 0;
    for (const row of this.#db.prepare("SELECT json_extract(state,'$.status') AS status,count(*) AS n FROM jobs WHERE app_id=? GROUP BY status").all(appId)) {
      states[row.status] = row.n; total += row.n;
    }
    const files = this.#db.prepare("SELECT count(*) AS n,coalesce(sum(json_extract(metadata,'$.byteCount')),0) AS bytes FROM artifacts WHERE app_id=?").get(appId);
    return freeze({ appId, total, states, artifacts: files.n, byteCount: files.bytes });
  }
  get(scope) {
    this.#assertOpen(); scope = snapshotBuildScope(scope);
    const row = this.#db.prepare('SELECT context,state FROM jobs WHERE app_id=? AND job_id=?').get(scope.appId, scope.jobId);
    if (!row) throw new Error('BUILD_JOB_NOT_FOUND');
    return freeze({ ...JSON.parse(row.context), ...JSON.parse(row.state) });
  }
  list({ appId, limit = 100, afterJobId = '', search = '', status = '' }) {
    this.#assertOpen(); queryLimit(limit);
    if (!isBuildId(appId) || (afterJobId !== '' && !isBuildId(afterJobId)) || typeof search !== 'string' || search.length > 128
        || /[\x00-\x1f\x7f]/.test(search) || !['', 'unconfigured', 'authorized', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'unknown'].includes(status))
      throw new Error('BUILD_QUERY_INVALID');
    return this.#db.prepare("SELECT context,state FROM jobs WHERE app_id=? AND job_id>? AND instr(lower(job_id),lower(?))>0 AND (?='' OR json_extract(state,'$.status')=?) ORDER BY job_id LIMIT ?")
      .all(appId, afterJobId, search, status, status, limit).map(row => freeze({ ...JSON.parse(row.context), ...JSON.parse(row.state) }));
  }
  history(scope, { limit = 100, afterSequence = 0 } = {}) {
    this.#assertOpen(); scope = snapshotBuildScope(scope); queryLimit(limit);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error('BUILD_QUERY_INVALID');
    this.get(scope);
    return this.#db.prepare(`SELECT sequence, version, status, event_type AS eventType, created_at AS createdAt
      FROM audit WHERE app_id=? AND job_id=? AND sequence>? ORDER BY sequence LIMIT ?`)
      .all(scope.appId, scope.jobId, afterSequence, limit).map(row => freeze({ ...row }));
  }
  // Internal runner hook: fixed vocabulary, same job version, no logs or arbitrary metadata.
  recordProgress(input) {
    const stages = ['runner-process-starting', 'runner-process-exited', 'runner-artifact-verifying', 'runner-artifact-publishing'];
    if (!isRecord(input) || Object.keys(input).some(k => !['scope', 'expectedVersion', 'runnerId', 'stage'].includes(k))
        || !stages.includes(input.stage)) throw new Error('BUILD_PROGRESS_INVALID');
    const scope = snapshotBuildScope(input.scope), expectedVersion = version(input.expectedVersion);
    const { runnerId, stage } = input;
    return this.#transaction(() => {
      const current = this.get(scope);
      if (current.runnerId !== runnerId) throw new Error('BUILD_EXECUTION_MISMATCH');
      if (current.version !== expectedVersion) throw new Error('BUILD_VERSION_CONFLICT');
      if (current.status !== 'running') throw new Error('BUILD_PROGRESS_NOT_RUNNING');
      const prior = this.#db.prepare("SELECT event_type AS stage FROM audit WHERE app_id=? AND job_id=? AND version=? AND event_type LIKE 'runner-%' ORDER BY sequence")
        .all(scope.appId, scope.jobId, expectedVersion);
      if (prior.some(e => e.stage === stage)) return freeze({ stage, version: expectedVersion, recorded: false });
      if (prior.length >= stages.length || stages[prior.length] !== stage) throw new Error('BUILD_PROGRESS_ORDER');
      this.#audit(scope, current, stage);
      return freeze({ stage, version: expectedVersion, recorded: true });
    });
  }
  #replay(scope, key, digest) {
    const row = this.#db.prepare('SELECT fingerprint,result FROM requests WHERE app_id=? AND job_id=? AND request_key=?')
      .get(scope.appId, scope.jobId, key);
    if (!row) return null;
    if (row.fingerprint !== digest) throw new Error('BUILD_IDEMPOTENCY_CONFLICT');
    return freeze({ ...JSON.parse(row.result), replayed: true });
  }
  #save(current, state, key, digest, result, kind) {
    const changed = this.#db.prepare('UPDATE jobs SET state=?,version=? WHERE app_id=? AND job_id=? AND version=?')
      .run(JSON.stringify(state), state.version, current.appId, current.jobId, current.version);
    if (changed.changes !== 1) throw new Error('BUILD_VERSION_CONFLICT');
    this.#db.prepare('INSERT INTO requests(app_id,job_id,request_key,fingerprint,result) VALUES(?,?,?,?,?)')
      .run(current.appId, current.jobId, key, digest, JSON.stringify(result));
    this.#audit(current, state, kind); return freeze(result);
  }
  async transition({ scope, event, expectedVersion }) {
    scope = snapshotBuildScope(scope); event = snapshotBuildEvent(event); version(expectedVersion);
    if (event.status === 'succeeded') throw new Error('BUILD_COMPLETION_REQUIRED');
    const digest = fingerprint(['transition', expectedVersion, event]);
    return this.#transaction(() => {
      const current = this.get(scope), prior = this.#replay(scope, event.idempotencyKey, digest);
      if (prior) return prior;
      if (current.version !== expectedVersion) throw new Error('BUILD_VERSION_CONFLICT');
      const state = nextBuildState(current, event, scope);
      return this.#save(current, state, event.idempotencyKey, digest, { ...current, ...state }, 'transition');
    });
  }
  #completion({ scope, manifest, execution, format, idempotencyKey, expectedVersion, signatureExpectation }) {
    scope = snapshotBuildScope(scope); version(expectedVersion);
    const job = this.get(scope), event = snapshotBuildEvent({ status: 'succeeded', idempotencyKey,
      artifactIntegrityVerified: true, executionVerified: true });
    validateArtifactMetadata({ manifest, expected: job, byteCount: manifest?.byteCount });
    if (!isRecord(execution) || execution.exitCode !== 0 || execution.runnerId !== job.runnerId
        || ['appId', 'jobId', 'repository', 'sourceSha', 'platform'].some(key => execution[key] !== job[key]))
      throw new Error('BUILD_EXECUTION_MISMATCH');
    if (!(job.platform === 'android' ? ['apk', 'aab'] : ['ipa']).includes(format)) throw new Error('BUILD_ARTIFACT_FORMAT_INVALID');
    const metadata = { ...snapshotBuildScope(job), repository: job.repository, sourceSha: job.sourceSha,
      platform: job.platform, byteCount: manifest.byteCount, sha256: manifest.sha256, format };
    const expectation = signatureExpectation == null ? null : validateSignatureExpectation(signatureExpectation);
    if (expectation && (job.platform !== 'android' || format !== 'aab')) throw new Error('ARTIFACT_SIGNATURE_POLICY_INVALID');
    // Preserve byte-for-byte compatibility with legacy unsigned request fingerprints.
    const payload = ['complete', expectedVersion, event, metadata, job.runnerId, 0];
    if (expectation) payload.push(expectation);
    const digest = fingerprint(payload);
    return { job, scope, event, metadata, digest, expectedVersion, expectation };
  }
  prepareCompletion(input) {
    const contract = this.#completion(input), prior = this.#replay(contract.scope, contract.event.idempotencyKey, contract.digest);
    if (!prior) this.#canComplete(contract);
    return freeze({ job: contract.job, replay: prior });
  }
  #canComplete({ job, expectedVersion }) {
    if (job.version !== expectedVersion) throw new Error('BUILD_VERSION_CONFLICT');
    if (!['running', 'unknown'].includes(job.status)) throw new Error('BUILD_TRANSITION_DENIED');
  }
  async complete(input) {
    // Called only after the service verifies and publishes bytes. It does not verify bytes itself.
    return this.#transaction(() => {
      const contract = this.#completion(input), { job, scope, event, metadata, digest } = contract;
      const prior = this.#replay(scope, event.idempotencyKey, digest); if (prior) return prior;
      this.#canComplete(contract);
      const receipt = input.receipt;
      if (!isRecord(receipt) || !artifactIdValid(receipt.artifactId) || receipt.storage !== 'local-only'
          || receipt.integrityVerified !== true || Object.entries(metadata).some(([key, value]) => key !== 'format' && receipt[key] !== value))
        throw new Error('BUILD_ARTIFACT_NOT_VERIFIED');
      let signatureEvidence;
      if (contract.expectation) signatureEvidence = validateSignatureEvidence(input.signatureEvidence, metadata, contract.expectation);
      else if (input.signatureEvidence !== undefined) throw new Error('ARTIFACT_SIGNATURE_EVIDENCE_INVALID');
      const artifact = freeze({ ...metadata, artifactId: receipt.artifactId, storage: 'local-only',
        integrityVerified: true, signatureVerified: Boolean(signatureEvidence), installVerified: false, createdAt: new Date().toISOString(),
        ...(signatureEvidence ? { signatureEvidence } : {}) });
      this.#db.prepare('INSERT INTO artifacts(app_id,job_id,artifact_id,metadata) VALUES(?,?,?,?)')
        .run(scope.appId, scope.jobId, artifact.artifactId, JSON.stringify(artifact));
      const state = nextBuildState(job, event, scope);
      return this.#save(job, state, event.idempotencyKey, digest, { ...job, ...state, artifact }, 'completed');
    });
  }
  artifacts(scope) {
    this.#assertOpen(); scope = snapshotBuildScope(scope); this.get(scope);
    return this.#db.prepare('SELECT metadata FROM artifacts WHERE app_id=? AND job_id=? ORDER BY artifact_id LIMIT 100')
      .all(scope.appId, scope.jobId).map(row => { const a = parsed(row.metadata); validateArtifactSigning(a); return a; });
  }
  artifact(scope, artifactId) {
    this.#assertOpen(); scope = snapshotBuildScope(scope);
    if (!artifactIdValid(artifactId)) throw new Error('BUILD_ARTIFACT_NOT_FOUND');
    const row = this.#db.prepare('SELECT metadata FROM artifacts WHERE app_id=? AND job_id=? AND artifact_id=?')
      .get(scope.appId, scope.jobId, artifactId);
    if (!row) throw new Error('BUILD_ARTIFACT_NOT_FOUND'); const a = parsed(row.metadata); validateArtifactSigning(a); return a;
  }
  inventory({ limit = 100, appId, after = null } = {}) {
    this.#assertOpen(); queryLimit(limit);
    if (appId !== undefined && !isBuildId(appId)) throw new Error('BUILD_QUERY_INVALID');
    if (after !== null && (!isRecord(after) || !isBuildId(after.appId) || !isBuildId(after.jobId) || !artifactIdValid(after.artifactId)))
      throw new Error('BUILD_QUERY_INVALID');
    return this.#db.prepare(`SELECT metadata FROM artifacts WHERE (?='' OR app_id=?)
      AND (app_id,job_id,artifact_id)>(?,?,?) ORDER BY app_id,job_id,artifact_id LIMIT ?`)
      .all(appId ?? '', appId ?? '', after?.appId ?? '', after?.jobId ?? '', after?.artifactId ?? '', limit).map(row => parsed(row.metadata));
  }
  diagnostics({ appId } = {}) {
    this.#assertOpen();
    if (appId !== undefined && !isBuildId(appId)) throw new Error('BUILD_QUERY_INVALID');
    const args = [appId ?? '', appId ?? ''], states = {};
    for (const row of this.#db.prepare("SELECT json_extract(state,'$.status') AS status,count(*) AS n FROM jobs WHERE (?='' OR app_id=?) GROUP BY status").all(...args)) states[row.status] = row.n;
    return freeze({ ...(appId === undefined ? {} : { appId }), schemaVersion: SCHEMA_VERSION,
      databaseIntegrity: this.#db.prepare('PRAGMA quick_check').get().quick_check === 'ok',
      jobs: this.#db.prepare("SELECT count(*) AS n FROM jobs WHERE (?='' OR app_id=?)").get(...args).n,
      artifacts: this.#db.prepare("SELECT count(*) AS n FROM artifacts WHERE (?='' OR app_id=?)").get(...args).n,
      revision: this.#db.prepare("SELECT coalesce(max(sequence),0) AS n FROM audit WHERE (?='' OR app_id=?)").get(...args).n, states });
  }
  close() { if (!this.#closed) { this.#db.close(); this.#closed = true; } }
}
