import {constants} from "node:fs";
import {lstat,mkdir,open,realpath,unlink,readdir} from "node:fs/promises";
import {dirname,isAbsolute,join,resolve} from "node:path";
import {parseAutomationLease,parseAutomationExportReceipt,automationDigest} from "@app-ops/dogfood";
import type {AutomationLease,AutomationExportReceipt,AutomationFinalization} from "@app-ops/dogfood";
import {invariant} from "./artifacts.js";
import type {RunnerClient} from "./client.js";
export interface RecoveryJournal {schemaVersion:1;origin:string;lease:AutomationLease;receipt:AutomationExportReceipt}
export interface RunnerIdentity {origin:string;runnerId:string}
export function parseRecoveryJournal(input:unknown,binding?:RunnerIdentity):RecoveryJournal{
 invariant(input&&typeof input==="object"&&!Array.isArray(input));const value=input as Record<string,unknown>;
 invariant(Object.keys(value).length===4&&Object.keys(value).every(key=>["schemaVersion","origin","lease","receipt"].includes(key))&&value.schemaVersion===1&&typeof value.origin==="string");
 const origin=new URL(value.origin);invariant(origin.origin===value.origin&&!origin.username&&!origin.password&&(origin.protocol==="https:"||origin.protocol==="http:"&&["127.0.0.1","localhost","[::1]"].includes(origin.hostname)));
 const lease=parseAutomationLease(value.lease),receipt=parseAutomationExportReceipt(value.receipt);invariant(lease.jobId===receipt.jobId&&lease.attemptId===receipt.attemptId);
 if(binding)invariant(binding.origin===value.origin&&binding.runnerId===lease.runnerId);
 return {schemaVersion:1,origin:value.origin,lease,receipt};
}
async function privateDirectory(directory:string,create=false):Promise<string>{
 invariant(isAbsolute(directory)&&resolve(directory)===directory);
 if(create){try{await mkdir(directory,{mode:0o700});await syncDirectory(dirname(directory));}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}}
 const stat=await lstat(directory);invariant(stat.isDirectory()&&!stat.isSymbolicLink()&&(stat.mode&0o777)===0o700&&(!process.getuid||stat.uid===process.getuid()) );
 return realpath(directory);
}
async function syncDirectory(directory:string){const handle=await open(directory,constants.O_RDONLY|constants.O_NOFOLLOW);try{await handle.sync();}finally{await handle.close();}}
/** Exclusive, synced, owner-only write before any publication request. No credentials or source material. */
export async function writeRecoveryJournal(directory:string,input:RecoveryJournal):Promise<string>{
 try{const record=parseRecoveryJournal(input);directory=await privateDirectory(directory,true);const path=join(directory,record.lease.jobId+"."+record.lease.attemptId+".json");
  const handle=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await handle.writeFile(JSON.stringify(record)+"\n","utf8");await handle.sync();}finally{await handle.close();}
  await syncDirectory(directory);return path;
 }catch{throw new Error("RECOVERY_JOURNAL_UNAVAILABLE");}
}
export async function readRecoveryJournal(path:string,binding:RunnerIdentity):Promise<RecoveryJournal>{
 try{await privateDirectory(dirname(path));const stat=await lstat(path);invariant(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=16384&&(stat.mode&0o777)===0o600&&(!process.getuid||stat.uid===process.getuid()));
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const current=await handle.stat();invariant(current.ino===stat.ino&&current.dev===stat.dev&&current.isFile()&&current.nlink===1&&current.size<=16384&&(current.mode&0o777)===0o600&&(!process.getuid||current.uid===process.getuid()));const bytes=await handle.readFile();invariant(bytes.length<=16384);return parseRecoveryJournal(JSON.parse(bytes.toString("utf8")),binding);}finally{await handle.close();}
 }catch{throw new Error("INVALID_RECOVERY_JOURNAL");}
}
export function assertPublicationResult(result:AutomationFinalization,record:RecoveryJournal):void{
 const {job,deployment}=result;invariant(job&&deployment&&job.id===record.lease.jobId&&job.appId===record.lease.appId&&job.state==="succeeded"&&job.deploymentId===deployment.id&&deployment.appId===record.lease.appId&&deployment.commitSha===record.receipt.commitSha&&deployment.launchAssetId===record.receipt.launchAssetId&&JSON.stringify(deployment.assetIds)===JSON.stringify(record.receipt.assetIds)&&JSON.stringify(parseAutomationExportReceipt(job.receipt))===JSON.stringify(record.receipt),"PUBLICATION_RESULT_UNCONFIRMED");
}
export async function clearRecoveryJournal(path:string,record:RecoveryJournal):Promise<void>{
 const current=await readRecoveryJournal(path,{origin:record.origin,runnerId:record.lease.runnerId});invariant(JSON.stringify(current)===JSON.stringify(record),"RECOVERY_JOURNAL_CHANGED");await unlink(path);await syncDirectory(dirname(path));
 try{await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}throw new Error("RECOVERY_CLEANUP_UNCONFIRMED");
}
/** Reconciliation has no claim, heartbeat, source/export, upload or fail side effects. */
export async function reconcilePublication(client:Pick<RunnerClient,"identity"|"finalize"|"clearCheckpoint">,path:string,remoteCheckpoint=false):Promise<AutomationFinalization>{
 invariant(client.identity&&(!remoteCheckpoint||client.clearCheckpoint),"INVALID_RUNNER_CONFIG");const record=await readRecoveryJournal(path,client.identity);const result=await client.finalize(record.lease,record.receipt);assertPublicationResult(result,record);await clearRecoveryJournal(path,record);if(remoteCheckpoint)await clearRemoteCheckpoint(client,record);return result;
}

/** A validated result precedes local deletion and remote deletion. Failed deletion stops the controller. */
export async function clearRemoteCheckpoint(client:Pick<RunnerClient,"clearCheckpoint">,record:RecoveryJournal):Promise<void>{
 invariant(client.clearCheckpoint,"INVALID_RUNNER_CONFIG");
 for(let attempt=0;attempt<3;attempt++){
  try{const result=await client.clearCheckpoint(record);invariant(["committed","absent"].includes(result.disposition)&&result.appId===record.lease.appId&&result.jobId===record.lease.jobId&&result.attemptId===record.lease.attemptId&&(result.disposition==="absent"?result.receiptDigest===null:result.receiptDigest===await automationDigest(record.receipt)),"RECOVERY_CHECKPOINT_UNAVAILABLE");return;}
  catch(error){const status=(error as {status?:unknown}).status;if(attempt===2||typeof status!=="number"||status!==0&&status<500)throw new Error("RECOVERY_CHECKPOINT_UNAVAILABLE");}
 }
}

/** Restore durable server receipts onto private disk before reconciling; no new job may be claimed first. */
export async function reconcileRemotePublications(client:Pick<RunnerClient,"identity"|"finalize"|"listCheckpoints"|"clearCheckpoint">,directory:string):Promise<number>{
 invariant(client.identity&&client.listCheckpoints&&client.clearCheckpoint,"INVALID_RUNNER_CONFIG");
 const records=await client.listCheckpoints();directory=await privateDirectory(directory,true);const paths=new Set(await pendingRecoveryJournals(directory));
 for(const input of records){const record=parseRecoveryJournal(input,client.identity),path=join(directory,record.lease.jobId+"."+record.lease.attemptId+".json");
  if(paths.has(path)){const local=await readRecoveryJournal(path,client.identity);invariant(JSON.stringify(local)===JSON.stringify(record),"INVALID_RECOVERY_JOURNAL");}
  else{paths.add(await writeRecoveryJournal(directory,record));}
 }
 for(const path of [...paths].sort()){
  try{await reconcilePublication(client,path,true);}
  catch(error){
   // Only an authoritative expired/stale lease response permits asking the
   // server to prove the original attempt is irrevocably fenced out. The
   // expectedDisposition guard preserves committed or ambiguous receipts.
   invariant(error instanceof Error,"RECOVERY_CHECKPOINT_UNAVAILABLE");
   if((error as {status?:unknown}).status!==409||!["LEASE_STALE","LEASE_EXPIRED"].includes(error.message))throw error;
   const record=await readRecoveryJournal(path,client.identity),proof=await client.clearCheckpoint(record,"stale");
   invariant(proof.disposition==="stale"&&proof.appId===record.lease.appId&&proof.jobId===record.lease.jobId&&proof.attemptId===record.lease.attemptId&&proof.receiptDigest===await automationDigest(record.receipt),"RECOVERY_CHECKPOINT_UNAVAILABLE");
   await clearRecoveryJournal(path,record);
  }
 }
 return paths.size;
}

/** Pending journals block ordinary CLI startup; only explicit reconciliation consumes them. */
export async function pendingRecoveryJournals(directory:string):Promise<string[]>{
 try{await lstat(directory);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return [];throw new Error("RECOVERY_JOURNAL_UNAVAILABLE");}
 try{const canonical=await privateDirectory(directory);const entries=await readdir(canonical);return entries.filter(name=>name.endsWith(".json")).sort().map(name=>join(canonical,name));}catch{throw new Error("RECOVERY_JOURNAL_UNAVAILABLE");}
}
