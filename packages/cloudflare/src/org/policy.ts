import {OrgStore} from './store.js';
import {orgActions,orgAssert,orgId,safeInteger} from './types.js';
import type {OrgAction,OrgPage,OrgPrincipal} from './types.js';
import type {AuthGrant} from '../contracts.js';
/** Pure local authority: no D1, network, token issuance or cached access decisions. */
export class OrgPolicy {
 constructor(private readonly store:OrgStore){}
 resolveLegacy(grant:AuthGrant,now:number):OrgPrincipal {
  const state=this.store.bootstrap({epoch:grant.epoch,claimed:true},now);
  orgAssert(state.ownerId===grant.ownerId,403,'MEMBERSHIP_CHANGED');
  const owner=this.store.storage.sql.exec<{id:string}>("SELECT id FROM flora_org_users WHERE auth_source='legacy_owner'").one();
  const member=this.store.member(owner.id);orgAssert(member&&member.role==='owner',503,'ORG_ACCESS_NOT_ACTIVE');
  return Object.freeze({organizationId:state.id,userId:owner.id,membershipId:member.membershipId,role:'owner',authSource:'legacy_owner',authEpoch:member.authEpoch,membershipRevision:member.membershipRevision,ownerEpoch:grant.epoch,sessionHash:grant.sessionHash,expiresAt:grant.expiresAt});
 }
 require(principal:OrgPrincipal,action:OrgAction,appId:string|undefined,now:number):void {
  safeInteger(now,0);orgAssert(orgActions.includes(action));
  const state=this.store.state();
  this.store.assertActor(principal,now);
  const epoch=this.store.storage.sql.exec<{epoch:number}>('SELECT epoch FROM flora_auth_meta WHERE id=1').one().epoch;
  orgAssert(principal.ownerEpoch===epoch,403,'MEMBERSHIP_CHANGED');
  if(principal.role!=='owner')orgAssert(state.mode==='active',503,'ORG_ACCESS_NOT_ACTIVE');
  const appScoped=!action.startsWith('org.')&&action!=='runner.organization';
  if(appScoped){orgAssert(appId!==undefined,400,'INVALID_REQUEST');orgId(appId);}
  if(principal.role==='owner')return;
  if(action==='org.self')return;
  if(appId!==undefined){orgId(appId);const access=this.store.storage.sql.exec<{active:number}>('SELECT active FROM flora_org_app_access WHERE membership_id=? AND app_id=?',principal.membershipId,appId).toArray()[0];orgAssert(access?.active===1,404,'NOT_FOUND');}
  if(action==='org.manage'||action==='runner.organization')orgAssert(false);
  if(action==='app.read'||action==='credential.read')return;
  if(action==='app.deploy'||action==='runner.request')orgAssert(principal.role==='admin'||principal.role==='deployer');
  else orgAssert(principal.role==='admin');
 }
 fence(principal:OrgPrincipal,action:OrgAction,appId?:string):()=>void {
  // Copy the captured identity so a caller cannot replace the held revision.
  const captured=Object.freeze({...principal});
  this.require(captured,action,appId,Date.now());
  return ()=>this.require(captured,action,appId,Date.now());
 }
 visibleApps(principal:OrgPrincipal,cursor:string|null,limit:number,filter=''):OrgPage<string> {
  this.require(principal,'org.self',undefined,Date.now());safeInteger(limit);orgAssert(limit<=50,400,'INVALID_REQUEST');
  // Owner's unbounded app listing remains in the existing owner-scoped D1 API.
  if(principal.role==='owner')return {items:[],nextCursor:null};
  let after='';
  if(cursor!==null){
   orgAssert(typeof cursor==='string'&&cursor.length<=2048,400,'INVALID_REQUEST');let parsed:Record<string,unknown>;
   try{parsed=JSON.parse(atob(cursor))}catch{orgAssert(false,400,'INVALID_REQUEST')}
   orgAssert(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&Object.keys(parsed).length===(filter?6:5),400,'INVALID_REQUEST');
   orgAssert(parsed.v===1&&parsed.organizationId===principal.organizationId&&parsed.userId===principal.userId&&parsed.revision===principal.membershipRevision&&parsed.filter===(filter||undefined),403,'MEMBERSHIP_CHANGED');
   orgId(parsed.after);after=parsed.after;
  }
  const rows=this.store.storage.sql.exec<{app_id:string}>('SELECT app_id FROM flora_org_app_access WHERE membership_id=? AND active=1 AND app_id>? ORDER BY app_id LIMIT ?',principal.membershipId,after,limit+1).toArray();
  const items=rows.slice(0,limit).map(r=>r.app_id);
  return {items,nextCursor:rows.length>limit?btoa(JSON.stringify({v:1,organizationId:principal.organizationId,userId:principal.userId,revision:principal.membershipRevision,...(filter?{filter}:{}),after:items.at(-1)})):null};
 }
}
