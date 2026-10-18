import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {createServer} from "node:net";
import {join} from "node:path";
const modulePath="../dist/setup/runner.js";
const runnerId="runner_11111111-1111-4111-8111-111111111111",origin="https://qa.example.com",image="sha256:"+"a".repeat(64),token=runnerId+"."+"b".repeat(43);
async function fixture(t:test.TestContext){
 const dir=await fs.mkdtemp("/private/tmp/flora-guided-"),socket=join(dir,"d.sock"),server=createServer();await new Promise<void>(r=>server.listen(socket,r));t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));await fs.rm(dir,{recursive:true,force:true});});
 const connection=join(dir,"connection.json");await fs.writeFile(connection,JSON.stringify({appId:"app_one",url:origin+"/updates/app_one",channel:"qa",runtimeVersion:"1",certificate:"public-cert",keyId:"qa"}));
 const calls:string[][]=[],messages:string[]=[],runtimeDirectory=join(dir,"runner"),binding={schemaVersion:1,origin,appId:"app_one",runnerId};
 const runtime={root:new URL("../../../",import.meta.url).pathname,nodePath:process.execPath,wranglerEntry:"/unused",dockerPath:"/usr/bin/docker",supervisorMain:new URL("../../../scripts/local-runner/supervisor.mjs",import.meta.url).pathname};
 const io={choose:async()=>"npm-registry",readPublic:async()=>image,readSecret:async()=>token,confirm:async()=>false,notice:(s:string)=>messages.push(s),report:()=>{}};
 let presenceId=runnerId;const deps={dockerHost:"unix://"+socket,run:async(_exe:string,args:string[])=>{calls.push(args);return {exitCode:0,stdout:args.includes("inspect")?image+"\n":args.includes("--version")?"10.9.8\n":args.includes("-p")?"24.19.0\n":"27.0.0\n"};},fetch:async(url:string,init:RequestInit)=>{assert.equal(url,origin+"/api/runner/presence");assert.equal(init.method,"POST");assert.equal(new Headers(init.headers).get("authorization"),"Bearer "+token);return Response.json({runnerId:presenceId,lastSeenAt:Date.now()});}};
 return {dir,connection,runtimeDirectory,binding,runtime,io,deps,calls,messages,setPresenceId:(s:string)=>{presenceId=s;}};
}
test("two_apps_produce_disjoint_private_paths_and_preserve_existing_state",async t=>{
 const api=await import(modulePath),f=await fixture(t),g=await fixture(t);g.binding.appId="app_two";await fs.writeFile(g.connection,JSON.stringify({...JSON.parse(await fs.readFile(g.connection,"utf8")),appId:"app_two",url:origin+"/updates/app_two"}));
 const a=await api.configureRunner(f.binding,f.connection,f.runtimeDirectory,f.io,f.runtime,new AbortController().signal,f.deps),b=await api.configureRunner(g.binding,g.connection,g.runtimeDirectory,g.io,g.runtime,new AbortController().signal,g.deps);
 assert.notEqual(a.runnerPath,b.runnerPath);assert.equal((await fs.stat(a.runnerPath)).mode&0o777,0o600);assert.equal((await fs.stat(f.runtimeDirectory)).mode&0o777,0o700);
 assert.equal(JSON.parse(await fs.readFile(a.servicePath,"utf8")).pollIntervalMs,30000);assert.equal(JSON.parse(await fs.readFile(a.runnerPath,"utf8")).publicationRecovery,"remote-checkpoint");assert.ok(!f.messages.join().includes(token));assert.ok(!JSON.stringify(f.calls).includes(token));
 for(const name of ["fatal-stop","recovery/old-journal.json"]){await fs.writeFile(join(f.runtimeDirectory,name),"preserve",{mode:0o600});}
 const before=await fs.readFile(a.runnerPath);await assert.rejects(api.configureRunner(f.binding,f.connection,f.runtimeDirectory,f.io,f.runtime,new AbortController().signal,f.deps));assert.deepEqual(await fs.readFile(a.runnerPath),before);assert.equal(await fs.readFile(join(f.runtimeDirectory,"fatal-stop"),"utf8"),"preserve");assert.equal(await fs.readFile(join(f.runtimeDirectory,"recovery/old-journal.json"),"utf8"),"preserve");
});
test("mixed_app_origin_or_runner_token_rejects_before_claim",async t=>{
 const api=await import(modulePath);
 for(const kind of ["app","origin","token"]){const f=await fixture(t);if(kind==="app")f.binding.appId="another_app";if(kind==="origin")f.binding.origin="https://other.example.com";if(kind==="token")f.io.readSecret=async()=>token.replace("11111111","22222222");let requests=0;
 await assert.rejects(api.configureRunner(f.binding,f.connection,f.runtimeDirectory,f.io,f.runtime,new AbortController().signal,{...f.deps,fetch:async()=>{requests++;assert.fail("no request on mismatch");}}));assert.equal(requests,0);assert.ok(!f.calls.some(a=>a.includes("--once")));
 }
});
test("resume_checks_fingerprints_and_presence_is_not_a_job_success",async t=>{
 const api=await import(modulePath),f=await fixture(t),signal=new AbortController().signal,paths=await api.configureRunner(f.binding,f.connection,f.runtimeDirectory,f.io,f.runtime,signal,f.deps);
 await api.verifyRunnerBinding(paths,signal,f.deps);assert.ok(!f.calls.some(a=>a.includes("--once")));assert.ok(!f.messages.some(s=>s.includes("succeeded")));
 f.setPresenceId("runner_22222222-2222-4222-8222-222222222222");await assert.rejects(api.verifyRunnerBinding(paths,signal,f.deps));f.setPresenceId(runnerId);
 await fs.appendFile(paths.runnerPath," ");await assert.rejects(api.verifyRunnerBinding(paths,signal,f.deps));
});
test("remote_docker_and_missing_disk_block_without_token_input",async t=>{
 const api=await import(modulePath),f=await fixture(t);let reads=0;f.io.readSecret=async()=>{reads++;return token;};
 await assert.rejects(api.configureRunner(f.binding,f.connection,f.runtimeDirectory,f.io,f.runtime,new AbortController().signal,{...f.deps,dockerHost:"tcp://remote:2375"}));assert.equal(reads,0);
 await assert.rejects(api.configureRunner(f.binding,f.connection,f.runtimeDirectory,f.io,f.runtime,new AbortController().signal,{...f.deps,availableBytes:async()=>0n}));assert.equal(reads,0);
});
