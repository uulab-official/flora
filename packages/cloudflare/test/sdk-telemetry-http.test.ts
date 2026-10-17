import test from "node:test";
import assert from "node:assert/strict";
import {createHash,randomBytes,randomUUID} from "node:crypto";
import {createTestRuntime} from "./runtime.ts";
import {createFloraClient,createFloraTelemetry} from "@flora/ota";
import {createFloraNativeEngine} from "@flora/ota/native-adapter";
import type {FloraConfiguration} from "@flora/ota";

test("actual SDK lifecycle reports pass the public Worker protocol and preserve three app scopes",async t=>{
 const origin="https://sdk-http.example.test",now=1800000000000,token=randomBytes(32),password=randomBytes(24).toString("base64url");
 const runtime=await createTestRuntime({entrypoint:new URL("./fixtures/hosted-entry.ts",import.meta.url),durableObjects:{FLORA_AUTH:"HostedFixtureAuth"},bindings:{FLORA_ORIGIN:origin,FLORA_OWNER_ID:"owner_sdk",FLORA_OWNER_EMAIL:"owner@example.test",FLORA_DB_IDENTITY:"db_sdk",FLORA_SETUP:{digest:createHash("sha256").update(token).digest("hex"),issuedAt:now,expiresAt:now+600000,generation:1,purpose:"enroll"}}});t.after(()=>runtime.dispose());
 await runtime.d1.exec(`CREATE TABLE flora_deployment(singleton INTEGER,owner_id TEXT,origin TEXT,db_identity TEXT);
CREATE TABLE applications(owner_id TEXT,id TEXT,name TEXT,repository_id TEXT,root_directory TEXT,created_at INTEGER,PRIMARY KEY(owner_id,id));
CREATE TABLE ota_deployments(owner_id TEXT,app_id TEXT,id TEXT,platform TEXT,channel TEXT,runtime_version TEXT,created_at INTEGER,data TEXT,PRIMARY KEY(owner_id,app_id,id));
CREATE TABLE github_connections(owner_id TEXT,app_id TEXT,version INTEGER,data TEXT);
CREATE TABLE automation_policies(owner_id TEXT,app_id TEXT,version INTEGER,data TEXT);
CREATE TABLE automation_runners(owner_id TEXT,id TEXT,version INTEGER,data TEXT);`);
 await runtime.d1.prepare("INSERT INTO flora_deployment VALUES(1,?,?,?)").bind("owner_sdk",origin,"db_sdk").run();
 const enrollment=await runtime.fetch(origin+"/api/auth/enroll",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({email:"owner@example.test",password,confirmation:password,token:token.toString("base64url")})});assert.equal(enrollment.status,200);
 const cookie=enrollment.headers.getSetCookie().map(v=>v.split(";",1)[0]).join("; ");
 const get=async()=>{const response=await runtime.fetch(origin+"/api/projects",{headers:{Cookie:cookie}});assert.equal(response.status,200);return await response.json() as any;};
 const summaries:Record<string,unknown>={};
 const cases=["isso","promise","reward"].map(name=>({name,appId:"application_"+name,deploymentId:randomUUID()}));
 for(const {name,appId,deploymentId} of cases){
  await runtime.d1.prepare("INSERT INTO applications VALUES(?,?,?,?,?,?)").bind("owner_sdk",appId,name,"synthetic/"+name,".",now-10).run();
  await runtime.d1.prepare("INSERT INTO ota_deployments VALUES(?,?,?,?,?,?,?,?)").bind("owner_sdk",appId,deploymentId,"android","verification","native-v1",now-1,JSON.stringify({commitSha:"a".repeat(40)})).run();
 }
 for(const {name,appId,deploymentId} of cases){
  const config:FloraConfiguration={appId,url:origin+"/updates/"+appId,platform:"android",channel:"verification",runtimeVersion:"native-v1"},update={...config,id:deploymentId};
  const stored=new Map<string,string>(),storage={getItem:async(k:string)=>stored.get(k)??null,setItem:async(k:string,v:string)=>{stored.set(k,v);}};
  const requests:Array<{url:string;status:number}>=[];
  const transport:typeof fetch=async(input,init)=>{const url=String(input),headers=new Headers(init?.headers);headers.set("CF-Connecting-IP","198.51.100.10");assert.equal(typeof init?.body,"string");const response=await runtime.fetch(url,{method:init?.method??"POST",body:init?.body as string,headers:Object.fromEntries(headers.entries())});requests.push({url,status:response.status});return response as unknown as Response;};
  const reporter=()=>createFloraTelemetry(config,{storage,createId:randomUUID,environment:"android-emulator",fetch:transport,now:()=>now});
  let launched=false;const bridge={getNativeConfiguration:async()=>({...config,enabled:true}),check:async()=>({available:true,update}),download:async()=>({downloaded:true,update}),reload:async()=>{},getLaunchInfo:async()=>({appId,runtimeVersion:config.runtimeVersion,source:launched?"update":"embedded",updateId:launched?deploymentId:null,assets:{}}),markLaunchSuccessful:async()=>{}};
  const first=reporter(),engine=createFloraNativeEngine(bridge,{telemetry:first}),client=createFloraClient(config,engine,{telemetry:first});
  await engine.getLaunchInfo();await client.checkForUpdate();await client.downloadUpdate();await client.reload();await first.flush();assert.ok(requests.every(r=>r.status===200),JSON.stringify(requests));
  const pending=(await get()).projects.find((p:any)=>p.id===appId).ota.android.telemetry;assert.equal(pending.downloadedInstallations,1);assert.equal(pending.appliedInstallations,0);assert.equal(pending.restartedInstallations,0);
  launched=true;const second=reporter(),freshEngine=createFloraNativeEngine(bridge,{telemetry:second});await freshEngine.getLaunchInfo();await freshEngine.markLaunchSuccessful(deploymentId);await second.flush();
  const result=(await get()).projects.find((p:any)=>p.id===appId).ota.android.telemetry;assert.equal(result.observedInstallations,1);assert.equal(result.applicationRate,100);assert.equal(result.appliedInstallations,1);assert.equal(result.restartedInstallations,1);
  await second.record(deploymentId,"failed",{stage:"download",code:"NETWORK_UNAVAILABLE"});await second.flush();const failed=(await get()).projects.find((p:any)=>p.id===appId).ota.android.telemetry;assert.equal(failed.failedInstallations,1);assert.equal(failed.failures[0].code,"NETWORK_UNAVAILABLE");summaries[appId]=failed;
  assert.ok(requests.every(r=>r.status===200),JSON.stringify(requests));
  const foreign=await runtime.fetch(origin+"/updates/application_foreign/telemetry",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:"invalid",events:[]})});assert.equal(foreign.status,401);
 }
 const final=await get();for(const project of final.projects)assert.deepEqual(project.ota.android.telemetry,summaries[project.id]);
 const blocked=await runtime.fetch(origin+"/updates/application_isso/telemetry",{method:"POST",headers:{Origin:"https://foreign.example","Content-Type":"application/json"},body:"{}"});assert.equal(blocked.status,403);
 for(const path of["/updates/application_isso/telemetry?appId=application_reward","/updates/application_isso/telemetry/session?ownerId=foreign"]){assert.equal((await runtime.fetch(origin+path,{method:"POST",body:"{}"})).status,400);}
});
