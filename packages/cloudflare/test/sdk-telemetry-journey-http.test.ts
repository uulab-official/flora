import test from "node:test";
import assert from "node:assert/strict";
import {createHash,randomBytes,randomUUID} from "node:crypto";
import {createTestRuntime} from "./runtime.ts";

test("owner-only journey route admits only a sealed installation and cursor, measures two D1 reads, and fences revoked grants",async t=>{
 const origin="https://journey.example.test",owner="owner_journey",now=1_800_000_000_000,token=randomBytes(32),password=randomBytes(24).toString("base64url"),appId="application_journey",source=randomUUID();
 const runtime=await createTestRuntime({entrypoint:new URL("./fixtures/operations-history-entry.ts",import.meta.url),durableObjects:{FLORA_AUTH:"OperationsHistoryFixture"},bindings:{FLORA_ORIGIN:origin,FLORA_OWNER_ID:owner,FLORA_OWNER_EMAIL:"owner@example.test",FLORA_DB_IDENTITY:"db_journey",FLORA_SETUP:{digest:createHash("sha256").update(token).digest("hex"),issuedAt:now,expiresAt:now+600000,generation:1,purpose:"enroll"}}});t.after(()=>runtime.dispose());
 await runtime.d1.exec(`CREATE TABLE flora_deployment(singleton INTEGER PRIMARY KEY,owner_id TEXT,origin TEXT,db_identity TEXT);
 CREATE TABLE applications(owner_id TEXT,id TEXT,name TEXT,repository_id TEXT,root_directory TEXT,created_at INTEGER,PRIMARY KEY(owner_id,id));
 CREATE TABLE ota_deployments(owner_id TEXT,app_id TEXT,id TEXT,platform TEXT,channel TEXT,runtime_version TEXT,created_at INTEGER,data TEXT,PRIMARY KEY(owner_id,app_id,id));
 CREATE INDEX ota_latest ON ota_deployments(owner_id,app_id,channel,runtime_version,platform,created_at DESC,id DESC);`);
 await runtime.d1.prepare("INSERT INTO flora_deployment VALUES(1,?,?,?)").bind(owner,origin,"db_journey").run();await runtime.d1.prepare("INSERT INTO applications VALUES(?,?,?,?,?,?)").bind(owner,appId,"Journey","synthetic/journey",".",now-2000).run();await runtime.d1.prepare("INSERT INTO ota_deployments VALUES(?,?,?,?,?,?,?,?)").bind(owner,appId,source,"android","verification","native-v1",now-1000,"{}").run();
 const enrollment=await runtime.fetch(origin+"/api/auth/enroll",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({email:"owner@example.test",password,confirmation:password,token:token.toString("base64url")})});assert.equal(enrollment.status,200);const cookie=enrollment.headers.getSetCookie().map(value=>value.split(";",1)[0]).join("; ");
 const get=(path:string,authenticated=true)=>runtime.fetch(origin+path,{headers:authenticated?{Cookie:cookie}:{}}),stats=async()=>await(await get("/__test/history-stats")).json() as any,post=(path:string,input:unknown)=>runtime.fetch(origin+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)});
 const session=await post(`/updates/${appId}/telemetry/session`,{installationId:randomUUID(),deploymentId:source,platform:"android",channel:"verification",runtimeVersion:"native-v1",environment:"android-emulator"});assert.equal(session.status,200);const ticket=(await session.json() as any).token;
 assert.equal((await post(`/updates/${appId}/telemetry`,{token:ticket,events:[{id:randomUUID(),type:"failed",observedAt:now,stage:"launch",code:"UNCONFIRMED_LAUNCH"}]})).status,200);
 const base=`/api/apps/${appId}/ota/deployments/${source}/telemetry`,detail=await(await get(base)).json() as any,ref=detail.installations[0].id,path=base+"/installations/"+ref+"/journey";await stats();
 assert.equal((await get(path,false)).status,401);assert.equal((await stats()).queries.length,0);
 const response=await get(path);assert.equal(response.status,200,await response.clone().text());const page=await response.json() as any;assert.equal(page.entries.length,2);assert.equal(page.rootDeploymentId,source);assert.equal((await stats()).queries.length,2);
 for(const suffix of["?filter=issues","?cursor=a&cursor=b","?ownerId=foreign","?limit=100","?cursor=bad"]){assert.equal((await get(path+suffix)).status,400,suffix);assert.equal((await stats()).queries.length,0);}
 assert.equal((await runtime.fetch(origin+path,{method:"POST",headers:{Cookie:cookie,"Content-Type":"application/json"},body:"{}"})).status,405);assert.equal((await stats()).queries.length,0);
 assert.equal((await get(path.replace(appId,"application_foreign"))).status,404);assert.equal((await stats()).queries.length,0);
 const control=await runtime.fetch(origin+"/__test/control",{method:"POST",body:JSON.stringify({revokeBeforeD1Read:true})});assert.equal(control.status,200);assert.equal((await get(path)).status,401);assert.equal((await stats()).queries.length,1);assert.equal((await get(path)).status,401);assert.equal((await stats()).queries.length,0);
});
