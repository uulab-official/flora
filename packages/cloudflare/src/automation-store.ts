import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { canonicalJson, freeze } from "@app-ops/config";
import { DomainError, ensure, id, integer } from "@app-ops/core";
import { applicationId, automationArtifactPayload, automationDigest, assertAutomationLease, assertAutomationPublication, parseAutomationFailureCode, parseAutomationJob,
  parseAutomationLease, parseAutomationClaimScope, parseRunnerAuthority, parseRunnerCredential, parseAutoPolicyUpdate, AUTOMATION_ATTEMPT_MAX_MS, AUTOMATION_LEASE_MAX_MS, OTA_ASSET_MAX_BYTES } from "@app-ops/dogfood";
import type { ApplicationStore, AutomationStore, AutomationJob, AutomationAttempt, AutomationEvent, AutomationLease, AutomationPublication,
  RunnerAuthority, RunnerCredential, RunnerSummary, AutoPolicy } from "@app-ops/dogfood";
import type { D1OperationsStore } from "./operations-store.js";
type Row = Record<string, string | number | null>;
interface Snapshot { job: AutomationJob; attempt: AutomationAttempt | null; event: AutomationEvent }
interface Current { version: number; snapshot: Snapshot }
const encoder = new TextEncoder();
const read = <T>(row: Row): T => freeze(JSON.parse(String(row.data)) as T);
const copy = <T>(input: T): T => freeze(JSON.parse(canonicalJson(input)) as T);
const summary = ({ tokenHash: _secret, ...runner }: RunnerCredential): RunnerSummary => freeze(runner);
function charge(fields: unknown[]) { const bytes = encoder.encode(canonicalJson(fields)).byteLength; ensure(bytes <= 524288, "INPUT_TOO_LARGE"); return bytes; }
const transitionColumns = ["owner_id", "app_id", "job_id", "version", "now", "kind", "authority_json", "lease_json", "data"];
export function createD1AutomationStore(db: D1Database, owner: string, applications: ApplicationStore, operations: D1OperationsStore,
  verify: () => Promise<void>, beforeCommit: () => void): AutomationStore {
  function insert(table: string, columns: string[], fields: (string | number | null)[], suffix = "", extra: (string | number | null)[] = []) {
    return db.prepare(`INSERT INTO ${table}(${columns.join(",")},stored_bytes) SELECT ${fields.map(() => "?").join(",")},? ${suffix}`).bind(...fields, charge(fields), ...extra);
  }
  async function submit(statements: D1PreparedStatement[]) {
    beforeCommit();
    try { return await db.batch<Row>(statements); }
    catch (error) {
      if (error instanceof Error) {
        if (/runner authority/.test(error.message)) throw new DomainError("PERMISSION_DENIED");
        if (/lease fence/.test(error.message)) throw new DomainError("LEASE_STALE");
        if (/automation conflict|flora capacity exceeded|deployment timestamp conflict|deployment provenance mismatch|UNIQUE constraint failed/.test(error.message)) throw new DomainError("CONFLICT");
      }
      throw error;
    }
  }
  const runnerQuery = (runnerId: string) => db.prepare("SELECT data,version FROM automation_runners WHERE owner_id=? AND id=? ORDER BY version DESC LIMIT 1").bind(owner, runnerId);
  const jobQuery = (appId: string, jobId: string) => db.prepare("SELECT data,version FROM automation_transitions WHERE owner_id=? AND app_id=? AND job_id=? ORDER BY version DESC LIMIT 1").bind(owner, appId, jobId);
  async function current(appId: string, jobId: string): Promise<Current | null> {
    applicationId(appId); id(jobId); const row = await jobQuery(appId, jobId).first<Row>(); return row ? { version: Number(row.version), snapshot: read<Snapshot>(row) } : null;
  }
  async function credential(authority: RunnerAuthority, appId?: string): Promise<RunnerCredential> {
    const row = await runnerQuery(authority.runnerId).first<Row>(); ensure(row, "PERMISSION_DENIED"); const runner = read<RunnerCredential>(row);
    ensure(runner.tokenHash === authority.tokenHash && runner.credentialEpoch === authority.credentialEpoch && runner.revokedAt === null
      && (appId === undefined || runner.appIds.includes(appId)), "PERMISSION_DENIED"); return runner;
  }
  async function leaseState(authorityInput: RunnerAuthority, leaseInput: AutomationLease, now: number, allowCancel = false) {
    const authority = parseRunnerAuthority(authorityInput), lease = parseAutomationLease(leaseInput); integer(now); await verify();
    const runner = await credential(authority, lease.appId), found = await current(lease.appId, lease.jobId); ensure(found, "LEASE_STALE");
    const job = found.snapshot.job;
    assertAutomationLease(job, authority, lease, now, runner, allowCancel);
    ensure(found.snapshot.attempt && now < found.snapshot.attempt.claimedAt + AUTOMATION_ATTEMPT_MAX_MS, "LEASE_STALE");
    ensure(now >= job.updatedAt); return { authority, lease, runner, found };
  }
  function transitionFields(found: Current | null, job: AutomationJob, attempt: AutomationAttempt | null, kind: AutomationEvent["kind"], now: number,
    authority: RunnerAuthority | null = null, lease: AutomationLease | null = null): (string | number | null)[] {
    const event: AutomationEvent = { jobId: job.id, sequence: (found?.snapshot.event.sequence ?? 0) + 1, createdAt: now, kind,
      attemptId: attempt?.id ?? null, runnerId: attempt?.runnerId ?? null, code: job.code };
    const snapshot: Snapshot = { job: parseAutomationJob(job), attempt, event };
    return [owner, job.appId, job.id, (found?.version ?? -1) + 1, now, kind, authority ? canonicalJson(authority) : null, lease ? canonicalJson(lease) : null, canonicalJson(snapshot)];
  }
  async function commit(found: Current, job: AutomationJob, attempt: AutomationAttempt | null, kind: AutomationEvent["kind"], now: number,
    authority: RunnerAuthority | null = null, lease: AutomationLease | null = null): Promise<AutomationJob> {
    const fields = transitionFields(found, job, attempt, kind, now, authority, lease);
    const result = await submit([insert("automation_transitions", transitionColumns, fields), jobQuery(job.appId, job.id)]);
    const row = result[1]?.results[0]; ensure(row, "CONFLICT"); return read<Snapshot>(row).job;
  }
  function guard(authority: RunnerAuthority, lease: AutomationLease, now: number) {
    const fields = [owner, lease.appId, "guard_" + crypto.randomUUID(), lease.jobId, now, canonicalJson(authority), canonicalJson(lease)];
    return insert("automation_guards", ["owner_id", "app_id", "id", "job_id", "now", "authority_json", "lease_json"], fields);
  }
  const store: AutomationStore = {
    async getAutomationPolicy(appId) {
      applicationId(appId); await verify(); const row = await db.prepare("SELECT data FROM automation_policies WHERE owner_id=? AND app_id=? ORDER BY version DESC LIMIT 1").bind(owner, appId).first<Row>();
      return row ? read<AutoPolicy>(row) : { appId, version: 0, enabled: false, channel: "production", platform: "ios", updatedAt: 0 };
    },
    async updateAutomationPolicy(appId, input, now) {
      const update = parseAutoPolicyUpdate(input); integer(now); ensure(await applications.getApplication(appId), "NOT_FOUND");
      const current = await store.getAutomationPolicy(appId); ensure(current.version === update.expectedVersion, "CONFLICT"); ensure(now >= current.updatedAt);
      const { expectedVersion: _expectedVersion, ...selection } = update;
      const policy: AutoPolicy = copy({ appId, version: current.version + 1, ...selection, updatedAt: now });
      await submit([insert("automation_policies", ["owner_id", "app_id", "version", "data"], [owner, appId, policy.version, canonicalJson(policy)])]); return policy;
    },
    async findAutomationTargets(input) {
      integer(input.installationId, 1); await verify();
      const rows = await db.prepare(`SELECT p.app_id,p.data FROM automation_policies p JOIN github_connections c ON c.owner_id=p.owner_id AND c.app_id=p.app_id
        WHERE p.owner_id=? AND p.version=(SELECT max(version) FROM automation_policies WHERE owner_id=p.owner_id AND app_id=p.app_id)
        AND c.version=(SELECT max(version) FROM github_connections WHERE owner_id=c.owner_id AND app_id=c.app_id)
        AND json_extract(p.data,'$.enabled')=1 AND json_extract(c.data,'$.installationId')=? AND lower(json_extract(c.data,'$.owner'))=lower(?)
        AND lower(json_extract(c.data,'$.repository'))=lower(?) AND json_extract(c.data,'$.ref')=? ORDER BY p.app_id LIMIT 5`).bind(owner, input.installationId, input.owner, input.repository, input.ref).all<Row>();
      return rows.results.map(row => ({ appId: String(row.app_id), policy: read<AutoPolicy>(row) }));
    },
    async registerRunner(input) {
      const runner = parseRunnerCredential(input); await verify(); ensure(runner.credentialEpoch === 1 && runner.revokedAt === null);
      const apps = new Set((await applications.listApplications()).map(app => app.id)); ensure(runner.appIds.every(appId => apps.has(appId)), "NOT_FOUND");
      await submit([insert("automation_runners", ["owner_id", "id", "version", "data"], [owner, runner.id, 1, canonicalJson(runner)])]); return summary(runner);
    },
    async getRunnerCredential(runnerId) { id(runnerId); await verify(); const row = await runnerQuery(runnerId).first<Row>(); return row ? read<RunnerCredential>(row) : null; },
    async listRunners(appId) {
      applicationId(appId); await verify(); const result = await db.prepare(`SELECT data FROM automation_runners r WHERE owner_id=? AND version=(SELECT max(version) FROM automation_runners WHERE owner_id=r.owner_id AND id=r.id)
        AND EXISTS(SELECT 1 FROM json_each(r.data,'$.appIds') WHERE value=?) ORDER BY id LIMIT 100`).bind(owner, appId).all<Row>();
      return result.results.map(row => summary(read<RunnerCredential>(row)));
    },
    async revokeRunner(runnerId, now) {
      id(runnerId); integer(now); await verify(); const row = await runnerQuery(runnerId).first<Row>(); ensure(row, "NOT_FOUND"); const runner = read<RunnerCredential>(row);
      if (runner.revokedAt !== null) return summary(runner); ensure(now >= runner.createdAt);
      const revoked = copy({ ...runner, credentialEpoch: runner.credentialEpoch + 1, revokedAt: now });
      const active = await db.prepare(`SELECT data,version FROM automation_transitions t WHERE owner_id=? AND version=(SELECT max(version) FROM automation_transitions WHERE owner_id=t.owner_id AND app_id=t.app_id AND job_id=t.job_id)
        AND json_extract(data,'$.job.state') IN ('leased','cancel_requested') AND json_extract(data,'$.job.lease.runnerId')=? LIMIT 100`).bind(owner, runnerId).all<Row>();
      const prepared = active.results.map(row => {
        const found: Current = { version: Number(row.version), snapshot: read<Snapshot>(row) }, job = found.snapshot.job; ensure(now >= job.updatedAt);
        return transitionFields(found, { ...job, state: "failed", lease: null, code: "RUNNER_REVOKED", updatedAt: now },
          found.snapshot.attempt ? { ...found.snapshot.attempt, endedAt: now, outcome: "failed", code: "RUNNER_REVOKED" } : null, "failed", now);
      });
      const statements = [insert("automation_runners", ["owner_id", "id", "version", "data"], [owner, runner.id, Number(row.version) + 1, canonicalJson(revoked)])];
      // At most five statements close all100 active jobs; each row still runs its CAS and quota triggers.
      for (let start = 0; start < prepared.length; start += 20) {
        const packed = prepared.slice(start, start + 20).map(fields => ({ fields, bytes: charge(fields) }));
        const payload = canonicalJson(packed); ensure(encoder.encode(payload).byteLength <= 1900000, "INPUT_TOO_LARGE");
        statements.push(db.prepare(`INSERT INTO automation_transitions(${transitionColumns.join(",")},stored_bytes) SELECT ${transitionColumns.map((_, index) => `json_extract(value,'$.fields[${index}]')`).join(",")},json_extract(value,'$.bytes') FROM json_each(?)`).bind(payload));
      }
      await submit(statements); return summary(revoked);
    },
    async enqueueAutomationJob(input, expectedPolicyVersion?: number) {
      const job = parseAutomationJob(input); await verify(); ensure(job.state === "queued" && job.attemptCount === 0 && job.lease === null && job.receipt === null && job.code === null && job.updatedAt === job.createdAt);
      const requestLookup = () => db.prepare(`SELECT t.data FROM automation_jobs j JOIN automation_transitions t ON t.owner_id=j.owner_id AND t.app_id=j.app_id AND t.job_id=j.id WHERE j.owner_id=? AND j.app_id=? AND j.request_key=? AND t.version=(SELECT max(version) FROM automation_transitions WHERE owner_id=j.owner_id AND app_id=j.app_id AND job_id=j.id)`).bind(owner, job.appId, job.requestKey);
      const existingRow = await requestLookup().first<Row>(); const existing = existingRow ? read<Snapshot>(existingRow).job : null;
      const comparable = (value: AutomationJob) => ({ ...value, id: "", createdAt: 0, updatedAt: 0, state: "queued", attemptCount: 0, lease: null, code: null, deploymentId: null, receipt: null });
      if (existing) { ensure(canonicalJson(comparable(existing)) === canonicalJson(comparable(job)), "IDEMPOTENCY_CONFLICT"); return existing; }
      ensure(job.detection.automationConfig && canonicalJson(job.detection.automationConfig) === canonicalJson(job.config), "CONFIG_CONFLICT");
      ensure(job.configDigest === await automationDigest(job.config) && job.toolchainDigest === await automationDigest(job.config.toolchain), "INVALID_RELATION");
      const detectionRow = await db.prepare("SELECT data FROM github_detections WHERE owner_id=? AND app_id=? AND id=?").bind(owner, job.appId, job.detectionId).first<Row>();
      const connectionRow = await db.prepare("SELECT data FROM github_connections WHERE owner_id=? AND app_id=? ORDER BY version DESC LIMIT 1").bind(owner, job.appId).first<Row>();
      const detection = detectionRow ? read<AutomationJob["detection"]>(detectionRow) : null, connection = connectionRow ? read<AutomationJob["connection"]>(connectionRow) : null;
      ensure(detection && canonicalJson(detection) === canonicalJson(job.detection) && connection && canonicalJson(connection) === canonicalJson(job.connection), "CONFIG_CONFLICT");
      if (expectedPolicyVersion !== undefined) integer(expectedPolicyVersion);
      const policyPredicate = expectedPolicyVersion === undefined ? "" : ` AND EXISTS(SELECT 1 FROM automation_policies p WHERE p.owner_id=? AND p.app_id=?
        AND p.version=(SELECT max(version) FROM automation_policies WHERE owner_id=p.owner_id AND app_id=p.app_id)
        AND p.version=? AND json_extract(p.data,'$.enabled')=1 AND json_extract(p.data,'$.channel')=?
        AND ((json_type(p.data,'$.platforms') IS NULL AND json_extract(p.data,'$.platform')=?)
          OR (json_type(p.data,'$.platform') IS NULL AND json_type(p.data,'$.platforms')='array' AND EXISTS(SELECT 1 FROM json_each(p.data,'$.platforms') WHERE value=?))))`;
      const policyBindings = expectedPolicyVersion === undefined ? [] : [owner, job.appId, expectedPolicyVersion, job.channel, job.platform, job.platform];
      const fields = [owner, job.appId, job.id, job.requestKey, job.createdAt, canonicalJson(job)];
      const result = await submit([insert("automation_jobs", ["owner_id", "app_id", "id", "request_key", "created_at", "data"], fields, "WHERE NOT EXISTS(SELECT 1 FROM automation_jobs WHERE owner_id=? AND app_id=? AND request_key=?)" + policyPredicate, [owner, job.appId, job.requestKey, ...policyBindings]),
        insert("automation_transitions", transitionColumns, transitionFields(null, job, null, "queued", job.createdAt), "WHERE EXISTS(SELECT 1 FROM automation_jobs WHERE owner_id=? AND app_id=? AND id=?) AND NOT EXISTS(SELECT 1 FROM automation_transitions WHERE owner_id=? AND app_id=? AND job_id=? AND version=0)" + policyPredicate, [owner, job.appId, job.id, owner, job.appId, job.id, ...policyBindings]), requestLookup()]);
      const row = result[2]?.results[0]; ensure(row, expectedPolicyVersion === undefined ? "CONFLICT" : "CONFIG_CONFLICT"); const saved = read<Snapshot>(row).job;
      ensure(canonicalJson(comparable(saved)) === canonicalJson(comparable(job)), "IDEMPOTENCY_CONFLICT"); return saved;
    },
    async getAutomationJob(appId, jobId) { await verify(); return (await current(appId, jobId))?.snapshot.job ?? null; },
    async getAutomationJobForRequest(appId, requestKey) {
      applicationId(appId); id(requestKey); await verify(); const row = await db.prepare(`SELECT t.data FROM automation_jobs j JOIN automation_transitions t ON t.owner_id=j.owner_id AND t.app_id=j.app_id AND t.job_id=j.id
        WHERE j.owner_id=? AND j.app_id=? AND j.request_key=? AND t.version=(SELECT max(version) FROM automation_transitions WHERE owner_id=j.owner_id AND app_id=j.app_id AND job_id=j.id)`).bind(owner, appId, requestKey).first<Row>();
      return row ? read<Snapshot>(row).job : null;
    },
    async listAutomationJobs(appId) {
      applicationId(appId); await verify(); const rows = await db.prepare(`SELECT data FROM automation_transitions t WHERE owner_id=? AND app_id=? AND version=(SELECT max(version) FROM automation_transitions WHERE owner_id=t.owner_id AND app_id=t.app_id AND job_id=t.job_id) ORDER BY json_extract(data,'$.job.createdAt') DESC,job_id DESC LIMIT 20`).bind(owner, appId).all<Row>();
      return rows.results.map(row => read<Snapshot>(row).job);
    },
    async listAutomationAttempts(appId, jobId) {
      applicationId(appId); id(jobId); await verify(); const rows = await db.prepare(`SELECT data FROM automation_transitions t WHERE owner_id=? AND app_id=? AND job_id=? AND json_extract(data,'$.attempt.id') IS NOT NULL AND version=(SELECT max(version) FROM automation_transitions WHERE owner_id=t.owner_id AND app_id=t.app_id AND job_id=t.job_id AND json_extract(data,'$.attempt.id')=json_extract(t.data,'$.attempt.id')) ORDER BY version LIMIT 3`).bind(owner, appId, jobId).all<Row>();
      return rows.results.map(row => read<Snapshot>(row).attempt!);
    },
    async listAutomationEvents(appId, jobId) {
      applicationId(appId); id(jobId); await verify(); const rows = await db.prepare("SELECT data FROM automation_transitions WHERE owner_id=? AND app_id=? AND job_id=? ORDER BY version DESC LIMIT 100").bind(owner, appId, jobId).all<Row>();
      return rows.results.reverse().map(row => read<Snapshot>(row).event);
    },
    async claimAutomationJob(input, now, leaseMs, scope) {
      if (scope) scope = parseAutomationClaimScope(scope);
      const authority = parseRunnerAuthority(input); integer(now); integer(leaseMs, 1, AUTOMATION_LEASE_MAX_MS); await verify(); const runner = await credential(authority);
      // Visit registered jobs once and seek each job's latest immutable fact.
      // Polling must not re-scan all historic heartbeat versions of each job.
      const row = await db.prepare(`SELECT t.data,t.version FROM automation_jobs j JOIN automation_transitions t
        ON t.rowid=(SELECT rowid FROM automation_transitions WHERE owner_id=j.owner_id AND app_id=j.app_id AND job_id=j.id ORDER BY version DESC LIMIT 1)
        WHERE j.owner_id=? AND j.app_id IN(SELECT value FROM json_each(?)) AND (json_extract(t.data,'$.job.state')='queued' OR (json_extract(t.data,'$.job.state') IN ('leased','cancel_requested') AND json_extract(t.data,'$.job.lease.expiresAt')<=?))
        ${scope ? "AND t.app_id=? AND json_extract(t.data,'$.job.commitSha')=?" + (scope.platform ? " AND json_extract(t.data,'$.job.platform')=?" : "") : ""} ORDER BY json_extract(t.data,'$.job.createdAt'),t.job_id LIMIT 1`).bind(owner, canonicalJson(runner.appIds), now, ...(scope ? [scope.appId, scope.commitSha, ...(scope.platform ? [scope.platform] : [])] : [])).first<Row>();
      if (!row) return null; let found: Current = { version: Number(row.version), snapshot: read<Snapshot>(row) };
      if (found.snapshot.job.state !== "queued") { const expired = await store.expireAutomationJob(found.snapshot.job.appId, found.snapshot.job.id, now); if (expired.state !== "queued") return null; found = (await current(expired.appId, expired.id))!; }
      const job = found.snapshot.job; ensure(now >= job.updatedAt); ensure(job.attemptCount < 3, "INVALID_TRANSITION");
      const lease: AutomationLease = copy({ jobId: job.id, appId: job.appId, attemptId: "attempt_" + crypto.randomUUID(), runnerId: runner.id, credentialEpoch: runner.credentialEpoch, fence: job.attemptCount + 1, expiresAt: integer(now + leaseMs) });
      const attempt: AutomationAttempt = { id: lease.attemptId, jobId: job.id, runnerId: runner.id, credentialEpoch: runner.credentialEpoch, fence: lease.fence, claimedAt: now, expiresAt: lease.expiresAt, endedAt: null, outcome: null, code: null };
      const claimed = await commit(found, { ...job, state: "leased", updatedAt: now, attemptCount: job.attemptCount + 1, lease, code: null }, attempt, "claimed", now, authority); return { job: claimed, lease };
    },
    async requireAutomationLease(authority, lease, now) { return (await leaseState(authority, lease, now)).found.snapshot.job; },
    async heartbeatAutomationJob(authorityInput, leaseInput, now, leaseMs) {
      integer(leaseMs, 1, AUTOMATION_LEASE_MAX_MS); const { authority, lease, found } = await leaseState(authorityInput, leaseInput, now);
      const attempt = found.snapshot.attempt!, expiresAt = integer(Math.min(now + leaseMs, attempt.claimedAt + AUTOMATION_ATTEMPT_MAX_MS)); ensure(expiresAt > now, "LEASE_STALE");
      const next = { ...found.snapshot.job.lease!, expiresAt }; const updated = await commit(found, { ...found.snapshot.job, updatedAt: now, lease: next }, { ...attempt, expiresAt }, "heartbeat", now, authority, lease);
      return updated.lease!;
    },
    async saveAutomationAsset(authorityInput, leaseInput, input, bytes, now) {
      const startedAt = Date.now();
      const authority = parseRunnerAuthority(authorityInput), lease = parseAutomationLease(leaseInput), asset = copy(input); integer(now);
      ensure(bytes instanceof Uint8Array && bytes.length <= OTA_ASSET_MAX_BYTES, "INPUT_TOO_LARGE"); const ownedBytes = bytes.slice();
      await verify(); ensure(asset.appId === lease.appId, "INVALID_RELATION");
      if(operations.externalAssets)await leaseState(authority,lease,now);
      // The first batch statement atomically validates the current Runner and lease.
      // Its job foreign key establishes registration without redundant app reads.
      const prepared = await operations.prepareOTAAsset(asset, ownedBytes, true, true);
      // External I/O may outlive the admitted lease. Keep the caller's logical
      // time in tests, but account for elapsed wall time in the atomic SQL fence.
      const commitNow = operations.externalAssets ? integer(now + Math.max(0, Date.now() - startedAt)) : now;
      const fields = [owner, lease.appId, lease.jobId, lease.attemptId, asset.digest];
      const statements = [guard(authority, lease, commitNow), ...prepared.statements,
        insert("automation_asset_refs", ["owner_id", "app_id", "job_id", "attempt_id", "asset_hash"], fields,
          "WHERE NOT EXISTS(SELECT 1 FROM automation_asset_refs WHERE owner_id=? AND app_id=? AND job_id=? AND attempt_id=? AND asset_hash=?)", fields)];
      const results = await submit(statements); return prepared.existing ?? prepared.readAsset(results.slice(1, 1 + prepared.statements.length));
    },
    async finalizeAutomationJob(authorityInput, leaseInput, input, now) {
      const publication = copy(input), authority = parseRunnerAuthority(authorityInput), lease = parseAutomationLease(leaseInput); integer(now); await verify();
      await credential(authority, lease.appId); const prior = await current(lease.appId, lease.jobId); ensure(prior, "LEASE_STALE");
      if (prior.snapshot.job.state === "succeeded") {
        ensure(prior.snapshot.attempt?.id === lease.attemptId && prior.snapshot.attempt.runnerId === authority.runnerId && prior.snapshot.attempt.credentialEpoch === authority.credentialEpoch && prior.snapshot.attempt.fence === lease.fence, "LEASE_STALE");
        ensure(canonicalJson(prior.snapshot.job.receipt) === canonicalJson(publication.receipt), "IDEMPOTENCY_CONFLICT");
        const prepared = await operations.prepareOTADeployment(publication.deployment); ensure(prepared.existing && prepared.existing.id === prior.snapshot.job.deploymentId, "IDEMPOTENCY_CONFLICT"); return { job: prior.snapshot.job, deployment: prepared.existing };
      }
      const { found } = await leaseState(authority, lease, now); assertAutomationPublication(found.snapshot.job, lease, publication);
      const references = await db.prepare("SELECT asset_hash FROM automation_asset_refs WHERE owner_id=? AND app_id=? AND job_id=? AND attempt_id=? LIMIT 128").bind(owner, lease.appId, lease.jobId, lease.attemptId).all<Row>();
      const attached = new Set(references.results.map(row => String(row.asset_hash)));
      ensure([publication.receipt.launchAssetId, ...publication.receipt.assetIds].every(assetId => attached.has(assetId.slice(6))), "INVALID_RELATION");
      ensure(publication.receipt.artifactDigest === await automationDigest(automationArtifactPayload(publication.receipt, [publication.deployment.launchAsset, ...publication.deployment.assets])), "INVALID_RELATION");
      const prepared = await operations.prepareOTADeployment(publication.deployment), deploymentId = prepared.existing?.id ?? publication.deployment.id;
      const job: AutomationJob = { ...found.snapshot.job, state: "succeeded", lease: null, updatedAt: now, code: null, deploymentId, receipt: publication.receipt };
      const terminal = transitionFields(found, job, { ...found.snapshot.attempt!, endedAt: now, outcome: "succeeded", code: null }, "succeeded", now, authority, lease);
      const proof = [owner, lease.appId, lease.jobId, lease.attemptId, deploymentId, canonicalJson(publication.receipt)];
      const result = await submit([guard(authority, lease, now), insert("automation_transitions", transitionColumns, terminal), ...prepared.statements,
        insert("automation_publications", ["owner_id", "app_id", "job_id", "attempt_id", "deployment_id", "data"], proof), jobQuery(lease.appId, lease.jobId)]);
      const deployment = prepared.existing ?? prepared.readReceipt(result.slice(2, 2 + prepared.statements.length));
      const row = result.at(-1)?.results[0]; ensure(row, "CONFLICT"); return { job: read<Snapshot>(row).job, deployment };
    },
    async failAutomationJob(authorityInput, leaseInput, codeInput, now) {
      const code = parseAutomationFailureCode(codeInput), { authority, lease, found } = await leaseState(authorityInput, leaseInput, now, code === "CANCELLED");
      const cancelled = code === "CANCELLED" || found.snapshot.job.state === "cancel_requested";
      return commit(found, { ...found.snapshot.job, state: cancelled ? "cancelled" : "failed", code: cancelled ? "CANCELLED" : code, updatedAt: now, lease: null },
        { ...found.snapshot.attempt!, endedAt: now, outcome: cancelled ? "cancelled" : "failed", code: cancelled ? "CANCELLED" : code }, cancelled ? "cancelled" : "failed", now, authority, lease);
    },
    async cancelAutomationJob(appId, jobId, now) {
      integer(now); await verify(); const found = await current(appId, jobId); ensure(found, "NOT_FOUND"); const job = found.snapshot.job; ensure(now >= job.updatedAt);
      if (["succeeded", "failed", "cancelled", "cancel_requested"].includes(job.state)) return job;
      const state = job.state === "queued" ? "cancelled" : "cancel_requested";
      return commit(found, { ...job, state, updatedAt: now, code: "CANCELLED" }, found.snapshot.attempt, state, now);
    },
    async expireAutomationJob(appId, jobId, now) {
      integer(now); await verify(); const found = await current(appId, jobId); ensure(found, "NOT_FOUND"); const job = found.snapshot.job;
      ensure(job.lease && (job.state === "leased" || job.state === "cancel_requested"), "INVALID_TRANSITION");
      const runner = await runnerQuery(job.lease.runnerId).first<Row>(); const revoked = !runner || read<RunnerCredential>(runner).revokedAt !== null;
      ensure(revoked || job.lease.expiresAt <= now || found.snapshot.attempt!.claimedAt + AUTOMATION_ATTEMPT_MAX_MS <= now, "INVALID_TRANSITION");
      const code = revoked ? "RUNNER_REVOKED" : job.state === "cancel_requested" ? "CANCELLED" : "LEASE_EXPIRED";
      const state = revoked ? "failed" : job.state === "cancel_requested" ? "cancelled" : job.attemptCount < 3 ? "queued" : "failed";
      return commit(found, { ...job, state, code, updatedAt: now, lease: null }, { ...found.snapshot.attempt!, endedAt: now, outcome: revoked ? "failed" : state === "cancelled" ? "cancelled" : "expired", code }, "expired", now);
    },
  };
  return store;
}
