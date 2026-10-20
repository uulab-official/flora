import type {RunnerCredential} from '@app-ops/dogfood';
import type {NativeRunnerCredential} from '../native-types.js';
import type {OrgStore} from './store.js';
import type {RunnerGate,GateReceipt} from './runner-gate.js';
import type {OrgCheckpoint} from './protocol.js';
import {assertProtocol} from './protocol.js';
import type {OrgPage,OrgPrincipal,OrgState} from './types.js';
import {orgAssert,safeInteger,utf8Bytes} from './types.js';
import type {RunnerAccess} from './runner-access.js';
export interface MigrationAdapters {otaPage(cursor:string|null):Promise<OrgPage<RunnerCredential>>;nativePage(cursor:string|null):Promise<OrgPage<NativeRunnerCredential&{ownerEpoch:number}>>}
export interface MigrationReceipt {phase:OrgState['mode'];revision:number;generation:number;linked:number;nextCursor:string|null;minProtocol:number;gate:GateReceipt|null;checkpoint:OrgCheckpoint}
type Progress={singleton:number;generation:number;operation_id:string;stage:'ota'|'native'|'done';cursor:string|null;linked:number};
const nativeGuardSQL=`CREATE TRIGGER flora_org_native_first_insert BEFORE INSERT ON flora_native_runners
   WHEN EXISTS(SELECT 1 FROM flora_org_state WHERE singleton=1 AND mode!='owner_only') BEGIN
   SELECT RAISE(ABORT,'org native issuance blocked') WHERE NOT EXISTS(
    SELECT 1 FROM flora_org_runner_access a JOIN flora_org_state s ON s.id=a.org_id
    WHERE s.singleton=1 AND s.mode IN('active','paused') AND a.kind='native' AND a.runner_id=NEW.id AND a.state='pending'
    AND json_type(a.app_ids)='array' AND json_array_length(a.app_ids)=1 AND json_extract(a.app_ids,'$[0]')=NEW.app_id
    AND json_type(a.platforms)='array' AND json_array_length(a.platforms)=1 AND json_extract(a.platforms,'$[0]')=NEW.platform
    AND a.owner_epoch=NEW.owner_epoch);
   END;`;
const normalized=(value:string)=>value.trim().replace(/\s+/g,' ').replace(/;$/,'');
function hasNative(storage:OrgStore['storage']){return storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='flora_native_runners'").toArray().length>0;}
function verifyNativeBarrier(storage:OrgStore['storage']){if(!hasNative(storage))return;const row=storage.sql.exec<{sql:string}>("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='flora_org_native_first_insert'").toArray()[0];orgAssert(row&&normalized(row.sql)===normalized(nativeGuardSQL),503,'RUNNER_NATIVE_BARRIER_UNAVAILABLE');}
export function installNativeBarrier(storage:OrgStore['storage']):void {if(!hasNative(storage))return;if(!storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='flora_org_native_first_insert'").toArray().length)storage.sql.exec(nativeGuardSQL);verifyNativeBarrier(storage);}
/** Resumable two-store barrier. Never rewrites an existing credential or job. */
export class OrgMigration {
 constructor(readonly store:OrgStore,private gate:RunnerGate,private adapters:MigrationAdapters,private access:RunnerAccess){
  store.storage.sql.exec("CREATE TABLE IF NOT EXISTS flora_org_migration(singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation INTEGER NOT NULL,operation_id TEXT NOT NULL,stage TEXT NOT NULL,cursor TEXT,linked INTEGER NOT NULL)");
 }
 private owner(actor:OrgPrincipal,revision?:number,stepup=false){this.access.authorize(actor,'org.manage',undefined,Date.now());if(stepup)this.access.requireReauth(actor,Date.now());if(revision!==undefined){safeInteger(revision);orgAssert(this.store.state().revision===revision,409,'REVISION_CONFLICT');}}
 private progress():Progress|undefined{return this.store.storage.sql.exec<Progress>('SELECT * FROM flora_org_migration WHERE singleton=1').toArray()[0]}
 checkpoint():OrgCheckpoint {const s=this.store.state(),audit=this.store.storage.sql.exec<{n:number}>('SELECT coalesce(max(sequence),0) n FROM flora_org_audit').one();return {schemaVersion:1,organizationId:s.id,ownerId:s.ownerId,dbIdentity:s.dbIdentity,origin:s.origin,minProtocol:s.minProtocol,revision:s.revision,orgAccessEpoch:s.orgAccessEpoch,auditSequence:audit.n,mode:s.mode,generation:this.progress()?.generation??0};}
 async read(actor:OrgPrincipal):Promise<MigrationReceipt>{this.owner(actor);const p=this.progress(),s=this.store.state();let gate:GateReceipt|null=null;if(p)gate=await this.gate.read();this.owner(actor);return {phase:s.mode,revision:s.revision,generation:p?.generation??0,linked:p?.linked??0,nextCursor:p&&p.stage!=='done'?p.stage+':'+(p.cursor??''):null,minProtocol:s.minProtocol,gate,checkpoint:this.checkpoint()};}
 private nativeBarrier(){installNativeBarrier(this.store.storage);}
 async prepare(actor:OrgPrincipal,expectedRevision:number):Promise<MigrationReceipt>{
  this.owner(actor,expectedRevision,true);const s=this.store.state();orgAssert(s.mode==='owner_only'||s.mode==='preparing',409,'ORG_MODE_CONFLICT');
  if(s.mode==='owner_only')this.store.atomic(()=>{this.owner(actor,expectedRevision,true);this.nativeBarrier();const p:Progress={singleton:1,generation:1,operation_id:'cutover_'+crypto.randomUUID(),stage:'ota',cursor:null,linked:0};this.store.charge(utf8Bytes(p));this.store.storage.sql.exec('INSERT INTO flora_org_migration VALUES(1,?,?,?,?,?)',p.generation,p.operation_id,p.stage,p.cursor,p.linked);this.store.storage.sql.exec("UPDATE flora_org_state SET mode='preparing' WHERE singleton=1");this.store.bumpRevision();this.event(actor,'preparing');});
  await this.store.storage.sync();this.owner(actor);const p=this.progress()!;const receipt=await this.gate.block(p.generation,p.operation_id);this.owner(actor);orgAssert(receipt.generation===p.generation,503,'RUNNER_GATE_UNAVAILABLE');return this.read(actor);
 }
 async step(actor:OrgPrincipal,expectedRevision:number):Promise<MigrationReceipt>{
  this.owner(actor,expectedRevision,true);orgAssert(this.store.state().mode==='preparing',409,'ORG_MODE_CONFLICT');const p=this.progress();orgAssert(p,503,'ORG_ACCESS_NOT_ACTIVE');
  const gate=await this.gate.block(p.generation,p.operation_id);this.owner(actor,expectedRevision,true);orgAssert(gate.generation===p.generation&&(p.stage==='done'||gate.phase==='blocked'),503,'RUNNER_GATE_UNAVAILABLE');
  if(p.stage==='done'){await this.gate.seal(p.generation);this.owner(actor,expectedRevision,true);return this.read(actor);}
  const page=p.stage==='ota'?await this.adapters.otaPage(p.cursor):await this.adapters.nativePage(p.cursor);this.owner(actor,expectedRevision,true);
  orgAssert(Array.isArray(page.items)&&page.items.length<=50&&(page.nextCursor===null||typeof page.nextCursor==='string'),503,'RUNNER_MIGRATION_INVALID');
  let after=p.cursor??'';
  for(const runner of page.items){orgAssert(runner.id>after,503,'RUNNER_MIGRATION_INVALID');after=runner.id;const apps='appIds'in runner?runner.appIds:[runner.appId];await this.access.verifyApplications(apps);this.owner(actor,expectedRevision,true);}
  orgAssert(page.nextCursor===null||page.items.length>0&&page.nextCursor===after,503,'RUNNER_MIGRATION_INVALID');
  this.store.atomic(()=>{this.owner(actor,expectedRevision,true);orgAssert(this.store.state().mode==='preparing',409,'ORG_MODE_CONFLICT');for(const runner of page.items)this.link(actor,p.stage as 'ota'|'native',runner);const next={...p,cursor:page.nextCursor,stage:page.nextCursor?p.stage:p.stage==='ota'?'native' as const:'done' as const,linked:p.linked+page.items.length};this.store.charge(utf8Bytes(next)-utf8Bytes(p));this.store.storage.sql.exec('UPDATE flora_org_migration SET stage=?,cursor=?,linked=? WHERE singleton=1',next.stage,next.cursor,next.linked);this.store.bumpRevision();this.event(actor,'reconciled');});
  return this.read(actor);
 }
 private link(actor:OrgPrincipal,kind:'ota'|'native',runner:RunnerCredential|(NativeRunnerCredential&{ownerEpoch:number})){
  const apps='appIds'in runner?runner.appIds:[runner.appId],platforms='platform'in runner?[runner.platform]:['ios','android'];orgAssert(Array.isArray(apps)&&apps.length>0&&apps.length<=100&&new Set(apps).size===apps.length&&runner.credentialEpoch>=1,503,'RUNNER_MIGRATION_INVALID');
  const row={kind,runner_id:runner.id,org_id:this.store.state().id,app_ids:JSON.stringify(apps),platforms:JSON.stringify(platforms),owner_mode:'organization',issuer_id:actor.userId,approver_id:null,sponsor_id:null,sponsor_auth_epoch:null,sponsor_revision:null,org_access_epoch:this.store.state().orgAccessEpoch,state:runner.revokedAt===null?'ready':'revoked',operation_id:this.progress()!.operation_id,created_at:Date.now(),owner_epoch:'ownerEpoch'in runner?runner.ownerEpoch:0};
  orgAssert(!this.store.storage.sql.exec('SELECT 1 FROM flora_org_runner_access WHERE kind=? AND runner_id=?',kind,runner.id).toArray().length,409,'RUNNER_MIGRATION_CONFLICT');this.store.charge(utf8Bytes(row));const keys=Object.keys(row);this.store.storage.sql.exec('INSERT INTO flora_org_runner_access('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')',...Object.values(row));
 }
 async activate(actor:OrgPrincipal,expectedRevision:number):Promise<OrgState>{this.owner(actor,expectedRevision,true);orgAssert(this.store.state().mode==='preparing'&&this.progress()?.stage==='done',409,'ORG_MODE_CONFLICT');verifyNativeBarrier(this.store.storage);const p=this.progress()!,gate=await this.gate.read();this.owner(actor,expectedRevision,true);orgAssert(gate.phase==='ledger_only'&&gate.generation===p.generation,503,'RUNNER_GATE_UNAVAILABLE');verifyNativeBarrier(this.store.storage);return this.transition(actor,expectedRevision,'active',false);}
 private event(actor:OrgPrincipal,state:string){this.store.appendAudit('migration_'+crypto.randomUUID(),'completed',{actor:{kind:'human',id:actor.userId},action:'org.manage',state},Date.now(),state==='paused');}
 private transition(actor:OrgPrincipal,revision:number,mode:'active'|'paused',bump:boolean){return this.store.atomic(()=>{this.owner(actor,revision,true);const s=this.store.state();assertProtocol(s.minProtocol,1);if(bump)safeInteger(s.orgAccessEpoch+1);this.store.storage.sql.exec('UPDATE flora_org_state SET mode=?,org_access_epoch=org_access_epoch+? WHERE singleton=1',mode,bump?1:0);this.store.bumpRevision();this.event(actor,mode);return this.store.state();});}
 pause(actor:OrgPrincipal,expectedRevision:number):OrgState{this.owner(actor,expectedRevision,true);orgAssert(this.store.state().mode==='active',409,'ORG_MODE_CONFLICT');return this.transition(actor,expectedRevision,'paused',true);}
 resume(actor:OrgPrincipal,expectedRevision:number):OrgState{this.owner(actor,expectedRevision,true);orgAssert(this.store.state().mode==='paused',409,'ORG_MODE_CONFLICT');return this.transition(actor,expectedRevision,'active',false);}
}
