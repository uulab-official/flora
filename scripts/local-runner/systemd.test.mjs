import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const modulePath=new URL('./systemd.mjs',import.meta.url);
const unsupported=process.platform==='win32'||process.getuid?.()===0;
async function fixture(t,suffix=''){
 const root=await fs.mkdtemp(join(await fs.realpath(tmpdir()),'flora-systemd-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const runtime=join(root,'runner'+suffix);await fs.mkdir(runtime,{mode:0o700});
 await fs.mkdir(join(runtime,'scratch'),{mode:0o700});
 const config={runtimeDirectory:runtime,nodePath:await fs.realpath(process.execPath),runnerMain:fileURLToPath(import.meta.url),runnerConfigs:[join(runtime,'app.json')],path:'/usr/local/bin:/usr/bin:/bin',limaHome:runtime,dockerHost:'unix:///run/user/1000/docker.sock',pollIntervalMs:30000};
 await fs.writeFile(config.runnerConfigs[0],JSON.stringify({token:'synthetic-private-token',recoveryDirectory:join(runtime,'recovery')}),{mode:0o600});
 const service=join(runtime,'service.json');await fs.writeFile(service,JSON.stringify(config),{mode:0o600});
 return{root,runtime,config,service};
}
test('generates a private user service without starting, contacting providers or exposing credentials',{skip:unsupported},async t=>{
 const {generateSystemdService}=await import(modulePath.href),f=await fixture(t);
 const existing=await Promise.all([f.service,...f.config.runnerConfigs].map(p=>fs.readFile(p)));
 const fetchBefore=globalThis.fetch;globalThis.fetch=()=>assert.fail('configuration generation must be offline');
 let result;try{result=await generateSystemdService(f.service);}finally{globalThis.fetch=fetchBefore;}
 assert.equal(result.manager,'systemd-user');assert.equal(result.installed,false);assert.equal(result.started,false);assert.equal(result.state,'created');
 assert.match(result.unitName,/^flora-runner-[a-f0-9]{12}\.service$/);assert.equal(dirname(result.file),f.runtime);
 const unit=await fs.readFile(result.file,'utf8');assert.match(unit,/Restart=on-failure\nRestartSec=30s/);assert.match(unit,/KillMode=mixed\nTimeoutStopSec=40s/);
 assert.match(unit,/UMask=0077/);assert.match(unit,/WantedBy=default.target/);assert.ok(unit.includes('supervisor.mjs'));
 assert.match(unit,/UnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT NODE_TLS_REJECT_UNAUTHORIZED NODE_EXTRA_CA_CERTS/);
 assert.ok(!unit.includes('synthetic-private-token'));assert.ok(!unit.includes('ExecStartPre='));assert.ok(!unit.includes('/bin/sh'));
 assert.equal((await fs.stat(result.file)).mode&0o777,0o600);
 assert.deepEqual(await Promise.all([f.service,...f.config.runnerConfigs].map(p=>fs.readFile(p))),existing);
});
test('repeated generation is unchanged; edited units, symlinks and hardlinks are never overwritten',{skip:unsupported},async t=>{
 const {generateSystemdService}=await import(modulePath.href),f=await fixture(t),first=await generateSystemdService(f.service);
 const before=await fs.stat(first.file);assert.equal((await generateSystemdService(f.service)).state,'unchanged');assert.equal((await fs.stat(first.file)).mtimeMs,before.mtimeMs);
 await fs.appendFile(first.file,'# operator edit\n');const edited=await fs.readFile(first.file);await assert.rejects(generateSystemdService(f.service),/RUNNER_SERVICE_OUTPUT_CONFLICT/);assert.deepEqual(await fs.readFile(first.file),edited);
 await fs.rename(first.file,first.file+'.original');await fs.symlink(first.file+'.original',first.file);await assert.rejects(generateSystemdService(f.service),/PRIVATE_PATH_REQUIRED/);
 await fs.unlink(first.file);await fs.link(first.file+'.original',first.file);await assert.rejects(generateSystemdService(f.service),/PRIVATE_PATH_REQUIRED/);
});
test('same-server app configurations use distinct stable unit names',{skip:unsupported},async t=>{
 const {generateSystemdService}=await import(modulePath.href),a=await fixture(t),b=await fixture(t);
 const first=await generateSystemdService(a.service),second=await generateSystemdService(b.service);assert.notEqual(first.unitName,second.unitName);
 assert.equal(first.unitName,'flora-runner-'+createHash('sha256').update(a.service).digest('hex').slice(0,12)+'.service');
});
test('fatal stop and recovery files are preserved and never become automatic reset commands',{skip:unsupported},async t=>{
 const {generateSystemdService}=await import(modulePath.href),f=await fixture(t);const marker=join(f.runtime,'fatal-stop'),recovery=join(f.runtime,'recovery');await fs.mkdir(recovery,{mode:0o700});
 const journal=join(recovery,'unconfirmed.json');await fs.writeFile(marker,'Manual inspection required. Recovery journals preserved.\n',{mode:0o600});await fs.writeFile(journal,'{"publication":"unknown"}',{mode:0o600});
 const before=await Promise.all([marker,journal].map(p=>fs.readFile(p)));const result=await generateSystemdService(f.service);
 assert.deepEqual(await Promise.all([marker,journal].map(p=>fs.readFile(p))),before);assert.ok(!(await fs.readFile(result.file,'utf8')).includes('fatal-stop'));
});
test('refuses unsupported VM startup, control characters, remote Docker and unsafe configuration paths',{skip:unsupported},async t=>{
 const {generateSystemdService}=await import(modulePath.href);
 for(const change of [{vmStart:['/bin/limactl','start','vm','-y']},{nodePath:'/bin/node\u0000bad'},{path:'/bin\u001b[31m'},{dockerHost:'tcp://remote:2375'}]){
  const f=await fixture(t);await fs.writeFile(f.service,JSON.stringify({...f.config,...change}));await assert.rejects(generateSystemdService(f.service));assert.equal((await fs.readdir(f.runtime)).filter(p=>p.endsWith('.service')).length,0);
 }
 const f=await fixture(t),alias=join(f.root,'alias');await fs.symlink(f.runtime,alias);await assert.rejects(generateSystemdService(join(alias,'service.json')));
 await fs.chmod(f.service,0o644);await assert.rejects(generateSystemdService(f.service),/PRIVATE_PATH_REQUIRED/);
});
test('rejects writable non-sticky ancestors instead of executing files from a replaceable directory',{skip:unsupported},async t=>{
 const {generateSystemdService}=await import(modulePath.href),f=await fixture(t);await fs.chmod(f.root,0o777);
 await assert.rejects(generateSystemdService(f.service),/RUNNER_SERVICE_EXECUTABLE_UNSAFE/);
 assert.equal((await fs.readdir(f.runtime)).filter(p=>p.endsWith('.service')).length,0);
});
test('escapes systemd percent and dollar substitutions while retaining literal paths with spaces',{skip:unsupported},async t=>{
 const {generateSystemdService}=await import(modulePath.href),f=await fixture(t,' with %n $HOME "quotes" \\');
 const result=await generateSystemdService(f.service),unit=await fs.readFile(result.file,'utf8');
 const exec=unit.split('\n').find(l=>l.startsWith('ExecStart='));assert.ok(exec.startsWith('ExecStart=:'));assert.ok(exec.includes('%%n $HOME \\"quotes\\" \\\\'));assert.ok(unit.includes('WorkingDirectory='+f.runtime.replaceAll('%','%%')+'/\n'));
});
