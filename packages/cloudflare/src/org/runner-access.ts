import {OrgAudit} from './audit.js';
import {OrgPolicy} from './policy.js';
import type {MemberAuth} from './member-auth.js';
import type {OrgStore} from './store.js';
import type {OrgAction,OrgPrincipal,RunnerKind,RunnerRequest,RunnerAccessRef,OrgPage} from './types.js';
import {orgAssert,orgId,orgLabel,safeInteger,utf8Bytes} from './types.js';

type RequestRow={id:string;app_id:string;kind:RunnerKind;name:string;platforms:string;requester_id:string;requester_auth_epoch:number;requester_revision:number;approver_id:string|null;approver_auth_epoch:number|null;approver_revision:number|null;org_access_epoch:number;state:RunnerRequest['state'];revision:number;requested_at:number;expires_at:number;claim_expires_at:number|null;runner_id:string|null;operation_id:string|null;owner_epoch:number};
export type AccessRow={kind:RunnerKind;runner_id:string;org_id:string;app_ids:string;platforms:string;owner_mode:'organization'|'personal';issuer_id:string;approver_id:string|null;sponsor_id:string|null;sponsor_auth_epoch:number|null;sponsor_revision:number|null;org_access_epoch:number;state:'pending'|'ready'|'revoked'|'unknown';operation_id:string;created_at:number;owner_epoch:number};
export interface RegistrationTicket {ref:RunnerAccessRef;operationId:string;requestId:string|null;appIds:string[];platforms:('ios'|'android')[];name:string;actor:OrgPrincipal;ownerMode:'personal'|'organization'}
const requestColumns='id,app_id,kind,name,platforms,requester_id,requester_auth_epoch,requester_revision,approver_id,approver_auth_epoch,approver_revision,org_access_epoch,state,revision,requested_at,expires_at,claim_expires_at,runner_id,operation_id,owner_epoch';
const accessColumns='kind,runner_id,org_id,app_ids,platforms,owner_mode,issuer_id,approver_id,sponsor_id,sponsor_auth_epoch,sponsor_revision,org_access_epoch,state,operation_id,created_at,owner_epoch';
const values=(columns:string,row:object)=>columns.split(',').map(key=>(row as Record<string,string|number|null>)[key]!);
const increment=(value:number):number=>{safeInteger(value);safeInteger(value+1);return value+1};
const dto=(r:RequestRow):RunnerRequest=>({id:r.id,appId:r.app_id,kind:r.kind,name:r.name,platforms:JSON.parse(r.platforms),requesterUserId:r.requester_id,approverUserId:r.approver_id,state:r.state,revision:r.revision,requestedAt:r.requested_at,expiresAt:r.expires_at,claimExpiresAt:r.claim_expires_at,runnerId:r.runner_id});
function appId(value:unknown):asserts value is string {orgAssert(typeof value==='string'&&/^[a-z][a-z0-9_-]{2,95}$/.test(value),400,'INVALID_REQUEST')}
/** Local authority and metadata. No raw token, provider password or key is stored. */
export class RunnerAccess {
 readonly policy:OrgPolicy;
 readonly audit:OrgAudit;
 constructor(readonly store:OrgStore,private readonly auth:MemberAuth,readonly verifyApplications:(appIds:string[])=>Promise<void>){this.policy=new OrgPolicy(store);this.audit=new OrgAudit(store.storage,store)}
 private epoch():number {return this.store.storage.sql.exec<{epoch:number}>('SELECT epoch FROM flora_auth_meta WHERE id=1').one().epoch}
 authorize(actor:OrgPrincipal,action:OrgAction,application:string|undefined,now:number):void {this.auth.assertBrowser(actor,now);this.policy.require(actor,action,application,now)}
 requireReauth(actor:OrgPrincipal,now:number):void {this.auth.requireReauth(actor,now)}
 private active():void {orgAssert(this.store.state().mode==='active',503,'ORG_ACCESS_NOT_ACTIVE')}
 requestRow(id:string):RequestRow {orgId(id);const row=this.store.storage.sql.exec<RequestRow>('SELECT * FROM flora_org_runner_requests WHERE id=?',id).toArray()[0];orgAssert(row,404,'NOT_FOUND');return row}
 get(ref:RunnerAccessRef):AccessRow {orgAssert(ref.kind==='ota'||ref.kind==='native',400,'INVALID_REQUEST');orgId(ref.runnerId);const row=this.store.storage.sql.exec<AccessRow>('SELECT * FROM flora_org_runner_access WHERE kind=? AND runner_id=?',ref.kind,ref.runnerId).toArray()[0];orgAssert(row&&row.org_id===this.store.state().id,403,'RUNNER_ACCESS_DENIED');return row}
 private saveRequest(old:RequestRow,next:RequestRow,contraction=false):void {
  this.store.charge(utf8Bytes(next)-utf8Bytes(old),0,0,contraction);
  const columns=requestColumns.split(',').filter(c=>c!=='id');this.store.storage.sql.exec('UPDATE flora_org_runner_requests SET '+columns.map(c=>c+'=?').join(',')+' WHERE id=?',...values(columns.join(','),next),next.id);
 }
 private saveAccess(old:AccessRow,next:AccessRow,contraction=false):void {
  this.store.charge(utf8Bytes(next)-utf8Bytes(old),0,0,contraction);const columns=accessColumns.split(',').filter(c=>c!=='kind'&&c!=='runner_id');this.store.storage.sql.exec('UPDATE flora_org_runner_access SET '+columns.map(c=>c+'=?').join(',')+' WHERE kind=? AND runner_id=?',...values(columns.join(','),next),next.kind,next.runner_id);
 }
 private event(actor:OrgPrincipal,action:OrgAction,application:string,requestId:string|undefined,state:string,now:number,safety=false):void {this.store.appendAudit('operation_'+crypto.randomUUID(),'completed',{actor:{kind:'human',id:actor.userId},action,appId:application,...(requestId?{requestId}:{}),state,membershipRevision:actor.membershipRevision},now,safety)}
 request(actor:OrgPrincipal,application:string,input:{kind:RunnerKind;name:string;platforms:('ios'|'android')[]},now:number):RunnerRequest {
  this.authorize(actor,'runner.request',application,now);this.active();appId(application);orgAssert(input.kind==='ota'||input.kind==='native',400,'INVALID_REQUEST');orgLabel(input.name);orgAssert(input.name.trim(),400,'INVALID_REQUEST');
  orgAssert(Array.isArray(input.platforms)&&input.platforms.length>0&&input.platforms.length<=2&&new Set(input.platforms).size===input.platforms.length&&input.platforms.every(p=>p==='ios'||p==='android')&&(input.kind!=='native'||input.platforms.length===1),400,'INVALID_REQUEST');safeInteger(now,0);safeInteger(now+86400000);
  return this.store.atomic(()=>{this.authorize(actor,'runner.request',application,now);this.active();const row:RequestRow={id:'pc_request_'+crypto.randomUUID(),app_id:application,kind:input.kind,name:input.name.trim(),platforms:JSON.stringify([...input.platforms].sort()),requester_id:actor.userId,requester_auth_epoch:actor.authEpoch,requester_revision:actor.membershipRevision,approver_id:null,approver_auth_epoch:null,approver_revision:null,org_access_epoch:this.store.state().orgAccessEpoch,state:'pending',revision:1,requested_at:now,expires_at:now+86400000,claim_expires_at:null,runner_id:null,operation_id:null,owner_epoch:this.epoch()};
   this.store.charge(utf8Bytes(row));this.store.storage.sql.exec('INSERT INTO flora_org_runner_requests('+requestColumns+') VALUES('+requestColumns.split(',').map(()=>'?').join(',')+')',...values(requestColumns,row));this.event(actor,'runner.request',application,row.id,'pending',now);this.store.bumpRevision();return dto(row);
  });
 }
 private participant(userId:string,authEpoch:number,revision:number,application:string,approver:boolean):void {
  const user=this.store.member(userId);orgAssert(user&&user.userStatus==='active'&&user.membershipStatus==='active'&&user.authEpoch===authEpoch&&user.membershipRevision===revision&&(approver?user.role==='owner'||user.role==='admin':user.role!=='viewer'),403,'RUNNER_APPROVAL_CHANGED');
  if(user.role!=='owner')orgAssert(this.store.storage.sql.exec<{active:number}>('SELECT active FROM flora_org_app_access WHERE membership_id=? AND app_id=?',user.membershipId,application).toArray()[0]?.active===1,403,'RUNNER_APPROVAL_CHANGED');
 }
 private participants(row:RequestRow):void {
  orgAssert(row.owner_epoch===this.epoch()&&row.org_access_epoch===this.store.state().orgAccessEpoch,403,'RUNNER_APPROVAL_CHANGED');this.participant(row.requester_id,row.requester_auth_epoch,row.requester_revision,row.app_id,false);
  if(row.approver_id!==null){orgAssert(row.approver_auth_epoch!==null&&row.approver_revision!==null,403,'RUNNER_APPROVAL_CHANGED');this.participant(row.approver_id,row.approver_auth_epoch,row.approver_revision,row.app_id,true);}
 }
 approve(actor:OrgPrincipal,id:string,expectedRevision:number,now:number):RunnerRequest {
  safeInteger(expectedRevision);return this.store.atomic(()=>{const old=this.requestRow(id);this.authorize(actor,'runner.approve',old.app_id,now);this.active();this.auth.requireReauth(actor,now);orgAssert(actor.role==='owner'||actor.userId!==old.requester_id);orgAssert(old.revision===expectedRevision&&old.state==='pending',409,'REVISION_CONFLICT');orgAssert(old.expires_at>now,403,'RUNNER_REQUEST_EXPIRED');this.participants(old);safeInteger(old.revision+4);safeInteger(now+600000);
   const next:RequestRow={...old,state:'approved',revision:increment(old.revision),approver_id:actor.userId,approver_auth_epoch:actor.authEpoch,approver_revision:actor.membershipRevision,claim_expires_at:now+600000};this.saveRequest(old,next);this.event(actor,'runner.approve',old.app_id,id,'approved',now);this.store.bumpRevision();return dto(next);
  });
 }
 private insertAccess(ticket:RegistrationTicket,now:number,request?:RequestRow):void {
  const row:AccessRow={kind:ticket.ref.kind,runner_id:ticket.ref.runnerId,org_id:this.store.state().id,app_ids:JSON.stringify(ticket.appIds),platforms:JSON.stringify(ticket.platforms),owner_mode:ticket.ownerMode,issuer_id:ticket.actor.userId,approver_id:request?.approver_id??null,sponsor_id:request?.requester_id??null,sponsor_auth_epoch:request?.requester_auth_epoch??null,sponsor_revision:request?.requester_revision??null,org_access_epoch:this.store.state().orgAccessEpoch,state:'pending',operation_id:ticket.operationId,created_at:now,owner_epoch:this.epoch()};
  this.store.charge(utf8Bytes(row));this.store.storage.sql.exec('INSERT INTO flora_org_runner_access('+accessColumns+') VALUES('+accessColumns.split(',').map(()=>'?').join(',')+')',...values(accessColumns,row));
 }
 startClaim(actor:OrgPrincipal,id:string,expectedRevision:number,now:number):RegistrationTicket {
  safeInteger(expectedRevision);return this.store.atomic(()=>{const old=this.requestRow(id);this.authorize(actor,'runner.request',old.app_id,now);this.active();orgAssert(old.requester_id===actor.userId);orgAssert(old.state==='approved'&&old.revision===expectedRevision,409,'REVISION_CONFLICT');orgAssert(old.claim_expires_at!==null&&old.claim_expires_at>now,403,'RUNNER_CLAIM_EXPIRED');this.participants(old);orgAssert(old.approver_id!==null,403,'RUNNER_APPROVAL_CHANGED');safeInteger(old.revision+3);
   const intent=this.audit.begin({actor:{kind:'human',id:actor.userId},action:'runner.request',appId:old.app_id,requestId:id,membershipRevision:actor.membershipRevision},now,()=>this.authorize(actor,'runner.request',old.app_id,now));
   const ticket:RegistrationTicket={ref:{kind:old.kind,runnerId:(old.kind==='native'?'native_runner_':'runner_')+crypto.randomUUID()},operationId:intent.id,requestId:id,appIds:[old.app_id],platforms:JSON.parse(old.platforms),name:old.name,actor:Object.freeze({...actor}),ownerMode:'personal'};
   const next:RequestRow={...old,state:'issuing',revision:increment(old.revision),runner_id:ticket.ref.runnerId,operation_id:ticket.operationId};this.insertAccess(ticket,now,next);this.saveRequest(old,next);this.store.bumpRevision();return ticket;
  });
 }
 startOrganization(actor:OrgPrincipal,kind:RunnerKind,input:{name:string;appIds:string[];platforms:('ios'|'android')[]},now:number):RegistrationTicket {
  return this.store.atomic(()=>{this.authorize(actor,'runner.organization',undefined,now);orgAssert(['active','paused'].includes(this.store.state().mode),503,'ORG_ACCESS_NOT_ACTIVE');orgLabel(input.name);orgAssert(input.name.trim()&&input.appIds.length>0&&input.appIds.length<=100&&new Set(input.appIds).size===input.appIds.length,400,'INVALID_REQUEST');for(const a of input.appIds)appId(a);orgAssert(input.platforms.length>0&&input.platforms.length<=2&&new Set(input.platforms).size===input.platforms.length&&input.platforms.every(p=>p==='ios'||p==='android')&&(kind!=='native'||input.platforms.length===1),400,'INVALID_REQUEST');
   const intent=this.audit.begin({actor:{kind:'human',id:actor.userId},action:'runner.organization',membershipRevision:actor.membershipRevision},now,()=>this.authorize(actor,'runner.organization',undefined,now));
   const ticket:RegistrationTicket={ref:{kind,runnerId:(kind==='native'?'native_runner_':'runner_')+crypto.randomUUID()},operationId:intent.id,requestId:null,appIds:[...input.appIds],platforms:[...input.platforms].sort(),name:input.name.trim(),actor:Object.freeze({...actor}),ownerMode:'organization'};this.insertAccess(ticket,now);this.store.bumpRevision();return ticket;
  });
 }
 assertIssuing(ticket:RegistrationTicket,now:number):void {
  const row=this.get(ticket.ref);orgAssert(row.state==='pending'&&row.operation_id===ticket.operationId,403,'RUNNER_ACCESS_DENIED');
  if(ticket.ownerMode==='organization'){this.authorize(ticket.actor,'runner.organization',undefined,now);orgAssert(['active','paused'].includes(this.store.state().mode),503,'ORG_ACCESS_NOT_ACTIVE');return;}
  this.active();const request=this.requestRow(ticket.requestId!);this.authorize(ticket.actor,'runner.request',request.app_id,now);orgAssert(request.state==='issuing'&&request.operation_id===ticket.operationId&&request.runner_id===ticket.ref.runnerId,403,'RUNNER_ACCESS_DENIED');orgAssert(request.claim_expires_at!==null&&request.claim_expires_at>now,403,'RUNNER_CLAIM_EXPIRED');this.participants(request);
 }
 finish(ticket:RegistrationTicket,now:number):void {
  this.store.atomic(()=>{this.assertIssuing(ticket,now);const old=this.get(ticket.ref);this.saveAccess(old,{...old,state:'ready'});if(ticket.requestId){const request=this.requestRow(ticket.requestId);this.saveRequest(request,{...request,state:'claimed',revision:increment(request.revision)});}this.audit.settle(ticket.operationId,'completed',{runnerId:ticket.ref.runnerId,...(ticket.requestId?{requestId:ticket.requestId}:{})},now);this.store.bumpRevision();});
 }
 finishNative(ticket:RegistrationTicket,now:number):void {
  const row=this.store.storage.sql.exec<{data:string;owner_epoch:number}>('SELECT data,owner_epoch FROM flora_native_runners WHERE id=?',ticket.ref.runnerId).toArray()[0];orgAssert(row&&row.owner_epoch===ticket.actor.ownerEpoch,503,'RUNNER_NATIVE_PROOF_FAILED');const native=JSON.parse(row.data) as {id:string;appId:string;platform:string;credentialEpoch:number;revokedAt:number|null};orgAssert(native.id===ticket.ref.runnerId&&ticket.appIds.length===1&&ticket.appIds[0]===native.appId&&ticket.platforms.length===1&&ticket.platforms[0]===native.platform&&native.credentialEpoch===1&&native.revokedAt===null,503,'RUNNER_NATIVE_PROOF_FAILED');this.finish(ticket,now);
 }
 unknown(ticket:RegistrationTicket,now:number):void {
  this.store.atomic(()=>{
   const old=this.get(ticket.ref);orgAssert(old.operation_id===ticket.operationId,503,'RUNNER_ISSUANCE_UNVERIFIED');let changed=false;
   if(old.state==='pending'){
    this.saveAccess(old,{...old,state:'unknown'},true);changed=true;
    if(ticket.requestId){const request=this.requestRow(ticket.requestId);if(request.state==='issuing')this.saveRequest(request,{...request,state:'unknown',revision:increment(request.revision)},true);}
   }
   const prior=this.store.storage.sql.exec<{phase:string}>('SELECT phase FROM flora_org_audit WHERE operation_id=? ORDER BY sequence DESC LIMIT 1',ticket.operationId).toArray()[0];
   if(prior?.phase==='pending'){this.audit.settle(ticket.operationId,'unknown',{runnerId:ticket.ref.runnerId,code:old.state==='revoked'?'RUNNER_ISSUANCE_REVOKED':'RUNNER_RESULT_UNKNOWN'},now);changed=true;}
   if(changed)this.store.bumpRevision();
  });
 }
 private scope(row:AccessRow):{appIds:string[];platforms:('ios'|'android')[]} {
  let apps:unknown,platforms:unknown;try{apps=JSON.parse(row.app_ids);platforms=JSON.parse(row.platforms);}catch{orgAssert(false,403,'RUNNER_ACCESS_DENIED');}
  orgAssert(Array.isArray(apps)&&apps.length>0&&apps.length<=100&&new Set(apps).size===apps.length&&apps.every(a=>typeof a==='string'&&/^[a-z][a-z0-9_-]{2,95}$/.test(a))&&Array.isArray(platforms)&&platforms.length>0&&platforms.length<=2&&new Set(platforms).size===platforms.length&&platforms.every(p=>p==='ios'||p==='android')&&(row.kind!=='native'||apps.length===1&&platforms.length===1),403,'RUNNER_ACCESS_DENIED');return {appIds:apps,platforms};
 }
 serviceScope(ref:RunnerAccessRef,now:number):{appIds:string[];platforms:('ios'|'android')[]} {const scope=this.scope(this.get(ref));for(const appId of scope.appIds)this.assertService(ref,appId,undefined,now);return scope;}
 assertService(ref:RunnerAccessRef,application:string,platform:string|undefined,now:number):void {
  safeInteger(now,0);const row=this.get(ref),scope=this.scope(row);orgAssert(row.state==='ready'&&scope.appIds.includes(application)&&(platform===undefined||scope.platforms.includes(platform as 'ios'|'android')),403,'RUNNER_ACCESS_DENIED');
  if(row.owner_mode==='organization')return;
  orgAssert(row.owner_mode==='personal'&&this.store.state().mode==='active'&&row.org_access_epoch===this.store.state().orgAccessEpoch&&row.owner_epoch===this.epoch(),403,'RUNNER_ACCESS_DENIED');
  const request=this.store.storage.sql.exec<RequestRow>('SELECT * FROM flora_org_runner_requests WHERE operation_id=? AND runner_id=? AND kind=?',row.operation_id,row.runner_id,row.kind).toArray()[0];
  orgAssert(request?.state==='claimed'&&request.app_id===application&&scope.appIds.length===1&&row.platforms===request.platforms&&row.sponsor_id===request.requester_id&&row.issuer_id===request.requester_id&&row.sponsor_auth_epoch===request.requester_auth_epoch&&row.sponsor_revision===request.requester_revision&&row.approver_id===request.approver_id&&request.approver_id!==null&&row.org_access_epoch===request.org_access_epoch&&row.owner_epoch===request.owner_epoch,403,'RUNNER_ACCESS_DENIED');this.participants(request);
 }
 revoke(actor:OrgPrincipal,ref:RunnerAccessRef,now:number):void {
  this.store.atomic(()=>{const old=this.get(ref),apps=JSON.parse(old.app_ids) as string[];orgAssert(apps.length>0,403,'RUNNER_ACCESS_DENIED');this.authorize(actor,old.owner_mode==='organization'?'runner.organization':'runner.approve',old.owner_mode==='organization'?undefined:apps[0],now);if(old.state==='revoked')return;
   this.saveAccess(old,{...old,state:'revoked'},true);const request=this.store.storage.sql.exec<RequestRow>('SELECT * FROM flora_org_runner_requests WHERE operation_id=? AND runner_id=? AND kind=?',old.operation_id,old.runner_id,old.kind).toArray()[0];if(request)this.saveRequest(request,{...request,state:'revoked',revision:increment(request.revision)},true);this.event(actor,old.owner_mode==='organization'?'runner.organization':'runner.approve',apps[0]!,request?.id,'revoked',now,true);this.store.bumpRevision();});
 }
 cancel(actor:OrgPrincipal,id:string,expectedRevision:number,now:number):RunnerRequest {
  safeInteger(expectedRevision);const row=this.requestRow(id);this.authorize(actor,'app.read',row.app_id,now);orgAssert(row.revision===expectedRevision,409,'REVISION_CONFLICT');
  if(row.runner_id){this.revoke(actor,{kind:row.kind,runnerId:row.runner_id},now);return dto(this.requestRow(id));}
  return this.store.atomic(()=>{const current=this.requestRow(id);this.authorize(actor,'app.read',current.app_id,now);orgAssert(current.revision===expectedRevision,409,'REVISION_CONFLICT');orgAssert(actor.role==='owner'||actor.role==='admin'||current.requester_id===actor.userId);orgAssert(['pending','approved','revoked'].includes(current.state),409,'REVISION_CONFLICT');if(current.state==='revoked')return dto(current);const next:RequestRow={...current,state:'revoked',revision:increment(current.revision)};this.saveRequest(current,next,true);this.event(actor,'runner.request',row.app_id,id,'revoked',now,true);this.store.bumpRevision();return dto(next);});
 }
 list(actor:OrgPrincipal,application:string,cursor:string|null,limit:number,now:number):OrgPage<RunnerRequest> {
  this.authorize(actor,'app.read',application,now);safeInteger(limit);orgAssert(limit<=50,400,'INVALID_REQUEST');const revision=this.store.state().revision,all=actor.role==='owner'||actor.role==='admin';let after='';
  if(cursor){let c:any;try{c=JSON.parse(atob(cursor))}catch{orgAssert(false,400,'INVALID_REQUEST')}orgAssert(c.org===actor.organizationId&&c.user===actor.userId&&c.permission===actor.membershipRevision&&c.app===application&&c.revision===revision&&c.all===all,403,'MEMBERSHIP_CHANGED');orgId(c.after);after=c.after;}
  const rows=this.store.storage.sql.exec<RequestRow>('SELECT * FROM flora_org_runner_requests WHERE app_id=? AND id>?'+(all?'':' AND requester_id=?')+' ORDER BY id LIMIT ?',application,after,...(all?[]:[actor.userId]),limit+1).toArray(),items=rows.slice(0,limit).map(dto);
  return {items,nextCursor:rows.length>limit?btoa(JSON.stringify({org:actor.organizationId,user:actor.userId,permission:actor.membershipRevision,app:application,revision,all,after:items.at(-1)!.id})):null};
 }
 requestView(id:string):RunnerRequest{return dto(this.requestRow(id))}
}
