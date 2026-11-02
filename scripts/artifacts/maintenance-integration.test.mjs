import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { maintenanceFixture } from './maintenance-fixture.mjs';
import { startBuildConsole } from './build-console-server.mjs';
const exec=promisify(execFile);
async function httpFixture(t) {
 const f=await maintenanceFixture(t);await f.completed('one');const b=await f.completed('secret','app-b');
 await writeFile(join(f.directory,'artifacts','app-b','secret',b.artifact.artifactId+'.bin'),'corrupted');
 const server=await startBuildConsole({directory:f.directory,appIds:['app-a'],approvalCode:'a'.repeat(48)});t.after(()=>server.close());
 const login=await fetch(server.origin+'/api/session',{method:'POST',headers:{origin:server.origin,'content-type':'application/json'},body:JSON.stringify({code:'a'.repeat(48)})});
 const cookie=login.headers.get('set-cookie').split(';')[0],session=await login.json();
 async function request(input={},extra={}) {return fetch(server.origin+'/api/diagnostics',{method:'POST',headers:{origin:server.origin,'content-type':'application/json',cookie,'x-flora-csrf':session.csrf,...extra},body:JSON.stringify(input)});}
 return {...f,server,request};
}
test('CLI backup/verify/restore use separate processes and preserve original state',async t=>{
 const f=await maintenanceFixture(t);await f.completed('one');const backup=join(f.root,'backup'),target=join(f.root,'restored');
 async function cli(...args){const r=await exec(process.execPath,['scripts/artifacts/build-ops.mjs',...args]);return JSON.parse(r.stdout);}
 assert.equal((await cli('backup','--state-dir',f.directory,'--output',backup)).result.verified,true);
 assert.equal((await cli('verify-backup','--backup',backup)).ok,true);
 assert.equal((await cli('restore','--state-dir',target,'--backup',backup)).result.restored,true);
 assert.equal((await cli('show','--state-dir',target,'--app','app-a','--job','one')).result.job.status,'succeeded');
 const scoped=await cli('doctor','--state-dir',target,'--app','app-a');assert.equal(scoped.result.appId,'app-a');
});
test('HTTP diagnostics are explicit, scoped, redacted, budgeted and rate limited',async t=>{
 const f=await httpFixture(t),r=await f.request({appId:'app-a'});assert.equal(r.status,200);const report=await r.json();
 assert.equal(report.appId,'app-a');assert.equal(report.jobs,1);assert.equal(report.ready,true);assert.equal(report.liveProcessVerified,false);
 assert.equal(JSON.stringify(report).includes('secret'),false);assert.equal(JSON.stringify(report).includes(f.root),false);
 const duplicate=await f.request({appId:'app-a'});assert.equal(duplicate.status,429);
 assert.equal((await fetch(f.server.origin+'/api/diagnostics')).status,401);
});
test('HTTP diagnostics reject CSRF, arbitrary paths and cross-app scope without scanning',async t=>{
 const f=await httpFixture(t);
 assert.equal((await f.request({appId:'app-b'})).status,403);
 assert.equal((await f.request({appId:'app-a'},{'x-flora-csrf':''})).status,403);
 assert.equal((await f.request({appId:'app-a',directory:'/secret'})).status,400);
 assert.equal((await f.request({appId:'app-a',maxBytes:2147483648})).status,400);
 const r=await f.request({appId:'app-a',maxBytes:1});assert.equal(r.status,200);const result=await r.json();assert.equal(result.complete,false);assert.equal(result.ready,false);
});
test('console exposes diagnostic result, freshness and safe recovery instructions',async()=>{
 const html=await readFile(new URL('console/index.html',import.meta.url),'utf8'),js=await readFile(new URL('console/console.mjs',import.meta.url),'utf8');
 for(const id of ['diagnose','diagnostic-status','diagnostic-summary','diagnostic-issues','diagnostic-export'])assert.ok(html.includes(`id="${id}"`),id);
 assert.match(js,/\/api\/diagnostics/);assert.match(js,/diagnosticEpoch/);assert.match(html,/백업/);assert.match(html,/복원/);
});
