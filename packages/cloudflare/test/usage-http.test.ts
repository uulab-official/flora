import test from "node:test";
import assert from "node:assert/strict";
import {createHash,randomBytes} from "node:crypto";
import {mkdtemp,readFile,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {createTestRuntime} from "./runtime.ts";
import type {RunnerEnrollment} from "@app-ops/dogfood";

test("usage reports authenticate the designated Runner, preserve D1 history and never expose provider credentials",async t=>{
 const directory=await mkdtemp(join(tmpdir(),"flora-usage-http-"));t.after(()=>rm(directory,{recursive:true,force:true}));
 let source=await readFile(new URL("./fixtures/hosted-entry.ts",import.meta.url),"utf8");
 source=source.replace('from "../../dist/worker.js"','from '+JSON.stringify(fileURLToPath(new URL("../dist/worker.js",import.meta.url))));
 source=source.replace('from "../../src/contracts.js"','from '+JSON.stringify(fileURLToPath(new URL("../src/contracts.ts",import.meta.url))));
 source=source.replace("const data = await request.json() as {","const data = await request.json() as { usageReporter?:string;");
 source=source.replace("if (data.now !== undefined)","if(data.usageReporter!==undefined)this.fixtureEnv.FLORA_USAGE_REPORTER_ID=data.usageReporter; if (data.now !== undefined)");
 const entry=join(directory,"entry.ts");await writeFile(entry,source);
 const origin="https://usage.example.test",now=1800000000000,account="a".repeat(32),token=randomBytes(32),password=randomBytes(24).toString("base64url");
 const runtime=await createTestRuntime({entrypoint:new URL("file://"+entry),durableObjects:{FLORA_AUTH:"HostedFixtureAuth"},bindings:{FLORA_ORIGIN:origin,FLORA_OWNER_ID:"usage-owner",FLORA_OWNER_EMAIL:"owner@example.test",FLORA_DB_IDENTITY:"usage-db",FLORA_CLOUDFLARE_ACCOUNT_ID:account,FLORA_USAGE_REPORTER_ID:"runner_unconfigured",FLORA_SETUP:{digest:createHash("sha256").update(token).digest("hex"),issuedAt:now,expiresAt:now+600000,generation:1,purpose:"enroll"}}});t.after(()=>runtime.dispose());
 for(const name of["0001_private_imports.sql","0002_multi_app.sql","0003_github_ota.sql","0004_automation.sql"]){const sql=await readFile(new URL("../migrations/"+name,import.meta.url),"utf8");await runtime.d1.exec(sql.replace(/^--.*$/gm,"").split(/;\s*(?=CREATE|INSERT|DROP|PRAGMA|$)/).filter(s=>s.trim()).map(s=>s.replace(/\s*\n\s*/g," ").trim()+";").join("\n"));}
 await runtime.d1.prepare("INSERT INTO flora_deployment(singleton,owner_id,origin,db_identity)VALUES(1,?,?,?)").bind("usage-owner",origin,"usage-db").run();
 const enroll=await runtime.fetch(origin+"/api/auth/enroll",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({email:"owner@example.test",password,confirmation:password,token:token.toString("base64url")})});assert.equal(enroll.status,200);
 const headers={Cookie:enroll.headers.getSetCookie().map(c=>c.split(";",1)[0]).join("; "),Origin:origin,"Content-Type":"application/json","X-Flora-CSRF":(await enroll.json() as any).csrfToken};
 const owner=(path:string,body?:unknown)=>runtime.fetch(origin+path,{headers,...(body===undefined?{}:{method:"POST",body:JSON.stringify(body)})});
 const control=(body:unknown)=>owner("/__test/control",body),machine=(credential:string,body:unknown)=>runtime.fetch(origin+"/api/runner/usage",{method:"POST",headers:{Authorization:"Bearer "+credential,"Content-Type":"application/json"},body:JSON.stringify(body)});
 const appIds:string[]=[];for(const name of["first","second"]){const response=await owner("/api/apps",{name,repositoryId:"synthetic/"+name,rootDirectory:"."});assert.equal(response.status,201);appIds.push((await response.json() as any).id);}
 const first=await (await owner("/api/runners",{name:"reporter",appIds:[appIds[0]]})).json() as RunnerEnrollment,second=await (await owner("/api/runners",{name:"other app",appIds:[appIds[1]]})).json() as RunnerEnrollment;
 await control({usageReporter:first.runner.id});
 const report={day:new Date(now).toISOString().slice(0,10),observedAt:now,rowsRead:42,rowsWritten:7};
 assert.equal((await runtime.fetch(origin+"/api/projects")).status,401);
 assert.equal((await machine(second.token,report)).status,403);
 assert.ok((await machine(first.runner.id+".invalid",report)).status>=400);
 assert.ok((await owner("/api/runner/usage",report)).status>=400);
 for(const body of[{...report,accountId:account},{...report,appId:appIds[1]},{...report,providerToken:"NEVER_ACCEPT"},{...report,rowsRead:null},{...report,observedAt:now+1}])assert.equal((await machine(first.token,body)).status,400);
 const before=(await runtime.d1.prepare("SELECT * FROM applications ORDER BY id").all()).results;
 assert.equal((await machine(first.token,report)).status,200);
 const list=await owner("/api/projects");assert.equal(list.status,200);const result=await list.json() as any;assert.equal(result.usage.rowsRead,42);assert.equal(result.usage.rowsWritten,7);assert.equal(result.usage.collectedBy,"pc-runner");assert.equal(result.usage.verification,"authenticated-reporter");assert.doesNotMatch(JSON.stringify(result),/tokenHash|providerToken|NEVER_ACCEPT/);
 assert.equal((await machine(first.token,report)).status,409);
 await control({restart:true});assert.equal((await (await owner("/api/projects")).json() as any).usage.rowsRead,42);
 assert.deepEqual((await runtime.d1.prepare("SELECT * FROM applications ORDER BY id").all()).results,before);
 await owner(`/api/runners/${first.runner.id}/revoke`,{});await control({now:now+1});assert.equal((await machine(first.token,{...report,observedAt:now+1})).status,403);
 assert.equal((await (await owner("/api/projects")).json() as any).usage.rowsRead,42);
});
