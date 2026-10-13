import {mkdtemp,mkdir,rm,realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {automationArtifactPayload,automationDigest,parseOTAAsset} from "@app-ops/dogfood";
import type {AutomationLease,AutomationFailureCode} from "@app-ops/dogfood";
import {invariant,sha256} from "./artifacts.js";
import type {RunnerClient} from "./client.js";
import {RunnerHttpFailure} from "./client.js";
import type {SourceProvider} from "./source.js";
import {writeRecoveryJournal,clearRecoveryJournal,assertPublicationResult,clearRemoteCheckpoint} from "./recovery.js";
import type {RecoveryJournal} from "./recovery.js";
import type {ExportExecutor} from "./docker.js";
export interface RunnerOptions {client:RunnerClient;source:SourceProvider;executor:ExportExecutor;workDirectory?:string;signal?:AbortSignal;heartbeatMs?:number;recoveryDirectory?:string;remoteCheckpoint?:boolean}
export interface RunnerOutcome {state:"empty"|"succeeded"|"failed"|"interrupted"|"publication_unknown";jobId?:string;code?:AutomationFailureCode;recoveryJournal?:string}
export async function runOne(options:RunnerOptions):Promise<RunnerOutcome>{
 if(options.remoteCheckpoint)invariant(options.recoveryDirectory&&options.client.identity&&options.client.saveCheckpoint&&options.client.listCheckpoints&&options.client.clearCheckpoint,"INVALID_RUNNER_CONFIG");
 const claim=await options.client.claim();if(!claim)return {state:"empty"};const {job}=claim;let lease=claim.lease,done=false,heartbeat:Promise<void>|null=null,finalizing=false,heartbeatStopped=false;
 const controller=new AbortController(),abort=()=>controller.abort();options.signal?.addEventListener("abort",abort,{once:true});if(options.signal?.aborted)controller.abort();
 const timeout=setTimeout(abort,18*60*1000),same=(a:AutomationLease,b:AutomationLease)=>["jobId","appId","attemptId","runnerId","credentialEpoch","fence"].every(key=>a[key as keyof AutomationLease]===b[key as keyof AutomationLease]);
 const timer=setInterval(()=>{if(done||heartbeatStopped||heartbeat)return;heartbeat=options.client.heartbeat(lease).then(next=>{invariant(same(lease,next)&&next.expiresAt>Date.now(),"LEASE_EXPIRED");lease=next;}).catch(()=>{if(!done)controller.abort();}).finally(()=>{heartbeat=null;});},options.heartbeatMs??30000);
 let directory:string|undefined,journalPath:string|undefined,record:RecoveryJournal|undefined;
 try{
  const work=options.workDirectory??tmpdir();await mkdir(work,{recursive:true});directory=await mkdtemp(join(work,"flora-claim-"));
  const grant=await options.client.source(lease),checkout=await options.source.checkout(job,grant,directory,controller.signal);
  invariant(!controller.signal.aborted,"CANCELLED");const exported=await options.executor.execute(job,checkout.directory,controller.signal);
  invariant(exported.commitSha===job.commitSha&&exported.platform===job.platform&&exported.runtimeVersion===job.runtimeVersion,"ARTIFACT_INVALID");
  const uploaded=[];
  for(const asset of [exported.launchAsset,...exported.assets]){
   const uploadLease=lease,metadata={key:asset.key,contentType:asset.contentType,fileExtension:asset.fileExtension};let saved:ReturnType<typeof parseOTAAsset>|undefined;
   for(let attempt=0;attempt<3;attempt++){
    invariant(!controller.signal.aborted,"CANCELLED");invariant(uploadLease.expiresAt-Date.now()>=20000,"LEASE_EXPIRED");invariant(sha256(asset.bytes)===asset.digest,"ARTIFACT_INVALID");
    try{saved=parseOTAAsset(await options.client.uploadAsset(uploadLease,metadata,asset.bytes));break;}
    catch(error){if(!transient(error)||attempt===2||uploadLease.expiresAt-Date.now()<20000)throw error;await pause(250*(attempt+1),controller.signal);}
   }
   invariant(saved&&saved.appId===job.appId&&saved.digest===asset.digest&&saved.size===asset.bytes.length&&saved.key===asset.key,"ARTIFACT_INVALID");uploaded.push(saved);
  }
  const core={jobId:job.id,attemptId:lease.attemptId,commitSha:job.commitSha,configDigest:job.configDigest,toolchainDigest:job.toolchainDigest,sourceArchiveDigest:checkout.sourceDigest,launchAssetId:uploaded[0]!.id,assetIds:uploaded.slice(1).map(asset=>asset.id)};
  const artifactDigest=await automationDigest(automationArtifactPayload(core,uploaded));
  // A heartbeat mutates persisted lease/version state. Stop and drain it before
  // finalization, then renew once and reserve at least 35s for the bounded call.
  heartbeatStopped=true;clearInterval(timer);await heartbeat;invariant(!controller.signal.aborted,"CANCELLED");
  const fresh=await options.client.heartbeat(lease);invariant(same(lease,fresh)&&fresh.expiresAt-Date.now()>=35000,"LEASE_EXPIRED");lease=fresh;
  invariant(!controller.signal.aborted,"CANCELLED");
  const receipt={...core,artifactDigest};
  if(options.recoveryDirectory){invariant(options.client.identity&&options.client.identity.runnerId===lease.runnerId,"INVALID_RUNNER_CONFIG");record={schemaVersion:1,origin:options.client.identity.origin,lease,receipt};journalPath=await writeRecoveryJournal(options.recoveryDirectory,record);}
  const recoveryInsideCheckout=journalPath&&[await realpath(directory),await realpath(checkout.directory)].some(root=>journalPath!.startsWith(root+sep));
  if(controller.signal.aborted||recoveryInsideCheckout){if(journalPath&&record){try{await clearRecoveryJournal(journalPath,record);}catch{throw new Error("RECOVERY_CLEANUP_UNCONFIRMED");}journalPath=undefined;record=undefined;}throw new Error(recoveryInsideCheckout?"INVALID_RUNNER_CONFIG":"CANCELLED");}
  if(options.remoteCheckpoint){try{await options.client.saveCheckpoint!(record!);}catch{throw new Error("RECOVERY_CHECKPOINT_UNAVAILABLE");}invariant(lease.expiresAt-Date.now()>=35000,"LEASE_EXPIRED");invariant(!controller.signal.aborted,"CANCELLED");}
  finalizing=true;
  for(let attempt=0;attempt<3;attempt++){
   invariant(!controller.signal.aborted,"CANCELLED");
   try{const result=await options.client.finalize(lease,receipt);if(record){assertPublicationResult(result,record);await clearRecoveryJournal(journalPath!,record);if(options.remoteCheckpoint)await clearRemoteCheckpoint(options.client,record);}done=true;return {state:"succeeded",jobId:job.id};}
   catch(error){if(!transient(error)||attempt===2||lease.expiresAt-Date.now()<11000)throw error;await pause(250*(attempt+1));}
  }
  throw new Error("PUBLICATION_RESULT_UNCONFIRMED");
 }catch(error){
  if(error instanceof Error&&["ISOLATION_CLEANUP_UNCONFIRMED","RECOVERY_JOURNAL_UNAVAILABLE","RECOVERY_CLEANUP_UNCONFIRMED","RECOVERY_CHECKPOINT_UNAVAILABLE","INVALID_RUNNER_CONFIG"].includes(error.message))throw error;
  if(finalizing&&(journalPath||!(error instanceof RunnerHttpFailure)||transient(error)))return {state:"publication_unknown",jobId:job.id,code:"PUBLICATION_REJECTED",...(journalPath?{recoveryJournal:journalPath}:{})};
  if(error instanceof RunnerHttpFailure&&[401,403,409].includes(error.status))throw error;
  const message=error instanceof Error?error.message:"EXPORT_FAILED",allowed:AutomationFailureCode[]=["EXPORT_FAILED","SOURCE_UNAVAILABLE","CONFIG_CHANGED","ARTIFACT_INVALID","CANCELLED","LEASE_EXPIRED","RUNNER_REVOKED"];
  const code=controller.signal.aborted?"CANCELLED":allowed.includes(message as AutomationFailureCode)?message as AutomationFailureCode:finalizing?"PUBLICATION_REJECTED":"EXPORT_FAILED";
  await options.client.fail(lease,code).catch(()=>{});return {state:controller.signal.aborted?"interrupted":"failed",jobId:job.id,code};
 }finally{done=true;clearTimeout(timeout);clearInterval(timer);options.signal?.removeEventListener("abort",abort);await heartbeat;if(directory)await rm(directory,{recursive:true,force:true});}
}
function transient(error:unknown):boolean{return error instanceof RunnerHttpFailure&&(error.status===0||error.status>=500);}
async function pause(ms:number,signal?:AbortSignal):Promise<void>{if(signal?.aborted)return;await new Promise<void>(resolve=>{const timer=setTimeout(finish,ms);function finish(){clearTimeout(timer);signal?.removeEventListener("abort",finish);resolve();}signal?.addEventListener("abort",finish,{once:true});});}
export async function runDaemon(options:RunnerOptions&{pollMs?:number;onOutcome?:(value:RunnerOutcome)=>void}):Promise<void>{
 let claimFailures=0;
 while(!options.signal?.aborted){let result:RunnerOutcome;try{result=await runOne(options);claimFailures=0;}catch(error){if(!transient(error)||++claimFailures>=3)throw error;await pause(250*claimFailures,options.signal);continue;}
  options.onOutcome?.(result);if(result.state==="publication_unknown")throw new Error("PUBLICATION_RECONCILIATION_REQUIRED");if(result.state==="empty")await pause(options.pollMs??5000,options.signal);
 }
}
