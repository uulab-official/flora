import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ensure, id, integer, object } from "@app-ops/core";
import { canonicalJson, freeze } from "@app-ops/config";
import { applicationId, automationArtifactPayload, automationPolicyPlatforms, AUTOMATION_MAX_JOBS, AUTOMATION_MAX_ACTIVE_JOBS, AUTOMATION_MAX_ACTIVE_JOBS_PER_APP, AUTOMATION_MAX_RUNNERS, AUTOMATION_MAX_ATTEMPTS, AUTOMATION_LEASE_MAX_MS, AUTOMATION_ATTEMPT_MAX_MS, OTA_MAX_ASSETS, parseAutoPolicyUpdate, parseGitHubConnectionUpdate, parseOTAAsset, parseRunnerCredential, parseRunnerAuthority, parseAutomationJob, parseAutomationLease, parseAutomationClaimScope, parseAutomationFailureCode, parseAutomationExportReceipt, assertAutomationPublication } from "@app-ops/dogfood";
import type { AutoPolicy, AutoPolicyUpdate, AutomationTarget, AutomationJob, AutomationAttempt, AutomationEvent, AutomationStore, RunnerAuthority, RunnerCredential, RunnerSummary, AutomationLease, AutomationFailureCode, AutomationClaim, AutomationClaimScope, AutomationPublication, AutomationFinalization, OTAAsset } from "@app-ops/dogfood";
import { getApplication } from "./applications.js";
import { getGitHubConnection, getGitHubDetection, saveOTAAssetInTransaction, saveOTADeploymentInTransaction } from "./operations.js";
import { row, rows, transaction } from "./database.js";
function decode<T>(data: unknown): T { return freeze(JSON.parse(String(data)) as T); }
function hash(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function summary(credential: RunnerCredential): RunnerSummary { const { tokenHash: _private,...publicFields } = credential; return freeze(publicFields); }
export function getAutomationPolicy(db: DatabaseSync, appId: string): AutoPolicy {
  applicationId(appId); const application = getApplication(db,appId); ensure(application,"NOT_FOUND");
  const found = row(db,"SELECT data FROM automation_policy_history WHERE app_id=? ORDER BY version DESC LIMIT 1",appId);
  return found ? decode(found.data) : freeze({appId,version:0,enabled:false,channel:"preview",platform:"ios",updatedAt:application.createdAt});
}
export function updateAutomationPolicy(db: DatabaseSync, appId: string, input: AutoPolicyUpdate, now: number): AutoPolicy {
  applicationId(appId); const value = parseAutoPolicyUpdate(input); integer(now);
  return transaction(db,()=>{
    const previous = getAutomationPolicy(db,appId); ensure(previous.version===value.expectedVersion,"CONFLICT"); ensure(now>=previous.updatedAt);
    const { expectedVersion, ...selection } = value;
    const policy: AutoPolicy = {appId,version:integer(expectedVersion+1),...selection,updatedAt:now};
    db.prepare("INSERT INTO automation_policy_history VALUES(?,?,?,?)").run(appId,policy.version,now,canonicalJson(policy)); return freeze(policy);
  });
}
export function findAutomationTargets(db: DatabaseSync, input: {installationId:number;owner:string;repository:string;ref:string}): AutomationTarget[] {
  const fields = object(input,["installationId","owner","repository","ref"]);
  const value = parseGitHubConnectionUpdate({expectedVersion:0,installationId:fields.installationId,owner:fields.owner,repository:fields.repository,ref:fields.ref});
  return rows(db,`SELECT p.app_id,p.data FROM automation_policy_history p JOIN github_connection_history c ON c.app_id=p.app_id
    WHERE p.version=(SELECT max(version) FROM automation_policy_history WHERE app_id=p.app_id)
    AND c.version=(SELECT max(version) FROM github_connection_history WHERE app_id=c.app_id)
    AND json_extract(p.data,'$.enabled')=1 AND json_extract(c.data,'$.installationId')=?
    AND json_extract(c.data,'$.owner')=? COLLATE NOCASE AND json_extract(c.data,'$.repository')=? COLLATE NOCASE AND json_extract(c.data,'$.ref')=?
    ORDER BY p.app_id LIMIT 5`,value.installationId,value.owner,value.repository,value.ref).map(r=>({appId:String(r.app_id),policy:decode<AutoPolicy>(r.data)}));
}
export function getRunnerCredential(db: DatabaseSync, runnerId: string): RunnerCredential | null {
  id(runnerId); const found = row(db,"SELECT data FROM automation_runners WHERE id=?",runnerId); return found ? decode(found.data) : null;
}
function authenticate(db: DatabaseSync, input: RunnerAuthority): RunnerCredential {
  const authority = parseRunnerAuthority(input), credential = getRunnerCredential(db,authority.runnerId);
  ensure(credential && credential.revokedAt === null && credential.credentialEpoch === authority.credentialEpoch
    && timingSafeEqual(Buffer.from(credential.tokenHash,"hex"),Buffer.from(authority.tokenHash,"hex")),"PERMISSION_DENIED");
  return credential;
}
export function registerRunner(db: DatabaseSync, input: RunnerCredential): RunnerSummary {
  const credential = parseRunnerCredential(input); ensure(credential.credentialEpoch===1 && credential.revokedAt===null);
  return transaction(db,()=>{
    const existing = getRunnerCredential(db,credential.id);
    if (existing) { ensure(canonicalJson(existing)===canonicalJson(credential),"CONFLICT"); return summary(existing); }
    for (const appId of credential.appIds) ensure(getApplication(db,appId),"INVALID_RELATION");
    ensure(Number(row(db,"SELECT count(*) n FROM automation_runners")!.n)<AUTOMATION_MAX_RUNNERS,"INPUT_TOO_LARGE");
    db.prepare("INSERT INTO automation_runners VALUES(?,?,?,?,?,?)").run(credential.id,credential.tokenHash,credential.credentialEpoch,credential.createdAt,credential.revokedAt,canonicalJson(credential));
    const insert = db.prepare("INSERT INTO automation_runner_scopes VALUES(?,?)"); for (const appId of credential.appIds) insert.run(credential.id,appId);
    return summary(credential);
  });
}
export function listRunners(db: DatabaseSync, appId: string): RunnerSummary[] {
  applicationId(appId); return rows(db,"SELECT r.data FROM automation_runners r JOIN automation_runner_scopes s ON r.id=s.runner_id WHERE s.app_id=? ORDER BY r.created_at DESC,r.rowid DESC",appId).map(r=>summary(decode(r.data)));
}
export function getAutomationJob(db: DatabaseSync, appId: string, jobId: string): AutomationJob | null {
  applicationId(appId); id(jobId); const found = row(db,"SELECT data FROM automation_jobs WHERE app_id=? AND id=?",appId,jobId); return found ? decode(found.data) : null;
}
export function getAutomationJobForRequest(db: DatabaseSync, appId: string, requestKey: string): AutomationJob | null {
  applicationId(appId); id(requestKey); const found = row(db,"SELECT data FROM automation_jobs WHERE app_id=? AND request_key=?",appId,requestKey); return found ? decode(found.data) : null;
}
export function listAutomationJobs(db: DatabaseSync, appId: string): AutomationJob[] {
  applicationId(appId); return rows(db,"SELECT data FROM automation_jobs WHERE app_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100",appId).map(r=>decode(r.data));
}
export function listAutomationAttempts(db: DatabaseSync, appId: string, jobId: string): AutomationAttempt[] {
  applicationId(appId); id(jobId); return rows(db,"SELECT data FROM automation_attempts WHERE app_id=? AND job_id=? ORDER BY fence",appId,jobId).map(r=>decode(r.data));
}
export function listAutomationEvents(db: DatabaseSync, appId: string, jobId: string): AutomationEvent[] {
  applicationId(appId); id(jobId); return rows(db,"SELECT data FROM automation_events WHERE app_id=? AND job_id=? ORDER BY sequence",appId,jobId).map(r=>decode(r.data));
}
function event(db: DatabaseSync, job: AutomationJob, kind: AutomationEvent["kind"], now: number, lease: AutomationLease | null = job.lease, code: AutomationFailureCode | null = job.code): void {
  const latest = row(db,"SELECT sequence,created_at FROM automation_events WHERE app_id=? AND job_id=? ORDER BY sequence DESC LIMIT 1",job.appId,job.id);
  const sequence = integer(Number(latest?.sequence ?? 0)+1,1,1000); ensure(now>=Number(latest?.created_at ?? job.createdAt));
  const value: AutomationEvent = {jobId:job.id,sequence,createdAt:now,kind,attemptId:lease?.attemptId ?? null,runnerId:lease?.runnerId ?? null,code};
  db.prepare("INSERT INTO automation_events VALUES(?,?,?,?,?)").run(job.appId,job.id,sequence,now,canonicalJson(value));
}
function updateJob(db: DatabaseSync, job: AutomationJob): AutomationJob {
  db.prepare("UPDATE automation_jobs SET state=?,attempt_count=?,fence=?,attempt_id=?,lease_until=?,updated_at=?,data=? WHERE app_id=? AND id=?")
    .run(job.state,job.attemptCount,job.attemptCount,job.lease?.attemptId ?? null,job.lease?.expiresAt ?? null,job.updatedAt,canonicalJson(job),job.appId,job.id);
  return getAutomationJob(db,job.appId,job.id)!;
}
function attempt(db: DatabaseSync, lease: AutomationLease): AutomationAttempt | null {
  const found = row(db,"SELECT data FROM automation_attempts WHERE app_id=? AND job_id=? AND id=?",lease.appId,lease.jobId,lease.attemptId); return found ? decode(found.data) : null;
}
function endAttempt(db: DatabaseSync, lease: AutomationLease, outcome: NonNullable<AutomationAttempt["outcome"]>, code: AutomationFailureCode | null, now: number): void {
  const current = attempt(db,lease); ensure(current && current.outcome===null,"LEASE_STALE");
  const value: AutomationAttempt = {...current,endedAt:now,outcome,code};
  ensure(db.prepare("UPDATE automation_attempts SET ended_at=?,outcome=?,data=? WHERE app_id=? AND job_id=? AND id=? AND outcome IS NULL")
    .run(now,outcome,canonicalJson(value),lease.appId,lease.jobId,lease.attemptId).changes===1,"LEASE_STALE");
}
export function enqueueAutomationJob(db: DatabaseSync, input: AutomationJob, expectedPolicyVersion?: number): AutomationJob {
  if (expectedPolicyVersion!==undefined) integer(expectedPolicyVersion);
  const job = parseAutomationJob(input); ensure(job.state==="queued" && job.attemptCount===0 && job.lease===null && job.code===null && job.deploymentId===null && job.receipt===null && job.updatedAt===job.createdAt);
  ensure(job.configDigest===hash(job.config) && job.toolchainDigest===hash(job.config.toolchain));
  const {id:_id,createdAt:_created,updatedAt:_updated,state:_state,attemptCount:_count,lease:_lease,code:_code,deploymentId:_deployment,receipt:_receipt,...immutable} = job;
  const inputDigest = hash(immutable);
  return transaction(db,()=>{
    const existing = row(db,"SELECT data,input_digest FROM automation_jobs WHERE app_id=? AND request_key=?",job.appId,job.requestKey);
    if (existing) { ensure(existing.input_digest===inputDigest,"IDEMPOTENCY_CONFLICT"); return decode(existing.data); }
    if (expectedPolicyVersion!==undefined) {
      const policy = getAutomationPolicy(db,job.appId);
      ensure(policy.version===expectedPolicyVersion && policy.enabled && policy.channel===job.channel && automationPolicyPlatforms(policy).includes(job.platform),"CONFIG_CONFLICT");
    }
    const app = getApplication(db,job.appId), detection = getGitHubDetection(db,job.appId,job.detectionId);
    ensure(app && app.rootDirectory===job.rootDirectory && detection && canonicalJson(detection)===canonicalJson(job.detection),"INVALID_RELATION");
    ensure(canonicalJson(getGitHubConnection(db,job.appId))===canonicalJson(job.connection) && canonicalJson(job.connection)===canonicalJson(detection.connection),"CONFIG_CONFLICT");
    ensure(detection.updatesEnabled && detection.commitSha===job.commitSha && detection.runtimeVersion===job.runtimeVersion && detection.platforms.includes(job.platform),"PROVIDER_UNSUPPORTED");
    ensure(detection.automationConfig && canonicalJson(detection.automationConfig)===canonicalJson(job.config),"CONFIG_CONFLICT");
    ensure(job.config.updatesUrl===detection.updatesUrl && job.config.runtimeVersion===job.runtimeVersion && job.config.platforms.includes(job.platform),"CONFIG_CONFLICT");
    const usage = row(db,"SELECT count(*) n,sum(CASE WHEN state IN ('queued','leased','cancel_requested') THEN 1 ELSE 0 END) active,sum(CASE WHEN state IN ('queued','leased','cancel_requested') AND app_id=? THEN 1 ELSE 0 END) app_active FROM automation_jobs",job.appId)!;
    ensure(Number(usage.n)<AUTOMATION_MAX_JOBS && Number(usage.active ?? 0)<AUTOMATION_MAX_ACTIVE_JOBS && Number(usage.app_active ?? 0)<AUTOMATION_MAX_ACTIVE_JOBS_PER_APP,"INPUT_TOO_LARGE");
    db.prepare("INSERT INTO automation_jobs VALUES(?,?,?,?,?,0,0,NULL,NULL,?,?,?)").run(job.appId,job.id,job.requestKey,inputDigest,job.state,job.createdAt,job.updatedAt,canonicalJson(job));
    event(db,job,"queued",job.createdAt); return getAutomationJob(db,job.appId,job.id)!;
  });
}
function active(db: DatabaseSync, authority: RunnerAuthority, input: AutomationLease, now: number, allowCancellation=false): AutomationJob {
  const lease = parseAutomationLease(input); integer(now); const runner = authenticate(db,authority);
  ensure(runner.appIds.includes(lease.appId) && runner.id===lease.runnerId && runner.credentialEpoch===lease.credentialEpoch,"PERMISSION_DENIED");
  const job = getAutomationJob(db,lease.appId,lease.jobId), current = job?.lease, execution = attempt(db,lease);
  ensure(job && (job.state==="leased" || allowCancellation && job.state==="cancel_requested") && current && execution && execution.outcome===null
    && current.attemptId===lease.attemptId && current.fence===lease.fence && current.runnerId===lease.runnerId && current.credentialEpoch===lease.credentialEpoch
    && execution.runnerId===lease.runnerId && execution.fence===lease.fence && execution.credentialEpoch===lease.credentialEpoch
    && execution.expiresAt===current.expiresAt && now>=job.updatedAt && now>=execution.claimedAt && now<current.expiresAt,"LEASE_STALE");
  return job;
}
export function requireAutomationLease(db: DatabaseSync, authority: RunnerAuthority, lease: AutomationLease, now: number): AutomationJob {
  return transaction(db,()=>active(db,authority,lease,now));
}
function expire(db: DatabaseSync, job: AutomationJob, now: number): AutomationJob {
  if (!job.lease || !["leased","cancel_requested"].includes(job.state) || now<job.lease.expiresAt) return job;
  ensure(now>=job.updatedAt);
  const lease = job.lease, cancelled = job.state==="cancel_requested", terminal = cancelled || job.attemptCount>=AUTOMATION_MAX_ATTEMPTS;
  const code: AutomationFailureCode = cancelled ? "CANCELLED" : "LEASE_EXPIRED";
  endAttempt(db,lease,cancelled?"cancelled":"expired",code,now);
  const result = updateJob(db,{...job,state:cancelled?"cancelled":terminal?"failed":"queued",code,lease:null,updatedAt:now});
  event(db,result,cancelled?"cancelled":"expired",now,lease,code); return result;
}
export function expireAutomationJob(db: DatabaseSync, appId: string, jobId: string, now: number): AutomationJob {
  applicationId(appId); id(jobId); integer(now);
  return transaction(db,()=>{const job = getAutomationJob(db,appId,jobId); ensure(job,"NOT_FOUND"); return expire(db,job,now);});
}
export function claimAutomationJob(db: DatabaseSync, authority: RunnerAuthority, now: number, leaseMs: number, scope?: AutomationClaimScope): AutomationClaim | null {
  integer(now); integer(leaseMs,5000,AUTOMATION_LEASE_MAX_MS);
  if (scope) scope = parseAutomationClaimScope(scope);
  return transaction(db,()=>{
    const runner = authenticate(db,authority);
    const filter = scope ? " AND j.app_id=? AND json_extract(j.data,'$.commitSha')=?" + (scope.platform ? " AND json_extract(j.data,'$.platform')=?" : "") : "", extra = scope ? [scope.appId,scope.commitSha,...(scope.platform ? [scope.platform] : [])] : [];
    for (const r of rows(db,"SELECT j.data FROM automation_jobs j JOIN automation_runner_scopes s ON s.app_id=j.app_id WHERE s.runner_id=? AND j.state IN ('leased','cancel_requested') AND j.lease_until<=?"+filter,runner.id,now,...extra)) expire(db,decode(r.data),now);
    const found = row(db,"SELECT j.data FROM automation_jobs j JOIN automation_runner_scopes s ON s.app_id=j.app_id WHERE s.runner_id=? AND j.state='queued'"+filter+" ORDER BY j.created_at,j.rowid LIMIT 1",runner.id,...extra);
    if (!found) return null; const job = decode<AutomationJob>(found.data); ensure(now>=job.updatedAt);
    const count = integer(job.attemptCount+1,1,AUTOMATION_MAX_ATTEMPTS), expiresAt = integer(now+leaseMs), attemptId = "attempt_"+randomUUID();
    const lease: AutomationLease = {jobId:job.id,appId:job.appId,attemptId,runnerId:runner.id,credentialEpoch:runner.credentialEpoch,fence:count,expiresAt};
    const execution: AutomationAttempt = {id:attemptId,jobId:job.id,runnerId:runner.id,credentialEpoch:runner.credentialEpoch,fence:count,claimedAt:now,expiresAt,endedAt:null,outcome:null,code:null};
    db.prepare("INSERT INTO automation_attempts VALUES(?,?,?,?,?,?,?,?,NULL,NULL,?)").run(job.appId,job.id,attemptId,runner.id,runner.credentialEpoch,count,now,expiresAt,canonicalJson(execution));
    const result = updateJob(db,{...job,state:"leased",code:null,attemptCount:count,lease,updatedAt:now}); event(db,result,"claimed",now);
    return freeze({job:result,lease});
  });
}
export function heartbeatAutomationJob(db: DatabaseSync, authority: RunnerAuthority, input: AutomationLease, now: number, leaseMs: number): AutomationLease {
  integer(now); integer(leaseMs,5000,AUTOMATION_LEASE_MAX_MS);
  return transaction(db,()=>{
    const job = active(db,authority,input,now), current = job.lease!, execution = attempt(db,current)!;
    const maximum = integer(execution.claimedAt+AUTOMATION_ATTEMPT_MAX_MS), expiresAt = integer(Math.max(current.expiresAt,Math.min(integer(now+leaseMs),maximum)));
    const lease = {...current,expiresAt}, renewed = {...execution,expiresAt};
    db.prepare("UPDATE automation_attempts SET expires_at=?,data=? WHERE app_id=? AND job_id=? AND id=?").run(expiresAt,canonicalJson(renewed),job.appId,job.id,current.attemptId);
    const result = updateJob(db,{...job,lease,updatedAt:now}); event(db,result,"heartbeat",now); return result.lease!;
  });
}
export function saveAutomationAsset(db: DatabaseSync, authority: RunnerAuthority, lease: AutomationLease, input: OTAAsset, bytes: Uint8Array, now: number): OTAAsset {
  const asset = parseOTAAsset(input);
  return transaction(db,()=>{
    const job = active(db,authority,lease,now); ensure(asset.appId===job.appId,"INVALID_RELATION");
    const existing = row(db,"SELECT 1 FROM automation_uploaded_assets WHERE app_id=? AND job_id=? AND attempt_id=? AND asset_id=?",job.appId,job.id,lease.attemptId,asset.id);
    if (!existing) ensure(Number(row(db,"SELECT count(*) n FROM automation_uploaded_assets WHERE app_id=? AND job_id=? AND attempt_id=?",job.appId,job.id,lease.attemptId)!.n)<OTA_MAX_ASSETS+1,"INPUT_TOO_LARGE");
    const saved = saveOTAAssetInTransaction(db,asset,bytes);
    if (!existing) db.prepare("INSERT INTO automation_uploaded_assets VALUES(?,?,?,?)").run(job.appId,job.id,lease.attemptId,saved.id);
    return saved;
  });
}
export function failAutomationJob(db: DatabaseSync, authority: RunnerAuthority, lease: AutomationLease, input: AutomationFailureCode, now: number): AutomationJob {
  const code = parseAutomationFailureCode(input); integer(now);
  return transaction(db,()=>{
    const job = active(db,authority,lease,now,code==="CANCELLED"), cancelled = job.state==="cancel_requested" || code==="CANCELLED", actualCode = cancelled ? "CANCELLED" : code;
    endAttempt(db,job.lease!,cancelled?"cancelled":"failed",actualCode,now);
    const result = updateJob(db,{...job,state:cancelled?"cancelled":"failed",code:actualCode,lease:null,updatedAt:now});
    event(db,result,cancelled?"cancelled":"failed",now,job.lease,actualCode); return result;
  });
}
export function cancelAutomationJob(db: DatabaseSync, appId: string, jobId: string, now: number): AutomationJob {
  applicationId(appId); id(jobId); integer(now);
  return transaction(db,()=>{
    const job = getAutomationJob(db,appId,jobId); ensure(job,"NOT_FOUND");
    if (["succeeded","failed","cancelled","cancel_requested"].includes(job.state)) return job;
    ensure(now>=job.updatedAt);
    const result = updateJob(db,{...job,state:job.state==="queued"?"cancelled":"cancel_requested",code:"CANCELLED",updatedAt:now});
    event(db,result,job.state==="queued"?"cancelled":"cancel_requested",now); return result;
  });
}
export function revokeRunner(db: DatabaseSync, runnerId: string, now: number): RunnerSummary {
  id(runnerId); integer(now);
  return transaction(db,()=>{
    const runner = getRunnerCredential(db,runnerId); ensure(runner,"NOT_FOUND"); if (runner.revokedAt!==null) return summary(runner); ensure(now>=runner.createdAt);
    const revoked = {...runner,revokedAt:now,credentialEpoch:integer(runner.credentialEpoch+1)};
    db.prepare("UPDATE automation_runners SET revoked_at=?,credential_epoch=?,data=? WHERE id=?").run(now,revoked.credentialEpoch,canonicalJson(revoked),runnerId);
    for (const r of rows(db,"SELECT data FROM automation_jobs WHERE state IN ('leased','cancel_requested') AND json_extract(data,'$.lease.runnerId')=?",runnerId)) {
      const job = decode<AutomationJob>(r.data); ensure(now>=job.updatedAt); endAttempt(db,job.lease!,"failed","RUNNER_REVOKED",now);
      const result = updateJob(db,{...job,state:"failed",code:"RUNNER_REVOKED",lease:null,updatedAt:now}); event(db,result,"failed",now,job.lease,"RUNNER_REVOKED");
    }
    return summary(revoked);
  });
}
export function finalizeAutomationJob(db: DatabaseSync, authority: RunnerAuthority, lease: AutomationLease, input: AutomationPublication, now: number): AutomationFinalization {
  object(input,["deployment","receipt"]);
  const owned = JSON.parse(canonicalJson(input)) as AutomationPublication;
  const receipt = parseAutomationExportReceipt(owned.receipt); integer(now);
  return transaction(db,()=>{
    const job = active(db,authority,lease,now); const publication = {...owned,receipt}; assertAutomationPublication(job,lease,publication);
    ensure(receipt.artifactDigest===hash(automationArtifactPayload(receipt,[publication.deployment.launchAsset,...publication.deployment.assets])),"INVALID_RELATION");
    const latestIntent = row(db,"SELECT id FROM automation_jobs WHERE app_id=? AND json_extract(data,'$.channel')=? AND json_extract(data,'$.runtimeVersion')=? AND json_extract(data,'$.platform')=? ORDER BY created_at DESC,rowid DESC LIMIT 1",job.appId,job.channel,job.runtimeVersion,job.platform);
    ensure(latestIntent?.id===job.id,"CONFIG_CONFLICT");
    for (const assetId of [receipt.launchAssetId,...receipt.assetIds]) ensure(row(db,"SELECT 1 FROM automation_uploaded_assets WHERE app_id=? AND job_id=? AND attempt_id=? AND asset_id=?",job.appId,job.id,lease.attemptId,assetId),"INVALID_RELATION");
    const deployment = saveOTADeploymentInTransaction(db,publication.deployment);
    db.prepare("INSERT INTO automation_export_receipts VALUES(?,?,?,?,?)").run(job.appId,job.id,lease.attemptId,deployment.id,canonicalJson(receipt));
    endAttempt(db,job.lease!,"succeeded",null,now);
    const result = updateJob(db,{...job,state:"succeeded",code:null,lease:null,deploymentId:deployment.id,receipt,updatedAt:now}); event(db,result,"succeeded",now,job.lease,null);
    return freeze({job:result,deployment});
  });
}
export function createSqliteAutomationStore(db: DatabaseSync): AutomationStore {
  return {
    getAutomationPolicy: async appId=>getAutomationPolicy(db,appId), updateAutomationPolicy: async (appId,input,now)=>updateAutomationPolicy(db,appId,input,now), findAutomationTargets: async input=>findAutomationTargets(db,input),
    registerRunner: async input=>registerRunner(db,input), getRunnerCredential: async runnerId=>getRunnerCredential(db,runnerId), listRunners: async appId=>listRunners(db,appId), revokeRunner: async (runnerId,now)=>revokeRunner(db,runnerId,now),
    enqueueAutomationJob: async (input,expectedPolicyVersion?: number)=>enqueueAutomationJob(db,input,expectedPolicyVersion), getAutomationJob: async (appId,jobId)=>getAutomationJob(db,appId,jobId), getAutomationJobForRequest: async (appId,key)=>getAutomationJobForRequest(db,appId,key), listAutomationJobs: async appId=>listAutomationJobs(db,appId),
    listAutomationAttempts: async (appId,jobId)=>listAutomationAttempts(db,appId,jobId), listAutomationEvents: async (appId,jobId)=>listAutomationEvents(db,appId,jobId),
    claimAutomationJob: async (authority,now,leaseMs,scope)=>claimAutomationJob(db,authority,now,leaseMs,scope), requireAutomationLease: async (authority,lease,now)=>requireAutomationLease(db,authority,lease,now), heartbeatAutomationJob: async (authority,lease,now,leaseMs)=>heartbeatAutomationJob(db,authority,lease,now,leaseMs),
    saveAutomationAsset: async (authority,lease,asset,bytes,now)=>saveAutomationAsset(db,authority,lease,asset,bytes,now), finalizeAutomationJob: async (authority,lease,publication,now)=>finalizeAutomationJob(db,authority,lease,publication,now),
    failAutomationJob: async (authority,lease,code,now)=>failAutomationJob(db,authority,lease,code,now), cancelAutomationJob: async (appId,jobId,now)=>cancelAutomationJob(db,appId,jobId,now), expireAutomationJob: async (appId,jobId,now)=>expireAutomationJob(db,appId,jobId,now),
  };
}
