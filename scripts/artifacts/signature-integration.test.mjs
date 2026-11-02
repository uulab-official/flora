import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {signedBundleFixture} from './signature-fixture.mjs';
import {maintenanceFixture} from './maintenance-fixture.mjs';
import {openLocalBuildService} from './local-build-service.mjs';
import {backupLocalBuildState,restoreLocalBuildState,verifyLocalBuildBackup} from './local-build-backup.mjs';
import {runLocalBuild} from './local-build-runner.mjs';
import {inspectLocalBuild} from './local-build-preflight.mjs';
import {controlFixture} from './control-fixture.mjs';
let signing;before(async()=>{signing=await signedBundleFixture();});after(async()=>{await signing?.close();});
async function prepared(t) {
 const f=await maintenanceFixture(t),job={...f.context,jobId:'aab'};f.service.create(job);
 for(const [i,status] of ['authorized','queued','running'].entries())await f.service.transition({scope:job,expectedVersion:i,event:{status,idempotencyKey:String(i+1).repeat(32)}});
 const input={scope:job,expectedVersion:3,idempotencyKey:'4'.repeat(32),execution:{...job,exitCode:0},format:'aab',sourcePath:signing.signed,
  manifest:{...await signing.manifest(),...job},signaturePolicy:signing.policy};return {...f,job,input};
}
test('verified completion stores byte-bound per-artifact proof, not a global install claim',async t=>{
 const f=await prepared(t),done=await f.service.complete(f.input);assert.equal(done.artifact.signatureVerified,true);assert.equal(done.signatureVerified,false);assert.equal(done.installVerified,false);assert.equal(done.artifact.signatureEvidence.sha256,f.input.manifest.sha256);
 assert.equal(done.artifact.signatureEvidence.signerSha256,signing.policy.expectedSignerSha256);assert.equal(JSON.stringify(done).includes(signing.root),false);
});
test('wrong signing certificate blocks publication and completion',async t=>{
 const f=await prepared(t);await assert.rejects(f.service.complete({...f.input,signaturePolicy:{...signing.policy,expectedSignerSha256:'0'.repeat(64)}}),/ARTIFACT_SIGNATURE_SIGNER_MISMATCH/);
 assert.equal(f.service.show(f.job).job.status,'running');assert.equal(f.service.show(f.job).artifacts.length,0);assert.deepEqual(await readdir(join(f.directory,'artifacts')),[]);
});
test('caller cannot inject a signature receipt or boolean into completion',async t=>{
 const f=await prepared(t);await assert.rejects(f.service.complete({...f.input,signatureEvidence:{verified:true}}),/ARTIFACT_SIGNATURE_EVIDENCE_INVALID/);
 assert.equal(f.service.show(f.job).artifacts.length,0);
});
test('signed replay pins certificate expectation; unsigned downgrade and changed pin conflict',async t=>{
 const f=await prepared(t),first=await f.service.complete(f.input);
 const replay=await f.service.complete({...f.input,sourcePath:'/missing/not-used.aab'});assert.equal(replay.replayed,true);assert.deepEqual(replay.artifact,first.artifact);
 await assert.rejects(f.service.complete({...f.input,signaturePolicy:undefined}),/BUILD_IDEMPOTENCY_CONFLICT/);
 await assert.rejects(f.service.complete({...f.input,signaturePolicy:{...signing.policy,expectedSignerSha256:'f'.repeat(64)}}),/BUILD_IDEMPOTENCY_CONFLICT/);
});
test('signing failure and mismatched format never leave successful artifacts',async t=>{
 const f=await controlFixture(t,`require('node:fs').copyFileSync(${JSON.stringify(signing.signed)},'result.aab')`);
 const recipe={...f.recipe,format:'aab',artifactPath:join(f.cwd,'result.aab'),signaturePolicy:{...signing.policy,expectedSignerSha256:'e'.repeat(64)}};
 const done=await runLocalBuild({directory:f.directory,scope:f.job,recipe,execute:true});assert.equal(done.status,'failed');assert.equal(done.reason,'ARTIFACT_SIGNATURE_SIGNER_MISMATCH');assert.equal(f.service.show(f.job).artifacts.length,0);
 assert.equal(f.service.history(f.job).some(e=>e.eventType==='runner-artifact-publishing'),false);
});
test('actual runner publishes signed evidence and exposes signature verification stage',async t=>{
 const f=await controlFixture(t,`require('node:fs').copyFileSync(${JSON.stringify(signing.signed)},'result.aab')`),activity=[];
 const recipe={...f.recipe,format:'aab',artifactPath:join(f.cwd,'result.aab'),signaturePolicy:signing.policy};
 const preflight=await inspectLocalBuild({directory:f.directory,scope:f.job,recipe,expectedVersion:2});assert.equal(preflight.ready,true);assert.equal(preflight.signatureVerified,false);assert.ok(preflight.checks.some(c=>c.id==='signature-tool'&&c.status==='passed'));
 const done=await runLocalBuild({directory:f.directory,scope:f.job,recipe,execute:true,onProgress:p=>activity.push(p.stage)});assert.equal(done.status,'succeeded');assert.equal(done.artifact.signatureVerified,true);assert.ok(activity.includes('signature-verifying'));
});
test('backup and fresh restore preserve verified evidence and export bytes with historical verification',async t=>{
 const f=await prepared(t),done=await f.service.complete(f.input);f.service.close();
 let service=await openLocalBuildService({directory:f.directory});const saved=service.show(f.job).artifacts[0];assert.equal(saved.signatureVerified,true);service.close();
 const target=join(f.root,'snapshot'),restore=join(f.root,'restored');await backupLocalBuildState({directory:f.directory,target});await verifyLocalBuildBackup({directory:target});await restoreLocalBuildState({directory:target,target:restore});
 service=await openLocalBuildService({directory:restore});try{
  assert.deepEqual(service.show(f.job).artifacts[0].signatureEvidence,done.artifact.signatureEvidence);
  const output=join(f.root,'export.aab');const result=await service.export({scope:f.job,artifactId:saved.artifactId,targetPath:output});assert.equal(result.signatureVerified,true);assert.equal(result.installVerified,false);assert.deepEqual(await readFile(output),await readFile(signing.signed));
 }finally{service.close();}
});
test('backup rejects a signature flag without valid byte-bound evidence even after digest recomputation',async t=>{
 const f=await prepared(t);await f.service.complete(f.input);const target=join(f.root,'backup');await backupLocalBuildState({directory:f.directory,target});
 const path=join(target,'builds.sqlite'),db=new DatabaseSync(path);const a=JSON.parse(db.prepare('SELECT metadata FROM artifacts').get().metadata);a.signatureVerified=true;a.signatureEvidence={fake:true};db.prepare('UPDATE artifacts SET metadata=?').run(JSON.stringify(a));db.close();
 const mpath=join(target,'manifest.json'),m=JSON.parse(await readFile(mpath,'utf8')),bytes=await readFile(path);m.database={byteCount:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};await writeFile(mpath,JSON.stringify(m));await assert.rejects(verifyLocalBuildBackup({directory:target}),/BUILD_BACKUP_DATABASE_INVALID/);
});
test('read-only completion fails before signature tool or filesystem side effects',async t=>{
 const f=await prepared(t),ro=await openLocalBuildService({directory:f.directory,readOnly:true});try{await assert.rejects(ro.complete(f.input),/BUILD_LEDGER_READ_ONLY/);}finally{ro.close();}
 assert.equal((await readdir(f.directory)).some(n=>n.startsWith('.signature-')),false);
});
test('cancellation during signature verification prevents publication and cleans owned verifier process',async t=>{
 const f=await controlFixture(t,`require('node:fs').copyFileSync(${JSON.stringify(signing.signed)},'result.aab')`);
 const {chmod,access}=await import('node:fs/promises');const marker=join(f.root,'verifier-entered'),tool=join(f.root,'slow-java');
 await writeFile(tool,`#!/bin/sh\nprintf entered > '${marker}'\nexec sleep 20\n`);await chmod(tool,0o700);
 const c=new AbortController(),recipe={...f.recipe,format:'aab',artifactPath:join(f.cwd,'result.aab'),signaturePolicy:{...signing.policy,javaExecutable:tool}};
 const task=runLocalBuild({directory:f.directory,scope:f.job,recipe,execute:true,signal:c.signal});
 const deadline=Date.now()+10000;let entered=false;while(Date.now()<deadline){try{await access(marker);entered=true;break;}catch{}await new Promise(r=>setTimeout(r,10));}
 c.abort();const done=await task;assert.equal(entered,true);assert.equal(done.status,'cancelled');assert.equal(done.reason,'BUILD_PROCESS_ABORTED');assert.equal(f.service.show(f.job).artifacts.length,0);assert.equal((await readdir(f.directory)).some(n=>n.startsWith('.signature-')),false);
});
test('unsigned completion fingerprints stay compatible with pre-signature versions',async t=>{
 const f=await maintenanceFixture(t),done=await f.completed('legacy');const db=new DatabaseSync(join(f.directory,'builds.sqlite'),{readOnly:true});
 try {const event={status:'succeeded',idempotencyKey:'4'.repeat(32),artifactIntegrityVerified:true,executionVerified:true};
  const metadata={appId:'app-a',jobId:'legacy',repository:f.context.repository,sourceSha:f.context.sourceSha,platform:'android',byteCount:f.bytes.length,sha256:createHash('sha256').update(f.bytes).digest('hex'),format:'apk'};
  const fingerprint=createHash('sha256').update(JSON.stringify(['complete',3,event,metadata,f.context.runnerId,0])).digest('hex');assert.equal(db.prepare('SELECT fingerprint FROM requests WHERE request_key=?').get('4'.repeat(32)).fingerprint,fingerprint);assert.equal(done.artifact.signatureVerified,false);
 }finally{db.close();}
});
test('unsigned metadata evidence report cannot imply a signing or installation check',async t=>{
 const f=await maintenanceFixture(t),done=await f.completed('plain');const report=f.service.evidence({scope:done,artifactId:done.artifact.artifactId});assert.equal(report.signatureVerified,false);assert.equal(report.signatureEvidence,null);assert.equal(report.integrityRechecked,false);assert.equal(report.installVerified,false);
});
test('doctor flags corrupt signing metadata instead of treating a good byte hash as sufficient',async t=>{
 const f=await prepared(t);await f.service.complete(f.input);const db=new DatabaseSync(join(f.directory,'builds.sqlite'));const a=JSON.parse(db.prepare('SELECT metadata FROM artifacts').get().metadata);a.signatureEvidence.sha256='0'.repeat(64);db.prepare('UPDATE artifacts SET metadata=?').run(JSON.stringify(a));db.close();
 const report=await f.service.doctor({appId:'app-a'});assert.equal(report.ready,false);assert.ok(report.issues.some(i=>i.code==='ARTIFACT_SIGNATURE_EVIDENCE_INVALID'));assert.equal(report.signatureRechecked,false);
});
test('corrupt replay evidence is rejected even when stored artifact bytes are unchanged',async t=>{
 const f=await prepared(t);await f.service.complete(f.input);const db=new DatabaseSync(join(f.directory,'builds.sqlite'));
 const old=JSON.parse(db.prepare('SELECT result FROM requests WHERE request_key=?').get('4'.repeat(32)).result);old.artifact.signatureEvidence.signerSha256='0'.repeat(64);db.prepare('UPDATE requests SET result=? WHERE request_key=?').run(JSON.stringify(old),'4'.repeat(32));db.close();
 await assert.rejects(f.service.complete(f.input),/ARTIFACT_SIGNATURE_EVIDENCE_INVALID/);
});
