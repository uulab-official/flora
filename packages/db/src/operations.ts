import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ensure, id, integer, object, text } from "@app-ops/core";
import { canonicalJson, freeze } from "@app-ops/config";
import { applicationId, assertDetectionCanPublish, assertOTARollbackDeployment, parseOTARollbackMetadata, otaDeploymentId, parseGitHubDetection, parseOTAAsset, otaAssetId, OTA_APP_MAX_ASSETS, OTA_APP_MAX_BYTES, parseGitHubConnectionUpdate, parseOTAPublishInput, parseOTASelection } from "@app-ops/dogfood";
import type { GitHubConnection, GitHubConnectionUpdate, GitHubDetection, OTAAsset, OTADeployment, OTASelection, StoredOTAAsset } from "@app-ops/dogfood";
import { getApplication } from "./applications.js";
import { row, rows, transaction } from "./database.js";
function parsed<T>(data: string | number | null | undefined): T { return freeze(JSON.parse(String(data)) as T); }
function app(db: DatabaseSync, appId: string) { const value = getApplication(db, applicationId(appId)); ensure(value,"NOT_FOUND"); return value; }
export function getGitHubConnection(db: DatabaseSync, appId: string): GitHubConnection | null {
  applicationId(appId);
  const found = row(db,"SELECT data FROM github_connection_history WHERE app_id=? ORDER BY version DESC LIMIT 1",appId);
  return found ? parsed(found.data) : null;
}
export function saveGitHubConnection(db: DatabaseSync, appId: string, input: GitHubConnectionUpdate, now: number): GitHubConnection {
  applicationId(appId); const value = parseGitHubConnectionUpdate(input); integer(now);
  return transaction(db,()=>{
    app(db,appId); const current = getGitHubConnection(db,appId);
    ensure((current?.version ?? 0) === value.expectedVersion,"CONFLICT");
    ensure(!current || now >= current.connectedAt);
    const connection: GitHubConnection = { appId,version:value.expectedVersion+1,installationId:value.installationId,owner:value.owner,repository:value.repository,ref:value.ref,connectedAt:now };
    db.prepare("INSERT INTO github_connection_history VALUES(?,?,?)").run(appId,connection.version,canonicalJson(connection));
    return getGitHubConnection(db,appId)!;
  });
}
export function saveGitHubDetection(db: DatabaseSync, input: GitHubDetection): GitHubDetection {
  const detection = parseGitHubDetection(input);
  return transaction(db,()=>{
    const application = app(db,detection.appId), connection = getGitHubConnection(db,detection.appId);
    ensure(connection && canonicalJson(connection)===canonicalJson(detection.connection),"CONFLICT");
    ensure(application.rootDirectory === detection.rootDirectory,"INVALID_RELATION");
    ensure(detection.detectedAt>=connection.connectedAt);
    const existing = getGitHubDetection(db,detection.appId,detection.id);
    if (existing) { ensure(canonicalJson(existing)===canonicalJson(detection),"IDEMPOTENCY_CONFLICT"); return existing; }
    db.prepare("INSERT INTO github_detections VALUES(?,?,?,?,?)").run(detection.appId,detection.id,connection.version,detection.detectedAt,canonicalJson(detection));
    return getGitHubDetection(db,detection.appId,detection.id)!;
  });
}
export function listGitHubDetections(db: DatabaseSync, appId: string): GitHubDetection[] {
  applicationId(appId); return rows(db,"SELECT data FROM github_detections WHERE app_id=? ORDER BY detected_at DESC,rowid DESC LIMIT 100",appId).map(r=>parsed(r.data));
}
export function getGitHubDetection(db: DatabaseSync, appId: string, detectionId: string): GitHubDetection | null {
  applicationId(appId); id(detectionId); const found = row(db,"SELECT data FROM github_detections WHERE app_id=? AND id=?",appId,detectionId); return found ? parsed(found.data) : null;
}
function persistOTAAsset(db: DatabaseSync, input: OTAAsset, inputBytes: Uint8Array, nested: boolean): OTAAsset {
  ensure(!nested || db.isTransaction);
  const parsedAsset = parseOTAAsset(input);
  ensure(inputBytes instanceof Uint8Array && inputBytes.byteLength===parsedAsset.size);
  const bytes = Uint8Array.from(inputBytes), asset = parsedAsset;
  const hash = createHash("sha256").update(bytes).digest();
  ensure(hash.toString("hex")===asset.digest && hash.toString("base64url")===asset.hash && asset.id==="asset_"+asset.digest);
  const mutate = (): OTAAsset => {
    app(db,asset.appId); const existing = getOTAAsset(db,asset.appId,asset.id);
    if (existing) {
      const {createdAt:_old,...old} = existing.asset, {createdAt:_new,...next} = asset;
      ensure(canonicalJson(old)===canonicalJson(next) && Buffer.from(existing.bytes).equals(bytes),"IDEMPOTENCY_CONFLICT"); return existing.asset;
    }
    const usage = row(db,"SELECT count(*) n,coalesce(sum(size),0) size FROM ota_assets WHERE app_id=?",asset.appId)!;
    ensure(Number(usage.n)<OTA_APP_MAX_ASSETS && Number(usage.size)+asset.size<=OTA_APP_MAX_BYTES,"INPUT_TOO_LARGE");
    db.prepare("INSERT INTO ota_assets VALUES(?,?,?,?,?,?)").run(asset.appId,asset.id,asset.digest,asset.size,bytes,canonicalJson(asset));
    return getOTAAsset(db,asset.appId,asset.id)!.asset;
  };
  return nested ? mutate() : transaction(db,mutate);
}
export function saveOTAAsset(db: DatabaseSync, input: OTAAsset, bytes: Uint8Array): OTAAsset {
  return persistOTAAsset(db,input,bytes,false);
}
/** Internal composition port; the lease-owning caller must provide the transaction. */
export function saveOTAAssetInTransaction(db: DatabaseSync, input: OTAAsset, bytes: Uint8Array): OTAAsset {
  return persistOTAAsset(db,input,bytes,true);
}
export function listOTAAssets(db: DatabaseSync, appId: string): OTAAsset[] {
  applicationId(appId); return rows(db,"SELECT data FROM ota_assets WHERE app_id=? ORDER BY json_extract(data,'$.createdAt'),rowid",appId).map(r=>parsed(r.data));
}
function assetMetadata(db: DatabaseSync, appId: string, assetId: string): OTAAsset | null {
  const found = row(db,"SELECT data FROM ota_assets WHERE app_id=? AND id=?",appId,assetId);
  return found ? parsed(found.data) : null;
}
export function getOTAAsset(db: DatabaseSync, appId: string, assetId: string): StoredOTAAsset | null {
  applicationId(appId); otaAssetId(assetId);
  const found = db.prepare("SELECT data,bytes FROM ota_assets WHERE app_id=? AND id=?").get(appId,assetId) as {data:string;bytes:Uint8Array}|undefined;
  return found ? { asset:parsed(found.data),bytes:Uint8Array.from(found.bytes) } : null;
}
export function getPublishedOTAAsset(db: DatabaseSync, appId: string, assetId: string): StoredOTAAsset | null {
  applicationId(appId); otaAssetId(assetId);
  return row(db,"SELECT 1 FROM ota_deployment_assets WHERE app_id=? AND asset_id=? LIMIT 1",appId,assetId) ? getOTAAsset(db,appId,assetId) : null;
}
function persistOTADeployment(db: DatabaseSync, input: OTADeployment, nested: boolean, rollback = false): OTADeployment {
  ensure(!nested || db.isTransaction);
  object(input,["id","appId","createdAt","requestKey","detectionId","commitSha","channel","runtimeVersion","platform","launchAssetId","assetIds","launchAsset","assets", ...(rollback ? ["rollback"] : [])]);
  if (rollback) parseOTARollbackMetadata(input.rollback);
  const deploymentId = text(input.id,96);
  ensure(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(deploymentId));
  applicationId(input.appId); integer(input.createdAt);
  const request = parseOTAPublishInput({requestKey:input.requestKey,detectionId:input.detectionId,commitSha:input.commitSha,channel:input.channel,runtimeVersion:input.runtimeVersion,platform:input.platform,launchAssetId:input.launchAssetId,assetIds:input.assetIds});
  const deployment = JSON.parse(canonicalJson(input)) as OTADeployment;
  const inputDigest = createHash("sha256").update(canonicalJson({...request,launchAsset:deployment.launchAsset,assets:deployment.assets,...(rollback ? { rollback: { ...deployment.rollback!, requestedAt: 0 } } : {})})).digest("hex");
  const mutate = (): OTADeployment => {
    app(db,deployment.appId);
    const existing = row(db,"SELECT data,input_digest FROM ota_deployments WHERE app_id=? AND request_key=?",deployment.appId,request.requestKey);
    if (existing) { ensure(existing.input_digest===inputDigest,"IDEMPOTENCY_CONFLICT"); return parsed(existing.data); }
    const detection = getGitHubDetection(db,deployment.appId,request.detectionId); ensure(detection,"INVALID_RELATION");
    if (rollback) {
      const source = getOTADeployment(db, deployment.appId, deployment.rollback!.fromDeploymentId), target = getOTADeployment(db, deployment.appId, deployment.rollback!.targetDeploymentId);
      assertOTARollbackDeployment(deployment, source, target);
      ensure(getLatestOTADeployment(db, deployment.appId, { channel: deployment.channel, runtimeVersion: deployment.runtimeVersion, platform: deployment.platform })?.id === source!.id, "CONFIG_CONFLICT");
    } else assertDetectionCanPublish(detection,request,getGitHubConnection(db,deployment.appId));
    ensure(deployment.createdAt>=detection.detectedAt);
    const launch = assetMetadata(db,deployment.appId,request.launchAssetId); ensure(launch,"INVALID_RELATION");
    ensure(canonicalJson(launch)===canonicalJson(deployment.launchAsset),"INVALID_RELATION");
    ensure(Array.isArray(deployment.assets) && deployment.assets.length===request.assetIds.length,"INVALID_RELATION");
    for (const [index,assetId] of request.assetIds.entries()) {
      const asset = assetMetadata(db,deployment.appId,assetId);
      ensure(asset && canonicalJson(asset)===canonicalJson(deployment.assets[index]),"INVALID_RELATION");
    }
    ensure([launch,...deployment.assets].every(a=>a.createdAt<=deployment.createdAt));
    // Expo clients select by createdAt, so publication time must advance even
    // when the operator clock repeats or trails an earlier allocated timestamp.
    const previous = row(db,"SELECT max(created_at) created_at FROM ota_deployments WHERE app_id=? AND channel=? AND runtime_version=? AND platform=?",deployment.appId,request.channel,request.runtimeVersion,request.platform);
    if (previous?.created_at !== null && previous?.created_at !== undefined) {
      const lastCreatedAt = integer(Number(previous.created_at),0,Number.MAX_SAFE_INTEGER-1);
      deployment.createdAt = integer(Math.max(deployment.createdAt,lastCreatedAt+1));
    }
    db.prepare("INSERT INTO ota_deployments VALUES(?,?,?,?,?,?,?,?,?,?)").run(deployment.appId,deployment.id,request.requestKey,inputDigest,request.detectionId,request.channel,request.runtimeVersion,request.platform,deployment.createdAt,canonicalJson(deployment));
    const insert = db.prepare("INSERT INTO ota_deployment_assets VALUES(?,?,?,?)");
    insert.run(deployment.appId,deployment.id,launch.id,"launch");
    for (const assetId of request.assetIds) insert.run(deployment.appId,deployment.id,assetId,"asset");
    return parsed(canonicalJson(deployment));
  };
  return nested ? mutate() : transaction(db,mutate);
}
export function saveOTADeployment(db: DatabaseSync, input: OTADeployment): OTADeployment {
  return persistOTADeployment(db,input,false);
}
export function saveOTARollback(db: DatabaseSync, input: OTADeployment): OTADeployment {
  return persistOTADeployment(db, input, false, true);
}
export function getOTADeployment(db: DatabaseSync, appId: string, deploymentId: string): OTADeployment | null {
  applicationId(appId); otaDeploymentId(deploymentId);
  const found = row(db, "SELECT data FROM ota_deployments WHERE app_id=? AND id=?", appId, deploymentId);
  return found ? parsed(found.data) : null;
}
/** Internal composition port for atomic job/deployment provenance finalization. */
export function saveOTADeploymentInTransaction(db: DatabaseSync, input: OTADeployment): OTADeployment {
  return persistOTADeployment(db,input,true);
}
export function getOTADeploymentForRequest(db: DatabaseSync, appId: string, requestKey: string): OTADeployment | null {
  applicationId(appId); id(requestKey);
  const found = row(db,"SELECT data FROM ota_deployments WHERE app_id=? AND request_key=?",appId,requestKey);
  return found ? parsed(found.data) : null;
}
export function listOTADeployments(db: DatabaseSync, appId: string): OTADeployment[] {
  applicationId(appId); return rows(db,"SELECT data FROM ota_deployments WHERE app_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100",appId).map(r=>parsed(r.data));
}
export function getLatestOTADeployment(db: DatabaseSync, appId: string, input: OTASelection): OTADeployment | null {
  applicationId(appId); const selection = parseOTASelection(input);
  const found = row(db,"SELECT data FROM ota_deployments WHERE app_id=? AND channel=? AND runtime_version=? AND platform=? ORDER BY created_at DESC,rowid DESC LIMIT 1",appId,selection.channel,selection.runtimeVersion,selection.platform);
  return found ? parsed(found.data) : null;
}
