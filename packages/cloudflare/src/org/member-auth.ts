import {Buffer} from 'node:buffer';
import {createPasswordVerifier,verifyPassword,validPassword} from '../auth/password.js';
import type {PasswordVerifierV1} from '../auth/password.js';
import type {NewSession} from '../auth-state.js';
import {OrgStore} from './store.js';
import {OrgFailure,normalizeEmail,normalizeOwnerEmail,orgAssert,safeInteger,utf8Bytes} from './types.js';
import type {OrgPrincipal,OrgRole} from './types.js';
const lifetime=3_600_000,stepUp=300_000;
const dummy:PasswordVerifierV1={version:1,algorithm:'scrypt',N:32768,r:8,p:3,maxmem:67108864,keyLength:32,saltHex:'0'.repeat(32),hashHex:'0'.repeat(64)};
export interface MemberAuthOptions {
 now:()=>number;minimum:()=>12|15;tryHeavy:()=>null|(()=>void);
 owner:()=>{epoch:number;verifier:PasswordVerifierV1|null};reserveOwner:(now:number)=>void;
 assertLegacy:(principal:OrgPrincipal,now:number)=>void;
}
type UserRow={id:string;email:string;auth_source:'legacy_owner'|'member';status:'active'|'disabled';auth_epoch:number};
type BudgetRow={bucket:string;attempt_window:number;attempts:number;kdf_window:number;kdfs:number};
type SessionRow={session_hash:string;csrf_hash:string;user_id:string;membership_id:string;auth_epoch:number;owner_epoch:number;expires_at:number;reauth_until:number;
 user_status:string|null;current_auth_epoch:number|null;auth_source:string|null;role:OrgRole|null;membership_status:string|null;revision:number|null;org_id:string|null;owner_exists:number};
export interface MemberSessionResult {session:NewSession;principal:OrgPrincipal;sessionToken:string;csrfToken:string}
export class MemberAuth {
 constructor(readonly store:OrgStore,readonly options:MemberAuthOptions){}
 private active():void {orgAssert(this.options.owner().verifier!==null&&this.store.state().mode==='active',503,'ORG_ACCESS_NOT_ACTIVE')}
 private user(email:string):UserRow|null{return this.store.storage.sql.exec<UserRow>('SELECT id,email,auth_source,status,auth_epoch FROM flora_org_users WHERE email=?',email).toArray()[0]??null}
 private reserve(bucket:string,now:number,cost:number):void {
  this.store.atomic(()=>{
   const update=(key:string,attemptLimit:number,kdfLimit:number)=>{
    const old=this.store.storage.sql.exec<BudgetRow>('SELECT * FROM flora_org_auth_budget WHERE bucket=?',key).toArray()[0];
    const a=Math.max(old?.attempt_window??0,Math.floor(now/900_000)*900_000),k=Math.max(old?.kdf_window??0,Math.floor(now/3_600_000)*3_600_000);
    const attempts=old?.attempt_window===a?old.attempts:0,kdfs=old?.kdf_window===k?old.kdfs:0;
    if(attempts>=attemptLimit||kdfs+cost>kdfLimit)throw new OrgFailure(429,'RATE_LIMITED',Math.min(3600,Math.max(1,Math.ceil(((attempts>=attemptLimit?a+900_000:k+3_600_000)-now)/1000))));
    const next={bucket:key,attempt_window:a,attempts:attempts+1,kdf_window:k,kdfs:kdfs+cost};
    this.store.charge(utf8Bytes(next)-(old?utf8Bytes(old):0));
    this.store.storage.sql.exec('INSERT INTO flora_org_auth_budget VALUES(?,?,?,?,?) ON CONFLICT(bucket) DO UPDATE SET attempt_window=excluded.attempt_window,attempts=excluded.attempts,kdf_window=excluded.kdf_window,kdfs=excluded.kdfs',key,a,attempts+1,k,kdfs+cost);
   };
   // A fixed shared bucket, never an unbounded map of unknown email guesses.
   update('nonowner',Number.MAX_SAFE_INTEGER,240);update(bucket,5,60);
  });
 }
 async withKdf<T>(bucket:string,cost:number,run:()=>Promise<T>):Promise<T> {
  orgAssert(cost===1||cost===2,400,'INVALID_REQUEST');const release=this.options.tryHeavy();if(!release)throw new OrgFailure(409,'BUSY',1);
  try{this.reserve(bucket,this.options.now(),cost);await this.store.storage.sync();return await run()}finally{release()}
 }
 private ownerEpoch():number {return this.options.owner().epoch}
 private snapshot(userId:string){const m=this.store.member(userId);orgAssert(m&&m.authSource==='member'&&m.userStatus==='active'&&m.membershipStatus==='active',401,'UNAUTHENTICATED');return m}
 private assertSnapshot(userId:string,epoch:number,revision:number,ownerEpoch:number):void {
  this.active();const m=this.snapshot(userId);orgAssert(m.authEpoch===epoch&&m.membershipRevision===revision&&this.ownerEpoch()===ownerEpoch,403,'MEMBERSHIP_CHANGED');
 }
 async newSession(now:number){
  const raw=crypto.getRandomValues(new Uint8Array(32)),csrf=crypto.getRandomValues(new Uint8Array(32));
  const hash=async(value:Uint8Array)=>Buffer.from(await crypto.subtle.digest('SHA-256',value)).toString('hex');
  return {sessionToken:Buffer.from(raw).toString('base64url'),csrfToken:Buffer.from(csrf).toString('base64url'),sessionHash:await hash(raw),csrfHash:await hash(csrf),expiresAt:now+lifetime};
 }
 createSession(userId:string,session:NewSession,ownerEpoch:number,now:number):OrgPrincipal {
  return this.store.atomic(()=>{
   this.active();const m=this.snapshot(userId);orgAssert(ownerEpoch===this.ownerEpoch(),403,'MEMBERSHIP_CHANGED');
   const s=this.store.storage;
   // Collision in either authority is rejected, never interpreted as Owner.
   orgAssert(!s.sql.exec('SELECT 1 FROM flora_auth_sessions WHERE session_hash=?',session.sessionHash).toArray().length&&!s.sql.exec('SELECT 1 FROM flora_org_sessions WHERE session_hash=?',session.sessionHash).toArray().length,503,'AUTH_UNAVAILABLE');
   const before=s.sql.exec('SELECT * FROM flora_org_sessions WHERE user_id=? ORDER BY sequence',userId).toArray();
   s.sql.exec('DELETE FROM flora_org_sessions WHERE user_id=? AND (expires_at<=? OR auth_epoch<>? OR owner_epoch<>?)',userId,now,m.authEpoch,ownerEpoch);
   s.sql.exec('INSERT INTO flora_org_sessions(session_hash,csrf_hash,user_id,membership_id,auth_epoch,owner_epoch,expires_at) VALUES(?,?,?,?,?,?,?)',session.sessionHash,session.csrfHash,userId,m.membershipId,m.authEpoch,ownerEpoch,session.expiresAt);
   s.sql.exec('DELETE FROM flora_org_sessions WHERE user_id=? AND sequence NOT IN(SELECT sequence FROM flora_org_sessions WHERE user_id=? ORDER BY sequence DESC LIMIT 5)',userId,userId);
   const after=s.sql.exec('SELECT * FROM flora_org_sessions WHERE user_id=? ORDER BY sequence',userId).toArray();this.store.charge(utf8Bytes(after)-utf8Bytes(before));
   this.store.appendAudit('login_'+crypto.randomUUID(),'completed',{actor:{kind:'human',id:userId},action:'login'},now);
   return Object.freeze({organizationId:this.store.state().id,userId,membershipId:m.membershipId,role:m.role,authSource:'member' as const,authEpoch:m.authEpoch,membershipRevision:m.membershipRevision,ownerEpoch,sessionHash:session.sessionHash,expiresAt:session.expiresAt});
  });
 }
 async login(email:string,password:string,now:number):Promise<MemberSessionResult> {
  this.active();const normalized=normalizeEmail(email);orgAssert(normalized!==normalizeOwnerEmail(this.store.binding.ownerEmail),401,'UNAUTHENTICATED');
  const minimum=this.options.minimum();orgAssert(validPassword(password,minimum),401,'UNAUTHENTICATED');
  const user=this.user(normalized),member=user?.auth_source==='member'?this.store.member(user.id):null,ownerEpoch=this.ownerEpoch();
  const stored=user?this.store.storage.sql.exec<{verifier:string}>('SELECT verifier FROM flora_org_passwords WHERE user_id=?',user.id).toArray()[0]:undefined;
  let verifier:PasswordVerifierV1=dummy;try{if(stored)verifier=JSON.parse(stored.verifier)}catch{throw new OrgFailure(503,'AUTH_UNAVAILABLE')}
  return this.withKdf(user?'user:'+user.id:'unknown',1,async()=>{
   let matched:boolean;try{matched=await verifyPassword(password,verifier,minimum)}catch{throw new OrgFailure(503,'AUTH_UNAVAILABLE')}
   orgAssert(matched&&user?.auth_source==='member'&&user.status==='active'&&member?.membershipStatus==='active',401,'UNAUTHENTICATED');
   this.assertSnapshot(user.id,user.auth_epoch,member.membershipRevision,ownerEpoch);
   const candidate=await this.newSession(this.options.now());
   return this.store.atomic(()=>{
    orgAssert(this.options.minimum()===minimum,503,'AUTH_UNAVAILABLE');this.assertSnapshot(user.id,user.auth_epoch,member.membershipRevision,ownerEpoch);
    return {session:{sessionHash:candidate.sessionHash,csrfHash:candidate.csrfHash,expiresAt:candidate.expiresAt},principal:this.createSession(user.id,candidate,ownerEpoch,this.options.now()),sessionToken:candidate.sessionToken,csrfToken:candidate.csrfToken};
   });
  });
 }
 inspect(sessionHash:string,now:number):{principal:OrgPrincipal;csrfHash:string;reauthUntil:number}|null {
  const row=this.store.storage.sql.exec<SessionRow>(`SELECT s.*,u.status AS user_status,u.auth_epoch AS current_auth_epoch,u.auth_source,m.role,m.status AS membership_status,m.revision,m.org_id,
   EXISTS(SELECT 1 FROM flora_auth_sessions WHERE session_hash=s.session_hash) AS owner_exists FROM flora_org_sessions s
   LEFT JOIN flora_org_users u ON u.id=s.user_id LEFT JOIN flora_org_memberships m ON m.id=s.membership_id AND m.user_id=s.user_id WHERE s.session_hash=?`,sessionHash).toArray()[0];
  if(!row)return null;
  orgAssert(!row.owner_exists&&row.expires_at>now&&row.auth_epoch===row.current_auth_epoch&&row.owner_epoch===this.ownerEpoch()&&row.user_status==='active'&&row.membership_status==='active'&&row.auth_source==='member'&&row.role!==null&&row.role!=='owner'&&row.org_id===this.store.state().id,401,'UNAUTHENTICATED');
  this.active();
  return {csrfHash:row.csrf_hash,reauthUntil:row.reauth_until,principal:Object.freeze({organizationId:row.org_id,userId:row.user_id,membershipId:row.membership_id,role:row.role,authSource:'member',authEpoch:row.auth_epoch,membershipRevision:row.revision!,ownerEpoch:row.owner_epoch,sessionHash:row.session_hash,expiresAt:row.expires_at})};
 }
 session(sessionHash:string,now:number):OrgPrincipal {const found=this.inspect(sessionHash,now);orgAssert(found,401,'UNAUTHENTICATED');return found.principal}
 /** Reuse the original Owner authority; member sessions never fall through to it. */
 assertBrowser(principal:OrgPrincipal,now:number):void {if(principal.authSource==='legacy_owner')this.options.assertLegacy(principal,now);else this.assertCurrent(principal,now)}
 assertCurrent(principal:OrgPrincipal,now:number):void {const live=this.session(principal.sessionHash,now);orgAssert(live.userId===principal.userId&&live.authEpoch===principal.authEpoch&&live.membershipRevision===principal.membershipRevision&&live.ownerEpoch===principal.ownerEpoch&&live.expiresAt===principal.expiresAt,403,'MEMBERSHIP_CHANGED')}
 logout(principal:OrgPrincipal,now:number):void {this.store.atomic(()=>{this.assertCurrent(principal,now);const before=this.sessionBytes(principal.userId);this.store.storage.sql.exec('DELETE FROM flora_org_sessions WHERE session_hash=? AND user_id=?',principal.sessionHash,principal.userId);this.store.charge(this.sessionBytes(principal.userId)-before,0,0,true);this.store.appendAudit('logout_'+crypto.randomUUID(),'completed',{actor:{kind:'human',id:principal.userId},action:'logout'},now,true)})}
 private sessionBytes(userId:string):number{return utf8Bytes(this.store.storage.sql.exec('SELECT * FROM flora_org_sessions WHERE user_id=? ORDER BY sequence',userId).toArray())}
 requireReauth(principal:OrgPrincipal,now:number):void {
  if(principal.authSource==='legacy_owner'){
   this.options.assertLegacy(principal,now);const entries=this.ownerStepUps();const found=entries[principal.sessionHash];orgAssert(found&&found.epoch===principal.ownerEpoch&&found.until>now,403,'REAUTH_REQUIRED');
  }else {this.assertCurrent(principal,now);orgAssert(this.inspect(principal.sessionHash,now)!.reauthUntil>now,403,'REAUTH_REQUIRED')}
 }
 private ownerStepUps():Record<string,{epoch:number;until:number}> {const row=this.store.storage.sql.exec<{owner_reauth:string}>('SELECT owner_reauth FROM flora_org_state WHERE singleton=1').one();try{return JSON.parse(row.owner_reauth)}catch{throw new OrgFailure(503,'ORG_ACCESS_NOT_ACTIVE')}}
 async reauth(principal:OrgPrincipal,password:string,now:number):Promise<void> {
  const minimum=this.options.minimum();orgAssert(validPassword(password,minimum),401,'UNAUTHENTICATED');
  const owner=principal.authSource==='legacy_owner';if(owner)this.options.assertLegacy(principal,now);else this.assertCurrent(principal,now);
  const verifier=owner?this.options.owner().verifier:JSON.parse(this.store.storage.sql.exec<{verifier:string}>('SELECT verifier FROM flora_org_passwords WHERE user_id=?',principal.userId).one().verifier) as PasswordVerifierV1;
  const run=async()=>{
   let matches:boolean;try{matches=await verifyPassword(password,verifier!,minimum)}catch{throw new OrgFailure(503,'AUTH_UNAVAILABLE')}
   orgAssert(matches,401,'UNAUTHENTICATED');
   this.store.atomic(()=>{
    const current=this.options.now();orgAssert(minimum===this.options.minimum(),503,'AUTH_UNAVAILABLE');
    if(owner){
     this.options.assertLegacy(principal,current);const entries=this.ownerStepUps();for(const [hash,v]of Object.entries(entries))if(v.until<=current||v.epoch!==principal.ownerEpoch)delete entries[hash];
     entries[principal.sessionHash]={epoch:principal.ownerEpoch,until:Math.min(principal.expiresAt,current+stepUp)};orgAssert(Object.keys(entries).length<=5,409,'ORG_ACCESS_CAPACITY');
     const previous=this.ownerStepUps();this.store.charge(utf8Bytes(entries)-utf8Bytes(previous));this.store.storage.sql.exec('UPDATE flora_org_state SET owner_reauth=? WHERE singleton=1',JSON.stringify(entries));
    }else{this.assertCurrent(principal,current);const before=this.sessionBytes(principal.userId);this.store.storage.sql.exec('UPDATE flora_org_sessions SET reauth_until=? WHERE session_hash=?',Math.min(principal.expiresAt,current+stepUp),principal.sessionHash);this.store.charge(this.sessionBytes(principal.userId)-before)}
    this.store.appendAudit('reauth_'+crypto.randomUUID(),'completed',{actor:{kind:'human',id:principal.userId},action:'reauth'},current);
   });
  };
  if(owner){const release=this.options.tryHeavy();if(!release)throw new OrgFailure(409,'BUSY',1);try{this.options.reserveOwner(now);await this.store.storage.sync();await run()}finally{release()}}
  else await this.withKdf('user:'+principal.userId,1,run);
 }
 async changePassword(principal:OrgPrincipal,current:string,next:string,confirmation:string,now:number):Promise<void> {
  orgAssert(principal.authSource==='member');this.assertCurrent(principal,now);const minimum=this.options.minimum();orgAssert(next===confirmation&&validPassword(next,minimum),400,'INVALID_PASSWORD');orgAssert(validPassword(current,minimum),401,'UNAUTHENTICATED');
  const verifier=JSON.parse(this.store.storage.sql.exec<{verifier:string}>('SELECT verifier FROM flora_org_passwords WHERE user_id=?',principal.userId).one().verifier) as PasswordVerifierV1;
  await this.withKdf('user:'+principal.userId,2,async()=>{
   let matches:boolean;try{matches=await verifyPassword(current,verifier,minimum)}catch{throw new OrgFailure(503,'AUTH_UNAVAILABLE')}
   orgAssert(matches,401,'UNAUTHENTICATED');this.assertCurrent(principal,this.options.now());
   let candidate:PasswordVerifierV1;try{candidate=await createPasswordVerifier(next,minimum)}catch{throw new OrgFailure(503,'AUTH_UNAVAILABLE')}
   this.store.atomic(()=>{
    this.assertCurrent(principal,this.options.now());orgAssert(minimum===this.options.minimum(),503,'AUTH_UNAVAILABLE');safeInteger(principal.authEpoch+1);safeInteger(principal.membershipRevision+1);
    const beforeSessions=this.sessionBytes(principal.userId),beforeUser=this.store.storage.sql.exec('SELECT * FROM flora_org_users WHERE id=?',principal.userId).one(),beforeMembership=this.store.storage.sql.exec('SELECT * FROM flora_org_memberships WHERE id=?',principal.membershipId).one(),beforePassword=this.store.storage.sql.exec('SELECT * FROM flora_org_passwords WHERE user_id=?',principal.userId).one();
    this.store.storage.sql.exec('UPDATE flora_org_passwords SET verifier=? WHERE user_id=?',JSON.stringify(candidate),principal.userId);
    this.store.storage.sql.exec('UPDATE flora_org_users SET auth_epoch=auth_epoch+1 WHERE id=?',principal.userId);
    this.store.storage.sql.exec('UPDATE flora_org_memberships SET revision=revision+1 WHERE id=?',principal.membershipId);
    this.store.storage.sql.exec('DELETE FROM flora_org_sessions WHERE user_id=?',principal.userId);
    const delta=this.sessionBytes(principal.userId)-beforeSessions+utf8Bytes(this.store.storage.sql.exec('SELECT * FROM flora_org_users WHERE id=?',principal.userId).one())-utf8Bytes(beforeUser)+utf8Bytes(this.store.storage.sql.exec('SELECT * FROM flora_org_memberships WHERE id=?',principal.membershipId).one())-utf8Bytes(beforeMembership)+utf8Bytes(this.store.storage.sql.exec('SELECT * FROM flora_org_passwords WHERE user_id=?',principal.userId).one())-utf8Bytes(beforePassword);this.store.charge(delta,0,0,true);
    this.store.appendAudit('password_'+crypto.randomUUID(),'completed',{actor:{kind:'human',id:principal.userId},action:'password-changed',membershipRevision:principal.membershipRevision+1},this.options.now(),true);
   });
  });
 }
}
