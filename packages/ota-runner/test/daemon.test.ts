import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {runOne,runDaemon,finishExport,assetMetadata} from "../dist/index.js";
import type {RunnerClient,SourceProvider,ExportExecutor} from "../dist/index.js";
import type {AutomationJob} from "@app-ops/dogfood";
const expectation={platform:"ios" as const,runtimeVersion:"native-1",commitSha:"a".repeat(40)},exported=finishExport(expectation,assetMetadata("launch","bundle",new TextEncoder().encode("fixture")),[]),lease={jobId:"job_fixture",appId:"app_fixture",attemptId:"attempt_fixture",runnerId:"runner_fixture",credentialEpoch:1,fence:1,expiresAt:Date.now()+120000};
const job={...expectation,id:lease.jobId,appId:lease.appId,rootDirectory:".",configDigest:"b".repeat(64),toolchainDigest:"c".repeat(64)} as AutomationJob;
function fixtures(){let claims=0,uploads=0,finalized=0;const client:RunnerClient={async claim(){claims++;return {job,lease};},async heartbeat(){return {...lease,expiresAt:Date.now()+120000};},async source(){return {url:"synthetic",token:"synthetic",commitSha:job.commitSha,expiresAt:lease.expiresAt,maxBytes:64};},async uploadAsset(_lease,metadata,bytes){uploads++;const digest=createHash("sha256").update(bytes).digest();return {...metadata,id:"asset_"+digest.toString("hex"),appId:job.appId,digest:digest.toString("hex"),hash:digest.toString("base64url"),size:bytes.length,createdAt:Date.now()};},async finalize(){finalized++;return {deployment:{id:"deployment_fixture"}} as never;},async fail(){}};const source:SourceProvider={async checkout(_job,_grant,directory){return {directory,root:directory,sourceDigest:"d".repeat(64)};}};const executor:ExportExecutor={async execute(){return exported;}};return {client,source,executor,count:()=>({claims,uploads,finalized})};}
test("known host asset storage failures fail only their prepublication job and keep the real supervisor alive",async t=>{
 const {runnerFailureCode,runnerFailureDiagnostic}=await import("../dist/index.js"),{sanitizedLine,supervise}=await import(new URL("../../../scripts/local-runner/supervisor.mjs",import.meta.url).href);
 for(const code of ["ASSET_STORAGE_RATE_LIMITED","ASSET_STORAGE_UNAVAILABLE","ASSET_STORAGE_CAPACITY","ASSET_STORAGE_CONFLICT"])await t.test(code,async sub=>{
  const fixture=fixtures(),lines:string[]=[],write=process.stdout.write;let failed=0,uploads=0;
  sub.mock.method(process.stdout,"write",function(line:string|Uint8Array,...args:unknown[]){if(typeof line==="string"&&line.startsWith('{"diagnostic":')){lines.push(line);return true;}return Reflect.apply(write,process.stdout,[line,...args]);});
  fixture.client.uploadAsset=async()=>{uploads++;throw Error(code);};fixture.client.fail=async(_lease,reason)=>{failed++;assert.equal(reason,"EXPORT_FAILED");};
  const outcome=await runOne({...fixture,diagnostics:true});assert.equal(outcome.state,"failed");assert.equal(outcome.code,"EXPORT_FAILED");assert.equal(failed,1);assert.equal(uploads,1,"host provider mutations are never retried here");assert.equal(fixture.count().finalized,0);
  const diagnostic=lines.map(line=>JSON.parse(line)).find(row=>row.stage==="asset-upload");assert.deepEqual(diagnostic,{diagnostic:true,stage:"asset-upload",code:"EXPORT_FAILED"});
  const records=[...lines,JSON.stringify(outcome)].map(sanitizedLine).filter(Boolean),controller=new AbortController();let claims=0;
  assert.equal(await supervise({runtimeDirectory:"/private/fixture",path:"/usr/bin:/bin",limaHome:"/private/lima",dockerHost:"unix:///private/docker.sock",nodePath:process.execPath,runnerMain:"/private/main.js",runnerConfigs:["/private/app.json"],pollIntervalMs:30000},{signal:controller.signal,presence:false,health:async()=>({ok:true}),run:async()=>{claims++;return {exitCode:1,records};},pause:async()=>controller.abort(),log:async()=>{},fatal:async()=>assert.fail("a completed failed storage job must not stop all apps")}),0);
  assert.equal(claims,1);assert.equal(runnerFailureCode(Error(code)),"RUNNER_STOPPED");for(const stage of ["claim","source","compiler","finalize","recovery-journal"])assert.equal(runnerFailureDiagnostic(stage,Error(code)).code,"RUNNER_STOPPED","outside the upload stage fatal classification remains");
 });
});
test("storage labels cannot soften HTTP authority failures or unknown and finalization diagnostics",async()=>{
 const {runnerFailureDiagnostic,RunnerHttpFailure}=await import("../dist/index.js");
 for(const status of [401,403,409]){const fixture=fixtures();const failure=new RunnerHttpFailure(status,"ASSET_STORAGE_UNAVAILABLE");fixture.client.uploadAsset=async()=>{throw failure;};await assert.rejects(runOne(fixture),error=>error===failure);assert.equal(runnerFailureDiagnostic("asset-upload",failure).code,"RUNNER_REQUEST_REJECTED");assert.equal(runnerFailureDiagnostic("asset-upload",failure).httpStatus,status);}
 assert.equal(runnerFailureDiagnostic("asset-upload",Error("ASSET_STORAGE_UNKNOWN_PRIVATE_TEXT")).code,"RUNNER_STOPPED");
 const fixture=fixtures();fixture.client.finalize=async()=>{throw Error("ASSET_STORAGE_UNAVAILABLE");};assert.equal((await runOne(fixture)).state,"publication_unknown");
});
test("exact backend GitHub provider backpressure keeps asset job failure recoverable in the supervisor",async t=>{
 const {RunnerHttpFailure,runnerFailureDiagnostic}=await import("../dist/index.js"),{sanitizedLine,supervise}=await import(new URL("../../../scripts/local-runner/supervisor.mjs",import.meta.url).href);
 for(const [status,code] of [[429,"GITHUB_ASSET_RATE_LIMIT"],[429,"GITHUB_ASSET_BUSY"],[503,"GITHUB_ASSET_UNAVAILABLE"]] as const)await t.test(code,async sub=>{
  const fixture=fixtures(),lines:string[]=[],write=process.stdout.write;let uploads=0,failed=0;
  sub.mock.method(process.stdout,"write",function(line:string|Uint8Array,...args:unknown[]){if(typeof line==="string"&&line.startsWith('{"diagnostic":')){lines.push(line);return true;}return Reflect.apply(write,process.stdout,[line,...args]);});
  fixture.client.uploadAsset=async()=>{uploads++;throw new RunnerHttpFailure(status,code);};fixture.client.fail=async(_lease,reason)=>{failed++;assert.equal(reason,"EXPORT_FAILED");};
  const outcome=await runOne({...fixture,diagnostics:true});assert.equal(outcome.state,"failed");assert.equal(outcome.code,"EXPORT_FAILED");assert.equal(failed,1);assert.equal(fixture.count().finalized,0);assert.equal(uploads,status===503?3:1,"only existing bounded server-error retries remain");
  const diagnostic=lines.map(line=>JSON.parse(line)).find(row=>row.stage==="asset-upload");assert.deepEqual(diagnostic,{diagnostic:true,stage:"asset-upload",code:"EXPORT_FAILED",httpStatus:status});
  const controller=new AbortController(),records=[...lines,JSON.stringify(outcome)].map(sanitizedLine).filter(Boolean);
  assert.equal(await supervise({runtimeDirectory:"/private/fixture",path:"/usr/bin:/bin",limaHome:"/private/lima",dockerHost:"unix:///private/docker.sock",nodePath:process.execPath,runnerMain:"/private/main.js",runnerConfigs:["/private/app.json"],pollIntervalMs:30000},{signal:controller.signal,presence:false,health:async()=>({ok:true}),run:async()=>({exitCode:1,records}),pause:async()=>controller.abort(),log:async()=>{},fatal:async()=>assert.fail("known provider backpressure must not latch the service")}),0);
  for(const stage of ["claim","source","compiler","finalize","recovery-journal"])assert.equal(runnerFailureDiagnostic(stage,new RunnerHttpFailure(status,code)).code,"RUNNER_REQUEST_REJECTED");
 });
});
test("backend storage recovery classification rejects mismatched statuses integrity errors and wrapped causes",async()=>{
 const {RunnerHttpFailure,runnerFailureDiagnostic}=await import("../dist/index.js");
 for(const [status,code] of [[401,"GITHUB_ASSET_RATE_LIMIT"],[403,"GITHUB_ASSET_BUSY"],[409,"GITHUB_ASSET_UNAVAILABLE"],[503,"GITHUB_ASSET_RATE_LIMIT"],[429,"GITHUB_ASSET_UNAVAILABLE"],[503,"GITHUB_ASSET_INTEGRITY"],[429,"GITHUB_ASSET_UNKNOWN"]] as const){const failure=new RunnerHttpFailure(status,code),diagnostic=runnerFailureDiagnostic("asset-upload",failure);assert.equal(diagnostic.code,"RUNNER_REQUEST_REJECTED");assert.equal(diagnostic.httpStatus,status);}
 assert.equal(runnerFailureDiagnostic("asset-upload",Error("ASSET_STORAGE_UNAVAILABLE",{cause:new RunnerHttpFailure(403,"FORBIDDEN")})).code,"FORBIDDEN");
 assert.equal(runnerFailureDiagnostic("asset-upload",Error("UNKNOWN_CONTROL",{cause:new RunnerHttpFailure(503,"GITHUB_ASSET_UNAVAILABLE")})).code,"RUNNER_REQUEST_REJECTED");
 for(const cause of [Error("FORBIDDEN"),Error("wrapped",{cause:new RunnerHttpFailure(403,"FORBIDDEN")})])assert.equal(runnerFailureDiagnostic("asset-upload",Error("ASSET_STORAGE_UNAVAILABLE",{cause})).code,"RUNNER_STOPPED","host recovery never conceals a nested control failure");
});
test("pending heartbeat drains and no heartbeat mutates the lease during finalization",async()=>{
 const fixture=fixtures();let heartbeats=0,resolvePending!:()=>void;const started=new Promise<void>(resolve=>{fixture.client.heartbeat=async()=>{heartbeats++;if(heartbeats===1){resolve();await new Promise<void>(r=>{resolvePending=r;});}return {...lease,expiresAt:Date.now()+120000};};});
 fixture.executor.execute=async()=>{await started;setTimeout(resolvePending,20);return exported;};
 fixture.client.finalize=async()=>{assert.equal(heartbeats,2,"drained pending heartbeat and renewed once");await new Promise(r=>setTimeout(r,30));assert.equal(heartbeats,2,"timer stayed stopped during finalization");return {deployment:{id:"deployment_fixture"}} as never;};
 const outcome=await runOne({...fixture,heartbeatMs:5});assert.equal(outcome.state,"succeeded");assert.equal(outcome.platform,"ios");assert.equal(outcome.deploymentId,"deployment_fixture");
});
test("uncertain isolation cleanup stops the daemon before upload or another claim",async()=>{
 const fixture=fixtures();fixture.executor.execute=async()=>{throw new Error("ISOLATION_CLEANUP_UNCONFIRMED");};await assert.rejects(runDaemon(fixture),/ISOLATION_CLEANUP_UNCONFIRMED/);assert.deepEqual(fixture.count(),{claims:1,uploads:0,finalized:0});
});
test("Docker availability loss after claim remains fatal even when optional diagnostics are disabled",async()=>{
 const fixture=fixtures();let failureReports=0;fixture.client.fail=async()=>{failureReports++;};fixture.executor.execute=async()=>{throw new Error("DOCKER_DAEMON_UNAVAILABLE");};
 await assert.rejects(runOne(fixture),/^Error: DOCKER_DAEMON_UNAVAILABLE$/);assert.deepEqual(fixture.count(),{claims:1,uploads:0,finalized:0});assert.equal(failureReports,0,'do not disguise isolation loss as a completed normal export failure');
});
test("runtime substitution and lease cancellation never reach publication",async()=>{
 const mismatch=fixtures();mismatch.executor.execute=async()=>({...exported,runtimeVersion:"other-native"});assert.equal((await runOne(mismatch)).state,"failed");assert.equal(mismatch.count().uploads,0);
 const cancelled=fixtures();cancelled.client.heartbeat=async()=>{throw new Error("LEASE_STALE");};cancelled.executor.execute=async(_job,_source,signal)=>{await new Promise<void>(resolve=>{signal.addEventListener("abort",()=>resolve(),{once:true});});return exported;};assert.equal((await runOne({...cancelled,heartbeatMs:5})).state,"interrupted");assert.equal(cancelled.count().finalized,0);assert.equal(cancelled.count().uploads,0);
});
test("daemon retries only transient claim failures with a bounded budget",async()=>{
 const {RunnerHttpFailure}=await import("../dist/index.js");const fixture=fixtures();const stop=new AbortController();let claims=0;
 fixture.client.claim=async()=>{claims++;if(claims<3)throw new RunnerHttpFailure(claims===1?0:503,"UNAVAILABLE");stop.abort();return null;};
 await runDaemon({...fixture,signal:stop.signal});assert.equal(claims,3);assert.equal(fixture.count().uploads,0);
 claims=0;fixture.client.claim=async()=>{claims++;throw new RunnerHttpFailure(403,"RUNNER_REVOKED");};await assert.rejects(runDaemon(fixture),/RUNNER_REVOKED/);assert.equal(claims,1);
 claims=0;fixture.client.claim=async()=>{claims++;throw new RunnerHttpFailure(503,"UNAVAILABLE");};await assert.rejects(runDaemon(fixture),/UNAVAILABLE/);assert.equal(claims,3);
});
test("recovery write failure stops before publication or another claim",async t=>{
 const {mkdtemp,mkdir,rm}=await import("node:fs/promises"),{tmpdir}=await import("node:os"),{join}=await import("node:path");const root=await mkdtemp(join(tmpdir(),"flora-journal-failure-"));t.after(()=>rm(root,{recursive:true,force:true}));const exposed=join(root,"exposed");await mkdir(exposed,{mode:0o755});
 const fixture=fixtures();await assert.rejects(runDaemon({...fixture,client:{...fixture.client,identity:{origin:"https://flora.example.test",runnerId:lease.runnerId}},recoveryDirectory:exposed}),/RECOVERY_JOURNAL_UNAVAILABLE/);assert.equal(fixture.count().claims,1);assert.equal(fixture.count().finalized,0);
});
test("abort during durable journal I/O prevents the first publication and removes only its unsubmitted record",async t=>{
 const {mkdtemp,rm,readdir}=await import("node:fs/promises"),{tmpdir}=await import("node:os"),{join}=await import("node:path");const root=await mkdtemp(join(tmpdir(),"flora-journal-abort-"));t.after(()=>rm(root,{recursive:true,force:true}));const fixture=fixtures(),controller=new AbortController();
 fixture.client.heartbeat=async()=>{setTimeout(()=>controller.abort(),0);return {...lease,expiresAt:Date.now()+120000};};
 const outcome=await runOne({...fixture,client:{...fixture.client,identity:{origin:"https://flora.example.test",runnerId:lease.runnerId}},signal:controller.signal,recoveryDirectory:join(root,"recovery")});
 assert.equal(outcome.state,"interrupted");assert.equal(fixture.count().finalized,0);assert.deepEqual(await readdir(join(root,"recovery")),[]);
});
test("abort after a sent publication stops replay and retains the original uncertain journal",async t=>{
 const {mkdtemp,rm,lstat}=await import("node:fs/promises"),{tmpdir}=await import("node:os"),{join}=await import("node:path"),{RunnerHttpFailure}=await import("../dist/index.js");const root=await mkdtemp(join(tmpdir(),"flora-retry-abort-"));t.after(()=>rm(root,{recursive:true,force:true}));const fixture=fixtures(),controller=new AbortController();let finalizations=0;
 fixture.client.finalize=async()=>{finalizations++;setTimeout(()=>controller.abort(),0);throw new RunnerHttpFailure(0,"RESPONSE_LOST");};
 const outcome=await runOne({...fixture,client:{...fixture.client,identity:{origin:"https://flora.example.test",runnerId:lease.runnerId}},signal:controller.signal,recoveryDirectory:join(root,"recovery")});assert.equal(outcome.state,"publication_unknown");assert.equal(finalizations,1);assert.ok(outcome.recoveryJournal);assert.ok(await lstat(outcome.recoveryJournal));
});
test("a recovery directory inside the exporter checkout is rejected before publication",async t=>{
 const {mkdtemp,rm,readdir}=await import("node:fs/promises"),{tmpdir}=await import("node:os"),{join}=await import("node:path");const root=await mkdtemp(join(tmpdir(),"flora-recovery-boundary-"));t.after(()=>rm(root,{recursive:true,force:true}));const fixture=fixtures();fixture.source.checkout=async()=>({directory:root,root,sourceDigest:"d".repeat(64)});
 await assert.rejects(runOne({...fixture,client:{...fixture.client,identity:{origin:"https://flora.example.test",runnerId:lease.runnerId}},recoveryDirectory:join(root,"recovery")}),/INVALID_RUNNER_CONFIG/);assert.equal(fixture.count().finalized,0);assert.deepEqual(await readdir(join(root,"recovery")),[]);
});
test("hosted publication waits for durable remote checkpoint and clears it only after exact success",async t=>{
 const {mkdtemp,rm,lstat}=await import("node:fs/promises"),{tmpdir}=await import("node:os"),{join}=await import("node:path");const root=await mkdtemp(join(tmpdir(),"flora-remote-checkpoint-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const fixture=fixtures(),events:string[]=[];let saved:import("../dist/index.js").RecoveryJournal|undefined;
 const client={...fixture.client,identity:{origin:"https://flora.example.test",runnerId:lease.runnerId},
  async saveCheckpoint(record:import("../dist/index.js").RecoveryJournal){assert.ok(await lstat(join(root,"recovery",record.lease.jobId+"."+record.lease.attemptId+".json")));events.push("saved");saved=record;},
  async listCheckpoints(){return [];},async clearCheckpoint(record:import("../dist/index.js").RecoveryJournal){assert.equal(record,saved);events.push("cleared");const {automationDigest}=await import("@app-ops/dogfood");return {disposition:"committed" as const,appId:record.lease.appId,jobId:record.lease.jobId,attemptId:record.lease.attemptId,receiptDigest:await automationDigest(record.receipt)};},
  async finalize(_lease:unknown,receipt:import("@app-ops/dogfood").AutomationExportReceipt){assert.equal(saved?.receipt,receipt);events.push("finalized");return {job:{...job,state:"succeeded" as const,deploymentId:"deployment_fixture",receipt},deployment:{id:"deployment_fixture",appId:job.appId,commitSha:receipt.commitSha,launchAssetId:receipt.launchAssetId,assetIds:receipt.assetIds}} as never;}
 };
 const result=await runOne({...fixture,client,recoveryDirectory:join(root,"recovery"),remoteCheckpoint:true} as never);
 assert.equal(result.state,"succeeded");assert.deepEqual(events,["saved","finalized","cleared"]);
});
test("remote checkpoint failure retains private evidence and prevents publication",async t=>{
 const {mkdtemp,rm,readdir}=await import("node:fs/promises"),{tmpdir}=await import("node:os"),{join}=await import("node:path");const root=await mkdtemp(join(tmpdir(),"flora-remote-failure-"));t.after(()=>rm(root,{recursive:true,force:true}));const fixture=fixtures();let finalized=0;
 const client={...fixture.client,identity:{origin:"https://flora.example.test",runnerId:lease.runnerId},async saveCheckpoint(){throw new Error("unavailable");},async listCheckpoints(){return [];},async clearCheckpoint(){throw new Error("must not clear");},async finalize(){finalized++;return {deployment:{id:"deployment_fixture"}} as never;}};
 await assert.rejects(runOne({...fixture,client,recoveryDirectory:join(root,"recovery"),remoteCheckpoint:true} as never),/RECOVERY_CHECKPOINT_UNAVAILABLE/);assert.equal(finalized,0);assert.equal((await readdir(join(root,"recovery"))).length,1);
});
test("asset upload retries transient responses with identical bytes metadata and fenced lease",async()=>{
 const {RunnerHttpFailure}=await import("../dist/index.js");const fixture=fixtures(),original=fixture.client.uploadAsset,seen:{lease:unknown;metadata:unknown;bytes:Buffer}[]=[];
 fixture.client.uploadAsset=async(actualLease,metadata,bytes)=>{seen.push({lease:structuredClone(actualLease),metadata:structuredClone(metadata),bytes:Buffer.from(bytes)});if(seen.length<3)throw new RunnerHttpFailure(seen.length===1?0:503,"UNAVAILABLE");return original(actualLease,metadata,bytes);};
 assert.equal((await runOne(fixture)).state,"succeeded");assert.equal(seen.length,3);assert.deepEqual(seen[1],seen[0]);assert.deepEqual(seen[2],seen[0]);assert.equal(fixture.count().uploads,1);
});
test("authoritative upload rejection and cancellation never retry or finalize",async()=>{
 const {RunnerHttpFailure}=await import("../dist/index.js");const rejected=fixtures();let calls=0;rejected.client.uploadAsset=async()=>{calls++;throw new RunnerHttpFailure(403,"RUNNER_REVOKED");};await assert.rejects(runOne(rejected),/RUNNER_REVOKED/);assert.equal(calls,1);assert.equal(rejected.count().finalized,0);
 const cancelled=fixtures(),controller=new AbortController();calls=0;cancelled.client.uploadAsset=async()=>{calls++;setTimeout(()=>controller.abort(),10);throw new RunnerHttpFailure(503,"UNAVAILABLE");};assert.equal((await runOne({...cancelled,signal:controller.signal})).state,"interrupted");assert.equal(calls,1);assert.equal(cancelled.count().finalized,0);
});
test("upload failures expose only their fixed phase HTTP status and allowlisted code",async t=>{
 const {RunnerHttpFailure}=await import("../dist/index.js");
 for(const [status,code,safeCode] of [[400,"INVALID_INPUT","INVALID_INPUT"],[409,"BUSY","BUSY"],[409,"LEASE_STALE","LEASE_STALE"],[409,"IDEMPOTENCY_CONFLICT","IDEMPOTENCY_CONFLICT"],[400,"PRIVATE_BEARER_CREDENTIAL","RUNNER_REQUEST_REJECTED"]] as const)await t.test(status+" "+safeCode,async sub=>{
  const fixture=fixtures(),output:string[]=[],write=process.stdout.write;sub.mock.method(process.stdout,"write",function(line:string|Uint8Array,...args:unknown[]){if(typeof line==="string"&&line.startsWith('{"diagnostic":')){output.push(line);return true;}return Reflect.apply(write,process.stdout,[line,...args]);});
  let calls=0;fixture.client.uploadAsset=async()=>{calls++;throw new RunnerHttpFailure(status,code);};
  if(status===409)await assert.rejects(runOne({...fixture,diagnostics:true}),error=>error instanceof RunnerHttpFailure&&error.status===status&&error.message===code);
  else assert.equal((await runOne({...fixture,diagnostics:true})).state,"failed");
  assert.equal(calls,1);assert.equal(fixture.count().finalized,0);
  assert.ok(output.map(line=>JSON.parse(line)).some(value=>value.stage==="asset-upload"&&value.httpStatus===status&&value.code===safeCode));
  assert.ok(!output.join("").includes("PRIVATE_BEARER_CREDENTIAL"));
 });
});
test("finalization diagnostics preserve the uncertain journal without exposing receipt or credentials",async t=>{
 const {mkdtemp,rm,lstat}=await import("node:fs/promises"),{tmpdir}=await import("node:os"),{join}=await import("node:path"),{RunnerHttpFailure}=await import("../dist/index.js");
 const root=await mkdtemp(join(tmpdir(),"flora-finalize-diagnostic-"));t.after(()=>rm(root,{recursive:true,force:true}));const fixture=fixtures(),output:string[]=[],write=process.stdout.write;t.mock.method(process.stdout,"write",function(line:string|Uint8Array,...args:unknown[]){if(typeof line==="string"&&line.startsWith('{"diagnostic":')){output.push(line);return true;}return Reflect.apply(write,process.stdout,[line,...args]);});
 let failed=0;fixture.client.finalize=async()=>{throw new RunnerHttpFailure(409,"CONFIG_CONFLICT");};fixture.client.fail=async()=>{failed++;};
 const outcome=await runOne({...fixture,client:{...fixture.client,identity:{origin:"https://flora.example.test",runnerId:lease.runnerId}},diagnostics:true,recoveryDirectory:join(root,"recovery")});
 assert.equal(outcome.state,"publication_unknown");assert.equal(failed,0);assert.ok(outcome.recoveryJournal);assert.ok(await lstat(outcome.recoveryJournal));
 assert.ok(output.map(line=>JSON.parse(line)).some(value=>value.stage==="finalize"&&value.httpStatus===409&&value.code==="CONFIG_CONFLICT"));
 assert.ok(!output.join("").includes(root));assert.ok(!output.join("").includes(job.configDigest));
});
