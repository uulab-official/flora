import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,chmod,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {signedBundleFixture} from './signature-fixture.mjs';
import {controlFixture,requestKey} from './control-fixture.mjs';
import {startBuildConsole} from './build-console-server.mjs';
let signed;before(async()=>{signed=await signedBundleFixture();});after(async()=>{await signed?.close();});
async function fixture(t) {
 const f=await controlFixture(t,`require('node:fs').copyFileSync(${JSON.stringify(signed.signed)},'result.aab')`);
 const recipe={...f.recipe,format:'aab',artifactPath:join(f.cwd,'result.aab'),signaturePolicy:signed.policy};
 const console=await startBuildConsole({directory:f.directory,appIds:['app-a'],approvalCode:'b'.repeat(48),enableExecution:true,presets:[{id:'signed-aab',label:'Signed AAB',recipe}]});f.closers.push(()=>console.close());
 const response=await fetch(console.origin+'/api/session',{method:'POST',headers:{origin:console.origin,'content-type':'application/json'},body:JSON.stringify({code:'b'.repeat(48)})});const session=await response.json();
 const headers={origin:console.origin,cookie:response.headers.get('set-cookie').split(';')[0],'content-type':'application/json','x-flora-csrf':session.csrf};
 const call=(path,body)=>fetch(console.origin+path,{headers,method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{})});
 return {...f,recipe,console,call,headers,path:'/api/jobs/app-a/job-one'};
}
async function complete(f) {
 const res=await f.call(f.path+'/execute',{presetId:'signed-aab',expectedVersion:2,idempotencyKey:requestKey(60)});assert.equal(res.status,202);
 const deadline=Date.now()+30000;while(Date.now()<deadline){const r=f.service.show(f.job);if(r.job.status==='succeeded')return r.artifacts[0];if(['failed','unknown'].includes(r.job.status))assert.fail('native verification did not complete: '+r.job.failureCode);await new Promise(r=>setTimeout(r,20));}assert.fail('completion deadline');
}
test('signed preset HTTP execution -> artifact proof -> verified download -> CLI evidence',async t=>{
 const f=await fixture(t),catalog=await(await f.call('/api/presets?app=app-a')).json();assert.equal(catalog.presets[0].signaturePolicy.expectedSignerSha256,signed.policy.expectedSignerSha256);assert.equal(JSON.stringify(catalog).includes('javaExecutable'),false);
 const artifact=await complete(f),response=await f.call(f.path+'/evidence?artifact='+artifact.artifactId);assert.equal(response.status,200);const report=await response.json();
 assert.equal(report.signatureVerified,true);assert.equal(report.integrityRechecked,false);assert.equal(report.bundleValidated,false);assert.equal(report.installVerified,false);assert.equal(JSON.stringify(report).includes(signed.root),false);
 const {ticket}=await(await f.call(f.path+'/downloads',{artifactId:artifact.artifactId})).json(),download=await f.call('/api/download',{ticket});assert.deepEqual(Buffer.from(await download.arrayBuffer()),await readFile(signed.signed));
 const out=await promisify(execFile)(process.execPath,['scripts/artifacts/build-ops.mjs','evidence','--state-dir',f.directory,'--app',f.job.appId,'--job',f.job.jobId,'--artifact',artifact.artifactId],{maxBuffer:65536,timeout:10000});assert.deepEqual(JSON.parse(out.stdout).result,report);
});
test('evidence read is authenticated and app scoped; browsers cannot set signature policy or receipt',async t=>{
 const f=await fixture(t);
 assert.equal((await fetch(f.console.origin+f.path+'/evidence?artifact='+'a'.repeat(24))).status,401);
 assert.equal((await f.call('/api/jobs/other/job-one/evidence?artifact='+'a'.repeat(24))).status,403);
 assert.equal((await f.call(f.path+'/evidence?artifact='+'a'.repeat(24))).status,404);
 for(const extra of [{signaturePolicy:signed.policy},{signatureEvidence:{verified:true}}])assert.equal((await f.call(f.path+'/execute',{presetId:'signed-aab',expectedVersion:2,idempotencyKey:requestKey(70),...extra})).status,400);
 assert.equal(f.service.show(f.job).job.status,'queued');
});
test('configured signature tool missing in preflight is not a successful signing check',async t=>{
 const f=await fixture(t);const {inspectLocalBuild}=await import('./local-build-preflight.mjs');
 const report=await inspectLocalBuild({directory:f.directory,scope:f.job,expectedVersion:2,recipe:{...f.recipe,signaturePolicy:{...signed.policy,javaExecutable:join(f.root,'missing-java')}}});assert.equal(report.ready,false);assert.equal(report.signatureVerified,false);assert.equal(report.checks.find(c=>c.id==='signature-tool').status,'failed');
});
test('console separates AAB upload signing, native validation and installation and saves scoped evidence',async()=>{
 const js=await readFile(new URL('./console/console.mjs',import.meta.url),'utf8');assert.match(js,/AAB 업로드 서명/);assert.match(js,/signatureEvidence/);assert.match(js,/bundleValidated/);assert.match(js,/서명 검증 기록/);assert.match(js,/signature-tool/);
});
