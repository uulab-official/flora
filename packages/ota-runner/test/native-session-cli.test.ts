import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, mkdir, mkdtemp, realpath, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entry=fileURLToPath(new URL("../dist/native-main.js",import.meta.url));
async function start(t:TestContext,args:string[]) {
  const child=spawn(process.execPath,[entry,...args],{stdio:["ignore","pipe","pipe"]});
  let stdout="",stderr="";
  child.stdout.on("data",chunk=>{stdout+=chunk;});child.stderr.on("data",chunk=>{stderr+=chunk;});
  const ended=new Promise<{code:number|null;signal:NodeJS.Signals|null;stdout:string;stderr:string}>((resolve,reject)=>{
    child.once("error",reject);child.once("close",(code,signal)=>resolve({code,signal,stdout,stderr}));
  });
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");await ended.catch(()=>{});});
  return {child,ended};
}
test("actual native CLI help and malformed invocation perform no configuration reads",{timeout:10000},async t=>{
  const help=await start(t,["--help"]);const output=await help.ended;assert.equal(output.code,0);assert.match(output.stdout,/--daemon/);assert.match(output.stdout,/--job/);assert.match(output.stdout,/--help/);
  const invalid=await start(t,["--config","/PRIVATE_NONEXISTENT","--daemon","--job","job_fixture"]);const failure=await invalid.ended;
  assert.equal(failure.code,2);assert.equal(failure.stdout,"");assert.ok(!failure.stderr.includes("PRIVATE_NONEXISTENT"));assert.match(failure.stderr,/INVALID_NATIVE_CONFIG/);
});
for(const signal of ["SIGINT","SIGTERM"] as const)for(const mode of ["single-presence","daemon-presence","daemon-pending"] as const){
  test(`actual native CLI ${signal} ends ${mode} without starting compilation`,{skip:process.platform==="win32",timeout:12000},async t=>{
    const root=await realpath(await mkdtemp(join(tmpdir(),"flora-session-cli-")));await chmod(root,0o700);t.after(()=>rm(root,{recursive:true,force:true}));
    const paths:string[]=[];let notify!:()=>void;const requestArrived=new Promise<void>(r=>{notify=r;});
    const server=createServer((req,res)=>{
      paths.push(req.url!);req.resume();
      if(mode==="daemon-pending"&&req.url?.endsWith("presence"))res.end(JSON.stringify({runnerId:"native_runner_fixture",lastSeenAt:Date.now()}));
      else notify();
    });
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
    const configPath=join(root,"native.json"),tool=await realpath(process.execPath);
    // Valid private configuration; the harmless executable placeholders are never
    // invoked. These tests stop before source validation, compiler or signing.
    const config={origin:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,token:"native_runner_fixture."+"a".repeat(43),appId:"app_fixture",platform:"android",sourceDirectory:root,artifactDirectory:join(root,"artifacts"),expectedCertificateSha256:"b".repeat(64),tools:{git:tool,keytool:tool,apksigner:tool,aapt2:tool,zipalign:tool},android:{directory:"android",apkPath:"unused.apk"}};
    await writeFile(configPath,JSON.stringify(config),{mode:0o600});
    const run=await start(t,["--config",configPath,...(mode==="single-presence"?["--job","native_job_fixture"]:["--daemon"])]);
    await Promise.race([requestArrived,run.ended.then(value=>{throw new Error("CLI_EXITED_BEFORE_REQUEST: "+JSON.stringify(value));})]);
    const started=performance.now();assert.equal(run.child.kill(signal),true);const output=await run.ended;
    assert.ok(performance.now()-started<3000,"operator stop must not await the 20-second HTTP deadline");
    assert.equal(output.code,0);assert.equal(output.signal,null);assert.deepEqual(JSON.parse(output.stdout),{state:"stopped",code:"NATIVE_CANCELLED"});
    assert.ok(!output.stderr.includes(config.token));assert.ok(!output.stdout.includes(configPath));
    assert.deepEqual(paths,mode==="daemon-pending"?["/api/native-runner/presence","/api/native-runner/pending"]:["/api/native-runner/presence"]);
  });
}

for (const recovery of ["unconfirmed-receipt", "pending-file"] as const) {
  test(`actual single-job CLI preserves ${recovery} and makes zero HTTP requests`,{skip:process.platform==="win32",timeout:12000},async t=>{
    const root=await realpath(await mkdtemp(join(tmpdir(),"flora-session-recovery-")));await chmod(root,0o700);t.after(()=>rm(root,{recursive:true,force:true}));
    let requests=0;const server=createServer((req,res)=>{requests++;req.resume();res.end("{}");});await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
    t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
    const artifactDirectory=join(root,"artifacts");await mkdir(artifactDirectory,{mode:0o700});
    const pending=join(artifactDirectory,".pending");if(recovery==="pending-file")await mkdir(pending,{mode:0o700});
    const marker=recovery==="pending-file"?join(pending,"native_job_prior.apk"):join(artifactDirectory,"native_job_prior.apk.receipt.json");
    const bytes=Buffer.from(recovery==="pending-file"?"SYNTHETIC_UNCONFIRMED_BYTES":JSON.stringify({completionConfirmed:false}));await writeFile(marker,bytes,{mode:0o600});
    const tool=await realpath(process.execPath),configPath=join(root,"native.json");
    await writeFile(configPath,JSON.stringify({origin:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,token:"native_runner_fixture."+"a".repeat(43),appId:"app_fixture",platform:"android",sourceDirectory:root,artifactDirectory,expectedCertificateSha256:"b".repeat(64),tools:{git:tool,keytool:tool,apksigner:tool,aapt2:tool,zipalign:tool},android:{directory:"android",apkPath:"unused.apk"}}),{mode:0o600});
    const run=await start(t,["--config",configPath,"--job","native_job_next"]);const output=await run.ended;
    assert.equal(output.code,1);assert.equal(output.stdout,"");assert.deepEqual(JSON.parse(output.stderr),{state:"attention",code:"NATIVE_COMPLETION_RECONCILIATION_REQUIRED"});assert.equal(requests,0);assert.deepEqual(await readFile(marker),bytes);
  });
}
