import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {createMemberAuthFixture,sessionCookies} from './org-fixtures.ts';

test('member_sessions_do_not_evict_owner',async t=>{
 const h=await createMemberAuthFixture(t),a=await h.member(),before=await h.sql('SELECT * FROM flora_auth_sessions');
 const session=await h.login(a);
 assert.equal((await h.request(session,'GET','/api/auth/session')).status,200);
 assert.equal((await h.request(h.owner,'GET','/api/auth/session')).status,200);
 assert.deepEqual(await h.sql('SELECT * FROM flora_auth_sessions'),before);
 const rows=await h.sql('SELECT * FROM flora_org_sessions');assert.equal(rows.length,1);
 assert.ok(!JSON.stringify(rows).includes(session.csrfToken));
 const logout=await h.request(session,'POST','/api/auth/logout',{});assert.equal(logout.status,200);
 assert.equal((await h.request(session,'GET','/api/auth/session')).status,401);
 assert.equal((await h.request(h.owner,'GET','/api/auth/session')).status,200);
});
test('sixth_session_evicts_only_same_user',async t=>{
 const h=await createMemberAuthFixture(t),a=await h.member(),b=await h.member('viewer','b'),bSession=await h.login(b),sessions=[];
 for(let i=0;i<5;i++)sessions.push(await h.login(a));
 await h.control({now:h.now+900_000});sessions.push(await h.login(a));
 assert.equal((await h.request(sessions[0]!,'GET','/api/auth/session')).status,401);
 for(const s of sessions.slice(1))assert.equal((await h.request(s,'GET','/api/auth/session')).status,200);
 assert.equal((await h.request(bSession,'GET','/api/auth/session')).status,200);
 assert.equal((await h.request(h.owner,'GET','/api/auth/session')).status,200);
});
test('RF4_member_budget_cannot_starve_owner',async t=>{
 const h=await createMemberAuthFixture(t),a=await h.member(),before=await h.sql('SELECT * FROM flora_auth_budget');
 for(let i=0;i<5;i++)assert.equal((await h.request(null,'POST','/api/auth/login',{email:a.email,password:'synthetic-wrong-password'})).status,401);
 assert.equal((await h.request(null,'POST','/api/auth/login',a)).status,400); // strict body rejects extra fields, not an authentication attempt
 const limited=await h.request(null,'POST','/api/auth/login',{email:a.email,password:a.password});assert.equal(limited.status,429);
 assert.deepEqual(await h.sql('SELECT * FROM flora_auth_budget'),before);
 assert.equal((await h.request(h.owner,'GET','/api/auth/session')).status,200);
 assert.equal((await h.request(null,'POST','/api/auth/login',{email:'Owner@example.test',password:h.ownerPassword})).status,200);
});
test('member_password_change_revokes_old_sessions',async t=>{
 const h=await createMemberAuthFixture(t),a=await h.member(),s=await h.login(a),next='synthetic-replacement-password';
 const response=await h.request(s,'POST','/api/auth/member/password',{currentPassword:a.password,password:next,confirmation:next});assert.equal(response.status,200);
 assert.equal((await h.request(s,'GET','/api/auth/session')).status,401);
 assert.equal((await h.request(h.owner,'GET','/api/auth/session')).status,200);
 assert.equal((await h.request(null,'POST','/api/auth/login',{email:a.email,password:a.password})).status,401);
 assert.equal((await h.request(await h.login({...a,password:next}),'GET','/api/auth/session')).status,200);
 assert.equal((await h.sql('SELECT auth_epoch FROM flora_org_users WHERE id=?',[a.userId]))[0].auth_epoch,2);
 assert.equal((await h.sql('SELECT revision FROM flora_org_memberships WHERE id=?',[a.membershipId]))[0].revision,2);
});
test('owner_recover_invalidates_members',async t=>{
 const h=await createMemberAuthFixture(t),a=await h.member(),s=await h.login(a),token=randomBytes(32),next='synthetic-owner-recovered-password';
 await h.control({action:'restart',env:{FLORA_SETUP:{digest:createHash('sha256').update(token).digest('hex'),issuedAt:h.now,expiresAt:h.now+600_000,generation:2,purpose:'recover'}}});
 const r=await h.request(null,'POST','/api/auth/recover',{email:'Owner@example.test',password:next,confirmation:next,token:token.toString('base64url')});assert.equal(r.status,200);
 assert.equal((await h.request(s,'GET','/api/auth/session')).status,401);
 assert.equal((await h.request(h.owner,'GET','/api/auth/session')).status,401);
 const owner=sessionCookies(r,(await r.json() as any).csrfToken);assert.equal((await h.request(owner,'GET','/api/auth/session')).status,200);
});
test('ambiguous_session_source_fails_closed',async t=>{
 const h=await createMemberAuthFixture(t),a=await h.member(),s=await h.login(a);
 await h.sql('INSERT INTO flora_auth_sessions(session_hash,csrf_hash,epoch,expires_at) SELECT session_hash,csrf_hash,owner_epoch,expires_at FROM flora_org_sessions WHERE user_id=?',[a.userId]);
 assert.equal((await h.request(s,'GET','/api/auth/session')).status,401);
});
test('unknown_disabled_wrong_password_are_indistinguishable_and_no_legacy_routes_open',async t=>{
 const h=await createMemberAuthFixture(t),a=await h.member(),s=await h.login(a);
 assert.equal((await h.request(s,'GET','/api/github/repositories')).status,403);
 const wrong=await h.request(null,'POST','/api/auth/login',{email:a.email,password:'synthetic-wrong-password'}),unknown=await h.request(null,'POST','/api/auth/login',{email:'missing@example.test',password:'synthetic-wrong-password'});
 assert.equal(wrong.status,401);assert.equal(unknown.status,401);assert.deepEqual(await wrong.json(),await unknown.json());
 await h.sql("UPDATE flora_org_users SET status='disabled' WHERE id=?",[a.userId]);
 const disabled=await h.request(null,'POST','/api/auth/login',{email:a.email,password:a.password});assert.equal(disabled.status,401);
 assert.deepEqual(await disabled.json(),{error:'UNAUTHENTICATED'});
 assert.equal((await h.request(s,'GET','/api/auth/session')).status,401);
});
test('member_session_expiry_and_paused_login_fail_closed',async t=>{
 const h=await createMemberAuthFixture(t),a=await h.member(),s=await h.login(a);
 await h.control({now:h.now+3_600_000});assert.equal((await h.request(s,'GET','/api/auth/session')).status,401);
 await h.sql("UPDATE flora_org_state SET mode='paused'");
 assert.equal((await h.request(null,'POST','/api/auth/login',{email:a.email,password:a.password})).status,503);
});
test('reauthentication_requires_current_password_and_never_copies_owner_verifier',async t=>{
 const h=await createMemberAuthFixture(t),a=await h.member(),s=await h.login(a);
 assert.equal((await h.request(h.owner,'POST','/api/auth/reauth',{password:'synthetic-wrong-password'})).status,401);
 assert.equal((await h.request(h.owner,'POST','/api/auth/reauth',{password:h.ownerPassword})).status,200);
 assert.equal((await h.request(s,'POST','/api/auth/reauth',{password:a.password})).status,200);
 assert.equal((await h.sql("SELECT p.* FROM flora_org_passwords p JOIN flora_org_users u ON u.id=p.user_id WHERE u.auth_source='legacy_owner'")).length,0);
});

test('session_metadata_is_released_on_logout_instead_of_accumulating_forever',async t=>{
 const h=await createMemberAuthFixture(t),a=await h.member();
 let s=await h.login(a);assert.equal((await h.request(s,'POST','/api/auth/logout',{})).status,200);
 const first=(await h.sql('SELECT metadata_bytes FROM flora_org_state'))[0].metadata_bytes;
 await h.control({now:h.now+900_000});s=await h.login(a);assert.equal((await h.request(s,'POST','/api/auth/logout',{})).status,200);
 assert.equal((await h.sql('SELECT metadata_bytes FROM flora_org_state'))[0].metadata_bytes,first);
});
test('reauth_step_up_accounts_for_session_metadata_growth',async t=>{
 const h=await createMemberAuthFixture(t),a=await h.member(),s=await h.login(a),before=(await h.sql('SELECT metadata_bytes FROM flora_org_state'))[0].metadata_bytes;
 assert.equal((await h.request(s,'POST','/api/auth/reauth',{password:a.password})).status,200);
 assert.equal((await h.sql('SELECT metadata_bytes FROM flora_org_state'))[0].metadata_bytes-before,12);
});
test('permission_revocation_after_kdf_before_session_commit_is_denied',async t=>{
 const h=await createMemberAuthFixture(t),a=await h.member();await h.control({holdHash:true});
 const pending=h.request(null,'POST','/api/auth/login',{email:a.email,password:a.password});
 try{
  let held=false;for(let i=0;i<100;i++){held=(await(await h.control({action:'hash-state'})).json() as any).held;if(held)break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(held,true);
  await h.sql('UPDATE flora_org_memberships SET revision=2 WHERE id=?',[a.membershipId]);
 }finally{await h.control({action:'release-hash'});}
 assert.equal((await pending).status,403);
 assert.deepEqual(await h.sql('SELECT * FROM flora_org_sessions WHERE user_id=?',[a.userId]),[]);
});
test('nonowner_aggregate_kdf_cap_does_not_charge_owner_budget',async t=>{
 const h=await createMemberAuthFixture(t),a=await h.member(),before=await h.sql('SELECT * FROM flora_auth_budget');
 await h.sql("INSERT INTO flora_org_auth_budget VALUES('nonowner',?,1,?,240)",[Math.floor(h.now/900_000)*900_000,Math.floor(h.now/3_600_000)*3_600_000]);
 const r=await h.request(null,'POST','/api/auth/login',{email:a.email,password:a.password});assert.equal(r.status,429);
 assert.deepEqual(await h.sql('SELECT * FROM flora_auth_budget'),before);
 assert.equal((await h.request(null,'POST','/api/auth/login',{email:'Owner@example.test',password:h.ownerPassword})).status,200);
});
