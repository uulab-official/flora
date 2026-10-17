import type { ApplicationStore } from "./applications.js";
import { digest, ensure, id, integer, object, text } from "@app-ops/core";
import { canonicalJson, freeze } from "@app-ops/config";
import { parseAutomationConfigSnapshot } from "./automation.js";
import type { AutomationConfigSnapshot } from "./automation.js";

export type OTAPlatform = "ios" | "android";
export interface GitHubConnectionUpdate {
  expectedVersion: number;
  installationId: number;
  owner: string;
  repository: string;
  ref: string;
}
export interface GitHubConnection {
  appId: string;
  version: number;
  installationId: number;
  owner: string;
  repository: string;
  ref: string;
  connectedAt: number;
}
export interface GitHubDetectionResult {
  commitSha: string;
  framework: "expo" | "react-native" | "flora" | "unsupported";
  expoVersion: string | null;
  reactNativeVersion: string | null;
  configSource: "app.json" | "resolved-export" | "flora.config.json" | "none" | "dynamic-required";
  runtimeVersion: string | null;
  platforms: OTAPlatform[];
  updatesEnabled: boolean;
  updatesUrl: string | null;
  reasons: string[];
  automationConfig?: AutomationConfigSnapshot | null;
}
/** Evidence is pinned to this immutable connection version and source SHA. */
export interface GitHubDetection extends GitHubDetectionResult {
  id: string;
  appId: string;
  connection: GitHubConnection;
  rootDirectory: string;
  detectedAt: number;
}
export interface OTAAsset {
  id: string;
  appId: string;
  digest: string;
  hash: string;
  key: string;
  contentType: string;
  fileExtension: string;
  size: number;
  createdAt: number;
}
export interface OTAAssetUpload { key: string; contentType: string; fileExtension: string }
export interface StoredOTAAsset { asset: OTAAsset; bytes: Uint8Array }
export interface OTAPublishInput {
  requestKey: string;
  detectionId: string;
  commitSha: string;
  channel: string;
  runtimeVersion: string;
  platform: OTAPlatform;
  launchAssetId: string;
  assetIds: string[];
}
export interface OTARollbackInput {
  requestKey: string;
  fromDeploymentId: string;
  targetDeploymentId: string;
  reason: string;
}
/** Operator rollback is a new publication, separate from native launch recovery. */
export interface OTARollbackMetadata {
  fromDeploymentId: string;
  targetDeploymentId: string;
  reason: string;
  requestedAt: number;
}
/** Immutable publication references already uploaded app-scoped assets. */
export interface OTADeployment extends OTAPublishInput {
  id: string;
  appId: string;
  createdAt: number;
  launchAsset: OTAAsset;
  assets: OTAAsset[];
  rollback?: OTARollbackMetadata;
}
export interface OTASelection { channel: string; runtimeVersion: string; platform: OTAPlatform }
export interface OperationsState {
  connection: GitHubConnection | null;
  detections: GitHubDetection[];
  assets: OTAAsset[];
  deployments: OTADeployment[];
}
/** Each method is app-scoped. Mutation ports must validate foreign keys and
 * immutable content. Connection CAS starts at expectedVersion=0. Detection
 * insertion checks the current connection version; publication atomically
 * enforces (appId,requestKey) idempotency and asset/detection provenance.
 * getPublishedOTAAsset returns bytes only when an immutable deployment for
 * this app references the asset. Secrets never enter this storage contract. */
export interface OperationsStore {
  getGitHubConnection(appId: string): Promise<GitHubConnection | null>;
  saveGitHubConnection(appId: string, input: GitHubConnectionUpdate, now: number): Promise<GitHubConnection>;
  saveGitHubDetection(detection: GitHubDetection): Promise<GitHubDetection>;
  listGitHubDetections(appId: string): Promise<GitHubDetection[]>;
  getGitHubDetection(appId: string, detectionId: string): Promise<GitHubDetection | null>;
  saveOTAAsset(asset: OTAAsset, bytes: Uint8Array): Promise<OTAAsset>;
  listOTAAssets(appId: string, assetIds?: string[]): Promise<OTAAsset[]>;
  getOTAAsset(appId: string, assetId: string): Promise<StoredOTAAsset | null>;
  getPublishedOTAAsset(appId: string, assetId: string): Promise<StoredOTAAsset | null>;
  saveOTADeployment(deployment: OTADeployment): Promise<OTADeployment>;
  /** Atomically compare the selected head and restore exactly a prior artifact. */
  saveOTARollback(deployment: OTADeployment): Promise<OTADeployment>;
  getOTADeployment(appId: string, deploymentId: string): Promise<OTADeployment | null>;
  listOTADeployments(appId: string): Promise<OTADeployment[]>;
  getOTADeploymentForRequest(appId: string, requestKey: string): Promise<OTADeployment | null>;
  getLatestOTADeployment(appId: string, selection: OTASelection): Promise<OTADeployment | null>;
}
export interface OperationsContext { applications: ApplicationStore; operations: OperationsStore }
export interface GitHubResolver {
  detect(connection: GitHubConnection, rootDirectory: string, resolvedConfig?: unknown, requireCommitSha?: string): Promise<GitHubDetectionResult>;
}
export interface OperationsService {
  getState(appId: string): Promise<OperationsState>;
  connect(appId: string, input: GitHubConnectionUpdate, resolvedConfig?: unknown): Promise<OperationsState>;
  detect(appId: string, resolvedConfig?: unknown): Promise<GitHubDetection>;
  detectCommit(appId: string, commitSha: string, options?: { requireCurrentRef?: boolean }): Promise<GitHubDetection>;
  uploadAsset(appId: string, upload: OTAAssetUpload, bytes: Uint8Array): Promise<OTAAsset>;
  publish(appId: string, input: OTAPublishInput): Promise<OTADeployment>;
  rollback(appId: string, input: OTARollbackInput): Promise<OTADeployment>;
  getUpdate(appId: string, selection: OTASelection, origin: string, requestHeaders?: Headers): Promise<Response>;
  getPublishedAsset(appId: string, assetId: string): Promise<StoredOTAAsset | null>;
}
export interface OperationsServiceOptions {
  github?: GitHubResolver;
  now?: () => number;
  publicOrigin?: string | (() => string);
  signer?: ExpoManifestSigner;
}
export interface ExpoManifestSigner { keyId: string; sign(bytes: Uint8Array): Promise<Uint8Array> }
export const OTA_ASSET_MAX_BYTES = 16 * 1024 * 1024;
export const OTA_MAX_ASSETS = 64;
export const OTA_APP_MAX_ASSETS = 128;
export const OTA_APP_MAX_BYTES = 64 * 1024 * 1024;

export function parseGitHubConnectionUpdate(input: unknown): GitHubConnectionUpdate {
  const value = object(input, ["expectedVersion", "installationId", "owner", "repository", "ref"]);
  const owner = text(value.owner, 39), repository = text(value.repository, 100), ref = text(value.ref, 256);
  ensure(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner));
  ensure(/^[A-Za-z0-9_.-]+$/.test(repository) && ![".", ".."].includes(repository));
  ensure(!/[\u0000-\u0020\u007f~^:?*[\\]/.test(ref) && !ref.includes("..") && !ref.endsWith("/") && !ref.startsWith("/") && !ref.endsWith(".lock"));
  return freeze({ expectedVersion: integer(value.expectedVersion, 0, Number.MAX_SAFE_INTEGER - 1), installationId: integer(value.installationId, 1), owner, repository, ref });
}
export function parseOTAAssetUpload(input: unknown): OTAAssetUpload {
  const value = object(input, ["key", "contentType", "fileExtension"]);
  const key = text(value.key, 128), contentType = text(value.contentType, 128), fileExtension = text(value.fileExtension, 16);
  ensure(/^[A-Za-z0-9_-]+$/.test(key));
  ensure(/^(?:application\/(?:javascript|octet-stream|json|wasm|x-font-ttf|vnd\.ms-fontobject)|text\/javascript|image\/(?:png|jpeg|gif|webp|avif)|font\/(?:ttf|otf|woff|woff2)|audio\/(?:mpeg|mp4|wav|ogg)|video\/mp4)$/.test(contentType));
  ensure(/^\.[A-Za-z0-9]{1,15}$/.test(fileExtension));
  return freeze({ key, contentType, fileExtension });
}
export function otaAssetId(value: unknown): string {
  const result = text(value, 70); ensure(/^asset_[a-f0-9]{64}$/.test(result)); return result;
}
export function otaPlatform(value: unknown): OTAPlatform { ensure(value === "ios" || value === "android"); return value; }
export function parseOTASelection(input: unknown): OTASelection {
  const value = object(input, ["channel", "runtimeVersion", "platform"]);
  const channel = text(value.channel, 64), runtimeVersion = text(value.runtimeVersion, 128);
  ensure(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(channel) && !/[\u0000-\u001f\u007f]/.test(runtimeVersion));
  return freeze({ channel, runtimeVersion, platform: otaPlatform(value.platform) });
}
export function parseOTAPublishInput(input: unknown): OTAPublishInput {
  const value = object(input, ["requestKey", "detectionId", "commitSha", "channel", "runtimeVersion", "platform", "launchAssetId", "assetIds"]);
  const commitSha = text(value.commitSha, 40); ensure(/^[a-f0-9]{40}$/.test(commitSha));
  const selection = parseOTASelection({ channel: value.channel, runtimeVersion: value.runtimeVersion, platform: value.platform });
  const launchAssetId = otaAssetId(value.launchAssetId);
  ensure(Array.isArray(value.assetIds) && value.assetIds.length <= OTA_MAX_ASSETS);
  const assetIds = value.assetIds.map(otaAssetId);
  ensure(new Set(assetIds).size === assetIds.length && !assetIds.includes(launchAssetId));
  return freeze({ requestKey: id(value.requestKey), detectionId: id(value.detectionId), commitSha, ...selection, launchAssetId, assetIds });
}
export function otaDeploymentId(value: unknown): string {
  const result = text(value, 36);
  ensure(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(result));
  return result;
}
export function parseOTARollbackInput(input: unknown): OTARollbackInput {
  const value = object(input, ["requestKey", "fromDeploymentId", "targetDeploymentId", "reason"]);
  const reason = text(value.reason, 500).trim(); ensure(reason.length > 0 && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(reason));
  const fromDeploymentId = otaDeploymentId(value.fromDeploymentId), targetDeploymentId = otaDeploymentId(value.targetDeploymentId);
  ensure(fromDeploymentId !== targetDeploymentId, "INVALID_RELATION");
  return freeze({ requestKey: id(value.requestKey), fromDeploymentId, targetDeploymentId, reason });
}
export function parseOTARollbackMetadata(input: unknown): OTARollbackMetadata {
  const value = object(input, ["fromDeploymentId", "targetDeploymentId", "reason", "requestedAt"]);
  const { requestKey: _, ...parsed } = parseOTARollbackInput({ requestKey: "rollback_metadata", fromDeploymentId: value.fromDeploymentId, targetDeploymentId: value.targetDeploymentId, reason: value.reason });
  return freeze({ ...parsed, requestedAt: integer(value.requestedAt) });
}
function artifactIdentity(value: OTADeployment) {
  return { appId: value.appId, detectionId: value.detectionId, commitSha: value.commitSha,
    channel: value.channel, runtimeVersion: value.runtimeVersion, platform: value.platform,
    launchAssetId: value.launchAssetId, assetIds: value.assetIds, launchAsset: value.launchAsset, assets: value.assets };
}
/** Both adapters repeat this under their mutation boundary. */
export function assertOTARollbackDeployment(deployment: OTADeployment, source: OTADeployment | null, target: OTADeployment | null): void {
  const rollback = parseOTARollbackMetadata(deployment.rollback);
  ensure(source && target && source.appId === deployment.appId && target.appId === deployment.appId, "NOT_FOUND");
  ensure(source.id === rollback.fromDeploymentId && target.id === rollback.targetDeploymentId && target.createdAt < source.createdAt, "INVALID_RELATION");
  ensure(source.channel === target.channel && source.runtimeVersion === target.runtimeVersion && source.platform === target.platform, "INVALID_RELATION");
  ensure(canonicalJson(artifactIdentity(deployment)) === canonicalJson(artifactIdentity(target)), "INVALID_RELATION");
  ensure(deployment.id !== source.id && deployment.id !== target.id && rollback.requestedAt <= deployment.createdAt, "INVALID_RELATION");
}
export function parseGitHubDetection(input: unknown): GitHubDetection {
  const hasAutomation = typeof input === "object" && input !== null && Object.hasOwn(input, "automationConfig");
  const value = object(input, ["id", "appId", "connection", "rootDirectory", "detectedAt", "commitSha", "framework", "expoVersion", "reactNativeVersion", "configSource", "runtimeVersion", "platforms", "updatesEnabled", "updatesUrl", "reasons", ...(hasAutomation ? ["automationConfig"] : [])]);
  const connection = object(value.connection, ["appId", "version", "installationId", "owner", "repository", "ref", "connectedAt"]);
  const version = integer(connection.version, 1), appId = id(value.appId);
  const parsed = parseGitHubConnectionUpdate({ expectedVersion: version - 1, installationId: connection.installationId, owner: connection.owner, repository: connection.repository, ref: connection.ref });
  ensure(connection.appId === appId);
  const rootDirectory = text(value.rootDirectory, 4096);
  ensure(rootDirectory === "." || !/[\\:\u0000-\u001f\u007f]/.test(rootDirectory) && rootDirectory.split("/").every(part => part !== "" && ![".", "..", "__proto__", "constructor", "prototype"].includes(part)));
  const commitSha = text(value.commitSha, 40); ensure(/^[a-f0-9]{40}$/.test(commitSha));
  ensure(["expo", "react-native", "flora", "unsupported"].includes(String(value.framework)) && ["app.json", "resolved-export", "flora.config.json", "none", "dynamic-required"].includes(String(value.configSource)));
  const nullable = (field: unknown, max: number) => field === null ? null : text(field, max);
  const runtimeVersion = nullable(value.runtimeVersion, 128); if (runtimeVersion) ensure(!/[\u0000-\u001f\u007f]/.test(runtimeVersion));
  ensure(Array.isArray(value.platforms) && value.platforms.length <= 2 && new Set(value.platforms).size === value.platforms.length);
  const platforms = value.platforms.map(otaPlatform);
  ensure(typeof value.updatesEnabled === "boolean" && Array.isArray(value.reasons) && value.reasons.length <= 16);
  const reasons = value.reasons.map(reason => { const result = text(reason, 128); ensure(/^[A-Z][A-Z0-9_]*$/.test(result)); return result; });
  const updatesUrl = nullable(value.updatesUrl, 2048);
  if (updatesUrl) {
    let url: URL | undefined; try { url = new URL(updatesUrl); } catch { ensure(false); }
    ensure(url && !url.username && !url.password && !url.hash && (url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)));
  }
  if (value.updatesEnabled) ensure(value.framework !== "unsupported" && runtimeVersion && updatesUrl && platforms.length && reasons.length === 0 && !["none", "dynamic-required"].includes(String(value.configSource)));
  const automationConfig = hasAutomation && value.automationConfig !== null ? parseAutomationConfigSnapshot(value.automationConfig) : null;
  if (automationConfig) ensure(automationConfig.runtimeVersion === runtimeVersion && automationConfig.updatesUrl === updatesUrl && canonicalJson(automationConfig.platforms) === canonicalJson(platforms), "INVALID_RELATION");
  return freeze({ id: id(value.id), appId, connection: { appId, version, installationId: parsed.installationId, owner: parsed.owner, repository: parsed.repository, ref: parsed.ref, connectedAt: integer(connection.connectedAt) }, rootDirectory, detectedAt: integer(value.detectedAt), commitSha, framework: value.framework as GitHubDetection["framework"], expoVersion: nullable(value.expoVersion, 128), reactNativeVersion: nullable(value.reactNativeVersion, 128), configSource: value.configSource as GitHubDetection["configSource"], runtimeVersion, platforms, updatesEnabled: value.updatesEnabled, updatesUrl, reasons, ...(hasAutomation ? { automationConfig } : {}) });
}
export function parseOTAAsset(input: unknown): OTAAsset {
  const value = object(input, ["id", "appId", "digest", "hash", "key", "contentType", "fileExtension", "size", "createdAt"]);
  const hash = text(value.hash, 43); ensure(/^[A-Za-z0-9_-]{43}$/.test(hash));
  const hex = digest(value.digest); ensure(otaAssetId(value.id) === "asset_" + hex);
  const hashBytes = Uint8Array.from(hex.match(/../g)!, pair => Number.parseInt(pair, 16));
  ensure(btoa(String.fromCharCode(...hashBytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") === hash, "INVALID_RELATION");
  return freeze({ id: otaAssetId(value.id), appId: id(value.appId), digest: hex, hash, ...parseOTAAssetUpload({ key: value.key, contentType: value.contentType, fileExtension: value.fileExtension }), size: integer(value.size, 1, OTA_ASSET_MAX_BYTES), createdAt: integer(value.createdAt) });
}
export async function prepareOTAAsset(appId: string, upload: OTAAssetUpload, bytes: Uint8Array, now: number): Promise<OTAAsset> {
  ensure(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= OTA_ASSET_MAX_BYTES, "INPUT_TOO_LARGE");
  const metadata = parseOTAAssetUpload(upload), hashBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer));
  const hex = Array.from(hashBytes, byte => byte.toString(16).padStart(2, "0")).join("");
  const hash = btoa(String.fromCharCode(...hashBytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return freeze({ id: "asset_" + hex, appId: id(appId), digest: hex, hash, ...metadata, size: bytes.byteLength, createdAt: integer(now) });
}
export async function assertOTAAssetBytes(asset: OTAAsset, bytes: Uint8Array): Promise<void> {
  const parsed = parseOTAAsset(asset), computed = await prepareOTAAsset(parsed.appId, { key: parsed.key, contentType: parsed.contentType, fileExtension: parsed.fileExtension }, bytes, parsed.createdAt);
  ensure(canonicalJson(parsed) === canonicalJson(computed), "INVALID_RELATION");
}
export function assertDetectionCanPublish(detection: GitHubDetection, input: OTAPublishInput, connection: GitHubConnection | null): void {
  const parsed = parseGitHubDetection(detection), publish = parseOTAPublishInput(input);
  ensure(parsed.id === publish.detectionId && parsed.commitSha === publish.commitSha && connection && canonicalJson(parsed.connection) === canonicalJson(connection), "CONFIG_CONFLICT");
  ensure(parsed.updatesEnabled && parsed.runtimeVersion === publish.runtimeVersion && parsed.platforms.includes(publish.platform), "PROVIDER_UNSUPPORTED");
}
export function assertUpdateDestination(detection: GitHubDetection, appId: string, origin: string, channel: string): void {
  const actual = new URL(origin); ensure(actual.origin === origin && !actual.username && !actual.password && (actual.protocol === "https:" || actual.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(actual.hostname)), "INVALID_INPUT");
  ensure(detection.updatesUrl, "PROVIDER_UNSUPPORTED"); const destination = new URL(detection.updatesUrl);
  ensure(destination.origin === origin && destination.pathname === "/updates/" + id(appId) && !destination.hash && !destination.username && !destination.password, "PROVIDER_UNSUPPORTED");
  const query: [string, string][] = []; destination.searchParams.forEach((value, key) => query.push([key, value])); ensure(query.length === 0 || query.length === 1 && query[0]![0] === "channel" && query[0]![1] === channel, "PROVIDER_UNSUPPORTED");
}
/** Credentials are injected from the server, never settings/connection JSON.
 * Provider detection does not execute the app or prove native build readiness. */
export function createOperationsService(ctx: OperationsContext, github: GitHubResolver | undefined, now: () => number = Date.now, options: Omit<OperationsServiceOptions, "github" | "now"> = {}): OperationsService {
  async function app(appId: string) { const value = await ctx.applications.getApplication(id(appId)); ensure(value, "NOT_FOUND"); return value; }
  const service: OperationsService = {
    async getState(appId) {
      await app(appId);
      const [connection, detections, assets, deployments] = await Promise.all([ctx.operations.getGitHubConnection(appId), ctx.operations.listGitHubDetections(appId), ctx.operations.listOTAAssets(appId), ctx.operations.listOTADeployments(appId)]);
      return freeze({ connection, detections: detections.slice(0, 20), assets: assets.slice(0, OTA_APP_MAX_ASSETS), deployments: deployments.slice(0, 20) });
    },
    async connect(appId, input, resolvedConfig) {
      const application = await app(appId); ensure(github, "PROVIDER_UNCONFIGURED");
      const update = parseGitHubConnectionUpdate(input), current = await ctx.operations.getGitHubConnection(appId);
      ensure((current?.version ?? 0) === update.expectedVersion, "CONFIG_CONFLICT");
      const connectedAt = integer(now()); ensure(!current || connectedAt >= current.connectedAt);
      const candidate: GitHubConnection = freeze({ appId, version: update.expectedVersion + 1, installationId: update.installationId, owner: update.owner, repository: update.repository, ref: update.ref, connectedAt });
      // Resolve and validate the candidate before any persistence. Failed
      // provider reads must not replace a usable connection or its evidence.
      const result = await github.detect(candidate, application.rootDirectory, resolvedConfig);
      const detection = parseGitHubDetection({ ...result, id: "github_" + crypto.randomUUID(), appId, connection: candidate, rootDirectory: application.rootDirectory, detectedAt: integer(now()) });
      ensure(detection.framework !== "unsupported", "GITHUB_APP_UNSUPPORTED");
      ensure(detection.detectedAt >= candidate.connectedAt);
      // The storage CAS and detection connection fence still reject a newer
      // connection that won while the external source reads were in flight.
      const saved = await ctx.operations.saveGitHubConnection(appId, update, connectedAt);
      ensure(canonicalJson(saved) === canonicalJson(candidate), "CONFIG_CONFLICT");
      await ctx.operations.saveGitHubDetection(detection); return service.getState(appId);
    },
    async detect(appId, resolvedConfig) {
      const application = await app(appId); ensure(github, "PROVIDER_UNCONFIGURED");
      const connection = await ctx.operations.getGitHubConnection(appId); ensure(connection, "NOT_FOUND");
      const result = await github.detect(connection, application.rootDirectory, resolvedConfig);
      const detection = parseGitHubDetection({ ...result, id: "github_" + crypto.randomUUID(), appId, connection, rootDirectory: application.rootDirectory, detectedAt: integer(now()) });
      return ctx.operations.saveGitHubDetection(detection);
    },
    async detectCommit(appId, commitSha, options) {
      const application = await app(appId); ensure(github, "PROVIDER_UNCONFIGURED"); ensure(/^[a-f0-9]{40}$/.test(commitSha));
      const connection = await ctx.operations.getGitHubConnection(appId); ensure(connection, "NOT_FOUND");
      const result = options?.requireCurrentRef ? await github.detect(connection, application.rootDirectory, undefined, commitSha) : await github.detect({ ...connection, ref: commitSha }, application.rootDirectory);
      ensure(result.commitSha === commitSha, "CONFIG_CONFLICT");
      return ctx.operations.saveGitHubDetection(parseGitHubDetection({ ...result, id: "github_" + crypto.randomUUID(), appId, connection, rootDirectory: application.rootDirectory, detectedAt: integer(now()) }));
    },
    async uploadAsset(appId, upload, bytes) {
      await app(appId); ensure(bytes instanceof Uint8Array && bytes.byteLength <= OTA_ASSET_MAX_BYTES, "INPUT_TOO_LARGE");
      const copy = bytes.slice(), asset = await prepareOTAAsset(appId, upload, copy, now());
      return ctx.operations.saveOTAAsset(asset, copy);
    },
    async publish(appId, input) {
      await app(appId); const parsed = parseOTAPublishInput(input);
      const existing = await ctx.operations.getOTADeploymentForRequest(appId, parsed.requestKey);
      if (existing) {
        ensure(existing.appId === appId, "INVALID_RELATION");
        ensure(!existing.rollback, "IDEMPOTENCY_CONFLICT");
        const identity = parseOTAPublishInput({ requestKey: existing.requestKey, detectionId: existing.detectionId, commitSha: existing.commitSha, channel: existing.channel, runtimeVersion: existing.runtimeVersion, platform: existing.platform, launchAssetId: existing.launchAssetId, assetIds: existing.assetIds });
        ensure(canonicalJson(parsed) === canonicalJson(identity), "IDEMPOTENCY_CONFLICT");
        return freeze(existing);
      }
      const [detection, connection, uploaded] = await Promise.all([ctx.operations.getGitHubDetection(appId, parsed.detectionId), ctx.operations.getGitHubConnection(appId), ctx.operations.listOTAAssets(appId,[parsed.launchAssetId,...parsed.assetIds])]);
      ensure(detection && detection.appId === appId, "NOT_FOUND"); assertDetectionCanPublish(detection, parsed, connection);
      const origin = typeof options.publicOrigin === "function" ? options.publicOrigin() : options.publicOrigin;
      ensure(origin, "PROVIDER_UNCONFIGURED"); assertUpdateDestination(detection, appId, origin, parsed.channel);
      const byId = new Map(uploaded.map(value => [value.id, parseOTAAsset(value)]));
      const launchAsset = byId.get(parsed.launchAssetId), assets = parsed.assetIds.map(assetId => byId.get(assetId));
      ensure(launchAsset && assets.every(value => value !== undefined), "NOT_FOUND");
      ensure(launchAsset.appId === appId && assets.every(value => value!.appId === appId), "NOT_FOUND");
      ensure(["application/javascript", "text/javascript", "application/octet-stream"].includes(launchAsset.contentType), "INVALID_RELATION");
      ensure(new Set([launchAsset.key, ...assets.map(value => value!.key)]).size === assets.length + 1, "INVALID_RELATION");
      return ctx.operations.saveOTADeployment(freeze({ ...parsed, id: crypto.randomUUID(), appId, createdAt: integer(now()), launchAsset, assets: assets as OTAAsset[] }));
    },
    async rollback(appId, input) {
      await app(appId); const parsed = parseOTARollbackInput(input);
      const existing = await ctx.operations.getOTADeploymentForRequest(appId, parsed.requestKey);
      if (existing) {
        ensure(existing.appId === appId && existing.rollback, "IDEMPOTENCY_CONFLICT");
        const rollback = parseOTARollbackMetadata(existing.rollback);
        ensure(canonicalJson({ requestKey: existing.requestKey, fromDeploymentId: rollback.fromDeploymentId, targetDeploymentId: rollback.targetDeploymentId, reason: rollback.reason }) === canonicalJson(parsed), "IDEMPOTENCY_CONFLICT");
        return freeze(existing);
      }
      const [source, target] = await Promise.all([ctx.operations.getOTADeployment(appId, parsed.fromDeploymentId), ctx.operations.getOTADeployment(appId, parsed.targetDeploymentId)]);
      ensure(source && target, "NOT_FOUND");
      const requestedAt = integer(now());
      const deployment: OTADeployment = freeze({ ...target, id: crypto.randomUUID(), requestKey: parsed.requestKey,
        createdAt: Math.max(requestedAt, source.createdAt + 1), rollback: { fromDeploymentId: source.id, targetDeploymentId: target.id, reason: parsed.reason, requestedAt } });
      assertOTARollbackDeployment(deployment, source, target);
      const latest = await ctx.operations.getLatestOTADeployment(appId, { channel: deployment.channel, runtimeVersion: deployment.runtimeVersion, platform: deployment.platform });
      ensure(latest?.id === source.id, "CONFIG_CONFLICT");
      const detection = await ctx.operations.getGitHubDetection(appId, target.detectionId); ensure(detection, "INVALID_RELATION");
      const origin = typeof options.publicOrigin === "function" ? options.publicOrigin() : options.publicOrigin;
      ensure(origin, "PROVIDER_UNCONFIGURED"); assertUpdateDestination(detection, appId, origin, target.channel);
      return ctx.operations.saveOTARollback(deployment);
    },
    async getUpdate(appId, selection, origin, requestHeaders) { await app(appId); return createOTAUpdateResponse(ctx.operations, appId, parseOTASelection(selection), origin, requestHeaders ?? new Headers(), options.signer); },
    async getPublishedAsset(appId, assetId) { await app(appId); const stored = await ctx.operations.getPublishedOTAAsset(appId, otaAssetId(assetId)); if (stored) { ensure(stored.asset.appId === appId && stored.asset.id === assetId, "INVALID_RELATION"); await assertOTAAssetBytes(stored.asset, stored.bytes); } return stored; },
  };
  return service;
}
function updateHeaders(appId: string, selection: OTASelection): Headers { return new Headers({ "expo-protocol-version": "1", "expo-sfv-version": "0", "expo-manifest-filters": `channel="${selection.channel}", appid="${appId}"`, "expo-server-defined-headers": "", "Cache-Control": "private, max-age=0", Vary: "expo-platform, expo-runtime-version, expo-channel-name, accept, expo-expect-signature" }); }
function responseFormat(accept: string | null): "application/expo+json" | "application/json" | "multipart/mixed" | null {
  if (accept === null || accept === "") return "application/expo+json";
  if (accept.length > 2048) return null;
  const parts = accept.split(","); if (parts.length > 16) return null;
  const accepted = parts.map((part, index) => {
    const fields = part.trim().split(";").map(value => value.trim()), media = fields[0]!.toLowerCase();
    const quality = fields.slice(1).find(value => value.startsWith("q=")); const q = quality === undefined ? 1 : Number(quality.slice(2));
    return { media, q: Number.isFinite(q) && q > 0 && q <= 1 ? q : 0, index };
  });
  const formats = ["application/expo+json", "application/json", "multipart/mixed"] as const;
  const candidates = formats.map(format => {
    const family = format.split("/")[0] + "/*";
    const matches = accepted.filter(value => value.media === format || value.media === family || value.media === "*/*").sort((a, b) => (b.media === format ? 2 : b.media === family ? 1 : 0) - (a.media === format ? 2 : a.media === family ? 1 : 0) || b.q - a.q || a.index - b.index);
    return { format, q: matches[0]?.q ?? 0, index: matches[0]?.index ?? 1000 };
  }).sort((a, b) => b.q - a.q || a.index - b.index);
  return candidates[0]?.q ? candidates[0].format : null;
}
async function createOTAUpdateResponse(store: OperationsStore, appId: string, selection: OTASelection, origin: string, requestHeaders: Headers, signer?: ExpoManifestSigner): Promise<Response> {
  const headers = updateHeaders(appId, selection), protocol = requestHeaders.get("expo-protocol-version");
  if (protocol !== null && protocol !== "1") return new Response(null, { status: 406, headers });
  const format = responseFormat(requestHeaders.get("accept")); if (!format) return new Response(null, { status: 406, headers });
  const deployment = await store.getLatestOTADeployment(id(appId), selection);
  if (!deployment) return new Response(null, { status: 204, headers });
  ensure(deployment.appId === appId && deployment.channel === selection.channel && deployment.runtimeVersion === selection.runtimeVersion && deployment.platform === selection.platform, "INVALID_RELATION");
  ensure(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(deployment.id), "INVALID_RELATION");
  const rawDetection = await store.getGitHubDetection(appId, deployment.detectionId); ensure(rawDetection, "INVALID_RELATION");
  const detection = parseGitHubDetection(rawDetection); ensure(detection.appId === appId && detection.commitSha === deployment.commitSha && detection.runtimeVersion === deployment.runtimeVersion && detection.platforms.includes(deployment.platform) && detection.updatesEnabled, "INVALID_RELATION"); assertUpdateDestination(detection, appId, origin, selection.channel);
  ensure(deployment.launchAsset.id === deployment.launchAssetId && deployment.assets.length <= OTA_MAX_ASSETS && canonicalJson(deployment.assets.map(value => value.id)) === canonicalJson(deployment.assetIds), "INVALID_RELATION");
  const asset = (value: OTAAsset, launch = false) => { const parsed = parseOTAAsset(value); ensure(parsed.appId === appId, "INVALID_RELATION"); return { hash: parsed.hash, key: parsed.key, contentType: parsed.contentType, ...(launch ? {} : { fileExtension: parsed.fileExtension }), url: origin + "/updates/" + appId + "/assets/" + parsed.digest }; };
  const body = JSON.stringify({ id: deployment.id, createdAt: new Date(deployment.createdAt).toISOString(), runtimeVersion: deployment.runtimeVersion, launchAsset: asset(deployment.launchAsset, true), assets: deployment.assets.map(value => asset(value)), metadata: { channel: deployment.channel, appid: appId }, extra: { flora: { appId, platform: deployment.platform, commitSha: deployment.commitSha, detectionId: deployment.detectionId } } });
  let signature: string | undefined;
  const expected = requestHeaders.get("expo-expect-signature");
  if (expected !== null) {
    ensure(signer, "PROVIDER_UNCONFIGURED"); ensure(expected.length <= 512 && /^[A-Za-z0-9._-]{1,128}$/.test(signer.keyId), "INVALID_INPUT");
    const entries = expected.split(",").map(value => value.trim()); ensure(entries.length <= 3 && new Set(entries.map(value => value.split("=")[0])).size === entries.length && entries.every(value => /^(?:sig(?:=\?1)?|keyid="[A-Za-z0-9._-]{1,128}"|alg="rsa-v1_5-sha256")$/.test(value)), "PROVIDER_UNSUPPORTED");
    const key = entries.find(value => value.startsWith("keyid=")); ensure(key === undefined || key === `keyid="${signer.keyId}"`, "PROVIDER_UNSUPPORTED");
    const bytes = await signer.sign(new TextEncoder().encode(body)); ensure(bytes instanceof Uint8Array && bytes.length >= 128 && bytes.length <= 1024, "PROVIDER_UNSUPPORTED");
    signature = `sig="${btoa(String.fromCharCode(...bytes))}", keyid="${signer.keyId}", alg="rsa-v1_5-sha256"`;
  }
  if (format === "multipart/mixed") {
    const boundary = "flora_" + crypto.randomUUID(); headers.set("Content-Type", "multipart/mixed; boundary=" + boundary);
    return new Response(`--${boundary}\r\nContent-Disposition: form-data; name="manifest"\r\nContent-Type: application/expo+json\r\n${signature ? "expo-signature: " + signature + "\r\n" : ""}\r\n${body}\r\n--${boundary}--\r\n`, { headers });
  }
  headers.set("Content-Type", format); if (signature) headers.set("expo-signature", signature);
  return new Response(body, { headers });
}
export async function serveOTAUpdate(store: OperationsStore, appId: string, request: Request, origin: string, signer?: ExpoManifestSigner): Promise<Response> {
  const url = new URL(request.url); ensure(request.method === "GET" && url.origin === origin && url.pathname === "/updates/" + id(appId), "INVALID_INPUT");
  const query: [string, string][] = []; url.searchParams.forEach((value, key) => query.push([key, value])); ensure(query.length === 0 || query.length === 1 && query[0]![0] === "channel", "INVALID_INPUT");
  const selection = parseOTASelection({ channel: url.searchParams.get("channel") ?? request.headers.get("expo-channel-name") ?? "production", runtimeVersion: request.headers.get("expo-runtime-version"), platform: request.headers.get("expo-platform") });
  return createOTAUpdateResponse(store, appId, selection, origin, request.headers, signer);
}
export async function serveOTAAsset(store: OperationsStore, appId: string, assetDigest: string): Promise<Response> {
  const stored = await store.getPublishedOTAAsset(id(appId), "asset_" + digest(assetDigest));
  if (!stored) return new Response(null, { status: 404 });
  await assertOTAAssetBytes(stored.asset, stored.bytes);
  return new Response(new Uint8Array(stored.bytes).buffer, { headers: { "Content-Type": stored.asset.contentType, "Content-Length": String(stored.asset.size), "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'", ETag: `"${stored.asset.digest}"` } });
}
