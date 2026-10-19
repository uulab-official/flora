import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,lstat,chmod,symlink,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import type {Server} from 'node:http';

// Unix sockets and POSIX owner/mode checks are scoped to macOS and Linux.
const posixTest=process.platform==='win32'?test.skip:test;

// Removing validation, permitting network Docker hosts, or trusting failed probes
// must change these consumer-visible readiness results.
async function inspect(path:string, probes:Record<string,unknown>={}) {
  const url=new URL('../src/runner-doctor.ts',import.meta.url).href;
  const mod=await import(url).catch(()=>({}));
  const fn=Reflect.get(mod,'inspectRunnerService');
  assert.equal(typeof fn,'function','read-only Runner doctor must be implemented');
  return fn(path,probes);
}
const plenty=async()=>10n*1024n**3n;
async function fixture(run:(f:{root:string;service:string;runner:string;socket:string;server:Server;config:Record<string,unknown>;app:Record<string,unknown>})=>Promise<void>,hang=false){
  const root=await realpath(await mkdtemp(join(tmpdir(),'runner-doctor-')));await chmod(root,0o700);
  const socket=join(root,'docker.sock'),server=createServer((_request,response)=>{if(!hang)response.end('OK');});
  await new Promise<void>(resolve=>server.listen(socket,resolve));await chmod(socket,0o600);
  const service=join(root,'service.json'),runner=join(root,'runner.json');
  const config={runtimeDirectory:root,nodePath:process.execPath,runnerMain:'/trusted/runner.js',runnerConfigs:[runner],path:'/usr/bin:/bin',limaHome:root,dockerHost:'unix://'+socket,pollIntervalMs:30000};
  const app={origin:'https://private.invalid',token:'runner_private.'+'a'.repeat(43),dockerImage:'sha256:'+'a'.repeat(64)};
  await mkdir(join(root,'scratch'),{mode:0o700});
  await writeFile(service,JSON.stringify(config),{mode:0o600});await writeFile(runner,JSON.stringify(app),{mode:0o600});
  try{await run({root,service,runner,socket,server,config,app});}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
}
posixTest('valid private configurations verify local readiness without network or mutation',async()=>fixture(async f=>{
  const before=await Promise.all([f.service,f.runner].map(async p=>({bytes:await readFile(p),stat:await lstat(p)})));
  const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('network forbidden');};
  let report;try{report=await inspect(f.service,{availableBytes:plenty});}finally{globalThis.fetch=oldFetch;}
  assert.equal(report.ready,true);assert.equal(report.readOnly,true);assert.equal(report.serverOnlineVerified,false);
  assert.equal(report.checks.docker,'available');assert.equal(report.checks.runners[0].recovery,'clear');assert.deepEqual(report.issues,[]);
  assert.ok(!JSON.stringify(report).includes(f.root));assert.ok(!JSON.stringify(report).includes('runner_private'));
  for(const [i,p] of [f.service,f.runner].entries()){assert.deepEqual(await readFile(p),before[i]!.bytes);const stat=await lstat(p);assert.equal(stat.mode,before[i]!.stat.mode);assert.equal(stat.mtimeMs,before[i]!.stat.mtimeMs);}
}));
test('relative and missing service paths fail closed without raw path errors',async()=>{
  for(const p of ['relative.json','/missing/private-secret/service.json']){const r=await inspect(p);assert.equal(r.ready,false);assert.equal(r.checks.serviceConfig,'invalid');assert.ok(!JSON.stringify(r).includes('private-secret'));}
});
posixTest('malformed service JSON is sanitized',async()=>fixture(async f=>{await writeFile(f.service,'private-secret invalid JSON');const r=await inspect(f.service);assert.equal(r.ready,false);assert.ok(!JSON.stringify(r).includes('private-secret'));}));
for(const target of ['service','runner'] as const){
  posixTest(`insecure ${target} file blocks readiness`,async()=>fixture(async f=>{await chmod(f[target],0o644);const r=await inspect(f.service,{availableBytes:plenty});assert.equal(r.ready,false);assert.ok(r.issues.some((v:{check:string})=>v.check===(target==='service'?'serviceConfig':'runnerConfig')));}));
  posixTest(`symlink ${target} file is rejected`,async()=>fixture(async f=>{const p=f[target],bytes=await readFile(p);await rm(p);await writeFile(p+'.real',bytes,{mode:0o600});await symlink(p+'.real',p);assert.equal((await inspect(f.service,{availableBytes:plenty})).ready,false);}));
}
posixTest('remote Docker hosts cannot cause a remote probe',async()=>fixture(async f=>{await writeFile(f.service,JSON.stringify({...f.config,dockerHost:'tcp://private.invalid:2375'}));const r=await inspect(f.service,{availableBytes:plenty,dockerPing:()=>assert.fail('remote probe forbidden')});assert.equal(r.ready,false);assert.equal(r.checks.serviceConfig,'invalid');}));
posixTest('invalid runner token is rejected without exposing it',async()=>fixture(async f=>{await writeFile(f.runner,JSON.stringify({...f.app,token:'private-secret'}));const r=await inspect(f.service,{availableBytes:plenty});assert.equal(r.checks.runners[0].config,'invalid');assert.equal(r.ready,false);assert.ok(!JSON.stringify(r).includes('private-secret'));}));
posixTest('disk low and unavailable are blocking, sanitized states',async()=>fixture(async f=>{
  const low=await inspect(f.service,{availableBytes:async()=>1n});assert.equal(low.checks.disk,'low');assert.equal(low.ready,false);
  const unknown=await inspect(f.service,{availableBytes:async()=>{throw Error('private-secret');}});assert.equal(unknown.checks.disk,'unavailable');assert.equal(unknown.ready,false);assert.ok(!JSON.stringify(unknown).includes('private-secret'));
}));
posixTest('unavailable local Docker socket fails closed',async()=>fixture(async f=>{await new Promise<void>(resolve=>f.server.close(()=>resolve()));const r=await inspect(f.service,{availableBytes:plenty});assert.equal(r.ready,false);assert.equal(r.checks.docker,'unavailable');}));
posixTest('hung local Docker request has a bounded deadline',async()=>fixture(async f=>{const started=Date.now(),r=await inspect(f.service,{availableBytes:plenty});assert.equal(r.ready,false);assert.equal(r.checks.docker,'timeout');assert.ok(Date.now()-started<5000);},true));
posixTest('fatal marker is preserved and blocks readiness without exposing its contents',async()=>fixture(async f=>{const p=join(f.root,'fatal-stop');await writeFile(p,'private-secret',{mode:0o600});const r=await inspect(f.service,{availableBytes:plenty});assert.equal(r.checks.fatalStop,'present');assert.equal(r.ready,false);assert.equal(await readFile(p,'utf8'),'private-secret');assert.ok(!JSON.stringify(r).includes('private-secret'));}));
posixTest('pending recovery journals remain untouched and block readiness',async()=>fixture(async f=>{const dir=join(f.root,'recovery');await mkdir(dir,{mode:0o700});const p=join(dir,'private-secret.json');await writeFile(p,'private-secret',{mode:0o600});const r=await inspect(f.service,{availableBytes:plenty});assert.equal(r.checks.runners[0].recovery,'pending');assert.equal(r.ready,false);assert.equal(await readFile(p,'utf8'),'private-secret');assert.ok(!JSON.stringify(r).includes('private-secret'));}));
posixTest('unsafe recovery directory cannot be reported clear',async()=>fixture(async f=>{await mkdir(join(f.root,'recovery'),{mode:0o755});const r=await inspect(f.service,{availableBytes:plenty});assert.equal(r.checks.runners[0].recovery,'unknown');assert.equal(r.ready,false);}));
posixTest('non-journal unexpected recovery entries fail unknown',async()=>fixture(async f=>{const dir=join(f.root,'recovery');await mkdir(dir,{mode:0o700});await writeFile(join(dir,'unexpected.tmp'),'secret',{mode:0o600});const r=await inspect(f.service,{availableBytes:plenty});assert.equal(r.checks.runners[0].recovery,'unknown');assert.equal(r.ready,false);}));

for(const [status,body] of [[200,'unrecognized'],[200,'x'.repeat(10000)],[302,'OK'],[500,'OK']] as const){
  posixTest(`Docker HTTP status ${status} and invalid response length ${body.length} cannot verify connectivity`,async()=>fixture(async f=>{f.server.removeAllListeners('request');f.server.on('request',(req,res)=>{assert.equal(req.method,'GET');assert.equal(req.url,'/_ping');res.writeHead(status);res.end(body);});const r=await inspect(f.service,{availableBytes:plenty});assert.equal(r.checks.docker,'unavailable');assert.equal(r.ready,false);}));
}
posixTest('an injected hung Docker probe still has a total deadline',async()=>fixture(async f=>{const start=Date.now();const r=await inspect(f.service,{availableBytes:plenty,dockerPing:()=>new Promise(()=>{})});assert.equal(r.checks.docker,'timeout');assert.ok(Date.now()-start<5000);}));
posixTest('oversized private service config is rejected without retaining contents',async()=>fixture(async f=>{await writeFile(f.service,'x'.repeat(20000));const r=await inspect(f.service);assert.equal(r.checks.serviceConfig,'invalid');assert.equal(r.ready,false);}));
posixTest('recovery scans stop at a finite entry bound and report unknown',async()=>fixture(async f=>{const dir=join(f.root,'recovery');await mkdir(dir,{mode:0o700});await Promise.all(Array.from({length:257},(_,i)=>writeFile(join(dir,i+'.json'),'{}',{mode:0o600})));const r=await inspect(f.service,{availableBytes:plenty});assert.equal(r.checks.runners[0].recovery,'unknown');assert.equal(r.ready,false);}));
posixTest('unsafe scratch permissions cannot satisfy local readiness',async()=>fixture(async f=>{await chmod(join(f.root,'scratch'),0o755);const r=await inspect(f.service,{availableBytes:plenty});assert.equal(r.ready,false);assert.equal(r.checks.serviceConfig,'invalid');}));
for(const [mode,recovery,ready] of [[0o500,'unknown',false],[0o600,'unknown',false],[0o700,'clear',true]] as const){
  posixTest(`recovery directory mode ${mode.toString(8)} must match the Runner's exact 0700 requirement`,async()=>fixture(async f=>{
    const directory=join(f.root,'recovery');await mkdir(directory,{mode:0o700});await chmod(directory,mode);
    const report=await inspect(f.service,{availableBytes:plenty});
    assert.equal(report.checks.runners[0].recovery,recovery);assert.equal(report.ready,ready);
    assert.equal((await lstat(directory)).mode&0o777,mode,'diagnostics must preserve recovery directory permissions');
  }));
}
