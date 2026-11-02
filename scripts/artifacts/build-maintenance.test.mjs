import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openLocalBuildService } from './local-build-service.mjs';
import { maintenanceFixture } from './maintenance-fixture.mjs';
test('app diagnostics never expose another app inventory, counts or unknown jobs', async t => {
  const f=await maintenanceFixture(t); await f.completed('one'); const b=await f.completed('secret','app-b');
  await writeFile(join(f.directory,'artifacts','app-b','secret',b.artifact.artifactId+'.bin'),'corrupted');
  const report=await f.service.doctor({appId:'app-a'});
  assert.equal(report.appId,'app-a'); assert.equal(report.jobs,1); assert.equal(report.artifacts,1); assert.equal(report.ready,true);
  assert.equal(JSON.stringify(report).includes('secret'),false);
  const bad=await f.service.doctor({appId:'app-b'}); assert.equal(bad.ready,false); assert.equal(bad.jobs,1);
});
test('diagnostics paginate beyond 100 artifacts and never call bounded scan complete', async t => {
  const f=await maintenanceFixture(t);
  for(let i=0;i<103;i++) await f.completed('job-'+String(i).padStart(3,'0'));
  const report=await f.service.doctor({appId:'app-a',maxEntries:1000});
  assert.equal(report.verifiedFiles,103); assert.equal(report.complete,true); assert.equal(report.ready,true);
  const limited=await f.service.doctor({appId:'app-a',maxEntries:20});
  assert.equal(limited.complete,false); assert.equal(limited.ready,false); assert.ok(limited.verifiedFiles<=20);
});
test('diagnostics reject malformed app scope and require checking running jobs',async t=>{
  const f=await maintenanceFixture(t); f.service.create(f.context);
  for(const [i,status] of ['authorized','queued','running'].entries()) await f.service.transition({scope:f.context,expectedVersion:i,event:{status,idempotencyKey:String(i+1).repeat(32)}});
  await assert.rejects(f.service.doctor({appId:'../other'}),/BUILD_QUERY_INVALID/);
  const result=await f.service.doctor({appId:'app-a'});
  assert.equal(result.ready,false); assert.ok(result.issues.some(i=>i.code==='BUILD_RUNNING_REQUIRES_CHECK'));
});
test('incomplete restored state cannot be opened even with create=true',async t=>{
  const f=await maintenanceFixture(t); await writeFile(join(f.directory,'.flora-incomplete'),'restore-in-progress',{mode:0o600});
  await assert.rejects(openLocalBuildService({directory:f.directory}),/BUILD_STATE_INCOMPLETE/);
  await assert.rejects(openLocalBuildService({directory:f.directory,create:true}),/BUILD_STATE_INCOMPLETE/);
});
test('read-only completion refuses before creating artifact files',async t=>{
 const f=await maintenanceFixture(t); f.service.create(f.context);
 for(const [i,status]of ['authorized','queued','running'].entries())await f.service.transition({scope:f.context,expectedVersion:i,event:{status,idempotencyKey:String(i+1).repeat(32)}});
 const ro=await openLocalBuildService({directory:f.directory,readOnly:true});t.after(()=>ro.close());
 const {createHash}=await import('node:crypto');const {readdir}=await import('node:fs/promises');
 const before=await readdir(join(f.directory,'artifacts'));
 await assert.rejects(ro.complete({scope:f.context,expectedVersion:3,idempotencyKey:'4'.repeat(32),execution:{...f.context,exitCode:0},sourcePath:join(f.root,'source.apk'),format:'apk',
  manifest:{...f.context,byteCount:f.bytes.length,sha256:createHash('sha256').update(f.bytes).digest('hex')}}),/BUILD_LEDGER_READ_ONLY/);
 assert.deepEqual(await readdir(join(f.directory,'artifacts')),before);
});
