import type { ApplicationStore } from "./applications.js";
import type { GitHubConnection, GitHubDetection, OTAAsset, OTAAssetUpload, OTADeployment, OTAPlatform, OperationsStore } from "./operations.js";
import { DomainError, digest, ensure, id, integer, object, text, safeJson } from "@app-ops/core";
import { canonicalJson, freeze } from "@app-ops/config";
import { OTA_MAX_ASSETS, parseGitHubDetection, parseGitHubConnectionUpdate, parseOTASelection, otaAssetId, otaPlatform, parseOTAPublishInput, parseOTAAsset, assertDetectionCanPublish, assertUpdateDestination, prepareOTAAsset } from "./operations.js";

export type AutomationBundler = "metro" | "expo";
export interface AutomationToolchain { nodeVersion: string; packageManager: { name: "npm" | "pnpm" | "yarn"; version: string } }
export interface AutomationConfigSnapshot {
  schemaVersion: 1;
  bundler: AutomationBundler;
  entryFile: string;
  toolchain: AutomationToolchain;
  runtimeVersion: string;
  platforms: OTAPlatform[];
  updatesUrl: string;
}
export interface AutomationQueueInput {
  requestKey: string;
  detectionId: string;
  channel: string;
  runtimeVersion: string;
  platform: OTAPlatform;
  config: AutomationConfigSnapshot;
}
export type AutomationJobState = "queued" | "leased" | "cancel_requested" | "succeeded" | "failed" | "cancelled";
export type AutomationFailureCode = "EXPORT_FAILED" | "SOURCE_UNAVAILABLE" | "CONFIG_CHANGED" | "ARTIFACT_INVALID" | "LEASE_EXPIRED" | "RUNNER_REVOKED" | "CANCELLED" | "PUBLICATION_REJECTED";
export interface AutomationLease {
  jobId: string;
  appId: string;
  attemptId: string;
  runnerId: string;
  credentialEpoch: number;
  fence: number;
  expiresAt: number;
}
export interface AutomationJob extends AutomationQueueInput {
  id: string;
  appId: string;
  detection: GitHubDetection;
  commitSha: string;
  rootDirectory: string;
  connection: GitHubConnection;
  configDigest: string;
  toolchainDigest: string;
  createdAt: number;
  updatedAt: number;
  state: AutomationJobState;
  attemptCount: number;
  lease: AutomationLease | null;
  code: AutomationFailureCode | null;
  deploymentId: string | null;
  receipt: AutomationExportReceipt | null;
}
export interface AutomationAttempt {
  id: string;
  jobId: string;
  runnerId: string;
  credentialEpoch: number;
  fence: number;
  claimedAt: number;
  expiresAt: number;
  endedAt: number | null;
  outcome: "succeeded" | "failed" | "expired" | "cancelled" | null;
  code: AutomationFailureCode | null;
}
export interface AutomationEvent { jobId: string; sequence: number; createdAt: number; kind: "queued" | "claimed" | "heartbeat" | "cancel_requested" | "succeeded" | "failed" | "expired" | "cancelled"; attemptId: string | null; runnerId: string | null; code: AutomationFailureCode | null }
export interface RunnerSummary { id: string; name: string; appIds: string[]; createdAt: number; credentialEpoch: number; revokedAt: number | null }
/** Internal-only credential metadata. No response/SDK/export execution receives it. */
export interface RunnerCredential extends RunnerSummary { tokenHash: string }
export interface RunnerAuthority { runnerId: string; credentialEpoch: number; tokenHash: string }
export interface RunnerEnrollmentInput { name: string; appIds: string[] }
export interface RunnerEnrollment { runner: RunnerSummary; token: string }
export interface AutomationClaim { job: AutomationJob; lease: AutomationLease }
/** Server-admitted CI identity narrows selection before any claim mutation. */
export interface AutomationClaimScope { appId: string; commitSha: string }
export function parseAutomationClaimScope(input: unknown): AutomationClaimScope {
  const raw = object(input, ["appId", "commitSha"]), commitSha = text(raw.commitSha, 40); ensure(/^[a-f0-9]{40}$/.test(commitSha));
  return { appId: id(raw.appId), commitSha };
}
export interface AutomationExportReceipt {
  jobId: string;
  attemptId: string;
  commitSha: string;
  configDigest: string;
  toolchainDigest: string;
  sourceArchiveDigest: string;
  launchAssetId: string;
  assetIds: string[];
  artifactDigest: string;
}
export interface AutomationPublication { deployment: OTADeployment; receipt: AutomationExportReceipt }
export interface AutomationFinalization { job: AutomationJob; deployment: OTADeployment }
export interface AutomationState { jobs: AutomationJob[]; runners: RunnerSummary[]; policy: AutoPolicy }
export interface AutoPolicy { appId: string; version: number; enabled: boolean; channel: string; platform: OTAPlatform; updatedAt: number }
export interface AutoPolicyUpdate { expectedVersion: number; enabled: boolean; channel: string; platform: OTAPlatform }
export interface AutomationTarget { appId: string; policy: AutoPolicy }
export interface GitHubPushEvent { deliveryId: string; installationId: number; owner: string; repository: string; ref: string; commitSha: string }
export interface GitHubPushResult { jobs: AutomationJob[]; ignored: number }
export interface AutomationSourceGrant { url: string; token: string; commitSha: string; expiresAt: number; maxBytes: number }
export interface AutomationSourceProvider { grant(connection: GitHubConnection, commitSha: string, expiresAt: number): Promise<AutomationSourceGrant> }
/** Job input and terminal results are immutable. All Runner mutations validate
 * runner hash/epoch/revocation/app scopes and the CURRENT attempt/fence/deadline
 * atomically with their write. The request's expiresAt is not authority.
 * Asset upload associates assets with this attempt; finalize requires all refs
 * to that attempt and commits the OTA ledger + job terminal CAS in one txn.
 * Expired attempts may requeue at most3 times; cancelled/revoked attempts cannot
 * publish. No publication credential or source token is stored in a job. */
export interface AutomationStore {
  getAutomationPolicy(appId: string): Promise<AutoPolicy>;
  updateAutomationPolicy(appId: string, input: AutoPolicyUpdate, now: number): Promise<AutoPolicy>;
  findAutomationTargets(input: { installationId: number; owner: string; repository: string; ref: string }): Promise<AutomationTarget[]>;
  registerRunner(credential: RunnerCredential): Promise<RunnerSummary>;
  getRunnerCredential(runnerId: string): Promise<RunnerCredential | null>;
  listRunners(appId: string): Promise<RunnerSummary[]>;
  revokeRunner(runnerId: string, now: number): Promise<RunnerSummary>;
  enqueueAutomationJob(job: AutomationJob, expectedPolicyVersion?: number): Promise<AutomationJob>;
  getAutomationJob(appId: string, jobId: string): Promise<AutomationJob | null>;
  getAutomationJobForRequest(appId: string, requestKey: string): Promise<AutomationJob | null>;
  listAutomationJobs(appId: string): Promise<AutomationJob[]>;
  listAutomationAttempts(appId: string, jobId: string): Promise<AutomationAttempt[]>;
  listAutomationEvents(appId: string, jobId: string): Promise<AutomationEvent[]>;
  claimAutomationJob(authority: RunnerAuthority, now: number, leaseMs: number, scope?: AutomationClaimScope): Promise<AutomationClaim | null>;
  requireAutomationLease(authority: RunnerAuthority, lease: AutomationLease, now: number): Promise<AutomationJob>;
  heartbeatAutomationJob(authority: RunnerAuthority, lease: AutomationLease, now: number, leaseMs: number): Promise<AutomationLease>;
  saveAutomationAsset(authority: RunnerAuthority, lease: AutomationLease, asset: OTAAsset, bytes: Uint8Array, now: number): Promise<OTAAsset>;
  finalizeAutomationJob(authority: RunnerAuthority, lease: AutomationLease, publication: AutomationPublication, now: number): Promise<AutomationFinalization>;
  failAutomationJob(authority: RunnerAuthority, lease: AutomationLease, code: AutomationFailureCode, now: number): Promise<AutomationJob>;
  cancelAutomationJob(appId: string, jobId: string, now: number): Promise<AutomationJob>;
  expireAutomationJob(appId: string, jobId: string, now: number): Promise<AutomationJob>;
}
export interface AutomationContext { applications: ApplicationStore; operations: OperationsStore; automation: AutomationStore }
export interface AutomationService {
  authorizeRunner(token: string, lease?: AutomationLease): Promise<void>;
  getState(appId: string): Promise<AutomationState>;
  getJob(appId: string, jobId: string): Promise<{ job: AutomationJob; attempts: AutomationAttempt[]; events: AutomationEvent[] }>;
  enrollRunner(input: RunnerEnrollmentInput): Promise<RunnerEnrollment>;
  revokeRunner(runnerId: string): Promise<RunnerSummary>;
  queue(appId: string, input: AutomationQueueInput): Promise<AutomationJob>;
  updatePolicy(appId: string, input: AutoPolicyUpdate): Promise<AutoPolicy>;
  handleGitHubPush(event: GitHubPushEvent): Promise<GitHubPushResult>;
  cancel(appId: string, jobId: string): Promise<AutomationJob>;
  claim(token: string, scope?: AutomationClaimScope): Promise<AutomationClaim | null>;
  heartbeat(token: string, lease: AutomationLease): Promise<AutomationLease>;
  source(token: string, lease: AutomationLease): Promise<AutomationSourceGrant>;
  uploadAsset(token: string, lease: AutomationLease, upload: OTAAssetUpload, bytes: Uint8Array): Promise<OTAAsset>;
  finalize(token: string, lease: AutomationLease, receipt: AutomationExportReceipt): Promise<AutomationFinalization>;
  fail(token: string, lease: AutomationLease, code: AutomationFailureCode): Promise<AutomationJob>;
}
export interface AutomationServiceOptions { now?: () => number; publicOrigin: string | (() => string); leaseMs?: number; source?: AutomationSourceProvider; detectCommit?: (appId: string, commitSha: string) => Promise<GitHubDetection>; detectPushCommit?: (appId: string, commitSha: string) => Promise<GitHubDetection>; maxWebhookTargets?: number }
export const AUTOMATION_MAX_JOBS = 1000;
export const AUTOMATION_MAX_ACTIVE_JOBS = 100;
export const AUTOMATION_MAX_ACTIVE_JOBS_PER_APP = 10;
export const AUTOMATION_MAX_RUNNERS = 100;
export const AUTOMATION_MAX_ATTEMPTS = 3;
export const AUTOMATION_LEASE_MAX_MS = 120_000;
export const AUTOMATION_ATTEMPT_MAX_MS = 1_200_000;
export const AUTOMATION_MAX_WEBHOOK_TARGETS = 4;

function relativePath(value: unknown): string {
  const path = text(value, 256); ensure(!/[\\:\u0000-\u001f\u007f]/.test(path) && path.split("/").every(part => part !== "" && ![".", "..", "__proto__", "constructor", "prototype"].includes(part))); return path;
}
function exactVersion(value: unknown): string { const version = text(value, 32); ensure(/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[A-Za-z0-9.-]{1,16})?$/.test(version)); return version; }
export function parseAutomationConfigSnapshot(input: unknown): AutomationConfigSnapshot {
  const value = object(input, ["schemaVersion", "bundler", "entryFile", "toolchain", "runtimeVersion", "platforms", "updatesUrl"]);
  ensure(value.schemaVersion === 1 && (value.bundler === "metro" || value.bundler === "expo"));
  const toolchain = object(value.toolchain, ["nodeVersion", "packageManager"]), manager = object(toolchain.packageManager, ["name", "version"]);
  ensure(manager.name === "npm" || manager.name === "pnpm" || manager.name === "yarn");
  const runtimeVersion = text(value.runtimeVersion, 128); ensure(!/[\u0000-\u001f\u007f]/.test(runtimeVersion));
  ensure(Array.isArray(value.platforms) && value.platforms.length > 0 && value.platforms.length <= 2 && new Set(value.platforms).size === value.platforms.length);
  const updatesUrl = text(value.updatesUrl, 2048); let url: URL | undefined; try { url = new URL(updatesUrl); } catch { ensure(false); }
  ensure(url && !url.username && !url.password && !url.hash && (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  return freeze({ schemaVersion: 1, bundler: value.bundler, entryFile: relativePath(value.entryFile), toolchain: { nodeVersion: exactVersion(toolchain.nodeVersion), packageManager: { name: manager.name, version: exactVersion(manager.version) } }, runtimeVersion, platforms: value.platforms.map(otaPlatform), updatesUrl: url.href });
}
export function parseFloraConfig(input: unknown): AutomationConfigSnapshot {
  const value = object(input, ["schemaVersion", "ota", "export"]), ota = object(value.ota, ["runtimeVersion", "platforms", "url"]), adapter = object(value.export, ["bundler", "entryFile", "nodeVersion", "packageManager"]);
  return parseAutomationConfigSnapshot({ schemaVersion: value.schemaVersion, bundler: adapter.bundler, entryFile: adapter.entryFile, toolchain: { nodeVersion: adapter.nodeVersion, packageManager: adapter.packageManager }, runtimeVersion: ota.runtimeVersion, platforms: ota.platforms, updatesUrl: ota.url });
}
export function parseAutomationQueueInput(input: unknown): AutomationQueueInput {
  const value = object(input, ["requestKey", "detectionId", "channel", "runtimeVersion", "platform", "config"]);
  const config = parseAutomationConfigSnapshot(value.config), target = parseOTASelection({ channel: value.channel, runtimeVersion: value.runtimeVersion, platform: value.platform });
  ensure(config.runtimeVersion === target.runtimeVersion && config.platforms.includes(target.platform), "CONFIG_CONFLICT");
  return freeze({ requestKey: id(value.requestKey), detectionId: id(value.detectionId), ...target, config });
}
export function parseRunnerEnrollmentInput(input: unknown): RunnerEnrollmentInput {
  const value = object(input, ["name", "appIds"]); ensure(Array.isArray(value.appIds) && value.appIds.length > 0 && value.appIds.length <= 100 && new Set(value.appIds).size === value.appIds.length);
  return freeze({ name: text(value.name, 128), appIds: value.appIds.map(id) });
}
export function parseRunnerCredential(input: unknown): RunnerCredential {
  const value = object(input, ["id", "name", "appIds", "createdAt", "credentialEpoch", "revokedAt", "tokenHash"]);
  const enrollment = parseRunnerEnrollmentInput({ name: value.name, appIds: value.appIds }), createdAt = integer(value.createdAt);
  const revokedAt = value.revokedAt === null ? null : integer(value.revokedAt, createdAt);
  return freeze({ id: id(value.id), ...enrollment, createdAt, credentialEpoch: integer(value.credentialEpoch, 1), revokedAt, tokenHash: digest(value.tokenHash) });
}
export function parseRunnerAuthority(input: unknown): RunnerAuthority {
  const value = object(input, ["runnerId", "credentialEpoch", "tokenHash"]); return freeze({ runnerId: id(value.runnerId), credentialEpoch: integer(value.credentialEpoch, 1), tokenHash: digest(value.tokenHash) });
}
export function parseAutomationLease(input: unknown): AutomationLease {
  const value = object(input, ["jobId", "appId", "attemptId", "runnerId", "credentialEpoch", "fence", "expiresAt"]);
  return freeze({ jobId: id(value.jobId), appId: id(value.appId), attemptId: id(value.attemptId), runnerId: id(value.runnerId), credentialEpoch: integer(value.credentialEpoch, 1), fence: integer(value.fence, 1), expiresAt: integer(value.expiresAt, 1) });
}
export function parseAutomationFailureCode(value: unknown): AutomationFailureCode {
  ensure(["EXPORT_FAILED", "SOURCE_UNAVAILABLE", "CONFIG_CHANGED", "ARTIFACT_INVALID", "LEASE_EXPIRED", "RUNNER_REVOKED", "CANCELLED", "PUBLICATION_REJECTED"].includes(String(value))); return value as AutomationFailureCode;
}
export function parseAutoPolicyUpdate(input: unknown): AutoPolicyUpdate {
  const value = object(input, ["expectedVersion", "enabled", "channel", "platform"]); ensure(typeof value.enabled === "boolean");
  const target = parseOTASelection({ channel: value.channel, runtimeVersion: "policy", platform: value.platform });
  return freeze({ expectedVersion: integer(value.expectedVersion, 0, Number.MAX_SAFE_INTEGER - 1), enabled: value.enabled, channel: target.channel, platform: target.platform });
}
export function parseAutomationExportReceipt(input: unknown): AutomationExportReceipt {
  const value = object(input, ["jobId", "attemptId", "commitSha", "configDigest", "toolchainDigest", "sourceArchiveDigest", "launchAssetId", "assetIds", "artifactDigest"]);
  const commitSha = text(value.commitSha, 40); ensure(/^[a-f0-9]{40}$/.test(commitSha));
  ensure(Array.isArray(value.assetIds) && value.assetIds.length <= OTA_MAX_ASSETS && new Set(value.assetIds).size === value.assetIds.length);
  const launchAssetId = otaAssetId(value.launchAssetId), assetIds = value.assetIds.map(otaAssetId); ensure(!assetIds.includes(launchAssetId));
  return freeze({ jobId: id(value.jobId), attemptId: id(value.attemptId), commitSha, configDigest: digest(value.configDigest), toolchainDigest: digest(value.toolchainDigest), sourceArchiveDigest: digest(value.sourceArchiveDigest), launchAssetId, assetIds, artifactDigest: digest(value.artifactDigest) });
}
export function parseAutomationJob(input: unknown): AutomationJob {
  const value = object(input, ["requestKey", "detectionId", "channel", "runtimeVersion", "platform", "config", "id", "appId", "detection", "commitSha", "rootDirectory", "connection", "configDigest", "toolchainDigest", "createdAt", "updatedAt", "state", "attemptCount", "lease", "code", "deploymentId", "receipt"]);
  const queue = parseAutomationQueueInput({ requestKey: value.requestKey, detectionId: value.detectionId, channel: value.channel, runtimeVersion: value.runtimeVersion, platform: value.platform, config: value.config }), detection = parseGitHubDetection(value.detection), appId = id(value.appId), jobId = id(value.id);
  ensure(detection.appId === appId && detection.id === queue.detectionId && detection.commitSha === value.commitSha && detection.rootDirectory === value.rootDirectory && canonicalJson(detection.connection) === canonicalJson(value.connection), "INVALID_RELATION");
  const createdAt = integer(value.createdAt), updatedAt = integer(value.updatedAt, createdAt);
  ensure(["queued", "leased", "cancel_requested", "succeeded", "failed", "cancelled"].includes(String(value.state)));
  const lease = value.lease === null ? null : parseAutomationLease(value.lease); if (lease) ensure(lease.appId === appId && lease.jobId === jobId);
  const receipt = value.receipt === null ? null : parseAutomationExportReceipt(value.receipt), deploymentId = value.deploymentId === null ? null : text(value.deploymentId, 96);
  if (value.state === "succeeded") ensure(receipt && deploymentId && receipt.jobId === jobId);
  else ensure(receipt === null && deploymentId === null);
  ensure(value.state === "leased" || value.state === "cancel_requested" ? lease !== null : lease === null);
  return freeze({ ...queue, id: jobId, appId, detection, commitSha: detection.commitSha, rootDirectory: detection.rootDirectory, connection: detection.connection, configDigest: digest(value.configDigest), toolchainDigest: digest(value.toolchainDigest), createdAt, updatedAt, state: value.state as AutomationJobState, attemptCount: integer(value.attemptCount, 0, AUTOMATION_MAX_ATTEMPTS), lease, code: value.code === null ? null : parseAutomationFailureCode(value.code), deploymentId, receipt });
}
export async function automationDigest(input: unknown): Promise<string> { const bytes = new TextEncoder().encode(canonicalJson(input)); const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); return Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join(""); }
export function assertAutomationLease(jobInput: AutomationJob, authorityInput: RunnerAuthority, leaseInput: AutomationLease, now: number, runnerInput: RunnerCredential, allowCancel = false): void {
  const job = parseAutomationJob(jobInput), authority = parseRunnerAuthority(authorityInput), lease = parseAutomationLease(leaseInput), runner = parseRunnerCredential(runnerInput); integer(now);
  ensure(runner.id === authority.runnerId && runner.credentialEpoch === authority.credentialEpoch && runner.tokenHash === authority.tokenHash && runner.revokedAt === null && runner.appIds.includes(job.appId), "PERMISSION_DENIED");
  const current = job.lease;
  ensure((job.state === "leased" || allowCancel && job.state === "cancel_requested") && current && current.expiresAt > now && current.jobId === lease.jobId && current.appId === lease.appId && current.attemptId === lease.attemptId && current.runnerId === authority.runnerId && current.runnerId === lease.runnerId && current.credentialEpoch === authority.credentialEpoch && lease.credentialEpoch === authority.credentialEpoch && current.fence === lease.fence, "LEASE_STALE");
}
export function automationArtifactPayload(input: AutomationExportReceipt | Omit<AutomationExportReceipt, "artifactDigest">, assets: OTAAsset[]): { receipt: Omit<AutomationExportReceipt, "artifactDigest">; assets: Omit<OTAAsset, "appId" | "createdAt">[] } {
  const { artifactDigest: _unused, ...core } = input as AutomationExportReceipt;
  const { artifactDigest: _placeholder, ...receipt } = parseAutomationExportReceipt({ ...core, artifactDigest: "0".repeat(64) });
  ensure(canonicalJson(assets.map(asset => asset.id)) === canonicalJson([receipt.launchAssetId, ...receipt.assetIds]), "INVALID_RELATION");
  return freeze({ receipt, assets: assets.map(asset => { const { appId: _app, createdAt: _time, ...metadata } = parseOTAAsset(asset); return metadata; }) });
}
export function assertAutomationPublication(jobInput: AutomationJob, leaseInput: AutomationLease, publication: AutomationPublication): void {
  const job = parseAutomationJob(jobInput), lease = parseAutomationLease(leaseInput), receipt = parseAutomationExportReceipt(publication.receipt), deployment = publication.deployment;
  ensure(receipt.jobId === job.id && receipt.attemptId === lease.attemptId && receipt.commitSha === job.commitSha && receipt.configDigest === job.configDigest && receipt.toolchainDigest === job.toolchainDigest, "INVALID_RELATION");
  const target = parseOTAPublishInput({ requestKey: deployment.requestKey, detectionId: deployment.detectionId, commitSha: deployment.commitSha, channel: deployment.channel, runtimeVersion: deployment.runtimeVersion, platform: deployment.platform, launchAssetId: deployment.launchAssetId, assetIds: deployment.assetIds });
  ensure(deployment.appId === job.appId && target.requestKey === job.id && target.detectionId === job.detectionId && target.commitSha === job.commitSha && target.channel === job.channel && target.runtimeVersion === job.runtimeVersion && target.platform === job.platform && target.launchAssetId === receipt.launchAssetId && canonicalJson(target.assetIds) === canonicalJson(receipt.assetIds), "INVALID_RELATION");
}
export async function runnerTokenHash(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token), hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); return Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
}
function equalDigest(first: string, second: string): boolean { let difference = first.length ^ second.length; for (let index = 0; index < 64; index++) difference |= (first.charCodeAt(index) || 0) ^ (second.charCodeAt(index) || 0); return difference === 0; }
function queueIdentity(job: AutomationQueueInput) { return parseAutomationQueueInput({ requestKey: job.requestKey, detectionId: job.detectionId, channel: job.channel, runtimeVersion: job.runtimeVersion, platform: job.platform, config: job.config }); }
/** The export execution never receives the bearer token. Machine writes use
 * separate atomic storage ports; browser owner authorization stays in adapters. */
export function createAutomationService(ctx: AutomationContext, options: AutomationServiceOptions): AutomationService {
  const now = options.now ?? Date.now, leaseMs = integer(options.leaseMs ?? 60_000, 1000, AUTOMATION_LEASE_MAX_MS);
  const maxWebhookTargets = integer(options.maxWebhookTargets ?? AUTOMATION_MAX_WEBHOOK_TARGETS, 1, AUTOMATION_MAX_WEBHOOK_TARGETS);
  const origin = () => typeof options.publicOrigin === "function" ? options.publicOrigin() : options.publicOrigin;
  async function application(appId: string) { const app = await ctx.applications.getApplication(id(appId)); ensure(app, "NOT_FOUND"); return app; }
  async function authority(token: string): Promise<RunnerAuthority> {
    ensure(typeof token === "string" && token.length <= 128, "PERMISSION_DENIED");
    const match = /^(runner_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.([A-Za-z0-9_-]{43})$/.exec(token); ensure(match, "PERMISSION_DENIED");
    const runner = await ctx.automation.getRunnerCredential(match[1]!); ensure(runner, "PERMISSION_DENIED");
    const current = parseRunnerCredential(runner), tokenHash = await runnerTokenHash(token);
    ensure(current.revokedAt === null && equalDigest(current.tokenHash, tokenHash), "PERMISSION_DENIED");
    return freeze({ runnerId: current.id, credentialEpoch: current.credentialEpoch, tokenHash });
  }
  async function queue(appId: string, input: AutomationQueueInput, expectedPolicyVersion?: number): Promise<AutomationJob> {
    const app = await application(appId), parsed = parseAutomationQueueInput(input), existing = await ctx.automation.getAutomationJobForRequest(appId, parsed.requestKey);
    if (existing) { ensure(canonicalJson(queueIdentity(existing)) === canonicalJson(parsed), "IDEMPOTENCY_CONFLICT"); return existing; }
    const [detection, connection] = await Promise.all([ctx.operations.getGitHubDetection(appId, parsed.detectionId), ctx.operations.getGitHubConnection(appId)]);
    ensure(detection && detection.appId === appId && detection.rootDirectory === app.rootDirectory, "NOT_FOUND");
    ensure(detection.automationConfig && canonicalJson(detection.automationConfig) === canonicalJson(parsed.config), "CONFIG_CONFLICT");
    assertDetectionCanPublish(detection, { requestKey: parsed.requestKey, detectionId: parsed.detectionId, commitSha: detection.commitSha, channel: parsed.channel, runtimeVersion: parsed.runtimeVersion, platform: parsed.platform, launchAssetId: "asset_" + "0".repeat(64), assetIds: [] }, connection);
    assertUpdateDestination(detection, appId, origin(), parsed.channel);
    const time = integer(now()), configDigest = await automationDigest(parsed.config), toolchainDigest = await automationDigest(parsed.config.toolchain);
    if (expectedPolicyVersion !== undefined) {
      const policy = await ctx.automation.getAutomationPolicy(appId);
      ensure(policy?.enabled && policy.version === expectedPolicyVersion && policy.channel === parsed.channel && policy.platform === parsed.platform, "CONFIG_CONFLICT");
    }
    return ctx.automation.enqueueAutomationJob(parseAutomationJob({ ...parsed, id: "automation_" + crypto.randomUUID(), appId, detection, connection: detection.connection, commitSha: detection.commitSha, rootDirectory: detection.rootDirectory, configDigest, toolchainDigest, createdAt: time, updatedAt: time, state: "queued", attemptCount: 0, lease: null, code: null, deploymentId: null, receipt: null }), expectedPolicyVersion);
  }
  const service: AutomationService = {
    async authorizeRunner(token, lease) { const auth = await authority(token); if (lease) await ctx.automation.requireAutomationLease(auth, parseAutomationLease(lease), now()); },
    async getState(appId) { await application(appId); const [jobs, runners, policy] = await Promise.all([ctx.automation.listAutomationJobs(appId), ctx.automation.listRunners(appId), ctx.automation.getAutomationPolicy(appId)]); return freeze({ jobs: jobs.slice(0, 20), runners: runners.map(runner => ({ id: runner.id, name: runner.name, appIds: runner.appIds, createdAt: runner.createdAt, credentialEpoch: runner.credentialEpoch, revokedAt: runner.revokedAt })), policy }); },
    async getJob(appId, jobId) { await application(appId); const job = await ctx.automation.getAutomationJob(appId, id(jobId)); ensure(job, "NOT_FOUND"); const [attempts, events] = await Promise.all([ctx.automation.listAutomationAttempts(appId, jobId), ctx.automation.listAutomationEvents(appId, jobId)]); return freeze({ job, attempts, events }); },
    async enrollRunner(input) {
      const parsed = parseRunnerEnrollmentInput(input), apps = new Set((await ctx.applications.listApplications()).map(app => app.id)); ensure(parsed.appIds.every(appId => apps.has(appId)), "NOT_FOUND");
      const runnerId = "runner_" + crypto.randomUUID(), secret = crypto.getRandomValues(new Uint8Array(32));
      const token = runnerId + "." + btoa(String.fromCharCode(...secret)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
      const runner = await ctx.automation.registerRunner(parseRunnerCredential({ id: runnerId, ...parsed, createdAt: now(), credentialEpoch: 1, revokedAt: null, tokenHash: await runnerTokenHash(token) }));
      return freeze({ runner, token });
    },
    async revokeRunner(runnerId) { return ctx.automation.revokeRunner(id(runnerId), now()); },
    queue,
    async updatePolicy(appId, input) { await application(appId); return ctx.automation.updateAutomationPolicy(appId, parseAutoPolicyUpdate(input), now()); },
    async handleGitHubPush(event) {
      const value = parseGitHubPushEvent(event); ensure(options.detectPushCommit, "PROVIDER_UNCONFIGURED");
      const targets = await ctx.automation.findAutomationTargets({ installationId: value.installationId, owner: value.owner, repository: value.repository, ref: value.ref });
      ensure(targets.length <= maxWebhookTargets, "INPUT_TOO_LARGE"); const jobs: AutomationJob[] = []; let ignored = 0;
      const requestKey = "hook_" + (await runnerTokenHash(value.deliveryId));
      for (const target of targets) {
        const existing = await ctx.automation.getAutomationJobForRequest(target.appId, requestKey);
        if (existing) { ensure(existing.commitSha === value.commitSha && existing.connection.installationId === value.installationId && existing.connection.owner.toLowerCase() === value.owner.toLowerCase() && existing.connection.repository.toLowerCase() === value.repository.toLowerCase() && existing.connection.ref === value.ref, "IDEMPOTENCY_CONFLICT"); jobs.push(existing); continue; }
        if (!target.policy.enabled) { ignored++; continue; }
        let detection: GitHubDetection;
        try { detection = await options.detectPushCommit(target.appId, value.commitSha); }
        catch (error) { if (error instanceof DomainError && error.code === "CONFIG_CONFLICT") { ignored++; continue; } throw error; }
        if (detection.commitSha !== value.commitSha || detection.connection.installationId !== value.installationId || detection.connection.owner.toLowerCase() !== value.owner.toLowerCase() || detection.connection.repository.toLowerCase() !== value.repository.toLowerCase() || detection.connection.ref !== value.ref) { ignored++; continue; }
        if (!detection.automationConfig || !detection.updatesEnabled) { ignored++; continue; }
        try { jobs.push(await queue(target.appId, { requestKey, detectionId: detection.id, channel: target.policy.channel, runtimeVersion: detection.automationConfig.runtimeVersion, platform: target.policy.platform, config: detection.automationConfig }, target.policy.version)); }
        catch (error) { if (error instanceof DomainError && error.code === "CONFIG_CONFLICT") { ignored++; continue; } throw error; }
      }
      return freeze({ jobs, ignored });
    },
    async cancel(appId, jobId) { await application(appId); return ctx.automation.cancelAutomationJob(appId, id(jobId), now()); },
    async claim(token, scope) {
      return ctx.automation.claimAutomationJob(await authority(token), now(), leaseMs, scope ? parseAutomationClaimScope(scope) : undefined);
    },
    async heartbeat(token, lease) { return ctx.automation.heartbeatAutomationJob(await authority(token), parseAutomationLease(lease), now(), leaseMs); },
    async source(token, lease) {
      const auth = await authority(token), parsed = parseAutomationLease(lease), job = await ctx.automation.requireAutomationLease(auth, parsed, now()); ensure(options.source, "PROVIDER_UNCONFIGURED");
      const grant = await options.source.grant(job.connection, job.commitSha, job.lease!.expiresAt);
      await ctx.automation.requireAutomationLease(auth, parsed, now()); ensure(grant.commitSha === job.commitSha && grant.expiresAt > now() && grant.url === `https://api.github.com/repos/${encodeURIComponent(job.connection.owner)}/${encodeURIComponent(job.connection.repository)}/tarball/${job.commitSha}`, "INVALID_RELATION");
      return grant;
    },
    async uploadAsset(token, lease, upload, bytes) {
      const auth = await authority(token), parsed = parseAutomationLease(lease); await ctx.automation.requireAutomationLease(auth, parsed, now());
      const copy = bytes.slice(), asset = await prepareOTAAsset(parsed.appId, upload, copy, now());
      return ctx.automation.saveAutomationAsset(auth, parsed, asset, copy, now());
    },
    async finalize(token, lease, receiptInput) {
      const auth = await authority(token), parsedLease = parseAutomationLease(lease), receipt = parseAutomationExportReceipt(receiptInput);
      const prior = await ctx.automation.getAutomationJob(parsedLease.appId, parsedLease.jobId);
      if (prior?.state === "succeeded") {
        ensure(prior.receipt && canonicalJson(prior.receipt) === canonicalJson(receipt), "IDEMPOTENCY_CONFLICT");
        const attempts = await ctx.automation.listAutomationAttempts(parsedLease.appId, prior.id);
        ensure(attempts.some(attempt => attempt.id === receipt.attemptId && attempt.runnerId === auth.runnerId && attempt.credentialEpoch === auth.credentialEpoch && attempt.fence === parsedLease.fence), "PERMISSION_DENIED");
        const deployment = await ctx.operations.getOTADeploymentForRequest(prior.appId, prior.id); ensure(deployment && deployment.id === prior.deploymentId, "INVALID_RELATION"); return freeze({ job: prior, deployment });
      }
      const job = await ctx.automation.requireAutomationLease(auth, parsedLease, now());
      ensure(receipt.jobId === job.id && receipt.attemptId === parsedLease.attemptId && receipt.commitSha === job.commitSha && receipt.configDigest === job.configDigest && receipt.toolchainDigest === job.toolchainDigest, "INVALID_RELATION");
      const metadata = await ctx.operations.listOTAAssets(job.appId), byId = new Map(metadata.map(asset => [asset.id, parseOTAAsset(asset)])), launchAsset = byId.get(receipt.launchAssetId), assets = receipt.assetIds.map(assetId => byId.get(assetId));
      ensure(launchAsset && assets.every(asset => asset !== undefined), "NOT_FOUND");
      ensure(equalDigest(receipt.artifactDigest, await automationDigest(automationArtifactPayload(receipt, [launchAsset, ...assets as OTAAsset[]]))), "INVALID_RELATION");
      ensure(new Set([launchAsset.key, ...assets.map(asset => asset!.key)]).size === assets.length + 1 && ["application/javascript", "text/javascript", "application/octet-stream"].includes(launchAsset.contentType), "INVALID_RELATION");
      assertUpdateDestination(job.detection, job.appId, origin(), job.channel);
      const deployment: OTADeployment = freeze({ id: crypto.randomUUID(), appId: job.appId, createdAt: integer(now()), requestKey: job.id, detectionId: job.detectionId, commitSha: job.commitSha, channel: job.channel, runtimeVersion: job.runtimeVersion, platform: job.platform, launchAssetId: launchAsset.id, assetIds: receipt.assetIds, launchAsset, assets: assets as OTAAsset[] });
      const publication = freeze({ deployment, receipt }); assertAutomationPublication(job, parsedLease, publication);
      return ctx.automation.finalizeAutomationJob(auth, parsedLease, publication, now());
    },
    async fail(token, lease, code) { return ctx.automation.failAutomationJob(await authority(token), parseAutomationLease(lease), parseAutomationFailureCode(code), now()); },
  };
  return service;
}
export function parseGitHubPushEvent(input: unknown): GitHubPushEvent {
  const value = object(input, ["deliveryId", "installationId", "owner", "repository", "ref", "commitSha"]), deliveryId = text(value.deliveryId, 128), owner = text(value.owner, 39), repository = text(value.repository, 100), ref = text(value.ref, 256), commitSha = text(value.commitSha, 40);
  ensure(/^[A-Za-z0-9_-]+$/.test(deliveryId) && /^[A-Za-z0-9-]+$/.test(owner) && /^[A-Za-z0-9_.-]+$/.test(repository) && /^[a-f0-9]{40}$/.test(commitSha));
  const normalized = ref.startsWith("refs/heads/") ? ref.slice(11) : ref;
  const identity = parseGitHubConnectionUpdate({ expectedVersion: 0, installationId: value.installationId, owner, repository, ref: normalized });
  return freeze({ deliveryId, installationId: identity.installationId, owner, repository, ref: normalized, commitSha });
}
export async function verifyGitHubWebhook(body: Uint8Array, signature: string | null, secret: string | undefined): Promise<void> {
  ensure(typeof secret === "string" && secret.length > 0 && secret.length <= 4096, "PROVIDER_UNCONFIGURED");
  ensure(body instanceof Uint8Array && body.length > 0 && body.length <= 1024 * 1024, "INPUT_TOO_LARGE");
  ensure(signature && /^sha256=[a-f0-9]{64}$/.test(signature), "PERMISSION_DENIED");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const supplied = Uint8Array.from(signature.slice(7).match(/../g)!, pair => Number.parseInt(pair, 16));
  ensure(await crypto.subtle.verify("HMAC", key, supplied, new Uint8Array(body).buffer), "PERMISSION_DENIED");
}
/** Call only after verifyGitHubWebhook on these exact, bounded raw bytes. */
export function parseGitHubWebhook(body: Uint8Array, headers: Headers): GitHubPushEvent | null {
  ensure(body instanceof Uint8Array && body.length > 0 && body.length <= 1024 * 1024, "INPUT_TOO_LARGE");
  if (headers.get("X-GitHub-Event") !== "push") return null;
  let parsed: unknown; try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); } catch { ensure(false); } safeJson(parsed);
  ensure(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)); const event = parsed as Record<string, unknown>;
  if (event.deleted === true) return null;
  ensure(event.installation && typeof event.installation === "object" && event.repository && typeof event.repository === "object");
  const installation = event.installation as Record<string, unknown>, repository = event.repository as Record<string, unknown>;
  ensure(repository.owner && typeof repository.owner === "object"); const owner = repository.owner as Record<string, unknown>;
  ensure(typeof event.ref === "string" && (event.ref.startsWith("refs/heads/") || event.ref.startsWith("refs/tags/")));
  return parseGitHubPushEvent({ deliveryId: headers.get("X-GitHub-Delivery"), installationId: installation.id, owner: owner.login, repository: repository.name, ref: event.ref, commitSha: event.after });
}
