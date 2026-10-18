import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createHash,randomBytes,randomUUID} from "node:crypto";
import type {D1Database,D1PreparedStatement} from "@cloudflare/workers-types";
import {createD1ImportStore} from "../dist/d1-import-store.js";
import {createOperationsService} from "@app-ops/dogfood";
import type {OTADeployment} from "@app-ops/dogfood";
import {routeRequest,HttpFailure} from "../dist/http.js";
import {createTestRuntime} from "./runtime.ts";
const origin="https://flora.example.test",deploymentId="11111111-1111-4111-8111-111111111111";

test("publication_requires_session_app_and_exact_uuid",()=>{
 const path="/api/apps/app_test/ota/deployments/"+deploymentId+"/publication";
 assert.equal(routeRequest(new Request(origin+path)).kind,"hosted");
 for(const init of [{method:"POST"},{method:"HEAD"},{headers:{"Content-Length":"1"}}])assert.throws(()=>routeRequest(new Request(origin+path,init)),e=>e instanceof HttpFailure && [400,405].includes(e.status));
 assert.throws(()=>routeRequest(new Request(origin+path+"?cursor=all")),e=>e instanceof HttpFailure && e.status===400);
 for(const id of ["bad",deploymentId.toUpperCase(),deploymentId+"/extra"])if(id!==deploymentId)assert.throws(()=>routeRequest(new Request(origin+path.replace(deploymentId,id))));
});

test("publication_read_budget_is_constant_with_long_history_and_no_telemetry_writes",async t=>{
 const now=1800000000000,token=randomBytes(32),password=randomBytes(24).toString("base64url");
 const config={origin,ownerId:"synthetic-owner",ownerEmail:"owner@example.test",dbIdentity:"synthetic-db",setup:null};
 const runtime=await createTestRuntime({entrypoint:new URL("./fixtures/hosted-entry.ts",import.meta.url),durableObjects:{FLORA_AUTH:"HostedFixtureAuth"},bindings:{FLORA_ORIGIN:origin,FLORA_OWNER_ID:config.ownerId,FLORA_OWNER_EMAIL:config.ownerEmail,FLORA_DB_IDENTITY:config.dbIdentity,FLORA_SETUP:{digest:createHash("sha256").update(token).digest("hex"),issuedAt:now,expiresAt:now+600000,generation:1,purpose:"enroll"}}});t.after(()=>runtime.dispose());
 const db=runtime.d1 as unknown as D1Database;
 for(const name of ["0001_private_imports.sql","0002_multi_app.sql","0003_github_ota.sql","0004_automation.sql"]){
  const sql=await readFile(new URL("../migrations/"+name,import.meta.url),"utf8");
  await db.exec(sql.replace(/^--.*$/gm,"").split(/;\s*(?=CREATE|INSERT|PRAGMA|$)/).filter(s=>s.trim()).map(s=>s.replace(/\s*\n\s*/g," ").trim()+";").join("\n"));
 }
 await db.prepare("INSERT INTO flora_deployment VALUES(1,?,?,?)").bind(config.ownerId,origin,config.dbIdentity).run();
 const store=createD1ImportStore(db,config,()=>{}),apps=store.applications!,ops=store.operations!;
 const a=await apps.registerApplication({name:"A",repositoryId:"repo-a",rootDirectory:"."},now),b=await apps.registerApplication({name:"B",repositoryId:"repo-b",rootDirectory:"."},now);
 const connection=await ops.saveGitHubConnection(a.id,{expectedVersion:0,installationId:1,owner:"example",repository:"sample",ref:"main"},now);
 const detection=await ops.saveGitHubDetection({id:"detection_old",appId:a.id,connection,rootDirectory:".",detectedAt:now,commitSha:"a".repeat(40),framework:"expo",expoVersion:"57.0.0",reactNativeVersion:"0.86.3",configSource:"app.json",runtimeVersion:"1",platforms:["ios","android"],updatesEnabled:true,updatesUrl:origin+"/updates/"+a.id,reasons:[]});
 const bytes=new TextEncoder().encode("retained bundle"),hash=createHash("sha256").update(bytes);
 const digest=hash.digest("hex"),asset=await ops.saveOTAAsset({id:"asset_"+digest,appId:a.id,digest,hash:Buffer.from(digest,"hex").toString("base64url"),key:"bundle",contentType:"application/javascript",fileExtension:".js",size:bytes.length,createdAt:now},bytes);
 const original:OTADeployment={id:deploymentId,appId:a.id,requestKey:"old",detectionId:detection.id,commitSha:detection.commitSha,channel:"preview",runtimeVersion:"1",platform:"ios",launchAssetId:asset.id,assetIds:[],launchAsset:asset,assets:[],createdAt:now};await ops.saveOTADeployment(original);
 let queries=0,rowsRead=0,writes=0;
 function statement(stmt:D1PreparedStatement):D1PreparedStatement{return new Proxy(stmt,{get(target,key){
  if(key==="bind")return(...values:unknown[])=>statement(target.bind(...values));
  if(key==="first")return async(column?:string)=>{const result=await target.all<Record<string,unknown>>();queries++;rowsRead+=result.meta.rows_read;const row=result.results[0]??null;return column?row?.[column]??null:row;};
  if(key==="run"||key==="all")return async()=>{const result=await target.all();queries++;rowsRead+=result.meta.rows_read;writes+=result.meta.rows_written;return result;};
  const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
 }});}
 const measured=new Proxy(db,{get(target,key){if(key==="prepare")return(sql:string)=>statement(target.prepare(sql));const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}});
 const measuredStore=createD1ImportStore(measured,config,()=>{}),service=createOperationsService({applications:measuredStore.applications!,operations:measuredStore.operations!},undefined);
 const get=Reflect.get(service,"getPublication");assert.equal(typeof get,"function");
 const view=await get.call(service,a.id,deploymentId);const budget={queries,rowsRead};assert.ok(queries<=8);assert.equal(writes,0);
 for(let i=0;i<24;i++)await ops.saveOTADeployment({...original,id:randomUUID(),requestKey:"later_"+i,createdAt:now+i+1});
 assert.ok(!(await createOperationsService({applications:apps,operations:ops},undefined).getState(a.id)).deployments.some(d=>d.id===deploymentId));
 const before=(await db.prepare("SELECT data FROM ota_deployments ORDER BY id").all()).results;
 queries=0;rowsRead=0;writes=0;assert.deepEqual(await get.call(service,a.id,deploymentId),view);assert.deepEqual({queries,rowsRead},budget);assert.equal(writes,0);
 assert.deepEqual((await db.prepare("SELECT data FROM ota_deployments ORDER BY id").all()).results,before);
 const path="/api/apps/"+a.id+"/ota/deployments/"+deploymentId+"/publication";
 assert.equal((await runtime.fetch(origin+path)).status,401);
 const enrolled=await runtime.fetch(origin+"/api/auth/enroll",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({email:config.ownerEmail,password,confirmation:password,token:token.toString("base64url")})});assert.equal(enrolled.status,200);
 const cookie=enrolled.headers.getSetCookie().map(c=>c.split(";",1)[0]).join("; ");
 const response=await runtime.fetch(origin+path,{headers:{Cookie:cookie}});assert.equal(response.status,200);assert.deepEqual(await response.json(),view);
 assert.equal((await runtime.fetch(origin+path.replace(a.id,b.id),{headers:{Cookie:cookie}})).status,404);
 assert.equal((await runtime.fetch(origin+path.replace(deploymentId,"22222222-2222-4222-8222-222222222222"),{headers:{Cookie:cookie}})).status,404);
 assert.equal(writes,0);assert.deepEqual((await db.prepare("SELECT data FROM ota_deployments ORDER BY id").all()).results,before);
 t.diagnostic("Publication point read budget: "+JSON.stringify(budget)+", writes=0; unchanged with 24 newer deployments");
});
