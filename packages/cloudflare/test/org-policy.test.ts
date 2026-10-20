import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createOrgFixture} from './org-fixtures.ts';
async function policyFixture(t:TestContext){
 const h=await createOrgFixture(t);let r=await h.control({action:'bootstrap',owner:{epoch:7,claimed:true}});assert.equal(r.status,200);const org=await r.json() as any;
 await h.sql("UPDATE flora_auth_meta SET epoch=7,verifier='{}' WHERE id=1");
 await h.sql("UPDATE flora_org_state SET mode='active' WHERE singleton=1");
 const actors:Record<string,any>={};
 const [owner]=await h.sql("SELECT u.id AS userId,m.id AS membershipId,m.revision FROM flora_org_users u JOIN flora_org_memberships m ON m.user_id=u.id WHERE u.auth_source='legacy_owner'");
 actors.owner={organizationId:org.id,userId:owner.userId,membershipId:owner.membershipId,role:'owner',authSource:'legacy_owner',authEpoch:1,membershipRevision:1,ownerEpoch:7,sessionHash:'a'.repeat(64),expiresAt:Date.now()+600_000};
 for(const role of ['admin','deployer','viewer']){
  await h.sql('INSERT INTO flora_org_users VALUES(?,?,?,\'member\',\'active\',1)',['user-'+role,role+'@example.test',role]);
  await h.sql('INSERT INTO flora_org_memberships VALUES(?,?,?, ?,\'active\',1)',['membership-'+role,org.id,'user-'+role,role]);
  await h.sql('INSERT INTO flora_org_app_access VALUES(?,?,1)',['membership-'+role,'app_first']);
  actors[role]={...actors.owner,userId:'user-'+role,membershipId:'membership-'+role,role,authSource:'member'};
 }
 return {...h,actors,org,check:(role:string,capability:string,appId?:string,patch={})=>h.control({action:'policy',actor:{...actors[role],...patch},capability,...(appId?{appId}:{})})};
}

test('roles_apply_the_entire_action_matrix',async t=>{
 const h=await policyFixture(t);
 const matrix:Record<string,number[]>={
  'org.self':[200,200,200,200],'org.manage':[200,403,403,403],
  'app.read':[200,200,200,200],'app.deploy':[200,200,200,403],'app.manage':[200,200,403,403],
  'credential.read':[200,200,200,200],'credential.manage':[200,200,403,403],
  'runner.request':[200,200,200,403],'runner.approve':[200,200,403,403],'runner.organization':[200,403,403,403]
 };
 for(const [action,statuses]of Object.entries(matrix))for(const [i,role]of ['owner','admin','deployer','viewer'].entries()){
  const r=await h.check(role,action,action.startsWith('org.')||action==='runner.organization'?undefined:'app_first');assert.equal(r.status,statuses[i],role+' '+action);
 }
 assert.equal((await h.check('owner','key.export','app_first')).status,403);
});
test('foreign_app_is_404_and_missing_app_never_grants_global_access',async t=>{
 const h=await policyFixture(t);
 for(const role of ['admin','deployer','viewer']){
  const foreign=await h.check(role,'app.read','app_second'),unknown=await h.check(role,'app.read','app_unknown');
  assert.equal(foreign.status,404);assert.deepEqual(await foreign.json(),await unknown.json());
  assert.equal((await h.check(role,'app.read')).status,400);
  assert.equal((await h.check(role,'app.read','app_first',{organizationId:'other-org'})).status,403);
 }
});
test('RF2_after_await_revision_change',async t=>{
 const h=await policyFixture(t);await h.sql('CREATE TABLE fixture_policy_writes(value TEXT)');
 assert.equal((await h.control({action:'capture-fence',actor:h.actors.deployer,capability:'app.deploy',appId:'app_first'})).status,200);
 await h.sql("UPDATE flora_org_memberships SET role='viewer',revision=2 WHERE id='membership-deployer'");
 assert.equal((await h.control({action:'run-fence'})).status,403);
 assert.deepEqual(await h.sql('SELECT * FROM fixture_policy_writes'),[]);
 assert.equal((await h.check('deployer','app.deploy','app_first')).status,403);
});
test('paused_member_reads_are_denied_and_reactivation_does_not_restore_epoch',async t=>{
 const h=await policyFixture(t);
 for(const mode of ['owner_only','preparing','paused']){
  await h.sql('UPDATE flora_org_state SET mode=?',[mode]);
  assert.equal((await h.check('viewer','app.read','app_first')).status,503);
  assert.equal((await h.check('owner','app.read','app_first')).status,200);
 }
 await h.sql("UPDATE flora_org_state SET mode='active'");await h.sql("UPDATE flora_org_users SET auth_epoch=2 WHERE id='user-viewer'");
 assert.equal((await h.check('viewer','app.read','app_first')).status,403);
});
test('scoped_cursor_is_bounded_and_bound_to_current_membership',async t=>{
 const h=await policyFixture(t);await h.sql("INSERT INTO flora_org_app_access VALUES('membership-viewer','app_second',1)");
 const call=(actor:any,cursor?:string,limit=1)=>h.control({action:'policy-page',actor,cursor,limit});
 let r=await call(h.actors.viewer);assert.equal(r.status,200);const page=await r.json() as any;assert.deepEqual(page.items,['app_first']);assert.equal(typeof page.nextCursor,'string');
 r=await call(h.actors.viewer,page.nextCursor);assert.equal(r.status,200);assert.deepEqual((await r.json() as any).items,['app_second']);
 assert.equal((await call(h.actors.admin,page.nextCursor)).status,403);
 assert.equal((await call(h.actors.viewer,undefined,51)).status,400);
 await h.sql("UPDATE flora_org_memberships SET revision=2 WHERE id='membership-viewer'");
 assert.equal((await call({...h.actors.viewer,membershipRevision:2},page.nextCursor)).status,403);
});
test('forged_grant_is_denied_and_owner_compatibility_survives_logout',async t=>{
 const h=await policyFixture(t),session=Buffer.alloc(32,3),csrf=Buffer.alloc(32,4),hash=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
 await h.sql('INSERT INTO flora_auth_sessions(session_hash,csrf_hash,epoch,expires_at) VALUES(?,?,7,?)',[hash(session),hash(csrf),Date.now()+600_000]);
 const cookie='__Host-flora_session='+session.toString('base64url')+'; __Host-flora_csrf='+csrf.toString('base64url');
 assert.equal((await h.control({action:'capture-grant',headers:{Cookie:cookie}})).status,200);
 assert.equal((await h.control({action:'assert-grant'})).status,200);
 assert.equal((await h.control({action:'assert-grant',forged:true})).status,401);
 await h.sql('DELETE FROM flora_auth_sessions');
 assert.equal((await h.control({action:'assert-grant'})).status,401);
});
test('auth_point_lookups_bounded',async t=>{
 const h=await policyFixture(t),r=await h.check('viewer','app.read','app_first');assert.equal(r.status,200);
 assert.ok((await r.json() as any).pointQueries<=3); // at most joined user/membership + indexed app scope; session belongs to auth adapter
 const queryPlan=await h.sql("EXPLAIN QUERY PLAN SELECT active FROM flora_org_app_access WHERE membership_id='membership-viewer' AND app_id='app_first'");
 assert.ok(queryPlan.every(row=>!String(row.detail).includes('SCAN flora_org_app_access')));
});

test('owner_compatibility_during_first_organization_bootstrap_capacity_failure',async t=>{
 const h=await createOrgFixture(t,{FLORA_ORG_METADATA_BYTES:'1'}),session=Buffer.alloc(32,5),csrf=Buffer.alloc(32,6),hash=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
 await h.sql("UPDATE flora_auth_meta SET epoch=7,verifier='{}' WHERE id=1");
 await h.sql('INSERT INTO flora_auth_sessions(session_hash,csrf_hash,epoch,expires_at) VALUES(?,?,7,?)',[hash(session),hash(csrf),Date.now()+600_000]);
 const r=await h.runtime.fetch('https://organization.example.test/api/auth/session',{headers:{Cookie:'__Host-flora_session='+session.toString('base64url')+'; __Host-flora_csrf='+csrf.toString('base64url')}});
 assert.equal(r.status,200);
 assert.deepEqual(await h.sql('SELECT * FROM flora_org_users'),[]);
});
