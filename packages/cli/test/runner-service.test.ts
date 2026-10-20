import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runCli} from '../dist/main.js';
// Include the dependency-free Linux fixture suite in the normal pnpm check
// discovery, while keeping it runnable inside a networkless Node container.
await import(new URL('../../../scripts/local-runner/systemd.test.mjs',import.meta.url).href);
function capture(){const out:string[]=[],err:string[]=[];return{out,err,io:{stdout:(s:string)=>{out.push(s);},stderr:(s:string)=>{err.push(s);},readFile:async()=>new Uint8Array()}};}
test('runner service-config parser rejects missing, duplicate, relative and unknown options without writing',async()=>{
 for(const args of [[],['service-config'],['service-config','--service','relative.json'],['service-config','--service','/absolute','--service','/other'],['service-config','--service','/absolute','--start'],['service-config','--token','private-token']]){
  const c=capture();assert.equal(await runCli(['runner',...args],c.io),2);assert.equal(c.out.length,0);assert.ok(!c.err.join('').includes('private-token'));
 }
});
test('runner help describes configuration-only generation and root help exposes the command',async()=>{
 const c=capture();assert.equal(await runCli(['runner','--help'],c.io),0);assert.match(c.out.join(''),/Does not install, start, contact Flora/);
 const root=capture();assert.equal(await runCli(['--help'],root.io),0);assert.match(root.out.join(''),/flora runner service-config --service/);
});
test('runner service-config end-to-end returns an uninstalled private unit without printing token',{skip:process.platform==='win32'||process.getuid?.()===0},async t=>{
 const dir=await fs.mkdtemp(join(await fs.realpath(tmpdir()),'flora-cli-systemd-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.chmod(dir,0o700);await fs.mkdir(join(dir,'scratch'),{mode:0o700});const app=join(dir,'app.json'),service=join(dir,'service.json');
 await fs.writeFile(app,'{"token":"synthetic-private-token"}',{mode:0o600});
 await fs.writeFile(service,JSON.stringify({runtimeDirectory:dir,nodePath:await fs.realpath(process.execPath),runnerMain:await fs.realpath(process.execPath),runnerConfigs:[app],path:'/usr/bin:/bin',limaHome:dir,dockerHost:'unix:///run/user/1000/docker.sock',pollIntervalMs:30000}),{mode:0o600});
 const c=capture();assert.equal(await runCli(['runner','service-config','--service',service],c.io),0);assert.equal(c.err.length,0);
 const result=JSON.parse(c.out.join(''));assert.equal(result.installed,false);assert.equal(result.started,false);assert.equal((await fs.stat(result.file)).mode&0o777,0o600);assert.ok(!c.out.join('').includes('synthetic-private-token'));
});
test('filesystem and invalid-config failures print fixed codes without paths or raw secrets',async()=>{
 const c=capture();assert.equal(await runCli(['runner','service-config','--service','/missing/private-provider-secret.json'],c.io),1);assert.equal(c.out.length,0);assert.ok(!c.err.join('').includes('private-provider-secret'));assert.match(c.err.join(''),/RUNNER_SERVICE_(CONFIG_FAILED|HOST_UNSUPPORTED)/);
});
