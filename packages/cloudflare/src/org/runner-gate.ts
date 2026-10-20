import type {D1Database} from '@cloudflare/workers-types';
import {OrgFailure,orgAssert,orgId,safeInteger,storageIdentity} from './types.js';
export interface GateReceipt {ownerId:string;generation:number;phase:'blocked'|'ledger_only';protocol:1}
type GateRow={owner_id:string;generation:number;operation_id:string;phase:'blocked'|'ledger_only';protocol:1};
const guardName='flora_org_runner_first_insert';
// Exact protocol-1 barrier, compared with the installed trigger before issuance.
const guardSQL=`CREATE TRIGGER flora_org_runner_first_insert BEFORE INSERT ON automation_runners WHEN NEW.version=1 AND EXISTS(SELECT 1 FROM flora_org_runner_gate WHERE owner_id=NEW.owner_id)
BEGIN
 SELECT RAISE(ABORT,'org runner issuance blocked') WHERE NOT EXISTS(
  SELECT 1 FROM flora_org_runner_gate g JOIN flora_org_runner_reservations r ON r.owner_id=g.owner_id AND r.generation=g.generation
  WHERE g.owner_id=NEW.owner_id AND g.phase='ledger_only' AND g.protocol=1 AND r.runner_id=NEW.id AND r.consumed_at IS NULL
  AND r.expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  AND json_type(NEW.data,'$.appIds')='array' AND json_array_length(NEW.data,'$.appIds')=json_array_length(r.app_ids)
  AND r.app_ids=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(NEW.data,'$.appIds') ORDER BY value))
 );
 UPDATE flora_org_runner_reservations SET consumed_at=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) WHERE owner_id=NEW.owner_id AND runner_id=NEW.id AND consumed_at IS NULL;
END;`;
const normalized=(sql:string)=>sql.trim().replace(/\s+/g,' ').replace(/;$/,'');
const clockSQL="CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
const receipt=(row:GateRow):GateReceipt=>({ownerId:row.owner_id,generation:row.generation,phase:row.phase,protocol:row.protocol});
/** New control rows only; construction never initializes schema or opens a gate. */
export class RunnerGate {
 constructor(private readonly db:D1Database,private readonly ownerId:string){storageIdentity(ownerId)}
 private async context(){
  try{
   const results=await this.db.batch([
    this.db.prepare('SELECT owner_id,'+clockSQL+' now FROM flora_deployment WHERE singleton=1'),
    this.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").bind(guardName),
    this.db.prepare('SELECT * FROM flora_org_runner_gate WHERE owner_id=?').bind(this.ownerId),
   ]);
   const owner=results[0]?.results[0] as {owner_id:string;now:number}|undefined,guard=results[1]?.results[0] as {sql:string}|undefined,row=results[2]?.results[0] as GateRow|undefined;
   orgAssert(owner?.owner_id===this.ownerId&&guard&&normalized(guard.sql)===normalized(guardSQL),503,'RUNNER_GATE_UNAVAILABLE');safeInteger(owner.now);
   if(row)orgAssert(row.owner_id===this.ownerId&&row.protocol===1&&['blocked','ledger_only'].includes(row.phase),503,'RUNNER_GATE_UNAVAILABLE');
   return {row,sql:guard.sql,now:owner.now};
  }catch(error){if(error instanceof OrgFailure)throw error;throw new OrgFailure(503,'RUNNER_GATE_UNAVAILABLE')}
 }
 private async run<T>(run:()=>Promise<T>):Promise<T>{try{return await run()}catch(error){if(error instanceof OrgFailure)throw error;if(error instanceof Error&&/SQLITE_CONSTRAINT|org runner/.test(error.message))throw new OrgFailure(409,'RUNNER_GATE_CONFLICT');throw new OrgFailure(503,'RUNNER_GATE_UNAVAILABLE')}}
 async read():Promise<GateReceipt>{const {row}=await this.context();orgAssert(row,409,'RUNNER_GATE_MISSING');return receipt(row)}
 async block(generation:number,operationId:string):Promise<GateReceipt>{
  safeInteger(generation);orgId(operationId);const context=await this.context();
  if(context.row){orgAssert(context.row.generation===generation&&context.row.operation_id===operationId,409,'RUNNER_GATE_CONFLICT');return receipt(context.row)}
  const results=await this.run(()=>this.db.batch([
   this.db.prepare(`INSERT INTO flora_org_runner_gate(owner_id,generation,operation_id,phase,protocol)
    SELECT ?,?,?,'blocked',1 WHERE EXISTS(SELECT 1 FROM flora_deployment WHERE singleton=1 AND owner_id=?)
    AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=? AND sql=?) AND NOT EXISTS(SELECT 1 FROM flora_org_runner_gate WHERE owner_id=?)`).bind(this.ownerId,generation,operationId,this.ownerId,guardName,context.sql,this.ownerId),
   this.db.prepare('SELECT * FROM flora_org_runner_gate WHERE owner_id=?').bind(this.ownerId),
  ]));
  const row=results[1]?.results[0] as GateRow|undefined;orgAssert(row&&row.generation===generation&&row.operation_id===operationId,409,'RUNNER_GATE_CONFLICT');return receipt(row);
 }
 async seal(generation:number):Promise<GateReceipt>{
  safeInteger(generation);const context=await this.context();orgAssert(context.row?.generation===generation,409,'RUNNER_GATE_CONFLICT');
  if(context.row.phase==='ledger_only')return receipt(context.row);
  const results=await this.run(()=>this.db.batch([
   this.db.prepare("UPDATE flora_org_runner_gate SET phase='ledger_only' WHERE owner_id=? AND generation=? AND phase='blocked' AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=? AND sql=?)").bind(this.ownerId,generation,guardName,context.sql),
   this.db.prepare('SELECT * FROM flora_org_runner_gate WHERE owner_id=?').bind(this.ownerId),
  ]));const row=results[1]?.results[0] as GateRow|undefined;orgAssert(row?.generation===generation&&row.phase==='ledger_only',409,'RUNNER_GATE_CONFLICT');return receipt(row);
 }
 async reserve(input:{runnerId:string;operationId:string;appIds:string[];generation:number}):Promise<void>{
  orgId(input.runnerId);orgId(input.operationId);safeInteger(input.generation);orgAssert(Array.isArray(input.appIds)&&input.appIds.length>0&&input.appIds.length<=100&&new Set(input.appIds).size===input.appIds.length,400,'INVALID_REQUEST');
  const {runnerId,operationId,generation}=input,appIds=[...input.appIds].sort();for(const app of appIds)orgAssert(typeof app==='string'&&/^[a-z][a-z0-9_-]{2,95}$/.test(app),400,'INVALID_REQUEST');const apps=JSON.stringify(appIds);
  const context=await this.context();orgAssert(context.row?.generation===generation&&context.row.phase==='ledger_only',409,'RUNNER_ACCESS_NOT_READY');
  const expires=context.now+600000;safeInteger(expires);orgAssert(new TextEncoder().encode(JSON.stringify([this.ownerId,runnerId,operationId,apps,generation,expires,Number.MAX_SAFE_INTEGER])).length<=2048,413,'INPUT_TOO_LARGE');
  const found=await this.db.prepare('SELECT * FROM flora_org_runner_reservations WHERE owner_id=? AND (runner_id=? OR operation_id=?)').bind(this.ownerId,runnerId,operationId).first<{runner_id:string;operation_id:string;app_ids:string;generation:number;expires_at:number;consumed_at:number|null}>();
  if(found){orgAssert(found.runner_id===runnerId&&found.operation_id===operationId&&found.app_ids===apps&&found.generation===generation&&found.expires_at>context.now&&found.consumed_at===null,409,'RUNNER_GATE_CONFLICT');return;}
  const results=await this.run(()=>this.db.batch([
   this.db.prepare(`DELETE FROM flora_org_runner_reservations WHERE owner_id=? AND runner_id IN(SELECT runner_id FROM flora_org_runner_reservations WHERE owner_id=? AND consumed_at IS NULL AND expires_at<=${clockSQL} ORDER BY expires_at,runner_id LIMIT 50)`).bind(this.ownerId,this.ownerId),
   this.db.prepare(`INSERT INTO flora_org_runner_reservations(owner_id,runner_id,operation_id,app_ids,generation,expires_at,consumed_at)
    SELECT ?,?,?,?,?,?,NULL WHERE EXISTS(SELECT 1 FROM flora_org_runner_gate WHERE owner_id=? AND generation=? AND phase='ledger_only' AND protocol=1)
    AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=? AND sql=?)
    AND (SELECT count(*) FROM applications WHERE owner_id=? AND id IN(SELECT value FROM json_each(?)))=?`).bind(this.ownerId,runnerId,operationId,apps,generation,expires,this.ownerId,generation,guardName,context.sql,this.ownerId,apps,appIds.length),
  ]));orgAssert(results[1]?.meta.changes===1,409,'RUNNER_GATE_CONFLICT');
 }
}
