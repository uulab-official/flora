import {storageIdentity} from './types.js';
import {createOrgSchema} from './schema.js';
import {OrgFailure,defaultOrgLimits,normalizeOwnerEmail,orgAssert,orgId,safeInteger,utf8Bytes} from './types.js';
import type {OrgBinding,OrgLimits,OrgStorage,OrgState,OrgMemberState,OrgPrincipal,MembershipInput,OrgRole} from './types.js';
export type OrgStateRow = {id:string;owner_id:string;db_identity:string;origin:string;owner_email:string;display_name:string;mode:OrgState['mode'];revision:number;org_access_epoch:number;min_protocol:number;metadata_bytes:number;audit_bytes:number;safety_bytes:number}
export class OrgStore {
 readonly limits:Readonly<OrgLimits>;
 constructor(readonly storage:OrgStorage,readonly binding:OrgBinding,limits:OrgLimits=defaultOrgLimits) {
  storageIdentity(binding.ownerId);storageIdentity(binding.dbIdentity);normalizeOwnerEmail(binding.ownerEmail);
  safeInteger(limits.metadataBytes);safeInteger(limits.auditBytes);this.limits=Object.freeze({...limits});
  this.atomic(()=>{createOrgSchema(storage);const row=this.storage.sql.exec<OrgStateRow>('SELECT * FROM flora_org_state WHERE singleton=1').toArray()[0];if(row)this.checkBinding(row);});
 }
 atomic<T>(action:()=>T):T {try{return this.storage.transactionSync(action)}catch(e){if(e instanceof OrgFailure)throw e;throw new OrgFailure(503,'ORG_ACCESS_NOT_ACTIVE')}}
 row():OrgStateRow {const row=this.storage.sql.exec<OrgStateRow>('SELECT * FROM flora_org_state WHERE singleton=1').toArray()[0];orgAssert(row,503,'ORG_ACCESS_NOT_ACTIVE');this.checkBinding(row);return row}
 private checkBinding(row:OrgStateRow):void {orgAssert(row.owner_id===this.binding.ownerId&&row.db_identity===this.binding.dbIdentity&&row.origin===this.binding.origin&&row.owner_email===normalizeOwnerEmail(this.binding.ownerEmail),503,'ORG_ACCESS_NOT_ACTIVE')}
 state():OrgState {const r=this.row();return {id:r.id,ownerId:r.owner_id,dbIdentity:r.db_identity,origin:r.origin,mode:r.mode,revision:r.revision,orgAccessEpoch:r.org_access_epoch,minProtocol:r.min_protocol}}
 bootstrap(owner:{epoch:number;claimed:boolean},now:number):OrgState {
  safeInteger(owner.epoch,0);safeInteger(now,0);
  return this.atomic(()=>{
   const old=this.storage.sql.exec<OrgStateRow>('SELECT * FROM flora_org_state WHERE singleton=1').toArray()[0];
   if(old)this.checkBinding(old);else this.storage.sql.exec("INSERT INTO flora_org_state(singleton,id,owner_id,db_identity,origin,owner_email,display_name,schema_version,min_protocol,mode,revision,org_access_epoch) VALUES(1,?,?,?,?,?,?,1,1,'owner_only',1,1)",'org_'+crypto.randomUUID(),this.binding.ownerId,this.binding.dbIdentity,this.binding.origin,normalizeOwnerEmail(this.binding.ownerEmail),this.binding.workspaceName??'Flora');
   if(owner.claimed){
    orgAssert(owner.epoch>0,503,'ORG_ACCESS_NOT_ACTIVE');
    const existing=this.storage.sql.exec<{id:string}>("SELECT id FROM flora_org_users WHERE auth_source='legacy_owner'").toArray()[0];
    if(!existing){
     const userId='user_'+crypto.randomUUID(),membershipId='membership_'+crypto.randomUUID(),email=normalizeOwnerEmail(this.binding.ownerEmail);
     this.charge(utf8Bytes({id:userId,email,display_name:'Owner',auth_source:'legacy_owner',status:'active',auth_epoch:1})+utf8Bytes({id:membershipId,org_id:this.row().id,user_id:userId,role:'owner',status:'active',revision:1}));
     this.storage.sql.exec("INSERT INTO flora_org_users(id,email,display_name,auth_source,status,auth_epoch) VALUES(?,?,'Owner','legacy_owner','active',1)",userId,email);
     this.storage.sql.exec("INSERT INTO flora_org_memberships(id,org_id,user_id,role,status,revision) VALUES(?,?,?,'owner','active',1)",membershipId,this.row().id,userId);
    }
   }
   return this.state();
  });
 }
 charge(metadataDelta:number,auditDelta=0,safetyDelta=0,contraction=false):void {
  const row=this.row();for(const n of [metadataDelta,auditDelta,safetyDelta])orgAssert(Number.isSafeInteger(n),503,'ORG_ACCESS_NOT_ACTIVE');
  orgAssert(row.metadata_bytes+metadataDelta>=0&&(metadataDelta<=0||contraction||row.metadata_bytes+metadataDelta<=this.limits.metadataBytes)&&row.audit_bytes+auditDelta>=0&&(auditDelta<=0||row.audit_bytes+auditDelta<=this.limits.auditBytes)&&row.safety_bytes+safetyDelta>=0&&row.safety_bytes+safetyDelta<=1_048_576,409,'ORG_ACCESS_CAPACITY');
  this.storage.sql.exec('UPDATE flora_org_state SET metadata_bytes=metadata_bytes+?,audit_bytes=audit_bytes+?,safety_bytes=safety_bytes+? WHERE singleton=1',metadataDelta,auditDelta,safetyDelta);
 }
 member(userId:string):OrgMemberState|null {
  const r=this.storage.sql.exec<{authSource:'legacy_owner'|'member';userId:string;membershipId:string;role:OrgRole;userStatus:'active'|'disabled';membershipStatus:'active'|'disabled';authEpoch:number;membershipRevision:number}>('SELECT u.auth_source AS authSource,u.id AS userId,m.id AS membershipId,m.role,u.status AS userStatus,m.status AS membershipStatus,u.auth_epoch AS authEpoch,m.revision AS membershipRevision FROM flora_org_users u JOIN flora_org_memberships m ON m.user_id=u.id WHERE u.id=? AND m.org_id=?',userId,this.row().id).toArray()[0];return r??null;
 }
 assertActor(actor:OrgPrincipal,now:number):OrgMemberState {
  const s=this.state(),m=this.member(actor.userId);
  safeInteger(actor.expiresAt);orgAssert(actor.organizationId===s.id&&!!m&&m.membershipId===actor.membershipId&&m.role===actor.role&&m.userStatus==='active'&&m.membershipStatus==='active'&&m.authEpoch===actor.authEpoch&&m.membershipRevision===actor.membershipRevision&&m.authSource===actor.authSource&&(m.role==='owner'?m.authSource==='legacy_owner':m.authSource==='member')&&actor.expiresAt>now,403,'MEMBERSHIP_CHANGED');return m!;
 }
 setAccess(actor:OrgPrincipal,userId:string,input:MembershipInput,now:number):void {
  this.atomic(()=>{
   const member=this.member(userId);orgAssert(member,404,'NOT_FOUND');orgAssert(member.role!=='owner',409,'BOOTSTRAP_OWNER_PROTECTED');
   this.assertActor(actor,now);orgAssert(actor.role==='owner');safeInteger(input.expectedRevision);
   orgAssert(member.membershipRevision===input.expectedRevision,409,'REVISION_CONFLICT');orgAssert(['admin','deployer','viewer'].includes(input.role),400,'INVALID_REQUEST');
   orgAssert(Array.isArray(input.addAppIds)&&Array.isArray(input.removeAppIds)&&input.addAppIds.length+input.removeAppIds.length<=100,400,'INVALID_REQUEST');
   const all=[...input.addAppIds,...input.removeAppIds];all.forEach(orgId);orgAssert(new Set(all).size===all.length,400,'INVALID_REQUEST');
   const m=this.storage.sql.exec<{id:string}>('SELECT id FROM flora_org_memberships WHERE user_id=?',userId).one();
   const before=this.storage.sql.exec('SELECT * FROM flora_org_app_access WHERE membership_id=? ORDER BY app_id',m.id).toArray();
   const beforeMembership=this.storage.sql.exec('SELECT * FROM flora_org_memberships WHERE id=?',m.id).one();const revision=this.state().revision;
   for(const app of input.addAppIds)this.storage.sql.exec('INSERT INTO flora_org_app_access VALUES(?,?,1) ON CONFLICT(membership_id,app_id) DO UPDATE SET active=1',m.id,app);
   for(const app of input.removeAppIds)this.storage.sql.exec('UPDATE flora_org_app_access SET active=0 WHERE membership_id=? AND app_id=?',m.id,app);
   const after=this.storage.sql.exec('SELECT * FROM flora_org_app_access WHERE membership_id=? ORDER BY app_id',m.id).toArray();
   const expansion=input.addAppIds.length>0||({viewer:0,deployer:1,admin:2}[input.role]>({viewer:0,deployer:1,admin:2}[member.role as Exclude<OrgRole,'owner'>]));
   // Contractions bypass ordinary metadata/audit budgets but retain bounded durable evidence.
   this.charge(utf8Bytes(after)-utf8Bytes(before),0,0,!expansion);
   this.storage.sql.exec('UPDATE flora_org_memberships SET role=?,revision=revision+1 WHERE id=? AND revision<9007199254740991',input.role,m.id);
   orgAssert(this.member(userId)!.membershipRevision===input.expectedRevision+1,409,'REVISION_CONFLICT');
   this.charge(utf8Bytes(this.storage.sql.exec('SELECT * FROM flora_org_memberships WHERE id=?',m.id).one())-utf8Bytes(beforeMembership),0,0,!expansion);
   this.storage.sql.exec('UPDATE flora_org_state SET revision=revision+1 WHERE singleton=1 AND revision<9007199254740991');
   orgAssert(this.state().revision===revision+1,409,'REVISION_CONFLICT');
   this.appendAudit('access_'+crypto.randomUUID(),'completed',{actor:{kind:'human',id:actor.userId},action:'org.manage',targetUserId:userId,membershipRevision:input.expectedRevision+1},now,!expansion);
  });
 }
 bumpRevision():void {const before=this.state().revision;safeInteger(before+1);this.storage.sql.exec('UPDATE flora_org_state SET revision=revision+1 WHERE singleton=1');}
 disable(actor:OrgPrincipal,userId:string,expectedRevision:number,now:number):void {
  this.atomic(()=>{
   this.assertActor(actor,now);orgAssert(actor.role==='owner');safeInteger(expectedRevision);const target=this.member(userId);orgAssert(target,404,'NOT_FOUND');orgAssert(target.role!=='owner'&&target.authSource!=='legacy_owner',409,'BOOTSTRAP_OWNER_PROTECTED');orgAssert(target.membershipRevision===expectedRevision,409,'REVISION_CONFLICT');
   if(target.userStatus==='disabled'&&target.membershipStatus==='disabled')return;
   safeInteger(target.authEpoch+1);safeInteger(target.membershipRevision+1);
   const measure=()=>utf8Bytes(this.storage.sql.exec('SELECT * FROM flora_org_users WHERE id=?',userId).one())+utf8Bytes(this.storage.sql.exec('SELECT * FROM flora_org_memberships WHERE id=?',target.membershipId).one())+utf8Bytes(this.storage.sql.exec('SELECT * FROM flora_org_sessions WHERE user_id=? ORDER BY sequence',userId).toArray());const before=measure();
   this.storage.sql.exec("UPDATE flora_org_users SET status='disabled',auth_epoch=auth_epoch+1 WHERE id=?",userId);this.storage.sql.exec("UPDATE flora_org_memberships SET status='disabled',revision=revision+1 WHERE id=?",target.membershipId);this.storage.sql.exec('DELETE FROM flora_org_sessions WHERE user_id=?',userId);this.charge(measure()-before,0,0,true);this.bumpRevision();this.appendAudit('disable_'+crypto.randomUUID(),'completed',{actor:{kind:'human',id:actor.userId},action:'member-disabled',targetUserId:userId,membershipRevision:target.membershipRevision+1},now,true);
  });
 }
 appendAudit(operationId:string,phase:string,data:unknown,now:number,safety=false):void {
  const payload=JSON.stringify(data);const bytes=utf8Bytes({operation_id:operationId,phase,data:payload,created_at:now,safety:safety?1:0});orgAssert(bytes<=2048,409,'ORG_ACCESS_CAPACITY');const reserve=safety&&this.row().audit_bytes+bytes>this.limits.auditBytes;this.charge(0,reserve?0:bytes,reserve?bytes:0);
  this.storage.sql.exec('INSERT INTO flora_org_audit(operation_id,phase,data,created_at,safety) VALUES(?,?,?,?,?)',operationId,phase,payload,now,reserve?1:0);
 }
}
