import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createTestRuntime } from "./runtime.ts";

const now=1_800_000_000_000, origin="https://telemetry.example.test", appA="application_first",appB="application_second";
const deploymentA="ba0ded11-d92f-4d64-b8e0-a98bc5693fee",deploymentB="7e83448c-5391-4a65-87c9-05b9817e103e";
const install=()=>randomUUID();
const session=(installationId=install(),deploymentId=deploymentA,platform="android")=>({installationId,deploymentId,platform,channel:"verification",runtimeVersion:"native-v1",environment:platform==="android"?"android-emulator":"ios-simulator"});
const event=(type:string,extra:Record<string,unknown>={})=>({id:randomUUID(),type,observedAt:now,...extra});
async function fixture(t:test.TestContext){
 const runtime=await createTestRuntime({entrypoint:new URL("./fixtures/sdk-telemetry-entry.ts",import.meta.url),durableObjects:{TELEMETRY:"TelemetryFixture"}});t.after(()=>runtime.dispose());
 await runtime.d1.exec(`CREATE TABLE flora_deployment(singleton INTEGER PRIMARY KEY,owner_id TEXT,origin TEXT,db_identity TEXT);
CREATE TABLE applications(owner_id TEXT,id TEXT,PRIMARY KEY(owner_id,id));
CREATE TABLE ota_deployments(owner_id TEXT,app_id TEXT,id TEXT,platform TEXT,channel TEXT,runtime_version TEXT,created_at INTEGER,data TEXT,PRIMARY KEY(owner_id,app_id,id));`);
 await runtime.d1.prepare("INSERT INTO flora_deployment VALUES(1,?,?,?)").bind("owner_a",origin,"db_a").run();
 for(const [app,id,platform] of [[appA,deploymentA,"android"],[appB,deploymentB,"ios"]]){
  await runtime.d1.prepare("INSERT INTO applications VALUES(?,?)").bind("owner_a",app).run();
  await runtime.d1.prepare("INSERT INTO ota_deployments VALUES(?,?,?,?,?,?,?,?)").bind("owner_a",app,id,platform,"verification","native-v1",now-1000,JSON.stringify({preserved:"old-history"})).run();
 }
 const call=async(op:string,input:unknown=null,extra:Record<string,unknown>={})=>{const response=await runtime.fetch(origin,{method:"POST",body:JSON.stringify({op,input,...extra})});return {status:response.status,value:await response.json() as any};};
 const latest=async(appId=appA,deploymentId=deploymentA)=>(await call("latest",[{appId,deploymentId}])).value[JSON.stringify([appId,deploymentId])];
 return {runtime,call,latest};
}


test("current issues require both newer confirmations, reopen on relapse and ignore another installation's recovery",async t=>{
 const {call,latest}=await fixture(t),token=(await call("session",session())).value.token;
 const post=async(items:any[])=>assert.equal((await call("report",{token,events:items})).status,200);
 const state=async()=> (await latest()).issueResolution;
 await post([event("failed",{stage:"download",code:"TIMEOUT",observedAt:now+10})]);
 assert.deepEqual(await state(),{unresolvedInstallations:1,resolvedInstallations:0,unknownInstallations:0});
 const other=(await call("session",session())).value.token;
 await call("report",{token:other,events:[event("launch_confirmed",{observedAt:now+30}),event("restart_confirmed",{observedAt:now+30})]});
 assert.deepEqual(await state(),{unresolvedInstallations:1,resolvedInstallations:0,unknownInstallations:0});
 await post([event("restart_confirmed",{observedAt:now+20}),event("launch_confirmed",{observedAt:now+10})]);
 assert.equal((await state()).unresolvedInstallations,1,"equal launch is not a recovery");
 await post([event("launch_confirmed",{observedAt:now+21})]);
 assert.deepEqual(await state(),{unresolvedInstallations:0,resolvedInstallations:1,unknownInstallations:0});
 await post([event("rolled_back",{stage:"launch",code:"UNCONFIRMED_LAUNCH",observedAt:now+30})]);
 assert.deepEqual(await state(),{unresolvedInstallations:1,resolvedInstallations:0,unknownInstallations:0});
 assert.equal((await latest()).recoveredInstallations,1,"historical recovered counter remains cumulative");
 await post([event("failed",{stage:"download",code:"TIMEOUT",observedAt:now+11}),event("launch_confirmed",{observedAt:now+25}),event("restart_confirmed",{observedAt:now+30})]);
 assert.equal((await state()).unresolvedInstallations,1,"reordered older events cannot erase the latest failure");
 await post([event("launch_confirmed",{observedAt:now+31}),event("restart_confirmed",{observedAt:now+32})]);
 await call("restart");assert.deepEqual(await state(),{unresolvedInstallations:0,resolvedInstallations:1,unknownInstallations:0});
 const foreign=(await call("session",session(install(),deploymentB,"ios"),{appId:appB})).value.token;
 await call("report",{token:foreign,events:[event("failed",{stage:"launch",code:"UNKNOWN"})]},{appId:appB});
 assert.equal((await latest(appB,deploymentB)).issueResolution.unresolvedInstallations,1);
 assert.equal((await state()).resolvedInstallations,1);
});


async function dropProjection(call:any){
 for(const sql of ["DELETE FROM flora_sdk_telemetry_issue_state RETURNING installation_hash","DELETE FROM flora_sdk_telemetry_issue_aggregates RETURNING app_id","DELETE FROM flora_sdk_telemetry_meta WHERE key='issue-resolution-v1' RETURNING key"])assert.equal((await call("debug",null,{sql})).status,200);
 await call("restart");
}
async function rawSnapshot(call:any){
 const result:any={};for(const table of ["installations","aggregates","journal","failures","installation_failures"])result[table]=(await call("debug",null,{sql:`SELECT * FROM flora_sdk_telemetry_${table} ORDER BY 1,2,3,4`})).value.rows;return result;
}

test("one-time complete-journal backfill finds relapse without rewriting raw histories or cumulative counters",async t=>{
 const {call,latest}=await fixture(t),token=(await call("session",session())).value.token;
 await call("report",{token,events:[event("failed",{stage:"download",code:"TIMEOUT",observedAt:now+1}),event("launch_confirmed",{observedAt:now+3}),event("restart_confirmed",{observedAt:now+4}),event("rolled_back",{stage:"launch",code:"UNCONFIRMED_LAUNCH",observedAt:now+5})]});
 const before=await rawSnapshot(call);await dropProjection(call);
 assert.deepEqual((await latest()).issueResolution,{unresolvedInstallations:1,resolvedInstallations:0,unknownInstallations:0});
 assert.equal((await latest()).recoveredInstallations,1);assert.deepEqual(await rawSnapshot(call),before);
 // Existing projection is authoritative after journal capacity is reached. No
 // repeated backfill scan and no loss of current state on object reconstruction.
 await call("debug",null,{sql:"UPDATE flora_sdk_telemetry_meta SET value='50000' WHERE key='journal-count' RETURNING key"});
 await call("report",{token,events:[event("launch_confirmed",{observedAt:now+6}),event("restart_confirmed",{observedAt:now+7})]});
 await call("restart");assert.deepEqual((await latest()).issueResolution,{unresolvedInstallations:0,resolvedInstallations:1,unknownInstallations:0});
 assert.equal((await call("detail")).value.installations[0].history.complete,false);
 const plan=(await call("debug",null,{sql:`EXPLAIN QUERY PLAN SELECT a.app_id,a.deployment_id,a.data,r.unresolved,r.resolved,r.unknown FROM json_each('[{"appId":"${appA}","deploymentId":"${deploymentA}"}]') t JOIN flora_sdk_telemetry_aggregates a ON a.owner_id='owner_a' AND a.app_id=json_extract(t.value,'$.appId') AND a.deployment_id=json_extract(t.value,'$.deploymentId') LEFT JOIN flora_sdk_telemetry_issue_aggregates r ON r.owner_id=a.owner_id AND r.app_id=a.app_id AND r.deployment_id=a.deployment_id`})).value.rows;
 assert.match(JSON.stringify(plan),/SEARCH a USING INDEX/);assert.match(JSON.stringify(plan),/SEARCH r USING INDEX/);assert.doesNotMatch(JSON.stringify(plan),/SCAN a|SCAN r|flora_sdk_telemetry_installations|flora_sdk_telemetry_journal/);
});

test("legacy failure aggregate upper bound proves recovery and never reopens because another installation failed later",async t=>{
 const {call,latest}=await fixture(t),token=(await call("session",session())).value.token;
 await call("report",{token,events:[event("failed",{stage:"download",code:"TIMEOUT",observedAt:now+1}),event("launch_confirmed",{observedAt:now+3}),event("restart_confirmed",{observedAt:now+4})]});
 await call("debug",null,{sql:"UPDATE flora_sdk_telemetry_installations SET data=json_remove(data,'$.detailHistory') RETURNING installation_hash"});
 await call("debug",null,{sql:"DELETE FROM flora_sdk_telemetry_journal RETURNING event_hash"});
 const before=await rawSnapshot(call);await dropProjection(call);
 assert.deepEqual((await latest()).issueResolution,{unresolvedInstallations:0,resolvedInstallations:1,unknownInstallations:0});
 const detail=(await call("detail")).value.installations[0];assert.equal(detail.issueStatus,"resolved");assert.equal(detail.issueOrderKnown,true);assert.equal(detail.history.complete,false);assert.deepEqual(await rawSnapshot(call),before);
 const other=(await call("session",session())).value.token;await call("report",{token:other,events:[event("failed",{stage:"launch",code:"UNKNOWN",observedAt:now+20})]});
 assert.deepEqual((await latest()).issueResolution,{unresolvedInstallations:1,resolvedInstallations:1,unknownInstallations:0});
 await call("restart");assert.equal((await latest()).issueResolution.resolvedInstallations,1);
 await call("report",{token,events:[event("failed",{stage:"launch",code:"UNKNOWN",observedAt:now+30})]});
 assert.deepEqual((await latest()).issueResolution,{unresolvedInstallations:2,resolvedInstallations:0,unknownInstallations:0});
});

test("incomplete legacy order stays unresolved until newer evidence proves it and does not trust sticky recovered",async t=>{
 const {call,latest}=await fixture(t),token=(await call("session",session())).value.token;
 await call("report",{token,events:[event("failed",{stage:"download",code:"TIMEOUT",observedAt:now+1}),event("launch_confirmed",{observedAt:now+3}),event("restart_confirmed",{observedAt:now+4})]});
 await call("debug",null,{sql:"UPDATE flora_sdk_telemetry_installations SET data=json_set(data,'$.detailHistory.legacy',json('true'),'$.lastReportedAt',1800000000020) RETURNING installation_hash"});
 // Missing old aggregate ordering cannot be reconstructed from a recovered flag.
 await call("debug",null,{sql:"DELETE FROM flora_sdk_telemetry_journal RETURNING event_hash"});await call("debug",null,{sql:"DELETE FROM flora_sdk_telemetry_failures RETURNING app_id"});
 await dropProjection(call);assert.deepEqual((await latest()).issueResolution,{unresolvedInstallations:1,resolvedInstallations:0,unknownInstallations:1});
 const unknown=(await call("detail")).value.installations[0];assert.equal(unknown.recovered,true);assert.equal(unknown.issueStatus,"unresolved");assert.equal(unknown.issueOrderKnown,false);
 await call("report",{token,events:[event("failed",{stage:"download",code:"TIMEOUT",observedAt:now+10}),event("launch_confirmed",{observedAt:now+15}),event("restart_confirmed",{observedAt:now+15})]});
 assert.equal((await latest()).issueResolution.unknownInstallations,1,"older evidence cannot erase an uncertainty bound");
 await call("report",{token,events:[event("failed",{stage:"launch",code:"UNKNOWN",observedAt:now+20}),event("launch_confirmed",{observedAt:now+20}),event("restart_confirmed",{observedAt:now+21})]});
 assert.deepEqual((await latest()).issueResolution,{unresolvedInstallations:1,resolvedInstallations:0,unknownInstallations:0},"failure at the upper bound establishes ordering; equal launch does not resolve");
 await call("report",{token,events:[event("launch_confirmed",{observedAt:now+22})]});assert.equal((await latest()).issueResolution.resolvedInstallations,1);
});

test("resolved and unresolved pages use indexed current state, isolate cursors and retain the complete issue journal",async t=>{
 const {call}=await fixture(t);
 for(let i=0;i<23;i++){
  const token=(await call("session",session())).value.token;assert.equal((await call("report",{token,events:[event("failed",{stage:"download",code:"TIMEOUT",observedAt:now+1}),...(i<21?[event("launch_confirmed",{observedAt:now+2}),event("restart_confirmed",{observedAt:now+3})]:[])]})).status,200);
 }
 const resolved=(await call("detail",null,{filter:"resolved"})).value;assert.equal(resolved.filter,"resolved");assert.equal(resolved.installations.length,20);assert.ok(resolved.installations.every((row:any)=>row.issueStatus==="resolved"&&row.issueOrderKnown));assert.ok(resolved.nextCursor);
 const last=(await call("detail",null,{filter:"resolved",cursor:resolved.nextCursor})).value;assert.equal(last.installations.length,1);assert.equal(last.nextCursor,null);
 const unresolved=(await call("detail",null,{filter:"unresolved"})).value;assert.equal(unresolved.installations.length,2);assert.ok(unresolved.installations.every((row:any)=>row.issueStatus==="unresolved"));
 const reads=(await call("debug")).value.reads;
 for(const extra of [{filter:"unresolved",cursor:resolved.nextCursor},{filter:"issues",cursor:resolved.nextCursor},{cursor:resolved.nextCursor},{filter:"resolved",cursor:resolved.nextCursor,appId:appB},{filter:"resolved",installationRef:resolved.installations[0].id}])assert.equal((await call("detail",null,extra)).status,400);
 assert.equal((await call("debug")).value.reads,reads);
 const timeline=(await call("detail",null,{installationRef:resolved.installations[0].id})).value;assert.equal(timeline.events.length,3);assert.ok(timeline.events.some((event:any)=>event.type==="failed"));assert.equal(timeline.installation.issueStatus,"resolved");
 const all=(await call("detail",null,{filter:"issues"})).value;assert.equal(all.summary.failedInstallations,23);assert.equal(all.summary.issueResolution.resolvedInstallations,21);assert.equal(all.summary.issueResolution.unresolvedInstallations,2);
 const plan=(await call("debug",null,{sql:`EXPLAIN QUERY PLAN SELECT s.installation_hash,i.data FROM flora_sdk_telemetry_issue_state s JOIN flora_sdk_telemetry_installations i ON i.owner_id=s.owner_id AND i.app_id=s.app_id AND i.deployment_id=s.deployment_id AND i.installation_hash=s.installation_hash WHERE s.owner_id='owner_a' AND s.app_id='${appA}' AND s.deployment_id='${deploymentA}' AND s.status='unresolved' AND s.installation_hash>'' ORDER BY s.installation_hash LIMIT 21`})).value.rows;
 assert.match(JSON.stringify(plan),/SEARCH s USING COVERING INDEX flora_sdk_telemetry_issue_state_page/);assert.match(JSON.stringify(plan),/SEARCH i USING INDEX/);assert.doesNotMatch(JSON.stringify(plan),/SCAN s|SCAN i|USE TEMP B-TREE/);
});

test("resolution migration is fenced and atomic; repeated latest reads never revisit installation or journal history",async t=>{
 const {call,latest}=await fixture(t),token=(await call("session",session())).value.token;
 await call("report",{token,events:[event("rolled_back",{stage:"launch",code:"UNCONFIRMED_LAUNCH",observedAt:now+1})]});
 const before=await rawSnapshot(call);await dropProjection(call);
 // latest: owner fence, migration fence, transaction fence, then final fence.
 assert.equal((await call("latest",[{appId:appA,deploymentId:deploymentA}],{failFenceAt:4})).status,401);
 assert.deepEqual((await call("debug",null,{sql:"SELECT * FROM flora_sdk_telemetry_issue_state"})).value.rows,[]);
 assert.deepEqual((await call("debug",null,{sql:"SELECT value FROM flora_sdk_telemetry_meta WHERE key='issue-resolution-v1'"})).value.rows,[]);
 assert.deepEqual(await rawSnapshot(call),before);
 const expected=await latest();assert.equal(expected.issueResolution.unresolvedInstallations,1);
 // Failure/success summary reads must remain available using persisted counts,
 // without reading either raw table after the once-only projection is ready.
 await call("debug",null,{sql:"DROP TABLE flora_sdk_telemetry_installations"});await call("debug",null,{sql:"DROP TABLE flora_sdk_telemetry_journal"});
 for(let i=0;i<3;i++)assert.deepEqual(await latest(),expected);
});

test("rejected observation rolls back current-state counts with original telemetry and retries exactly once",async t=>{
 const {call,latest}=await fixture(t),token=(await call("session",session())).value.token;
 await call("observe");const batch=[event("failed",{stage:"download",code:"TIMEOUT"})];
 assert.equal((await call("report",{token,events:batch},{observationFailure:true})).status,503);
 assert.equal(await latest(),undefined);assert.deepEqual((await call("debug",null,{sql:"SELECT * FROM flora_sdk_telemetry_issue_state"})).value.rows,[]);
 assert.equal((await call("report",{token,events:batch})).value.accepted,1);const expected=await latest();assert.equal(expected.issueResolution.unresolvedInstallations,1);
 assert.equal((await call("report",{token,events:batch})).value.duplicates,1);assert.deepEqual(await latest(),expected);
});
