import {OrgStore} from './store.js';
import {orgActions,orgAssert,orgId,safeInteger} from './types.js';
import type {OrgStorage,AuditIntent} from './types.js';
/** Append-only facts; remote results close only a previously durable intent. */
export class OrgAudit {
 constructor(private readonly storage:OrgStorage,private readonly store:OrgStore){}
 begin(input:Omit<AuditIntent,'id'|'state'>,now:number,fence:()=>void):AuditIntent {
  return this.store.atomic(()=>{fence();orgAssert(['human','runner','webhook','system'].includes(input.actor.kind)&&orgActions.includes(input.action),400,'INVALID_REQUEST');orgId(input.actor.id);if(input.appId)orgId(input.appId);if(input.membershipRevision!==undefined)safeInteger(input.membershipRevision);const intent:AuditIntent={...input,id:'operation_'+crypto.randomUUID(),state:'pending'};this.store.appendAudit(intent.id,'pending',intent,now);return intent});
 }
 settle(id:string,state:'completed'|'rejected'|'unknown',refs:Record<string,string>,now:number):void {
  this.store.atomic(()=>{orgId(id);orgAssert(['completed','rejected','unknown'].includes(state),400,'INVALID_REQUEST');
   const prior=this.storage.sql.exec<{phase:string}>('SELECT phase FROM flora_org_audit WHERE operation_id=? ORDER BY sequence DESC LIMIT 1',id).toArray()[0];orgAssert(prior,404,'NOT_FOUND');
   if(prior.phase===state)return;orgAssert(prior.phase==='pending',409,'REVISION_CONFLICT');
   orgAssert(Object.keys(refs).length<=8,400,'INVALID_REQUEST');for(const [k,v]of Object.entries(refs)){orgAssert(['appId','runnerId','jobId','deploymentId','credentialVersion','code'].includes(k),400,'INVALID_REQUEST');orgId(v)}
   this.store.appendAudit(id,state,{id,state,refs},now);
  });
 }
}
