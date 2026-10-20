import type {RunnerAccess} from './runner-access.js';
import type {RunnerRegistration} from './runner-registration.js';
import {json,parseJson,readBody} from '../http.js';
import type {AuthGrant} from '../contracts.js';
import type {OrgStore} from './store.js';
import type {OrgPolicy} from './policy.js';
import type {MemberAuth} from './member-auth.js';
import type {InvitationService} from './invitations.js';
import type {InvitationInput,MembershipInput,OrgPrincipal} from './types.js';
import {orgActions,orgAssert,safeInteger} from './types.js';
import {organizationRoute} from './routes.js';
export interface OrgHttpContext {store:OrgStore;policy:OrgPolicy;auth:MemberAuth;invitations:InvitationService;runnerAccess:RunnerAccess;runnerRegistration:RunnerRegistration;grant:AuthGrant|null;principal:OrgPrincipal|null;now:()=>number}
async function body(request:Request,allowed:readonly string[]):Promise<Record<string,unknown>>{
 const input=parseJson(await readBody(request,16384));orgAssert(input&&typeof input==='object'&&!Array.isArray(input),400,'INVALID_REQUEST');
 const record=input as Record<string,unknown>;orgAssert(Object.keys(record).every(k=>allowed.includes(k)),400,'INVALID_REQUEST');return record;
}
function cursor(value:string|null,actor:OrgPrincipal,revision:number):string{
 if(value===null)return '';let decoded:any;try{decoded=JSON.parse(atob(value))}catch{orgAssert(false,400,'INVALID_REQUEST')}
 orgAssert(decoded&&decoded.org===actor.organizationId&&decoded.user===actor.userId&&decoded.revision===revision&&typeof decoded.after==='string',403,'MEMBERSHIP_CHANGED');return decoded.after;
}
export async function handleOrgHttp(request:Request,c:OrgHttpContext):Promise<Response|null>{
 const url=new URL(request.url),route=organizationRoute(url.pathname,request.method);if(!route)return null;
 if(route.public){
  const input=await body(request,route.action==='preview'?['nonce']:['nonce','email','password','confirmation']);
  if(route.action==='preview'){orgAssert(Object.keys(input).length===1,400,'INVALID_REQUEST');return json(await c.invitations.preview(input.nonce as string,c.now()))}
  orgAssert(Object.keys(input).length===4&&Object.values(input).every(v=>typeof v==='string'),400,'INVALID_REQUEST');const result=await c.invitations.accept(input as {nonce:string;email:string;password:string;confirmation:string},c.now());
  const headers=new Headers(),options='; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600';headers.append('Set-Cookie','__Host-flora_session='+result.sessionToken+options);headers.append('Set-Cookie','__Host-flora_csrf='+result.csrfToken+options);return json({csrfToken:result.csrfToken,expiresAt:result.session.expiresAt},200,headers);
 }
 const actor=c.principal;orgAssert(actor&&c.grant,503,'ORG_ACCESS_NOT_ACTIVE');c.policy.require(actor,'org.self',undefined,c.now());
 if(route.action.startsWith('runner-')){
  const access=c.runnerAccess,application=route.appId!,action=route.action==='runner-approve'?'runner.approve':route.action==='runner-request'||route.action==='runner-claim'?'runner.request':'app.read';access.authorize(actor,action,application,c.now());
  if(route.action==='runner-list')return json(access.list(actor,application,url.searchParams.get('cursor'),Number(url.searchParams.get('limit')??25),c.now()));
  if(route.action==='runner-request'){
   const input=await body(request,['kind','name','platforms']);access.authorize(actor,'runner.request',application,c.now());await access.verifyApplications([application]);return json(access.request(actor,application,input as any,c.now()),201);
  }
  const input=await body(request,['expectedRevision']);orgAssert(Object.keys(input).length===1,400,'INVALID_REQUEST');safeInteger(input.expectedRevision);
  orgAssert(access.requestView(route.id!).appId===application,404,'NOT_FOUND');
  if(route.action==='runner-approve')return json(access.approve(actor,route.id!,input.expectedRevision,c.now()));
  if(route.action==='runner-claim')return json(await c.runnerRegistration.claim(actor,route.id!,input.expectedRevision),201);
  return json(await c.runnerRegistration.revokeRequest(actor,route.id!,input.expectedRevision));
 }
 if(route.action==='self'){
  const page=c.policy.visibleApps(actor,null,50);const user=c.store.storage.sql.exec<{display_name:string}>('SELECT display_name FROM flora_org_users WHERE id=?',actor.userId).one();
  const capabilities=orgActions.filter(action=>actor.role==='owner'||action==='org.self'||['app.read','credential.read'].includes(action)||(actor.role!=='viewer'&&['app.deploy','runner.request'].includes(action))||(actor.role==='admin'&&['app.manage','credential.manage','runner.approve'].includes(action)));
  return json({organizationId:actor.organizationId,userId:actor.userId,membershipId:actor.membershipId,displayName:user.display_name,role:actor.role,permissionRevision:actor.membershipRevision,appIds:page.items,nextAppCursor:page.nextCursor,capabilities});
 }
 if(route.action==='organization'){const s=c.store.state();return json({id:s.id,name:c.store.row().display_name,mode:s.mode,revision:s.revision})}
 c.policy.require(actor,'org.manage',undefined,c.now());
 if(route.action==='members'||route.action==='audit'){
  const limit=Number(url.searchParams.get('limit')??25);safeInteger(limit);orgAssert(limit<=50,400,'INVALID_REQUEST');const revision=c.store.state().revision,after=cursor(url.searchParams.get('cursor'),actor,revision),sql=c.store.storage.sql;
  let rows:any[];
  if(route.action==='members'){
   rows=sql.exec('SELECT u.id AS userId,m.id AS membershipId,u.display_name AS displayName,u.email,m.role,CASE WHEN m.status=\'active\' AND u.status=\'active\' THEN \'active\' ELSE \'disabled\' END AS status,m.revision FROM flora_org_users u JOIN flora_org_memberships m ON m.user_id=u.id WHERE m.org_id=? AND u.id>? ORDER BY u.id LIMIT ?',actor.organizationId,after,limit+1).toArray();
   for(const row of rows.slice(0,limit)){const access=sql.exec<{app_id:string}>('SELECT app_id FROM flora_org_app_access WHERE membership_id=? AND active=1 ORDER BY app_id LIMIT 51',row.membershipId).toArray();row.appIds=access.slice(0,50).map(r=>r.app_id);row.hasMoreApps=access.length>50}
  }else{
   orgAssert(after===''||/^[1-9][0-9]*$/.test(after),400,'INVALID_REQUEST');const n=after===''?Number.MAX_SAFE_INTEGER:Number(after);safeInteger(n);
   rows=sql.exec<{sequence:number;data:string;created_at:number}>('SELECT sequence,data,created_at FROM flora_org_audit WHERE sequence<? ORDER BY sequence DESC LIMIT ?',n,limit+1).toArray().map(r=>({sequence:r.sequence,event:JSON.parse(r.data),createdAt:r.created_at}));
  }
  const items=rows.slice(0,limit),last=items.at(-1),nextCursor=rows.length>limit?btoa(JSON.stringify({org:actor.organizationId,user:actor.userId,revision,after:String(route.action==='members'?last.userId:last.sequence)})):null;return json({items,nextCursor});
 }
 c.invitations.owner(actor,c.now());
 if(route.action==='issue'){const input=await body(request,['purpose','email','targetUserId','expectedRevision','role','appIds']);c.invitations.owner(actor,c.now());return json(await c.invitations.issue(actor,input as unknown as InvitationInput,c.now()),201)}
 const input=await body(request,route.action==='access'?['expectedRevision','role','addAppIds','removeAppIds']:['expectedRevision']);safeInteger(input.expectedRevision);c.invitations.owner(actor,c.now());
 if(route.action==='revoke'){c.invitations.revoke(actor,route.id!,input.expectedRevision,c.now());return json({ok:true})}
 if(route.action==='access'){
  orgAssert(Object.keys(input).length===4&&Array.isArray(input.addAppIds)&&Array.isArray(input.removeAppIds),400,'INVALID_REQUEST');
  if(input.addAppIds.length)await c.invitations.verifyApps(input.addAppIds as string[]);
  c.store.atomic(()=>{c.invitations.owner(actor,c.now());c.store.setAccess(actor,route.id!,input as unknown as MembershipInput,c.now())});return json({ok:true});
 }
 c.store.atomic(()=>{c.invitations.owner(actor,c.now());c.store.disable(actor,route.id!,input.expectedRevision as number,c.now())});return json({ok:true});
}
