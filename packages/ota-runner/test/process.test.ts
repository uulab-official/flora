import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {trustedProcess} from "../dist/process.js";
import * as processModule from "../dist/process.js";
test("cancelled trusted child exits before control returns",async t=>{
 const root=await mkdtemp(join(tmpdir(),"flora-process-"));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,"pid"),controller=new AbortController();
 const operation=trustedProcess(process.execPath,["-e",`require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)`,path],{signal:controller.signal,timeoutMs:5000});
 const observed=operation.catch(error=>error);let pid=0;for(let i=0;i<100&&!pid;i++){try{pid=Number(await readFile(path,"utf8"));}catch{}if(!pid)await new Promise(r=>setTimeout(r,10));}assert.ok(pid);controller.abort();assert.equal((await observed).message,"EXECUTION_FAILED");assert.throws(()=>process.kill(pid,0),(error:unknown)=>(error as NodeJS.ErrnoException).code==="ESRCH");
});
test("untrusted output and execution duration are bounded without echoing diagnostics",async()=>{
 await assert.rejects(trustedProcess(process.execPath,["-e","process.stderr.write('secret'.repeat(10000));setInterval(()=>{},1000)"],{maxBytes:1000}),/^Error: EXECUTION_FAILED$/);
 await assert.rejects(trustedProcess(process.execPath,["-e","setInterval(()=>{},1000)"],{timeoutMs:30}),/^Error: EXECUTION_FAILED$/);
});
test("actual npm loads distinct controlled empty user and global configuration",async t=>{
 const root=await mkdtemp(join(tmpdir(),"flora-npm-configuration-"));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(join(root,"npm-user.rc"),"",{mode:0o444});await writeFile(join(root,"npm-global.rc"),"",{mode:0o444});
 const api=processModule as unknown as {npmConfigurationEnvironment(root:string):Record<string,string>;processEnvironment(extra:Record<string,string>):Record<string,string>};assert.equal(typeof api.npmConfigurationEnvironment,"function");const config=api.npmConfigurationEnvironment(root);assert.notEqual(config.npm_config_userconfig,config.npm_config_globalconfig);
 const options={cwd:root,env:api.processEnvironment(config)};
 const version=await trustedProcess("npm",["--version"],options);assert.match(version.trim(),/^\d+\.\d+\.\d+$/);
 for(const key of ["userconfig","globalconfig"]){const actual=await trustedProcess("npm",["config","get",key],options);assert.equal(actual.trim(),config["npm_config_"+key]);}
});
test("safe child diagnostics classify npm failure while excluding arbitrary stderr and fake secret markers",async()=>{
 const api=processModule as unknown as {trustedProcess:typeof trustedProcess;diagnosticCode(error:unknown):string};
 let caught:unknown;try{await api.trustedProcess(process.execPath,["-e","process.stderr.write('npm error code ERESOLVE\\nprivate-source-and-token\\n');process.exitCode=1"],{diagnostics:"npm"} as never);}catch(error){caught=error;}
 assert.equal(typeof api.diagnosticCode,"function");assert.equal(api.diagnosticCode(caught),"NPM_ERESOLVE");assert.ok(!JSON.stringify(caught).includes("private-source-and-token"));
});
test("PNPM timeout preserves bounded import progress without retaining source paths or credentials",async()=>{
 const api=processModule as any;let caught;try{await api.trustedProcess(process.execPath,["-e","process.stdout.write('Progress: resolved 675, reused 675, downloaded 0, added 420\\nprivate-source-and-token\\n');setInterval(()=>{},1000)"],{diagnostics:"pnpm",timeoutMs:2000});}catch(error){caught=error;}
 assert.equal(api.diagnosticCode(caught),"PNPM_TIMEOUT_IMPORTING");assert.deepEqual((caught as any).pnpmProgress,{resolved:675,reused:675,downloaded:0,added:420,done:false});assert.ok(!JSON.stringify(caught).includes("private-source-and-token"));
});
test("PNPM timeout distinguishes completed package imports and rejects fabricated or unbounded progress",async()=>{
 const api=processModule as any;for(const [line,code,progress]of [["Progress: resolved 675, reused 675, downloaded 0, added 675, done\n","PNPM_TIMEOUT_AFTER_IMPORT",true],["Progress: resolved 999999, reused 1, downloaded 0, added 1\nprivate-source-and-token","PROCESS_TIMEOUT",false]]){let caught;try{await api.trustedProcess(process.execPath,["-e",`process.stdout.write(${JSON.stringify(line)});setInterval(()=>{},1000)`],{diagnostics:"pnpm",timeoutMs:2000});}catch(error){caught=error;}assert.equal(api.diagnosticCode(caught),code);assert.equal(!!(caught as any).pnpmProgress,progress);assert.ok(!JSON.stringify(caught).includes("private-source-and-token"));}
});
test("container timeout preserves only fixed stage markers and rejects paths, extra fields and foreign stages",async()=>{
 const api=processModule as any;
 const lines=[
  'FLORA_DIAGNOSTIC {"diagnostic":true,"stage":"cache-copy"}',
  'FLORA_DIAGNOSTIC {"diagnostic":true,"stage":"private-source-and-token"}',
  'FLORA_DIAGNOSTIC {"diagnostic":true,"stage":"npm-install","path":"private-source-and-token"}',
  'FLORA_DIAGNOSTIC {"diagnostic":true,"stage":"npm-install","pnpmProgress":{"resolved":1,"reused":1,"downloaded":0,"added":1,"done":true}}',
 ];
 let caught;try{await api.trustedProcess(process.execPath,["-e",`process.stderr.write(${JSON.stringify(lines.join("\n")+"\n")});setInterval(()=>{},1000)`],{diagnostics:"container",timeoutMs:2000});}catch(error){caught=error;}
 assert.equal(api.diagnosticCode(caught),"PROCESS_TIMEOUT");assert.deepEqual((caught as any).containerDiagnostic,{diagnostic:true,stage:"cache-copy"});assert.ok(!JSON.stringify(caught).includes("private-source-and-token"));
});
test("PNPM reporter diagnostics accept stderr progress and only allowlisted failure codes",async()=>{
 const api=processModule as any;let caught;try{await api.trustedProcess(process.execPath,["-e","process.stderr.write('Progress: resolved 675, reused 607, downloaded 0, added 607\\nprivate-source-and-token\\n');setInterval(()=>{},1000)"],{diagnostics:"pnpm",timeoutMs:2000});}catch(error){caught=error;}assert.equal(api.diagnosticCode(caught),"PNPM_TIMEOUT_IMPORTING");assert.deepEqual((caught as any).pnpmProgress,{resolved:675,reused:607,downloaded:0,added:607,done:false});
 for(const [input,expected]of [["ERR_PNPM_NO_OFFLINE_TARBALL private-source-and-token\n","ERR_PNPM_NO_OFFLINE_TARBALL"],["ERR_PNPM_PRIVATE_SOURCE_AND_TOKEN\n","EXECUTION_FAILED"]]){try{await api.trustedProcess(process.execPath,["-e",`process.stderr.write(${JSON.stringify(input)});process.exitCode=1`],{diagnostics:"pnpm"});}catch(error){caught=error;}assert.equal(api.diagnosticCode(caught),expected);assert.ok(!JSON.stringify(caught).includes("private-source-and-token"));}
});
