import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,rm,readFile,lstat,chmod,symlink,link,writeFile,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {writeRecoveryJournal,readRecoveryJournal,clearRecoveryJournal,reconcilePublication,reconcileRemotePublications} from "../dist/index.js";
import type {AutomationFinalization} from "@app-ops/dogfood";
const lease={jobId:"job_one",appId:"app_one",attemptId:"attempt_one",runnerId:"runner_one",credentialEpoch:1,fence:1,expiresAt:Date.now()+120000};
const receipt={jobId:lease.jobId,attemptId:lease.attemptId,commitSha:"a".repeat(40),configDigest:"b".repeat(64),toolchainDigest:"c".repeat(64),sourceArchiveDigest:"d".repeat(64),launchAssetId:"asset_"+"e".repeat(64),assetIds:[],artifactDigest:"f".repeat(64)};
const record={schemaVersion:1 as const,origin:"https://flora.example.com",lease,receipt};
const result={job:{id:lease.jobId,appId:lease.appId,state:"succeeded",receipt,deploymentId:"deployment_one"},deployment:{id:"deployment_one",appId:lease.appId,commitSha:receipt.commitSha,launchAssetId:receipt.launchAssetId,assetIds:[]}} as unknown as AutomationFinalization;
test("private durable recovery journal excludes secrets and refuses replacement",async t=>{
 const root=await mkdtemp(join(tmpdir(),"flora-recovery-"));t.after(()=>rm(root,{recursive:true,force:true}));const directory=join(root,"recovery"),path=await writeRecoveryJournal(directory,record);
 assert.equal((await lstat(directory)).mode&0o777,0o700);assert.equal((await lstat(path)).mode&0o777,0o600);assert.deepEqual(await readRecoveryJournal(path,{origin:record.origin,runnerId:lease.runnerId}),record);
 assert.deepEqual(Object.keys(JSON.parse(await readFile(path,"utf8"))),["schemaVersion","origin","lease","receipt"]);
 await assert.rejects(writeRecoveryJournal(directory,record),/RECOVERY_JOURNAL_UNAVAILABLE/);assert.equal((await readdir(directory)).length,1);
 await assert.rejects(readRecoveryJournal(path,{origin:"https://another.example.com",runnerId:lease.runnerId}),/INVALID_RECOVERY_JOURNAL/);
 await assert.rejects(readRecoveryJournal(path,{origin:record.origin,runnerId:"runner_other"}),/INVALID_RECOVERY_JOURNAL/);
 await clearRecoveryJournal(path,record);assert.deepEqual(await readdir(directory),[]);
});
test("journal rejects symlinks, hardlinks, exposed permissions and additional fields",async t=>{
 const root=await mkdtemp(join(tmpdir(),"flora-recovery-"));t.after(()=>rm(root,{recursive:true,force:true}));const path=await writeRecoveryJournal(join(root,"recovery"),record),binding={origin:record.origin,runnerId:lease.runnerId};
 const alias=join(root,"alias");await symlink(path,alias);await assert.rejects(readRecoveryJournal(alias,binding),/INVALID_RECOVERY_JOURNAL/);await rm(alias);await link(path,alias);await assert.rejects(readRecoveryJournal(path,binding),/INVALID_RECOVERY_JOURNAL/);await rm(alias);
 await chmod(path,0o640);await assert.rejects(readRecoveryJournal(path,binding),/INVALID_RECOVERY_JOURNAL/);await chmod(path,0o600);
 await writeFile(path,JSON.stringify({...record,token:"must-never-be-stored"}));await assert.rejects(readRecoveryJournal(path,binding),/INVALID_RECOVERY_JOURNAL/);
 const exposed=join(root,"exposed");await mkdir(exposed,{mode:0o755});await assert.rejects(writeRecoveryJournal(exposed,record),/RECOVERY_JOURNAL_UNAVAILABLE/);
 const linked=join(root,"linked");await symlink(join(root,"recovery"),linked);await assert.rejects(writeRecoveryJournal(linked,record),/RECOVERY_JOURNAL_UNAVAILABLE/);
});
test("reconciliation replays exactly the saved receipt and clears only the verified original result",async t=>{
 const root=await mkdtemp(join(tmpdir(),"flora-recovery-"));t.after(()=>rm(root,{recursive:true,force:true}));const path=await writeRecoveryJournal(join(root,"recovery"),record);
 let calls=0;const client={identity:{origin:record.origin,runnerId:lease.runnerId},async finalize(actualLease:unknown,actualReceipt:unknown){calls++;assert.deepEqual(actualLease,lease);assert.deepEqual(actualReceipt,receipt);return result;}};
 await reconcilePublication(client,path);assert.equal(calls,1);await assert.rejects(lstat(path),{code:"ENOENT"});
 const otherPath=await writeRecoveryJournal(join(root,"recovery"),record);client.finalize=async()=>({...result,job:{...result.job,appId:"app_other"}});
 await assert.rejects(reconcilePublication(client,otherPath),/PUBLICATION_RESULT_UNCONFIRMED/);assert.ok(await lstat(otherPath));
 client.finalize=async()=>{throw new Error("LEASE_EXPIRED");};await assert.rejects(reconcilePublication(client,otherPath),/LEASE_EXPIRED/);assert.ok(await lstat(otherPath));
});
test("fresh hosted VM restores and reconciles remote receipt before clearing any recovery record",async t=>{
 const root=await mkdtemp(join(tmpdir(),"flora-remote-restore-"));t.after(()=>rm(root,{recursive:true,force:true}));const directory=join(root,"recovery"),events:string[]=[];
 const client={identity:{origin:record.origin,runnerId:lease.runnerId},async listCheckpoints(){events.push("list");return [record];},
  async finalize(actualLease:unknown,actualReceipt:unknown){events.push("finalize");assert.deepEqual(actualLease,lease);assert.deepEqual(actualReceipt,receipt);const path=join(directory,lease.jobId+"."+lease.attemptId+".json");assert.deepEqual(await readRecoveryJournal(path,this.identity),record);return result;},
  async clearCheckpoint(actual:unknown){events.push("clear");assert.deepEqual(actual,record);assert.deepEqual(await readdir(directory),[]);const {automationDigest}=await import("@app-ops/dogfood");return {disposition:"committed" as const,appId:lease.appId,jobId:lease.jobId,attemptId:lease.attemptId,receiptDigest:await automationDigest(record.receipt)};}
 };
 assert.equal(await reconcileRemotePublications(client,directory),1);assert.deepEqual(events,["list","finalize","clear"]);assert.deepEqual(await readdir(directory),[]);
});
test("hosted reconciliation rejects foreign or changed remote receipts and retains local proof on failed finalize",async t=>{
 const root=await mkdtemp(join(tmpdir(),"flora-remote-binding-"));t.after(()=>rm(root,{recursive:true,force:true}));const directory=join(root,"recovery");let clears=0;
 const client={identity:{origin:record.origin,runnerId:lease.runnerId},async listCheckpoints(){return [record];},async finalize(){throw new Error("LEASE_STALE");},async clearCheckpoint(){clears++;return {disposition:"committed" as const,appId:lease.appId,jobId:lease.jobId,attemptId:lease.attemptId,receiptDigest:"proof"};}};
 await assert.rejects(reconcileRemotePublications(client,directory),/LEASE_STALE/);assert.equal(clears,0);assert.equal((await readdir(directory)).length,1);
 client.listCheckpoints=async()=>[{...record,receipt:{...receipt,artifactDigest:"1".repeat(64)}}];await assert.rejects(reconcileRemotePublications(client,directory),/INVALID_RECOVERY_JOURNAL/);assert.equal(clears,0);
 client.listCheckpoints=async()=>[{...record,lease:{...lease,runnerId:"runner_foreign"}}];await assert.rejects(reconcileRemotePublications(client,directory));assert.equal(clears,0);
});
test("crash before finalization discards only an authoritative stale checkpoint and preserves ambiguous proof",async t=>{
 const {RunnerHttpFailure}=await import("../dist/index.js"),{automationDigest}=await import("@app-ops/dogfood");const root=await mkdtemp(join(tmpdir(),"flora-stale-checkpoint-"));t.after(()=>rm(root,{recursive:true,force:true}));const directory=join(root,"recovery");let clears=0;
 const client={identity:{origin:record.origin,runnerId:lease.runnerId},async listCheckpoints(){return [record];},async finalize(){throw new RunnerHttpFailure(409,"LEASE_EXPIRED");},async clearCheckpoint(input:unknown,expected?:string){clears++;assert.deepEqual(input,record);assert.equal(expected,"stale");return {disposition:"stale" as "stale"|"committed"|"absent",appId:lease.appId,jobId:lease.jobId,attemptId:lease.attemptId,receiptDigest:await automationDigest(record.receipt)};}};
 assert.equal(await reconcileRemotePublications(client,directory),1);assert.equal(clears,1);assert.deepEqual(await readdir(directory),[]);
 client.clearCheckpoint=async()=>{clears++;return {disposition:"absent",appId:lease.appId,jobId:lease.jobId,attemptId:lease.attemptId,receiptDigest:"proof"};};await assert.rejects(reconcileRemotePublications(client,directory),/RECOVERY_CHECKPOINT_UNAVAILABLE/);assert.equal((await readdir(directory)).length,1);
 client.clearCheckpoint=async()=>{clears++;throw new RunnerHttpFailure(0,"RUNNER_TRANSPORT_UNAVAILABLE");};await assert.rejects(reconcileRemotePublications(client,directory),/RUNNER_TRANSPORT_UNAVAILABLE/);assert.equal((await readdir(directory)).length,1);
 client.finalize=async()=>{throw new RunnerHttpFailure(503,"SERVER_UNAVAILABLE");};const previous=clears;await assert.rejects(reconcileRemotePublications(client,directory),/SERVER_UNAVAILABLE/);assert.equal(clears,previous);
});
