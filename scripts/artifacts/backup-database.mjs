import { DatabaseSync } from 'node:sqlite';
import { isBuildId, isRecord } from './build-lifecycle.mjs';
import { validateArtifactMetadata } from './native-artifact-integrity.mjs';
import { privateFile } from './private-paths.mjs';

export const MAX_BACKUP_DATABASE_BYTES = 256 * 1024 * 1024;
const statuses = ['unconfigured','authorized','queued','running','succeeded','failed','cancelled','unknown'];
const tables = { jobs: ['app_id','job_id','context','state','version'], requests: ['app_id','job_id','request_key','fingerprint','result'],
  audit: ['sequence','app_id','job_id','version','status','event_type','created_at'], artifacts: ['app_id','job_id','artifact_id','metadata'] };
const invalid = () => { throw new Error('BUILD_BACKUP_DATABASE_INVALID'); };
function json(value) { try { const result=JSON.parse(value); if(!isRecord(result)) invalid();return result; }catch {invalid();} }
// Inspection is read-only: no migration, SQL imports, triggers or extension loading.
export async function inspectBackupDatabase(path, maxEntries) {
  await privateFile(path); const db = new DatabaseSync(path, { readOnly:true, allowExtension:false });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1500;');
    if (db.prepare('PRAGMA application_id').get().application_id !== 0x464c4f52 || db.prepare('PRAGMA user_version').get().user_version !== 1) throw new Error('BUILD_SCHEMA_UNSUPPORTED');
    const schema=db.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
    if(schema.length!==5 || schema.some(s=>s.type==='table' ? !Object.hasOwn(tables,s.name)||!/^CREATE TABLE\s/i.test(s.sql) : s.type!=='index'||s.name!=='audit_scope')) invalid();
    for(const [name,columns] of Object.entries(tables))
      if(JSON.stringify(db.prepare(`PRAGMA table_info(${name})`).all().map(c=>c.name))!==JSON.stringify(columns)) invalid();
    if(db.prepare('PRAGMA quick_check').all().some(r=>r.quick_check!=='ok') || db.prepare('PRAGMA foreign_key_check').all().length) invalid();
    const count=name=>db.prepare(`SELECT count(*) AS n FROM ${name}`).get().n;
    const jobCount=count('jobs'), artifactCount=count('artifacts');
    if(jobCount>maxEntries || artifactCount>maxEntries) throw new Error('BUILD_BACKUP_LIMIT');
    const states={}, jobs=new Map();
    for(const row of db.prepare('SELECT * FROM jobs ORDER BY app_id,job_id').all()) {
      const context=json(row.context), state=json(row.state), job={...context,...state};
      if(!isBuildId(row.app_id)||!isBuildId(row.job_id)||context.appId!==row.app_id||context.jobId!==row.job_id||state.appId!==row.app_id||state.jobId!==row.job_id
          || !Number.isSafeInteger(row.version)||row.version<0||row.version>=Number.MAX_SAFE_INTEGER||state.version!==row.version||!statuses.includes(state.status)
          ||!isBuildId(job.runnerId)||job.provider!=='local'||!['ios','android'].includes(job.platform)
          ||typeof job.repository!=='string'||!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(job.repository)||/\s/.test(job.repository)
          ||typeof job.sourceSha!=='string'||job.sourceSha.length!==40||!/^[a-f0-9]{40}$/.test(job.sourceSha)) invalid();
      const last=db.prepare('SELECT version,status FROM audit WHERE app_id=? AND job_id=? ORDER BY sequence DESC LIMIT 1').get(row.app_id,row.job_id);
      if(!last||last.version!==row.version||last.status!==state.status) invalid();
      states[state.status]=(states[state.status]??0)+1; jobs.set(JSON.stringify([row.app_id,row.job_id]),job);
    }
    if(['authorized','queued','running'].some(s=>states[s])) throw new Error('BUILD_BACKUP_NOT_QUIESCENT');
    const artifacts=[], covered=new Set();
    for(const row of db.prepare('SELECT * FROM artifacts ORDER BY app_id,job_id,artifact_id').all()) {
      const a=json(row.metadata),key=JSON.stringify([row.app_id,row.job_id]),job=jobs.get(key);
      if(!job||job.status!=='succeeded'||a.appId!==row.app_id||a.jobId!==row.job_id||a.artifactId!==row.artifact_id||typeof a.artifactId!=='string'||a.artifactId.length!==24||!/^[a-f0-9]{24}$/.test(a.artifactId)
          ||a.storage!=='local-only'||a.integrityVerified!==true||a.signatureVerified!==false||a.installVerified!==false||!(job.platform==='ios'?['ipa']:['apk','aab']).includes(a.format)) invalid();
      try { validateArtifactMetadata({manifest:a,expected:job,byteCount:a.byteCount}); } catch {invalid();}
      artifacts.push(a);covered.add(key);
    }
    if([...jobs.entries()].some(([k,j])=>j.status==='succeeded'&&!covered.has(k))) invalid();
    return { jobs:jobCount, artifacts, states, auditEvents:count('audit'), requests:count('requests') };
  } finally { db.close(); }
}
