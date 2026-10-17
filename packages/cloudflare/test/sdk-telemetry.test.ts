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

test("SDK reports aggregate unique installations, tolerate reorder/retries, and survive reconstruction without D1 event reads",async t=>{
 const {runtime,call,latest}=await fixture(t), installation=install();
 const before=(await runtime.d1.prepare("SELECT * FROM ota_deployments ORDER BY app_id").all()).results;
 const ticket=await call("session",session(installation));assert.equal(ticket.status,200);assert.equal(ticket.value.expiresAt,now+7*86400000);
 assert.equal(await latest(),undefined); // Issuance is not a device report.
 const restarted=event("restart_confirmed"),seen=event("update_seen"),download=event("downloaded");
 const first=await call("report",{token:ticket.value.token,events:[restarted,seen,download]});assert.equal(first.status,200);assert.deepEqual(first.value,{accepted:3,duplicates:0,acknowledged:[restarted.id,seen.id,download.id]});
 assert.equal((await latest()).restartedInstallations,0);assert.equal((await latest()).observedInstallations,1);
 const applied=event("launch_confirmed");assert.equal((await call("report",{token:ticket.value.token,events:[applied,download]})).status,200);
 const ready=await latest();assert.equal(ready.appliedInstallations,1);assert.equal(ready.restartedInstallations,1);assert.equal(ready.applicationRate,100);assert.equal(ready.environments.androidEmulator,1);
 const failure=event("failed",{stage:"download",code:"ASSET_HASH_MISMATCH"});
 assert.equal((await call("report",{token:ticket.value.token,events:[failure,failure]})).status,200);
 assert.equal((await latest()).failedInstallations,1);assert.equal((await latest()).failures[0].installations,1);
 const reads=(await call("debug")).value.reads;
 await call("restart");const retry=await call("report",{token:ticket.value.token,events:[applied,download]});assert.deepEqual(retry.value,{accepted:0,duplicates:2,acknowledged:[applied.id,download.id]});
 assert.equal((await call("debug")).value.reads,reads);assert.deepEqual(await latest(),{...ready,failedInstallations:1,issueResolution:{unresolvedInstallations:1,resolvedInstallations:0,unknownInstallations:0},failures:[{stage:"download",code:"ASSET_HASH_MISMATCH",installations:1,lastReportedAt:now}]});
 const other=await call("session",session(install()));await call("report",{token:other.value.token,events:[event("update_seen")]});assert.equal((await latest()).applicationRate,50);
 const second=await call("session",session(install(),deploymentB,"ios"),{appId:appB});assert.equal(second.status,200);await call("report",{token:second.value.token,events:[event("update_seen"),event("rolled_back",{stage:"launch",code:"UNCONFIRMED_LAUNCH"})]},{appId:appB});
 assert.equal((await latest(appB,deploymentB)).rolledBackInstallations,1);assert.equal((await latest()).observedInstallations,2);
 assert.doesNotMatch(JSON.stringify(await latest()),new RegExp(`${installation}|${ticket.value.token}|198\\.51|old-history`));
 assert.deepEqual((await runtime.d1.prepare("SELECT * FROM ota_deployments ORDER BY app_id").all()).results,before);
 const dump=await call("debug",null,{sql:"SELECT * FROM flora_sdk_telemetry_installations"});assert.doesNotMatch(JSON.stringify(dump.value),new RegExp(`${installation}|198\\.51`));
});

test("unknown device classification can become known without duplicating an installation",async t=>{
 const {call,latest}=await fixture(t),id=install();
 const unknown=await call("session",{...session(id),environment:"unknown"});assert.equal(unknown.status,200);
 const first=event("update_seen");assert.equal((await call("report",{token:unknown.value.token,events:[first]})).status,200);
 assert.equal((await latest()).environments.unknown,1);
 const known=await call("session",{...session(id),environment:"physical-device"});assert.equal(known.status,200);
 assert.equal((await call("report",{token:known.value.token,events:[first]})).status,200);
 const result=await latest();assert.equal(result.observedInstallations,1);assert.deepEqual(result.environments,{physicalDevice:1,androidEmulator:0,iosSimulator:0,unknown:0});
 const conflicts=await call("session",session(id));assert.equal(conflicts.status,200);
 assert.equal((await call("report",{token:conflicts.value.token,events:[event("downloaded")]})).status,409);
 assert.deepEqual(await latest(),result);
});

test("SDK tickets reject tamper, cross app/config/runtime, expiry, malformed events and revoked fences atomically",async t=>{
 const {call,latest}=await fixture(t);const input=session();
 for(const invalid of [{...input,installationId:"not-a-uuid"},{...input,deploymentId:undefined},{...input,deploymentId:"application_bad"},{...input,platform:"ios",environment:"android-emulator"},{...input,environment:"bad"},{...input,platform:["android"]},{...input,environment:["physical-device"]},{...input,deviceName:"PII"}])assert.equal((await call("session",invalid)).status,400);
 for(const invalid of [{...input,runtimeVersion:"wrong"},{...input,channel:"wrong"},{...input,platform:"ios",environment:"ios-simulator"}])assert.equal((await call("session",invalid)).status,409);
 assert.equal((await call("session",input,{appId:appB})).status,404);assert.equal((await call("session",input,{config:{dbIdentity:"wrong"}})).status,409);
 assert.equal((await call("session",input,{failFenceAt:10})).status,401); // Revoked after the indexed identity read.
 const ticket=(await call("session",input)).value.token;
 const valid=event("update_seen");const report={token:ticket,events:[valid]};
 assert.equal((await call("report",{...report,token:ticket.slice(0,-1)+(ticket.endsWith("A")?"B":"A")})).status,401);
 assert.equal((await call("report",report,{appId:appB})).status,401);
 for(const changed of [{ownerId:"owner_b"},{dbIdentity:"db_b"},{origin:"https://other.example.test"}])assert.equal((await call("report",report,{config:changed})).status,401);
 assert.equal((await call("report",report,{now:now+7*86400000})).status,401);
 for(const invalid of [{...valid,id:"bad"},{...valid,type:"invented"},{...valid,type:["downloaded"]},{...valid,observedAt:now+120001},{...valid,observedAt:now-121001},{...valid,observedAt:0},{...valid,stage:"check"},{...valid,deviceId:"PII"},event("failed",{stage:"download",code:"raw provider error"}),event("failed",{stage:["download"],code:"UNKNOWN"}),event("failed",{stage:"download",code:["UNKNOWN"]}),event("failed",{code:"UNKNOWN"})])assert.equal((await call("report",{token:ticket,events:[valid,invalid]})).status,400);
 assert.equal((await call("report",{token:ticket,events:[]})).status,400);assert.equal((await call("report",{token:ticket,events:Array.from({length:17},()=>valid)})).status,400);
 assert.equal((await call("report",{token:ticket,events:[valid],extra:"x"})).status,400);
 assert.equal((await call("report",report,{failFenceAt:4})).status,401);assert.equal(await latest(),undefined); // Revoked after HMAC verification.
 assert.equal((await call("report",report,{failFenceAt:13})).status,401);assert.equal(await latest(),undefined); // Synchronous transaction rolls back writes.
 assert.equal((await call("report",report)).status,200);assert.equal((await call("report",{token:ticket,events:[{...valid,type:"downloaded"}]})).status,409);assert.equal((await latest()).downloadedInstallations,0);
});

test("SDK capacity rejection preserves aggregates and event dedupe atomically, with bounded indexed summaries",async t=>{
 const {call,latest}=await fixture(t);const token=(await call("session",session())).value.token;
 const first=event("update_seen");assert.equal((await call("report",{token,events:[first]})).status,200);
 const baseline=await latest();
 await call("debug",null,{sql:"UPDATE flora_sdk_telemetry_meta SET value='99999' WHERE key='event-count' RETURNING value"});
 const batch=[event("downloaded"),event("launch_confirmed")];assert.equal((await call("report",{token,events:batch})).status,429);
 assert.deepEqual(await latest(),baseline);
 const events=(await call("debug",null,{sql:"SELECT count(*) AS total FROM flora_sdk_telemetry_events"})).value.rows;assert.equal(events[0].total,1);
 await call("debug",null,{sql:"UPDATE flora_sdk_telemetry_meta SET value='1' WHERE key='event-count' RETURNING value"});
 assert.equal((await call("report",{token,events:batch})).status,200);assert.equal((await latest()).applicationRate,100);
 const issued=(await call("session",session())).value.token;
 await call("debug",null,{sql:"UPDATE flora_sdk_telemetry_meta SET value='20000' WHERE key='installation-count' RETURNING value"});
 assert.equal((await call("report",{token:issued,events:[event("update_seen")]})).status,429);assert.equal((await latest()).observedInstallations,1);
 const query=(await call("debug",null,{sql:"EXPLAIN QUERY PLAN SELECT a.data FROM json_each('[{\"appId\":\"application_first\",\"deploymentId\":\"ba0ded11-d92f-4d64-b8e0-a98bc5693fee\"}]') t JOIN flora_sdk_telemetry_aggregates a ON a.owner_id='owner_a' AND a.app_id=json_extract(t.value,'$.appId') AND a.deployment_id=json_extract(t.value,'$.deploymentId')"})).value.rows;
 assert.match(JSON.stringify(query),/SEARCH a USING INDEX/);assert.doesNotMatch(JSON.stringify(query),/SCAN a/);
 assert.equal((await call("latest",Array.from({length:401},()=>({appId:appA,deploymentId:deploymentA})))).status,400);
 assert.equal((await call("latest",[{appId:appA,deploymentId:deploymentA,installationId:install()}])).status,400);
});

test("anonymous SDK admission is bounded, hashed and keeps accepted records after caps",async t=>{
 const {call,latest}=await fixture(t);const original=session();let issued:any;
 for(let i=0;i<6;i++){issued=await call("session",original);assert.equal(issued.status,200);}
 assert.equal((await call("session",original)).status,429);
 const token=issued.value.token;
 for(let i=0;i<4;i++)assert.equal((await call("report",{token,events:Array.from({length:16},()=>event("update_seen"))})).status,200);
 assert.equal((await call("report",{token,events:[event("downloaded")]})).status,429);
 assert.equal((await latest()).observedInstallations,1);assert.equal((await latest()).downloadedInstallations,0);
 const buckets=await call("debug",null,{sql:"SELECT * FROM flora_sdk_telemetry_buckets"});assert.doesNotMatch(JSON.stringify(buckets.value),/198\.51\.100\.1/);
 const result=await call("session",session(),{ip:"203.0.113.10"});assert.equal(result.status,200);
 for(let i=0;i<59;i++)assert.equal((await call("session",session(),{ip:"203.0.113.10"})).status,200);
 assert.equal((await call("session",session(),{ip:"203.0.113.10"})).status,429);
 assert.equal((await call("latest",[{appId:appA,deploymentId:deploymentA}],{config:{ownerId:"other_owner"}})).value[JSON.stringify([appA,deploymentA])],undefined);
});

test("expired replay-cache hashes can be collected while installation, failure and adoption history remain intact",async t=>{
 const {call,latest}=await fixture(t),input=session();const ticket=(await call("session",input)).value.token;
 const report=[event("downloaded"),event("launch_confirmed"),event("failed",{stage:"launch",code:"UNCONFIRMED_LAUNCH"})];
 assert.equal((await call("report",{token:ticket,events:report})).status,200);const before=await latest();
 const boundary=now+7*86400000,boundaryTicket=(await call("session",input,{now:boundary})).value.token;
 const replay=await call("report",{token:boundaryTicket,events:report},{now:boundary});assert.equal(replay.status,200);assert.equal(replay.value.accepted,0);assert.equal(replay.value.duplicates,3);
 const later=now+8*86400000,renewed=await call("session",input,{now:later});assert.equal(renewed.status,200);
 const dedupe=(await call("debug",null,{sql:"SELECT count(*) AS total FROM flora_sdk_telemetry_events"})).value.rows;assert.equal(dedupe[0].total,0);
 assert.deepEqual(await latest(),before);
 assert.equal((await call("report",{token:renewed.value.token,events:report},{now:later})).status,400);
 assert.equal((await call("report",{token:renewed.value.token,events:[event("downloaded",{observedAt:later})]},{now:later})).status,200);
 assert.equal((await latest()).observedInstallations,1);assert.equal((await latest()).appliedInstallations,1);assert.equal((await latest()).failedInstallations,1);assert.equal((await latest()).failures[0].installations,1);
});

test("all 52 allowlisted failure dimensions retain unique installation counters and remain bounded",async t=>{
 const {call,latest}=await fixture(t);const token=(await call("session",session())).value.token;
 const codes=["NETWORK_UNAVAILABLE","TIMEOUT","SIGNATURE_INVALID","ASSET_HASH_MISMATCH","UPDATE_INCOMPATIBLE","UNCONFIRMED_LAUNCH","STORED_UPDATE_INVALID","NATIVE_OPERATION_FAILED","CHECK_FAILED","DOWNLOAD_FAILED","ACTIVATION_FAILED","LAUNCH_CONFIRMATION_FAILED","UNKNOWN"];
 const failures=["check","download","activation","launch"].flatMap(stage=>codes.map(code=>event("failed",{stage,code})));
 for(let offset=0;offset<failures.length;offset+=16)assert.equal((await call("report",{token,events:failures.slice(offset,offset+16)})).status,200);
 const summary=await latest();assert.equal(summary.failures.length,52);assert.equal(summary.failedInstallations,1);assert.equal(summary.observedInstallations,1);assert.equal(summary.applicationRate,0);
 assert.ok(summary.failures.every((f:any)=>f.installations===1));
 const other=(await call("session",session())).value.token;assert.equal((await call("report",{token:other,events:[event("failed",{stage:"download",code:"ASSET_HASH_MISMATCH"})]})).status,200);
 assert.equal((await latest()).failures.find((f:any)=>f.stage==="download"&&f.code==="ASSET_HASH_MISMATCH").installations,2);assert.equal((await latest()).failedInstallations,2);
});

test("reported failure followed by download, launch and restart counts one recovery across reordered batches and retries",async t=>{
 const {call,latest}=await fixture(t);const token=(await call("session",session())).value.token;
 const failure=event("failed",{stage:"download",code:"NETWORK_UNAVAILABLE",observedAt:now+1});
 const download=event("downloaded",{observedAt:now+2}),launch=event("launch_confirmed",{observedAt:now+3}),restart=event("restart_confirmed",{observedAt:now+4});
 const reads=(await call("debug")).value.reads;
 assert.equal((await call("report",{token,events:[failure]})).status,200);assert.equal((await latest()).recoveredInstallations,0);
 assert.equal((await call("report",{token,events:[restart,download]})).status,200);assert.equal((await latest()).recoveredInstallations,0);
 assert.equal((await call("report",{token,events:[launch]})).status,200);assert.equal((await latest()).recoveredInstallations,1);
 const ready=await latest();assert.equal(ready.observedInstallations,1);assert.equal(ready.failedInstallations,1);assert.equal(ready.appliedInstallations,1);assert.equal(ready.restartedInstallations,1);
 await call("restart");assert.equal((await call("report",{token,events:[failure,download,launch,restart]})).value.duplicates,4);assert.deepEqual(await latest(),ready);
 assert.equal((await call("debug")).value.reads,reads);
 const reordered=(await call("session",session())).value.token;
 assert.equal((await call("report",{token:reordered,events:[event("restart_confirmed",{observedAt:now+30}),event("launch_confirmed",{observedAt:now+20})]})).status,200);
 assert.equal((await latest()).recoveredInstallations,1);
 assert.equal((await call("report",{token:reordered,events:[event("rolled_back",{stage:"launch",code:"UNCONFIRMED_LAUNCH",observedAt:now+10})]})).status,200);
 assert.equal((await latest()).recoveredInstallations,2);assert.equal((await latest()).observedInstallations,2);
 const other=(await call("session",session(install(),deploymentB,"ios"),{appId:appB})).value.token;
 assert.equal((await call("report",{token:other,events:[event("failed",{stage:"download",code:"NETWORK_UNAVAILABLE"})]},{appId:appB})).status,200);
 assert.equal((await latest(appB,deploymentB)).recoveredInstallations,0);assert.equal((await latest()).recoveredInstallations,2);
});

test("a failure after successful launch/restart and equal timestamps cannot fabricate recovery",async t=>{
 const {call,latest}=await fixture(t);const token=(await call("session",session())).value.token;
 const post=(events:unknown[])=>call("report",{token,events});
 await post([event("launch_confirmed",{observedAt:now+10}),event("restart_confirmed",{observedAt:now+20}),event("failed",{stage:"download",code:"TIMEOUT",observedAt:now+30})]);
 assert.equal((await latest()).recoveredInstallations,0);
 await post([event("launch_confirmed",{observedAt:now+30}),event("restart_confirmed",{observedAt:now+30})]);assert.equal((await latest()).recoveredInstallations,0);
 await post([event("restart_confirmed",{observedAt:now+31})]);assert.equal((await latest()).recoveredInstallations,0);
 await post([event("launch_confirmed",{observedAt:now+32})]);assert.equal((await latest()).recoveredInstallations,1);
 await post([event("failed",{stage:"launch",code:"UNCONFIRMED_LAUNCH",observedAt:now+40})]);assert.equal((await latest()).recoveredInstallations,1); // Historical, not current health.
});

test("legacy recovery fields normalize to zero without inventing history, NaN or changing existing counters",async t=>{
 const {call,latest}=await fixture(t);const token=(await call("session",session())).value.token;
 await call("report",{token,events:[event("failed",{stage:"download",code:"NETWORK_UNAVAILABLE"}),event("launch_confirmed",{observedAt:now+1}),event("restart_confirmed",{observedAt:now+2})]});
 assert.equal((await latest()).recoveredInstallations,1);
 await call("debug",null,{sql:"UPDATE flora_sdk_telemetry_installations SET data=json_remove(data,'$.firstFailureAt','$.latestConfirmedAt','$.latestRestartAt','$.recovered') RETURNING installation_hash"});
 await call("debug",null,{sql:"UPDATE flora_sdk_telemetry_aggregates SET data=json_remove(data,'$.recoveredInstallations') RETURNING app_id"});
 await call("restart");const baseline=await latest();assert.equal(baseline.recoveredInstallations,0);
 await call("report",{token,events:[event("launch_confirmed",{observedAt:now+10}),event("restart_confirmed",{observedAt:now+11})]});
 const retained=await latest();assert.equal(retained.recoveredInstallations,0);assert.equal(retained.failedInstallations,1);assert.equal(retained.observedInstallations,1);assert.equal(retained.applicationRate,100);
 await call("report",{token,events:[event("failed",{stage:"download",code:"NETWORK_UNAVAILABLE",observedAt:now+20}),event("launch_confirmed",{observedAt:now+21}),event("restart_confirmed",{observedAt:now+22})]});
 const recovered=await latest();assert.equal(recovered.recoveredInstallations,1);assert.equal(recovered.observedInstallations,1);assert.equal(recovered.failedInstallations,1);assert.equal(recovered.failures[0].installations,1);
 for(const field of ["observedInstallations","downloadedInstallations","appliedInstallations","restartedInstallations","failedInstallations","rolledBackInstallations","recoveredInstallations"])assert.ok(Number.isSafeInteger(recovered[field]),field);
});


test("accepted SDK observations carry signed deployment scope and only new events without D1 report reads",async t=>{
 const {call}=await fixture(t);await call("observe");const installationId=install();
 const token=(await call("session",session(installationId))).value.token;
 const beforeReads=(await call("debug")).value.reads;
 const downloaded=event("downloaded"),failed=event("failed",{stage:"activation",code:"ACTIVATION_FAILED"});
 assert.equal((await call("report",{token,events:[downloaded,downloaded,failed]})).value.accepted,2);
 assert.equal((await call("report",{token,events:[failed,downloaded]})).value.accepted,0);
 const restarted=event("restart_confirmed");await call("report",{token,events:[failed,restarted]});
 const rows=(await call("debug",null,{sql:"SELECT * FROM observation_fixture ORDER BY rowid"})).value.rows;
 assert.equal(rows.length,2);const first=JSON.parse(rows[0].data);
 assert.deepEqual({...first,installationHash:"redacted"},{ownerId:"owner_a",appId:appA,deploymentId:deploymentA,platform:"android",channel:"verification",runtimeVersion:"native-v1",publishedAt:now-1000,isRollback:false,installationHash:"redacted",events:[{type:"downloaded",observedAt:now},{type:"failed",observedAt:now,stage:"activation",code:"ACTIVATION_FAILED"}]});
 assert.match(first.installationHash,/^[A-Za-z0-9_-]{43}$/);assert.equal(rows[0].received_at,now);
 assert.deepEqual(JSON.parse(rows[1].data).events,[{type:"restart_confirmed",observedAt:now}]);
 assert.doesNotMatch(JSON.stringify(rows),new RegExp(`${installationId}|${downloaded.id}|${failed.id}|${restarted.id}`));
 assert.equal((await call("debug")).value.reads,beforeReads);
});

test("rollback provenance is minted from D1 and legacy tickets report without triggering automatic observations",async t=>{
 const {runtime,call,latest}=await fixture(t);await call("observe");
 await runtime.d1.prepare("UPDATE ota_deployments SET data=? WHERE app_id=?").bind(JSON.stringify({rollback:{fromDeploymentId:deploymentA,targetDeploymentId:deploymentA,reason:"restore",requestedAt:now-2000}}),appB).run();
 const rollbackToken=(await call("session",session(install(),deploymentB,"ios"),{appId:appB})).value.token;
 await call("report",{token:rollbackToken,events:[event("rolled_back",{stage:"launch",code:"UNCONFIRMED_LAUNCH"})]},{appId:appB});
 const rows=(await call("debug",null,{sql:"SELECT * FROM observation_fixture"})).value.rows;
 assert.equal(rows.length,1);assert.equal(JSON.parse(rows[0].data).isRollback,true);assert.equal(JSON.parse(rows[0].data).appId,appB);
 const ordinary=(await call("session",session())).value.token;
 const payload=JSON.parse(Buffer.from(ordinary.split(".")[1],"base64url").toString());delete payload.isRollback;
 const secret=(await call("debug",null,{sql:"SELECT value FROM flora_sdk_telemetry_meta WHERE key='secret'"})).value.rows[0].value;
 const encoded=Buffer.from(JSON.stringify(payload)).toString("base64url");
 const legacy="v1."+encoded+"."+createHmac("sha256",Buffer.from(secret,"base64url")).update("v1."+encoded).digest("base64url");
 assert.equal((await call("report",{token:legacy,events:[event("downloaded")]})).status,200);
 assert.equal((await latest()).downloadedInstallations,1);
 assert.equal((await call("debug",null,{sql:"SELECT * FROM observation_fixture"})).value.rows.length,1);
});

test("observation failure rolls back telemetry, replay cache, and durable intent together for a valid retry",async t=>{
 const {call,latest}=await fixture(t);await call("observe");const token=(await call("session",session())).value.token;
 const failed=event("failed",{stage:"launch",code:"UNCONFIRMED_LAUNCH"}),report={token,events:[failed]};
 assert.equal((await call("report",report,{observationFailure:true})).status,503);
 assert.equal(await latest(),undefined);
 for(const table of ["observation_fixture","flora_sdk_telemetry_events","flora_sdk_telemetry_journal","flora_sdk_telemetry_installation_failures"]){
  assert.equal((await call("debug",null,{sql:`SELECT count(*) AS total FROM ${table}`})).value.rows[0].total,0);
 }
 const retry=await call("report",report);assert.equal(retry.status,200);assert.equal(retry.value.accepted,1);assert.equal(retry.value.duplicates,0);
 assert.equal((await latest()).failedInstallations,1);
 assert.equal((await call("debug",null,{sql:"SELECT count(*) AS total FROM observation_fixture"})).value.rows[0].total,1);
});
