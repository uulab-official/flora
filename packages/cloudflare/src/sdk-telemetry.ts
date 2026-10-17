import type { DurableObject } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";
import { canonicalJson } from "@app-ops/config";
import { id, object, safeJson, text } from "@app-ops/core";
import { parseOTARollbackInput } from "@app-ops/dogfood";
import type { OTADeployment } from "@app-ops/dogfood";
import type { FloraConfig } from "./contracts.js";
import { HttpFailure } from "./http.js";

type Storage = ConstructorParameters<typeof DurableObject>[0]["storage"];
type Fence = () => void;
type Environment = "physical-device" | "android-emulator" | "ios-simulator" | "unknown";
type Stage = "check" | "download" | "activation" | "launch";
type EventType = "update_seen" | "downloaded" | "activation_requested" | "launch_confirmed" | "restart_confirmed" | "failed" | "rolled_back";
export const SDK_TELEMETRY_CODES = ["NETWORK_UNAVAILABLE","TIMEOUT","SIGNATURE_INVALID","ASSET_HASH_MISMATCH","UPDATE_INCOMPATIBLE","UNCONFIRMED_LAUNCH","STORED_UPDATE_INVALID","NATIVE_OPERATION_FAILED","CHECK_FAILED","DOWNLOAD_FAILED","ACTIVATION_FAILED","LAUNCH_CONFIRMATION_FAILED","UNKNOWN"] as const;
type FailureCode = typeof SDK_TELEMETRY_CODES[number];
interface Event { id:string; type:EventType; observedAt:number; stage?:Stage; code?:FailureCode }
interface SessionInput { installationId:string; deploymentId:string; platform:"ios"|"android";channel:string;runtimeVersion:string;environment:Environment }
interface Ticket extends Omit<SessionInput,"installationId"> { version:1;ownerId:string;origin:string;dbIdentity:string;appId:string;installationHash:string;publishedAt:number;isRollback?:boolean;issuedAt:number;expiresAt:number }
/** Server-minted deployment scope and newly accepted SDK assertions only.
 * Installation hashes are private DO-local identifiers, never public device IDs. */
export interface SDKTelemetryObservation {
 ownerId:string;appId:string;deploymentId:string;platform:"ios"|"android";channel:string;runtimeVersion:string;
 publishedAt:number;isRollback:boolean;installationHash:string;events:Array<Omit<Event,"id">>;
}
export type SDKTelemetryObserver = (observation:SDKTelemetryObservation,now:number)=>void;
interface Flags { downloaded:number;applied:number;restartReported:number;restarted:number;failed:number;rolledBack:number;recovered:number }
interface DetailHistory { version:1;legacy:boolean;recordedEvents:number;omittedEvents:number;startedAt:number }
interface Installation extends Flags { environment:Environment;lastReportedAt:number;firstFailureAt:number;latestConfirmedAt:number;latestRestartAt:number;detailHistory?:DetailHistory }
interface Counters { observedInstallations:number;downloadedInstallations:number;appliedInstallations:number;restartedInstallations:number;failedInstallations:number;rolledBackInstallations:number;recoveredInstallations:number;lastReportedAt:number;environments:{physicalDevice:number;androidEmulator:number;iosSimulator:number;unknown:number} }
interface Failure { stage:Stage;code:FailureCode;installations:number;lastReportedAt:number }
export interface SDKIssueResolution {unresolvedInstallations:number;resolvedInstallations:number;unknownInstallations:number;rollbackResolvedInstallations?:number}
export interface SDKIssueResolutionProof {kind:"same-deployment"|"rollback";deploymentId:string;confirmedAt:number;restartedAt:number}
export interface SDKRollbackFailure {deploymentId:string;observedAt:number;stage?:Stage;code?:FailureCode}
export interface SDKRollbackLineage {id:string;appId:string;platform:"ios"|"android";channel:string;runtimeVersion:string;createdAt:number;fromDeploymentId:string;targetDeploymentId:string;requestedAt:number;reason:string;sourceCreatedAt:number;targetCreatedAt:number}
export interface SDKRollbackChain {facts:SDKRollbackLineage[];rootId:string|null;depth:number}
const rollbackMaximumDepth=32;
/** This expression is evaluated only over immutable server publication rows. A
 * client ticket boolean or a supplied fromDeploymentId never registers lineage. */
export const sdkRollbackJoins = `LEFT JOIN ota_deployments rf ON rf.owner_id=d.owner_id AND rf.app_id=d.app_id AND rf.id=json_extract(d.data,'$.rollback.fromDeploymentId') LEFT JOIN ota_deployments rt ON rt.owner_id=d.owner_id AND rt.app_id=d.app_id AND rt.id=json_extract(d.data,'$.rollback.targetDeploymentId')`;
export const sdkRollbackProjection = `CASE WHEN json_type(d.data,'$.rollback')='object' AND rf.id IS NOT NULL AND rt.id IS NOT NULL AND rf.id<>rt.id AND rt.created_at<rf.created_at AND rf.created_at<d.created_at AND rf.platform=d.platform AND rt.platform=d.platform AND rf.channel=d.channel AND rt.channel=d.channel AND rf.runtime_version=d.runtime_version AND rt.runtime_version=d.runtime_version THEN json_object('id',d.id,'appId',d.app_id,'platform',d.platform,'channel',d.channel,'runtimeVersion',d.runtime_version,'createdAt',d.created_at,'fromDeploymentId',rf.id,'targetDeploymentId',rt.id,'sourceCreatedAt',rf.created_at,'targetCreatedAt',rt.created_at,'reason',json_extract(d.data,'$.rollback.reason'),'requestedAt',json_extract(d.data,'$.rollback.requestedAt')) ELSE NULL END`;
/** Correlated immutable publication chain. Each edge repeats the complete
 * owner/app/platform/channel/runtime/chronology proof; an invalid or missing
 * ancestor and chains over 32 edges have no authoritative root. This is part
 * of an existing D1 statement, never an SDK-controlled traversal request. */
export function sdkRollbackChainProjection(alias:string):string {
 const fact=sdkRollbackProjection.replace(/\bd\./g,"cd.").replace(/\brf\./g,"cf.").replace(/\brt\./g,"ct."),joins=sdkRollbackJoins.replace(/\bd\./g,"cd.").replace(/\brf\b/g,"cf").replace(/\brt\b/g,"ct");
 return `(WITH RECURSIVE sdk_chain(depth,id,source_id,is_rollback,rollback_lineage) AS (
 SELECT 0,cd.id,cf.id,CASE WHEN json_type(cd.data,'$.rollback') IS NULL THEN 0 ELSE 1 END,${fact} FROM ota_deployments cd ${joins} WHERE cd.owner_id=${alias}.owner_id AND cd.app_id=${alias}.app_id AND cd.id=${alias}.id
 UNION ALL SELECT c.depth+1,cd.id,cf.id,CASE WHEN json_type(cd.data,'$.rollback') IS NULL THEN 0 ELSE 1 END,${fact} FROM sdk_chain c JOIN ota_deployments cd ON cd.owner_id=${alias}.owner_id AND cd.app_id=${alias}.app_id AND cd.id=c.source_id ${joins} WHERE c.rollback_lineage IS NOT NULL AND c.depth<${rollbackMaximumDepth}
 ) SELECT json_object('facts',json_group_array(json(rollback_lineage)) FILTER(WHERE rollback_lineage IS NOT NULL),'rootId',MAX(CASE WHEN is_rollback=0 THEN id END),'depth',MAX(depth)) FROM sdk_chain)`;
}
type IssueState = {latest_failure_at:number;unknown_until:number|null;status:"unresolved"|"resolved"}
export interface SDKTelemetrySummary extends Counters { issueResolution:SDKIssueResolution;source:"sdk-self-report";applicationRate:number|null;failures:Failure[] }
export interface SDKInstallationDetail {
 id:string;label:string;environment:Environment;automaticRollbackEligible?:boolean;downloaded:boolean;applied:boolean;restarted:boolean;failed:boolean;rolledBack:boolean;recovered:boolean;
 issueStatus:"none"|"unresolved"|"resolved";issueOrderKnown:boolean;issueResolution?:SDKIssueResolutionProof;rollbackFailure?:SDKRollbackFailure;lastReportedAt:number;firstFailureAt:number|null;latestConfirmedAt:number|null;latestRestartAt:number|null;
 history:{complete:boolean;reason:"legacy"|"capacity"|null;recordedEvents:number;omittedEvents:number;startedAt:number|null};failures:Array<{stage:Stage;code:FailureCode}>;
}
interface DetailDeployment {id:string;platform:"ios"|"android";channel:string;runtimeVersion:string;createdAt:number;commitSha:string|null;rollback?:NonNullable<OTADeployment["rollback"]>}
interface DetailBase {appId:string;deploymentId:string;deployment:DetailDeployment;source:"sdk-self-report";observedAt:number;nextCursor:string|null;pageSize:20}
export interface SDKInstallationPage extends DetailBase {filter?:"issues"|"unresolved"|"resolved";summary:SDKTelemetrySummary|null;installations:SDKInstallationDetail[]}
export interface SDKEventPage extends DetailBase {installation:SDKInstallationDetail;events:Array<{type:EventType;observedAt:number;receivedAt:number;stage?:Stage;code?:FailureCode}>}
type JourneyHistoryReason="legacy"|"capacity"|"missing"|"lineage";
interface JourneyHistory {complete:boolean;reason:"legacy"|"capacity"|"missing"|null;recordedEvents:number;omittedEvents:number;startedAt:number|null}
export interface SDKJourneyPage {
 appId:string;deploymentId:string;rootDeploymentId:string|null;source:"sdk-self-report";observedAt:number;pageSize:20;nextCursor:string|null;
 installation:{id:string;label:string;environment:Environment};deployments:Array<DetailDeployment&{history:JourneyHistory}>;
 history:{complete:boolean;reasons:JourneyHistoryReason[]};entries:Array<{id:string;kind:"publication";deploymentId:string;observedAt:number}|{id:string;kind:"sdk-event";deploymentId:string;type:EventType;observedAt:number;receivedAt:number;stage?:Stage;code?:FailureCode}>;
}
/** Check redundant publication JSON against its authoritative indexed columns.
 * Old publication records may omit those redundant fields. */
function journeyMetadataPredicate(alias:string):string {
 return [["id","id"],["appId","app_id"],["platform","platform"],["channel","channel"],["runtimeVersion","runtime_version"],["createdAt","created_at"]].map(([field,column])=>`(json_type(${alias}.data,'$.${field}') IS NULL OR json_extract(${alias}.data,'$.${field}')=${alias}.${column})`).join(" AND ");
}
function journeyPublicationProjection(alias:string):string {
 const lineage=sdkRollbackProjection.replace(/\bd\./g,alias+".");
 return `json_object('id',${alias}.id,'platform',${alias}.platform,'channel',${alias}.channel,'runtimeVersion',${alias}.runtime_version,'createdAt',${alias}.created_at,'commitSha',json_extract(${alias}.data,'$.commitSha'),'validMetadata',CASE WHEN ${journeyMetadataPredicate(alias)} THEN 1 ELSE 0 END,'rollbackPresent',CASE WHEN json_type(${alias}.data,'$.rollback') IS NULL THEN 0 ELSE 1 END,'rollbackFrom',json_extract(${alias}.data,'$.rollback.fromDeploymentId'),'lineage',json(CASE WHEN ${journeyMetadataPredicate(alias)} AND ${journeyMetadataPredicate("rf")} AND ${journeyMetadataPredicate("rt")} THEN ${lineage} ELSE NULL END))`;
}
const detailPageSize=20,journalMaximum=50_000,installationJournalMaximum=256;
const hour=3_600_000, lifetime=7*86_400_000, skew=120_000;
const uuidPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const events:readonly string[]=["update_seen","downloaded","activation_requested","launch_confirmed","restart_confirmed","failed","rolled_back"];
const stages:readonly string[]=["check","download","activation","launch"];
const environments:readonly string[]=["physical-device","android-emulator","ios-simulator","unknown"];
const encoder=new TextEncoder(),decoder=new TextDecoder("utf-8",{fatal:true,ignoreBOM:false});
const invalid=():never=>{throw new HttpFailure(400,"INVALID_SDK_TELEMETRY");};
const denied=():never=>{throw new HttpFailure(401,"SDK_TELEMETRY_TOKEN_INVALID");};
const integer=(v:unknown):v is number=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0;
function uuid(v:unknown):string {if(typeof v!=="string"||!uuidPattern.test(v))return invalid();return v;}
function boundedBody(input:unknown):void {safeJson(input);if(encoder.encode(JSON.stringify(input)).byteLength>8192)invalid();}
function b64(bytes:Uint8Array):string {return btoa(String.fromCharCode(...bytes)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");}
function un64(value:string):Uint8Array<ArrayBuffer> {if(!/^[A-Za-z0-9_-]+$/.test(value)||value.length%4===1)throw new Error("Invalid encoding");const raw=atob(value.replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-value.length%4)%4));const result=Uint8Array.from(raw,c=>c.charCodeAt(0));if(b64(result)!==value)throw new Error("Invalid encoding");return result;}
function parseSession(input:unknown):SessionInput {
 boundedBody(input);const value=object(input,["installationId","deploymentId","platform","channel","runtimeVersion","environment"]);
 uuid(value.installationId);uuid(value.deploymentId);text(value.channel,128);text(value.runtimeVersion,256);
 if(typeof value.platform!=="string"||typeof value.environment!=="string"||!["ios","android"].includes(value.platform)||!environments.includes(value.environment)||value.platform==="ios"&&value.environment==="android-emulator"||value.platform==="android"&&value.environment==="ios-simulator")invalid();
 return value as unknown as SessionInput;
}
function parseEvents(input:unknown,now:number,ticket:Ticket):{token:string;events:Event[]} {
 boundedBody(input);const value=object(input,["token","events"]);text(value.token,4096);
 const rawEvents=value.events;if(!Array.isArray(rawEvents))return invalid();if(rawEvents.length<1||rawEvents.length>16)invalid();
 const parsed=rawEvents.map((raw:unknown)=>{
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return invalid();const item=raw as Record<string,unknown>;
  const failure=item.type==="failed"||item.type==="rolled_back";
  object(item,failure?["id","type","observedAt","stage","code"]:["id","type","observedAt"]);uuid(item.id);
  // Device and publication clocks may differ by the same bounded skew used
  // for future reports. Preserve the device timestamp in the event journal.
  if(typeof item.type!=="string"||!events.includes(item.type)||!integer(item.observedAt)||item.observedAt<Math.max(0,ticket.publishedAt-skew)||item.observedAt<now-lifetime||item.observedAt>now+skew||failure&&(typeof item.stage!=="string"||typeof item.code!=="string"||!stages.includes(item.stage)||!SDK_TELEMETRY_CODES.includes(item.code as FailureCode)))invalid();
  return item as unknown as Event;
 });return {token:value.token as string,events:parsed};
}
function emptyCounters():Counters {return {observedInstallations:0,downloadedInstallations:0,appliedInstallations:0,restartedInstallations:0,failedInstallations:0,rolledBackInstallations:0,recoveredInstallations:0,lastReportedAt:0,environments:{physicalDevice:0,androidEmulator:0,iosSimulator:0,unknown:0}};}
function normalizeInstallation(value:Installation):Installation {
 // Older flags do not establish event order. Zero means unknown: never derive
 // a failure/confirmation timestamp from lastReportedAt or historical booleans.
 return {...value,recovered:value.recovered===1?1:0,firstFailureAt:integer(value.firstFailureAt)?value.firstFailureAt:0,latestConfirmedAt:integer(value.latestConfirmedAt)?value.latestConfirmedAt:0,latestRestartAt:integer(value.latestRestartAt)?value.latestRestartAt:0};
}
function normalizeCounters(value:Counters):Counters {return {...value,recoveredInstallations:integer(value.recoveredInstallations)?value.recoveredInstallations:0};}
function environmentKey(value:Environment):keyof Counters["environments"] {return value==="physical-device"?"physicalDevice":value==="android-emulator"?"androidEmulator":value==="ios-simulator"?"iosSimulator":"unknown";}

/** Anonymous SDK assertions, never native proof or update authority. Only additive,
 * bounded pseudonymous telemetry is stored in the existing DO; D1 is read-only. */
export class SDKTelemetryStore {
 private key:Promise<CryptoKey>|undefined;
 private detailKey:Promise<CryptoKey>|undefined;
 private issueResolutionReady=false;
 private rollbackResolutionReady=false;
 constructor(private readonly storage:Storage,private readonly observeAccepted?:SDKTelemetryObserver) {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS flora_sdk_telemetry_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS flora_sdk_telemetry_installations(owner_id TEXT NOT NULL,app_id TEXT NOT NULL,deployment_id TEXT NOT NULL,installation_hash TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(owner_id,app_id,deployment_id,installation_hash));
   CREATE INDEX IF NOT EXISTS flora_sdk_telemetry_installations_issues ON flora_sdk_telemetry_installations(owner_id,app_id,deployment_id,installation_hash) WHERE json_extract(data,'$.failed')=1 OR json_extract(data,'$.rolledBack')=1;
   CREATE TABLE IF NOT EXISTS flora_sdk_telemetry_aggregates(owner_id TEXT NOT NULL,app_id TEXT NOT NULL,deployment_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(owner_id,app_id,deployment_id));
   CREATE TABLE IF NOT EXISTS flora_sdk_telemetry_events(event_hash TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,expires_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS flora_sdk_telemetry_events_expiry ON flora_sdk_telemetry_events(expires_at);
   CREATE TABLE IF NOT EXISTS flora_sdk_telemetry_failures(owner_id TEXT NOT NULL,app_id TEXT NOT NULL,deployment_id TEXT NOT NULL,stage TEXT NOT NULL,code TEXT NOT NULL,installations INTEGER NOT NULL,last_reported_at INTEGER NOT NULL,PRIMARY KEY(owner_id,app_id,deployment_id,stage,code));
   CREATE TABLE IF NOT EXISTS flora_sdk_telemetry_installation_failures(owner_id TEXT NOT NULL,app_id TEXT NOT NULL,deployment_id TEXT NOT NULL,installation_hash TEXT NOT NULL,stage TEXT NOT NULL,code TEXT NOT NULL,PRIMARY KEY(owner_id,app_id,deployment_id,installation_hash,stage,code));
   CREATE TABLE IF NOT EXISTS flora_sdk_telemetry_buckets(bucket_hash TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS flora_sdk_telemetry_buckets_expiry ON flora_sdk_telemetry_buckets(expires_at);
   CREATE TABLE IF NOT EXISTS flora_sdk_telemetry_journal(event_hash TEXT PRIMARY KEY,owner_id TEXT NOT NULL,app_id TEXT NOT NULL,deployment_id TEXT NOT NULL,installation_hash TEXT NOT NULL,observed_at INTEGER NOT NULL,received_at INTEGER NOT NULL,type TEXT NOT NULL,stage TEXT,code TEXT);
   CREATE INDEX IF NOT EXISTS flora_sdk_telemetry_journal_page ON flora_sdk_telemetry_journal(owner_id,app_id,deployment_id,installation_hash,observed_at DESC,event_hash DESC);
   CREATE TABLE IF NOT EXISTS flora_sdk_telemetry_issue_state(owner_id TEXT NOT NULL,app_id TEXT NOT NULL,deployment_id TEXT NOT NULL,installation_hash TEXT NOT NULL,latest_failure_at INTEGER NOT NULL,unknown_until INTEGER,status TEXT NOT NULL CHECK(status IN ('unresolved','resolved')),PRIMARY KEY(owner_id,app_id,deployment_id,installation_hash));
   CREATE INDEX IF NOT EXISTS flora_sdk_telemetry_issue_state_page ON flora_sdk_telemetry_issue_state(owner_id,app_id,deployment_id,status,installation_hash);
   CREATE TABLE IF NOT EXISTS flora_sdk_telemetry_issue_aggregates(owner_id TEXT NOT NULL,app_id TEXT NOT NULL,deployment_id TEXT NOT NULL,unresolved INTEGER NOT NULL,resolved INTEGER NOT NULL,unknown INTEGER NOT NULL,PRIMARY KEY(owner_id,app_id,deployment_id));
   CREATE TABLE IF NOT EXISTS flora_sdk_telemetry_rollback_lineage(owner_id TEXT NOT NULL,app_id TEXT NOT NULL,deployment_id TEXT NOT NULL,source_id TEXT NOT NULL,target_id TEXT NOT NULL,created_at INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(owner_id,app_id,deployment_id));
   CREATE INDEX IF NOT EXISTS flora_sdk_telemetry_rollback_source ON flora_sdk_telemetry_rollback_lineage(owner_id,app_id,source_id,created_at DESC,deployment_id);
   CREATE TABLE IF NOT EXISTS flora_sdk_telemetry_resolution_proof(owner_id TEXT NOT NULL,app_id TEXT NOT NULL,deployment_id TEXT NOT NULL,installation_hash TEXT NOT NULL,kind TEXT NOT NULL,resolution_id TEXT NOT NULL,confirmed_at INTEGER NOT NULL,restarted_at INTEGER NOT NULL,PRIMARY KEY(owner_id,app_id,deployment_id,installation_hash));
   CREATE TABLE IF NOT EXISTS flora_sdk_telemetry_rollback_issue_aggregates(owner_id TEXT NOT NULL,app_id TEXT NOT NULL,deployment_id TEXT NOT NULL,resolved INTEGER NOT NULL,PRIMARY KEY(owner_id,app_id,deployment_id));`);
  if(!storage.sql.exec<{value:string}>("SELECT value FROM flora_sdk_telemetry_meta WHERE key='secret'").toArray().length)
   storage.sql.exec("INSERT OR IGNORE INTO flora_sdk_telemetry_meta(key,value) VALUES('secret',?)",b64(crypto.getRandomValues(new Uint8Array(32))));
 }
 /** Once-only, bounded additive backfill. Original installation JSON, cumulative
  * counters and retained journal rows remain byte-for-byte untouched. Incomplete
  * history cannot prove which failure was last, even when recovered is sticky.
  * Its fixed upper bound can still prove a later launch AND restart. The
  * deployment failure aggregate is a bound only, never this install's failure;
  * later reports from another installation cannot reopen this resolved issue. */
 private ensureIssueResolution(fence:Fence):void {
  if(this.issueResolutionReady)return;
  fence();
  if(this.storage.sql.exec("SELECT 1 FROM flora_sdk_telemetry_meta WHERE key='issue-resolution-v1'").toArray().length){this.issueResolutionReady=true;return;}
  this.storage.transactionSync(()=>{
   fence();
   const total=this.storage.sql.exec<{total:number}>("SELECT count(*) AS total FROM flora_sdk_telemetry_installations").one().total;
   if(total>20000)throw new HttpFailure(429,"SDK_TELEMETRY_CAPACITY");
   this.storage.sql.exec(`WITH failure_bounds AS (
    SELECT owner_id,app_id,deployment_id,MAX(last_reported_at) AS deployment_failure_bound FROM flora_sdk_telemetry_failures GROUP BY owner_id,app_id,deployment_id
   ), history AS (
    SELECT i.owner_id,i.app_id,i.deployment_id,i.installation_hash,i.data,count(j.event_hash) AS recorded,
     COALESCE(MAX(CASE WHEN j.type IN ('failed','rolled_back') THEN j.observed_at END),0) AS failure_at,
     SUM(CASE WHEN j.type='failed' THEN 1 ELSE 0 END) AS failed_events,
     SUM(CASE WHEN j.type='rolled_back' THEN 1 ELSE 0 END) AS rollback_events,
     f.deployment_failure_bound
    FROM flora_sdk_telemetry_installations i LEFT JOIN failure_bounds f ON f.owner_id=i.owner_id AND f.app_id=i.app_id AND f.deployment_id=i.deployment_id LEFT JOIN flora_sdk_telemetry_journal j ON j.owner_id=i.owner_id AND j.app_id=i.app_id AND j.deployment_id=i.deployment_id AND j.installation_hash=i.installation_hash
    WHERE json_extract(i.data,'$.failed')=1 OR json_extract(i.data,'$.rolledBack')=1
    GROUP BY i.owner_id,i.app_id,i.deployment_id,i.installation_hash
   ), ordered AS (
    SELECT *,CASE WHEN json_extract(data,'$.detailHistory.version')=1 AND json_extract(data,'$.detailHistory.legacy')=0 AND json_extract(data,'$.detailHistory.omittedEvents')=0 AND json_extract(data,'$.detailHistory.recordedEvents')=recorded
     AND (COALESCE(json_extract(data,'$.failed'),0)<>1 OR failed_events>0) AND (COALESCE(json_extract(data,'$.rolledBack'),0)<>1 OR rollback_events>0) AND failed_events+rollback_events>0 THEN 1 ELSE 0 END AS known,
     CASE WHEN deployment_failure_bound>0 AND deployment_failure_bound>=COALESCE(json_extract(data,'$.firstFailureAt'),0)
      THEN MIN(deployment_failure_bound,COALESCE(json_extract(data,'$.lastReportedAt'),9007199254740991)) ELSE COALESCE(json_extract(data,'$.lastReportedAt'),9007199254740991) END AS uncertainty_bound FROM history
   ) INSERT INTO flora_sdk_telemetry_issue_state(owner_id,app_id,deployment_id,installation_hash,latest_failure_at,unknown_until,status)
   SELECT owner_id,app_id,deployment_id,installation_hash,failure_at,
    CASE WHEN known=1 THEN NULL ELSE uncertainty_bound END,
    CASE WHEN json_type(data,'$.latestConfirmedAt')='integer' AND json_type(data,'$.latestRestartAt')='integer' AND json_extract(data,'$.latestConfirmedAt')>MAX(failure_at,CASE WHEN known=1 THEN 0 ELSE uncertainty_bound END) AND json_extract(data,'$.latestRestartAt')>MAX(failure_at,CASE WHEN known=1 THEN 0 ELSE uncertainty_bound END) THEN 'resolved' ELSE 'unresolved' END FROM ordered`);
   this.storage.sql.exec(`INSERT INTO flora_sdk_telemetry_issue_aggregates(owner_id,app_id,deployment_id,unresolved,resolved,unknown)
    SELECT owner_id,app_id,deployment_id,SUM(status='unresolved'),SUM(status='resolved'),SUM(status='unresolved' AND unknown_until IS NOT NULL)
    FROM flora_sdk_telemetry_issue_state GROUP BY owner_id,app_id,deployment_id`);
   this.storage.sql.exec("INSERT INTO flora_sdk_telemetry_meta(key,value) VALUES('issue-resolution-v1','1')");
   this.storage.sql.exec("DELETE FROM flora_sdk_telemetry_meta WHERE key='rollback-resolution-v2'");
   fence();
  });
  this.issueResolutionReady=true;this.rollbackResolutionReady=false;
 }
 private ensureRollbackResolution(fence:Fence):void {
  if(this.rollbackResolutionReady)return;
  this.ensureIssueResolution(fence);fence();
  if(!this.storage.sql.exec("SELECT 1 FROM flora_sdk_telemetry_meta WHERE key='rollback-resolution-v2'").toArray().length)this.storage.transactionSync(()=>{
   const issues=this.storage.sql.exec<{owner_id:string;app_id:string;deployment_id:string;installation_hash:string}>("SELECT owner_id,app_id,deployment_id,installation_hash FROM flora_sdk_telemetry_issue_state ORDER BY owner_id,app_id,deployment_id,installation_hash LIMIT 20001").toArray();
   if(issues.length>20000)throw new HttpFailure(429,"SDK_TELEMETRY_CAPACITY");
   for(const issue of issues)this.reconcileIssue([issue.owner_id,issue.app_id,issue.deployment_id,issue.installation_hash]);
   this.storage.sql.exec("INSERT INTO flora_sdk_telemetry_meta(key,value) VALUES('rollback-resolution-v2','1')");fence();
  });
  this.rollbackResolutionReady=true;
 }
 private updateIssueResolution(bind:readonly string[],previous:Installation,state:Installation,newEvents:ReadonlyArray<{event:Event}>):void {
  if(state.failed!==1&&state.rolledBack!==1)return;
  const old=this.storage.sql.exec<IssueState>("SELECT latest_failure_at,unknown_until,status FROM flora_sdk_telemetry_issue_state WHERE owner_id=? AND app_id=? AND deployment_id=? AND installation_hash=?",...bind).toArray()[0];
  // A row missing after migration can only be a newly observed issue. Retain a
  // conservative upper bound if an older pre-projection payload ever appears.
  const current:IssueState=old?{...old}:{latest_failure_at:0,unknown_until:previous.failed===1||previous.rolledBack===1?previous.lastReportedAt:null,status:"unresolved"};
  for(const {event} of newEvents)if(event.type==="failed"||event.type==="rolled_back"){
   current.latest_failure_at=Math.max(current.latest_failure_at,event.observedAt);
   if(current.unknown_until!==null&&event.observedAt>=current.unknown_until)current.unknown_until=null;
  }
  const failureBound=Math.max(current.latest_failure_at,current.unknown_until??0);
  current.status=state.latestConfirmedAt>failureBound&&state.latestRestartAt>failureBound?"resolved":"unresolved";
  if(old&&old.latest_failure_at===current.latest_failure_at&&old.unknown_until===current.unknown_until&&old.status===current.status)return;
  this.storage.sql.exec("INSERT INTO flora_sdk_telemetry_issue_state(owner_id,app_id,deployment_id,installation_hash,latest_failure_at,unknown_until,status) VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_id,app_id,deployment_id,installation_hash) DO UPDATE SET latest_failure_at=excluded.latest_failure_at,unknown_until=excluded.unknown_until,status=excluded.status",...bind,current.latest_failure_at,current.unknown_until,current.status);
  const unresolved=Number(current.status==="unresolved")-Number(old?.status==="unresolved"),resolved=Number(current.status==="resolved")-Number(old?.status==="resolved"),unknown=Number(current.status==="unresolved"&&current.unknown_until!==null)-Number(old?.status==="unresolved"&&old.unknown_until!==null);
  if(unresolved||resolved||unknown)this.storage.sql.exec("INSERT INTO flora_sdk_telemetry_issue_aggregates(owner_id,app_id,deployment_id,unresolved,resolved,unknown) VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,app_id,deployment_id) DO UPDATE SET unresolved=unresolved+excluded.unresolved,resolved=resolved+excluded.resolved,unknown=unknown+excluded.unknown",...bind.slice(0,3),unresolved,resolved,unknown);
 }
 /** Register only facts already proven by the D1 three-publication join above.
  * New facts reconcile existing reports once, without replaying SDK assertions. */
 registerRollbackLineages(ownerId:string,values:ReadonlyArray<SDKRollbackLineage>,fence:Fence):void {
  fence();text(ownerId,256);if(values.length>2000)throw new HttpFailure(429,"SDK_TELEMETRY_CAPACITY");
  if(!values.length)return;
  const rows=values.map(value=>{
   id(value.appId);uuid(value.id);uuid(value.fromDeploymentId);uuid(value.targetDeploymentId);
   const parsed=parseOTARollbackInput({requestKey:"rollback_link",fromDeploymentId:value.fromDeploymentId,targetDeploymentId:value.targetDeploymentId,reason:value.reason});
   if(!["ios","android"].includes(value.platform)||!value.channel||value.channel.length>128||!value.runtimeVersion||value.runtimeVersion.length>256||![value.createdAt,value.sourceCreatedAt,value.targetCreatedAt,value.requestedAt].every(integer)||value.targetCreatedAt>=value.sourceCreatedAt||value.sourceCreatedAt>=value.createdAt||value.requestedAt>value.createdAt||parsed.fromDeploymentId===value.id||parsed.targetDeploymentId===value.id||parsed.fromDeploymentId===parsed.targetDeploymentId)throw new HttpFailure(409,"CONFIG_CONFLICT");
   return value;
  });
  this.ensureRollbackResolution(fence);
  this.storage.transactionSync(()=>{
   fence();
   for(const value of rows){
    const bind=[ownerId,value.appId,value.id],data=canonicalJson(value);
    const old=this.storage.sql.exec<{data:string}>("SELECT data FROM flora_sdk_telemetry_rollback_lineage WHERE owner_id=? AND app_id=? AND deployment_id=?",...bind).toArray()[0];
    if(old){if(old.data!==data)throw new HttpFailure(409,"CONFIG_CONFLICT");continue;}
    this.reserve("rollback-lineage-count",1,2000);
    this.storage.sql.exec("INSERT INTO flora_sdk_telemetry_rollback_lineage(owner_id,app_id,deployment_id,source_id,target_id,created_at,data) VALUES(?,?,?,?,?,?,?)",...bind,value.fromDeploymentId,value.targetDeploymentId,value.createdAt,data);
    const ancestors=this.rollbackAncestors(ownerId,value.appId,value.id).map(row=>row.source_id);
    const issues=this.storage.sql.exec<{deployment_id:string;installation_hash:string}>("SELECT s.deployment_id,s.installation_hash FROM json_each(?) p JOIN flora_sdk_telemetry_issue_state s ON s.owner_id=? AND s.app_id=? AND s.deployment_id=p.value ORDER BY s.deployment_id,s.installation_hash LIMIT 20001",JSON.stringify(ancestors),ownerId,value.appId).toArray();
    if(issues.length>20000)throw new HttpFailure(429,"SDK_TELEMETRY_CAPACITY");
    for(const issue of issues)this.reconcileIssue([ownerId,value.appId,issue.deployment_id,issue.installation_hash]);
   }
   fence();
  });
 }
 /** One bounded, app-indexed immutable fact read when its existing 20-row
  * operations watermark changes. Persistent watermark survives DO eviction. */
 async synchronizeRollbackHistory(db:D1Database,config:FloraConfig,appId:string,deployments:ReadonlyArray<{id:string;createdAt:number}>,fence:Fence):Promise<void> {
  fence();id(appId);if(deployments.length>20)invalid();
  const key="rollback-history-v1:"+canonicalJson([config.ownerId,appId]),watermark=canonicalJson(["transitive-v2",deployments.map(value=>[value.id,value.createdAt])]);
  if(this.storage.sql.exec<{value:string}>("SELECT value FROM flora_sdk_telemetry_meta WHERE key=?",key).toArray()[0]?.value===watermark)return;
  const result=await db.prepare(`SELECT ${sdkRollbackProjection} AS rollback_lineage FROM ota_deployments d ${sdkRollbackJoins} WHERE d.owner_id=? AND d.app_id=? AND json_type(d.data,'$.rollback')='object' ORDER BY d.created_at DESC,d.id LIMIT 2001`).bind(config.ownerId,appId).all<{rollback_lineage:string|null}>();fence();
  if(!result.success||result.results.length>2000)throw new HttpFailure(429,"SDK_TELEMETRY_CAPACITY");
  const lineages=result.results.filter(row=>row.rollback_lineage!==null).map(row=>JSON.parse(row.rollback_lineage!) as SDKRollbackLineage);
  this.ensureRollbackResolution(fence);
  this.storage.transactionSync(()=>{fence();this.registerRollbackLineages(config.ownerId,lineages,fence);this.storage.sql.exec("INSERT INTO flora_sdk_telemetry_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",key,watermark);fence();});
 }
 private rollbackAncestors(ownerId:string,appId:string,deploymentId:string):Array<{source_id:string;depth:number}> {
  // There are at most 2,000 verified facts in this owner store. Invalidation
  // follows that hard bound even when a chain is too deep to prove recovery,
  // so a failure beyond depth 32 cannot leave an older root proof standing.
  return this.storage.sql.exec<{source_id:string;depth:number}>(`WITH RECURSIVE ancestors(source_id,created_at,depth) AS (
   SELECT source_id,created_at,1 FROM flora_sdk_telemetry_rollback_lineage WHERE owner_id=? AND app_id=? AND deployment_id=?
   UNION ALL SELECT l.source_id,l.created_at,a.depth+1 FROM ancestors a JOIN flora_sdk_telemetry_rollback_lineage l ON l.owner_id=? AND l.app_id=? AND l.deployment_id=a.source_id AND l.created_at<a.created_at WHERE a.depth<2000
  ) SELECT source_id,depth FROM ancestors`,ownerId,appId,deploymentId,ownerId,appId).toArray();
 }
 private rollbackDescendants(bind:readonly string[]):Array<{deployment_id:string;depth:number;created_at:number;data:string|null;latest_failure_at:number|null;unknown_until:number|null}> {
  return this.storage.sql.exec<{deployment_id:string;depth:number;created_at:number;data:string|null;latest_failure_at:number|null;unknown_until:number|null}>(`WITH RECURSIVE descendants(deployment_id,created_at,depth) AS (
   SELECT deployment_id,created_at,1 FROM flora_sdk_telemetry_rollback_lineage WHERE owner_id=? AND app_id=? AND source_id=?
   UNION ALL SELECT l.deployment_id,l.created_at,d.depth+1 FROM descendants d JOIN flora_sdk_telemetry_rollback_lineage l ON l.owner_id=? AND l.app_id=? AND l.source_id=d.deployment_id AND l.created_at>d.created_at WHERE d.depth<=${rollbackMaximumDepth}
  ) SELECT d.deployment_id,d.depth,d.created_at,i.data,s.latest_failure_at,s.unknown_until FROM descendants d LEFT JOIN flora_sdk_telemetry_installations i ON i.owner_id=? AND i.app_id=? AND i.deployment_id=d.deployment_id AND i.installation_hash=? LEFT JOIN flora_sdk_telemetry_issue_state s ON s.owner_id=i.owner_id AND s.app_id=i.app_id AND s.deployment_id=i.deployment_id AND s.installation_hash=i.installation_hash WHERE i.installation_hash IS NOT NULL OR d.depth>${rollbackMaximumDepth} ORDER BY d.created_at DESC,d.deployment_id LIMIT 2001`,...bind.slice(0,3),...bind.slice(0,2),...bind.slice(0,2),bind[3]!).toArray();
 }
 private reconcileIssue(bind:readonly string[]):void {
  const issue=this.storage.sql.exec<IssueState>("SELECT latest_failure_at,unknown_until,status FROM flora_sdk_telemetry_issue_state WHERE owner_id=? AND app_id=? AND deployment_id=? AND installation_hash=?",...bind).toArray()[0];
  if(!issue)return;
  const row=this.storage.sql.exec<{data:string}>("SELECT data FROM flora_sdk_telemetry_installations WHERE owner_id=? AND app_id=? AND deployment_id=? AND installation_hash=?",...bind).toArray()[0];
  if(!row)return;
  const state=normalizeInstallation(JSON.parse(row.data) as Installation),bound=Math.max(issue.latest_failure_at,issue.unknown_until??0);
  const oldProof=this.storage.sql.exec<{kind:string}>("SELECT kind FROM flora_sdk_telemetry_resolution_proof WHERE owner_id=? AND app_id=? AND deployment_id=? AND installation_hash=?",...bind).toArray()[0];
  let proof:SDKIssueResolutionProof|undefined;
  const candidates=this.rollbackDescendants(bind);
  if(candidates.length>2000)throw new HttpFailure(429,"SDK_TELEMETRY_CAPACITY");
  const tooDeep=candidates.some(candidate=>candidate.depth>rollbackMaximumDepth),states=candidates.filter(candidate=>candidate.data!==null).map(candidate=>({candidate,state:normalizeInstallation(JSON.parse(candidate.data!) as Installation)}));
   // A later failure on another rollback attempt for this same source/device
   // invalidates an older successful proof too. Fresh confirmations may prove
   // the fallback healthy, but stale success cannot hide the new failure.
  const relatedFailureBound=states.reduce((latest,{candidate,state:rollback})=>Math.max(latest,candidate.latest_failure_at===null&&(rollback.failed||rollback.rolledBack)?rollback.lastReportedAt:Math.max(candidate.latest_failure_at??0,candidate.unknown_until??0)),bound);
  if(!tooDeep&&state.latestConfirmedAt>relatedFailureBound&&state.latestRestartAt>relatedFailureBound)proof={kind:"same-deployment",deploymentId:bind[2]!,confirmedAt:state.latestConfirmedAt,restartedAt:state.latestRestartAt};
  else if(!tooDeep){
   for(const {candidate,state:rollback} of states){
    const causalBound=Math.max(relatedFailureBound,candidate.created_at);
    if(rollback.latestConfirmedAt>causalBound&&rollback.latestRestartAt>causalBound){proof={kind:"rollback",deploymentId:candidate.deployment_id,confirmedAt:rollback.latestConfirmedAt,restartedAt:rollback.latestRestartAt};break;}
   }
  }
  const status=proof?"resolved":"unresolved",unresolved=Number(status==="unresolved")-Number(issue.status==="unresolved"),resolved=-unresolved,unknown=Number(status==="unresolved"&&issue.unknown_until!==null)-Number(issue.status==="unresolved"&&issue.unknown_until!==null);
  if(status!==issue.status){
   this.storage.sql.exec("UPDATE flora_sdk_telemetry_issue_state SET status=? WHERE owner_id=? AND app_id=? AND deployment_id=? AND installation_hash=?",status,...bind);
   this.storage.sql.exec("UPDATE flora_sdk_telemetry_issue_aggregates SET unresolved=unresolved+?,resolved=resolved+?,unknown=unknown+? WHERE owner_id=? AND app_id=? AND deployment_id=?",unresolved,resolved,unknown,...bind.slice(0,3));
  }
  const delta=Number(proof?.kind==="rollback")-Number(oldProof?.kind==="rollback");
  if(delta)this.storage.sql.exec("INSERT INTO flora_sdk_telemetry_rollback_issue_aggregates(owner_id,app_id,deployment_id,resolved) VALUES(?,?,?,?) ON CONFLICT(owner_id,app_id,deployment_id) DO UPDATE SET resolved=resolved+excluded.resolved",...bind.slice(0,3),delta);
  if(proof)this.storage.sql.exec("INSERT INTO flora_sdk_telemetry_resolution_proof(owner_id,app_id,deployment_id,installation_hash,kind,resolution_id,confirmed_at,restarted_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,app_id,deployment_id,installation_hash) DO UPDATE SET kind=excluded.kind,resolution_id=excluded.resolution_id,confirmed_at=excluded.confirmed_at,restarted_at=excluded.restarted_at",...bind,proof.kind,proof.deploymentId,proof.confirmedAt,proof.restartedAt);
  else if(oldProof)this.storage.sql.exec("DELETE FROM flora_sdk_telemetry_resolution_proof WHERE owner_id=? AND app_id=? AND deployment_id=? AND installation_hash=?",...bind);
 }
 private reconcileRelatedIssues(bind:readonly string[]):void {
  this.reconcileIssue(bind);
  for(const original of this.rollbackAncestors(bind[0]!,bind[1]!,bind[2]!))this.reconcileIssue([bind[0]!,bind[1]!,original.source_id,bind[3]!]);
 }
 private async cryptoKey(fence:Fence):Promise<CryptoKey> {
  fence();if(!this.key){const secret=this.storage.sql.exec<{value:string}>("SELECT value FROM flora_sdk_telemetry_meta WHERE key='secret'").one().value;this.key=crypto.subtle.importKey("raw",un64(secret),{name:"HMAC",hash:"SHA-256"},false,["sign","verify"]);}
  const key=await this.key;fence();return key;
 }
 private async hash(key:CryptoKey,value:string,fence:Fence):Promise<string> {const result=await crypto.subtle.sign("HMAC",key,encoder.encode(value));fence();return b64(new Uint8Array(result));}
 private reserve(key:string,amount:number,maximum:number):void {
  const row=this.storage.sql.exec<{value:string}>("SELECT value FROM flora_sdk_telemetry_meta WHERE key=?",key).toArray()[0];const count=Number(row?.value??0);
  if(!Number.isSafeInteger(count)||count+amount>maximum)throw new HttpFailure(429,"SDK_TELEMETRY_CAPACITY");
  this.storage.sql.exec("INSERT INTO flora_sdk_telemetry_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",key,String(count+amount));
 }
 private admit(buckets:ReadonlyArray<{hash:string;limit:number;amount:number;expiresAt:number}>,now:number):void {
  // Expiring rate counters are not deployment/report history. Prune once an hour.
  const slot=Math.floor(now/hour);const old=this.storage.sql.exec<{value:string}>("SELECT value FROM flora_sdk_telemetry_meta WHERE key='bucket-slot'").toArray()[0];
  if(old?.value!==String(slot)){
   const removed=this.storage.sql.exec<{bucket_hash:string}>("DELETE FROM flora_sdk_telemetry_buckets WHERE expires_at<=? RETURNING bucket_hash",now).toArray().length;
   if(removed)this.reserve("bucket-count",-removed,25000);
   // Event IDs are a replay cache, not report history. A timestamp older than
   // seven days is always rejected, including with a freshly issued ticket.
   // Keep the equality boundary: events expiring exactly now still deduplicate.
   const expired=this.storage.sql.exec<{event_hash:string}>("DELETE FROM flora_sdk_telemetry_events WHERE expires_at<? RETURNING event_hash",now).toArray().length;
   if(expired)this.reserve("event-count",-expired,100000);
   this.storage.sql.exec("INSERT INTO flora_sdk_telemetry_meta(key,value) VALUES('bucket-slot',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(slot));
  }
  for(const bucket of buckets){const row=this.storage.sql.exec<{count:number}>("SELECT count FROM flora_sdk_telemetry_buckets WHERE bucket_hash=?",bucket.hash).toArray()[0];
   if((row?.count??0)+bucket.amount>bucket.limit)throw new HttpFailure(429,"SDK_TELEMETRY_RATE_LIMITED");
   if(!row)this.reserve("bucket-count",1,25000);
   this.storage.sql.exec("INSERT INTO flora_sdk_telemetry_buckets(bucket_hash,count,expires_at) VALUES(?,?,?) ON CONFLICT(bucket_hash) DO UPDATE SET count=count+excluded.count",bucket.hash,bucket.amount,bucket.expiresAt);
  }
 }
 private async buckets(key:CryptoKey,kind:"session"|"report",ip:string,installation:string,now:number,amount:number,fence:Fence):Promise<Array<{hash:string;limit:number;amount:number;expiresAt:number}>> {
  // The raw provider IP exists only during this call; HMAC changes each hour.
  const address=typeof ip==="string"&&ip.length<=128?ip.trim():"unknown";const slot=Math.floor(now/hour);
  const values=kind==="session"?[["global",1000],["ip:"+address,60],["installation:"+installation,6]] as const:[["global",10000],["ip:"+address,600],["installation:"+installation,64]] as const;
  const result=[];for(const [bucket,limit]of values)result.push({hash:await this.hash(key,canonicalJson(["rate",kind,slot,bucket]),fence),limit,amount,expiresAt:(slot+1)*hour});
  // These independent daily bounds protect the shared free DO write allowance;
  // hourly/IP limits alone would permit continual anonymous quota exhaustion.
  const day=Math.floor(now/86_400_000),expiresAt=(day+1)*86_400_000;
  result.push({hash:await this.hash(key,canonicalJson(["daily",kind,day]),fence),limit:kind==="session"?1000:5000,amount,expiresAt});
  if(kind==="report")result.push({hash:await this.hash(key,canonicalJson(["daily-requests",kind,day]),fence),limit:1000,amount:1,expiresAt});
  return result;
 }

 async session(db:D1Database,config:FloraConfig,appId:string,input:unknown,fence:Fence,now:number,ip:string):Promise<{token:string;expiresAt:number}> {
  if(!integer(now))invalid();const value=parseSession(input),app=id(appId),owner=text(config.ownerId,256);fence();
  const key=await this.cryptoKey(fence);const installationHash=await this.hash(key,canonicalJson(["installation",owner,config.origin,config.dbIdentity,app,value.installationId]),fence);
  const buckets=await this.buckets(key,"session",ip,installationHash,now,1,fence);
  // Admission is durable before indexed D1 reads, including rejected guesses.
  this.storage.transactionSync(()=>{fence();this.admit(buckets,now);});
  const identity=await db.prepare("SELECT owner_id,origin,db_identity FROM flora_deployment WHERE singleton=1").first<{owner_id:string;origin:string;db_identity:string}>();fence();
  if(!identity||identity.owner_id!==owner||identity.origin!==config.origin||identity.db_identity!==config.dbIdentity)throw new HttpFailure(409,"CONFIG_CONFLICT");
  const published=await db.prepare(`SELECT d.platform,d.channel,d.runtime_version,d.created_at,CASE WHEN json_type(d.data,'$.rollback') IS NULL THEN 0 ELSE 1 END AS is_rollback,CASE WHEN json_type(d.data,'$.rollback') IS NOT NULL THEN ${sdkRollbackChainProjection("d")} ELSE NULL END AS rollback_chain FROM ota_deployments d JOIN applications a ON a.owner_id=d.owner_id AND a.id=d.app_id WHERE d.owner_id=? AND d.app_id=? AND d.id=?`).bind(owner,app,value.deploymentId).first<{platform:string;channel:string;runtime_version:string;created_at:number;is_rollback:number;rollback_chain:string|null}>();fence();
  if(!published)throw new HttpFailure(404,"NOT_FOUND");
  if(published.platform!==value.platform||published.channel!==value.channel||published.runtime_version!==value.runtimeVersion)throw new HttpFailure(409,"SDK_TELEMETRY_SCOPE_MISMATCH");
  if(!integer(published.created_at)||published.created_at>now)throw new HttpFailure(409,"SDK_TELEMETRY_SCOPE_MISMATCH");
  if(published.rollback_chain)this.registerRollbackLineages(owner,(JSON.parse(published.rollback_chain) as SDKRollbackChain).facts,fence);
  const ticket:Ticket={version:1,ownerId:owner,origin:config.origin,dbIdentity:config.dbIdentity,appId:app,installationHash,deploymentId:value.deploymentId,platform:value.platform,channel:value.channel,runtimeVersion:value.runtimeVersion,environment:value.environment,publishedAt:published.created_at,isRollback:published.is_rollback!==0,issuedAt:now,expiresAt:now+lifetime};
  const payload=b64(encoder.encode(canonicalJson(ticket))),signature=await this.hash(key,"v1."+payload,fence);fence();return {token:"v1."+payload+"."+signature,expiresAt:ticket.expiresAt};
 }
 private async ticket(config:FloraConfig,appId:string,token:unknown,now:number,key:CryptoKey,fence:Fence):Promise<Ticket> {
  if(typeof token!=="string"||token.length>4096)return denied();const pieces=token.split(".");if(pieces.length!==3||pieces[0]!=="v1")return denied();
  let signature:Uint8Array<ArrayBuffer>,ticket:Ticket;
  try {signature=un64(pieces[2]!);if(signature.length!==32)return denied();ticket=JSON.parse(decoder.decode(un64(pieces[1]!))) as Ticket;}catch{return denied();}
  const verified=await crypto.subtle.verify("HMAC",key,signature,encoder.encode("v1."+pieces[1]));fence();if(!verified)return denied();
  // Only locally minted, current deployment/config-scoped tickets can reach SQL.
  if(ticket.isRollback!==undefined&&typeof ticket.isRollback!=="boolean")return denied();
  if(ticket.version!==1||ticket.ownerId!==config.ownerId||ticket.origin!==config.origin||ticket.dbIdentity!==config.dbIdentity||ticket.appId!==appId||!integer(ticket.issuedAt)||!integer(ticket.expiresAt)||ticket.expiresAt-ticket.issuedAt!==lifetime||ticket.issuedAt>now+skew||ticket.expiresAt<=now)return denied();
  return ticket;
 }
 async report(config:FloraConfig,appId:string,input:unknown,fence:Fence,now:number,ip:string):Promise<{accepted:number;duplicates:number;acknowledged:string[]}> {
  if(!integer(now))invalid();boundedBody(input);const raw=object(input,["token","events"]);id(appId);fence();const key=await this.cryptoKey(fence);
  const ticket=await this.ticket(config,appId,raw.token,now,key,fence),value=parseEvents(input,now,ticket);
  const buckets=await this.buckets(key,"report",ip,ticket.installationHash,now,value.events.length,fence);
  const prepared:Array<{event:Event;hash:string;payload:string}>=[];for(const event of value.events)prepared.push({event,hash:await this.hash(key,canonicalJson(["event",ticket.ownerId,ticket.dbIdentity,appId,ticket.deploymentId,ticket.installationHash,event.id]),fence),payload:await this.hash(key,canonicalJson(event),fence)});
  this.ensureRollbackResolution(fence);
  return this.storage.transactionSync(()=>{
   fence();this.admit(buckets,now);const bind=[ticket.ownerId,appId,ticket.deploymentId,ticket.installationHash];
   const row=this.storage.sql.exec<{data:string}>("SELECT data FROM flora_sdk_telemetry_installations WHERE owner_id=? AND app_id=? AND deployment_id=? AND installation_hash=?",...bind).toArray()[0];
   const previous:Installation=row?normalizeInstallation(JSON.parse(row.data) as Installation):{downloaded:0,applied:0,restartReported:0,restarted:0,failed:0,rolledBack:0,recovered:0,environment:ticket.environment,lastReportedAt:0,firstFailureAt:0,latestConfirmedAt:0,latestRestartAt:0};
   // A formerly unavailable detector may classify an existing installation.
   // An older unknown ticket cannot erase that classification.
   if(previous.environment!==ticket.environment&&previous.environment!=="unknown"&&ticket.environment!=="unknown")throw new HttpFailure(409,"SDK_TELEMETRY_SCOPE_MISMATCH");
   const environmentUpgrade=!!row&&previous.environment==="unknown"&&ticket.environment!=="unknown";
   const state={...previous,environment:environmentUpgrade?ticket.environment:previous.environment};let duplicates=0;const failures=new Map<string,{stage:Stage;code:FailureCode;lastReportedAt:number}>();
   const existingEvents=this.storage.sql.exec<{event_hash:string;payload_hash:string}>("SELECT e.event_hash,e.payload_hash FROM json_each(?) p JOIN flora_sdk_telemetry_events e ON e.event_hash=json_extract(p.value,'$.hash')",JSON.stringify(prepared.map(item=>({hash:item.hash})))).toArray();
   const known=new Map(existingEvents.map(event=>[event.event_hash,event.payload_hash]));const newEvents=[];
   for(const item of prepared){const existing=known.get(item.hash);if(existing!==undefined){if(existing!==item.payload)throw new HttpFailure(409,"SDK_TELEMETRY_EVENT_CONFLICT");duplicates++;continue;}known.set(item.hash,item.payload);newEvents.push(item);}
   const accepted=newEvents.length;
   if(!accepted&&!environmentUpgrade)return {accepted,duplicates,acknowledged:value.events.map(event=>event.id)};
   this.reserve("event-count",accepted,100000);
   this.storage.sql.exec("INSERT INTO flora_sdk_telemetry_events(event_hash,payload_hash,expires_at) SELECT json_extract(value,'$.hash'),json_extract(value,'$.payload'),json_extract(value,'$.expiresAt') FROM json_each(?)",JSON.stringify(newEvents.map(item=>({hash:item.hash,payload:item.payload,expiresAt:item.event.observedAt+lifetime}))));
   // This additive journal contains only accepted safe SDK assertions. The older
   // replay cache stores hashes, so it cannot be backfilled into invented events.
   // A full detail budget never rejects a report or discards existing history.
   const detailHistory:DetailHistory=previous.detailHistory?{...previous.detailHistory}:{version:1,legacy:!!row,recordedEvents:0,omittedEvents:0,startedAt:row?0:now};
   const journalCount=Number(this.storage.sql.exec<{value:string}>("SELECT value FROM flora_sdk_telemetry_meta WHERE key='journal-count'").toArray()[0]?.value??0);
   const available=Number.isSafeInteger(journalCount)&&journalCount>=0?Math.max(0,Math.min(journalMaximum-journalCount,installationJournalMaximum-detailHistory.recordedEvents)):0;
   const journalEvents=newEvents.slice(0,available);
   if(journalEvents.length){
    this.storage.sql.exec("INSERT INTO flora_sdk_telemetry_journal(event_hash,owner_id,app_id,deployment_id,installation_hash,observed_at,received_at,type,stage,code) SELECT json_extract(value,'$.hash'),?,?,?, ?,json_extract(value,'$.observedAt'),?,json_extract(value,'$.type'),json_extract(value,'$.stage'),json_extract(value,'$.code') FROM json_each(?)",...bind,now,JSON.stringify(journalEvents.map(item=>({hash:item.hash,...item.event,id:undefined}))));
    this.storage.sql.exec("INSERT INTO flora_sdk_telemetry_meta(key,value) VALUES('journal-count',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(journalCount+journalEvents.length));
   }
   detailHistory.recordedEvents+=journalEvents.length;detailHistory.omittedEvents+=accepted-journalEvents.length;state.detailHistory=detailHistory;
   for(const item of newEvents){
    state.lastReportedAt=Math.max(state.lastReportedAt,item.event.observedAt);
    if(item.event.type==="downloaded")state.downloaded=1;
    if(item.event.type==="launch_confirmed"){state.applied=1;state.latestConfirmedAt=Math.max(state.latestConfirmedAt,item.event.observedAt);}
    if(item.event.type==="restart_confirmed"){state.restartReported=1;state.latestRestartAt=Math.max(state.latestRestartAt,item.event.observedAt);}
    if(item.event.type==="failed"||item.event.type==="rolled_back"){
     if(item.event.type==="failed")state.failed=1;else state.rolledBack=1;
     state.firstFailureAt=state.firstFailureAt===0?item.event.observedAt:Math.min(state.firstFailureAt,item.event.observedAt);
     const stage=item.event.stage!,code=item.event.code!,failureKey=JSON.stringify([stage,code]);
     failures.set(failureKey,{stage,code,lastReportedAt:Math.max(failures.get(failureKey)?.lastReportedAt??0,item.event.observedAt)});
    }
   }
   state.restarted=state.applied&&state.restartReported?1:0;
   this.updateIssueResolution(bind,previous,state,newEvents);
   // Cumulative reported recovery, independent of event arrival order. Both
   // successful launch and restart must be strictly later than a known failure.
   if(state.firstFailureAt>0&&state.latestConfirmedAt>state.firstFailureAt&&state.latestRestartAt>state.firstFailureAt)state.recovered=1;
   const target=[ticket.ownerId,appId,ticket.deploymentId];
   const aggregateRow=this.storage.sql.exec<{data:string}>("SELECT data FROM flora_sdk_telemetry_aggregates WHERE owner_id=? AND app_id=? AND deployment_id=?",...target).toArray()[0];
   const aggregate:Counters=aggregateRow?normalizeCounters(JSON.parse(aggregateRow.data) as Counters):emptyCounters();
   if(!row){this.reserve("installation-count",1,20000);aggregate.observedInstallations++;aggregate.environments[environmentKey(state.environment)]++;}
   if(environmentUpgrade){aggregate.environments.unknown--;aggregate.environments[environmentKey(state.environment)]++;}
   if(!aggregateRow)this.reserve("deployment-count",1,2000);
   aggregate.downloadedInstallations+=state.downloaded-previous.downloaded;aggregate.appliedInstallations+=state.applied-previous.applied;aggregate.restartedInstallations+=state.restarted-previous.restarted;
   aggregate.failedInstallations+=state.failed-previous.failed;aggregate.rolledBackInstallations+=state.rolledBack-previous.rolledBack;aggregate.recoveredInstallations+=state.recovered-previous.recovered;aggregate.lastReportedAt=Math.max(aggregate.lastReportedAt,state.lastReportedAt);
   this.storage.sql.exec("INSERT INTO flora_sdk_telemetry_installations(owner_id,app_id,deployment_id,installation_hash,data) VALUES(?,?,?,?,?) ON CONFLICT(owner_id,app_id,deployment_id,installation_hash) DO UPDATE SET data=excluded.data",...bind,canonicalJson(state));
   this.reconcileRelatedIssues(bind);
   this.storage.sql.exec("INSERT INTO flora_sdk_telemetry_aggregates(owner_id,app_id,deployment_id,data) VALUES(?,?,?,?) ON CONFLICT(owner_id,app_id,deployment_id) DO UPDATE SET data=excluded.data",...target,canonicalJson(aggregate));
   for(const failure of failures.values()){
    const failureBind=[...bind,failure.stage,failure.code];const exists=this.storage.sql.exec("SELECT 1 FROM flora_sdk_telemetry_installation_failures WHERE owner_id=? AND app_id=? AND deployment_id=? AND installation_hash=? AND stage=? AND code=?",...failureBind).toArray().length;
    if(!exists){this.reserve("failure-count",1,100000);this.storage.sql.exec("INSERT INTO flora_sdk_telemetry_installation_failures(owner_id,app_id,deployment_id,installation_hash,stage,code) VALUES(?,?,?,?,?,?)",...failureBind);}
    this.storage.sql.exec("INSERT INTO flora_sdk_telemetry_failures(owner_id,app_id,deployment_id,stage,code,installations,last_reported_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_id,app_id,deployment_id,stage,code) DO UPDATE SET installations=installations+?,last_reported_at=MAX(last_reported_at,excluded.last_reported_at)",...target,failure.stage,failure.code,exists?0:1,failure.lastReportedAt,exists?0:1);
   }
   // Old signed tickets lack authoritative rollback provenance. Keep accepting
   // their telemetry, but never infer automatic update authority from absence.
   // The observer writes its durable intent in this same transaction; a throw
   // rolls back aggregation and replay hashes so a retried report is still new.
   if(accepted&&typeof ticket.isRollback==="boolean")this.observeAccepted?.({ownerId:ticket.ownerId,appId,deploymentId:ticket.deploymentId,platform:ticket.platform,channel:ticket.channel,runtimeVersion:ticket.runtimeVersion,publishedAt:ticket.publishedAt,isRollback:ticket.isRollback,installationHash:ticket.installationHash,events:newEvents.map(({event:{id:_id,...event}})=>event)},now);
   fence();return {accepted,duplicates,acknowledged:value.events.map(event=>event.id)};
  });
 }

 private async detailCrypto(fence:Fence):Promise<CryptoKey> {
  const key=await this.cryptoKey(fence);
  // Domain-separated encryption hides the app-wide installation HMAC from URLs
  // and page cursors. No raw SDK identifier is present in stored details.
  if(!this.detailKey)this.detailKey=crypto.subtle.sign("HMAC",key,encoder.encode("flora-sdk-detail-seal-v1")).then(bytes=>crypto.subtle.importKey("raw",bytes,"AES-GCM",false,["encrypt","decrypt"]));
  const result=await this.detailKey;fence();return result;
 }
 private async sealDetail(key:CryptoKey,aad:string,value:unknown,fence:Fence,prefix:"i1"|"c1"):Promise<string> {
  const iv=crypto.getRandomValues(new Uint8Array(12)),cipher=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:encoder.encode(aad)},key,encoder.encode(canonicalJson(value))));fence();
  const result=new Uint8Array(iv.length+cipher.length);result.set(iv);result.set(cipher,iv.length);return prefix+"."+b64(result);
 }
 private async openDetail(key:CryptoKey,aad:string,value:string,fence:Fence,prefix:"i1"|"c1"):Promise<unknown> {
  let result:unknown;
  try {if(value.length>512||!value.startsWith(prefix+"."))throw new Error("Invalid detail token");const bytes=un64(value.slice(3));if(bytes.length<29)throw new Error("Invalid detail token");const payload=await crypto.subtle.decrypt({name:"AES-GCM",iv:bytes.slice(0,12),additionalData:encoder.encode(aad)},key,bytes.slice(12));result=JSON.parse(decoder.decode(payload));}
  catch {throw new HttpFailure(prefix==="i1"?404:400,prefix==="i1"?"NOT_FOUND":"INVALID_TELEMETRY_CURSOR");}
  fence();return result;
 }

 private async detailDeployment(db:D1Database,config:FloraConfig,appId:string,deploymentId:string,fence:Fence,now:number):Promise<DetailDeployment> {
  const owner=text(config.ownerId,256);
  fence();const identity=await db.prepare("SELECT owner_id,origin,db_identity FROM flora_deployment WHERE singleton=1").first<{owner_id:string;origin:string;db_identity:string}>();fence();
  if(!identity||identity.owner_id!==owner||identity.origin!==config.origin||identity.db_identity!==config.dbIdentity)throw new HttpFailure(409,"CONFIG_CONFLICT");
  const historyKey="rollback-detail-history-v1:"+canonicalJson([owner,appId]),chainHistoryKey="rollback-detail-chain-v2:"+canonicalJson([owner,appId]);
  const initializeHistory=!this.storage.sql.exec("SELECT 1 FROM flora_sdk_telemetry_meta WHERE key=?",chainHistoryKey).toArray().length;
  // First owner detail for an app hydrates already-published historical rollback
  // facts in the same indexed publication query. Subsequent pages skip this
  // bounded app scan; immutable facts and marker survive object eviction.
  const historyProjection=initializeHistory?`,(SELECT json_object('count',count(*),'facts',json_group_array(json(rollback_lineage)) FILTER (WHERE rollback_lineage IS NOT NULL)) FROM (SELECT ${sdkRollbackProjection} AS rollback_lineage FROM ota_deployments d ${sdkRollbackJoins} WHERE d.owner_id=published.owner_id AND d.app_id=published.app_id AND json_type(d.data,'$.rollback')='object' ORDER BY d.created_at DESC,d.id LIMIT 2001)) AS rollback_history`:"";
  const published=await db.prepare(`SELECT d.platform,d.channel,d.runtime_version,d.created_at,d.data,${sdkRollbackProjection} AS rollback_lineage${historyProjection} FROM ota_deployments d JOIN applications a ON a.owner_id=d.owner_id AND a.id=d.app_id JOIN ota_deployments published ON published.owner_id=d.owner_id AND published.app_id=d.app_id AND published.id=d.id ${sdkRollbackJoins} WHERE d.owner_id=? AND d.app_id=? AND d.id=?`).bind(owner,appId,deploymentId).first<{platform:string;channel:string;runtime_version:string;created_at:number;data:string;rollback_lineage:string|null;rollback_history?:string}>();fence();
  if(!published)throw new HttpFailure(404,"NOT_FOUND");
  if(!["ios","android"].includes(published.platform)||typeof published.channel!=="string"||!published.channel.length||published.channel.length>128||typeof published.runtime_version!=="string"||!published.runtime_version.length||published.runtime_version.length>256||!integer(published.created_at)||published.created_at>now)throw new HttpFailure(409,"CONFIG_CONFLICT");
  let source:Record<string,unknown>;try{source=JSON.parse(published.data) as Record<string,unknown>;if(!source||Array.isArray(source)||typeof source!=="object")throw new Error("Invalid deployment");}catch{throw new HttpFailure(409,"CONFIG_CONFLICT");}
  if(source.appId!==undefined&&source.appId!==appId||source.id!==undefined&&source.id!==deploymentId||source.platform!==undefined&&source.platform!==published.platform||source.channel!==undefined&&source.channel!==published.channel||source.runtimeVersion!==undefined&&source.runtimeVersion!==published.runtime_version||source.createdAt!==undefined&&source.createdAt!==published.created_at)throw new HttpFailure(409,"CONFIG_CONFLICT");
  const deployment:DetailDeployment={id:deploymentId,platform:published.platform as "ios"|"android",channel:published.channel,runtimeVersion:published.runtime_version,createdAt:published.created_at,commitSha:typeof source.commitSha==="string"&&/^[a-f0-9]{40}$/.test(source.commitSha)?source.commitSha:null};
  if(source.rollback!==undefined){
   try{
    const raw=object(source.rollback,["fromDeploymentId","targetDeploymentId","reason","requestedAt"]);
    const parsed=parseOTARollbackInput({requestKey:"rollback_detail",fromDeploymentId:raw.fromDeploymentId,targetDeploymentId:raw.targetDeploymentId,reason:raw.reason});
    if(!integer(raw.requestedAt)||raw.requestedAt>published.created_at||parsed.fromDeploymentId===deploymentId||parsed.targetDeploymentId===deploymentId)throw new Error("Invalid rollback");
    deployment.rollback={fromDeploymentId:parsed.fromDeploymentId,targetDeploymentId:parsed.targetDeploymentId,reason:parsed.reason,requestedAt:raw.requestedAt};
   }catch{throw new HttpFailure(409,"CONFIG_CONFLICT");}
  }
  if(initializeHistory){
   const history=JSON.parse(published.rollback_history!) as {count:number;facts:SDKRollbackLineage[]};
   if(!integer(history.count)||history.count>2000||!Array.isArray(history.facts))throw new HttpFailure(429,"SDK_TELEMETRY_CAPACITY");
   this.ensureRollbackResolution(fence);
   this.storage.transactionSync(()=>{fence();this.registerRollbackLineages(owner,history.facts,fence);this.storage.sql.exec("INSERT OR IGNORE INTO flora_sdk_telemetry_meta(key,value) VALUES(?,'1')",historyKey);this.storage.sql.exec("INSERT OR IGNORE INTO flora_sdk_telemetry_meta(key,value) VALUES(?,'1')",chainHistoryKey);fence();});
  }else if(published.rollback_lineage)this.registerRollbackLineages(owner,[JSON.parse(published.rollback_lineage) as SDKRollbackLineage],fence);
  return deployment;
 }

 /** Owner-only resolution of an existing opaque reference for explicit policy
  * enrollment. The internal installation HMAC never enters an HTTP response. */
 async resolveInstallation(db:D1Database,config:FloraConfig,appId:string,deploymentId:string,installationRef:string,fence:Fence,now:number):Promise<string> {
  fence();id(appId);uuid(deploymentId);if(!integer(now))invalid();
  const owner=text(config.ownerId,256),key=await this.detailCrypto(fence);
  const scope=canonicalJson(["sdk-detail-v1",owner,config.origin,config.dbIdentity,appId,deploymentId]);
  const installationHash=await this.openDetail(key,scope+":installation",installationRef,fence,"i1");
  if(typeof installationHash!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(installationHash))throw new HttpFailure(404,"NOT_FOUND");
  await this.detailDeployment(db,config,appId,deploymentId,fence,now);
  const found=this.storage.sql.exec("SELECT 1 FROM flora_sdk_telemetry_installations WHERE owner_id=? AND app_id=? AND deployment_id=? AND installation_hash=?",owner,appId,deploymentId,installationHash).toArray().length;
  fence();if(!found)throw new HttpFailure(404,"NOT_FOUND");return installationHash;
 }

 /** Owner-requested, snapshot-paged incident history. The existing private
  * installation reference authorizes only its exact owner/app/anchor. Every
  * publication edge is freshly validated by D1; only that installation's real
  * retained journal enters the timeline. No event/proof/counter is synthesized
  * or changed. One identity guard and one bounded indexed publication query,
  * never one D1 request per deployment or an extra project-list poll. */
 async journey(db:D1Database,config:FloraConfig,appId:string,deploymentId:string,installationRef:string,cursor:string|null,fence:Fence,now:number):Promise<SDKJourneyPage> {
  fence();id(appId);uuid(deploymentId);if(!integer(now))invalid();
  const owner=text(config.ownerId,256),key=await this.detailCrypto(fence),hmac=await this.cryptoKey(fence);
  const scope=canonicalJson(["sdk-detail-v1",owner,config.origin,config.dbIdentity,appId,deploymentId]);
  const installationHash=await this.openDetail(key,scope+":installation",installationRef,fence,"i1");
  if(typeof installationHash!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(installationHash))throw new HttpFailure(404,"NOT_FOUND");
  const journeyScope=scope+":journey-v1:"+installationHash;
  let afterTime=-1,afterKind=-1,afterDeployment="",afterHash="",snapshotAt=now,snapshotRowid:number|null=null,expectedGraph:string|null=null;
  if(cursor!==null){
   const opened=await this.openDetail(key,journeyScope,cursor,fence,"c1");
   if(!Array.isArray(opened)||opened.length!==7||!integer(opened[0])||![0,1].includes(opened[1])||typeof opened[2]!=="string"||!uuidPattern.test(opened[2])||typeof opened[3]!=="string"||(opened[1]===0?opened[3]!=="":!/^[A-Za-z0-9_-]{43}$/.test(opened[3]))||!integer(opened[4])||opened[4]>now||!integer(opened[5])||typeof opened[6]!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(opened[6]))throw new HttpFailure(400,"INVALID_TELEMETRY_CURSOR");
   [afterTime,afterKind,afterDeployment,afterHash,snapshotAt,snapshotRowid,expectedGraph]=opened as [number,number,string,string,number,number,string];
  }
  const identity=await db.prepare("SELECT owner_id,origin,db_identity FROM flora_deployment WHERE singleton=1").first<{owner_id:string;origin:string;db_identity:string}>();fence();
  if(!identity||identity.owner_id!==owner||identity.origin!==config.origin||identity.db_identity!==config.dbIdentity)throw new HttpFailure(409,"CONFIG_CONFLICT");
  // The existing ota_latest index restricts this MATERIALIZED slice to one
  // app/platform/channel/runtime and publication snapshot. At most 2,001 rows
  // are inspected once, even when the logical graph contains branches. Scope
  // overflow is reported as incomplete, never silently considered complete.
  const published=await db.prepare(`WITH anchor AS MATERIALIZED (
   SELECT d.*,${sdkRollbackChainProjection("d")} AS chain_value FROM ota_deployments d JOIN applications a ON a.owner_id=d.owner_id AND a.id=d.app_id WHERE d.owner_id=? AND d.app_id=? AND d.id=?
  ), scoped AS MATERIALIZED (
   SELECT d.* FROM ota_deployments d JOIN anchor a ON d.owner_id=a.owner_id AND d.app_id=a.app_id AND d.platform=a.platform AND d.channel=a.channel AND d.runtime_version=a.runtime_version
   WHERE d.created_at>=COALESCE((SELECT r.created_at FROM ota_deployments r WHERE r.owner_id=a.owner_id AND r.app_id=a.app_id AND r.id=json_extract(a.chain_value,'$.rootId')),a.created_at) AND d.created_at<=?
   ORDER BY d.created_at,d.id LIMIT 2001
  ) SELECT ${journeyPublicationProjection("d")} AS anchor_value,d.chain_value,
   (SELECT json_group_array(json(value)) FROM (SELECT ${journeyPublicationProjection("d")} AS value FROM scoped d ${sdkRollbackJoins} ORDER BY d.created_at,d.id)) AS scope_value
   FROM anchor d ${sdkRollbackJoins}`).bind(owner,appId,deploymentId,snapshotAt).first<{anchor_value:string;chain_value:string;scope_value:string}>();fence();
  if(!published)throw new HttpFailure(404,"NOT_FOUND");
  type PublicationRow={id:string;platform:"ios"|"android";channel:string;runtimeVersion:string;createdAt:number;commitSha:unknown;validMetadata:number;rollbackPresent:number;rollbackFrom:unknown;lineage:SDKRollbackLineage|null};
  const anchor=JSON.parse(published.anchor_value) as PublicationRow,scoped=JSON.parse(published.scope_value) as PublicationRow[];
  const validPublication=(row:PublicationRow):boolean=>row.validMetadata===1&&typeof row.id==="string"&&uuidPattern.test(row.id)&&["ios","android"].includes(row.platform)&&typeof row.channel==="string"&&row.channel.length>0&&row.channel.length<=128&&typeof row.runtimeVersion==="string"&&row.runtimeVersion.length>0&&row.runtimeVersion.length<=256&&integer(row.createdAt)&&row.createdAt<=snapshotAt;
  if(!validPublication(anchor))throw new HttpFailure(409,"CONFIG_CONFLICT");
  const validLineage=(row:PublicationRow):boolean=>{
   const value=row.lineage;if(!value||value.id!==row.id||value.appId!==appId||value.platform!==anchor.platform||value.channel!==anchor.channel||value.runtimeVersion!==anchor.runtimeVersion||value.createdAt!==row.createdAt||![value.createdAt,value.sourceCreatedAt,value.targetCreatedAt,value.requestedAt].every(integer)||value.targetCreatedAt>=value.sourceCreatedAt||value.sourceCreatedAt>=value.createdAt||value.requestedAt>value.createdAt)return false;
   try{const parsed=parseOTARollbackInput({requestKey:"journey_lineage",fromDeploymentId:value.fromDeploymentId,targetDeploymentId:value.targetDeploymentId,reason:value.reason});return parsed.fromDeploymentId!==row.id&&parsed.targetDeploymentId!==row.id&&parsed.fromDeploymentId!==parsed.targetDeploymentId;}catch{return false;}
  };
  const candidates=new Map(scoped.slice(0,2000).filter(row=>validPublication(row)&&row.platform===anchor.platform&&row.channel===anchor.channel&&row.runtimeVersion===anchor.runtimeVersion).map(row=>[row.id,row]));candidates.set(anchor.id,anchor);
  const reasons=new Set<JourneyHistoryReason>();if(scoped.length>2000)reasons.add("capacity");
  let root:PublicationRow|null=anchor,depth=0;
  while(root?.rollbackPresent){if(depth++>=rollbackMaximumDepth||!validLineage(root)){root=null;break;}root=candidates.get(root.lineage!.fromDeploymentId)??null;}
  if(!root)reasons.add("lineage");
  let nodes:PublicationRow[];
  if(root){
   const connected=new Map<string,PublicationRow>([[root.id,root]]);
   for(const row of [...candidates.values()].sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id))){if(row.id===root.id)continue;if(validLineage(row)&&connected.has(row.lineage!.fromDeploymentId))connected.set(row.id,row);else if(row.lineage&&connected.has(row.lineage.fromDeploymentId))reasons.add("lineage");}
   // A same-scope child with a missing/invalid target is not a proven edge.
   // Explain the gap rather than pretending this truncated incident is complete.
   for(const row of scoped.slice(0,2000))if(row.rollbackPresent&&typeof row.rollbackFrom==="string"&&connected.has(row.rollbackFrom)&&(!validPublication(row)||!validLineage(row)))reasons.add("lineage");
   nodes=[...connected.values()].sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));
   if(nodes.length>rollbackMaximumDepth+1){reasons.add("capacity");reasons.add("lineage");nodes=nodes.slice(0,rollbackMaximumDepth+1);}
   if(!nodes.some(row=>row.id===anchor.id)){root=null;reasons.add("lineage");nodes=[anchor];}
  }else nodes=[anchor];
  const metadata=(row:PublicationRow):DetailDeployment=>({id:row.id,platform:row.platform,channel:row.channel,runtimeVersion:row.runtimeVersion,createdAt:row.createdAt,commitSha:typeof row.commitSha==="string"&&/^[a-f0-9]{40}$/.test(row.commitSha)?row.commitSha:null,...(row.rollbackPresent&&validLineage(row)?{rollback:{fromDeploymentId:row.lineage!.fromDeploymentId,targetDeploymentId:row.lineage!.targetDeploymentId,reason:row.lineage!.reason,requestedAt:row.lineage!.requestedAt}}:{})});
  const nodeIds=JSON.stringify(nodes.map(row=>row.id));
  const original=this.storage.sql.exec<{data:string}>("SELECT data FROM flora_sdk_telemetry_installations WHERE owner_id=? AND app_id=? AND deployment_id=? AND installation_hash=?",owner,appId,deploymentId,installationHash).toArray()[0];
  if(!original)throw new HttpFailure(404,"NOT_FOUND");
  if(snapshotRowid===null)snapshotRowid=this.storage.sql.exec<{maximum:number|null}>("SELECT MAX(j.rowid) AS maximum FROM json_each(?) d JOIN flora_sdk_telemetry_journal j ON j.owner_id=? AND j.app_id=? AND j.deployment_id=d.value AND j.installation_hash=? WHERE j.received_at<=?",nodeIds,owner,appId,installationHash,snapshotAt).one().maximum??0;
  const states=this.storage.sql.exec<{deployment_id:string;data:string;recorded:number}>("SELECT i.deployment_id,i.data,(SELECT count(*) FROM flora_sdk_telemetry_journal j WHERE j.owner_id=i.owner_id AND j.app_id=i.app_id AND j.deployment_id=i.deployment_id AND j.installation_hash=i.installation_hash AND j.rowid<=? AND j.received_at<=?) AS recorded FROM json_each(?) d JOIN flora_sdk_telemetry_installations i ON i.owner_id=? AND i.app_id=? AND i.deployment_id=d.value AND i.installation_hash=?",snapshotRowid,snapshotAt,nodeIds,owner,appId,installationHash).toArray();
  const historyById=new Map<string,JourneyHistory>();
  for(const row of states){
   const detail=normalizeInstallation(JSON.parse(row.data) as Installation).detailHistory;
   if(detail?.startedAt&&detail.startedAt>snapshotAt)continue;
   const reason=detail?.omittedEvents?"capacity" as const:!detail||detail.legacy?"legacy" as const:null;
   historyById.set(row.deployment_id,{complete:reason===null,reason,recordedEvents:row.recorded,omittedEvents:detail?.omittedEvents??0,startedAt:detail?.startedAt||null});
  }
  const deployments=nodes.map(row=>{const history:JourneyHistory=historyById.get(row.id)??{complete:false,reason:"missing",recordedEvents:0,omittedEvents:0,startedAt:null};if(history.reason)reasons.add(history.reason);return {...metadata(row),history};});
  const state=normalizeInstallation(JSON.parse(original.data) as Installation);
  // A pagination cursor seals provenance and conservative history coverage as
  // well as graph shape. A changed legacy/capacity classification cannot turn a
  // prior incomplete snapshot into apparent success while its events are absent.
  const graph=await this.hash(hmac,canonicalJson(["journey-graph-v1",root?.id??null,deployments,state.environment,[...reasons].sort()]),fence);
  if(expectedGraph!==null&&expectedGraph!==graph)throw new HttpFailure(409,"SDK_TELEMETRY_JOURNEY_CHANGED");
  const entries=this.storage.sql.exec<{at:number;kind:number;deployment_id:string;event_hash:string;type:EventType|null;received_at:number|null;stage:Stage|null;code:FailureCode|null}>(`WITH items AS (
   SELECT json_extract(d.value,'$.id') AS deployment_id,json_extract(d.value,'$.createdAt') AS at,0 AS kind,'' AS event_hash,NULL AS type,NULL AS received_at,NULL AS stage,NULL AS code FROM json_each(?) d
   UNION ALL SELECT j.deployment_id,j.observed_at,1,j.event_hash,j.type,j.received_at,j.stage,j.code FROM json_each(?) d JOIN flora_sdk_telemetry_journal j ON j.owner_id=? AND j.app_id=? AND j.deployment_id=d.value AND j.installation_hash=? WHERE j.rowid<=? AND j.received_at<=?
  ) SELECT * FROM items WHERE (at,kind,deployment_id,event_hash)>(?,?,?,?) ORDER BY at,kind,deployment_id,event_hash LIMIT 21`,JSON.stringify(nodes.map(row=>({id:row.id,createdAt:row.createdAt}))),nodeIds,owner,appId,installationHash,snapshotRowid,snapshotAt,afterTime,afterKind,afterDeployment,afterHash).toArray();fence();
  const page=entries.slice(0,detailPageSize),publicEntries:SDKJourneyPage["entries"]=[];
  for(const row of page){const entryId="j1."+await this.hash(hmac,canonicalJson(["journey-entry-v1",journeyScope,row.kind,row.deployment_id,row.event_hash]),fence);publicEntries.push(row.kind===0?{id:entryId,kind:"publication",deploymentId:row.deployment_id,observedAt:row.at}:{id:entryId,kind:"sdk-event",deploymentId:row.deployment_id,type:row.type!,observedAt:row.at,receivedAt:row.received_at!,...(row.stage&&row.code?{stage:row.stage,code:row.code}:{})});}
  const last=page.at(-1),label=await this.hash(hmac,canonicalJson(["display-installation",scope,installationHash]),fence);
  const nextCursor=entries.length>detailPageSize&&last?await this.sealDetail(key,journeyScope,[last.at,last.kind,last.deployment_id,last.event_hash,snapshotAt,snapshotRowid,graph],fence,"c1"):null;fence();
  return {appId,deploymentId,rootDeploymentId:root?.id??null,source:"sdk-self-report",observedAt:snapshotAt,pageSize:20,nextCursor,installation:{id:installationRef,label:"설치 "+label.slice(0,12),environment:state.environment},deployments,history:{complete:reasons.size===0,reasons:[...reasons].sort()},entries:publicEntries};
 }

 /** Owner-only, manually requested pages: two indexed immutable D1 scope reads,
  * then bounded installation/event pages after the additive once-only current
  * state initialization. No polling, history deletion, repeated fleet scans or
  * device identity export; original journal and cumulative counters stay intact. */
 async detail(db:D1Database,config:FloraConfig,appId:string,deploymentId:string,cursor:string|null,installationRef:string|null,fence:Fence,now:number,isAutomaticRollbackEligible?:(installationHash:string)=>boolean,filter:"all"|"issues"|"unresolved"|"resolved"="all"):Promise<SDKInstallationPage|SDKEventPage> {
  fence();id(appId);uuid(deploymentId);if(!integer(now))invalid();
  if(!["all","issues","unresolved","resolved"].includes(filter)||installationRef!==null&&filter!=="all")throw new HttpFailure(400,"INVALID_INPUT");
  const owner=text(config.ownerId,256),key=await this.detailCrypto(fence),hmac=await this.cryptoKey(fence);
  const scope=canonicalJson(["sdk-detail-v1",owner,config.origin,config.dbIdentity,appId,deploymentId]);
  let installationHash:string|null=null;
  if(installationRef!==null){const opened=await this.openDetail(key,scope+":installation",installationRef,fence,"i1");if(typeof opened!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(opened))throw new HttpFailure(404,"NOT_FOUND");installationHash=opened;}
  const installationsScope=scope+(filter!=="all"?":installations:"+filter:":installations");
  let afterHash="",afterTime=Number.MAX_SAFE_INTEGER;
  if(cursor!==null){const opened=await this.openDetail(key,(installationHash?scope+":events:"+installationHash:installationsScope),cursor,fence,"c1");
   if(installationHash){if(!Array.isArray(opened)||opened.length!==2||!integer(opened[0])||typeof opened[1]!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(opened[1]))throw new HttpFailure(400,"INVALID_TELEMETRY_CURSOR");afterTime=opened[0];afterHash=opened[1];}
   else{if(typeof opened!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(opened))throw new HttpFailure(400,"INVALID_TELEMETRY_CURSOR");afterHash=opened;}
  }
  const deployment=await this.detailDeployment(db,config,appId,deploymentId,fence,now);
  this.ensureRollbackResolution(fence);
  const target=[owner,appId,deploymentId],base={appId,deploymentId,deployment,source:"sdk-self-report" as const,observedAt:now,pageSize:detailPageSize as 20};
  const rows=installationHash?this.storage.sql.exec<{installation_hash:string;data:string}>("SELECT installation_hash,data FROM flora_sdk_telemetry_installations WHERE owner_id=? AND app_id=? AND deployment_id=? AND installation_hash=?",...target,installationHash).toArray():filter==="unresolved"||filter==="resolved"?this.storage.sql.exec<{installation_hash:string;data:string}>("SELECT s.installation_hash,i.data FROM flora_sdk_telemetry_issue_state s JOIN flora_sdk_telemetry_installations i ON i.owner_id=s.owner_id AND i.app_id=s.app_id AND i.deployment_id=s.deployment_id AND i.installation_hash=s.installation_hash WHERE s.owner_id=? AND s.app_id=? AND s.deployment_id=? AND s.status=? AND s.installation_hash>? ORDER BY s.installation_hash LIMIT 21",...target,filter,afterHash).toArray():this.storage.sql.exec<{installation_hash:string;data:string}>(`SELECT installation_hash,data FROM flora_sdk_telemetry_installations WHERE owner_id=? AND app_id=? AND deployment_id=? ${filter==="issues"?"AND (json_extract(data,'$.failed')=1 OR json_extract(data,'$.rolledBack')=1) ":""}AND installation_hash>? ORDER BY installation_hash LIMIT 21`,...target,afterHash).toArray();
  if(installationHash&&!rows.length)throw new HttpFailure(404,"NOT_FOUND");
  const pageRows=rows.slice(0,detailPageSize);
  const failures=pageRows.length?this.storage.sql.exec<{installation_hash:string;stage:Stage;code:FailureCode}>("SELECT f.installation_hash,f.stage,f.code FROM json_each(?) i JOIN flora_sdk_telemetry_installation_failures f ON f.owner_id=? AND f.app_id=? AND f.deployment_id=? AND f.installation_hash=i.value ORDER BY f.installation_hash,f.stage,f.code",JSON.stringify(pageRows.map(row=>row.installation_hash)),...target).toArray():[];
  const issueRows=pageRows.length?this.storage.sql.exec<IssueState&{installation_hash:string}>("SELECT s.installation_hash,s.latest_failure_at,s.unknown_until,s.status FROM json_each(?) i JOIN flora_sdk_telemetry_issue_state s ON s.owner_id=? AND s.app_id=? AND s.deployment_id=? AND s.installation_hash=i.value",JSON.stringify(pageRows.map(row=>row.installation_hash)),...target).toArray():[];
  const proofRows=pageRows.length?this.storage.sql.exec<{installation_hash:string;kind:"same-deployment"|"rollback";resolution_id:string;confirmed_at:number;restarted_at:number}>("SELECT p.installation_hash,p.kind,p.resolution_id,p.confirmed_at,p.restarted_at FROM json_each(?) i JOIN flora_sdk_telemetry_resolution_proof p ON p.owner_id=? AND p.app_id=? AND p.deployment_id=? AND p.installation_hash=i.value",JSON.stringify(pageRows.map(row=>row.installation_hash)),...target).toArray():[];
  const proofByHash=new Map(proofRows.map(row=>[row.installation_hash,{kind:row.kind,deploymentId:row.resolution_id,confirmedAt:row.confirmed_at,restartedAt:row.restarted_at}]));
  const issueByHash=new Map(issueRows.map(row=>[row.installation_hash,row]));
  // One page-scoped DO query derives the latest same-install rollback cause.
  // It does not copy rollback events into the original publication journal or
  // export the private cross-deployment installation HMAC.
  const rollbackFailures=pageRows.length?this.storage.sql.exec<{installation_hash:string;deployment_id:string;observed_at:number;cause:string|null}>(`WITH RECURSIVE linked(installation_hash,deployment_id,created_at,depth) AS (
   SELECT p.value,l.deployment_id,l.created_at,1 FROM json_each(?) p JOIN flora_sdk_telemetry_rollback_lineage l ON l.owner_id=? AND l.app_id=? AND l.source_id=?
   UNION ALL SELECT d.installation_hash,l.deployment_id,l.created_at,d.depth+1 FROM linked d JOIN flora_sdk_telemetry_rollback_lineage l ON l.owner_id=? AND l.app_id=? AND l.source_id=d.deployment_id AND l.created_at>d.created_at WHERE d.depth<${rollbackMaximumDepth}
  ), ordered AS (
   SELECT d.installation_hash,d.deployment_id,s.latest_failure_at AS observed_at,ROW_NUMBER() OVER(PARTITION BY d.installation_hash ORDER BY s.latest_failure_at DESC,d.created_at DESC,d.deployment_id) AS position
   FROM linked d JOIN flora_sdk_telemetry_issue_state s ON s.owner_id=? AND s.app_id=? AND s.deployment_id=d.deployment_id AND s.installation_hash=d.installation_hash JOIN flora_sdk_telemetry_issue_state original ON original.owner_id=s.owner_id AND original.app_id=s.app_id AND original.deployment_id=? AND original.installation_hash=s.installation_hash
   WHERE s.latest_failure_at>MAX(original.latest_failure_at,COALESCE(original.unknown_until,0),d.created_at) AND (s.unknown_until IS NULL OR s.latest_failure_at>=s.unknown_until)
  ) SELECT o.installation_hash,o.deployment_id,o.observed_at,(SELECT json_object('stage',j.stage,'code',j.code) FROM flora_sdk_telemetry_journal j WHERE j.owner_id=? AND j.app_id=? AND j.deployment_id=o.deployment_id AND j.installation_hash=o.installation_hash AND j.observed_at=o.observed_at AND j.type IN ('failed','rolled_back') ORDER BY j.event_hash LIMIT 1) AS cause FROM ordered o WHERE position=1`,JSON.stringify(pageRows.map(row=>row.installation_hash)),...target,...target.slice(0,2),...target,...target.slice(0,2)).toArray():[];
  const rollbackFailureByHash=new Map(rollbackFailures.map(row=>[row.installation_hash,{deploymentId:row.deployment_id,observedAt:row.observed_at,...(row.cause?JSON.parse(row.cause) as {stage:Stage;code:FailureCode}:{})}]));
  const installations:SDKInstallationDetail[]=[];
  for(const row of pageRows){const state=normalizeInstallation(JSON.parse(row.data) as Installation),history=state.detailHistory,issue=issueByHash.get(row.installation_hash);
   const label=await this.hash(hmac,canonicalJson(["display-installation",scope,row.installation_hash]),fence);
   installations.push({id:installationRef??await this.sealDetail(key,scope+":installation",row.installation_hash,fence,"i1"),label:"설치 "+label.slice(0,12),environment:state.environment,...(isAutomaticRollbackEligible?{automaticRollbackEligible:isAutomaticRollbackEligible(row.installation_hash)}:{}),...(rollbackFailureByHash.has(row.installation_hash)?{rollbackFailure:rollbackFailureByHash.get(row.installation_hash)!}:{}),...(issue?.status==="resolved"?{issueResolution:proofByHash.get(row.installation_hash)??{kind:"same-deployment" as const,deploymentId,confirmedAt:state.latestConfirmedAt,restartedAt:state.latestRestartAt}}:{}),issueStatus:issue?.status??(state.failed||state.rolledBack?"unresolved":"none"),issueOrderKnown:issue?issue.status==="resolved"||issue.unknown_until===null:!state.failed&&!state.rolledBack,downloaded:state.downloaded===1,applied:state.applied===1,restarted:state.restarted===1,failed:state.failed===1,rolledBack:state.rolledBack===1,recovered:state.recovered===1,lastReportedAt:state.lastReportedAt,firstFailureAt:state.firstFailureAt||null,latestConfirmedAt:state.latestConfirmedAt||null,latestRestartAt:state.latestRestartAt||null,
    history:{complete:!!history&&!history.legacy&&history.omittedEvents===0,reason:history?.omittedEvents?"capacity":!history||history.legacy?"legacy":null,recordedEvents:history?.recordedEvents??0,omittedEvents:history?.omittedEvents??0,startedAt:history?.startedAt||null},failures:failures.filter(f=>f.installation_hash===row.installation_hash).map(f=>({stage:f.stage,code:f.code}))});
  }
  if(installationHash){
   const journal=this.storage.sql.exec<{event_hash:string;observed_at:number;received_at:number;type:EventType;stage:Stage|null;code:FailureCode|null}>("SELECT event_hash,observed_at,received_at,type,stage,code FROM flora_sdk_telemetry_journal WHERE owner_id=? AND app_id=? AND deployment_id=? AND installation_hash=? AND (observed_at,event_hash)<(?,?) ORDER BY observed_at DESC,event_hash DESC LIMIT 21",...target,installationHash,afterTime,cursor?afterHash:"~").toArray();
   const page=journal.slice(0,detailPageSize),last=page.at(-1);fence();return {...base,installation:installations[0]!,events:page.map(row=>({type:row.type,observedAt:row.observed_at,receivedAt:row.received_at,...(row.stage&&row.code?{stage:row.stage,code:row.code}:{})})),nextCursor:journal.length>detailPageSize&&last?await this.sealDetail(key,scope+":events:"+installationHash,[last.observed_at,last.event_hash],fence,"c1"):null};
  }
  const last=pageRows.at(-1),summary=this.latest(owner,[{appId,deploymentId}],fence).get(JSON.stringify([appId,deploymentId]))??null;fence();
  return {...base,...(filter!=="all"?{filter}:{}),summary,installations,nextCursor:rows.length>detailPageSize&&last?await this.sealDetail(key,installationsScope,last.installation_hash,fence,"c1"):null};
 }

 /** Two indexed DO joins after the once-only migration; current-state counts
  * join the cumulative aggregate query, with no per-app reads or fleet scans. */
 latest(ownerId:string,targets:ReadonlyArray<{appId:string;deploymentId:string}>,fence:Fence):ReadonlyMap<string,SDKTelemetrySummary> {
  fence();text(ownerId,256);if(targets.length>400)invalid();if(!targets.length)return new Map();
  for(const target of targets){object(target,["appId","deploymentId"]);id(target.appId);uuid(target.deploymentId);}
  this.ensureRollbackResolution(fence);
  const input=JSON.stringify(targets),rows=this.storage.sql.exec<{app_id:string;deployment_id:string;data:string;unresolved:number|null;resolved:number|null;unknown:number|null;rollback_resolved:number|null}>(`SELECT a.app_id,a.deployment_id,a.data,r.unresolved,r.resolved,r.unknown,b.resolved AS rollback_resolved FROM json_each(?) t JOIN flora_sdk_telemetry_aggregates a ON a.owner_id=? AND a.app_id=json_extract(t.value,'$.appId') AND a.deployment_id=json_extract(t.value,'$.deploymentId') LEFT JOIN flora_sdk_telemetry_issue_aggregates r ON r.owner_id=a.owner_id AND r.app_id=a.app_id AND r.deployment_id=a.deployment_id LEFT JOIN flora_sdk_telemetry_rollback_issue_aggregates b ON b.owner_id=a.owner_id AND b.app_id=a.app_id AND b.deployment_id=a.deployment_id`,input,ownerId).toArray();
  const failures=this.storage.sql.exec<{app_id:string;deployment_id:string;stage:Stage;code:FailureCode;installations:number;last_reported_at:number}>(`SELECT f.* FROM json_each(?) t JOIN flora_sdk_telemetry_failures f ON f.owner_id=? AND f.app_id=json_extract(t.value,'$.appId') AND f.deployment_id=json_extract(t.value,'$.deploymentId') ORDER BY f.installations DESC,f.last_reported_at DESC,f.stage,f.code`,input,ownerId).toArray();
  fence();return new Map(rows.map(row=>{const data=normalizeCounters(JSON.parse(row.data) as Counters);return [JSON.stringify([row.app_id,row.deployment_id]),{...data,issueResolution:{unresolvedInstallations:row.unresolved??0,resolvedInstallations:row.resolved??0,unknownInstallations:row.unknown??0,...(row.rollback_resolved?{rollbackResolvedInstallations:row.rollback_resolved}:{})},source:"sdk-self-report" as const,applicationRate:data.observedInstallations?data.appliedInstallations/data.observedInstallations*100:null,failures:failures.filter(f=>f.app_id===row.app_id&&f.deployment_id===row.deployment_id).map(f=>({stage:f.stage,code:f.code,installations:f.installations,lastReportedAt:f.last_reported_at}))}];}));
 }
}
