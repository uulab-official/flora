import test from "node:test";
import assert from "node:assert/strict";
import type { D1Database } from "@cloudflare/workers-types";
import type { FloraConfig } from "../src/contracts.ts";
import { listProjectSummaries } from "../dist/project-summary.js";
import { routeRequest, HttpFailure } from "../dist/http.js";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createTestRuntime } from "./runtime.ts";
const config: FloraConfig = { ownerId: "owner_a", origin: "https://flora.example.test", ownerEmail: "owner@example.test", dbIdentity: "db_a", setup: null };
const now = 1800000000000;

test("project summary route is read-only with validated app selectors and rejects caller authority", () => {
  assert.equal(routeRequest(new Request(config.origin + "/api/projects")).kind, "hosted");
  for (const method of ["POST", "HEAD", "DELETE"]) assert.throws(() => routeRequest(new Request(config.origin + "/api/projects", { method })), (e: unknown) => e instanceof HttpFailure && e.status === 405);
  assert.equal(routeRequest(new Request(config.origin+"/api/projects?appId=application_a")).kind,"hosted");
  assert.equal(routeRequest(new Request(config.origin+"/api/projects?appCursor=opaque")).kind,"hosted");
  for (const search of ["?appId=../foreign", "?appId=application_a&appId=application_b", "?appId=application_a&appCursor=opaque", "?ownerId=owner_b", "?token=secret", "?role=owner", "?appIds=application_a"]) assert.throws(() => routeRequest(new Request(config.origin + "/api/projects" + search)), (e: unknown) => e instanceof HttpFailure && e.status === 400);
});

test("bounded owner projection separates apps and platforms, latest published OTA and Runner semantics without writes", async t => {
  const runtime = await createTestRuntime({ entrypoint: new URL("./fixtures/runtime-entry.ts", import.meta.url) }); t.after(() => runtime.dispose());
  const db = runtime.d1;
  await db.exec(`CREATE TABLE flora_deployment(singleton INTEGER,owner_id TEXT,origin TEXT,db_identity TEXT);
CREATE TABLE applications(owner_id TEXT,id TEXT,name TEXT,repository_id TEXT,root_directory TEXT,created_at INTEGER);
CREATE TABLE github_connections(owner_id TEXT,app_id TEXT,version INTEGER,data TEXT);
CREATE TABLE ota_deployments(owner_id TEXT,app_id TEXT,id TEXT,platform TEXT,channel TEXT,runtime_version TEXT,created_at INTEGER,data TEXT);
CREATE TABLE automation_policies(owner_id TEXT,app_id TEXT,version INTEGER,data TEXT);
CREATE TABLE automation_runners(owner_id TEXT,id TEXT,version INTEGER,data TEXT);`);
  await db.prepare("INSERT INTO flora_deployment VALUES(1,?,?,?)").bind(config.ownerId, config.origin, config.dbIdentity).run();
  const app = async (owner: string, id: string, repository = "synthetic/" + id, root = ".", name = id) => db.prepare("INSERT INTO applications VALUES(?,?,?,?,?,?)").bind(owner, id, name, repository, root, now).run();
  for (const id of ["app_online", "app_offline", "app_unseen", "app_revoked", "app_empty"]) await app(config.ownerId, id);
  await app("owner_b", "foreign_app");
  await db.prepare("INSERT INTO github_connections VALUES(?,?,?,?)").bind(config.ownerId, "app_online", 1, JSON.stringify({ owner: "old", repository: "old", ref: "old" })).run();
  await db.prepare("INSERT INTO github_connections VALUES(?,?,?,?)").bind(config.ownerId, "app_online", 2, JSON.stringify({ owner: "synthetic", repository: "online", ref: "main", secret: "MUST_NOT_EXPORT" })).run();
  await db.prepare("INSERT INTO github_connections VALUES(?,?,?,?)").bind("owner_b", "app_online", 99, JSON.stringify({ owner: "foreign", repository: "secret", ref: "other" })).run();
  for (const [owner,id,platform,time,channel] of [[config.ownerId,"ios_old","ios",now-10,"production"],[config.ownerId,"ios_new","ios",now,"verification"],[config.ownerId,"aaa_ios_later","ios",now,"staging"],[config.ownerId,"android_new","android",now-5,"production"],["owner_b","ios_foreign","ios",now+10,"foreign"]] as const) {
    await db.prepare("INSERT INTO ota_deployments VALUES(?,?,?,?,?,?,?,?)").bind(owner,"app_online",id,platform,channel,"runtime-v1",time,JSON.stringify({ commitSha:"a".repeat(40),assets:["MUST_NOT_EXPORT"],private:"MUST_NOT_EXPORT" })).run();
  }
  await db.prepare("INSERT INTO automation_policies VALUES(?,?,?,?)").bind(config.ownerId,"app_online",1,JSON.stringify({enabled:true,channel:"verification",platforms:["ios","android"],updatedAt:now})).run();
  const runner = async (owner: string, id: string, appIds: string[], revokedAt: number | null, version = 1) => db.prepare("INSERT INTO automation_runners VALUES(?,?,?,?)").bind(owner,id,version,JSON.stringify({ appIds,revokedAt,tokenHash:"MUST_NOT_EXPORT",private:"MUST_NOT_EXPORT" })).run();
  await runner(config.ownerId,"runner_online",["app_online"],null);
  await runner(config.ownerId,"runner_offline",["app_offline"],null);
  await runner(config.ownerId,"runner_unseen",["app_unseen"],null);
  await runner(config.ownerId,"runner_revoked",["app_revoked"],null);
  await runner(config.ownerId,"runner_revoked",["app_revoked"],now,2);
  await runner("owner_b","foreign_runner",["app_unseen"],null);
  const presence = new Map([["runner_online",now-120000],["runner_offline",now-120001],["runner_revoked",now],["foreign_runner",now]]);
  const totals = () => db.prepare("SELECT (SELECT count(*) FROM applications) apps,(SELECT count(*) FROM ota_deployments) ota,(SELECT count(*) FROM automation_runners) runners").first();
  const before = await totals(); let prepareCount = 0, batches = 0;
  const traced = new Proxy(db, { get(target,key) { if(key === "prepare") return (sql: string) => { prepareCount++; assert.match(sql,/^SELECT/); assert.doesNotMatch(sql,/SELECT\s+(?:\*|data\b)|tokenHash/); return target.prepare(sql); }; if(key === "batch") return (...args: any[]) => { batches++; return (target.batch as any)(...args); }; const value = Reflect.get(target,key); return typeof value === "function" ? value.bind(target) : value; } }) as D1Database;
  const result = await listProjectSummaries(traced,config,()=>{},now,presence);
  assert.equal(prepareCount,3); assert.equal(batches,1); assert.deepEqual(await totals(),before); assert.equal(result.projects.length,5);
  const online = result.projects.find(row=>row.id === "app_online")!;
  assert.equal(online.github?.repository,"online"); assert.equal(online.ota.ios?.id,"aaa_ios_later"); assert.equal(online.ota.ios?.channel,"staging"); assert.equal(online.ota.android?.id,"android_new");
  assert.deepEqual(online.automation?.platforms,["ios","android"]);
  assert.equal(online.runner.status,"online"); assert.equal(result.projects.find(row=>row.id === "app_offline")?.runner.status,"offline"); assert.equal(result.projects.find(row=>row.id === "app_unseen")?.runner.status,"unseen"); assert.equal(result.projects.find(row=>row.id === "app_revoked")?.runner.status,"revoked");
  const empty = result.projects.find(row=>row.id === "app_empty")!; assert.equal(empty.runner.status,"unregistered"); assert.deepEqual(empty.ota,{ios:null,android:null}); assert.equal(empty.github,null); assert.equal(empty.automation,null);
  assert.doesNotMatch(JSON.stringify(result),/MUST_NOT_EXPORT|foreign_app|ios_foreign|foreign_runner|tokenHash/);
  await assert.rejects(listProjectSummaries(db,{...config,ownerId:"owner_b"},()=>{},now,presence),/IDENTITY_MISMATCH/);
  let fenceCount = 0; await assert.rejects(listProjectSummaries(db,config,()=>{ if(++fenceCount===3) throw new Error("SESSION_REVOKED"); },now,presence),/SESSION_REVOKED/);
  for(let i=0;i<100;i++) await app(config.ownerId,`bounded_${i.toString().padStart(3,"0")}`,"\u0001".repeat(4096),"😀".repeat(4096),"\u0001".repeat(256));
  const bounded = await listProjectSummaries(db,config,()=>{},now,new Map()); assert.equal(bounded.projects.length,100);
  const clipped=bounded.projects.find(row=>row.id.startsWith("bounded_"))!; assert.equal([...clipped.repositoryId].length,256); assert.equal([...clipped.rootDirectory].length,256); assert.deepEqual(clipped.truncated,{repositoryId:true,rootDirectory:true});
  assert.ok(Buffer.byteLength(JSON.stringify(bounded))<700000,"worst escaped metadata remains under response bound");
  const full = await db.prepare("SELECT length(repository_id) size FROM applications WHERE id=?").bind(clipped.id).first<{size:number}>(); assert.equal(full?.size,4096);
  await db.exec("DROP TABLE ota_deployments"); await assert.rejects(listProjectSummaries(db,config,()=>{},now,presence));
});


test("project API requires a live owner session and fails closed on store or authority errors", async t => {
  const token = randomBytes(32), password = randomBytes(24).toString("base64url");
  const runtime = await createTestRuntime({ entrypoint: new URL("./fixtures/hosted-entry.ts", import.meta.url), durableObjects: { FLORA_AUTH: "HostedFixtureAuth" }, bindings: {
    FLORA_ORIGIN: config.origin, FLORA_OWNER_ID: config.ownerId, FLORA_OWNER_EMAIL: config.ownerEmail, FLORA_DB_IDENTITY: config.dbIdentity,
    FLORA_SETUP: { digest: createHash("sha256").update(token).digest("hex"), issuedAt: now, expiresAt: now + 600000, generation: 1, purpose: "enroll" },
  }}); t.after(() => runtime.dispose());
  const migrations = await Promise.all(["0001_private_imports.sql", "0002_multi_app.sql", "0003_github_ota.sql", "0004_automation.sql"].map(file => readFile(new URL("../migrations/" + file, import.meta.url), "utf8")));
  await runtime.d1.exec(migrations.join("\n").replace(/^--.*$/gm, "").split(/;\s*(?=CREATE|INSERT|PRAGMA|$)/).filter(s => s.trim()).map(s => s.replace(/\s*\n\s*/g, " ").trim() + ";").join("\n"));
  await runtime.d1.prepare("INSERT INTO flora_deployment VALUES(1,?,?,?)").bind(config.ownerId,config.origin,config.dbIdentity).run();
  const call = (path: string, body?: unknown, cookie = "", csrf = "") => runtime.fetch(config.origin + path, { headers: { Cookie: cookie, ...(body === undefined ? {} : { Origin: config.origin, "Content-Type": "application/json", "X-Flora-CSRF": csrf }) }, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  assert.equal((await call("/api/projects")).status,401);
  const enrolled = await call("/api/auth/enroll",{email:config.ownerEmail,password,confirmation:password,token:token.toString("base64url")}); assert.equal(enrolled.status,200);
  const cookie = enrolled.headers.getSetCookie().map(value=>value.split(";",1)[0]).join("; "); const csrf = (await enrolled.json() as {csrfToken:string}).csrfToken;
  const empty = await call("/api/projects",undefined,cookie); assert.equal(empty.status,200); assert.deepEqual((await empty.json() as any).projects,[]);
  await call("/__test/control",{failD1:true},cookie,csrf);
  const unavailable = await call("/api/projects",undefined,cookie); assert.equal(unavailable.status,503); assert.deepEqual(await unavailable.json(),{error:"DEPENDENCY_UNAVAILABLE"});
  await call("/__test/control",{failD1:false,revokeBeforeD1Read:true},cookie,csrf);
  assert.equal((await call("/api/projects",undefined,cookie)).status,401);
  assert.equal((await call("/api/projects",undefined,cookie)).status,401);
});

test("project API reuses projection for60seconds while every request keeps live authority and presence", async t => {
  const token=randomBytes(32),password=randomBytes(24).toString("base64url");
  const runtime=await createTestRuntime({entrypoint:new URL("./fixtures/hosted-entry.ts",import.meta.url),durableObjects:{FLORA_AUTH:"HostedFixtureAuth"},bindings:{
    FLORA_ORIGIN:config.origin,FLORA_OWNER_ID:config.ownerId,FLORA_OWNER_EMAIL:config.ownerEmail,FLORA_DB_IDENTITY:config.dbIdentity,
    FLORA_SETUP:{digest:createHash("sha256").update(token).digest("hex"),issuedAt:now,expiresAt:now+600000,generation:1,purpose:"enroll"}}});t.after(()=>runtime.dispose());
  await runtime.d1.exec(`CREATE TABLE flora_deployment(singleton INTEGER,owner_id TEXT,origin TEXT,db_identity TEXT);
CREATE TABLE applications(owner_id TEXT,id TEXT,name TEXT,repository_id TEXT,root_directory TEXT,created_at INTEGER);
CREATE TABLE github_connections(owner_id TEXT,app_id TEXT,version INTEGER,data TEXT);
CREATE TABLE ota_deployments(owner_id TEXT,app_id TEXT,id TEXT,platform TEXT,channel TEXT,runtime_version TEXT,created_at INTEGER,data TEXT);
CREATE TABLE automation_policies(owner_id TEXT,app_id TEXT,version INTEGER,data TEXT);
CREATE TABLE automation_runners(owner_id TEXT,id TEXT,version INTEGER,data TEXT);`);
  await runtime.d1.prepare("INSERT INTO flora_deployment VALUES(1,?,?,?)").bind(config.ownerId,config.origin,config.dbIdentity).run();
  await runtime.d1.prepare("INSERT INTO applications VALUES(?,?,?,?,?,?)").bind(config.ownerId,"application_first","First","synthetic/first",".",now-1).run();
  await runtime.d1.prepare("INSERT INTO automation_runners VALUES(?,?,?,?)").bind(config.ownerId,"runner_first",1,JSON.stringify({appIds:["application_first"],revokedAt:null})).run();
  const call=(path:string,body?:unknown,cookie="",csrf="")=>runtime.fetch(config.origin+path,{headers:{Cookie:cookie,...(body===undefined?{}:{Origin:config.origin,"Content-Type":"application/json","X-Flora-CSRF":csrf})},...(body===undefined?{}:{method:"POST",body:JSON.stringify(body)})});
  const enrolled=await call("/api/auth/enroll",{email:config.ownerEmail,password,confirmation:password,token:token.toString("base64url")});assert.equal(enrolled.status,200);
  const cookie=enrolled.headers.getSetCookie().map(v=>v.split(";",1)[0]).join("; "),csrf=(await enrolled.json() as {csrfToken:string}).csrfToken;
  const control=async(value:unknown)=>{const response=await call("/__test/control",value,cookie,csrf);assert.equal(response.status,200);return await response.json() as any;};
  const list=async()=>{const response=await call("/api/projects",undefined,cookie);assert.equal(response.status,200);return await response.json() as any;};
  const first=await list();assert.equal(first.projects[0].runner.status,"unseen");const afterFirst=(await control({stats:true})).writes;
  await list();assert.equal((await control({stats:true})).writes,afterFirst,"cache hit cannot rescan project and runner histories");
  await control({sql:"INSERT INTO flora_runner_presence VALUES('runner_first',"+now+")"});
  const live=await list();assert.equal(live.projects[0].runner.status,"online");assert.equal(live.observedAt,now);assert.equal((await control({stats:true})).writes,afterFirst);
  await control({now:now+59999});await list();assert.equal((await control({stats:true})).writes,afterFirst);
  await control({now:now+60000});await list();assert.equal((await control({stats:true})).writes,afterFirst+1);
  await control({now:now+120001});const expired=await list();assert.equal(expired.projects[0].runner.status,"offline");
  await runtime.d1.prepare("UPDATE flora_deployment SET db_identity='different'").run();
  assert.equal((await call("/api/projects",undefined,cookie)).status,503,"identity mismatch cannot expose cached projects");
  await runtime.d1.prepare("UPDATE flora_deployment SET db_identity=?").bind(config.dbIdentity).run();
  await control({revokeBeforeD1Read:true});assert.equal((await call("/api/projects",undefined,cookie)).status,401,"session revoked during a cache-hit identity read stays revoked");
  assert.equal((await call("/api/projects",undefined,cookie)).status,401);
});

test("project rollback linkage proves both immutable endpoints in all six scopes without additional D1 queries",async t=>{
 const runtime=await createTestRuntime({entrypoint:new URL("./fixtures/runtime-entry.ts",import.meta.url)});t.after(()=>runtime.dispose());const db=runtime.d1;
 await db.exec(`CREATE TABLE flora_deployment(singleton INTEGER,owner_id TEXT,origin TEXT,db_identity TEXT);
CREATE TABLE applications(owner_id TEXT,id TEXT,name TEXT,repository_id TEXT,root_directory TEXT,created_at INTEGER);
CREATE TABLE github_connections(owner_id TEXT,app_id TEXT,version INTEGER,data TEXT);
CREATE TABLE ota_deployments(owner_id TEXT,app_id TEXT,id TEXT,platform TEXT,channel TEXT,runtime_version TEXT,created_at INTEGER,data TEXT,PRIMARY KEY(owner_id,app_id,id));
CREATE TABLE automation_policies(owner_id TEXT,app_id TEXT,version INTEGER,data TEXT);
CREATE TABLE automation_runners(owner_id TEXT,id TEXT,version INTEGER,data TEXT);`);
 await db.prepare("INSERT INTO flora_deployment VALUES(1,?,?,?)").bind(config.ownerId,config.origin,config.dbIdentity).run();
 const {randomUUID}=await import("node:crypto"),cases=[];
 for(const name of ["isso","promise","reward"]){
  const appId="application_"+name;await db.prepare("INSERT INTO applications VALUES(?,?,?,?,?,?)").bind(config.ownerId,appId,name,"synthetic/"+name,".",now-5000).run();
  for(const platform of ["ios","android"] as const){
   const source=randomUUID(),target=randomUUID(),rollback=randomUUID(),metadata={fromDeploymentId:source,targetDeploymentId:target,reason:"Restore known safe release",requestedAt:now-1000};cases.push({appId,platform,source,target,rollback,metadata});
   for(const [id,createdAt,extra] of [[target,now-3000,{}],[source,now-2000,{}],[rollback,now-1000,{rollback:metadata}]] as const)await db.prepare("INSERT INTO ota_deployments VALUES(?,?,?,?,?,?,?,?)").bind(config.ownerId,appId,id,platform,"verification","native-v1",createdAt,JSON.stringify({commitSha:"a".repeat(40),...extra})).run();
  }
 }
 let reads=0;const traced=new Proxy(db,{get(target,key){if(key==="prepare")return (sql:string)=>{reads++;return target.prepare(sql);};const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}}) as D1Database;
 const before=(await db.prepare("SELECT * FROM ota_deployments ORDER BY app_id,id").all()).results;
 const result=await listProjectSummaries(traced,config,()=>{},now,new Map());assert.equal(reads,3);assert.equal(result.rollbackLineages?.length,6);
 for(const item of cases){const selected=result.projects.find(p=>p.id===item.appId)!.ota[item.platform]!;assert.equal(selected.id,item.rollback);assert.deepEqual(selected.rollback,item.metadata);assert.deepEqual(selected.rollbackIssue,{deploymentId:item.source,telemetry:null});}
 assert.deepEqual((await db.prepare("SELECT * FROM ota_deployments ORDER BY app_id,id").all()).results,before);
 const invalid=cases[0]!;await db.prepare("UPDATE ota_deployments SET runtime_version='foreign-runtime' WHERE id=?").bind(invalid.target).run();
 const mismatched=await listProjectSummaries(db,config,()=>{},now,new Map());assert.equal(mismatched.rollbackLineages?.length,5);const selected=mismatched.projects.find(p=>p.id===invalid.appId)!.ota[invalid.platform]!;assert.equal(selected.rollback,undefined);assert.equal(selected.rollbackIssue,null,"an invalid latest rollback is explicitly unknown even before any edge can be trusted");
 await db.prepare("UPDATE ota_deployments SET runtime_version='native-v1' WHERE id=?").bind(invalid.target).run();
 const nested=[];
 for(const item of cases){const second=randomUUID(),third=randomUUID();nested.push({...item,second,third});for(const [id,parent,createdAt] of [[second,item.rollback,now-500],[third,second,now-250]] as const)await db.prepare("INSERT INTO ota_deployments VALUES(?,?,?,?,?,?,?,?)").bind(config.ownerId,item.appId,id,item.platform,"verification","native-v1",createdAt,JSON.stringify({rollback:{fromDeploymentId:parent,targetDeploymentId:item.target,reason:"Recover rollback",requestedAt:createdAt}})).run();}
 reads=0;const chain=await listProjectSummaries(traced,config,()=>{},now,new Map());assert.equal(reads,3,"the bounded root chain stays inside the existing projection query");assert.equal(chain.rollbackLineages?.length,18);
 for(const item of nested){const latest=chain.projects.find(p=>p.id===item.appId)!.ota[item.platform]!;assert.equal(latest.id,item.third);assert.equal(latest.rollback?.fromDeploymentId,item.second);assert.deepEqual(latest.rollbackIssue,{deploymentId:item.source,telemetry:null,depth:3});}
 const broken=nested[0]!;await db.prepare("UPDATE ota_deployments SET data=json_set(data,'$.rollback.fromDeploymentId',?) WHERE id=?").bind(randomUUID(),broken.second).run();
 const incomplete=await listProjectSummaries(db,config,()=>{},now,new Map()),unknown=incomplete.projects.find(p=>p.id===broken.appId)!.ota[broken.platform]!;assert.equal(unknown.rollback?.fromDeploymentId,broken.second);assert.equal(unknown.rollbackIssue,null,"an invalid ancestor cannot manufacture an authoritative original root");
});
