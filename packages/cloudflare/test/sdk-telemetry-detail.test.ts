import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTestRuntime } from "./runtime.ts";

const now=1_800_000_000_000,origin="https://telemetry.example.test",app="application_first",other="application_second";
const deployment="ba0ded11-d92f-4d64-b8e0-a98bc5693fee",second="7e83448c-5391-4a65-87c9-05b9817e103e";
async function fixture(t:test.TestContext){
 const runtime=await createTestRuntime({entrypoint:new URL("./fixtures/sdk-telemetry-entry.ts",import.meta.url),durableObjects:{TELEMETRY:"TelemetryFixture"}});t.after(()=>runtime.dispose());
 await runtime.d1.exec(`CREATE TABLE flora_deployment(singleton INTEGER PRIMARY KEY,owner_id TEXT,origin TEXT,db_identity TEXT);
 CREATE TABLE applications(owner_id TEXT,id TEXT,PRIMARY KEY(owner_id,id));
 CREATE TABLE ota_deployments(owner_id TEXT,app_id TEXT,id TEXT,platform TEXT,channel TEXT,runtime_version TEXT,created_at INTEGER,data TEXT,PRIMARY KEY(owner_id,app_id,id));`);
 await runtime.d1.prepare("INSERT INTO flora_deployment VALUES(1,?,?,?)").bind("owner_a",origin,"db_a").run();
 for(const name of [app,other]){await runtime.d1.prepare("INSERT INTO applications VALUES(?,?)").bind("owner_a",name).run();for(const id of [deployment,second])await runtime.d1.prepare("INSERT INTO ota_deployments VALUES(?,?,?,?,?,?,?,?)").bind("owner_a",name,id,"android","verification","native-v1",now-1000,JSON.stringify({commitSha:"a".repeat(40),preserved:true})).run();}
 const call=async(op:string,input:unknown=null,extra:Record<string,unknown>={})=>{const response=await runtime.fetch(origin,{method:"POST",body:JSON.stringify({op,input,...extra})});return {status:response.status,value:await response.json() as any};};
 const ticket=async(installationId=randomUUID(),appId=app,deploymentId=deployment)=>{const response=await call("session",{installationId,deploymentId,platform:"android",channel:"verification",runtimeVersion:"native-v1",environment:"android-emulator"},{appId});assert.equal(response.status,200);return response.value.token;};
 const event=(type:string,offset=0,extra={})=>({id:randomUUID(),type,observedAt:now+offset,...extra});
 return {runtime,call,ticket,event};
}

test("device detail exposes only scoped pseudonyms, real event times and independent recovery, preserving legacy history",async t=>{
 const {runtime,call,ticket,event}=await fixture(t),sdkId=randomUUID(),token=await ticket(sdkId);
 const before=(await runtime.d1.prepare("SELECT * FROM ota_deployments ORDER BY app_id,id").all()).results;
 const batch=[event("failed",1,{stage:"download",code:"NETWORK_UNAVAILABLE"}),event("downloaded",2),event("launch_confirmed",3),event("restart_confirmed",4)];
 assert.equal((await call("report",{token,events:batch})).status,200);
 assert.equal((await call("report",{token,events:batch})).value.duplicates,4);
 const reads=(await call("debug")).value.reads,page=await call("detail");assert.equal(page.status,200,JSON.stringify(page.value));assert.equal((await call("debug")).value.reads-reads,2);
 assert.equal(page.value.installations.length,1);assert.equal(page.value.pageSize,20);assert.equal(page.value.nextCursor,null);
 const row=page.value.installations[0];assert.equal(row.downloaded,true);assert.equal(row.applied,true);assert.equal(row.restarted,true);assert.equal(row.failed,true);assert.equal(row.recovered,true);
 assert.deepEqual(row.history,{complete:true,reason:null,recordedEvents:4,omittedEvents:0,startedAt:now});assert.equal(row.firstFailureAt,now+1);assert.equal(row.latestConfirmedAt,now+3);
 assert.deepEqual(page.value.deployment,{id:deployment,platform:"android",channel:"verification",runtimeVersion:"native-v1",createdAt:now-1000,commitSha:"a".repeat(40)});
 assert.deepEqual(row.failures,[{stage:"download",code:"NETWORK_UNAVAILABLE"}]);
 const timeline=await call("detail",null,{installationRef:row.id});assert.equal(timeline.status,200);assert.deepEqual(timeline.value.events,batch.slice().reverse().map(({id,...value})=>({...value,receivedAt:now})));
 assert.equal(timeline.value.installation.label,row.label);
 const raw=(await call("debug",null,{sql:"SELECT installation_hash FROM flora_sdk_telemetry_installations"})).value.rows[0].installation_hash;
 assert.doesNotMatch(JSON.stringify([page.value,timeline.value]),new RegExp(`${sdkId}|${token}|${raw}|198\\.51|old-history`));
 for(const scope of [{appId:other},{deploymentId:second},{config:{ownerId:"other_owner"}}])assert.notEqual((await call("detail",null,{installationRef:row.id,...scope})).status,200);
 assert.equal((await call("detail",null,{installationRef:row.id.slice(0,-1)+(row.id.endsWith("A")?"B":"A")})).status,404);
 await call("restart");assert.equal((await call("detail",null,{installationRef:row.id})).value.events.length,4);
 await call("debug",null,{sql:"UPDATE flora_sdk_telemetry_installations SET data=json_remove(data,'$.detailHistory') RETURNING installation_hash"});
 const legacy=(await call("detail")).value.installations[0];assert.equal(legacy.history.complete,false);assert.equal(legacy.history.reason,"legacy");assert.equal(legacy.history.startedAt,null);
 assert.equal(legacy.downloaded,true);assert.equal(legacy.firstFailureAt,now+1);
 assert.deepEqual((await runtime.d1.prepare("SELECT * FROM ota_deployments ORDER BY app_id,id").all()).results,before);
});

test("indexed keyset device and event pages are bounded, reject scope reuse and never query D1 for invalid cursors",async t=>{
 const {call,ticket,event}=await fixture(t);
 for(let index=0;index<23;index++){const token=await ticket();assert.equal((await call("report",{token,events:Array.from({length:index===0?25:1},()=>event("update_seen")).slice(0,16)})).status,200);if(index===0)assert.equal((await call("report",{token,events:Array.from({length:9},()=>event("downloaded"))})).status,200);}
 const first=(await call("detail")).value;assert.equal(first.installations.length,20);assert.equal(typeof first.nextCursor,"string");
 const secondPage=(await call("detail",null,{cursor:first.nextCursor})).value;assert.equal(secondPage.installations.length,3);assert.equal(secondPage.nextCursor,null);
 assert.equal(new Set([...first.installations,...secondPage.installations].map((row:any)=>row.label)).size,23);
 const heavy=[...first.installations,...secondPage.installations].find((row:any)=>row.history.recordedEvents===25);
 const timeline=(await call("detail",null,{installationRef:heavy.id})).value;assert.equal(timeline.events.length,20);assert.ok(timeline.nextCursor);
 const last=(await call("detail",null,{installationRef:heavy.id,cursor:timeline.nextCursor})).value;assert.equal(last.events.length,5);assert.equal(last.nextCursor,null);
 const reads=(await call("debug")).value.reads;
 for(const cursor of ["bad",first.nextCursor.slice(0,-2)+"XX"]){assert.equal((await call("detail",null,{cursor})).status,400);}
 assert.equal((await call("detail",null,{cursor:first.nextCursor,appId:other})).status,400);
 assert.equal((await call("detail",null,{cursor:timeline.nextCursor})).status,400);assert.equal((await call("debug")).value.reads,reads);
 for(const sql of ["EXPLAIN QUERY PLAN SELECT installation_hash,data FROM flora_sdk_telemetry_installations WHERE owner_id='owner_a' AND app_id='application_first' AND deployment_id='ba0ded11-d92f-4d64-b8e0-a98bc5693fee' AND installation_hash>'' ORDER BY installation_hash LIMIT 21","EXPLAIN QUERY PLAN SELECT * FROM flora_sdk_telemetry_journal WHERE owner_id='owner_a' AND app_id='application_first' AND deployment_id='ba0ded11-d92f-4d64-b8e0-a98bc5693fee' AND installation_hash='x' AND (observed_at,event_hash)<(1800000000000,'x') ORDER BY observed_at DESC,event_hash DESC LIMIT 21"]){const plan=JSON.stringify((await call("debug",null,{sql})).value.rows);assert.match(plan,/SEARCH/);assert.doesNotMatch(plan,/SCAN flora_sdk|USE TEMP B-TREE/);}
});

test("journal capacity never rejects accepted SDK reports or deletes historical event details",async t=>{
 const {call,ticket,event}=await fixture(t),token=await ticket();await call("report",{token,events:[event("downloaded")]});
 await call("debug",null,{sql:"UPDATE flora_sdk_telemetry_meta SET value='50000' WHERE key='journal-count' RETURNING value"});
 assert.equal((await call("report",{token,events:[event("failed",1,{stage:"download",code:"TIMEOUT"}),event("launch_confirmed",2),event("restart_confirmed",3)]})).status,200);
 const page=(await call("detail")).value,row=page.installations[0];assert.equal(page.summary.applicationRate,100);assert.equal(page.summary.recoveredInstallations,1);assert.equal(row.history.complete,false);assert.equal(row.history.reason,"capacity");assert.equal(row.history.recordedEvents,1);assert.equal(row.history.omittedEvents,3);
 assert.equal((await call("detail",null,{installationRef:row.id})).value.events.length,1);
 assert.equal((await call("detail",null,{failFenceAt:1})).status,401);assert.equal((await call("detail",null,{config:{dbIdentity:"wrong"}})).status,409);
});

test("one installation's journal remains bounded and survives expiry of the independent replay cache",async t=>{
 const {call,ticket,event}=await fixture(t),installationId=randomUUID(),token=await ticket(installationId);
 for(let batch=0;batch<17;batch++){const at=now+Math.floor(batch/4)*3_600_000;const events=Array.from({length:16},(_,index)=>event("update_seen",at-now+index));assert.equal((await call("report",{token,events},{now:at})).status,200);}
 const first=(await call("detail")).value.installations[0];assert.equal(first.history.recordedEvents,256);assert.equal(first.history.omittedEvents,16);assert.equal(first.history.reason,"capacity");
 assert.equal((await call("debug",null,{sql:"SELECT count(*) AS total FROM flora_sdk_telemetry_journal"})).value.rows[0].total,256);
 const later=now+8*86_400_000,renewed=await call("session",{installationId,deploymentId:deployment,platform:"android",channel:"verification",runtimeVersion:"native-v1",environment:"android-emulator"},{now:later});assert.equal(renewed.status,200);
 assert.equal((await call("debug",null,{sql:"SELECT count(*) AS total FROM flora_sdk_telemetry_events"})).value.rows[0].total,0);
 assert.equal((await call("debug",null,{sql:"SELECT count(*) AS total FROM flora_sdk_telemetry_journal"})).value.rows[0].total,256);
 const inspected=(await call("detail",null,{installationRef:first.id,now:later})).value;assert.equal(inspected.events.length,20);assert.equal(inspected.installation.history.recordedEvents,256);
});


test("owner installation authorization resolves only an existing sealed app and deployment reference with two indexed D1 guards",async t=>{
 const {call,ticket,event,runtime}=await fixture(t),rawId=randomUUID(),token=await ticket(rawId);
 await call("report",{token,events:[event("downloaded")]});
 const row=(await call("detail")).value.installations[0];
 const hash=(await call("debug",null,{sql:"SELECT installation_hash FROM flora_sdk_telemetry_installations"})).value.rows[0].installation_hash;
 const before=(await call("debug")).value.reads;
 const resolved=await call("resolve",null,{installationRef:row.id});assert.equal(resolved.status,200);assert.deepEqual(resolved.value,{installationHash:hash});
 assert.equal((await call("debug")).value.reads-before,2);
 const reads=(await call("debug")).value.reads;
 for(const scope of [{appId:other},{deploymentId:second},{config:{ownerId:"other_owner"}},{installationRef:"i1.invalid"}])assert.equal((await call("resolve",null,{installationRef:row.id,...scope})).status,404);
 assert.equal((await call("debug")).value.reads,reads,"invalid opaque references are rejected before D1 lookup");
 await runtime.d1.prepare("DELETE FROM ota_deployments WHERE app_id=? AND id=?").bind(app,deployment).run();
 assert.equal((await call("resolve",null,{installationRef:row.id})).status,404,"a valid reference cannot authorize an unpublished scope");
 // Restore only the synthetic fixture row to check removal of an installation independently.
 await runtime.d1.prepare("INSERT INTO ota_deployments VALUES(?,?,?,?,?,?,?,?)").bind("owner_a",app,deployment,"android","verification","native-v1",now-1000,"{}").run();
 await call("debug",null,{sql:"DELETE FROM flora_sdk_telemetry_installations RETURNING installation_hash"});
 assert.equal((await call("resolve",null,{installationRef:row.id})).status,404,"a sealed reference does not create or resurrect an installation");
});

test("owner detail exposes only automatic rollback eligibility and keeps hashes private when an eligibility lookup is supplied",async t=>{
 const {call,ticket,event}=await fixture(t),rawId=randomUUID(),token=await ticket(rawId);
 await call("report",{token,events:[event("downloaded")]});
 const raw=(await call("debug",null,{sql:"SELECT installation_hash FROM flora_sdk_telemetry_installations"})).value.rows[0].installation_hash;
 const legacy=(await call("detail")).value;assert.equal(Object.hasOwn(legacy.installations[0],"automaticRollbackEligible"),false);
 const denied=(await call("detail",null,{eligibility:true})).value;assert.equal(denied.installations[0].automaticRollbackEligible,false);
 const allowed=(await call("detail",null,{eligibility:true,allowedInstallationHash:raw})).value;assert.equal(allowed.installations[0].automaticRollbackEligible,true);
 const timeline=(await call("detail",null,{installationRef:allowed.installations[0].id,eligibility:true,allowedInstallationHash:raw})).value;
 assert.equal(timeline.installation.automaticRollbackEligible,true);
 assert.doesNotMatch(JSON.stringify([denied,allowed,timeline]),new RegExp(`${raw}|${rawId}|${token}`));
});


test("bounded device clock skew accepts publication minus 120 seconds and preserves original lifecycle timestamps without weakening ticket scope",async t=>{
 const {call,ticket,event}=await fixture(t);await call("observe");const token=await ticket(),publishedAt=now-1000;
 const boundary=event("update_seen",-121000),download=event("downloaded",-4397);
 const activation=event("activation_requested",-4391),rollback=event("rolled_back",-1100,{stage:"launch",code:"UNCONFIRMED_LAUNCH"});
 const tooOld=event("update_seen",-121001);
 assert.equal((await call("report",{token,events:[boundary,tooOld]})).status,400,"publication minus 120,001ms rejects the entire batch");
 assert.equal((await call("detail")).value.installations.length,0,"a rejected skew batch leaves no installation history");
 const reads=(await call("debug")).value.reads;
 const input={token,events:[boundary,download,activation,rollback]};
 const accepted=await call("report",input);assert.equal(accepted.status,200,JSON.stringify(accepted.value));assert.equal(accepted.value.accepted,4);
 assert.equal((await call("debug")).value.reads,reads,"skew tolerance adds no D1 reads to SDK reports");
 assert.equal((await call("report",input,{appId:other})).status,401,"clock tolerance never bypasses the signed app scope");
 assert.equal((await call("report",{token,events:[event("update_seen",120001)]})).status,400,"the existing future-clock bound remains unchanged");
 assert.equal((await call("report",{token,events:[boundary]},{now:now+7*86400000-1})).status,400,"the seven-day event age bound still applies independently");
 const page=(await call("detail")).value,timeline=(await call("detail",null,{installationRef:page.installations[0].id})).value;
 assert.deepEqual(timeline.events,[rollback,activation,download,boundary].map(({id,...value})=>({...value,receivedAt:now})),"owner history retains original device timestamps without clamping or rewriting them");
 const observations=(await call("debug",null,{sql:"SELECT data FROM observation_fixture"})).value.rows;
 assert.equal(observations.length,1);const observed=JSON.parse(observations[0].data);
 assert.equal(observed.publishedAt,publishedAt);assert.deepEqual(observed.events,[boundary,download,activation,rollback].map(({id,...value})=>value));
 assert.ok(observed.events.find((value:any)=>value.type==="activation_requested").observedAt<publishedAt);
 assert.ok(observed.events.find((value:any)=>value.type==="rolled_back").observedAt<publishedAt);
});


test("issue device pages skip healthy prefixes, include recovered history and use an additive indexed scope without rewriting data",async t=>{
 const {call}=await fixture(t);
 const flags=(i:number)=>JSON.stringify({environment:"android-emulator",downloaded:1,applied:1,restartReported:1,restarted:1,failed:i>=26?1:0,rolledBack:i===25?1:0,recovered:i===26?1:0,lastReportedAt:now,firstFailureAt:i>=25?now-10:0,latestConfirmedAt:now,latestRestartAt:now,legacyMarker:"preserve byte whitespace"});
 for(let i=0;i<47;i++){const hash=String(i).padStart(43,"0");const data=flags(i).replace('{','{ ');assert.equal((await call("debug",null,{sql:`INSERT INTO flora_sdk_telemetry_installations VALUES('owner_a','${app}','${deployment}','${hash}','${data}') RETURNING installation_hash`})).status,200);}
 // An issue in another app must never enter this deployment page.
 await call("debug",null,{sql:`INSERT INTO flora_sdk_telemetry_installations VALUES('owner_a','${other}','${deployment}','${"Z".repeat(43)}','${flags(25)}') RETURNING installation_hash`});
 const snapshot=(await call("debug",null,{sql:"SELECT * FROM flora_sdk_telemetry_installations ORDER BY owner_id,app_id,deployment_id,installation_hash"})).value.rows;
 await call("debug",null,{sql:"DROP INDEX IF EXISTS flora_sdk_telemetry_installations_issues"});await call("restart");
 const all=(await call("detail")).value;assert.equal(all.installations.length,20);assert.equal(Object.hasOwn(all,"filter"),false);assert.ok(all.installations.every((row:any)=>!row.failed&&!row.rolledBack));
 const reads=(await call("debug")).value.reads;
 const first=(await call("detail",null,{filter:"issues"})).value;assert.equal(first.filter,"issues");assert.equal(first.installations.length,20);assert.ok(first.installations.every((row:any)=>row.failed||row.rolledBack));assert.ok(first.installations.some((row:any)=>row.recovered));assert.ok(first.installations.some((row:any)=>row.rolledBack&&!row.failed),"native rollback without a failed flag remains an issue");assert.equal((await call("debug")).value.reads-reads,2);
 const last=(await call("detail",null,{filter:"issues",cursor:first.nextCursor})).value;assert.equal(last.installations.length,2);assert.equal(last.nextCursor,null);assert.equal(new Set([...first.installations,...last.installations].map((row:any)=>row.label)).size,22);
 const guardReads=(await call("debug")).value.reads;
 for(const extra of [{cursor:first.nextCursor},{filter:"issues",cursor:all.nextCursor},{filter:"issues",cursor:first.nextCursor,appId:other},{filter:"unknown"},{filter:"issues",installationRef:first.installations[0].id}])assert.equal((await call("detail",null,extra)).status,400);
 assert.equal((await call("debug")).value.reads,guardReads,"invalid filter and cross-mode cursors reject before D1");
 assert.equal((await call("detail",null,{installationRef:first.installations[0].id})).status,200,"issue refs retain the existing event scope");
 const sql=`EXPLAIN QUERY PLAN SELECT installation_hash,data FROM flora_sdk_telemetry_installations WHERE owner_id='owner_a' AND app_id='${app}' AND deployment_id='${deployment}' AND (json_extract(data,'$.failed')=1 OR json_extract(data,'$.rolledBack')=1) AND installation_hash>'' ORDER BY installation_hash LIMIT 21`;
 const plan=JSON.stringify((await call("debug",null,{sql})).value.rows);assert.match(plan,/SEARCH.*flora_sdk_telemetry_installations_issues/);assert.doesNotMatch(plan,/SCAN flora_sdk|USE TEMP B-TREE/);
 assert.deepEqual((await call("debug",null,{sql:"SELECT * FROM flora_sdk_telemetry_installations ORDER BY owner_id,app_id,deployment_id,installation_hash"})).value.rows,snapshot);
});
