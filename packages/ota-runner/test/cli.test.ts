import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {createServer} from "node:http";
import {execFile} from "node:child_process";
test("CLI presence works without Docker, recovery setup, claims or credential output",async t=>{
 const root=await mkdtemp(join(tmpdir(),"flora-cli-presence-"));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,"empty-path"));const now=Date.now(),token="runner_fixture."+"a".repeat(43);let requests=0;
 const server=createServer(async(req,res)=>{requests++;assert.equal(req.url,"/api/runner/presence");assert.equal(req.headers.authorization,"Bearer "+token);let input="";for await(const bytes of req)input+=bytes;assert.equal(input,"{}");res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({runnerId:"runner_fixture",lastSeenAt:now}));});await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));t.after(()=>new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();}));
 const path=join(root,"runner.json");await writeFile(path,JSON.stringify({origin:"http://127.0.0.1:"+(server.address() as {port:number}).port,token,dockerImage:"node@sha256:"+"a".repeat(64),recoveryDirectory:join(root,"recovery")}),{mode:0o600});
 const invoke=(args:string[])=>new Promise<{error:Error|null;stdout:string;stderr:string}>(resolve=>execFile(process.execPath,[fileURLToPath(new URL("../dist/main.js",import.meta.url)),"--config",path,...args],{env:{PATH:join(root,"empty-path")},timeout:5000},(error,stdout,stderr)=>resolve({error,stdout,stderr})));
 const result=await invoke(["--presence"]);assert.equal(result.error,null);assert.equal(result.stderr,"");assert.deepEqual(JSON.parse(result.stdout),{state:"presence",runnerId:"runner_fixture",lastSeenAt:now});assert.equal(requests,1);assert.ok(!result.stdout.includes(token));const {lstat}=await import("node:fs/promises");await assert.rejects(lstat(join(root,"recovery")),{code:"ENOENT"});
 for(const args of [["--once","--presence"],["--presence","--presence"],["--presence","--reconcile",join(root,"journal.json")]]){const rejected=await invoke(args);assert.ok(rejected.error);assert.match(rejected.stderr,/^Usage:/);assert.equal(rejected.stdout,"");}assert.equal(requests,1);
});
test("CLI unavailable Docker is explicitly preclaim while acquiring no job or exposing its credential",async t=>{
 const root=await mkdtemp(join(tmpdir(),"flora-cli-"));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,"empty-path"));let requests=0;const server=createServer((_req,res)=>{requests++;res.writeHead(204);res.end();});await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));t.after(()=>new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();}));
 const token="runner_fixture."+"a".repeat(43),path=join(root,"runner.json");await writeFile(path,JSON.stringify({origin:"http://127.0.0.1:"+(server.address() as {port:number}).port,token,dockerImage:"node@sha256:"+"a".repeat(64)}),{mode:0o600});
 const result=await new Promise<{error:Error|null;stdout:string;stderr:string}>(resolve=>execFile(process.execPath,[fileURLToPath(new URL("../dist/main.js",import.meta.url)),"--config",path,"--once"],{env:{PATH:join(root,"empty-path")},timeout:5000},(error,stdout,stderr)=>resolve({error,stdout,stderr})));
 assert.ok(result.error);assert.equal(result.stderr,JSON.stringify({diagnostic:true,stage:"runner-initialization",code:"DOCKER_DAEMON_UNAVAILABLE"})+"\nDOCKER_DAEMON_UNAVAILABLE\n");assert.equal(result.stdout,"");assert.equal(requests,0);assert.ok(!result.stderr.includes(token));
});
test("CLI reconciliation bypasses Docker and never claims or discards a rejected journal",async t=>{
 const {writeRecoveryJournal}=await import("../dist/index.js");const root=await mkdtemp(join(tmpdir(),"flora-cli-reconcile-"));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,"empty-path"));let requests=0;
 const server=createServer((req,res)=>{requests++;assert.equal(req.url,"/api/runner/finalize");res.writeHead(409,{"Content-Type":"application/json"});res.end(JSON.stringify({error:"LEASE_EXPIRED"}));});await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));t.after(()=>new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();}));
 const origin="http://127.0.0.1:"+(server.address() as {port:number}).port,token="runner_fixture."+"a".repeat(43),configPath=join(root,"runner.json");await writeFile(configPath,JSON.stringify({origin,token,dockerImage:"node@sha256:"+"a".repeat(64)}),{mode:0o600});
 const lease={jobId:"job_one",appId:"app_one",attemptId:"attempt_one",runnerId:"runner_fixture",credentialEpoch:1,fence:1,expiresAt:Date.now()+120000},receipt={jobId:lease.jobId,attemptId:lease.attemptId,commitSha:"a".repeat(40),configDigest:"b".repeat(64),toolchainDigest:"c".repeat(64),sourceArchiveDigest:"d".repeat(64),launchAssetId:"asset_"+"e".repeat(64),assetIds:[],artifactDigest:"f".repeat(64)};
 const path=await writeRecoveryJournal(join(root,"recovery"),{schemaVersion:1,origin,lease,receipt});
 async function invoke(args:string[]){return new Promise<{error:Error|null;stdout:string;stderr:string}>(resolve=>execFile(process.execPath,[fileURLToPath(new URL("../dist/main.js",import.meta.url)),"--config",configPath,...args],{env:{PATH:join(root,"empty-path")},timeout:5000},(error,stdout,stderr)=>resolve({error,stdout,stderr})));}
 const result=await invoke(["--reconcile",path]);assert.ok(result.error);assert.equal(requests,1);assert.equal(result.stderr,"LEASE_EXPIRED\n");const {lstat}=await import("node:fs/promises");assert.ok(await lstat(path));assert.ok(!result.stderr.includes(token));
 const restarted=await invoke(["--once"]);assert.ok(restarted.error);assert.equal(restarted.stderr,"PUBLICATION_RECONCILIATION_REQUIRED\n");assert.equal(JSON.parse(restarted.stdout).recoveryJournal,path);assert.equal(requests,1,"pending recovery stops before Docker or claim");
});
test("CLI presence retains actual HTTP status in fixed diagnostics alongside legacy code-only line",async t=>{
 const root=await mkdtemp(join(tmpdir(),"flora-cli-presence-failure-"));t.after(()=>rm(root,{recursive:true,force:true}));const token="runner_fixture."+"a".repeat(43);let status=503,valid=false;
 const server=createServer((req,res)=>{assert.equal(req.url,"/api/runner/presence");res.writeHead(status,{"Content-Type":"application/json","X-Secret":"private-header"});res.end(valid?'{}':'secret raw body '+token);});
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));t.after(()=>new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();}));
 const configPath=join(root,"runner.json");await writeFile(configPath,JSON.stringify({origin:"http://127.0.0.1:"+(server.address() as {port:number}).port,token,dockerImage:"node@sha256:"+"a".repeat(64)}),{mode:0o600});
 const invoke=()=>new Promise<{error:Error|null;stdout:string;stderr:string}>(resolve=>execFile(process.execPath,[fileURLToPath(new URL("../dist/main.js",import.meta.url)),"--config",configPath,"--presence"],{timeout:5000},(error,stdout,stderr)=>resolve({error,stdout,stderr})));
 for(const code of [500,503,401,403]){status=code;const result=await invoke();assert.ok(result.error);assert.equal(result.stdout,"");const lines=result.stderr.trim().split('\n');assert.equal(lines.length,2);assert.deepEqual(JSON.parse(lines[0]!),{diagnostic:true,stage:"runner-execution",code:"RUNNER_REQUEST_REJECTED",httpStatus:code});assert.equal(lines[1],"RUNNER_REQUEST_REJECTED");assert.ok(!result.stderr.includes(token));assert.ok(!result.stderr.includes('secret raw'));assert.ok(!result.stderr.includes('private-header'));}
 status=200;valid=true;const unknown=await invoke();assert.ok(unknown.error);const lines=unknown.stderr.trim().split('\n');assert.deepEqual(JSON.parse(lines[0]!),{diagnostic:true,stage:"runner-execution",code:"RUNNER_RESPONSE_INVALID"});assert.equal(lines[1],"RUNNER_RESPONSE_INVALID");
});
test("CLI presence exposes only fixed daily D1 quota codes for supervisor cooldown",async t=>{
 const root=await mkdtemp(join(tmpdir(),"flora-cli-quota-"));t.after(()=>rm(root,{recursive:true,force:true}));const token="runner_fixture."+"a".repeat(43);let code="D1_DAILY_READ_LIMIT";
 const server=createServer((req,res)=>{assert.equal(req.url,"/api/runner/presence");res.writeHead(503,{"Content-Type":"application/json"});res.end(JSON.stringify({error:code,detail:"private detail "+token}));});await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));t.after(()=>new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();}));
 const configPath=join(root,"runner.json");await writeFile(configPath,JSON.stringify({origin:"http://127.0.0.1:"+(server.address() as {port:number}).port,token,dockerImage:"node@sha256:"+"a".repeat(64)}),{mode:0o600});
 for(const [serverCode,expectedCode] of [["D1_DAILY_READ_LIMIT","D1_DAILY_READ_LIMIT"],["D1_DAILY_WRITE_LIMIT","D1_DAILY_WRITE_LIMIT"],["D1_UNRECOGNIZED_SECRET","RUNNER_REQUEST_REJECTED"]]){
  code=serverCode!;const result=await new Promise<{error:Error|null;stdout:string;stderr:string}>(resolve=>execFile(process.execPath,[fileURLToPath(new URL("../dist/main.js",import.meta.url)),"--config",configPath,"--presence"],{timeout:5000},(error,stdout,stderr)=>resolve({error,stdout,stderr})));
  assert.ok(result.error);assert.equal(result.stdout,"");const lines=result.stderr.trim().split('\n');assert.equal(lines.length,2);assert.deepEqual(JSON.parse(lines[0]!),{diagnostic:true,stage:"runner-execution",code:expectedCode,httpStatus:503});assert.equal(lines[1],expectedCode);assert.ok(!result.stderr.includes(token));assert.ok(!result.stderr.includes("private detail"));assert.ok(!result.stderr.includes("D1_UNRECOGNIZED_SECRET"));
 }
});
