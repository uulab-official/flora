import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { maintenanceFixture } from './maintenance-fixture.mjs';
import { openLocalBuildService } from './local-build-service.mjs';
import { backupLocalBuildState, verifyLocalBuildBackup, restoreLocalBuildState } from './local-build-backup.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
async function setup(t) { const f=await maintenanceFixture(t);f.done=await f.completed('one');f.backup=join(f.root,'backup');return f; }
test('verified backup restores artifact bytes, audit and idempotency into a fresh state',async t=>{
 const f=await setup(t), snapshot=await backupLocalBuildState({directory:f.directory,target:f.backup});
 assert.equal(snapshot.verified,true);assert.equal(snapshot.artifacts,1);
 assert.equal(JSON.stringify(snapshot).includes(f.root),false);
 assert.deepEqual((await readdir(f.backup)).sort(),['.flora-backup','artifacts','builds.sqlite','manifest.json']);
 const before=sha(await readFile(join(f.backup,'builds.sqlite')));
 const checked=await verifyLocalBuildBackup({directory:f.backup});assert.equal(checked.verified,true);
 assert.equal(sha(await readFile(join(f.backup,'builds.sqlite'))),before,'verify must be read-only');
 const target=join(f.root,'restored');const restored=await restoreLocalBuildState({directory:f.backup,target});assert.equal(restored.restored,true);
 const service=await openLocalBuildService({directory:target}); t.after(()=>service.close());
 assert.deepEqual(service.history(f.context),f.service.history(f.context));assert.deepEqual(service.show(f.context),f.service.show(f.context));
 const replay=await service.transition({scope:f.context,expectedVersion:0,event:{status:'authorized',idempotencyKey:'1'.repeat(32)}});assert.equal(replay.replayed,true);
 await service.export({scope:f.context,artifactId:f.done.artifact.artifactId,targetPath:join(f.root,'out.apk')});
 assert.deepEqual(await readFile(join(f.root,'out.apk')),f.bytes);
 assert.equal((await stat(join(target,'builds.sqlite'))).mode&0o777,0o600);
});
test('backup snapshots are not executable operational directories',async t=>{
 const f=await setup(t);await backupLocalBuildState({directory:f.directory,target:f.backup});
 await assert.rejects(openLocalBuildService({directory:f.backup}),/BUILD_BACKUP_READ_ONLY/);
});
test('backup does not export local secrets, presets, locks or download staging',async t=>{
 const f=await setup(t);await writeFile(join(f.directory,'approval-code.txt'),'do-not-copy',{mode:0o600});
 await writeFile(join(f.directory,'.runner-lock-private.lock'),'do-not-copy',{mode:0o600});
 await mkdir(join(f.directory,'console-download-stale'),{mode:0o700});
 await backupLocalBuildState({directory:f.directory,target:f.backup});
 const names=await readdir(f.backup);assert.ok(!names.some(n=>/approval|lock|download/.test(n)));
 assert.equal((await readFile(join(f.backup,'manifest.json'),'utf8')).includes('do-not-copy'),false);
});
test('backup and restore never overwrite existing files or directories',async t=>{
 const f=await setup(t);await mkdir(f.backup,{mode:0o700});await writeFile(join(f.backup,'keep'),'keep');
 await assert.rejects(backupLocalBuildState({directory:f.directory,target:f.backup}),/BUILD_BACKUP_TARGET_EXISTS/);
 assert.equal(await readFile(join(f.backup,'keep'),'utf8'),'keep');
 const other=join(f.root,'snapshot');await backupLocalBuildState({directory:f.directory,target:other});
 const original=sha(await readFile(join(f.directory,'builds.sqlite')));
 await assert.rejects(restoreLocalBuildState({directory:other,target:f.directory}),/BUILD_BACKUP_TARGET_EXISTS/);
 assert.equal(sha(await readFile(join(f.directory,'builds.sqlite'))),original);
});
test('same-size artifact tamper rejects verification and restore without activating target',async t=>{
 const f=await setup(t);await backupLocalBuildState({directory:f.directory,target:f.backup});
 const path=join(f.backup,'artifacts','app-a','one',f.done.artifact.artifactId+'.bin');await writeFile(path,Buffer.alloc(f.bytes.length,88));
 await assert.rejects(verifyLocalBuildBackup({directory:f.backup}),/ARTIFACT_HASH_MISMATCH|BUILD_BACKUP_HASH_MISMATCH/);
 const target=join(f.root,'restored');await assert.rejects(restoreLocalBuildState({directory:f.backup,target}),/HASH_MISMATCH/);
 await assert.rejects(stat(target),{code:'ENOENT'});assert.equal((await f.service.doctor()).ready,true);
});
test('database and manifest tampering, incomplete snapshots and symlinks fail closed',async t=>{
 const f=await setup(t);await backupLocalBuildState({directory:f.directory,target:f.backup});
 await writeFile(join(f.backup,'.flora-incomplete'),'partial',{mode:0o600});
 await assert.rejects(verifyLocalBuildBackup({directory:f.backup}),/BUILD_BACKUP_INCOMPLETE/);
 const alias=join(f.root,'alias');await symlink(f.backup,alias);
 await assert.rejects(verifyLocalBuildBackup({directory:alias}),/BUILD_DIRECTORY_UNSAFE/);
 const b=join(f.root,'backup2');await backupLocalBuildState({directory:f.directory,target:b});
 const m=JSON.parse(await readFile(join(b,'manifest.json'),'utf8'));m.artifacts[0].appId='../escape';
 await writeFile(join(b,'manifest.json'),JSON.stringify(m));
 await assert.rejects(verifyLocalBuildBackup({directory:b}),/BUILD_BACKUP_MANIFEST_INVALID/);
});
test('unknown schema with a recomputed digest is rejected, not migrated during restore',async t=>{
 const f=await setup(t);await backupLocalBuildState({directory:f.directory,target:f.backup});
 const path=join(f.backup,'builds.sqlite'), db=new DatabaseSync(path);db.exec('PRAGMA user_version=999');db.close();
 const bytes=await readFile(path),mp=join(f.backup,'manifest.json'),m=JSON.parse(await readFile(mp,'utf8'));m.database.sha256=sha(bytes);m.database.byteCount=bytes.length;await writeFile(mp,JSON.stringify(m));
 await assert.rejects(restoreLocalBuildState({directory:f.backup,target:join(f.root,'new')}),/BUILD_SCHEMA_UNSUPPORTED/);
});
for(const status of ['authorized','queued','running']) test(`snapshot with ${status} jobs requires operator quiescence`,async t=>{
 const f=await maintenanceFixture(t);f.service.create(f.context);
 for(const [i,s]of ['authorized','queued','running'].slice(0,['authorized','queued','running'].indexOf(status)+1).entries()) await f.service.transition({scope:f.context,expectedVersion:i,event:{status:s,idempotencyKey:String(i+1).repeat(32)}});
 const target=join(f.root,'backup');await assert.rejects(backupLocalBuildState({directory:f.directory,target}),/BUILD_BACKUP_NOT_QUIESCENT/);
 assert.equal(f.service.show(f.context).job.status,status);await assert.rejects(stat(target),{code:'ENOENT'});
});
test('unknown outcome is preserved and remains blocked after restore',async t=>{
 const f=await maintenanceFixture(t);f.service.create(f.context);
 for(const [i,status]of ['authorized','queued','unknown'].entries())await f.service.transition({scope:f.context,expectedVersion:i,event:{status,idempotencyKey:String(i+1).repeat(32)}});
 const backup=join(f.root,'backup'),target=join(f.root,'restored');
 const result=await backupLocalBuildState({directory:f.directory,target:backup});assert.equal(result.requiresReconciliation,true);
 await restoreLocalBuildState({directory:backup,target});const s=await openLocalBuildService({directory:target});t.after(()=>s.close());
 assert.equal(s.show(f.context).job.status,'unknown');assert.equal((await s.doctor()).ready,false);
});
test('byte/entry limits and corrupted source leave no completed backup',async t=>{
 const f=await setup(t);await assert.rejects(backupLocalBuildState({directory:f.directory,target:f.backup,maxBytes:1}),/BUILD_BACKUP_LIMIT/);
 await assert.rejects(stat(f.backup),{code:'ENOENT'});
 await writeFile(join(f.directory,'artifacts','app-a','one',f.done.artifact.artifactId+'.bin'),Buffer.alloc(f.bytes.length,0));
 await assert.rejects(backupLocalBuildState({directory:f.directory,target:f.backup}),/HASH_MISMATCH/);await assert.rejects(stat(f.backup),{code:'ENOENT'});
});
test('read-only ledger rejects state mutation while retaining reads',async t=>{
 const f=await setup(t),ro=await openLocalBuildService({directory:f.directory,readOnly:true});t.after(()=>ro.close());
 assert.equal(ro.show(f.context).job.status,'succeeded');assert.throws(()=>ro.create({...f.context,jobId:'forbidden'}),/BUILD_LEDGER_READ_ONLY/);
});
test('an empty snapshot still requires an artifacts directory, not a file',async t=>{
 const f=await maintenanceFixture(t),target=join(f.root,'backup');await backupLocalBuildState({directory:f.directory,target});
 const {rm}=await import('node:fs/promises');await rm(join(target,'artifacts'),{recursive:true});await writeFile(join(target,'artifacts'),'not-a-directory',{mode:0o600});
 await assert.rejects(verifyLocalBuildBackup({directory:target}),/BUILD_BACKUP_UNEXPECTED_ENTRY/);
});
test('extra entries, artifact hardlinks, DB tampering and tight entry budgets are rejected',async t=>{
 const f=await setup(t);await f.completed('two');
 await assert.rejects(backupLocalBuildState({directory:f.directory,target:f.backup,maxEntries:1}),/BUILD_BACKUP_LIMIT/);
 await backupLocalBuildState({directory:f.directory,target:f.backup});
 await writeFile(join(f.backup,'unknown.txt'),'not-in-manifest',{mode:0o600});await assert.rejects(verifyLocalBuildBackup({directory:f.backup}),/BUILD_BACKUP_UNEXPECTED_ENTRY/);
 const {rm,link}=await import('node:fs/promises');await rm(join(f.backup,'unknown.txt'));
 const path=join(f.backup,'artifacts','app-a','one',f.done.artifact.artifactId+'.bin');await link(path,join(f.root,'hard.bin'));
 await assert.rejects(verifyLocalBuildBackup({directory:f.backup}),/BUILD_DATABASE_UNSAFE|ARTIFACT_NOT_REGULAR_FILE/);await rm(join(f.root,'hard.bin'));
 const dbpath=join(f.backup,'builds.sqlite'),bytes=await readFile(dbpath);bytes[200]^=1;await writeFile(dbpath,bytes);
 await assert.rejects(verifyLocalBuildBackup({directory:f.backup}),/BUILD_BACKUP_HASH_MISMATCH/);
});
