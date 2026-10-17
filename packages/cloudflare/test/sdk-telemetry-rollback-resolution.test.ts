import test from "node:test";
import assert from "node:assert/strict";
import { createHmac,randomUUID } from "node:crypto";
import { createTestRuntime } from "./runtime.ts";

const now=1_800_000_000_000,origin="https://telemetry.example.test";
async function fixture(t:test.TestContext){
 const runtime=await createTestRuntime({entrypoint:new URL("./fixtures/sdk-telemetry-entry.ts",import.meta.url),durableObjects:{TELEMETRY:"TelemetryFixture"}});t.after(()=>runtime.dispose());
 await runtime.d1.exec(`CREATE TABLE flora_deployment(singleton INTEGER PRIMARY KEY,owner_id TEXT,origin TEXT,db_identity TEXT);
CREATE TABLE applications(owner_id TEXT,id TEXT,PRIMARY KEY(owner_id,id));
CREATE TABLE ota_deployments(owner_id TEXT,app_id TEXT,id TEXT,platform TEXT,channel TEXT,runtime_version TEXT,created_at INTEGER,data TEXT,PRIMARY KEY(owner_id,app_id,id));`);
 await runtime.d1.prepare("INSERT INTO flora_deployment VALUES(1,?,?,?)").bind("owner_a",origin,"db_a").run();
 const cases:Array<{appId:string;platform:string;target:string;source:string;rollback:string;installationId:string}>=[];
 for(const name of ["isso","promise","reward"]){
  const appId="application_"+name;await runtime.d1.prepare("INSERT INTO applications VALUES(?,?)").bind("owner_a",appId).run();
  for(const platform of ["ios","android"]){
   const target=randomUUID(),source=randomUUID(),rollback=randomUUID(),installationId=randomUUID();
   const item={appId,platform,target,source,rollback,installationId};cases.push(item);
   for(const [id,createdAt,data] of [[target,now-3000,{}],[source,now-2000,{}],[rollback,now-1000,{rollback:{fromDeploymentId:source,targetDeploymentId:target,reason:"Verified safe rollback",requestedAt:now-1000}}]] as const)
    await runtime.d1.prepare("INSERT INTO ota_deployments VALUES(?,?,?,?,?,?,?,?)").bind("owner_a",appId,id,platform,"verification","native-v1",createdAt,JSON.stringify(data)).run();
  }
 }
 const call=async(op:string,input:unknown=null,extra:Record<string,unknown>={})=>{const response=await runtime.fetch(origin,{method:"POST",body:JSON.stringify({op,input,now,...extra})});return {status:response.status,value:await response.json() as any};};
 const session=async(item:typeof cases[number],deploymentId=item.source,installationId=item.installationId)=>{
  const result=await call("session",{installationId,deploymentId,platform:item.platform,channel:"verification",runtimeVersion:"native-v1",environment:item.platform==="ios"?"ios-simulator":"android-emulator"},{appId:item.appId});assert.equal(result.status,200,JSON.stringify(result));return result.value.token;
 };
 const post=async(item:typeof cases[number],token:string,events:any[],extra={})=>{const result=await call("report",{token,events},{appId:item.appId,...extra});assert.equal(result.status,200,JSON.stringify(result));return result.value;};
 const latest=async(item:typeof cases[number],deploymentId=item.source)=>(await call("latest",[{appId:item.appId,deploymentId}])).value[JSON.stringify([item.appId,deploymentId])];
 const detail=async(item:typeof cases[number],deploymentId=item.source,filter="all")=>(await call("detail",null,{appId:item.appId,deploymentId,filter})).value;
 return {runtime,cases,call,session,post,latest,detail};
}
const event=(type:string,observedAt=now,extra:Record<string,unknown>={})=>({id:randomUUID(),type,observedAt,...extra});
const failure=(at=now)=>event("failed",at,{stage:"launch",code:"UNCONFIRMED_LAUNCH"});
const confirmations=(at=now+10)=>[event("launch_confirmed",at),event("restart_confirmed",at+1)];
const snapshot=async(call:any)=>{const result:any={};for(const table of ["installations","aggregates","journal","failures","installation_failures"])result[table]=(await call("debug",null,{sql:`SELECT * FROM flora_sdk_telemetry_${table} ORDER BY 1,2,3,4`})).value.rows;return result;};

test("Isso Promise Reward both platforms require same installation applied and restarted rollback; preserve original raw telemetry",async t=>{
 const {runtime,cases,call,session,post,latest,detail}=await fixture(t);
 const before=(await runtime.d1.prepare("SELECT * FROM ota_deployments ORDER BY app_id,id").all()).results;
 for(const item of cases){
  const original=await session(item);await post(item,original,[failure()]);
  const rollback=await session(item,item.rollback);assert.equal((await latest(item)).issueResolution.unresolvedInstallations,1,"publication/session cannot resolve");
  const other=await session(item,item.rollback,randomUUID());await post(item,other,confirmations());
  assert.equal((await latest(item)).issueResolution.unresolvedInstallations,1,"different installation cannot resolve");
  await post(item,rollback,[event("downloaded",now+2),event("launch_confirmed",now+3)]);
  assert.equal((await latest(item)).issueResolution.unresolvedInstallations,1,"launch alone cannot resolve");
  await post(item,rollback,[event("restart_confirmed",now+4)]);
  const summary=await latest(item);assert.deepEqual(summary.issueResolution,{unresolvedInstallations:0,resolvedInstallations:1,unknownInstallations:0,rollbackResolvedInstallations:1});
  assert.equal(summary.appliedInstallations,0);assert.equal(summary.restartedInstallations,0);assert.equal(summary.recoveredInstallations,0);assert.equal(summary.failedInstallations,1);
  const result=await detail(item,item.source,"resolved");assert.equal(result.installations.length,1);const install=result.installations[0];
  assert.equal(install.issueStatus,"resolved");assert.equal(install.issueOrderKnown,true);assert.equal(install.applied,false);assert.equal(install.restarted,false);assert.equal(install.firstFailureAt,now);
  assert.deepEqual(install.issueResolution,{kind:"rollback",deploymentId:item.rollback,confirmedAt:now+3,restartedAt:now+4});
  const timeline=await call("detail",null,{appId:item.appId,deploymentId:item.source,installationRef:install.id});assert.equal(timeline.value.events.length,1);assert.equal(timeline.value.events[0].type,"failed");
 }
 const saved=await snapshot(call);await call("restart");for(const item of cases)assert.equal((await latest(item)).issueResolution.rollbackResolvedInstallations,1);
 assert.deepEqual(await snapshot(call),saved);assert.deepEqual((await runtime.d1.prepare("SELECT * FROM ota_deployments ORDER BY app_id,id").all()).results,before);
});

test("source relapse and rollback failure reopen linked issue; equal reordered replayed confirmations cannot falsely recover",async t=>{
 const {cases,call,session,post,latest,detail}=await fixture(t),item=cases[0]!;
 const original=await session(item),rollback=await session(item,item.rollback);
 await post(item,original,[failure()]);const success=confirmations();await post(item,rollback,success);
 assert.equal((await latest(item)).issueResolution.rollbackResolvedInstallations,1);
 await post(item,original,[failure(now+20)]);assert.equal((await latest(item)).issueResolution.unresolvedInstallations,1);
 assert.equal((await detail(item)).installations[0].issueResolution,undefined);
 assert.equal((await post(item,rollback,success)).duplicates,2);assert.equal((await latest(item)).issueResolution.unresolvedInstallations,1);
 await post(item,rollback,[event("launch_confirmed",now+20),event("restart_confirmed",now+21)]);assert.equal((await latest(item)).issueResolution.unresolvedInstallations,1);
 await post(item,rollback,[event("launch_confirmed",now+22)]);assert.equal((await latest(item)).issueResolution.rollbackResolvedInstallations,1);
 await post(item,rollback,[failure(now+30)]);assert.equal((await latest(item)).issueResolution.unresolvedInstallations,1);
 await post(item,rollback,[failure(now+5),event("launch_confirmed",now+29),event("restart_confirmed",now+30)]);assert.equal((await latest(item)).issueResolution.unresolvedInstallations,1);
 await post(item,rollback,confirmations(now+31));assert.equal((await latest(item)).issueResolution.rollbackResolvedInstallations,1);
 await post(item,original,confirmations(now+40));const direct=await latest(item);assert.equal(direct.issueResolution.resolvedInstallations,1);assert.equal(direct.issueResolution.rollbackResolvedInstallations,undefined);
 assert.equal((await detail(item)).installations[0].issueResolution.kind,"same-deployment");await call("restart");assert.deepEqual(await latest(item),direct);
});

test("all six app platform rollback relapse cycles expose linked failure context and re-recovery without changing original history or adding report D1 reads",async t=>{
 const {runtime,cases,call,session,post,latest,detail}=await fixture(t);
 const publications=(await runtime.d1.prepare("SELECT * FROM ota_deployments ORDER BY app_id,id").all()).results;
 for(const item of cases){
  const original=await session(item),rollback=await session(item,item.rollback);
  await post(item,original,[failure()]);await post(item,rollback,confirmations());
  assert.deepEqual((await latest(item)).issueResolution,{unresolvedInstallations:0,resolvedInstallations:1,unknownInstallations:0,rollbackResolvedInstallations:1});
  const sourceRows=async()=>{const result:any={};for(const table of ["installations","aggregates","journal","failures","installation_failures"])result[table]=(await call("debug",null,{sql:`SELECT * FROM flora_sdk_telemetry_${table} WHERE deployment_id='${item.source}' ORDER BY 1,2,3,4`})).value.rows;return result;};
  const preserved=await sourceRows(),reads=(await call("debug")).value.reads;
  const relapse=failure(now+30);await post(item,rollback,[relapse]);
  assert.equal((await call("debug")).value.reads,reads,"accepted relapse uses zero D1 reads");
  assert.deepEqual((await latest(item)).issueResolution,{unresolvedInstallations:1,resolvedInstallations:0,unknownInstallations:0});
  const beforeDetail=(await call("debug")).value.reads,unresolved=await detail(item,item.source,"unresolved");
  assert.equal((await call("debug")).value.reads,beforeDetail+2,"source detail retains two immutable D1 scope reads");
  assert.equal(unresolved.installations.length,1);const row=unresolved.installations[0];
  const context={deploymentId:item.rollback,observedAt:now+30,stage:"launch",code:"UNCONFIRMED_LAUNCH"};
  assert.deepEqual(row.rollbackFailure,context);assert.equal(row.issueResolution,undefined);assert.equal(row.applied,false);assert.equal(row.restarted,false);
  const sourceEvents=await call("detail",null,{appId:item.appId,deploymentId:item.source,installationRef:row.id});
  assert.deepEqual(sourceEvents.value.installation.rollbackFailure,context);assert.equal(sourceEvents.value.events.length,1);assert.equal(sourceEvents.value.events[0].observedAt,now);
  assert.equal((await detail(item,item.source,"resolved")).installations.length,0);
  await post(item,rollback,[event("launch_confirmed",now+29),event("restart_confirmed",now+30)]);assert.equal((await latest(item)).issueResolution.unresolvedInstallations,1,"stale and equal timestamps cannot recover");
  assert.equal((await post(item,rollback,[relapse])).duplicates,1);await call("restart");assert.deepEqual((await detail(item,item.source,"unresolved")).installations[0].rollbackFailure,context);
  const recoveryReads=(await call("debug")).value.reads;await post(item,rollback,confirmations(now+31));
  assert.equal((await call("debug")).value.reads,recoveryReads,"accepted re-recovery uses zero D1 reads");
  assert.deepEqual((await latest(item)).issueResolution,{unresolvedInstallations:0,resolvedInstallations:1,unknownInstallations:0,rollbackResolvedInstallations:1});
  const recovered=await detail(item,item.source,"resolved");assert.deepEqual(recovered.installations[0].rollbackFailure,context);assert.deepEqual(recovered.installations[0].issueResolution,{kind:"rollback",deploymentId:item.rollback,confirmedAt:now+31,restartedAt:now+32});
  assert.equal((await detail(item,item.source,"unresolved")).installations.length,0);
  const other=await session(item,item.rollback,randomUUID());await post(item,other,[failure(now+40)]);assert.equal((await latest(item)).issueResolution.rollbackResolvedInstallations,1,"another installation cannot reopen this source issue");
  const installationHash=JSON.parse(Buffer.from(rollback.split(".")[1],"base64url").toString()).installationHash;
  assert.ok(!JSON.stringify(recovered).includes(installationHash));assert.ok(!JSON.stringify(recovered).includes(item.installationId));
  assert.deepEqual(await sourceRows(),preserved,"source raw report, journal and cumulative counters stay byte-identical");
 }
 assert.deepEqual((await runtime.d1.prepare("SELECT * FROM ota_deployments ORDER BY app_id,id").all()).results,publications);
});

test("all six immutable rollback chains reopen the original on a descendant failure and require fresh paired descendant recovery",async t=>{
 const {runtime,cases,call,session,post,latest,detail}=await fixture(t);
 for(const item of cases){
  const original=await session(item),first=await session(item,item.rollback);await post(item,original,[failure()]);const firstSuccess=confirmations();await post(item,first,firstSuccess);
  const second=randomUUID(),third=randomUUID();
  for(const [deploymentId,parent,createdAt] of [[second,item.rollback,now-500],[third,second,now-250]] as const)await runtime.d1.prepare("INSERT INTO ota_deployments VALUES(?,?,?,?,?,?,?,?)").bind("owner_a",item.appId,deploymentId,item.platform,"verification","native-v1",createdAt,JSON.stringify({rollback:{fromDeploymentId:parent,targetDeploymentId:item.target,reason:"Nested rollback",requestedAt:createdAt}})).run();
  const secondTicket=await session(item,second);await post(item,secondTicket,[failure(now+20)]);
  assert.equal((await latest(item)).issueResolution.unresolvedInstallations,1,"a descendant failure reopens the root issue");
  assert.equal((await post(item,first,firstSuccess)).duplicates,2);assert.equal((await latest(item)).issueResolution.unresolvedInstallations,1);
  const source=await detail(item,item.source,"unresolved");assert.equal(source.installations[0].rollbackFailure.deploymentId,second);
  const thirdTicket=await session(item,third);await post(item,thirdTicket,[event("launch_confirmed",now+31)]);assert.equal((await latest(item)).issueResolution.unresolvedInstallations,1);assert.equal((await latest(item,second)).issueResolution.unresolvedInstallations,1);
  const reads=(await call("debug")).value.reads;await post(item,thirdTicket,[event("restart_confirmed",now+32)]);assert.equal((await call("debug")).value.reads,reads);
  for(const deploymentId of [item.source,second]){const report=await latest(item,deploymentId);assert.deepEqual(report.issueResolution,{unresolvedInstallations:0,resolvedInstallations:1,unknownInstallations:0,rollbackResolvedInstallations:1});const row=(await detail(item,deploymentId,"resolved")).installations[0];assert.equal(row.issueResolution.deploymentId,third);assert.equal(row.applied,false);assert.equal(row.restarted,false);}
  await call("restart");assert.equal((await latest(item)).issueResolution.rollbackResolvedInstallations,1);
 }
});

test("a chain deeper than 32 verified edges invalidates old root success and cannot manufacture a fresh recovery proof",async t=>{
 const {runtime,cases,call,session,post,latest}=await fixture(t),item=cases[0]!;
 const original=await session(item),first=await session(item,item.rollback);await post(item,original,[failure()]);await post(item,first,confirmations());
 let parent=item.rollback;
 for(let depth=2;depth<=32;depth++){const child=randomUUID(),createdAt=now-1000+depth*10;await runtime.d1.prepare("INSERT INTO ota_deployments VALUES(?,?,?,?,?,?,?,?)").bind("owner_a",item.appId,child,item.platform,"verification","native-v1",createdAt,JSON.stringify({rollback:{fromDeploymentId:parent,targetDeploymentId:item.target,reason:"Bounded rollback chain",requestedAt:createdAt}})).run();parent=child;}
 const boundary=await session(item,parent);await post(item,boundary,confirmations(now+15));assert.equal((await latest(item)).issueResolution.rollbackResolvedInstallations,1,"the 32-edge boundary still supports a verified recovery");
 const thirtyThird=randomUUID();await runtime.d1.prepare("INSERT INTO ota_deployments VALUES(?,?,?,?,?,?,?,?)").bind("owner_a",item.appId,thirtyThird,item.platform,"verification","native-v1",now-500,JSON.stringify({rollback:{fromDeploymentId:parent,targetDeploymentId:item.target,reason:"Over-depth rollback",requestedAt:now-500}})).run();parent=thirtyThird;
 const deep=await session(item,parent);assert.equal((await latest(item)).issueResolution.unresolvedInstallations,1,"registering an over-depth lineage fails closed rather than retaining an old root proof");
 const reads=(await call("debug")).value.reads;await post(item,deep,[failure(now+20),...confirmations(now+30)]);assert.equal((await call("debug")).value.reads,reads);assert.equal((await latest(item)).issueResolution.unresolvedInstallations,1);
 await post(item,first,confirmations(now+40));assert.equal((await latest(item)).issueResolution.unresolvedInstallations,1);await call("restart");assert.equal((await latest(item)).issueResolution.unresolvedInstallations,1);
});

test("an invalid nested ancestor cannot connect a valid descendant report across owner app platform channel runtime or publication chronology",async t=>{
 const {runtime,cases,call,session,post,latest}=await fixture(t);
 const mutations=["owner_id='foreign-owner'","app_id='application_foreign'","platform='foreign'","channel='foreign-channel'","runtime_version='foreign-runtime'",`created_at=${now-1000}`];
 for(const [index,mutation] of mutations.entries()){
  const item=cases[index]!,original=await session(item);await post(item,original,[failure()]);
  const child=randomUUID();await runtime.d1.prepare("INSERT INTO ota_deployments VALUES(?,?,?,?,?,?,?,?)").bind("owner_a",item.appId,child,item.platform,"verification","native-v1",now-500,JSON.stringify({rollback:{fromDeploymentId:item.rollback,targetDeploymentId:item.target,reason:"Nested validation",requestedAt:now-500}})).run();
  await runtime.d1.prepare(`UPDATE ota_deployments SET ${mutation} WHERE owner_id='owner_a' AND app_id=? AND id=?`).bind(item.appId,item.source).run();
  const validDescendant=await session(item,child);await post(item,validDescendant,confirmations());
  assert.equal((await latest(item)).issueResolution.unresolvedInstallations,1,mutation);assert.equal((await call("debug",null,{sql:`SELECT * FROM flora_sdk_telemetry_rollback_lineage WHERE deployment_id='${item.rollback}'`})).value.rows.length,0);
 }
});

test("transitive projection upgrade invalidates a prior direct-only proof once while preserving all raw reports and zero D1 summary reads",async t=>{
 const {runtime,cases,call,session,post,latest}=await fixture(t),item=cases[0]!;
 const original=await session(item),first=await session(item,item.rollback);await post(item,original,[failure()]);await post(item,first,confirmations());
 const child=randomUUID();await runtime.d1.prepare("INSERT INTO ota_deployments VALUES(?,?,?,?,?,?,?,?)").bind("owner_a",item.appId,child,item.platform,"verification","native-v1",now-500,JSON.stringify({rollback:{fromDeploymentId:item.rollback,targetDeploymentId:item.target,reason:"Nested failure before upgrade",requestedAt:now-500}})).run();
 const childTicket=await session(item,child);await post(item,childTicket,[failure(now+20)]);
 const hash=JSON.parse(Buffer.from(original.split(".")[1],"base64url").toString()).installationHash;
 // Reproduce only the preceding version's derived direct-only projection. The
 // immutable publications, accepted SDK events and original counters stay real.
 for(const sql of [
  `UPDATE flora_sdk_telemetry_issue_state SET status='resolved' WHERE deployment_id='${item.source}' RETURNING status`,
  `UPDATE flora_sdk_telemetry_issue_aggregates SET unresolved=0,resolved=1 WHERE deployment_id='${item.source}' RETURNING resolved`,
  `UPDATE flora_sdk_telemetry_rollback_issue_aggregates SET resolved=1 WHERE deployment_id='${item.source}' RETURNING resolved`,
  `INSERT INTO flora_sdk_telemetry_resolution_proof VALUES('owner_a','${item.appId}','${item.source}','${hash}','rollback','${item.rollback}',${now+10},${now+11}) RETURNING kind`,
  "DELETE FROM flora_sdk_telemetry_meta WHERE key='rollback-resolution-v2' RETURNING key",
 ])assert.equal((await call("debug",null,{sql})).status,200);
 const before=await snapshot(call),reads=(await call("debug")).value.reads;await call("restart");
 assert.deepEqual((await latest(item)).issueResolution,{unresolvedInstallations:1,resolvedInstallations:0,unknownInstallations:0});assert.deepEqual(await snapshot(call),before);assert.equal((await call("debug")).value.reads,reads);
 await call("restart");assert.equal((await latest(item)).issueResolution.unresolvedInstallations,1);assert.equal((await call("debug")).value.reads,reads);
});

test("immutable D1 scope rejects mismatched owner app platform channel runtime and target age",async t=>{
 const {runtime,cases,call,session,post,latest}=await fixture(t);
 const mutations=[["owner_id","owner_other"],["app_id","application_other"],["platform","android"],["channel","other"],["runtime_version","other"],["created_at",now-500]] as const;
 for(const [index,[column,value]] of mutations.entries()){
  const item=cases[index]!;const original=await session(item);await post(item,original,[failure()]);
  const old=await runtime.d1.prepare(`SELECT ${column} AS value FROM ota_deployments WHERE id=?`).bind(item.target).first<{value:string|number}>();
  const actual=column==="platform"?(item.platform==="ios"?"android":"ios"):value;
  await runtime.d1.prepare(`UPDATE ota_deployments SET ${column}=? WHERE id=?`).bind(actual,item.target).run();
  const rollback=await session(item,item.rollback);await post(item,rollback,confirmations());
  assert.equal((await latest(item)).issueResolution.unresolvedInstallations,1,column);
  assert.equal((await call("debug",null,{sql:`SELECT * FROM flora_sdk_telemetry_rollback_lineage WHERE deployment_id='${item.rollback}'`})).value.rows.length,0);
  await runtime.d1.prepare(`UPDATE ota_deployments SET ${column}=? WHERE id=?`).bind(old!.value,item.target).run();
  // Correct immutable server facts link existing assertions without fabricating new events.
  const before=await snapshot(call);await session(item,item.rollback);assert.equal((await latest(item)).issueResolution.rollbackResolvedInstallations,1);assert.deepEqual(await snapshot(call),before);
 }
});

test("legacy signed rollback boolean has no lineage authority and batched backfill is cached across reconstruction",async t=>{
 const {cases,call,session,post,latest}=await fixture(t),item=cases[0]!;
 const original=await session(item),rollback=await session(item,item.rollback);await post(item,original,[failure()]);
 await call("debug",null,{sql:"DELETE FROM flora_sdk_telemetry_rollback_lineage RETURNING deployment_id"});
 const secret=(await call("debug",null,{sql:"SELECT value FROM flora_sdk_telemetry_meta WHERE key='secret'"})).value.rows[0].value;
 const payload=JSON.parse(Buffer.from(rollback.split(".")[1],"base64url").toString());payload.isRollback=true;
 const encoded=Buffer.from(JSON.stringify(payload)).toString("base64url"),signature=createHmac("sha256",Buffer.from(secret,"base64url")).update("v1."+encoded).digest("base64url");
 await post(item,"v1."+encoded+"."+signature,confirmations());assert.equal((await latest(item)).issueResolution.unresolvedInstallations,1);
 const before=await snapshot(call),reads=(await call("debug")).value.reads;
 const watermark=[{id:item.rollback,createdAt:now-1000}];assert.equal((await call("sync",watermark,{appId:item.appId})).status,200);
 assert.equal((await call("debug")).value.reads,reads+1);assert.equal((await latest(item)).issueResolution.rollbackResolvedInstallations,1);
 await call("restart");await call("sync",watermark,{appId:item.appId});assert.equal((await call("debug")).value.reads,reads+1);
 assert.deepEqual(await snapshot(call),before);
 for(let i=0;i<3;i++)await latest(item);assert.equal((await call("debug")).value.reads,reads+1);
});

test("rollback report observer rejection atomically retains unresolved status and retry resolves once",async t=>{
 const {cases,call,session,post,latest}=await fixture(t),item=cases[0]!;
 const original=await session(item),rollback=await session(item,item.rollback);await post(item,original,[failure()]);await call("observe");
 const before=await snapshot(call),events=confirmations();
 const rejected=await call("report",{token:rollback,events},{appId:item.appId,observationFailure:true});assert.equal(rejected.status,503);
 assert.equal((await latest(item)).issueResolution.unresolvedInstallations,1);assert.deepEqual(await snapshot(call),before);
 assert.equal((await post(item,rollback,events)).accepted,2);const resolved=await latest(item);assert.equal(resolved.issueResolution.rollbackResolvedInstallations,1);
 assert.equal((await post(item,rollback,events)).duplicates,2);assert.deepEqual(await latest(item),resolved);
});

test("another later rollback failure invalidates an older healthy rollback until fresh launch and restart evidence",async t=>{
 const {runtime,cases,session,post,latest,detail}=await fixture(t),item=cases[0]!;
 const original=await session(item),first=await session(item,item.rollback);await post(item,original,[failure()]);await post(item,first,confirmations());
 const next=randomUUID();await runtime.d1.prepare("INSERT INTO ota_deployments VALUES(?,?,?,?,?,?,?,?)").bind("owner_a",item.appId,next,item.platform,"verification","native-v1",now-500,JSON.stringify({rollback:{fromDeploymentId:item.source,targetDeploymentId:item.target,reason:"Second rollback",requestedAt:now-500}})).run();
 const second=await session(item,next);await post(item,second,[failure(now+20)]);assert.equal((await latest(item)).issueResolution.unresolvedInstallations,1);
 await post(item,first,[event("restart_confirmed",now+30)]);assert.equal((await latest(item)).issueResolution.unresolvedInstallations,1);
 await post(item,first,[event("launch_confirmed",now+31)]);assert.equal((await latest(item)).issueResolution.rollbackResolvedInstallations,1);assert.equal((await detail(item)).installations[0].issueResolution.deploymentId,item.rollback);
});

test("prepublication rollback confirmations and incomplete legacy rollback ordering cannot resolve source",async t=>{
 const {cases,call,session,post,latest}=await fixture(t),item=cases[0]!;
 const original=await session(item),rollback=await session(item,item.rollback);await post(item,original,[failure(now-1800)]);
 await post(item,rollback,confirmations(now-1500));assert.equal((await latest(item)).issueResolution.unresolvedInstallations,1);
 await post(item,rollback,[failure(now),...confirmations()]);assert.equal((await latest(item)).issueResolution.rollbackResolvedInstallations,1);
 // Preserve cumulative flags but remove ordering and the v1 derived projection.
 await call("debug",null,{sql:`UPDATE flora_sdk_telemetry_installations SET data=json_set(data,'$.detailHistory.legacy',json('true'),'$.lastReportedAt',1800000000020) WHERE deployment_id='${item.rollback}' RETURNING installation_hash`});
 await call("debug",null,{sql:`DELETE FROM flora_sdk_telemetry_journal WHERE deployment_id='${item.rollback}' RETURNING event_hash`});
 await call("debug",null,{sql:`DELETE FROM flora_sdk_telemetry_failures WHERE deployment_id='${item.rollback}' RETURNING app_id`});
 for(const sql of ["DELETE FROM flora_sdk_telemetry_issue_state RETURNING installation_hash","DELETE FROM flora_sdk_telemetry_issue_aggregates RETURNING app_id","DELETE FROM flora_sdk_telemetry_resolution_proof RETURNING app_id","DELETE FROM flora_sdk_telemetry_rollback_issue_aggregates RETURNING app_id","DELETE FROM flora_sdk_telemetry_meta WHERE key='issue-resolution-v1' RETURNING key"])await call("debug",null,{sql});
 await call("restart");
 // A fresh safe report triggers causal reconciliation, not synthetic old success.
 await post(item,rollback,[event("downloaded",now+21)]);assert.equal((await latest(item)).issueResolution.unresolvedInstallations,1);
 await post(item,rollback,confirmations(now+22));assert.equal((await latest(item)).issueResolution.rollbackResolvedInstallations,1);
});

test("direct original detail backfills preexisting rollback reports before operations or new SDK sessions using the same two D1 reads",async t=>{
 const {cases,call,session,post,latest,detail}=await fixture(t),item=cases[0]!;
 const original=await session(item),rollback=await session(item,item.rollback);await post(item,original,[failure()]);
 // Simulate reports accepted by the preceding version, before authoritative
 // cross-deployment lineage existed. A signed boolean alone is insufficient.
 await call("debug",null,{sql:"DELETE FROM flora_sdk_telemetry_rollback_lineage RETURNING deployment_id"});
 await post(item,rollback,confirmations());assert.equal((await latest(item)).issueResolution.unresolvedInstallations,1);
 await call("restart");const before=await snapshot(call),reads=(await call("debug")).value.reads;
 const resolved=await detail(item,item.source,"resolved");assert.equal(resolved.installations.length,1);assert.equal(resolved.installations[0].issueResolution.deploymentId,item.rollback);
 assert.equal((await call("debug")).value.reads,reads+2);assert.deepEqual(await snapshot(call),before);
 const markers=(await call("debug",null,{sql:"SELECT key FROM flora_sdk_telemetry_meta WHERE key LIKE 'rollback-detail-history-v1:%'"})).value.rows;assert.equal(markers.length,1);
 await call("restart");assert.equal((await detail(item,item.source,"resolved")).installations.length,1);assert.equal((await call("debug")).value.reads,reads+4);
});

test("lineage outer transaction failure cannot roll back completed issue migration while leaving memory marked ready",async t=>{
 const {cases,call,session,post,latest}=await fixture(t),item=cases[0]!;
 const original=await session(item),rollback=await session(item,item.rollback);await post(item,original,[failure()]);await post(item,rollback,confirmations());
 for(const sql of ["DELETE FROM flora_sdk_telemetry_rollback_lineage RETURNING deployment_id","DELETE FROM flora_sdk_telemetry_resolution_proof RETURNING deployment_id","DELETE FROM flora_sdk_telemetry_rollback_issue_aggregates RETURNING deployment_id","DELETE FROM flora_sdk_telemetry_issue_state RETURNING installation_hash","DELETE FROM flora_sdk_telemetry_issue_aggregates RETURNING deployment_id","DELETE FROM flora_sdk_telemetry_meta WHERE key='issue-resolution-v1' RETURNING key"])await call("debug",null,{sql});
 await call("restart");const raw=await snapshot(call),watermark=[{id:item.rollback,createdAt:now-1000}];
 // Fence10 is the outer final fence after lineage + watermark insert. The v1
 // issue migration must have committed before this transaction began.
 const denied=await call("sync",watermark,{appId:item.appId,failFenceAt:10});assert.equal(denied.status,401);
 assert.equal((await call("debug",null,{sql:"SELECT * FROM flora_sdk_telemetry_rollback_lineage"})).value.rows.length,0);
 assert.equal((await call("debug",null,{sql:"SELECT key FROM flora_sdk_telemetry_meta WHERE key LIKE 'rollback-history-v1:%'"})).value.rows.length,0);
 assert.equal((await call("debug",null,{sql:"SELECT key FROM flora_sdk_telemetry_meta WHERE key='issue-resolution-v1'"})).value.rows.length,1);
 assert.equal((await latest(item)).issueResolution.unresolvedInstallations,1,"persisted current state survives a later outer rollback with same in-memory store");
 assert.deepEqual(await snapshot(call),raw);assert.equal((await call("sync",watermark,{appId:item.appId})).status,200);assert.equal((await latest(item)).issueResolution.rollbackResolvedInstallations,1);
});
