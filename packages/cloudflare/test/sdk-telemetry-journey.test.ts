import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {createTestRuntime} from "./runtime.ts";

const now=1_800_000_000_000,origin="https://telemetry.example.test",owner="owner_a";
async function fixture(t:test.TestContext){
 const runtime=await createTestRuntime({entrypoint:new URL("./fixtures/sdk-telemetry-entry.ts",import.meta.url),durableObjects:{TELEMETRY:"TelemetryFixture"}});t.after(()=>runtime.dispose());
 await runtime.d1.exec(`CREATE TABLE flora_deployment(singleton INTEGER PRIMARY KEY,owner_id TEXT,origin TEXT,db_identity TEXT);
 CREATE TABLE applications(owner_id TEXT,id TEXT,PRIMARY KEY(owner_id,id));
 CREATE TABLE ota_deployments(owner_id TEXT,app_id TEXT,id TEXT,platform TEXT,channel TEXT,runtime_version TEXT,created_at INTEGER,data TEXT,PRIMARY KEY(owner_id,app_id,id));
 CREATE INDEX ota_latest ON ota_deployments(owner_id,app_id,channel,runtime_version,platform,created_at DESC,id DESC);`);
 await runtime.d1.prepare("INSERT INTO flora_deployment VALUES(1,?,?,?)").bind(owner,origin,"db_a").run();
 const call=async(op:string,extra:Record<string,unknown>={})=>{const response=await runtime.fetch(origin,{method:"POST",body:JSON.stringify({op,...extra})});return {status:response.status,value:await response.json() as any};};
 const publish=async(appId:string,platform:string,at:number,from?:string,target?:string,extra:Record<string,unknown>={})=>{const id=randomUUID();await runtime.d1.prepare("INSERT OR IGNORE INTO applications VALUES(?,?)").bind(owner,appId).run();await runtime.d1.prepare("INSERT INTO ota_deployments VALUES(?,?,?,?,?,?,?,?)").bind(owner,appId,id,platform,"verification","native-v1",at,JSON.stringify({id,appId,platform,channel:"verification",runtimeVersion:"native-v1",createdAt:at,commitSha:"a".repeat(40),...(from?{rollback:{fromDeploymentId:from,targetDeploymentId:target,requestedAt:at,reason:"Restore verified release"}}:{}),...extra})).run();return id;};
 const report=async(appId:string,deploymentId:string,platform:string,installationId:string,events:any[])=>{const session=await call("session",{appId,input:{installationId,deploymentId,platform,channel:"verification",runtimeVersion:"native-v1",environment:platform==="ios"?"ios-simulator":"android-emulator"}});assert.equal(session.status,200,JSON.stringify(session.value));const result=await call("report",{appId,input:{token:session.value.token,events}});assert.equal(result.status,200,JSON.stringify(result.value));return session.value.token;};
 const event=(type:string,at:number)=>({id:randomUUID(),type,observedAt:at,...(["failed","rolled_back"].includes(type)?{stage:"launch",code:"UNCONFIRMED_LAUNCH"}:{})});
 const ref=async(appId:string,deploymentId:string)=>{const result=await call("detail",{appId,deploymentId});assert.equal(result.status,200,JSON.stringify(result.value));return result.value.installations.toSorted((a:any,b:any)=>b.history.recordedEvents-a.history.recordedEvents)[0].id as string;};
 const snapshot=async()=>({d1:(await runtime.d1.prepare("SELECT * FROM ota_deployments ORDER BY app_id,id").all()).results,journal:(await call("debug",{sql:"SELECT * FROM flora_sdk_telemetry_journal ORDER BY event_hash"})).value.rows,installations:(await call("debug",{sql:"SELECT * FROM flora_sdk_telemetry_installations ORDER BY app_id,deployment_id,installation_hash"})).value.rows,aggregates:(await call("debug",{sql:"SELECT * FROM flora_sdk_telemetry_aggregates ORDER BY app_id,deployment_id"})).value.rows});
 return {runtime,call,publish,report,event,ref,snapshot};
}

test("six app/platform journeys join original, successful rollback, relapse and recovery with bounded ascending pages, without rewriting raw history",async t=>{
 const f=await fixture(t);
 for(const appId of ["application_isso","application_promise","application_reward"])for(const platform of ["ios","android"]){
  const target=await f.publish(appId,platform,now-10000),source=await f.publish(appId,platform,now-9000),r1=await f.publish(appId,platform,now-7000,source,target),r2=await f.publish(appId,platform,now-5000,r1,target),r3=await f.publish(appId,platform,now-3000,r2,target),installationId=randomUUID();
  for(const [index,deploymentId]of[source,r1,r2,r3].entries()){const at=now-8500+index*2000;await f.report(appId,deploymentId,platform,installationId,[f.event("update_seen",at),f.event("downloaded",at+1),f.event("activation_requested",at+2),f.event(index===0||index===2?"rolled_back":"launch_confirmed",at+3),f.event(index===0||index===2?"failed":"restart_confirmed",at+4)]);}
  await f.report(appId,r2,platform,randomUUID(),[f.event("failed",now-4000)]);
  const refs=await Promise.all([source,r1,r2,r3].map(deploymentId=>f.ref(appId,deploymentId))),before=await f.snapshot();
  for(const [index,deploymentId]of[source,r1,r2,r3].entries()){
   const reads=(await f.call("debug")).value.reads,first=await f.call("journey",{appId,deploymentId,installationRef:refs[index]});assert.equal(first.status,200,JSON.stringify(first.value));assert.equal((await f.call("debug")).value.reads-reads,2);
   assert.equal(first.value.rootDeploymentId,source);assert.deepEqual(first.value.deployments.map((d:any)=>d.id),[source,r1,r2,r3]);assert.equal(first.value.history.complete,true);assert.deepEqual(first.value.history.reasons,[]);assert.equal(first.value.entries.length,20);assert.ok(first.value.nextCursor);
   const second=await f.call("journey",{appId,deploymentId,installationRef:refs[index],cursor:first.value.nextCursor});assert.equal(second.status,200,JSON.stringify(second.value));assert.equal(second.value.entries.length,4);assert.equal(second.value.nextCursor,null);
   const entries=[...first.value.entries,...second.value.entries];assert.equal(new Set(entries.map((e:any)=>e.id)).size,24);assert.ok(entries.every((e:any,i:number)=>i===0||entries[i-1].observedAt<=e.observedAt));assert.equal(entries.filter((e:any)=>e.kind==="publication").length,4);assert.equal(entries.filter((e:any)=>e.kind==="sdk-event").length,20);
   assert.deepEqual(entries.filter((e:any)=>e.type==="rolled_back").map((e:any)=>e.deploymentId),[source,r2]);assert.deepEqual(entries.filter((e:any)=>e.type==="restart_confirmed").map((e:any)=>e.deploymentId),[r1,r3]);
   const rawHash=(await f.call("debug",{sql:"SELECT installation_hash FROM flora_sdk_telemetry_installations LIMIT 1"})).value.rows[0].installation_hash;assert.doesNotMatch(JSON.stringify([first.value,second.value]),new RegExp(`${installationId}|${rawHash}|installation_hash|event_hash`));
  }
  assert.deepEqual(await f.snapshot(),before);
 }
});

test("journey references and cursors are context sealed, publication guarded, revocation fenced, and stable when reports arrive between pages",async t=>{
 const f=await fixture(t),appId="application_first",platform="android",target=await f.publish(appId,platform,now-10000),source=await f.publish(appId,platform,now-9000),r1=await f.publish(appId,platform,now-8000,source,target),installationId=randomUUID();
 await f.report(appId,source,platform,installationId,Array.from({length:16},(_,i)=>f.event("update_seen",now-7000+i)));await f.report(appId,r1,platform,installationId,Array.from({length:9},(_,i)=>f.event("update_seen",now-6000+i)));
 await f.report(appId,source,platform,installationId,Array.from({length:9},(_,i)=>f.event("downloaded",now-6500+i)));
 const installationRef=await f.ref(appId,source),first=await f.call("journey",{appId,deploymentId:source,installationRef});assert.equal(first.status,200);assert.ok(first.value.nextCursor);
 const reads=(await f.call("debug")).value.reads;
 for(const scope of [{appId:"application_other"},{deploymentId:r1},{config:{ownerId:"owner_other"}},{installationRef:installationRef.slice(0,-2)+"XX"}])assert.equal((await f.call("journey",{appId,deploymentId:source,installationRef,...scope})).status,404);
 assert.equal((await f.call("journey",{appId,deploymentId:source,installationRef,cursor:"c1.invalid"})).status,400);assert.equal((await f.call("debug")).value.reads,reads);
 const raw=(await f.call("detail",{appId,deploymentId:source,installationRef})).value;assert.ok(raw.nextCursor);assert.equal((await f.call("journey",{appId,deploymentId:source,installationRef,cursor:raw.nextCursor})).status,400);
 assert.equal((await f.call("detail",{appId,deploymentId:source,installationRef,cursor:first.value.nextCursor})).status,400);
 await f.report(appId,r1,platform,installationId,[f.event("failed",now-8500)]);
 const second=await f.call("journey",{appId,deploymentId:source,installationRef,cursor:first.value.nextCursor,now:now+50});assert.equal(second.status,200,JSON.stringify(second.value));assert.equal(second.value.entries.length,16);assert.equal(second.value.entries.some((e:any)=>e.type==="failed"),false,"late reports never alter an existing sealed snapshot");assert.equal(second.value.observedAt,first.value.observedAt);
 const refreshed=await f.call("journey",{appId,deploymentId:source,installationRef});assert.equal(refreshed.value.entries.some((e:any)=>e.type==="failed"),true);
 const laterRollback=await f.publish(appId,platform,now+10,r1,target),oldSnapshot=await f.call("journey",{appId,deploymentId:source,installationRef,cursor:first.value.nextCursor,now:now+50});assert.equal(oldSnapshot.status,200);assert.equal(oldSnapshot.value.deployments.some((d:any)=>d.id===laterRollback),false,"new publication does not change an older sealed snapshot");
 const newSnapshot=await f.call("journey",{appId,deploymentId:source,installationRef,now:now+50});assert.equal(newSnapshot.value.deployments.some((d:any)=>d.id===laterRollback),true,"manual refresh discovers the new authoritative descendant");
 assert.equal((await f.call("journey",{appId,deploymentId:source,installationRef,failFenceAt:1})).status,401);
 await f.runtime.d1.prepare("UPDATE ota_deployments SET data=json_set(data,'$.rollback.reason','Changed verified source fact') WHERE id=?").bind(r1).run();assert.equal((await f.call("journey",{appId,deploymentId:source,installationRef,cursor:first.value.nextCursor})).status,409,"changed immutable metadata cannot append to an older sealed graph");
 await f.runtime.d1.prepare("DELETE FROM ota_deployments WHERE id=?").bind(source).run();assert.equal((await f.call("journey",{appId,deploymentId:source,installationRef})).status,404);
});

test("journey snapshots exclude post-asOf receipts and do not turn an unreported node into falsely complete history between pages",async t=>{
 const f=await fixture(t),appId="application_first",platform="android",target=await f.publish(appId,platform,now-10000),source=await f.publish(appId,platform,now-9000),r1=await f.publish(appId,platform,now-8000,source,target),installationId=randomUUID();
 await f.report(appId,source,platform,installationId,Array.from({length:16},(_,i)=>f.event("update_seen",now-7000+i)));await f.report(appId,source,platform,installationId,Array.from({length:9},(_,i)=>f.event("downloaded",now-6500+i)));
 const installationRef=await f.ref(appId,source),first=await f.call("journey",{appId,deploymentId:source,installationRef});assert.equal(first.value.history.complete,false);assert.equal(first.value.deployments.find((d:any)=>d.id===r1).history.reason,"missing");
 const session=await f.call("session",{appId,input:{installationId,deploymentId:r1,platform,channel:"verification",runtimeVersion:"native-v1",environment:"android-emulator"},now:now+100});assert.equal(session.status,200);assert.equal((await f.call("report",{appId,input:{token:session.value.token,events:[f.event("launch_confirmed",now-6000)]},now:now+100})).status,200);
 const second=await f.call("journey",{appId,deploymentId:source,installationRef,cursor:first.value.nextCursor,now:now+101});assert.equal(second.status,200,JSON.stringify(second.value));assert.equal(second.value.deployments.find((d:any)=>d.id===r1).history.reason,"missing");assert.equal(second.value.entries.some((e:any)=>e.type==="launch_confirmed"),false);assert.equal(second.value.history.complete,false);
 const oldAsOf=await f.call("journey",{appId,deploymentId:source,installationRef,now});assert.equal(oldAsOf.status,200);assert.equal(oldAsOf.value.entries.some((e:any)=>e.type==="launch_confirmed"),false,"receipt bound holds even when a fresh MAX(rowid) sees later retained events");assert.equal(oldAsOf.value.deployments.find((d:any)=>d.id===r1).history.reason,"missing");
});

test("journey fails closed for missing, crossed and overly deep ancestry, and explains incomplete legacy or capped installation journals",async t=>{
 const f=await fixture(t),appId="application_first",platform="android",target=await f.publish(appId,platform,now-20000),source=await f.publish(appId,platform,now-19000),r1=await f.publish(appId,platform,now-18000,source,target),installationId=randomUUID();
 await f.report(appId,r1,platform,installationId,[f.event("failed",now-17000)]);const installationRef=await f.ref(appId,r1);
 let page=await f.call("journey",{appId,deploymentId:r1,installationRef});assert.equal(page.status,200);assert.equal(page.value.history.complete,false);assert.ok(page.value.history.reasons.includes("missing"));
 await f.call("debug",{sql:`UPDATE flora_sdk_telemetry_installations SET data=json_remove(data,'$.detailHistory') WHERE deployment_id='${r1}' RETURNING deployment_id`});page=await f.call("journey",{appId,deploymentId:r1,installationRef});assert.ok(page.value.history.reasons.includes("legacy"));
 await f.call("debug",{sql:"UPDATE flora_sdk_telemetry_meta SET value='50000' WHERE key='journal-count' RETURNING value"});await f.report(appId,r1,platform,installationId,[f.event("downloaded",now-16000)]);page=await f.call("journey",{appId,deploymentId:r1,installationRef});assert.ok(page.value.history.reasons.includes("capacity"));assert.equal(page.value.entries.filter((e:any)=>e.kind==="sdk-event").length,1,"omitted events are reported, never invented");
 await f.runtime.d1.prepare("UPDATE ota_deployments SET platform='ios' WHERE id=?").bind(source).run();page=await f.call("journey",{appId,deploymentId:r1,installationRef});assert.equal(page.value.rootDeploymentId,null);assert.ok(page.value.history.reasons.includes("lineage"));assert.deepEqual(page.value.deployments.map((d:any)=>d.id),[r1]);
 await f.runtime.d1.prepare("DELETE FROM ota_deployments WHERE id=?").bind(source).run();page=await f.call("journey",{appId,deploymentId:r1,installationRef});assert.equal(page.status,200);assert.equal(page.value.rootDeploymentId,null);assert.equal(page.value.deployments.length,1);
 const deepRoot=await f.publish(appId,platform,now-15000);let deep=deepRoot;for(let i=0;i<34;i++)deep=await f.publish(appId,platform,now-14000+i*100,deep,target);await f.report(appId,deep,platform,installationId,[f.event("failed",now-10000)]);const deepRef=await f.ref(appId,deep);const result=await f.call("journey",{appId,deploymentId:deep,installationRef:deepRef});assert.equal(result.status,200);assert.equal(result.value.rootDeploymentId,null);assert.ok(result.value.history.reasons.includes("lineage"));assert.equal(result.value.deployments.length,1);
 await f.report(appId,deepRoot,platform,installationId,[f.event("failed",now-14001)]);const rootRef=await f.ref(appId,deepRoot);const capped=await f.call("journey",{appId,deploymentId:deepRoot,installationRef:rootRef});assert.equal(capped.status,200);assert.equal(capped.value.deployments.length,33);assert.ok(capped.value.history.reasons.includes("capacity"));assert.ok(capped.value.history.reasons.includes("lineage"));
});

test("journey scans one bounded indexed scope, excludes unrelated publications, and marks a 2,001-row scope overflow",async t=>{
 const f=await fixture(t),appId="application_first",platform="android",target=await f.publish(appId,platform,now-10000),source=await f.publish(appId,platform,now-9000),r1=await f.publish(appId,platform,now-8000,source,target),installationId=randomUUID();
 await f.report(appId,source,platform,installationId,[f.event("failed",now-8500)]);const installationRef=await f.ref(appId,source);
 await f.runtime.d1.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2001) INSERT INTO ota_deployments SELECT ?,?,printf('00000000-0000-4000-8000-%012d',x),'android','verification','native-v1',?+x,'{}' FROM n`).bind(owner,appId,now-7000).run();
 const before=(await f.call("debug")).value,page=await f.call("journey",{appId,deploymentId:source,installationRef}),after=(await f.call("debug")).value;assert.equal(page.status,200,JSON.stringify(page.value));assert.equal(after.reads-before.reads,2);assert.ok(after.rowsRead-before.rowsRead>2000,"D1 statements and rows are measured separately");assert.ok(after.rowsRead-before.rowsRead<6200,"materialized bounded scope prevents recursive publication scans");assert.deepEqual(page.value.deployments.map((d:any)=>d.id),[source,r1]);assert.ok(page.value.history.reasons.includes("capacity"));assert.equal(page.value.history.complete,false);
 t.diagnostic(`2 D1 statements; ${after.rowsRead-before.rowsRead} rows read for a 2,001-publication scope cap`);
 const plan=(await f.runtime.d1.prepare("EXPLAIN QUERY PLAN SELECT * FROM ota_deployments WHERE owner_id=? AND app_id=? AND platform=? AND channel=? AND runtime_version=? AND created_at>=? AND created_at<=? ORDER BY created_at,id LIMIT 2001").bind(owner,appId,platform,"verification","native-v1",now-9000,now).all()).results;assert.match(JSON.stringify(plan),/SEARCH.*ota_latest/);assert.doesNotMatch(JSON.stringify(plan),/SCAN ota_deployments/);
});

test("journey never follows cross-app, owner, platform, channel, runtime, contradictory metadata or nonchronological rollback edges",async t=>{
 const f=await fixture(t),appId="application_first",platform="android",target=await f.publish(appId,platform,now-10000),source=await f.publish(appId,platform,now-9000),r1=await f.publish(appId,platform,now-8000,source,target),installationId=randomUUID();
 await f.report(appId,source,platform,installationId,[f.event("failed",now-8500)]);await f.report(appId,r1,platform,installationId,[f.event("launch_confirmed",now-7000)]);const installationRef=await f.ref(appId,r1),baseline=(await f.runtime.d1.prepare("SELECT * FROM ota_deployments WHERE id=?").bind(source).first()) as any;
 for(const [column,value]of [["owner_id","foreign_owner"],["app_id","application_foreign"],["platform","ios"],["channel","production"],["runtime_version","native-other"],["created_at",now-7000],["data",JSON.stringify({appId:"application_foreign"})]] as const){
  await f.runtime.d1.prepare(`UPDATE ota_deployments SET ${column}=? WHERE id=?`).bind(value,source).run();const page=await f.call("journey",{appId,deploymentId:r1,installationRef});assert.equal(page.status,200,JSON.stringify(page.value));assert.equal(page.value.rootDeploymentId,null,column);assert.deepEqual(page.value.deployments.map((d:any)=>d.id),[r1]);assert.ok(page.value.history.reasons.includes("lineage"));
  await f.runtime.d1.prepare(`UPDATE ota_deployments SET ${column}=? WHERE id=?`).bind(baseline[column],source).run();
 }
 await f.runtime.d1.prepare("UPDATE ota_deployments SET data=? WHERE id=?").bind(JSON.stringify({id:randomUUID()}),target).run();const targetMismatch=await f.call("journey",{appId,deploymentId:r1,installationRef});assert.equal(targetMismatch.value.rootDeploymentId,null,"the reused target JSON cannot contradict its authoritative publication columns");
 const sourceRef=await f.ref(appId,source),rootOnly=await f.call("journey",{appId,deploymentId:source,installationRef:sourceRef});assert.equal(rootOnly.value.rootDeploymentId,source);assert.deepEqual(rootOnly.value.deployments.map((d:any)=>d.id),[source]);assert.equal(rootOnly.value.history.complete,false);assert.ok(rootOnly.value.history.reasons.includes("lineage"),"an unproved same-scope child must not disappear behind a complete-history claim");
});
