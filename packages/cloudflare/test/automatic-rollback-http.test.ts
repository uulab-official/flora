import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createTestRuntime } from "./runtime.ts";

const origin="https://history.example.test",owner="owner_history",now=1_800_000_000_000;
const first="application_first",second="application_second";
const route=(app=first)=>`/api/apps/${app}/ota/rollback-policy`;
const policy=(targets:{ios:string|null;android:string|null}={ios:null,android:null})=>({expectedVersion:0,enabled:false,failureRatePercent:10,minInstallations:20,windowMinutes:30,channel:"verification",targets});
async function fixture(t:test.TestContext){
 const token=randomBytes(32),password=randomBytes(24).toString("base64url");
 const runtime=await createTestRuntime({entrypoint:new URL("./fixtures/automatic-rollback-http-entry.ts",import.meta.url),durableObjects:{FLORA_AUTH:"AutomaticRollbackHTTPFixture"},bindings:{FLORA_ORIGIN:origin,FLORA_OWNER_ID:owner,FLORA_OWNER_EMAIL:"owner@example.test",FLORA_DB_IDENTITY:"db_history",FLORA_SETUP:{digest:createHash("sha256").update(token).digest("hex"),issuedAt:now,expiresAt:now+600000,generation:1,purpose:"enroll"}}});
 t.after(()=>runtime.dispose());
 await runtime.d1.exec(`CREATE TABLE flora_deployment(singleton INTEGER,owner_id TEXT,origin TEXT,db_identity TEXT);
CREATE TABLE applications(owner_id TEXT,id TEXT,name TEXT,repository_id TEXT,root_directory TEXT,created_at INTEGER,PRIMARY KEY(owner_id,id));
CREATE TABLE application_settings(owner_id TEXT,app_id TEXT,version INTEGER,values_json TEXT,updated_at INTEGER);
CREATE TABLE ota_deployments(owner_id TEXT,app_id TEXT,id TEXT,platform TEXT,channel TEXT,runtime_version TEXT,created_at INTEGER,data TEXT,PRIMARY KEY(owner_id,app_id,id));
CREATE TABLE github_connections(owner_id TEXT,app_id TEXT,version INTEGER,data TEXT);
CREATE TABLE github_detections(owner_id TEXT,app_id TEXT,created_at INTEGER,data TEXT);
CREATE TABLE ota_assets(owner_id TEXT,app_id TEXT,hash TEXT,data TEXT);`);
 await runtime.d1.prepare("INSERT INTO flora_deployment VALUES(1,?,?,?)").bind(owner,origin,"db_history").run();
 const enrolled=await runtime.fetch(origin+"/api/auth/enroll",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({email:"owner@example.test",password,confirmation:password,token:token.toString("base64url")})});
 assert.equal(enrolled.status,200);
 const cookie=enrolled.headers.getSetCookie().map(value=>value.split(";",1)[0]).join("; "),csrf=(await enrolled.json() as any).csrfToken;
 const headers={Cookie:cookie,Origin:origin,"Content-Type":"application/json","X-Flora-CSRF":csrf};
 const call=(path:string,input?:unknown,extra:Record<string,string>={})=>runtime.fetch(origin+path,{method:input===undefined?"GET":"POST",headers:{...headers,...extra},...(input===undefined?{}:{body:JSON.stringify(input)})});
 const control=async(sql:string)=>{const response=await call("/__test/control",{sql});assert.equal(response.status,200);return response.json();};
 const stats=async()=>await(await call("/__test/history-stats")).json() as any;
 for(const app of[first,second]){
  await runtime.d1.prepare("INSERT INTO applications VALUES(?,?,?,?,?,?)").bind(owner,app,app,"synthetic/"+app,".",now-100).run();
  await runtime.d1.prepare("INSERT INTO application_settings VALUES(?,?,1,'{}',?)").bind(owner,app,now-100).run();
 }
 const deployments=[] as Array<{id:string;appId:string;platform:string;channel:string;runtimeVersion:string;createdAt:number;commitSha:string;preserved:string}>;
 const add=async(appId=first,platform="ios",channel="verification",healthy=true)=>{
  const record={id:randomUUID(),appId,platform,channel,runtimeVersion:"native-v1",createdAt:now-deployments.length-1,commitSha:"a".repeat(40),preserved:"existing-artifacts-and-history"};
  deployments.push(record);
  await runtime.d1.prepare("INSERT INTO ota_deployments VALUES(?,?,?,?,?,?,?,?)").bind(owner,appId,record.id,platform,channel,record.runtimeVersion,record.createdAt,JSON.stringify(record)).run();
  const counters={observedInstallations:1,downloadedInstallations:1,appliedInstallations:healthy?1:0,restartedInstallations:healthy?1:0,failedInstallations:0,rolledBackInstallations:0,recoveredInstallations:0,lastReportedAt:now,environments:{physicalDevice:0,androidEmulator:0,iosSimulator:1,unknown:0}};
  await control(`INSERT INTO flora_sdk_telemetry_aggregates VALUES('${owner}','${appId}','${record.id}','${JSON.stringify(counters)}')`);
  return record;
 };
 const state=async(app=first)=>{const response=await call(route(app));assert.equal(response.status,200,await response.clone().text());return response.json() as Promise<any>;};
 const rows=async()=>(await runtime.d1.prepare("SELECT * FROM ota_deployments ORDER BY app_id,id").all()).results;
 const authorize=async(deploymentId:string,token:string,installationId?:string)=>{
  assert.equal((await call(`/updates/${first}/telemetry`,{token,events:[{id:randomUUID(),type:"update_seen",observedAt:now+1000}]})).status,200);
  const detail=await call(`/api/apps/${first}/ota/deployments/${deploymentId}/telemetry`);assert.equal(detail.status,200);
  const installation=(await detail.json() as any).installations[0];assert.equal(installation.automaticRollbackEligible,false);
  const response=await call(`/api/apps/${first}/ota/rollback-installations`,{deploymentId,installationRef:installation.id,enabled:true});
  assert.equal(response.status,200,await response.clone().text());const result=await response.json() as any;assert.equal(result.enabled,true);assert.equal(result.eligibleInstallations,1);
  if(installationId){
   // Enrollment changes the policy fence. A subsequent publication and ticket
   // are required; older deployment reports can never trigger the new policy.
   await call("/__test/control",{now:now+2000});
   await runtime.d1.prepare("UPDATE ota_deployments SET created_at=?,data=json_set(data,'$.createdAt',?) WHERE id=?").bind(now+1100,now+1100,deploymentId).run();
   const renewed=await call(`/updates/${first}/telemetry/session`,{installationId,deploymentId,platform:"ios",channel:"verification",runtimeVersion:"native-v1",environment:"ios-simulator"});assert.equal(renewed.status,200);
   return (await renewed.json() as any).token as string;
  }
  return installation.id as string;
 };

 return{runtime,call,control,stats,headers,add,state,rows,authorize};
}

test("automatic rollback policy requires owner authority and strict bounded routes before reading deployment history",async t=>{
 const h=await fixture(t);await h.stats();
 assert.equal((await h.call(route(),undefined,{Cookie:""})).status,401);
 assert.equal((await h.call(route(),policy(),{"X-Flora-CSRF":""})).status,403);
 assert.equal((await h.call(route(),policy(),{Origin:"https://foreign.example.test"})).status,403);
 assert.equal((await h.call(route()+"?appId="+second)).status,400);
 assert.equal((await h.runtime.fetch(origin+route(),{method:"PUT",headers:h.headers,body:"{}"})).status,405);
 const oversize=await h.call("/__test/declared-size-probe",{path:route(),length:8193});
 assert.equal(oversize.status,200);const admission=await oversize.json() as any;
 assert.equal(admission.status,413);assert.equal(admission.reads,0);assert.equal(admission.authorityCalls,0);
 assert.equal((await h.stats()).queries.length,0);
 const initial=await h.state();assert.equal(initial.policy,null);assert.deepEqual(initial.decisions,[]);
 assert.equal((await h.call(route("application_missing"))).status,404);
 assert.equal((await h.state()).policy,null);
});

test("app-scoped automatic rollback settings preserve D1 history and reject stale policy writes across reload",async t=>{
 const h=await fixture(t),aIos=await h.add(),aAndroid=await h.add(first,"android"),bIos=await h.add(second),before=await h.rows();
 await h.stats();const initial=await h.state();assert.equal(initial.policy,null);
 const readQueries=(await h.stats()).queries;
 assert.ok(readQueries.length<=2,"policy GET adds only an indexed app guard and identity fence");
 assert.ok(readQueries.every((query:string)=>!query.includes("ota_deployments")),"policy GET never scans deployment history");
 const input={...policy({ios:aIos.id,android:aAndroid.id}),enabled:true};
 const saved=await h.call(route(),input);assert.equal(saved.status,200,await saved.clone().text());const firstState=await saved.json() as any;
 const {expectedVersion,...settings}=input;assert.deepEqual(firstState.policy,{...settings,appId:first,version:1,updatedAt:now});
 assert.equal((await h.state(second)).policy,null);
 const separate={...policy({ios:bIos.id,android:null}),enabled:true,failureRatePercent:25};
 assert.equal((await h.call(route(second),separate)).status,200);
 assert.equal((await h.call(route(),{...input,failureRatePercent:99})).status,409);
 assert.deepEqual(await h.state(),firstState);
 await h.call("/__test/control",{restart:true});assert.deepEqual(await h.state(),firstState);
 assert.equal((await h.state(second)).policy.failureRatePercent,25);
 assert.deepEqual(await h.rows(),before);
 const disabled=await h.call(route(),{...input,expectedVersion:1,enabled:false});assert.equal(disabled.status,200);
 assert.equal((await h.state()).policy.enabled,false);assert.equal((await h.state()).policy.version,2);
 assert.deepEqual(await h.rows(),before);
});

test("unhealthy foreign platform and channel restore targets cannot replace an existing policy",async t=>{
 const h=await fixture(t),healthy=await h.add(),foreign=await h.add(second),wrongPlatform=await h.add(first,"android"),wrongChannel=await h.add(first,"ios","production"),unconfirmed=await h.add(first,"ios","verification",false);
 const input={...policy({ios:healthy.id,android:null}),enabled:true};
 assert.equal((await h.call(route(),input)).status,200);const prior=await h.state(),before=await h.rows();
 for(const target of[foreign.id,wrongPlatform.id,wrongChannel.id,unconfirmed.id,randomUUID()]){
  const rejected=await h.call(route(),{...input,expectedVersion:1,targets:{ios:target,android:null}});
  assert.equal(rejected.status,409,"unsafe target must be rejected: "+await rejected.text());
  assert.deepEqual(await h.state(),prior);
 }
 // A recovered historical failure does not establish a failure-free pinned target.
 await h.control(`UPDATE flora_sdk_telemetry_aggregates SET data=json_set(data,'$.failedInstallations',1,'$.recoveredInstallations',1) WHERE app_id='${first}' AND deployment_id='${healthy.id}'`);
 const failed=await h.call(route(),{...input,expectedVersion:1});assert.equal(failed.status,409);
 assert.deepEqual(await h.state(),prior);
 await h.control(`UPDATE flora_sdk_telemetry_aggregates SET data=json_set(data,'$.failedInstallations',0,'$.rolledBackInstallations',1) WHERE app_id='${first}' AND deployment_id='${healthy.id}'`);
 assert.equal((await h.call(route(),{...input,expectedVersion:1})).status,409);
 assert.deepEqual(await h.state(),prior);assert.deepEqual(await h.rows(),before);
 const disabled=await h.call(route(),{...input,expectedVersion:1,enabled:false});assert.equal(disabled.status,200,"operators can always disable a policy after its target becomes unhealthy");
 assert.equal((await h.state()).policy.enabled,false);
});


test("SDK-triggered durable rollback scheduling coalesces duplicates and resumes after authority reconstruction without idle D1 polling",async t=>{
 const h=await fixture(t),target=await h.add(),source=await h.add(),before=await h.rows();
 const input={...policy({ios:target.id,android:null}),enabled:true,minInstallations:1,failureRatePercent:100};
 assert.equal((await h.call(route(),input)).status,200);
 await h.call("/__test/control",{now:now+1000});
 // Only deployments published after the approved policy can generate a decision.
 await h.runtime.d1.prepare("UPDATE ota_deployments SET created_at=?,data=json_set(data,'$.createdAt',?) WHERE id=?").bind(now+100,now+100,source.id).run();
 await h.call("/__test/auto-alarm",{reset:true});await h.stats();
 const empty=await h.call("/__test/auto-alarm",{run:true});assert.equal(empty.status,200);assert.equal((await empty.json() as any).alarm,null);
 assert.equal((await h.stats()).queries.length,0,"empty alarms never look up D1");
 const installationId=randomUUID();
 const issued=await h.call(`/updates/${first}/telemetry/session`,{installationId,deploymentId:source.id,platform:"ios",channel:"verification",runtimeVersion:"native-v1",environment:"ios-simulator"});
 assert.equal(issued.status,200,await issued.clone().text());let token=(await issued.json() as any).token;
 token=await h.authorize(source.id,token,installationId);
 const activation={id:randomUUID(),type:"activation_requested",observedAt:now+2000};
 const event={id:randomUUID(),type:"rolled_back",observedAt:now+2000,stage:"launch",code:"UNCONFIRMED_LAUNCH"};
 await h.call("/__test/auto-alarm",{reset:true});await h.stats();
 const report=await h.call(`/updates/${first}/telemetry`,{token,events:[activation,event]});
 assert.equal(report.status,200,await report.clone().text());assert.equal((await report.json() as any).accepted,2);
 const queued=await h.call("/__test/auto-alarm",{}),schedule=await queued.json() as any;
 assert.equal(schedule.setAlarm,1);assert.equal(schedule.alarm,now+122000);
 assert.equal((await h.stats()).queries.length,0,"accepted reports queue their durable intent without D1 reads");
 const decisions=(await h.state()).decisions;assert.equal(decisions.length,1);assert.equal(decisions[0].sourceDeploymentId,source.id);
 await h.stats();
 const detail=await h.call(`/api/apps/${first}/ota/deployments/${source.id}/telemetry`);assert.equal(detail.status,200);
 const detailState=await detail.json() as any;assert.equal(detailState.automaticRollback.id,decisions[0].id);
 assert.equal((await h.stats()).queries.length,2,"automatic decision detail adds no D1 reads to the two immutable scope guards");
 const history=await h.call(`/api/apps/${first}/operations`);assert.equal(history.status,200);
 const historyState=await history.json() as any;
 assert.equal(historyState.deployments.find((value:any)=>value.id===source.id).automaticRollback.id,decisions[0].id);
 assert.equal(historyState.deployments.find((value:any)=>value.id===target.id).automaticRollback,undefined);
 const coldHistoryQueries=(await h.stats()).queries as string[];
 assert.equal(coldHistoryQueries.length,11,"first operations history adds one bounded app-scoped rollback lineage backfill");
 const lineageReads=(queries:string[])=>queries.filter(query=>query.includes("AS rollback_lineage FROM ota_deployments d")&&query.includes("LIMIT 2001"));
 assert.equal(lineageReads(coldHistoryQueries).length,1,"cold operations history performs one batched lineage lookup, never a query per deployment");
 const repeatedHistory=await h.call(`/api/apps/${first}/operations`);assert.equal(repeatedHistory.status,200);
 const repeatedHistoryState=await repeatedHistory.json() as any;
 assert.equal(repeatedHistoryState.deployments.find((value:any)=>value.id===source.id).automaticRollback.id,decisions[0].id);
 const warmHistoryQueries=(await h.stats()).queries as string[];
 assert.equal(warmHistoryQueries.length,10,"unchanged operations watermark retains the existing bounded operations read count");
 assert.equal(lineageReads(warmHistoryQueries).length,0,"unchanged operations history never repeats the immutable lineage backfill");

 const retry=await h.call(`/updates/${first}/telemetry`,{token,events:[activation,event]});assert.equal(retry.status,200);assert.equal((await retry.json() as any).duplicates,2);
 assert.equal((await(await h.call("/__test/auto-alarm",{})).json() as any).setAlarm,1,"duplicate reports preserve the earlier alarm instead of adding work");
 assert.equal((await h.stats()).queries.length,0,"duplicate SDK reports and idle schedule inspection retain zero D1 reads");
 await h.call("/__test/control",{restart:true});
 assert.equal((await h.state()).decisions.length,1);assert.equal((await(await h.call("/__test/auto-alarm",{})).json() as any).setAlarm,1,"reconstruction retains an already scheduled durable alarm");
 // Simulate a lost alarm separately from SQL intent. Reconstruction must repair it.
 await h.call("/__test/auto-alarm",{clear:true});
 await h.call("/__test/control",{restart:true});await h.state();
 assert.equal((await(await h.call("/__test/auto-alarm",{})).json() as any).setAlarm,2);
 const after=await h.rows();assert.equal(after.length,before.length,"scheduling does not publish or overwrite history before alarm execution");
 for(const row of before as any[])if(row.id!==source.id)assert.deepEqual(after.find((value:any)=>value.id===row.id),row);
});

test("SDK retry repairs failed alarm persistence without duplicating the committed failure decision",async t=>{
 const h=await fixture(t),target=await h.add(),source=await h.add();
 assert.equal((await h.call(route(),{...policy({ios:target.id,android:null}),enabled:true,minInstallations:1,failureRatePercent:100})).status,200);
 await h.call("/__test/control",{now:now+1000});
 await h.runtime.d1.prepare("UPDATE ota_deployments SET created_at=?,data=json_set(data,'$.createdAt',?) WHERE id=?").bind(now+100,now+100,source.id).run();
 const installationId=randomUUID();
 const issued=await h.call(`/updates/${first}/telemetry/session`,{installationId,deploymentId:source.id,platform:"ios",channel:"verification",runtimeVersion:"native-v1",environment:"ios-simulator"});
 assert.equal(issued.status,200);let token=(await issued.json() as any).token;
 token=await h.authorize(source.id,token,installationId);
 const input={token,events:[{id:randomUUID(),type:"activation_requested",observedAt:now+2000},{id:randomUUID(),type:"rolled_back",observedAt:now+2000,stage:"launch",code:"UNCONFIRMED_LAUNCH"}]};
 await h.call("/__test/auto-alarm",{failNextSetAlarm:true});await h.stats();
 assert.equal((await h.call(`/updates/${first}/telemetry`,input)).status,503,"an ACK is withheld when a durable wake-up could not be saved");
 assert.equal((await(await h.call("/__test/auto-alarm",{})).json() as any).alarm,null);
 assert.equal((await h.stats()).queries.length,0);
 const pending=(await h.state()).decisions;assert.equal(pending.length,1);
 const retry=await h.call(`/updates/${first}/telemetry`,input);assert.equal(retry.status,200);const result=await retry.json() as any;
 assert.equal(result.accepted,0);assert.equal(result.duplicates,2);assert.deepEqual((await h.state()).decisions,pending);
 assert.ok((await(await h.call("/__test/auto-alarm",{})).json() as any).alarm!==null);
 await h.call("/__test/auto-alarm",{clear:true,failNextSetAlarm:true});
 await h.call("/__test/control",{restart:true});
 assert.equal((await h.state()).policy.enabled,true,"alarm persistence failure during reconstruction does not disable owner authentication");
 assert.equal((await(await h.call("/__test/auto-alarm",{})).json() as any).alarm,null);
 assert.equal((await h.call(`/updates/${first}/telemetry`,input)).status,200,"a subsequent duplicate SDK retry can repair the startup scheduling failure");
 assert.ok((await(await h.call("/__test/auto-alarm",{})).json() as any).alarm!==null);

});

test("an existing automatic rollback policy can be disabled while D1 is unavailable and another import holds the heavy slot",async t=>{
 const h=await fixture(t),target=await h.add();
 const input={...policy({ios:target.id,android:null}),enabled:true};
 assert.equal((await h.call(route(),input)).status,200);
 const held=await h.call("/__test/control",{holdImport:"{}"});assert.equal(held.status,200);assert.equal((await held.json() as any).held,true);
 await h.call("/__test/control",{failD1:true});await h.stats();
 const disabled=await h.call(route(),{...input,expectedVersion:1,enabled:false});assert.equal(disabled.status,200,await disabled.clone().text());
 assert.equal((await disabled.json() as any).policy.enabled,false);
 assert.equal((await h.stats()).queries.length,0,"emergency disable uses only the existing owner-scoped DO policy");
 await h.call("/__test/control",{releaseImport:true});await h.call("/__test/control",{failD1:false});
 assert.equal((await h.state()).policy.enabled,false);
});

test("installation eligibility requires an owner-approved sealed reference and cannot be supplied by public SDK clients",async t=>{
 const h=await fixture(t),source=await h.add(),path=`/api/apps/${first}/ota/rollback-installations`;
 const issued=await h.call(`/updates/${first}/telemetry/session`,{installationId:randomUUID(),deploymentId:source.id,platform:"ios",channel:"verification",runtimeVersion:"native-v1",environment:"ios-simulator"});assert.equal(issued.status,200);
 const token=(await issued.json() as any).token;
 assert.equal((await h.call(`/updates/${first}/telemetry`,{token,events:[{id:randomUUID(),type:"update_seen",observedAt:now}]})).status,200);
 const page=await h.call(`/api/apps/${first}/ota/deployments/${source.id}/telemetry`),row=(await page.json() as any).installations[0];
 const input={deploymentId:source.id,installationRef:row.id,enabled:true};await h.stats();
 assert.equal((await h.call(path,input,{Cookie:""})).status,401);
 assert.equal((await h.call(path,input,{"X-Flora-CSRF":""})).status,403);
 assert.equal((await h.call(path+"?ownerId=foreign",input)).status,400);
 assert.equal((await h.call(path)).status,405);
 assert.equal((await h.stats()).queries.length,0,"unauthorized mutations never resolve installation identity");
 assert.equal((await h.call(`/api/apps/${second}/ota/rollback-installations`,input)).status,404);
 assert.equal((await h.call(path,{...input,deploymentId:randomUUID()})).status,404);
 assert.equal((await h.call(path,{...input,installationHash:"attacker_supplied_hash"})).status,400);
 assert.equal((await h.call(path,{...input,enabled:"true"})).status,400);
 const approved=await h.call(path,input);assert.equal(approved.status,200);const result=await approved.json() as any;
 assert.deepEqual(result,{enabled:true,eligibleInstallations:1,policyVersion:null});assert.doesNotMatch(JSON.stringify(result),/installationHash|i1\./);
 const allowed=await h.call(`/api/apps/${first}/ota/deployments/${source.id}/telemetry`);assert.equal((await allowed.json() as any).installations[0].automaticRollbackEligible,true);
 const revoked=await h.call(path,{...input,enabled:false});assert.equal(revoked.status,200);assert.deepEqual(await revoked.json(),{enabled:false,eligibleInstallations:0,policyVersion:null});
 const denied=await h.call(`/api/apps/${first}/ota/deployments/${source.id}/telemetry`);assert.equal((await denied.json() as any).installations[0].automaticRollbackEligible,false);
});

test("twenty self-issued public SDK installations cannot trigger an owner automatic rollback without explicit installation enrollment",async t=>{
 const h=await fixture(t),target=await h.add(),source=await h.add();
 assert.equal((await h.call(route(),{...policy({ios:target.id,android:null}),enabled:true,minInstallations:1,failureRatePercent:100})).status,200);
 await h.call("/__test/control",{now:now+1000});
 await h.runtime.d1.prepare("UPDATE ota_deployments SET created_at=?,data=json_set(data,'$.createdAt',?) WHERE id=?").bind(now+100,now+100,source.id).run();
 const before=await h.rows();await h.call("/__test/auto-alarm",{reset:true});
 for(let index=0;index<20;index++){
  const issued=await h.call(`/updates/${first}/telemetry/session`,{installationId:randomUUID(),deploymentId:source.id,platform:"ios",channel:"verification",runtimeVersion:"native-v1",environment:"ios-simulator"});assert.equal(issued.status,200);
  const token=(await issued.json() as any).token;
  const response=await h.call(`/updates/${first}/telemetry`,{token,events:[{id:randomUUID(),type:"activation_requested",observedAt:now+1000},{id:randomUUID(),type:"rolled_back",observedAt:now+1000,stage:"launch",code:"UNCONFIRMED_LAUNCH"}]});assert.equal(response.status,200);
 }
 const state=await h.state();assert.deepEqual(state.decisions,[]);assert.equal(state.policy.enabled,true);
 const schedule=await(await h.call("/__test/auto-alarm",{})).json() as any;assert.equal(schedule.setAlarm,0);assert.equal(schedule.alarm,null);
 const detail=await h.call(`/api/apps/${first}/ota/deployments/${source.id}/telemetry`);assert.equal(detail.status,200);const displayed=await detail.json() as any;
 assert.equal(displayed.installations.length,20);assert.equal(displayed.summary.rolledBackInstallations,20);
 assert.ok(displayed.installations.every((value:any)=>value.automaticRollbackEligible===false));
 assert.deepEqual(await h.rows(),before,"SDK assertions remain preserved telemetry and cannot publish or overwrite deployments");
});


test("small-sample policy requires a full failure threshold while preserving an existing policy after invalid edits",async t=>{
 const h=await fixture(t),target=await h.add(),base={...policy({ios:target.id,android:null}),enabled:true};
 assert.equal((await h.call(route(),base)).status,200);const prior=await h.state();
 for(const minInstallations of[1,2,3,4]){
  assert.equal((await h.call(route(),{...base,expectedVersion:1,minInstallations,failureRatePercent:99})).status,400);
  assert.deepEqual(await h.state(),prior);
 }
 assert.equal((await h.call(route(),{...base,expectedVersion:1,minInstallations:1,failureRatePercent:100})).status,200);
 assert.equal((await h.state()).policy.minInstallations,1);
});

test("an enrolled small-sample installation requires paired native launch evidence and can recover outside its observation window before the delayed alarm",async t=>{
 const h=await fixture(t),target=await h.add(),source=await h.add();
 assert.equal((await h.call(route(),{...policy({ios:target.id,android:null}),enabled:true,minInstallations:1,failureRatePercent:100,windowMinutes:1})).status,200);
 await h.call("/__test/control",{now:now+1000});
 await h.runtime.d1.prepare("UPDATE ota_deployments SET created_at=?,data=json_set(data,'$.createdAt',?) WHERE id=?").bind(now+100,now+100,source.id).run();
 const installationId=randomUUID();
 const issued=await h.call(`/updates/${first}/telemetry/session`,{installationId,deploymentId:source.id,platform:"ios",channel:"verification",runtimeVersion:"native-v1",environment:"ios-simulator"});assert.equal(issued.status,200);
 const token=await h.authorize(source.id,(await issued.json() as any).token,installationId);
 const report=async(events:unknown[])=>{const response=await h.call(`/updates/${first}/telemetry`,{token,events});assert.equal(response.status,200,await response.clone().text());return response.json() as Promise<any>;};
 const failure={id:randomUUID(),type:"rolled_back",observedAt:now+2000,stage:"launch",code:"UNCONFIRMED_LAUNCH"};
 const generic={id:randomUUID(),type:"failed",observedAt:now+2000,stage:"activation",code:"ACTIVATION_FAILED"};
 const network={id:randomUUID(),type:"failed",observedAt:now+2000,stage:"launch",code:"NETWORK_UNAVAILABLE"};
 const timeout={id:randomUUID(),type:"failed",observedAt:now+2000,stage:"activation",code:"TIMEOUT"};
 await h.stats();await report([generic,network,timeout]);assert.equal((await h.stats()).queries.length,0);
 assert.deepEqual((await h.state()).decisions,[],"generic activation and network failures cannot invoke small-sample rollback");
 await report([failure]);assert.deepEqual((await h.state()).decisions,[],"a self-reported native failure without activation evidence is insufficient");
 // Arrival order may differ from observed order. Evidence must still refer to
 // this same installation and an activation at or before the native failure.
 const activation={id:randomUUID(),type:"activation_requested",observedAt:now+1900};
 await h.stats();assert.equal((await report([activation,failure])).accepted,1);assert.equal((await h.stats()).queries.length,0);
 const queued=(await h.state()).decisions;assert.equal(queued.length,1);
 assert.equal(queued[0].attemptedInstallations,1);assert.equal(queued[0].failedInstallations,1);assert.equal(queued[0].failureRatePercent,100);
 assert.equal(queued[0].nextAttemptAt,now+122000);
 for(let index=0;index<3;index++)await report([{...failure,id:randomUUID()}]);
 assert.deepEqual((await h.state()).decisions,queued,"new event IDs from one installation cannot inflate the decision snapshot");
 await h.stats();await h.call("/__test/auto-alarm",{run:true});assert.equal((await h.stats()).queries.length,0,"an alarm before the grace deadline never reads D1");
 assert.equal((await h.state()).decisions[0].status,"queued");
 // The publication window ends at +61,100ms; recovery arrives after that window
 // but before the server's +122,000ms grace deadline.
 await h.call("/__test/control",{now:now+62000});
 await h.stats();await report([{id:randomUUID(),type:"restart_confirmed",observedAt:now+62001},{id:randomUUID(),type:"launch_confirmed",observedAt:now+62000}]);
 assert.equal((await h.stats()).queries.length,0);
 await h.call("/__test/control",{now:now+122000});await h.stats();
 const alarm=await h.call("/__test/auto-alarm",{run:true});assert.equal(alarm.status,200,await alarm.clone().text());
 assert.equal((await h.stats()).queries.length,0,"a recovered delayed decision is skipped before D1 mutation or receipt lookup");
 const recovered=(await h.state()).decisions[0];assert.equal(recovered.status,"skipped");assert.equal(recovered.lastErrorCode,"AUTO_ROLLBACK_RECOVERED");
 assert.equal(recovered.rollbackDeploymentId,null);assert.equal(recovered.failedInstallations,1,"the original failure snapshot remains preserved in history");
});


test("small-sample minimum installations remain separate for iOS and Android despite enrollment in the same app",async t=>{
 const h=await fixture(t),seeds=[await h.add(),await h.add(first,"android"),await h.add()],sourceIos=await h.add(),sourceAndroid=await h.add(first,"android");
 const identities=[] as Array<{installationId:string;platform:string;environment:string}>;
 // Synthetic local protocol fixture: enroll three separate known installation
 // identities before enabling a new policy and publishing its candidates.
 for(const seed of seeds){
  const identity={installationId:randomUUID(),platform:seed.platform,environment:seed.platform==="ios"?"ios-simulator":"android-emulator"};identities.push(identity);
  const issued=await h.call(`/updates/${first}/telemetry/session`,{...identity,deploymentId:seed.id,channel:"verification",runtimeVersion:"native-v1"});assert.equal(issued.status,200);
  assert.equal((await h.call(`/updates/${first}/telemetry`,{token:(await issued.json() as any).token,events:[{id:randomUUID(),type:"update_seen",observedAt:now}]})).status,200);
  const page=await h.call(`/api/apps/${first}/ota/deployments/${seed.id}/telemetry`),installationRef=(await page.json() as any).installations[0].id;
  assert.equal((await h.call(`/api/apps/${first}/ota/rollback-installations`,{deploymentId:seed.id,installationRef,enabled:true})).status,200);
 }
 assert.equal((await h.call(route(),{...policy({ios:seeds[0]!.id,android:seeds[1]!.id}),enabled:true,minInstallations:2,failureRatePercent:100})).status,200);
 for(const source of[sourceIos,sourceAndroid])await h.runtime.d1.prepare("UPDATE ota_deployments SET created_at=?,data=json_set(data,'$.createdAt',?) WHERE id=?").bind(now+100,now+100,source.id).run();
 await h.call("/__test/control",{now:now+1000});
 const fail=async(identity:(typeof identities)[number],deploymentId:string)=>{
  const issued=await h.call(`/updates/${first}/telemetry/session`,{...identity,deploymentId,channel:"verification",runtimeVersion:"native-v1"});assert.equal(issued.status,200);
  const token=(await issued.json() as any).token;await h.stats();
  const response=await h.call(`/updates/${first}/telemetry`,{token,events:[{id:randomUUID(),type:"activation_requested",observedAt:now+1000},{id:randomUUID(),type:"rolled_back",observedAt:now+1000,stage:"launch",code:"UNCONFIRMED_LAUNCH"}]});assert.equal(response.status,200);
  assert.equal((await h.stats()).queries.length,0);
 };
 await fail(identities[0]!,sourceIos.id);await fail(identities[1]!,sourceAndroid.id);
 assert.deepEqual((await h.state()).decisions,[],"one failure per platform does not satisfy either two-installation minimum");
 await fail(identities[2]!,sourceIos.id);
 const decisions=(await h.state()).decisions;assert.equal(decisions.length,1);assert.equal(decisions[0].platform,"ios");assert.equal(decisions[0].sourceDeploymentId,sourceIos.id);
 assert.equal(decisions[0].attemptedInstallations,2);assert.equal(decisions[0].failedInstallations,2);assert.equal(decisions[0].nextAttemptAt,now+121000);
});

test("activation evidence alone never makes generic or network failures sufficient for a small-sample rollback",async t=>{
 const h=await fixture(t),target=await h.add(),source=await h.add();
 assert.equal((await h.call(route(),{...policy({ios:target.id,android:null}),enabled:true,minInstallations:1,failureRatePercent:100})).status,200);
 await h.call("/__test/control",{now:now+1000});
 await h.runtime.d1.prepare("UPDATE ota_deployments SET created_at=?,data=json_set(data,'$.createdAt',?) WHERE id=?").bind(now+100,now+100,source.id).run();
 const installationId=randomUUID();
 const issued=await h.call(`/updates/${first}/telemetry/session`,{installationId,deploymentId:source.id,platform:"ios",channel:"verification",runtimeVersion:"native-v1",environment:"ios-simulator"});assert.equal(issued.status,200);
 const token=await h.authorize(source.id,(await issued.json() as any).token,installationId);await h.stats();
 const response=await h.call(`/updates/${first}/telemetry`,{token,events:[
  {id:randomUUID(),type:"activation_requested",observedAt:now+1900},
  {id:randomUUID(),type:"failed",observedAt:now+2000,stage:"activation",code:"ACTIVATION_FAILED"},
  {id:randomUUID(),type:"failed",observedAt:now+2000,stage:"launch",code:"NETWORK_UNAVAILABLE"},
  {id:randomUUID(),type:"failed",observedAt:now+2000,stage:"activation",code:"TIMEOUT"},
 ]});assert.equal(response.status,200);assert.equal((await h.stats()).queries.length,0);
 assert.deepEqual((await h.state()).decisions,[]);
 assert.equal((await(await h.call("/__test/auto-alarm",{})).json() as any).alarm,null);
});
