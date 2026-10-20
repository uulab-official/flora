import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createOrgFixture} from './org-fixtures.ts';

// Removing organization initialization, binding validation, or atomic audit
// must break these tests while all pre-existing authority rows remain intact.
test('bootstrap_adds_only_org_rows',async t=>{
  const h=await createOrgFixture(t);
  await h.sql('CREATE TABLE legacy_inflight (id TEXT PRIMARY KEY, ciphertext TEXT, lease TEXT)');
  await h.sql('INSERT INTO legacy_inflight VALUES(?,?,?)',['job-1','unchanged-ciphertext','active-lease']);
  const before=await h.snapshot();
  const r=await h.control({action:'bootstrap'});assert.equal(r.status,200);
  const organization=await r.json() as any;assert.equal(organization.mode,'owner_only');
  await h.control({action:'restart'});
  const again=await h.control({action:'bootstrap'});assert.equal(again.status,200);
  assert.deepEqual(await again.json(),organization);
  assert.deepEqual(await h.snapshot(),before);
  assert.equal((await h.sql("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'flora_org_%'")).length,11);
  assert.deepEqual(await h.sql('SELECT * FROM flora_org_passwords'),[]);
});

test('bootstrap_rejects_identity_drift',async t=>{
  const h=await createOrgFixture(t);assert.equal((await h.control({action:'bootstrap'})).status,200);
  const before=await h.snapshot();
  for(const patch of [{FLORA_OWNER_ID:'other-owner'},{FLORA_DB_IDENTITY:'other-db'},{FLORA_ORIGIN:'https://other.example.test'}]){
    const response=await h.control({action:'restart',env:patch});assert.equal(response.status,503);
    // Restore the environment explicitly; no original storage is repaired by the constructor.
    await h.control({action:'restart',env:{FLORA_OWNER_ID:'synthetic-owner',FLORA_DB_IDENTITY:'synthetic-db',FLORA_ORIGIN:'https://organization.example.test'}});
  }
  assert.deepEqual(await h.snapshot(),before);
});

test('protected_owner_and_atomic_budget',async t=>{
  const h=await createOrgFixture(t);
  let r=await h.control({action:'bootstrap',owner:{epoch:7,claimed:true}});assert.equal(r.status,200);
  const org=await r.json() as any;
  const [owner]=await h.sql("SELECT u.id AS userId,m.id AS membershipId,m.revision FROM flora_org_users u JOIN flora_org_memberships m ON m.user_id=u.id WHERE u.auth_source='legacy_owner'");
  const actor={organizationId:org.id,userId:owner.userId,membershipId:owner.membershipId,role:'owner',authSource:'legacy_owner',authEpoch:1,membershipRevision:owner.revision,ownerEpoch:7,sessionHash:'a'.repeat(64),expiresAt:1_800_000_600_000};
  const original=await h.sql('SELECT * FROM flora_org_memberships');
  r=await h.control({action:'access',actor,userId:owner.userId,input:{expectedRevision:1,role:'viewer',addAppIds:[],removeAppIds:[]}});
  assert.equal(r.status,409);assert.deepEqual(await r.json(),{error:'BOOTSTRAP_OWNER_PROTECTED'});
  assert.deepEqual(await h.sql('SELECT * FROM flora_org_memberships'),original);
  assert.equal((await h.sql('SELECT * FROM flora_org_audit')).length,0);
  assert.deepEqual(await h.sql('SELECT * FROM flora_org_passwords'),[]);
});

test('RF1_owner_email_is_reserved',async t=>{
  const h=await createOrgFixture(t);assert.equal((await h.control({action:'bootstrap',owner:{epoch:1,claimed:true}})).status,200);
  const [u]=await h.sql("SELECT email,auth_source FROM flora_org_users WHERE auth_source='legacy_owner'");
  assert.deepEqual(u,{email:'owner@example.test',auth_source:'legacy_owner'});
  await assert.rejects(h.sql("INSERT INTO flora_org_users(id,email,display_name,auth_source,status,auth_epoch) VALUES('new-user','owner@example.test','Other','member','active',1)"));
  assert.equal((await h.sql("SELECT * FROM flora_org_users")).length,1);
});

test('configured_limits_reject_invalid_or_unsafe_bytes',async t=>{
  const h=await createOrgFixture(t,{FLORA_ORG_METADATA_BYTES:'1'});
  const r=await h.control({action:'bootstrap',owner:{epoch:1,claimed:true}});
  assert.equal(r.status,409);assert.deepEqual(await r.json(),{error:'ORG_ACCESS_CAPACITY'});
  assert.deepEqual(await h.sql('SELECT * FROM flora_org_users'),[]);
});

test('access_expansion_and_audit_are_atomic_at_budget_boundary',async t=>{
 const h=await createOrgFixture(t,{FLORA_ORG_AUDIT_BYTES:'1'});
 const r=await h.control({action:'bootstrap',owner:{epoch:7,claimed:true}});assert.equal(r.status,200);
 const org=await r.json() as any;
 const [owner]=await h.sql("SELECT u.id AS userId,m.id AS membershipId,m.revision FROM flora_org_users u JOIN flora_org_memberships m ON m.user_id=u.id WHERE u.auth_source='legacy_owner'");
 await h.sql("INSERT INTO flora_org_users VALUES('user-member','member@example.test','Member','member','active',1)");
 await h.sql("INSERT INTO flora_org_memberships VALUES('membership-member',?,'user-member','viewer','active',1)",[org.id]);
 const actor={organizationId:org.id,userId:owner.userId,membershipId:owner.membershipId,role:'owner',authSource:'legacy_owner',authEpoch:1,membershipRevision:owner.revision,ownerEpoch:7,sessionHash:'a'.repeat(64),expiresAt:1_800_000_600_000};
 const original=await h.sql('SELECT * FROM flora_org_state');
 const expanded=await h.control({action:'access',actor,userId:'user-member',input:{expectedRevision:1,role:'admin',addAppIds:['app_first'],removeAppIds:[]}});
 assert.equal(expanded.status,409);assert.deepEqual(await expanded.json(),{error:'ORG_ACCESS_CAPACITY'});
 assert.deepEqual(await h.sql('SELECT * FROM flora_org_app_access'),[]);
 assert.equal((await h.sql("SELECT revision FROM flora_org_memberships WHERE id='membership-member'"))[0].revision,1);
 assert.deepEqual(await h.sql('SELECT * FROM flora_org_state'),original);
 assert.deepEqual(await h.sql('SELECT * FROM flora_org_audit'),[]);
 const contracted=await h.control({action:'access',actor,userId:'user-member',input:{expectedRevision:1,role:'viewer',addAppIds:[],removeAppIds:[]}});
 assert.equal(contracted.status,200);
 const events=await h.sql('SELECT safety,data FROM flora_org_audit');assert.equal(events.length,1);assert.equal(events[0].safety,1);
});

test('capacity_reduction_does_not_prevent_durable_permission_contraction',async t=>{
 const h=await createOrgFixture(t);
 let r=await h.control({action:'bootstrap',owner:{epoch:7,claimed:true}});assert.equal(r.status,200);const org=await r.json() as any;
 const [owner]=await h.sql("SELECT u.id AS userId,m.id AS membershipId,m.revision FROM flora_org_users u JOIN flora_org_memberships m ON m.user_id=u.id WHERE u.auth_source='legacy_owner'");
 await h.sql("INSERT INTO flora_org_users VALUES('user-member','member@example.test','Member','member','active',1)");
 await h.sql("INSERT INTO flora_org_memberships VALUES('membership-member',?,'user-member','admin','active',1)",[org.id]);
 await h.sql("INSERT INTO flora_org_app_access VALUES('membership-member','app_first',1)");
 const actor={organizationId:org.id,userId:owner.userId,membershipId:owner.membershipId,role:'owner',authSource:'legacy_owner',authEpoch:1,membershipRevision:owner.revision,ownerEpoch:7,sessionHash:'a'.repeat(64),expiresAt:1_800_000_600_000};
 await h.control({action:'restart',env:{FLORA_ORG_METADATA_BYTES:'1',FLORA_ORG_AUDIT_BYTES:'1'}});
 r=await h.control({action:'access',actor,userId:'user-member',input:{expectedRevision:1,role:'viewer',addAppIds:[],removeAppIds:['app_first']}});
 assert.equal(r.status,200);
 assert.deepEqual((await h.sql("SELECT role,revision FROM flora_org_memberships WHERE id='membership-member'"))[0],{role:'viewer',revision:2});
 assert.equal((await h.sql("SELECT active FROM flora_org_app_access WHERE membership_id='membership-member'"))[0].active,0);
 assert.equal((await h.sql('SELECT safety FROM flora_org_audit')).at(-1).safety,1);
});


test('organization_capacity_failure_keeps_existing_owner_session_available',async t=>{
 const h=await createOrgFixture(t);
 const session=Buffer.alloc(32,1),csrf=Buffer.alloc(32,2),hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
 await h.sql("UPDATE flora_auth_meta SET epoch=7,verifier='{}' WHERE id=1");
 await h.sql('INSERT INTO flora_auth_sessions(session_hash,csrf_hash,epoch,expires_at) VALUES(?,?,7,?)',[hash(session),hash(csrf),Date.now()+600_000]);
 const before=await h.snapshot();
 await h.control({action:'restart',env:{FLORA_ORG_METADATA_BYTES:'1'}});
 const response=await h.runtime.fetch('https://organization.example.test/api/auth/session',{headers:{Cookie:'__Host-flora_session='+session.toString('base64url')+'; __Host-flora_csrf='+csrf.toString('base64url')}});
 assert.equal(response.status,200);
 assert.deepEqual(await h.snapshot(),before);
});


test('audit_intent_fence_and_single_settlement_are_durable',async t=>{
 const h=await createOrgFixture(t);await h.control({action:'bootstrap'});
 const before=await h.sql('SELECT * FROM flora_org_state');
 let r=await h.control({action:'audit-begin',input:{actor:{kind:'human',id:'synthetic-user'},action:'app.deploy',appId:'app_first'},revoked:true});
 assert.equal(r.status,403);assert.deepEqual(await h.sql('SELECT * FROM flora_org_audit'),[]);assert.deepEqual(await h.sql('SELECT * FROM flora_org_state'),before);
 r=await h.control({action:'audit-begin',input:{actor:{kind:'human',id:'synthetic-user'},action:'app.deploy',appId:'app_first'}});assert.equal(r.status,200);
 const intent=await r.json() as any;assert.equal(intent.state,'pending');
 r=await h.control({action:'audit-settle',id:intent.id,state:'completed',refs:{password:'not-allowed'}});assert.equal(r.status,400);
 assert.equal((await h.sql('SELECT * FROM flora_org_audit')).length,1);
 for(let i=0;i<2;i++){r=await h.control({action:'audit-settle',id:intent.id,state:'completed',refs:{jobId:'synthetic-job'}});assert.equal(r.status,200);}
 assert.deepEqual((await h.sql('SELECT phase FROM flora_org_audit ORDER BY sequence')).map(e=>e.phase),['pending','completed']);
 assert.equal((await h.control({action:'audit-settle',id:intent.id,state:'rejected'})).status,409);
});

test('existing_unicode_owner_email_keeps_legacy_identity_and_org_bootstrap',async t=>{
 const h=await createOrgFixture(t,{FLORA_OWNER_EMAIL:'소유자@example.test'});
 const response=await h.control({action:'bootstrap',owner:{epoch:1,claimed:true}});assert.equal(response.status,200);
 assert.deepEqual((await h.sql("SELECT email,auth_source FROM flora_org_users WHERE auth_source='legacy_owner'"))[0],{email:'소유자@example.test',auth_source:'legacy_owner'});
 assert.deepEqual(await h.sql('SELECT * FROM flora_org_passwords'),[]);
});


test('audit_rejects_unknown_actor_or_action_before_immutable_write',async t=>{
 const h=await createOrgFixture(t);await h.control({action:'bootstrap'});
 for(const input of [{actor:{kind:'unknown',id:'synthetic-user'},action:'app.deploy'},{actor:{kind:'human',id:'synthetic-user'},action:'unknown-action'}])assert.equal((await h.control({action:'audit-begin',input})).status,400);
 assert.deepEqual(await h.sql('SELECT * FROM flora_org_audit'),[]);
});
test('audit_event_envelope_is_included_in_two_kibibyte_limit',async t=>{
 const h=await createOrgFixture(t);await h.control({action:'bootstrap'});const before=await h.sql('SELECT * FROM flora_org_state');
 const r=await h.control({action:'audit-raw',data:{message:'x'.repeat(2000)}});assert.equal(r.status,409);
 assert.deepEqual(await h.sql('SELECT * FROM flora_org_audit'),[]);assert.deepEqual(await h.sql('SELECT * FROM flora_org_state'),before);
});


test('critical_events_use_ordinary_audit_capacity_before_finite_safety_reserve',async t=>{
 const h=await createOrgFixture(t);await h.control({action:'bootstrap'});
 const r=await h.control({action:'audit-raw',data:{action:'member-disabled'},safety:true});assert.equal(r.status,200);
 const [state]=await h.sql('SELECT audit_bytes,safety_bytes FROM flora_org_state');assert.ok(state.audit_bytes>0);assert.equal(state.safety_bytes,0);
});
