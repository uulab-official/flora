import { DatabaseSync, backup } from 'node:sqlite';
import { lstat, mkdir, open, readdir, rm, unlink } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { privateDirectory, privateFile, localPath, syncDirectory } from './private-paths.mjs';
import { checkBackupFile, writePrivateBackupFile } from './backup-files.mjs';
import { inspectBackupDatabase, MAX_BACKUP_DATABASE_BYTES } from './backup-database.mjs';
import { copyVerifiedNativeArtifact } from './verified-copy.mjs';
import { verifyNativeArtifactFile } from './native-artifact-file.mjs';
import { isBuildId, isRecord } from './build-lifecycle.mjs';

const MARKER='FLORA_LOCAL_BACKUP_V1\n', DEFAULT_BYTES=1024*1024*1024;
function limits({maxBytes=DEFAULT_BYTES,maxEntries=1000}) {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>16*1024*1024*1024||!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>10000) throw new Error('BUILD_BACKUP_LIMIT');
  return {maxBytes,maxEntries};
}
async function absent(path,code) { try {await lstat(path);throw new Error(code);}catch(e){if(e.code!=='ENOENT')throw e;} }
async function inputDirectory(value) {
  const directory=await privateDirectory(value);
  await absent(join(directory,'.flora-incomplete'),'BUILD_BACKUP_INCOMPLETE');return directory;
}
async function reserveTarget(source,target) {
  target=localPath(target); await privateDirectory(dirname(target));
  const child=relative(source,target);
  if(child===''||(!isAbsolute(child)&&child!=='..'&&!child.startsWith('../'))) throw new Error('BUILD_BACKUP_TARGET_INVALID');
  try {await mkdir(target,{mode:0o700});}catch(error){if(error.code==='EEXIST')throw new Error('BUILD_BACKUP_TARGET_EXISTS');throw error;}
  try {await writePrivateBackupFile(join(target,'.flora-incomplete'),'incomplete\n');await syncDirectory(dirname(target));}
  catch(error){await rm(target,{recursive:true,force:true});throw error;}
  return target;
}
const entry=a=>({appId:a.appId,jobId:a.jobId,artifactId:a.artifactId,byteCount:a.byteCount,sha256:a.sha256});
function summary(info,database) {return {verified:true,formatVersion:1,jobs:info.jobs,artifacts:info.artifacts.length,
  auditEvents:info.auditEvents,byteCount:database.byteCount+info.artifacts.reduce((n,a)=>n+a.byteCount,0),requiresReconciliation:Boolean(info.states.unknown)};}
async function parents(root,a) {const base=join(root,'artifacts');await privateDirectory(base,{create:true});
  const app=join(base,a.appId);await privateDirectory(app,{create:true});const job=join(app,a.jobId);await privateDirectory(job,{create:true});return job;}
const file=(root,a)=>join(root,'artifacts',a.appId,a.jobId,a.artifactId+'.bin');
function budget(info,database,maxBytes){if(database.byteCount+info.artifacts.reduce((n,a)=>n+a.byteCount,0)>maxBytes)throw new Error('BUILD_BACKUP_LIMIT');}
async function treeMatches(root,artifacts) {
  const directories=new Set(['artifacts']), expected=new Set(['.flora-backup','manifest.json','builds.sqlite','artifacts']);
  for(const a of artifacts){directories.add(`artifacts/${a.appId}`);directories.add(`artifacts/${a.appId}/${a.jobId}`);expected.add(`artifacts/${a.appId}`);expected.add(`artifacts/${a.appId}/${a.jobId}`);expected.add(`artifacts/${a.appId}/${a.jobId}/${a.artifactId}.bin`);}
  let seen=0;
  async function walk(dir,prefix='') {
    await privateDirectory(dir);
    for(const ent of await readdir(dir,{withFileTypes:true})) {
      const path=prefix+ent.name;if(!expected.has(path)||++seen>expected.size)throw new Error('BUILD_BACKUP_UNEXPECTED_ENTRY');
      if(directories.has(path)!==ent.isDirectory())throw new Error('BUILD_BACKUP_UNEXPECTED_ENTRY');
      if(ent.isDirectory())await walk(join(dir,ent.name),path+'/');else {if(!ent.isFile())throw new Error('BUILD_BACKUP_UNEXPECTED_ENTRY');await privateFile(join(dir,ent.name));}
    }
  }
  await walk(root);if(seen!==expected.size)throw new Error('BUILD_BACKUP_INCOMPLETE');
}
function keys(value,expected) {return isRecord(value)&&Object.keys(value).sort().join(',')===[...expected].sort().join(',');}
function validDigest(d){return keys(d,['byteCount','sha256'])&&Number.isSafeInteger(d.byteCount)&&d.byteCount>0&&typeof d.sha256==='string'&&d.sha256.length===64&&/^[a-f0-9]{64}$/.test(d.sha256);}
async function readManifest(directory,maxEntries) {
  const result=await checkBackupFile(join(directory,'manifest.json'),{maxBytes:8*1024*1024,collect:true});let m;
  try {m=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(result.bytes));}catch{throw new Error('BUILD_BACKUP_MANIFEST_INVALID');}
  if(!keys(m,['format','version','createdAt','database','artifacts'])||m.format!=='flora-local-backup'||m.version!==1||typeof m.createdAt!=='string'
      ||!Number.isFinite(Date.parse(m.createdAt))||new Date(m.createdAt).toISOString()!==m.createdAt||!validDigest(m.database)||!Array.isArray(m.artifacts)||m.artifacts.length>maxEntries)
    throw new Error('BUILD_BACKUP_MANIFEST_INVALID');
  for(const a of m.artifacts)if(!keys(a,['appId','jobId','artifactId','byteCount','sha256'])||!isBuildId(a.appId)||!isBuildId(a.jobId)||typeof a.artifactId!=='string'||a.artifactId.length!==24||!/^[a-f0-9]{24}$/.test(a.artifactId)||!validDigest({byteCount:a.byteCount,sha256:a.sha256}))throw new Error('BUILD_BACKUP_MANIFEST_INVALID');
  return m;
}
async function verified(directory,options) {
  const {maxBytes,maxEntries}=limits(options);directory=await inputDirectory(directory);
  const marker=await checkBackupFile(join(directory,'.flora-backup'),{maxBytes:64,collect:true});
  if(marker.bytes.toString()!==MARKER)throw new Error('BUILD_BACKUP_MANIFEST_INVALID');
  const manifest=await readManifest(directory,maxEntries);
  if(manifest.database.byteCount>Math.min(maxBytes,MAX_BACKUP_DATABASE_BYTES))throw new Error('BUILD_BACKUP_LIMIT');
  const database=await checkBackupFile(join(directory,'builds.sqlite'),{maxBytes:MAX_BACKUP_DATABASE_BYTES,expected:manifest.database});
  const info=await inspectBackupDatabase(join(directory,'builds.sqlite'),maxEntries);budget(info,database,maxBytes);
  if(JSON.stringify(info.artifacts.map(entry))!==JSON.stringify(manifest.artifacts))throw new Error('BUILD_BACKUP_MANIFEST_INVALID');
  await treeMatches(directory,info.artifacts);
  for(const a of info.artifacts)await verifyNativeArtifactFile({filePath:file(directory,a),manifest:a,expected:a});
  return {directory,info,database};
}
export async function backupLocalBuildState({directory,target,...options}) {
  const {maxBytes,maxEntries}=limits(options);directory=await inputDirectory(directory);
  await absent(join(directory,'.flora-backup'),'BUILD_BACKUP_READ_ONLY');
  const source=join(directory,'builds.sqlite');await privateFile(source);
  const size=(await lstat(source)).size;if(size>Math.min(maxBytes,MAX_BACKUP_DATABASE_BYTES))throw new Error('BUILD_BACKUP_LIMIT');
  for(const suffix of ['-wal','-shm','-journal'])await privateFile(source+suffix,{optional:true});
  target=await reserveTarget(directory,target);let db;
  try {
    const output=join(target,'builds.sqlite');const handle=await open(output,'wx',0o600);await handle.close();
    db=new DatabaseSync(source,{readOnly:true});db.exec('PRAGMA busy_timeout=1500;');
    await backup(db,output);db.close();db=null;
    const copied=await open(output,'r');try{await copied.sync();}finally{await copied.close();}
    const database=await checkBackupFile(output,{maxBytes:Math.min(maxBytes,MAX_BACKUP_DATABASE_BYTES)});
    const info=await inspectBackupDatabase(output,maxEntries);budget(info,database,maxBytes);
    await privateDirectory(join(target,'artifacts'),{create:true});
    for(const a of info.artifacts){await parents(target,a);await copyVerifiedNativeArtifact({sourcePath:file(directory,a),targetPath:file(target,a),manifest:a,expected:a});}
    const manifest={format:'flora-local-backup',version:1,createdAt:new Date().toISOString(),database,artifacts:info.artifacts.map(entry)};
    await writePrivateBackupFile(join(target,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
    await writePrivateBackupFile(join(target,'.flora-backup'),MARKER);
    await unlink(join(target,'.flora-incomplete'));await syncDirectory(target);
    const checked=await verified(target,options);return summary(checked.info,checked.database);
  } catch(error){db?.close();await rm(target,{recursive:true,force:true});await syncDirectory(dirname(target));throw error;}
}
export async function verifyLocalBuildBackup({directory,...options}) {const value=await verified(directory,options);return summary(value.info,value.database);}
export async function restoreLocalBuildState({directory,target,...options}) {
  const value=await verified(directory,options);directory=value.directory;
  target=await reserveTarget(directory,target);
  try {
    await checkBackupFile(join(directory,'builds.sqlite'),{maxBytes:MAX_BACKUP_DATABASE_BYTES,expected:value.database,target:join(target,'builds.sqlite')});
    await privateDirectory(join(target,'artifacts'),{create:true});
    for(const a of value.info.artifacts){await parents(target,a);await copyVerifiedNativeArtifact({sourcePath:file(directory,a),targetPath:file(target,a),manifest:a,expected:a});}
    await inspectBackupDatabase(join(target,'builds.sqlite'),limits(options).maxEntries);
    await unlink(join(target,'.flora-incomplete'));await syncDirectory(target);await syncDirectory(dirname(target));
    return {...summary(value.info,value.database),restored:true,executionEnabled:false};
  }catch(error){await rm(target,{recursive:true,force:true});await syncDirectory(dirname(target));throw error;}
}
