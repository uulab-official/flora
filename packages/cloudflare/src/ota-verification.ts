import type { DurableObject } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";
import { canonicalJson } from "@app-ops/config";
import { digest, id, integer, object, text } from "@app-ops/core";
import type { FloraConfig } from "./contracts.js";
import { HttpFailure } from "./http.js";

type Storage = ConstructorParameters<typeof DurableObject>[0]["storage"];
type Fence = () => void;
export interface OTAVerificationSummary {
  source: "operator-verification";
  environment: "android-emulator" | "ios-simulator" | "physical-device";
  observedAt: number;
  applied: true; restarted: true; signatureVerified: true; assetsVerified: true;
  receiptDigest: string;
}
interface VerificationInput extends Omit<OTAVerificationSummary, "source"> {
  deploymentId: string; platform: "ios" | "android"; channel: string; runtimeVersion: string; commitSha: string;
}
interface Published { id: string; platform: string; channel: string; runtime_version: string; created_at: number; commit_sha: string }
const maximumRecords = 1000;
const deploymentId = (value:unknown):string => {
  if(typeof value==="string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value))return value;
  return id(value);
};
const summary = (value: VerificationInput): OTAVerificationSummary => ({ source: "operator-verification", environment: value.environment, observedAt: value.observedAt,
  applied: true, restarted: true, signatureVerified: true, assetsVerified: true, receiptDigest: value.receiptDigest });

function parseProof(input: unknown, now: number): VerificationInput {
  const value = object(input, ["deploymentId", "platform", "channel", "runtimeVersion", "commitSha", "environment", "observedAt", "applied", "restarted", "signatureVerified", "assetsVerified", "receiptDigest"]);
  deploymentId(value.deploymentId); text(value.channel,128); text(value.runtimeVersion,256); digest(value.receiptDigest); integer(now); integer(value.observedAt,0,now);
  if (!["ios","android"].includes(String(value.platform)) || typeof value.commitSha !== "string" || !/^[a-f0-9]{40}$/.test(value.commitSha)
    || !["android-emulator","ios-simulator","physical-device"].includes(String(value.environment))
    || [value.applied,value.restarted,value.signatureVerified,value.assetsVerified].some(flag=>flag!==true)) throw new HttpFailure(400,"INVALID_OTA_VERIFICATION");
  if (value.environment === "android-emulator" && value.platform !== "android" || value.environment === "ios-simulator" && value.platform !== "ios") throw new HttpFailure(400,"INVALID_OTA_VERIFICATION");
  return value as unknown as VerificationInput;
}

/** Bounded operator QA receipts, not SDK telemetry or fleet install counts.
 * D1 published history is read-only; only additive DO records are written. */
export class OTAVerificationStore {
  constructor(private readonly storage: Storage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS flora_ota_verifications (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 256), app_id TEXT NOT NULL,
      deployment_id TEXT NOT NULL, receipt_digest TEXT NOT NULL CHECK(length(receipt_digest)=64), observed_at INTEGER NOT NULL CHECK(observed_at BETWEEN 0 AND 9007199254740991),
      recorded_at INTEGER NOT NULL CHECK(recorded_at BETWEEN 0 AND 9007199254740991), data TEXT NOT NULL CHECK(json_valid(data) AND length(CAST(data AS BLOB))<=4096),
      UNIQUE(owner_id,app_id,deployment_id,receipt_digest))`);
    storage.sql.exec("CREATE INDEX IF NOT EXISTS flora_ota_verifications_latest ON flora_ota_verifications(owner_id,app_id,deployment_id,observed_at DESC,sequence DESC)");
    storage.sql.exec("CREATE TRIGGER IF NOT EXISTS flora_ota_verifications_immutable_update BEFORE UPDATE ON flora_ota_verifications BEGIN SELECT RAISE(ABORT,'immutable OTA verification'); END");
    storage.sql.exec("CREATE TRIGGER IF NOT EXISTS flora_ota_verifications_immutable_delete BEFORE DELETE ON flora_ota_verifications BEGIN SELECT RAISE(ABORT,'immutable OTA verification'); END");
    storage.sql.exec("CREATE TRIGGER IF NOT EXISTS flora_ota_verifications_immutable_replace BEFORE INSERT ON flora_ota_verifications WHEN EXISTS(SELECT 1 FROM flora_ota_verifications WHERE sequence=NEW.sequence OR (owner_id=NEW.owner_id AND app_id=NEW.app_id AND deployment_id=NEW.deployment_id AND receipt_digest=NEW.receipt_digest)) BEGIN SELECT RAISE(ABORT,'immutable OTA verification'); END");
    storage.sql.exec(`CREATE TRIGGER IF NOT EXISTS flora_ota_verifications_capacity BEFORE INSERT ON flora_ota_verifications WHEN (SELECT count(*) FROM flora_ota_verifications)>=${maximumRecords} BEGIN SELECT RAISE(ABORT,'OTA verification capacity'); END`);
  }

  async record(db: D1Database, config: FloraConfig, appId: string, input: unknown, fence: Fence, now: number): Promise<{ verification: OTAVerificationSummary; created: boolean }> {
    const value = parseProof(input,now), selectedApp = id(appId), owner = text(config.ownerId,256);
    // The singleton marker and immutable published deployment are indexed point reads.
    fence();
    const identity = await db.prepare("SELECT owner_id,origin,db_identity FROM flora_deployment WHERE singleton=1").first<{owner_id:string;origin:string;db_identity:string}>();
    fence();
    if (!identity || identity.owner_id!==owner || identity.origin!==config.origin || identity.db_identity!==config.dbIdentity) throw new HttpFailure(409,"CONFIG_CONFLICT");
    const published = await db.prepare(`SELECT d.id,d.platform,d.channel,d.runtime_version,d.created_at,json_extract(d.data,'$.commitSha') commit_sha
      FROM ota_deployments d JOIN applications a ON a.owner_id=d.owner_id AND a.id=d.app_id WHERE d.owner_id=? AND d.app_id=? AND d.id=?`).bind(owner,selectedApp,value.deploymentId).first<Published>();
    fence();
    if (!published) throw new HttpFailure(404,"NOT_FOUND");
    if (published.platform!==value.platform || published.channel!==value.channel || published.runtime_version!==value.runtimeVersion || published.commit_sha!==value.commitSha) throw new HttpFailure(409,"OTA_VERIFICATION_SCOPE_MISMATCH");
    if (!Number.isSafeInteger(published.created_at) || value.observedAt<published.created_at) throw new HttpFailure(400,"INVALID_OTA_VERIFICATION");
    const data = canonicalJson(value);
    return this.storage.transactionSync(() => {
      fence();
      const existing = this.storage.sql.exec<{data:string}>("SELECT data FROM flora_ota_verifications WHERE owner_id=? AND app_id=? AND deployment_id=? AND receipt_digest=?",owner,selectedApp,value.deploymentId,value.receiptDigest).toArray()[0];
      if (existing) {
        if (existing.data!==data) throw new HttpFailure(409,"IDEMPOTENCY_CONFLICT");
        return {verification:summary(value),created:false};
      }
      if (this.storage.sql.exec<{count:number}>("SELECT count(*) AS count FROM flora_ota_verifications").one().count>=maximumRecords) throw new HttpFailure(409,"OTA_VERIFICATION_CAPACITY");
      this.storage.sql.exec("INSERT INTO flora_ota_verifications(owner_id,app_id,deployment_id,receipt_digest,observed_at,recorded_at,data) VALUES(?,?,?,?,?,?,?)",owner,selectedApp,value.deploymentId,value.receiptDigest,value.observedAt,now,data);
      return {verification:summary(value),created:true};
    });
  }

  /** One DO query, at most200 latest-platform targets, with indexed per-target lookups. */
  latest(ownerId: string, targets: ReadonlyArray<{appId:string;deploymentId:string}>, fence: Fence): ReadonlyMap<string, OTAVerificationSummary> {
    fence(); text(ownerId,256);
    if (targets.length>200) throw new HttpFailure(400,"INVALID_OTA_VERIFICATION");
    if (!targets.length) return new Map();
    for (const target of targets) { id(target.appId); deploymentId(target.deploymentId); }
    const rows = this.storage.sql.exec<{app_id:string;deployment_id:string;data:string}>(`SELECT v.app_id,v.deployment_id,v.data FROM json_each(?) t
      JOIN flora_ota_verifications v ON v.sequence=(SELECT sequence FROM flora_ota_verifications
        WHERE owner_id=? AND app_id=json_extract(t.value,'$.appId') AND deployment_id=json_extract(t.value,'$.deploymentId') ORDER BY observed_at DESC,sequence DESC LIMIT 1)`,JSON.stringify(targets),ownerId).toArray();
    fence();
    return new Map(rows.map(row=>[JSON.stringify([row.app_id,row.deployment_id]),summary(JSON.parse(row.data) as VerificationInput)]));
  }
}
