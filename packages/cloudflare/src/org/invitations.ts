import {Buffer} from 'node:buffer';
import {createPasswordVerifier,validPassword} from '../auth/password.js';
import type {PasswordVerifierV1} from '../auth/password.js';
import {OrgStore} from './store.js';
import {OrgPolicy} from './policy.js';
import {MemberAuth} from './member-auth.js';
import type {MemberSessionResult} from './member-auth.js';
import {OrgFailure,normalizeEmail,normalizeOwnerEmail,orgAssert,orgId,orgLabel,safeInteger,utf8Bytes} from './types.js';
import type {InvitationInput,OrgPrincipal,OrgRole} from './types.js';
type InviteRow={id:string;nonce_hash:string;email:string;purpose:'invite'|'reset'|'reactivate';target_user_id:string|null;auth_epoch:number|null;membership_revision:number|null;user_status:string|null;membership_status:string|null;issuer_id:string;owner_epoch:number;purpose_generation:number;role:Exclude<OrgRole,'owner'>|null;app_ids:string|null;expires_at:number;consumed_at:number|null;revoked_at:number|null;created_at:number};
export class InvitationService {
 private readonly policy:OrgPolicy;
 constructor(readonly store:OrgStore,readonly auth:MemberAuth,readonly verifyApps:(appIds:readonly string[])=>Promise<void>){this.policy=new OrgPolicy(store)}
 owner(actor:OrgPrincipal,now:number):void {this.policy.require(actor,'org.manage',undefined,now);this.auth.requireReauth(actor,now);orgAssert(this.store.state().mode==='active',503,'ORG_ACCESS_NOT_ACTIVE')}
 private userByEmail(email:string){return this.store.storage.sql.exec<{id:string;auth_source:string}>('SELECT id,auth_source FROM flora_org_users WHERE email=?',email).toArray()[0]}
 private currentGeneration(email:string,purpose:string):number{return this.store.storage.sql.exec<{generation:number}>('SELECT coalesce(max(purpose_generation),0) AS generation FROM flora_org_invites WHERE email=? AND purpose=?',email,purpose).one().generation}
 private apps(input:unknown):string[]{orgAssert(Array.isArray(input)&&input.length<=100,400,'INVALID_REQUEST');input.forEach(orgId);orgAssert(new Set(input).size===input.length,400,'INVALID_REQUEST');return [...input].sort()}
 private target(input:InvitationInput,email:string){
  const existing=this.userByEmail(email);
  if(input.purpose==='invite'){orgAssert(!existing,409,'REVISION_CONFLICT');orgAssert(input.targetUserId===undefined,400,'INVALID_REQUEST');orgAssert(this.store.state().revision===input.expectedRevision,409,'REVISION_CONFLICT');return null}
  orgAssert(existing&&existing.id===input.targetUserId&&existing.auth_source==='member',409,'REVISION_CONFLICT');
  const member=this.store.member(existing.id);orgAssert(member&&member.membershipRevision===input.expectedRevision,409,'REVISION_CONFLICT');
  orgAssert(input.purpose==='reset'?member.userStatus==='active'&&member.membershipStatus==='active':member.userStatus==='disabled'&&member.membershipStatus==='disabled',409,'REVISION_CONFLICT');return member;
 }
 private async hash(nonce:string):Promise<string>{
  orgAssert(typeof nonce==='string'&&/^[A-Za-z0-9_-]{43}$/.test(nonce),403,'INVITE_UNAVAILABLE');const bytes=Buffer.from(nonce,'base64url');orgAssert(bytes.length===32&&bytes.toString('base64url')===nonce,403,'INVITE_UNAVAILABLE');
  try{return Buffer.from(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes))).toString('hex')}catch{throw new OrgFailure(503,'AUTH_UNAVAILABLE')}
 }
 private available(hash:string,now:number):InviteRow {
  const r=this.store.storage.sql.exec<InviteRow>('SELECT * FROM flora_org_invites WHERE nonce_hash=?',hash).toArray()[0];
  orgAssert(r&&this.store.state().mode==='active'&&this.auth.options.owner().verifier!==null&&r.expires_at>now&&r.consumed_at===null&&r.revoked_at===null&&r.owner_epoch===this.auth.options.owner().epoch&&r.purpose_generation===this.currentGeneration(r.email,r.purpose),403,'INVITE_UNAVAILABLE');
  if(r.purpose==='invite')orgAssert(!this.userByEmail(r.email),403,'INVITE_UNAVAILABLE');
  else {const user=this.userByEmail(r.email),m=user?this.store.member(user.id):null;orgAssert(user?.id===r.target_user_id&&user.auth_source==='member'&&m&&m.authEpoch===r.auth_epoch&&m.membershipRevision===r.membership_revision&&m.userStatus===r.user_status&&m.membershipStatus===r.membership_status&&(r.purpose==='reset'?m.userStatus==='active'&&m.membershipStatus==='active':m.userStatus==='disabled'&&m.membershipStatus==='disabled'),403,'INVITE_UNAVAILABLE')}
  return r;
 }
 async issue(actor:OrgPrincipal,input:InvitationInput,now:number):Promise<{id:string;nonce:string;expiresAt:number;revision:number}>{
  this.owner(actor,now);safeInteger(input.expectedRevision);orgAssert(['invite','reset','reactivate'].includes(input.purpose),400,'INVALID_REQUEST');const email=normalizeEmail(input.email);
  orgAssert(email!==normalizeOwnerEmail(this.store.binding.ownerEmail),409,'BOOTSTRAP_OWNER_PROTECTED');
  const keys=Object.keys(input),allowed=input.purpose==='reset'?['purpose','email','targetUserId','expectedRevision']:['purpose','email','targetUserId','expectedRevision','role','appIds'];orgAssert(keys.every(k=>allowed.includes(k)),400,'INVALID_REQUEST');
  if(input.purpose==='reset')orgAssert(input.role===undefined&&input.appIds===undefined,400,'INVALID_REQUEST');else orgAssert(['admin','deployer','viewer'].includes(input.role!),400,'INVALID_REQUEST');
  const appIds=input.purpose==='reset'?[]:this.apps(input.appIds??[]);this.target(input,email);
  if(appIds.length)await this.verifyApps(appIds);this.owner(actor,this.auth.options.now());this.target(input,email);
  const nonce=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),hash=await this.hash(nonce);
  return this.store.atomic(()=>{
   const current=this.auth.options.now();this.owner(actor,current);const target=this.target(input,email),generation=this.currentGeneration(email,input.purpose)+1;safeInteger(generation);
   const row:InviteRow={id:'invite_'+crypto.randomUUID(),nonce_hash:hash,email,purpose:input.purpose,target_user_id:target?.userId??null,auth_epoch:target?.authEpoch??null,membership_revision:target?.membershipRevision??null,user_status:target?.userStatus??null,membership_status:target?.membershipStatus??null,issuer_id:actor.userId,owner_epoch:actor.ownerEpoch,purpose_generation:generation,role:input.purpose==='reset'?null:input.role!,app_ids:input.purpose==='reset'?null:JSON.stringify(appIds),expires_at:current+(input.purpose==='reset'?900_000:86_400_000),consumed_at:null,revoked_at:null,created_at:current};
   this.store.charge(utf8Bytes(row));this.store.storage.sql.exec('INSERT INTO flora_org_invites(id,nonce_hash,email,purpose,target_user_id,auth_epoch,membership_revision,user_status,membership_status,issuer_id,owner_epoch,purpose_generation,role,app_ids,expires_at,consumed_at,revoked_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',...Object.values(row));
   this.store.bumpRevision();this.store.appendAudit(row.id,'issued',{actor:{kind:'human',id:actor.userId},action:'invitation-issued',purpose:row.purpose,invitationId:row.id,generation},current);
   return {id:row.id,nonce,expiresAt:row.expires_at,revision:generation};
  });
 }
 async preview(nonce:string,now:number):Promise<{organizationName:string;maskedEmail:string;role:OrgRole;appCount:number}>{
  const hash=await this.hash(nonce),row=this.available(hash,this.auth.options.now());const target=row.target_user_id?this.store.member(row.target_user_id):null;
  const appCount=row.app_ids?JSON.parse(row.app_ids).length:this.store.storage.sql.exec<{count:number}>('SELECT count(*) AS count FROM flora_org_app_access WHERE membership_id=? AND active=1',target!.membershipId).one().count;
  const [local,domain]=row.email.split('@');return {organizationName:this.store.row().display_name,maskedEmail:local!.slice(0,1)+'***@'+domain,role:row.role??target!.role,appCount};
 }
 async accept(input:{nonce:string;email:string;password:string;confirmation:string},now:number):Promise<MemberSessionResult>{
  const hash=await this.hash(input.nonce),initial=this.available(hash,this.auth.options.now());let email:string;try{email=normalizeEmail(input.email)}catch{throw new OrgFailure(403,'INVITE_UNAVAILABLE')}
  orgAssert(email===initial.email,403,'INVITE_UNAVAILABLE');const minimum=this.auth.options.minimum();orgAssert(input.password===input.confirmation&&validPassword(input.password,minimum),400,'INVALID_PASSWORD');
  const apps: string[]=initial.app_ids?JSON.parse(initial.app_ids):[];
  const validateApps=async()=>{if(apps.length)try{await this.verifyApps(apps)}catch{throw new OrgFailure(403,'INVITE_UNAVAILABLE')}};
  await validateApps();this.available(hash,this.auth.options.now());
  return this.auth.withKdf(initial.target_user_id?'user:'+initial.target_user_id:'invite:'+initial.id,1,async()=>{
   this.available(hash,this.auth.options.now());let verifier:PasswordVerifierV1;try{verifier=await createPasswordVerifier(input.password,minimum)}catch{throw new OrgFailure(503,'AUTH_UNAVAILABLE')}
   this.available(hash,this.auth.options.now());const candidate=await this.auth.newSession(this.auth.options.now());await validateApps();
   return this.store.atomic(()=>{
    const current=this.auth.options.now(),row=this.available(hash,current);orgAssert(this.auth.options.minimum()===minimum,503,'AUTH_UNAVAILABLE');
    let userId=row.target_user_id,membershipId:string;
    if(row.purpose==='invite'){
     userId='user_'+crypto.randomUUID();membershipId='membership_'+crypto.randomUUID();const name=email.split('@')[0]!.slice(0,80);orgLabel(name);
     this.store.storage.sql.exec("INSERT INTO flora_org_users VALUES(?,?,?,'member','active',1)",userId,email,name);
     this.store.storage.sql.exec("INSERT INTO flora_org_memberships VALUES(?,?,?,?,'active',1)",membershipId,this.store.state().id,userId,row.role!);
     this.store.storage.sql.exec('INSERT INTO flora_org_passwords VALUES(?,?)',userId,JSON.stringify(verifier));
     for(const app of apps)this.store.storage.sql.exec('INSERT INTO flora_org_app_access VALUES(?,?,1)',membershipId,app);
     this.store.charge(utf8Bytes(this.store.storage.sql.exec('SELECT * FROM flora_org_users WHERE id=?',userId).one())+utf8Bytes(this.store.storage.sql.exec('SELECT * FROM flora_org_memberships WHERE id=?',membershipId).one())+utf8Bytes(this.store.storage.sql.exec('SELECT * FROM flora_org_passwords WHERE user_id=?',userId).one())+utf8Bytes(this.store.storage.sql.exec('SELECT * FROM flora_org_app_access WHERE membership_id=?',membershipId).toArray())-utf8Bytes([]));
    }else{
     const member=this.store.member(userId!)!;membershipId=member.membershipId;safeInteger(member.authEpoch+1);safeInteger(member.membershipRevision+1);
     const before=this.targetBytes(userId!,membershipId);
     this.store.storage.sql.exec('UPDATE flora_org_users SET status=\'active\',auth_epoch=auth_epoch+1 WHERE id=?',userId);
     this.store.storage.sql.exec('UPDATE flora_org_memberships SET status=\'active\',revision=revision+1 WHERE id=?',membershipId);
     this.store.storage.sql.exec('UPDATE flora_org_passwords SET verifier=? WHERE user_id=?',JSON.stringify(verifier),userId);
     this.store.storage.sql.exec('DELETE FROM flora_org_sessions WHERE user_id=?',userId);
     if(row.purpose==='reactivate'){
      this.store.storage.sql.exec('UPDATE flora_org_memberships SET role=? WHERE id=?',row.role,membershipId);
      this.store.storage.sql.exec('UPDATE flora_org_app_access SET active=0 WHERE membership_id=?',membershipId);
      for(const app of apps)this.store.storage.sql.exec('INSERT INTO flora_org_app_access VALUES(?,?,1) ON CONFLICT(membership_id,app_id) DO UPDATE SET active=1',membershipId,app);
     }
     this.store.charge(this.targetBytes(userId!,membershipId)-before,0,0,row.purpose==='reset');
    }
    const oldBytes=utf8Bytes(row);this.store.storage.sql.exec('UPDATE flora_org_invites SET consumed_at=? WHERE id=? AND consumed_at IS NULL',current,row.id);row.consumed_at=current;this.store.charge(utf8Bytes(row)-oldBytes,0,0,row.purpose==='reset');
    const principal=this.auth.createSession(userId!,candidate,row.owner_epoch,current);
    this.store.bumpRevision();this.store.appendAudit(row.id,'accepted',{actor:{kind:'human',id:userId!},action:'invitation-accepted',purpose:row.purpose,invitationId:row.id},current);
    return {session:{sessionHash:candidate.sessionHash,csrfHash:candidate.csrfHash,expiresAt:candidate.expiresAt},principal,sessionToken:candidate.sessionToken,csrfToken:candidate.csrfToken};
   });
  });
 }
 private targetBytes(userId:string,membershipId:string):number{
  const sql=this.store.storage.sql;return utf8Bytes(sql.exec('SELECT * FROM flora_org_users WHERE id=?',userId).one())+utf8Bytes(sql.exec('SELECT * FROM flora_org_memberships WHERE id=?',membershipId).one())+utf8Bytes(sql.exec('SELECT * FROM flora_org_passwords WHERE user_id=?',userId).one())+utf8Bytes(sql.exec('SELECT * FROM flora_org_sessions WHERE user_id=? ORDER BY sequence',userId).toArray())+utf8Bytes(sql.exec('SELECT * FROM flora_org_app_access WHERE membership_id=? ORDER BY app_id',membershipId).toArray());
 }
 revoke(actor:OrgPrincipal,id:string,expectedRevision:number,now:number):void {
  this.store.atomic(()=>{
   this.owner(actor,now);safeInteger(expectedRevision);const row=this.store.storage.sql.exec<InviteRow>('SELECT * FROM flora_org_invites WHERE id=?',id).toArray()[0];orgAssert(row,404,'NOT_FOUND');orgAssert(row.purpose_generation===expectedRevision&&row.consumed_at===null,409,'REVISION_CONFLICT');if(row.revoked_at!==null)return;
   const before=utf8Bytes(row);row.revoked_at=now;this.store.charge(utf8Bytes(row)-before,0,0,true);this.store.storage.sql.exec('UPDATE flora_org_invites SET revoked_at=? WHERE id=?',now,id);this.store.bumpRevision();this.store.appendAudit(id,'revoked',{actor:{kind:'human',id:actor.userId},action:'invitation-revoked',invitationId:id},now,true);
  });
 }
}
