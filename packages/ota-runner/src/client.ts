import {parseAutomationJob,parseAutomationLease,parseOTAAsset,parseOTAAssetUpload,automationDigest,parseAutomationExportReceipt} from "@app-ops/dogfood";
import type {AutomationClaim,AutomationJob,AutomationLease,AutomationSourceGrant,AutomationExportReceipt,AutomationFinalization,AutomationFailureCode,OTAAssetUpload,OTAAsset} from "@app-ops/dogfood";
import {assertPublicationResult,parseRecoveryJournal} from "./recovery.js";
import type {RecoveryJournal} from "./recovery.js";
import {invariant,sha256} from "./artifacts.js";
import type {AssetPublisher,GitHubAssetReference} from "./github-release-publisher.js";
export class RunnerHttpFailure extends Error { constructor(readonly status:number,code:string){super(code);} }
export interface CheckpointClearance {disposition:"committed"|"stale"|"absent";appId:string;jobId:string;attemptId:string;receiptDigest:string|null}
export interface RunnerPresence {runnerId:string;lastSeenAt:number}
export interface RunnerClient {
 readonly identity?:import("./recovery.js").RunnerIdentity;
 presence?():Promise<RunnerPresence>;
 claim():Promise<AutomationClaim|null>;heartbeat(lease:AutomationLease):Promise<AutomationLease>;source(lease:AutomationLease):Promise<AutomationSourceGrant>;
 uploadAsset(lease:AutomationLease,upload:OTAAssetUpload,bytes:Uint8Array):Promise<OTAAsset>;finalize(lease:AutomationLease,receipt:AutomationExportReceipt):Promise<AutomationFinalization>;fail(lease:AutomationLease,code:AutomationFailureCode):Promise<void>;
 saveCheckpoint?(record:RecoveryJournal):Promise<void>;listCheckpoints?():Promise<RecoveryJournal[]>;clearCheckpoint?(record:RecoveryJournal,expectedDisposition?:"stale"):Promise<CheckpointClearance>;
}
export function createRunnerClient(options:{origin:string;token:string;claimPlatform?:"ios"|"android";fetch?:typeof fetch;assetPublisher?:AssetPublisher}):RunnerClient {
 invariant(options.claimPlatform===undefined||options.claimPlatform==="ios"||options.claimPlatform==="android","INVALID_RUNNER_CONFIG");
 const origin=new URL(options.origin);invariant(origin.origin===options.origin&&!origin.username&&!origin.password&&(origin.protocol==="https:"||origin.protocol==="http:"&&["127.0.0.1","localhost","[::1]"].includes(origin.hostname)),"INVALID_RUNNER_CONFIG");
 invariant(/^[a-z][a-z0-9_-]{2,95}\.[A-Za-z0-9_-]{43}$/.test(options.token),"INVALID_RUNNER_CONFIG");const request=options.fetch??fetch,token=options.token;
 let claimed:AutomationJob|undefined;
 async function call(path:string,data:unknown,binary?:{lease:AutomationLease;bytes:Uint8Array;reference?:GitHubAssetReference},timeoutMs=20000,heartbeatLease?:AutomationLease):Promise<unknown>{
  // Freeze payload and lease headers before waiting so retries cannot observe caller mutation.
  const url=origin.origin+path,headers=new Headers({Authorization:"Bearer "+token,Origin:origin.origin,"Content-Type":binary?"application/octet-stream":"application/json",...(binary?{"X-Flora-Runner-Lease":Buffer.from(JSON.stringify(parseAutomationLease(binary.lease))).toString("base64url")}:{} )});
  const body=binary?new Uint8Array(binary.bytes):JSON.stringify(data);
  if(binary&&Object.hasOwn(binary,"reference")){const r=binary.reference;invariant(r&&typeof r==="object"&&!Array.isArray(r)&&Object.keys(r).length===3&&r.schemaVersion===1&&[r.releaseId,r.assetId].every(id=>Number.isSafeInteger(id)&&id>0),"RUNNER_RESPONSE_INVALID");const reference=Buffer.from(JSON.stringify({assetId:r.assetId,releaseId:r.releaseId,schemaVersion:1})).toString("base64url");invariant(reference.length<=1024,"RUNNER_RESPONSE_INVALID");headers.set("X-Flora-Asset-Reference",reference);}
  const startedAt=Date.now(),deadline=Math.min(startedAt+timeoutMs,heartbeatLease?.expiresAt??Infinity);
  invariant(deadline>startedAt,"LEASE_EXPIRED");const signal=AbortSignal.timeout(deadline-startedAt);
  for(let attempt=0;;attempt++){
   let response:Response|undefined,raw:unknown,failure:RunnerHttpFailure|undefined;
   // A failed request is transport-unavailable. After headers, only a presence
   // probe's interrupted body can use that path; mutation replies stay uncertain.
   try{response=await request(url,{method:"POST",redirect:"error",signal,headers:new Headers(headers),body:body instanceof Uint8Array?new Uint8Array(body):body});}
   catch{failure=new RunnerHttpFailure(0,"RUNNER_TRANSPORT_UNAVAILABLE");}
   if(response){
    invariant(Number.isInteger(response.status)&&response.status>=100&&response.status<=599&&typeof response.ok==="boolean","RUNNER_RESPONSE_INVALID");
    try{
     if(response.status===204)raw=null;
     else{
      invariant(response.body,"RUNNER_RESPONSE_INVALID");const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
      try{for(;;){const part=await reader.read().catch(()=>{
       if(path==="/api/runner/presence"&&response?.ok)throw new RunnerHttpFailure(0,"RUNNER_TRANSPORT_UNAVAILABLE");
       throw new Error("RUNNER_RESPONSE_INVALID");
      });if(part.done)break;size+=part.value.length;invariant(size<=1048576,"RUNNER_RESPONSE_INVALID");chunks.push(part.value);}}finally{void reader.cancel().catch(()=>{});}
      raw=JSON.parse(Buffer.concat(chunks).toString("utf8"));
     }
    }catch(error){
     if(path==="/api/runner/presence"&&response.ok&&error instanceof RunnerHttpFailure&&error.status===0&&error.message==="RUNNER_TRANSPORT_UNAVAILABLE")failure=error;
     // Completed malformed bodies and all uncertain mutation responses still
     // fail closed. No publication, claim or checkpoint is replayed here.
     else if(response.ok)throw new Error("RUNNER_RESPONSE_INVALID");
     else failure=new RunnerHttpFailure(response.status,"RUNNER_REQUEST_REJECTED");
    }
    if(!failure&&!response.ok){const code=typeof (raw as {error?:unknown})?.error==="string"&&/^[A-Z][A-Z0-9_]{1,95}$/.test((raw as {error:string}).error)?(raw as {error:string}).error:"RUNNER_REQUEST_REJECTED";failure=new RunnerHttpFailure(response.status,code);}
   }
   if(!failure){if(heartbeatLease)invariant(!signal.aborted&&Date.now()<deadline,"LEASE_EXPIRED");return raw;}
   let delay:number;
   const semanticRejection=/(?:^|_)(?:STALE|EXPIRED|REVOKED|DENIED|CONFLICT|INVALID|CANCELLED|CHANGED|REJECTED|UNAUTHENTICATED|UNAUTHORIZED|FORBIDDEN|MISMATCH)(?:_|$)/.test(failure.message)&&failure.message!=="RUNNER_REQUEST_REJECTED";
   if(heartbeatLease&&attempt<2&&(failure.status===0&&failure.message==="RUNNER_TRANSPORT_UNAVAILABLE"||failure.status>=500&&failure.status<=599&&!semanticRejection)){
    // A lost heartbeat reply may already have renewed the server lease. Repeat
    // exactly the confirmed attempt/fence, bounded by its ORIGINAL expiry.
    delay=250*(attempt+1);
   }else if(!heartbeatLease&&response?.status===409&&failure.message==="BUSY"&&attempt<2){
    const retryAfter=response.headers.get("Retry-After"),seconds=retryAfter!==null&&/^[0-9]{1,2}$/.test(retryAfter)?Math.min(Number(retryAfter),5):1;delay=seconds*1000;
   }else throw failure;
   if(signal.aborted||Date.now()+delay>=deadline)throw failure;
   try{await new Promise<void>((done,fail)=>{const stop=()=>{clearTimeout(timer);signal.removeEventListener("abort",stop);fail(signal.reason);},timer=setTimeout(()=>{signal.removeEventListener("abort",stop);done();},delay);signal.addEventListener("abort",stop,{once:true});if(signal.aborted)stop();});}catch{throw failure;}
   if(signal.aborted||Date.now()>=deadline)throw failure;
  }
 }
 const client:RunnerClient={
  identity:{origin:options.origin,runnerId:options.token.split(".")[0]!},
  async presence(){const raw=await call("/api/runner/presence",{},undefined,10000) as Record<string,unknown>;
   invariant(raw&&typeof raw==="object"&&!Array.isArray(raw)&&Object.keys(raw).length===2&&raw.runnerId===client.identity!.runnerId&&Number.isSafeInteger(raw.lastSeenAt)&&Number(raw.lastSeenAt)>0&&Number(raw.lastSeenAt)<=Date.now()+5000,"RUNNER_RESPONSE_INVALID");return {runnerId:raw.runnerId as string,lastSeenAt:raw.lastSeenAt as number};},
  async claim(){claimed=undefined;const input=await call("/api/runner/claim",options.claimPlatform?{platform:options.claimPlatform}:{});if(input===null)return null;invariant(input&&typeof input==="object","RUNNER_RESPONSE_INVALID");const raw=input as AutomationClaim,job=parseAutomationJob(raw.job),lease=parseAutomationLease(raw.lease);invariant(job.state==="leased"&&job.lease&&JSON.stringify(job.lease)===JSON.stringify(lease)&&job.appId===lease.appId&&job.id===lease.jobId&&lease.expiresAt>Date.now()&&lease.runnerId===options.token.split(".")[0],"RUNNER_RESPONSE_INVALID");invariant(!options.claimPlatform||job.platform===options.claimPlatform,"RUNNER_RESPONSE_INVALID");invariant(await automationDigest(job.config)===job.configDigest&&await automationDigest(job.config.toolchain)===job.toolchainDigest,"RUNNER_RESPONSE_INVALID");claimed=structuredClone(job);return {job,lease};},
  async heartbeat(lease){
   const original=parseAutomationLease(lease);invariant(original.runnerId===client.identity!.runnerId,"RUNNER_RESPONSE_INVALID");
   const raw=await call("/api/runner/heartbeat",{lease:original},undefined,20000,original);let next:AutomationLease;
   try{next=parseAutomationLease(raw);}catch{throw new Error("RUNNER_RESPONSE_INVALID");}
   invariant(["jobId","appId","attemptId","runnerId","credentialEpoch","fence"].every(key=>next[key as keyof AutomationLease]===original[key as keyof AutomationLease])&&next.expiresAt>Date.now(),"RUNNER_RESPONSE_INVALID");return next;
  },
  async source(lease){const value=await call("/api/runner/source",{lease:parseAutomationLease(lease)}) as AutomationSourceGrant;invariant(value&&typeof value.url==="string"&&typeof value.token==="string"&&typeof value.expiresAt==="number"&&typeof value.maxBytes==="number"&&typeof value.commitSha==="string","RUNNER_RESPONSE_INVALID");return value;},
  async uploadAsset(lease,upload,bytes){const metadata=parseOTAAssetUpload(upload),query=new URLSearchParams(metadata as unknown as Record<string,string>),original=parseAutomationLease(lease),snapshot=new Uint8Array(bytes),path="/api/runner/assets?"+query.toString();let raw:unknown;
   try{raw=await call(path,null,{lease:original,bytes:snapshot});}catch(error){
    if(!(error instanceof RunnerHttpFailure)||error.status!==428||error.message!=="ASSET_STORAGE_REFERENCE_REQUIRED"||!options.assetPublisher)throw error;
    const job=claimed;invariant(job&&job.lease&&["jobId","appId","attemptId","runnerId","credentialEpoch","fence"].every(k=>job.lease![k as keyof AutomationLease]===original[k as keyof AutomationLease])&&original.runnerId===client.identity!.runnerId,"RUNNER_RESPONSE_INVALID");invariant(original.expiresAt>Date.now(),"LEASE_EXPIRED");
    const reference=await options.assetPublisher({origin:origin.origin,job:structuredClone(job),lease:structuredClone(original),upload:{...metadata},bytes:new Uint8Array(snapshot)});invariant(original.expiresAt>Date.now(),"LEASE_EXPIRED");raw=await call(path,null,{lease:original,bytes:snapshot,reference});
   }
   const asset=parseOTAAsset(raw);invariant(asset.appId===original.appId&&asset.digest===sha256(snapshot)&&asset.size===snapshot.length&&asset.key===metadata.key&&asset.contentType===metadata.contentType&&asset.fileExtension===metadata.fileExtension,"RUNNER_RESPONSE_INVALID");return asset;},
  async finalize(lease,receipt){const raw=await call("/api/runner/finalize",{lease:parseAutomationLease(lease),receipt},undefined,10000) as AutomationFinalization;const job=parseAutomationJob(raw.job);invariant(job.id===lease.jobId&&job.appId===lease.appId&&job.state==="succeeded"&&raw.deployment?.id===job.deploymentId,"RUNNER_RESPONSE_INVALID");const result={job,deployment:raw.deployment};assertPublicationResult(result,{schemaVersion:1,origin:options.origin,lease:parseAutomationLease(lease),receipt:parseAutomationExportReceipt(receipt)});return result;},
  async fail(lease,code){await call("/api/runner/fail",{lease:parseAutomationLease(lease),code});},
  async saveCheckpoint(input){const record=parseRecoveryJournal(input,client.identity),raw=await call("/api/runner/checkpoint-save",record,undefined,10000);invariant(raw&&typeof raw==="object"&&Object.keys(raw).length===1&&(raw as {saved?:unknown}).saved===true,"RUNNER_RESPONSE_INVALID");},
  async listCheckpoints(){const raw=await call("/api/runner/checkpoint-list",{},undefined,10000) as {checkpoints?:unknown};invariant(raw&&typeof raw==="object"&&Object.keys(raw).length===1&&Array.isArray(raw.checkpoints)&&raw.checkpoints.length<=100,"RUNNER_RESPONSE_INVALID");const records=raw.checkpoints.map(record=>parseRecoveryJournal(record,client.identity));invariant(new Set(records.map(record=>record.lease.jobId+"."+record.lease.attemptId)).size===records.length,"RUNNER_RESPONSE_INVALID");return records;},
  async clearCheckpoint(input,expectedDisposition){const record=parseRecoveryJournal(input,client.identity),raw=await call("/api/runner/checkpoint-clear",{jobId:record.lease.jobId,attemptId:record.lease.attemptId,...(expectedDisposition?{expectedDisposition}:{})},undefined,10000) as Record<string,unknown>;
   invariant(raw&&typeof raw==="object"&&Object.keys(raw).length===6&&raw.cleared===true&&["committed","stale","absent"].includes(String(raw.disposition))&&raw.appId===record.lease.appId&&raw.jobId===record.lease.jobId&&raw.attemptId===record.lease.attemptId&&(raw.disposition==="absent"?raw.receiptDigest===null:raw.receiptDigest===await automationDigest(record.receipt))&&(!expectedDisposition||raw.disposition===expectedDisposition),"RUNNER_RESPONSE_INVALID");return {disposition:raw.disposition as CheckpointClearance["disposition"],appId:record.lease.appId,jobId:record.lease.jobId,attemptId:record.lease.attemptId,receiptDigest:raw.receiptDigest as string|null};},
 };return client;
}
