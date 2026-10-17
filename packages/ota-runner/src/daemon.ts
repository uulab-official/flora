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
import {diagnosticLine} from "./process.js";
export interface RunnerOptions {client:RunnerClient;source:SourceProvider;executor:ExportExecutor;workDirectory?:string;signal?:AbortSignal;heartbeatMs?:number;recoveryDirectory?:string;remoteCheckpoint?:boolean;diagnostics?:boolean}
export interface RunnerOutcome {state:"empty"|"succeeded"|"failed"|"interrupted"|"publication_unknown";jobId?:string;platform?:"ios"|"android";deploymentId?:string;code?:AutomationFailureCode;recoveryJournal?:string}
const failureCodes=new Set(["INVALID_RUNNER_CONFIG","ISOLATION_UNAVAILABLE","DOCKER_DAEMON_UNAVAILABLE","ISOLATION_CLEANUP_UNCONFIRMED","PUBLICATION_RECONCILIATION_REQUIRED","INVALID_RECOVERY_JOURNAL","RECOVERY_JOURNAL_UNAVAILABLE","RECOVERY_CLEANUP_UNCONFIRMED","RECOVERY_CHECKPOINT_UNAVAILABLE","PUBLICATION_RESULT_UNCONFIRMED","RUNNER_STOPPED","BUSY","LEASE_STALE","CONFIG_CONFLICT","CONFIG_CHANGED","PERMISSION_DENIED","INVALID_INPUT","INVALID_RELATION","NOT_FOUND","CONFLICT","INPUT_TOO_LARGE","PROVIDER_UNSUPPORTED","PROVIDER_UNCONFIGURED","UNAUTHENTICATED","FORBIDDEN","AUTH_UNAVAILABLE","CI_SESSION_REJECTED","CI_BINDING_REJECTED","CI_COMMIT_SUPERSEDED","CI_IDENTITY_REJECTED","CI_IDENTITY_REPLAYED","CHECKPOINT_CAPACITY","RUNNER_REVOKED","RUNNER_REQUEST_REJECTED","RUNNER_TRANSPORT_UNAVAILABLE","RUNNER_RESPONSE_INVALID","EXPORT_FAILED","SOURCE_UNAVAILABLE","ARTIFACT_INVALID","CANCELLED","LEASE_EXPIRED","PUBLICATION_REJECTED"]);
const failureStages=new Set(["runner-initialization","runner-execution","claim","source","compiler","artifact-validation","asset-upload","receipt","heartbeat","publication-heartbeat","recovery-journal","checkpoint-save","finalize","publication-verification","recovery-cleanup","checkpoint-clear","failure-report"]);
const recoverableHostAssetFailures=new Set(["ASSET_STORAGE_RATE_LIMITED","ASSET_STORAGE_UNAVAILABLE","ASSET_STORAGE_CAPACITY","ASSET_STORAGE_CONFLICT"]);
const recoverableProviderAssetFailures=new Set(["429:GITHUB_ASSET_RATE_LIMIT","429:GITHUB_ASSET_BUSY","503:GITHUB_ASSET_UNAVAILABLE"]);
for(const code of ["TENANT_MISMATCH","IDEMPOTENCY_CONFLICT","INVALID_TRANSITION","PRIVATE_STORE_UNSAFE","STORE_IN_USE","MIGRATION_MISMATCH","INVALID_REQUEST","PRESENCE_CAPACITY","D1_DAILY_READ_LIMIT","D1_DAILY_WRITE_LIMIT"])failureCodes.add(code);
/** Fixed codes only: an HTTP error body or thrown message is never printable data. */
export function runnerFailureCode(error:unknown):string{
 const code=error instanceof Error?error.message:"";return failureCodes.has(code)?code:error instanceof RunnerHttpFailure?"RUNNER_REQUEST_REJECTED":"RUNNER_STOPPED";
}
export function runnerFailureDiagnostic(stage:string,error:unknown):{diagnostic:true;stage:string;code:string;httpStatus?:number}{
 const http=error instanceof RunnerHttpFailure?error:error instanceof Error&&error.cause instanceof RunnerHttpFailure?error.cause:null;
 // These host-only failures happen before receipt/finalization. The job is
 // authoritatively failed as EXPORT_FAILED below; its diagnostic must agree so
 // one unavailable storage provider cannot latch the multi-app supervisor.
 // Only exact provider backpressure status/code pairs can join this upload-only
 // path. Authentication, integrity, wrapped controls and other stages stay fatal.
 const recoverable=stage==="asset-upload"&&(!http&&error instanceof Error&&error.cause===undefined&&recoverableHostAssetFailures.has(error.message)
  ||error instanceof RunnerHttpFailure&&recoverableProviderAssetFailures.has(error.status+":"+error.message));
 return {diagnostic:true,stage:failureStages.has(stage)?stage:"runner-execution",code:recoverable?"EXPORT_FAILED":runnerFailureCode(http??error),...(http&&Number.isInteger(http.status)&&(http.status===0||http.status>=100&&http.status<=599)?{httpStatus:http.status}:{})};
}
export async function runOne(options:RunnerOptions):Promise<RunnerOutcome>{
 const report=(stage:string,error:unknown)=>{if(options.diagnostics)process.stdout.write(JSON.stringify(runnerFailureDiagnostic(stage,error))+"\n");};
 if(options.remoteCheckpoint)invariant(options.recoveryDirectory&&options.client.identity&&options.client.saveCheckpoint&&options.client.listCheckpoints&&options.client.clearCheckpoint,"INVALID_RUNNER_CONFIG");
 let claim;try{claim=await options.client.claim();}catch(error){report("claim",error);throw error;}if(!claim)return {state:"empty"};const {job}=claim;let lease=claim.lease,done=false,heartbeat:Promise<void>|null=null,finalizing=false,heartbeatStopped=false;
 const controller=new AbortController(),abort=()=>controller.abort();options.signal?.addEventListener("abort",abort,{once:true});if(options.signal?.aborted)controller.abort();
 const timeout=setTimeout(abort,18*60*1000),same=(a:AutomationLease,b:AutomationLease)=>["jobId","appId","attemptId","runnerId","credentialEpoch","fence"].every(key=>a[key as keyof AutomationLease]===b[key as keyof AutomationLease]);
 const timer=setInterval(()=>{if(done||heartbeatStopped||heartbeat)return;heartbeat=options.client.heartbeat(lease).then(next=>{invariant(same(lease,next)&&next.expiresAt>Date.now(),"LEASE_EXPIRED");lease=next;}).catch(error=>{if(!done){report("heartbeat",error);controller.abort();}}).finally(()=>{heartbeat=null;});},options.heartbeatMs??30000);
 let directory:string|undefined,journalPath:string|undefined,record:RecoveryJournal|undefined,stage="source";
 try{
  const work=options.workDirectory??tmpdir();await mkdir(work,{recursive:true});directory=await mkdtemp(join(work,"flora-claim-"));
  const grant=await options.client.source(lease),checkout=await options.source.checkout(job,grant,directory,controller.signal);
  if(options.diagnostics)process.stdout.write(diagnosticLine("source-verified")+"\n");
  stage="compiler";invariant(!controller.signal.aborted,"CANCELLED");const exported=await options.executor.execute(job,checkout.directory,controller.signal);
  stage="artifact-validation";
  invariant(exported.commitSha===job.commitSha&&exported.platform===job.platform&&exported.runtimeVersion===job.runtimeVersion,"ARTIFACT_INVALID");
  const uploaded=[];
  stage="asset-upload";
  for(const asset of [exported.launchAsset,...exported.assets]){
   const uploadLease=lease,metadata={key:asset.key,contentType:asset.contentType,fileExtension:asset.fileExtension};let saved:ReturnType<typeof parseOTAAsset>|undefined;
   for(let attempt=0;attempt<3;attempt++){
    invariant(!controller.signal.aborted,"CANCELLED");invariant(uploadLease.expiresAt-Date.now()>=20000,"LEASE_EXPIRED");invariant(sha256(asset.bytes)===asset.digest,"ARTIFACT_INVALID");
    try{saved=parseOTAAsset(await options.client.uploadAsset(uploadLease,metadata,asset.bytes));break;}
    catch(error){if(!transient(error)||attempt===2||uploadLease.expiresAt-Date.now()<20000)throw error;await pause(250*(attempt+1),controller.signal);}
   }
   invariant(saved&&saved.appId===job.appId&&saved.digest===asset.digest&&saved.size===asset.bytes.length&&saved.key===asset.key,"ARTIFACT_INVALID");uploaded.push(saved);
  }
  stage="receipt";const core={jobId:job.id,attemptId:lease.attemptId,commitSha:job.commitSha,configDigest:job.configDigest,toolchainDigest:job.toolchainDigest,sourceArchiveDigest:checkout.sourceDigest,launchAssetId:uploaded[0]!.id,assetIds:uploaded.slice(1).map(asset=>asset.id)};
  const artifactDigest=await automationDigest(automationArtifactPayload(core,uploaded));
  // A heartbeat mutates persisted lease/version state. Stop and drain it before
  // finalization, then renew once and reserve at least 35s for the bounded call.
  stage="publication-heartbeat";heartbeatStopped=true;clearInterval(timer);await heartbeat;invariant(!controller.signal.aborted,"CANCELLED");
  const fresh=await options.client.heartbeat(lease);invariant(same(lease,fresh)&&fresh.expiresAt-Date.now()>=35000,"LEASE_EXPIRED");lease=fresh;
  invariant(!controller.signal.aborted,"CANCELLED");
  const receipt={...core,artifactDigest};
  stage="recovery-journal";if(options.recoveryDirectory){invariant(options.client.identity&&options.client.identity.runnerId===lease.runnerId,"INVALID_RUNNER_CONFIG");record={schemaVersion:1,origin:options.client.identity.origin,lease,receipt};journalPath=await writeRecoveryJournal(options.recoveryDirectory,record);}
  const recoveryInsideCheckout=journalPath&&[await realpath(directory),await realpath(checkout.directory)].some(root=>journalPath!.startsWith(root+sep));
  if(controller.signal.aborted||recoveryInsideCheckout){if(journalPath&&record){try{await clearRecoveryJournal(journalPath,record);}catch{throw new Error("RECOVERY_CLEANUP_UNCONFIRMED");}journalPath=undefined;record=undefined;}throw new Error(recoveryInsideCheckout?"INVALID_RUNNER_CONFIG":"CANCELLED");}
  stage="checkpoint-save";if(options.remoteCheckpoint){try{await options.client.saveCheckpoint!(record!);}catch(error){throw new Error("RECOVERY_CHECKPOINT_UNAVAILABLE",{cause:error});}invariant(lease.expiresAt-Date.now()>=35000,"LEASE_EXPIRED");invariant(!controller.signal.aborted,"CANCELLED");}
  finalizing=true;
  stage="finalize";
  for(let attempt=0;attempt<3;attempt++){
   invariant(!controller.signal.aborted,"CANCELLED");
   try{stage="finalize";const result=await options.client.finalize(lease,receipt);if(record){stage="publication-verification";assertPublicationResult(result,record);stage="recovery-cleanup";await clearRecoveryJournal(journalPath!,record);if(options.remoteCheckpoint){stage="checkpoint-clear";await clearRemoteCheckpoint(options.client,record);}}done=true;return {state:"succeeded",jobId:job.id,platform:job.platform,deploymentId:result.deployment.id};}
   catch(error){if(!transient(error)||attempt===2||lease.expiresAt-Date.now()<11000)throw error;await pause(250*(attempt+1));}
  }
  throw new Error("PUBLICATION_RESULT_UNCONFIRMED");
 }catch(error){
  report(stage,error);
  if(error instanceof Error&&["DOCKER_DAEMON_UNAVAILABLE","ISOLATION_CLEANUP_UNCONFIRMED","RECOVERY_JOURNAL_UNAVAILABLE","RECOVERY_CLEANUP_UNCONFIRMED","RECOVERY_CHECKPOINT_UNAVAILABLE","INVALID_RUNNER_CONFIG"].includes(error.message))throw error;
  if(finalizing&&(journalPath||!(error instanceof RunnerHttpFailure)||transient(error)))return {state:"publication_unknown",jobId:job.id,platform:job.platform,code:"PUBLICATION_REJECTED",...(journalPath?{recoveryJournal:journalPath}:{})};
  if(error instanceof RunnerHttpFailure&&[401,403,409].includes(error.status))throw error;
  const message=error instanceof Error?error.message:"EXPORT_FAILED",allowed:AutomationFailureCode[]=["EXPORT_FAILED","SOURCE_UNAVAILABLE","CONFIG_CHANGED","ARTIFACT_INVALID","CANCELLED","LEASE_EXPIRED","RUNNER_REVOKED"];
  const code=controller.signal.aborted?"CANCELLED":allowed.includes(message as AutomationFailureCode)?message as AutomationFailureCode:finalizing?"PUBLICATION_REJECTED":"EXPORT_FAILED";
  await options.client.fail(lease,code).catch(failure=>report("failure-report",failure));return {state:controller.signal.aborted?"interrupted":"failed",jobId:job.id,platform:job.platform,code};
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
