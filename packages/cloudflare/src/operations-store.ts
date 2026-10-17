import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types";
import { canonicalJson, freeze } from "@app-ops/config";
import { DomainError, ensure, id, integer, object, safeJson, text } from "@app-ops/core";
import { applicationId, OTA_MAX_ASSETS, OTA_ASSET_MAX_BYTES, parseGitHubConnectionUpdate, parseOTAAssetUpload, parseOTAPublishInput, parseOTASelection, parseGitHubDetection, parseOTAAsset, assertOTAAssetBytes, assertDetectionCanPublish, assertOTARollbackDeployment, parseOTARollbackMetadata, otaDeploymentId } from "@app-ops/dogfood";
import type { ApplicationStore, GitHubConnection, GitHubDetection, OTAAsset, OTADeployment, OperationsStore, StoredOTAAsset } from "@app-ops/dogfood";
import type { ExternalOTAAssets, ExternalAssetProof } from "./external-assets.js";

type Row = Record<string, string | number | null>;
const encoder = new TextEncoder();
const CHUNK_BYTES = 524288;
const value = <T>(row: Row): T => freeze(JSON.parse(String(row.data)) as T);
function owned<T>(input: T): T { safeJson(input); return freeze(JSON.parse(canonicalJson(input)) as T); }
function charge(fields: unknown[]): number {
  const size = encoder.encode(canonicalJson(fields)).byteLength;
  ensure(size <= 1048576, "INPUT_TOO_LARGE"); return size;
}
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
function assetDigest(assetId: string): string {
  ensure(/^asset_[a-f0-9]{64}$/.test(text(assetId, 70))); return assetId.slice(6);
}
export interface D1PreparedAsset {
  existing: OTAAsset | null;
  statements: D1PreparedStatement[];
  readAsset(results: D1Result<Row>[]): OTAAsset;
}
export interface D1PreparedPublication {
  existing: OTADeployment | null;
  statements: D1PreparedStatement[];
  readReceipt(results: D1Result<Row>[]): OTADeployment;
}
export interface D1OperationsStore extends OperationsStore {
  readonly externalAssets: boolean;
  /** Internal preparation only: callers must submit the entire batch atomically. */
  prepareOTAAsset(input: OTAAsset, bytes: Uint8Array, registeredScope?: boolean, bytesOwned?: boolean): Promise<D1PreparedAsset>;
  prepareOTADeployment(input: OTADeployment): Promise<D1PreparedPublication>;
}
/** All mutation batches share the auth store's synchronous submission fence. */
export function createD1OperationsStore(db: D1Database, owner: string, applications: ApplicationStore,
  verify: () => Promise<void>, beforeCommit: () => void, externalAssets?:ExternalOTAAssets): D1OperationsStore {
  const insert = (table: string, columns: string[], fields: (string | number | null)[], suffix = "", extra: (string | number | null)[] = []) =>
    db.prepare(`INSERT INTO ${table}(${columns.join(",")},stored_bytes) SELECT ${fields.map(() => "?").join(",")},? ${suffix}`)
      .bind(...fields, charge(fields), ...extra);
  async function submit(statements: D1PreparedStatement[]) {
    beforeCommit();
    try { return await db.batch<Row>(statements); }
    catch (error) {
      if (error instanceof Error && /flora capacity exceeded|connection version conflict|detection connection mismatch|deployment provenance mismatch|incomplete asset|deployment timestamp conflict|rollback provenance mismatch|UNIQUE constraint failed/.test(error.message)) throw new DomainError("CONFLICT");
      throw error;
    }
  }
  async function app(appId: string) {
    applicationId(appId); const found = await applications.getApplication(appId); ensure(found, "NOT_FOUND"); return found;
  }
  const connectionLookup = (appId: string) => db.prepare("SELECT data FROM github_connections WHERE owner_id=? AND app_id=? ORDER BY version DESC LIMIT 1").bind(owner, appId);
  const detectionLookup = (appId: string, detectionId: string) => db.prepare("SELECT data FROM github_detections WHERE owner_id=? AND app_id=? AND id=?").bind(owner, appId, detectionId);
  const assetLookup = (appId: string, hash: string) => db.prepare(externalAssets
    ? "SELECT a.data,a.chunk_count,a.byte_length,r.object_key,r.object_version,r.etag FROM ota_assets a LEFT JOIN ota_external_assets r ON r.owner_id=a.owner_id AND r.app_id=a.app_id AND r.hash=a.hash WHERE a.owner_id=? AND a.app_id=? AND a.hash=?"
    : "SELECT data,chunk_count,byte_length FROM ota_assets WHERE owner_id=? AND app_id=? AND hash=?").bind(owner, appId, hash);
  const externalProof=(row:Row,asset:OTAAsset):ExternalAssetProof|null=>row.object_key===undefined||row.object_key===null?null:{objectKey:String(row.object_key),size:Number(row.byte_length),digest:asset.digest,version:String(row.object_version),etag:String(row.etag)};
  const deploymentLookup = (appId: string, key: string) => db.prepare("SELECT data FROM ota_deployments WHERE owner_id=? AND app_id=? AND request_key=?").bind(owner, appId, key);
  async function readAsset(appId: string, assetId: string, published: boolean): Promise<StoredOTAAsset | null> {
    applicationId(appId); const hash = assetDigest(assetId); await verify();
    if (published) {
      const committed = await db.prepare("SELECT 1 AS ok FROM ota_deployment_assets r JOIN ota_deployments d ON d.owner_id=r.owner_id AND d.app_id=r.app_id AND d.id=r.deployment_id WHERE r.owner_id=? AND r.app_id=? AND r.hash=? LIMIT 1").bind(owner, appId, hash).first();
      if (!committed) return null;
    }
    const row = await assetLookup(appId, hash).first<Row>(); if (!row) return null;
    const asset=value<OTAAsset>(row),proof=externalProof(row,asset);if(proof){ensure(externalAssets,"PROVIDER_UNCONFIGURED");return {asset,bytes:await externalAssets.get(asset,proof)};}
    const bytes = new Uint8Array(Number(row.byte_length)); let offset = 0;
    // A query reads one <=512KiB chunk, never a multi-megabyte aggregated row.
    for (let index = 0; index < Number(row.chunk_count); index++) {
      const chunk = await db.prepare("SELECT content_base64,byte_length FROM ota_asset_chunks WHERE owner_id=? AND app_id=? AND hash=? AND chunk_index=?").bind(owner, appId, hash, index).first<Row>();
      ensure(chunk, "CONFLICT"); const binary = atob(String(chunk.content_base64)); ensure(binary.length === Number(chunk.byte_length), "CONFLICT");
      bytes.set(Uint8Array.from(binary, c => c.charCodeAt(0)), offset); offset += binary.length;
    }
    ensure(offset === bytes.length, "CONFLICT"); return { asset: value<OTAAsset>(row), bytes };
  }
  async function preparePublication(input: OTADeployment, rollback: boolean): Promise<D1PreparedPublication> {
      object(input, ["id", "appId", "createdAt", "requestKey", "detectionId", "commitSha", "channel", "runtimeVersion", "platform", "launchAssetId", "assetIds", "launchAsset", "assets", ...(rollback ? ["rollback"] : [])]);
      if (rollback) parseOTARollbackMetadata(input.rollback);
      let deployment = owned(input); await app(deployment.appId); text(deployment.id, 96); text(deployment.requestKey, 256); integer(deployment.createdAt);
      ensure(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(deployment.id));
      text(deployment.channel, 128); text(deployment.runtimeVersion, 256); ensure(deployment.platform === "ios" || deployment.platform === "android");
      ensure(deployment.assetIds.length <= OTA_MAX_ASSETS && new Set([deployment.launchAssetId, ...deployment.assetIds]).size === deployment.assetIds.length + 1);
      parseOTAPublishInput({ requestKey: deployment.requestKey, detectionId: deployment.detectionId, commitSha: deployment.commitSha, channel: deployment.channel, runtimeVersion: deployment.runtimeVersion, platform: deployment.platform, launchAssetId: deployment.launchAssetId, assetIds: deployment.assetIds });
      const lookup = () => deploymentLookup(deployment.appId, deployment.requestKey);
      const check = (row: Row) => {
        const saved = value<OTADeployment>(row); const comparable = (v: OTADeployment) => ({ ...v, id: "", createdAt: 0, ...(v.rollback ? { rollback: { ...v.rollback, requestedAt: 0 } } : {}) });
        ensure(canonicalJson(comparable(saved)) === canonicalJson(comparable(deployment)), "IDEMPOTENCY_CONFLICT"); return saved;
      };
      const existing = await lookup().first<Row>();
      if (existing) { const receipt = check(existing); return { existing: receipt, statements: [], readReceipt: () => receipt }; }
      const detectionRow = await detectionLookup(deployment.appId, deployment.detectionId).first<Row>(); ensure(detectionRow, "NOT_FOUND");
      const detection = value<GitHubDetection>(detectionRow);
      if (rollback) {
        const [source, target] = await Promise.all([store.getOTADeployment(deployment.appId, deployment.rollback!.fromDeploymentId), store.getOTADeployment(deployment.appId, deployment.rollback!.targetDeploymentId)]);
        assertOTARollbackDeployment(deployment, source, target);
        const latest = await store.getLatestOTADeployment(deployment.appId, { channel: deployment.channel, runtimeVersion: deployment.runtimeVersion, platform: deployment.platform });
        ensure(latest?.id === source!.id, "CONFIG_CONFLICT");
      } else {
        const current = await connectionLookup(deployment.appId).first<Row>();
        assertDetectionCanPublish(detection, { requestKey: deployment.requestKey, detectionId: deployment.detectionId, commitSha: deployment.commitSha,
          channel: deployment.channel, runtimeVersion: deployment.runtimeVersion, platform: deployment.platform, launchAssetId: deployment.launchAssetId, assetIds: deployment.assetIds },
          current ? value<GitHubConnection>(current) : null);
      }
      ensure(deployment.createdAt >= detection.detectedAt);
      ensure(Array.isArray(deployment.assets));
      const assets = [deployment.launchAsset, ...deployment.assets]; const assetIds = [deployment.launchAssetId, ...deployment.assetIds];
      ensure(assets.length === assetIds.length);
      const storedAssets = await db.prepare("SELECT data FROM ota_assets WHERE owner_id=? AND app_id=? AND hash IN(SELECT substr(value,7) FROM json_each(?)) LIMIT 128").bind(owner, deployment.appId,canonicalJson(assetIds)).all<Row>();
      const byId = new Map(storedAssets.results.map(row => { const asset = value<OTAAsset>(row); return [asset.id, asset] as const; }));
      for (let index = 0; index < assets.length; index++) {
        const asset = assets[index]!; ensure(asset.appId === deployment.appId && asset.id === assetIds[index], "INVALID_RELATION");
        ensure(asset.createdAt <= deployment.createdAt);
        const saved = byId.get(asset.id); ensure(saved, "NOT_FOUND");
        ensure(canonicalJson(saved) === canonicalJson(asset), "CONFLICT");
      }
      const latest = await db.prepare("SELECT max(created_at) AS latest FROM ota_deployments WHERE owner_id=? AND app_id=? AND channel=? AND runtime_version=? AND platform=?")
        .bind(owner, deployment.appId, deployment.channel, deployment.runtimeVersion, deployment.platform).first<Row>();
      const createdAt = Math.max(deployment.createdAt, latest?.latest === null || latest?.latest === undefined ? 0 : Number(latest.latest) + 1);
      ensure(Number.isSafeInteger(createdAt), "CONFLICT");
      deployment = owned({ ...deployment, createdAt });
      const fields = [owner, deployment.appId, deployment.id, deployment.requestKey, deployment.channel, deployment.runtimeVersion, deployment.platform, deployment.createdAt, canonicalJson(deployment)];
      const statements = [insert("ota_deployments", ["owner_id", "app_id", "id", "request_key", "channel", "runtime_version", "platform", "created_at", "data"], fields,
        "WHERE NOT EXISTS(SELECT 1 FROM ota_deployments WHERE owner_id=? AND app_id=? AND request_key=?)" + (rollback ? " AND (SELECT id FROM ota_deployments WHERE owner_id=? AND app_id=? AND channel=? AND runtime_version=? AND platform=? ORDER BY created_at DESC,rowid DESC LIMIT 1)=?" : ""),
        [owner, deployment.appId, deployment.requestKey, ...(rollback ? [owner, deployment.appId, deployment.channel, deployment.runtimeVersion, deployment.platform, deployment.rollback!.fromDeploymentId] : [])])];
      // One statement inserts all references; triggers validate and charge each row.
      statements.push(db.prepare(`INSERT INTO ota_deployment_assets(owner_id,app_id,deployment_id,hash,stored_bytes)
        SELECT ?,?,?,json_extract(value,'$.digest'),length(CAST(json_array(?,?,?,json_extract(value,'$.digest')) AS BLOB))
        FROM json_each(?) WHERE EXISTS(SELECT 1 FROM ota_deployments WHERE owner_id=? AND app_id=? AND id=?)
        AND NOT EXISTS(SELECT 1 FROM ota_deployment_assets WHERE owner_id=? AND app_id=? AND deployment_id=? AND hash=json_extract(value,'$.digest'))`)
        .bind(owner, deployment.appId, deployment.id, owner, deployment.appId, deployment.id, canonicalJson(assets), owner, deployment.appId, deployment.id, owner, deployment.appId, deployment.id));
      statements.push(lookup());
      return { existing: null, statements, readReceipt(results) { const row = results.at(-1)?.results[0]; ensure(row, rollback ? "CONFIG_CONFLICT" : "CONFLICT"); return check(row); } };

  }
  const store: D1OperationsStore = {
    externalAssets:!!externalAssets,
    async getGitHubConnection(appId) { applicationId(appId); await verify(); const row = await connectionLookup(appId).first<Row>(); return row ? value<GitHubConnection>(row) : null; },
    async saveGitHubConnection(appId, input, now) {
      const update = parseGitHubConnectionUpdate(input); await app(appId); integer(update.expectedVersion, 0, Number.MAX_SAFE_INTEGER - 1); integer(now);
      const current = await connectionLookup(appId).first<Row>();
      ensure((current ? value<GitHubConnection>(current).version : 0) === update.expectedVersion, "CONFLICT");
      ensure(!current || now >= value<GitHubConnection>(current).connectedAt);
      integer(update.installationId, 1); text(update.owner, 100); text(update.repository, 100); text(update.ref, 256);
      const connection: GitHubConnection = owned({ appId, version: update.expectedVersion + 1, installationId: update.installationId,
        owner: update.owner, repository: update.repository, ref: update.ref, connectedAt: now });
      const fields = [owner, appId, connection.version, canonicalJson(connection)];
      const results = await submit([insert("github_connections", ["owner_id", "app_id", "version", "data"], fields,
        "WHERE coalesce((SELECT max(version) FROM github_connections WHERE owner_id=? AND app_id=?),0)=? AND NOT EXISTS(SELECT 1 FROM github_connections WHERE owner_id=? AND app_id=? AND json_extract(data,'$.connectedAt')>?)", [owner, appId, update.expectedVersion, owner, appId, now]), connectionLookup(appId)]);
      ensure((results[0]?.meta.changes ?? 0) > 0, "CONFLICT"); const row = results[1]?.results[0]; ensure(row, "CONFLICT"); return value<GitHubConnection>(row);
    },
    async saveGitHubDetection(input) {
      const detection = parseGitHubDetection(input); const application = await app(detection.appId);
      ensure(detection.rootDirectory === application.rootDirectory, "INVALID_RELATION");
      const current = await connectionLookup(detection.appId).first<Row>();
      ensure(current && canonicalJson(value(current)) === canonicalJson(detection.connection), "CONFLICT");
      ensure(detection.detectedAt >= detection.connection.connectedAt);
      const lookup = () => detectionLookup(detection.appId, detection.id);
      const existing = await lookup().first<Row>();
      const check = (row: Row) => { ensure(canonicalJson(value(row)) === canonicalJson(detection), "IDEMPOTENCY_CONFLICT"); return value<GitHubDetection>(row); };
      if (existing) return check(existing);
      const fields = [owner, detection.appId, detection.id, detection.detectedAt, canonicalJson(detection)];
      const results = await submit([insert("github_detections", ["owner_id", "app_id", "id", "created_at", "data"], fields,
        "WHERE NOT EXISTS(SELECT 1 FROM github_detections WHERE owner_id=? AND app_id=? AND id=?)", [owner, detection.appId, detection.id]), lookup()]);
      const row = results[1]?.results[0]; ensure(row, "CONFLICT"); return check(row);
    },
    async listGitHubDetections(appId) { applicationId(appId); await verify(); const rows = await db.prepare("SELECT data FROM github_detections WHERE owner_id=? AND app_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100").bind(owner, appId).all<Row>(); return rows.results.map(row => value<GitHubDetection>(row)); },
    async getGitHubDetection(appId, detectionId) { applicationId(appId); await verify(); id(detectionId); const row = await detectionLookup(appId, detectionId).first<Row>(); return row ? value<GitHubDetection>(row) : null; },
    async saveOTAAsset(input, bytes) {
      const prepared = await store.prepareOTAAsset(input, bytes);
      if (prepared.existing) return prepared.existing;
      return prepared.readAsset(await submit(prepared.statements));
    },
    async prepareOTAAsset(input, suppliedBytes, registeredScope = false, bytesOwned = false) {
      const asset = parseOTAAsset(input); ensure(suppliedBytes instanceof Uint8Array && suppliedBytes.length <= OTA_ASSET_MAX_BYTES, "INPUT_TOO_LARGE");
      const bytes = bytesOwned ? suppliedBytes : suppliedBytes.slice(); if (!registeredScope) await app(asset.appId);
      await assertOTAAssetBytes(asset, bytes);
      const hash = assetDigest(asset.id);
      const existing = await assetLookup(asset.appId, hash).first<Row>();
      const check = (row: Row) => {
        const saved = value<OTAAsset>(row);
        ensure(saved.digest === asset.digest && saved.contentType === asset.contentType && saved.fileExtension === asset.fileExtension
          && saved.size === asset.size && saved.hash === asset.hash && saved.key === asset.key, "IDEMPOTENCY_CONFLICT"); return saved;
      };
      if (existing) { const asset = check(existing),proof=externalProof(existing,asset);if(proof){ensure(externalAssets,"PROVIDER_UNCONFIGURED");await externalAssets.get(asset,proof);}return { existing: asset, statements: [], readAsset: () => asset }; }
      const chunkCount = Math.ceil(bytes.length / CHUNK_BYTES);
      const metadata = [owner, asset.appId, hash, bytes.length, asset.contentType, chunkCount, canonicalJson(asset)];
      if(externalAssets){
        const proof=await externalAssets.put(asset,bytes);beforeCommit();ensure(proof.digest===hash&&proof.size===bytes.length,"INVALID_RELATION");
        const fields=[owner,asset.appId,hash,proof.objectKey,proof.size,proof.version,proof.etag],charged=charge(fields);ensure(charged<=2048,"INPUT_TOO_LARGE");
        const statements=[db.prepare("INSERT INTO ota_external_assets(owner_id,app_id,hash,object_key,byte_length,object_version,etag,stored_bytes) SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM ota_external_assets WHERE owner_id=? AND app_id=? AND hash=?)").bind(...fields,charged,owner,asset.appId,hash),
          insert("ota_assets",["owner_id","app_id","hash","byte_length","content_type","chunk_count","data"],metadata,"WHERE NOT EXISTS(SELECT 1 FROM ota_assets WHERE owner_id=? AND app_id=? AND hash=?)",[owner,asset.appId,hash]),assetLookup(asset.appId,hash)];
        return {existing:null,statements,readAsset(results){const row=results.at(-1)?.results[0];ensure(row,"CONFLICT");const saved=check(row),persisted=externalProof(row,saved);ensure(persisted&&persisted.objectKey===proof.objectKey&&persisted.digest===proof.digest&&persisted.size===proof.size,"IDEMPOTENCY_CONFLICT");return saved;}};
      }
      const statements = [insert("ota_assets", ["owner_id", "app_id", "hash", "byte_length", "content_type", "chunk_count", "data"], metadata,
        "WHERE NOT EXISTS(SELECT 1 FROM ota_assets WHERE owner_id=? AND app_id=? AND hash=?)", [owner, asset.appId, hash])];
      // Pair bounded rows in one query: each row stays <=512KiB raw and the
      // two base64 bindings together remain below D1's 2MiB query limit.
      for (let index = 0; index < chunkCount; index += 2) {
        const queries: string[] = [], bindings: (string | number)[] = [];
        for (let offset = index; offset < Math.min(index + 2, chunkCount); offset++) {
          const chunk = bytes.subarray(offset * CHUNK_BYTES, (offset + 1) * CHUNK_BYTES);
          const fields = [owner, asset.appId, hash, offset, base64(chunk), chunk.length];
          queries.push("SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM ota_asset_chunks WHERE owner_id=? AND app_id=? AND hash=? AND chunk_index=?)");
          bindings.push(...fields, charge(fields), owner, asset.appId, hash, offset);
        }
        statements.push(db.prepare("INSERT INTO ota_asset_chunks(owner_id,app_id,hash,chunk_index,content_base64,byte_length,stored_bytes) " + queries.join(" UNION ALL ")).bind(...bindings));
      }
      statements.push(assetLookup(asset.appId, hash));
      return { existing: null, statements, readAsset(results) { const row = results.at(-1)?.results[0]; ensure(row, "CONFLICT"); return check(row); } };
    },
    async listOTAAssets(appId,assetIds) { applicationId(appId);if(assetIds)ensure(Array.isArray(assetIds)&&assetIds.length<=128&&new Set(assetIds).size===assetIds.length);await verify();const hashes=assetIds?.map(assetDigest);const rows = await db.prepare("SELECT data FROM ota_assets WHERE owner_id=? AND app_id=?"+(hashes?" AND hash IN(SELECT value FROM json_each(?))":"")+" ORDER BY hash LIMIT 128").bind(owner,appId,...(hashes?[canonicalJson(hashes)]:[])).all<Row>();return rows.results.map(row=>value<OTAAsset>(row)); },
    getOTAAsset: (appId, assetId) => readAsset(appId, assetId, false),
    getPublishedOTAAsset: (appId, assetId) => readAsset(appId, assetId, true),
    async saveOTADeployment(input) {
      const prepared = await store.prepareOTADeployment(input);
      if (prepared.existing) return prepared.existing;
      return prepared.readReceipt(await submit(prepared.statements));
    },
    prepareOTADeployment: input => preparePublication(input, false),
    async saveOTARollback(input) {
      const prepared = await preparePublication(input, true);
      if (prepared.existing) return prepared.existing;
      return prepared.readReceipt(await submit(prepared.statements));
    },
    async getOTADeployment(appId, deploymentId) {
      applicationId(appId); otaDeploymentId(deploymentId); await verify();
      const row = await db.prepare("SELECT data FROM ota_deployments WHERE owner_id=? AND app_id=? AND id=?").bind(owner, appId, deploymentId).first<Row>();
      return row ? value<OTADeployment>(row) : null;
    },
    async getOTADeploymentForRequest(appId, requestKey) {
      applicationId(appId); id(requestKey); await verify();
      const row = await deploymentLookup(appId, requestKey).first<Row>(); return row ? value<OTADeployment>(row) : null;
    },
    async listOTADeployments(appId) { applicationId(appId); await verify(); const rows = await db.prepare("SELECT data FROM ota_deployments WHERE owner_id=? AND app_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100").bind(owner, appId).all<Row>(); return rows.results.map(row => value<OTADeployment>(row)); },
    async getLatestOTADeployment(appId, selection) {
      parseOTASelection(selection);
      applicationId(appId); await verify(); text(selection.channel, 128); text(selection.runtimeVersion, 256); ensure(selection.platform === "ios" || selection.platform === "android");
      const row = await db.prepare("SELECT data FROM ota_deployments WHERE owner_id=? AND app_id=? AND channel=? AND runtime_version=? AND platform=? ORDER BY created_at DESC,rowid DESC LIMIT 1")
        .bind(owner, appId, selection.channel, selection.runtimeVersion, selection.platform).first<Row>(); return row ? value<OTADeployment>(row) : null;
    },
  };
  return store;
}
