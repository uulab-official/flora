import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createTestRuntime } from "./runtime.ts";

test("authenticated deployment device drilldown preserves six app/platform scopes and uses exactly two indexed D1 reads per manual page",async t=>{
 const origin="https://detail.example.test",owner="owner_detail",now=1_800_000_000_000,token=randomBytes(32),password=randomBytes(24).toString("base64url");
 const runtime=await createTestRuntime({entrypoint:new URL("./fixtures/operations-history-entry.ts",import.meta.url),durableObjects:{FLORA_AUTH:"OperationsHistoryFixture"},bindings:{FLORA_ORIGIN:origin,FLORA_OWNER_ID:owner,FLORA_OWNER_EMAIL:"owner@example.test",FLORA_DB_IDENTITY:"db_detail",FLORA_SETUP:{digest:createHash("sha256").update(token).digest("hex"),issuedAt:now,expiresAt:now+600000,generation:1,purpose:"enroll"}}});t.after(()=>runtime.dispose());
 await runtime.d1.exec(`CREATE TABLE flora_deployment(singleton INTEGER PRIMARY KEY,owner_id TEXT,origin TEXT,db_identity TEXT);
 CREATE TABLE applications(owner_id TEXT,id TEXT,name TEXT,repository_id TEXT,root_directory TEXT,created_at INTEGER,PRIMARY KEY(owner_id,id));
 CREATE TABLE ota_deployments(owner_id TEXT,app_id TEXT,id TEXT,platform TEXT,channel TEXT,runtime_version TEXT,created_at INTEGER,data TEXT,PRIMARY KEY(owner_id,app_id,id));`);
 await runtime.d1.prepare("INSERT INTO flora_deployment VALUES(1,?,?,?)").bind(owner,origin,"db_detail").run();
 const enrollment=await runtime.fetch(origin+"/api/auth/enroll",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({email:"owner@example.test",password,confirmation:password,token:token.toString("base64url")})});assert.equal(enrollment.status,200);
 const cookie=enrollment.headers.getSetCookie().map(value=>value.split(";",1)[0]).join("; ");
 const get=(path:string,auth=true)=>runtime.fetch(origin+path,{headers:auth?{Cookie:cookie}:{}});
 const stats=async()=>await(await get("/__test/history-stats")).json() as any;
 const control=async(input:unknown)=>{const response=await runtime.fetch(origin+"/__test/control",{method:"POST",body:JSON.stringify(input)});assert.equal(response.status,200);return response.json();};
 const post=(path:string,input:unknown)=>runtime.fetch(origin+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)});
 const rollbackProof={fromDeploymentId:randomUUID(),targetDeploymentId:randomUUID(),reason:"Restore verified release",requestedAt:now-11};
 const targets:Array<{appId:string;deploymentId:string;platform:string}>=[];
 for(const name of ["isso","promise","reward"]){const appId="application_"+name;await runtime.d1.prepare("INSERT INTO applications VALUES(?,?,?,?,?,?)").bind(owner,appId,name,"synthetic/"+name,".",now-20).run();for(const platform of["ios","android"]){const deploymentId=randomUUID();targets.push({appId,deploymentId,platform});await runtime.d1.prepare("INSERT INTO ota_deployments VALUES(?,?,?,?,?,?,?,?)").bind(owner,appId,deploymentId,platform,"verification","native-v1",now-10,JSON.stringify({id:deploymentId,appId,platform,commitSha:"a".repeat(40),preserved:"immutable-history",...(name==="isso"&&platform==="ios"?{rollback:rollbackProof}:{})})).run();}}
 const baseline=(await runtime.d1.prepare("SELECT * FROM ota_deployments ORDER BY app_id,id").all()).results,installationId=randomUUID(),allRefs:string[]=[],labels:string[]=[];
 const detailPath=(target:typeof targets[number])=>`/api/apps/${target.appId}/ota/deployments/${target.deploymentId}/telemetry`;
 await stats();assert.equal((await get(detailPath(targets[0]!),false)).status,401);assert.deepEqual((await stats()).queries,[]);
 for(const target of targets){
  const session=await post(`/updates/${target.appId}/telemetry/session`,{installationId,deploymentId:target.deploymentId,platform:target.platform,channel:"verification",runtimeVersion:"native-v1",environment:target.platform==="ios"?"ios-simulator":"android-emulator"});assert.equal(session.status,200);const ticket=(await session.json() as any).token;
  const events=[{id:randomUUID(),type:"failed",observedAt:now,stage:"download",code:"NETWORK_UNAVAILABLE"},{id:randomUUID(),type:"downloaded",observedAt:now+1},{id:randomUUID(),type:"launch_confirmed",observedAt:now+2},{id:randomUUID(),type:"restart_confirmed",observedAt:now+3}];
  assert.equal((await post(`/updates/${target.appId}/telemetry`,{token:ticket,events:events.slice(0,1)})).status,200);await stats();
  const initialIssue=await(await get(detailPath(target)+'?filter=unresolved')).json() as any;
  assert.equal(initialIssue.installations.length,1);assert.equal(initialIssue.installations[0].issueStatus,'unresolved');
  assert.deepEqual(initialIssue.summary.issueResolution,{unresolvedInstallations:1,resolvedInstallations:0,unknownInstallations:0});assert.equal((await stats()).queries.length,2);
  assert.equal((await post(`/updates/${target.appId}/telemetry`,{token:ticket,events})).status,200);await stats();
  const response=await get(detailPath(target));assert.equal(response.status,200,await response.clone().text());const page=await response.json() as any,measured=await stats();
  assert.equal(measured.queries.length,2);assert.match(measured.queries[0],/flora_deployment WHERE singleton=1/);assert.match(measured.queries[1],/d\.owner_id=\? AND d\.app_id=\? AND d\.id=\?/);
  assert.deepEqual(page.deployment.rollback,target.appId==="application_isso"&&target.platform==="ios"?rollbackProof:undefined);
  assert.equal(page.installations.length,1);assert.equal(page.deployment.platform,target.platform);assert.equal(page.summary.applicationRate,100);assert.equal(page.summary.failedInstallations,1);assert.equal(page.summary.recoveredInstallations,1);
  const issuesResponse=await get(detailPath(target)+"?filter=issues");assert.equal(issuesResponse.status,200);const issues=await issuesResponse.json() as any;assert.equal(issues.filter,"issues");assert.equal(issues.installations.length,1);assert.equal(issues.installations[0].recovered,true);assert.equal((await stats()).queries.length,2);
  for(const filter of ['unresolved','resolved']){const filtered=await get(detailPath(target)+'?filter='+filter);assert.equal(filtered.status,200);const body=await filtered.json() as any;assert.equal(body.filter,filter);assert.equal(body.installations.length,filter==='resolved'?1:0);if(filter==='resolved')assert.equal(body.installations[0].issueStatus,'resolved');assert.equal((await stats()).queries.length,2);}
  const installation=page.installations[0];assert.equal(installation.recovered,true);assert.equal(installation.history.complete,true);assert.equal(installation.history.recordedEvents,4);allRefs.push(installation.id);labels.push(installation.label);
  const timeline=await get(detailPath(target)+"/installations/"+installation.id);assert.equal(timeline.status,200);const timelinePage=await timeline.json() as any;assert.equal(timelinePage.events.length,4);assert.equal(timelinePage.installation.id,installation.id);assert.equal((await stats()).queries.length,2);
  const relapse={id:randomUUID(),type:'failed',observedAt:now+4,stage:'launch',code:'LAUNCH_CONFIRMATION_FAILED'};
  assert.equal((await post(`/updates/${target.appId}/telemetry`,{token:ticket,events:[relapse]})).status,200);await stats();
  const reopened=await(await get(detailPath(target)+'?filter=unresolved')).json() as any;
  assert.equal(reopened.installations.length,1);assert.equal(reopened.installations[0].recovered,true,'cumulative recovery must not hide a relapse');
  assert.equal(reopened.installations[0].issueStatus,'unresolved');assert.equal((await stats()).queries.length,2);
  assert.equal((await post(`/updates/${target.appId}/telemetry`,{token:ticket,events:[{id:randomUUID(),type:'launch_confirmed',observedAt:now+5},{id:randomUUID(),type:'restart_confirmed',observedAt:now+6}]})).status,200);await stats();
  const restored=await(await get(detailPath(target)+'?filter=resolved')).json() as any;
  assert.equal(restored.installations.length,1);assert.equal(restored.summary.issueResolution.resolvedInstallations,1);assert.equal((await stats()).queries.length,2);
  for(const filter of ['issues','unresolved','resolved']){assert.equal((await get(detailPath(target)+"/installations/"+installation.id+"?filter="+filter)).status,400);assert.equal((await stats()).queries.length,0);}
  assert.doesNotMatch(JSON.stringify([page,timelinePage]),new RegExp(`${installationId}|${ticket}|immutable-history|198\\.51|installation_hash|event_hash`));
 }
 assert.equal(new Set(labels).size,6);assert.equal(new Set(allRefs).size,6);
 // Refs cannot be reused for either another app or another deployment.
 for(const target of targets.slice(1)){const response=await get(detailPath(target)+"/installations/"+allRefs[0]);assert.equal(response.status,404);assert.equal((await stats()).queries.length,0);}
 for(const suffix of["?cursor=bad","?cursor=a&cursor=b","?ownerId=foreign","?limit=999","?filter=all","?filter=unknown","?filter=issues&filter=issues","?filter=resolved&filter=unresolved","?filter=Resolved","?filter=resolved&cursor=a&cursor=b"]){assert.equal((await get(detailPath(targets[0]!)+suffix)).status,400);assert.equal((await stats()).queries.length,0);}
 assert.equal((await runtime.fetch(origin+detailPath(targets[0]!),{method:"POST",headers:{Cookie:cookie,"Content-Type":"application/json"},body:"{}"})).status,405);
 assert.equal((await get(`/api/apps/application_missing/ota/deployments/${targets[0]!.deploymentId}/telemetry`)).status,404);assert.equal((await stats()).queries.length,2);
 await control({sql:"UPDATE flora_sdk_telemetry_installations SET data=json_remove(data,'$.detailHistory','$.firstFailureAt','$.latestConfirmedAt','$.latestRestartAt') WHERE app_id='application_isso' RETURNING app_id"});
 const legacy=await(await get(detailPath(targets[0]!))).json() as any;assert.equal(legacy.installations[0].history.reason,"legacy");assert.equal(legacy.installations[0].firstFailureAt,null);assert.equal(legacy.installations[0].downloaded,true);await stats();
 assert.deepEqual((await runtime.d1.prepare("SELECT * FROM ota_deployments ORDER BY app_id,id").all()).results,baseline);
 await control({revokeBeforeD1Read:true});assert.equal((await get(detailPath(targets[0]!))).status,401);assert.equal((await stats()).queries.length,1);
 assert.equal((await get(detailPath(targets[0]!))).status,401);assert.equal((await stats()).queries.length,0);
});
