import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import events from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { parseNativeCommand, runNativeCommand, nativeCommandFailure } from "../dist/native-command.js";
import type { NativeCommandDependencies } from "../dist/native-command.js";
import type { NativeClient, NativeArtifact } from "../dist/native-client.js";

const config={origin:"https://native.invalid",token:"native_runner_test."+"a".repeat(43),appId:"app_test",platform:"android" as const};
const output:NativeArtifact={fileName:"native_job_test.apk",sha256:"a".repeat(64),byteLength:1,appIdentifier:"test.app",platform:"android",signerFingerprint:"b".repeat(64)};
const deps=(overrides:Partial<NativeCommandDependencies<typeof config>>={}):NativeCommandDependencies<typeof config>=>({readConfig:async()=>config,checkRecovery:async()=>{},runDaemon:async()=>{},runJob:async()=>output,...overrides});
const daemonArgs=["--config","/private/native.json","--daemon"];
const jobArgs=["--config","/private/native.json","--job","native_job_test"];

test("help and invalid invocation perform no config or network I/O",async()=>{
 let reads=0;const d=deps({readConfig:async()=>{reads++;throw new Error("PRIVATE_CONFIG");}});
 assert.deepEqual(await runNativeCommand(["--help"],d),{state:"help"});assert.equal(reads,0);
 for(const input of [[],["--help","--daemon"],["--config","/p","--daemon","--job","abc"],["--config","/p","--daemon","--daemon"],["--config","/p","--job","abc\n"],["--config","/p\0secret","--daemon"],["--config","/p","--config","/p","--daemon"],["--config","/p","--config","/q","--job","abc"],["--config","--daemon"],["--config","/p","--daemon","--password","PRIVATE"]]){
  await assert.rejects(runNativeCommand(input,d),/^Error: INVALID_NATIVE_CONFIG$/);
 }
 assert.equal(reads,0);
});
test("parser preserves explicit job IDs and bounds config entries before I/O",()=>{
 assert.deepEqual(parseNativeCommand(["--job","job_fixture","--config","/p"]),{mode:"job",paths:["/p"],jobId:"job_fixture"});
 const paths=Array.from({length:32},(_,n)=>["--config",`/p${n}`]).flat();assert.equal(parseNativeCommand([...paths,"--daemon"]).paths?.length,32);
 assert.throws(()=>parseNativeCommand([...paths,"--config","/overflow","--daemon"]),/INVALID_NATIVE_CONFIG/);
});
test("pre-aborted session reads no config or controller state",async()=>{
 const stop=new AbortController();stop.abort("PRIVATE");let reads=0;
 await assert.rejects(runNativeCommand(daemonArgs,deps({readConfig:async()=>{reads++;return config;}}),stop.signal),/NATIVE_CANCELLED/);assert.equal(reads,0);
});
test("stop during config read prevents later config reads, presence and job dispatch",async()=>{
 const stop=new AbortController();let reads=0,runs=0;
 const d=deps({readConfig:async()=>{reads++;stop.abort();return config;},runDaemon:async()=>{runs++;}});
 await assert.rejects(runNativeCommand(["--config","/a","--config","/b","--daemon"],d,stop.signal),/NATIVE_CANCELLED/);assert.equal(reads,1);assert.equal(runs,0);
});
test("immutable parsed args cannot be replaced while a configuration is loading",async()=>{
 const args=["--config","/one","--config","/two","--daemon"];const seen:string[]=[];
 await runNativeCommand(args,deps({readConfig:async path=>{seen.push(path);args[3]="/PRIVATE";return {...config,appId:seen.length===1?"app_test":"app_other"};}}));
 assert.deepEqual(seen,["/one","/two"]);
});
test("session lifetime is closed after normal daemon return and removes the parent listener",async()=>{
 const parent=new AbortController();const before=events.getEventListeners(parent.signal,"abort").length;let client!:NativeClient;
 const result=await runNativeCommand(daemonArgs,deps({runDaemon:async entries=>{client=entries[0]!.client;}}),parent.signal);
 assert.deepEqual(result,{state:"stopped",code:"NATIVE_DAEMON_STOPPED"});await assert.rejects(client.presence(),/NATIVE_CANCELLED/);
 assert.equal(events.getEventListeners(parent.signal,"abort").length,before);assert.equal(parent.signal.aborted,false);
});
test("fatal daemon exit closes all captured clients and never restarts work",async()=>{
 let clients:NativeClient[]=[];let runs=0;const parent=new AbortController();
 await assert.rejects(runNativeCommand(["--config","/a","--config","/b","--daemon"],deps({runDaemon:async entries=>{runs++;clients=entries.map(e=>e.client);throw new Error("NATIVE_COMPLETION_UNKNOWN");}}),parent.signal),/NATIVE_COMPLETION_UNKNOWN/);
 for(const c of clients)await assert.rejects(c.pending(),/NATIVE_CANCELLED/);assert.equal(runs,1);assert.equal(events.getEventListeners(parent.signal,"abort").length,0);
});
test("failure projection retains completion uncertainty even after operator shutdown",()=>{
 const stop=new AbortController();stop.abort("PRIVATE_REASON");
 assert.deepEqual(nativeCommandFailure(new Error("NATIVE_COMPLETION_UNKNOWN"),stop.signal),{state:"completion_unknown",code:"NATIVE_COMPLETION_UNKNOWN",exitCode:1});
 assert.deepEqual(nativeCommandFailure(new Error("NATIVE_COMPLETION_RECONCILIATION_REQUIRED"),stop.signal),{state:"attention",code:"NATIVE_COMPLETION_RECONCILIATION_REQUIRED",exitCode:1});
 assert.deepEqual(nativeCommandFailure(new Error("PRIVATE_TOKEN /private/path"),stop.signal),{state:"stopped",code:"NATIVE_CANCELLED",exitCode:0});
 assert.deepEqual(nativeCommandFailure(new Error("PRIVATE_TOKEN")),{state:"failed",code:"NATIVE_BUILD_FAILED",exitCode:1});
 assert.equal(nativeCommandFailure(new Error("INVALID_NATIVE_CONFIG")).exitCode,2);
});
async function host(t: TestContext, response:(path:string,res:import("node:http").ServerResponse)=>void){
 const paths:string[]=[];const server=createServer((req,res)=>{paths.push(req.url!);req.resume();response(req.url!,res);});await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});return {origin:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,paths,server};
}
test("real HTTP stop during initial presence prevents runJob and returns a stopped classification",async t=>{
 let arrived!:()=>void;const arrival=new Promise<void>(r=>{arrived=r;});const h=await host(t,()=>arrived());const stop=new AbortController();let jobs=0;
 const result=runNativeCommand(jobArgs,deps({readConfig:async()=>({...config,origin:h.origin}),runJob:async()=>{jobs++;return output;}}),stop.signal).then(()=>({code:"SUCCESS"}),e=>nativeCommandFailure(e,stop.signal));
 await arrival;stop.abort();const state=await Promise.race([result,delay(250).then(()=>({code:"HUNG"}))]);h.server.closeAllConnections();await result;
 assert.equal(state.code,"NATIVE_CANCELLED");assert.equal(jobs,0);assert.deepEqual(h.paths,["/api/native-runner/presence"]);
});
test("job dispatch receives shutdown-bound real client even when controller omits the per-call signal",async t=>{
 let grantReached!:()=>void;const grantArrival=new Promise<void>(r=>{grantReached=r;});
 const h=await host(t,(path,res)=>{if(path.endsWith("presence")){res.setHeader("content-type","application/json");res.end(JSON.stringify({runnerId:"native_runner_test",lastSeenAt:Date.now()}));}else grantReached();});
 const stop=new AbortController();let completions=0;
 const result=runNativeCommand(jobArgs,deps({readConfig:async()=>({...config,origin:h.origin}),runJob:async(_cfg,client,jobId)=>{
   await client.credentials({jobId,appId:"app_test",platform:"android",runnerId:"native_runner_test",attemptId:"attempt_test",credentialEpoch:1,fence:1,expiresAt:Date.now()+120000});completions++;return output;
 }}),stop.signal).then(()=>"SUCCESS",e=>nativeCommandFailure(e,stop.signal).code);
 await grantArrival;stop.abort();assert.equal(await Promise.race([result,delay(250).then(()=>"HUNG")]),"NATIVE_CANCELLED");h.server.closeAllConnections();await result;
 assert.equal(completions,0);assert.equal(h.paths.length,2);
});
test("confirmed build success is retained when shutdown follows confirmation",async t=>{
 const h=await host(t,(_path,res)=>res.end(JSON.stringify({runnerId:"native_runner_test",lastSeenAt:Date.now()})));const stop=new AbortController();
 const result=await runNativeCommand(jobArgs,deps({readConfig:async()=>({...config,origin:h.origin}),runJob:async()=>{stop.abort();return output;}}),stop.signal);
 assert.equal(result.state,"succeeded");assert.equal("sha256" in result&&result.sha256,output.sha256);
});
test("native executable and root shortcut both point to the existing native entry, not OTA",async()=>{
 const {readFile}=await import("node:fs/promises");
 const pkg=JSON.parse(await readFile(new URL("../package.json",import.meta.url),"utf8"));
 const root=JSON.parse(await readFile(new URL("../../../package.json",import.meta.url),"utf8"));
 assert.equal(pkg.bin["flora-native-runner"],"./dist/native-main.js");
 assert.equal(pkg.bin["flora-ota-runner"],"./dist/main.js");
 assert.equal(root.scripts["flora:native"],"node packages/ota-runner/dist/native-main.js");
});
test("startup checks recovery for every app before dispatch and blocks uncertain completion",async()=>{
 const checked:string[]=[];let runs=0;
 const d={...deps({readConfig:async path=>({...config,appId:path==="/a"?"app_one":"app_two"}),runDaemon:async()=>{runs++;}}),
   checkRecovery:async(c:typeof config)=>{checked.push(c.appId);if(c.appId==="app_two")throw new Error("NATIVE_COMPLETION_RECONCILIATION_REQUIRED");}};
 await assert.rejects(runNativeCommand(["--config","/a","--config","/b","--daemon"],d),/NATIVE_COMPLETION_RECONCILIATION_REQUIRED/);
 assert.deepEqual(checked,["app_one","app_two"]);assert.equal(runs,0);
});
test("single-job mode cannot bypass a recovery gate or send initial presence",async t=>{
 const h=await host(t,(_path,res)=>res.end(JSON.stringify({runnerId:"native_runner_test",lastSeenAt:Date.now()})));let jobs=0;
 const d={...deps({readConfig:async()=>({...config,origin:h.origin}),runJob:async()=>{jobs++;return output;}}),checkRecovery:async()=>{throw new Error("NATIVE_COMPLETION_RECONCILIATION_REQUIRED");}};
 await assert.rejects(runNativeCommand(jobArgs,d),/NATIVE_COMPLETION_RECONCILIATION_REQUIRED/);assert.equal(jobs,0);assert.deepEqual(h.paths,[]);
});
test("shutdown during recovery check stops the next app check and controller dispatch",async()=>{
 const stop=new AbortController();let checked=0,runs=0;
 const d={...deps({runDaemon:async()=>{runs++;}}),checkRecovery:async()=>{checked++;stop.abort();}};
 await assert.rejects(runNativeCommand(["--config","/a","--config","/b","--daemon"],d,stop.signal),/NATIVE_CANCELLED/);
 assert.equal(checked,1);assert.equal(runs,0);
});
test("single job rechecks recovery after asynchronous presence before dispatch",async t=>{
 const h=await host(t,(_path,res)=>res.end(JSON.stringify({runnerId:"native_runner_test",lastSeenAt:Date.now()})));let checks=0,jobs=0;
 const d=deps({readConfig:async()=>({...config,origin:h.origin}),checkRecovery:async()=>{if(++checks===2)throw new Error("NATIVE_COMPLETION_RECONCILIATION_REQUIRED");},runJob:async()=>{jobs++;return output;}});
 await assert.rejects(runNativeCommand(jobArgs,d),/NATIVE_COMPLETION_RECONCILIATION_REQUIRED/);
 assert.equal(checks,2);assert.equal(jobs,0);assert.deepEqual(h.paths,["/api/native-runner/presence"]);
});
