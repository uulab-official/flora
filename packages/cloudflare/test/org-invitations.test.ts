import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createMemberAuthFixture,sessionCookies} from './org-fixtures.ts';
async function invitationsFixture(t:TestContext){
 const h=await createMemberAuthFixture(t);
 for(const name of ['0001_private_imports.sql','0002_multi_app.sql']){
  const sql=await readFile(new URL('../migrations/'+name,import.meta.url),'utf8');
  await h.runtime.d1.exec(sql.replace(/^--.*$/gm,'').split(/;\s*(?=CREATE|INSERT|DROP|PRAGMA|$)/).filter(s=>s.trim()).map(s=>s.replace(/\s*\n\s*/g,' ').trim()+';').join('\n'));
 }
 await h.runtime.d1.prepare('INSERT INTO flora_deployment(singleton,owner_id,origin,db_identity) VALUES(1,?,?,?)').bind('synthetic-owner','https://organization.example.test','synthetic-db').run();
 const apps:string[]=[];
 for(const name of ['First','Second']){
  const r=await h.request(h.owner,'POST','/api/apps',{name,repositoryId:'github:synthetic/'+name.toLowerCase(),rootDirectory:'.'});assert.equal(r.status,201);apps.push((await r.json() as any).id);
 }
 async function reauth(){const r=await h.request(h.owner,'POST','/api/auth/reauth',{password:h.ownerPassword});assert.equal(r.status,200);}
 async function issue(input:Record<string,unknown>={}){
  const org=await h.sql('SELECT revision FROM flora_org_state');
  const r=await h.request(h.owner,'POST','/api/organization/invitations',{purpose:'invite',email:'new@example.test',expectedRevision:org[0].revision,role:'deployer',appIds:[apps[0]],...input});
  assert.equal(r.status,201);return await r.json() as any;
 }
 const accept=(nonce:string,email='new@example.test',password='synthetic-invited-password')=>h.request(null,'POST','/api/auth/member/accept',{nonce,email,password,confirmation:password});
 const preview=(nonce:string)=>h.request(null,'POST','/api/auth/member/preview',{nonce});
 await reauth();return {...h,apps,reauth,issue,accept,preview};
}

test('RF1_reserved_and_normalized_email',async t=>{
 const h=await invitationsFixture(t);const [{revision}]=await h.sql('SELECT revision FROM flora_org_state');
 const r=await h.request(h.owner,'POST','/api/organization/invitations',{purpose:'invite',email:' owner@EXAMPLE.test ',expectedRevision:revision,role:'viewer',appIds:[]});assert.equal(r.status,409);
 const issued=await h.issue({email:' New@EXAMPLE.test '});
 const preview=await h.preview(issued.nonce);assert.equal(preview.status,200);const publicInfo=await preview.json() as any;
 assert.equal(publicInfo.appCount,1);assert.equal(publicInfo.role,'deployer');assert.ok(!JSON.stringify(publicInfo).includes('new@example.test'));assert.ok(!JSON.stringify(publicInfo).includes(h.apps[0]!));
 const wrong=await h.accept(issued.nonce,'wrong@example.test');assert.equal(wrong.status,403);
 const accepted=await h.accept(issued.nonce,'NEW@example.test');assert.equal(accepted.status,200);
 assert.equal((await h.sql("SELECT email FROM flora_org_users WHERE auth_source='member'"))[0].email,'new@example.test');
 assert.ok(!JSON.stringify(await h.sql('SELECT * FROM flora_org_invites')).includes(issued.nonce));
});
test('nonce_accepts_once_and_preserves_consumed_history',async t=>{
 const h=await invitationsFixture(t),issued=await h.issue();
 const responses=await Promise.all([h.accept(issued.nonce),h.accept(issued.nonce)]);
 assert.equal(responses.filter(r=>r.status===200).length,1);
 assert.ok(responses.every(r=>[200,403,409].includes(r.status)));
 assert.equal((await h.accept(issued.nonce)).status,403);
 assert.equal((await h.sql("SELECT * FROM flora_org_users WHERE email='new@example.test'")).length,1);
 assert.equal((await h.sql('SELECT * FROM flora_org_invites WHERE consumed_at IS NOT NULL')).length,1);
});
test('RF4_reset_after_kdf_cannot_restore_old_access',async t=>{
 const h=await invitationsFixture(t),m=await h.member();
 const old=await h.issue({purpose:'reset',email:m.email,targetUserId:m.userId,expectedRevision:1,role:undefined,appIds:undefined});
 const change=await h.request(h.owner,'POST','/api/organization/members/'+m.userId+'/access',{expectedRevision:1,role:'viewer',addAppIds:[h.apps[1]],removeAppIds:['app_first']});assert.equal(change.status,200);
 assert.equal((await h.preview(old.nonce)).status,403);
 assert.equal((await h.accept(old.nonce,m.email)).status,403);
 const current=await h.sql('SELECT * FROM flora_org_app_access WHERE membership_id=? ORDER BY app_id',[m.membershipId]);
 const valid=await h.issue({purpose:'reset',email:m.email,targetUserId:m.userId,expectedRevision:2,role:undefined,appIds:undefined});
 assert.equal((await h.accept(valid.nonce,m.email)).status,200);
 assert.deepEqual(await h.sql('SELECT * FROM flora_org_app_access WHERE membership_id=? ORDER BY app_id',[m.membershipId]),current);
 assert.equal((await h.sql('SELECT role FROM flora_org_memberships WHERE id=?',[m.membershipId]))[0].role,'viewer');
});
test('reset_does_not_reactivate_and_reactivate_preserves_user_id',async t=>{
 const h=await invitationsFixture(t),m=await h.member(),reset=await h.issue({purpose:'reset',email:m.email,targetUserId:m.userId,expectedRevision:1,role:undefined,appIds:undefined});
 const disabled=await h.request(h.owner,'POST','/api/organization/members/'+m.userId+'/disable',{expectedRevision:1});assert.equal(disabled.status,200);
 assert.equal((await h.accept(reset.nonce,m.email)).status,403);
 const reactivate=await h.issue({purpose:'reactivate',email:m.email,targetUserId:m.userId,expectedRevision:2,role:'viewer',appIds:[h.apps[1]]});
 const r=await h.accept(reactivate.nonce,m.email);assert.equal(r.status,200);
 const users=await h.sql('SELECT id,auth_epoch FROM flora_org_users WHERE email=?',[m.email]);assert.equal(users.length,1);assert.equal(users[0].id,m.userId);assert.equal(users[0].auth_epoch,3);
 assert.deepEqual((await h.sql('SELECT app_id FROM flora_org_app_access WHERE membership_id=? AND active=1',[m.membershipId])).map(v=>v.app_id),[h.apps[1]]);
});
test('lost_accept_response_login_recovers_without_nonce_replay',async t=>{
 const h=await invitationsFixture(t),issued=await h.issue();
 const response=await h.accept(issued.nonce);assert.equal(response.status,200);await response.arrayBuffer(); // Discard a committed response, not a second mutation.
 const s=await h.login({email:'new@example.test',password:'synthetic-invited-password'});
 assert.equal((await h.request(s,'GET','/api/auth/session')).status,200);
 assert.equal((await h.accept(issued.nonce)).status,403);
});
test('step_up_and_csrf_required_and_expiry_is_session_specific',async t=>{
 const h=await invitationsFixture(t),org=(await h.sql('SELECT revision FROM flora_org_state'))[0];
 const second=await h.login({email:'Owner@example.test',password:h.ownerPassword});
 let r=await h.request(second,'POST','/api/organization/invitations',{purpose:'invite',email:'other@example.test',expectedRevision:org.revision,role:'viewer',appIds:[]});assert.equal(r.status,403);
 r=await h.request({...h.owner,csrfToken:'wrong'},'POST','/api/organization/invitations',{purpose:'invite',email:'other@example.test',expectedRevision:org.revision,role:'viewer',appIds:[]});assert.equal(r.status,403);
 await h.control({now:h.now+300_000});
 r=await h.request(h.owner,'POST','/api/organization/invitations',{purpose:'invite',email:'other@example.test',expectedRevision:org.revision,role:'viewer',appIds:[]});assert.equal(r.status,403);
});
test('reissue_revoke_expiry_and_owner_epoch_keep_prior_nonce_rows',async t=>{
 const h=await invitationsFixture(t),first=await h.issue(),second=await h.issue();
 assert.equal((await h.preview(first.nonce)).status,403);
 const revoked=await h.request(h.owner,'POST','/api/organization/invitations/'+second.id+'/revoke',{expectedRevision:second.revision});assert.equal(revoked.status,200);
 assert.equal((await h.preview(second.nonce)).status,403);assert.equal((await h.sql('SELECT * FROM flora_org_invites')).length,2);
 const third=await h.issue();await h.sql('UPDATE flora_auth_meta SET epoch=epoch+1');
 assert.equal((await h.preview(third.nonce)).status,403);
 assert.equal((await h.sql('SELECT * FROM flora_org_invites')).length,3);
});
test('member_and_out_of_installation_scope_cannot_manage_people_or_assign_apps',async t=>{
 const h=await invitationsFixture(t),m=await h.member('admin'),s=await h.login(m);
 for(const path of ['/api/organization/members','/api/organization/audit'])assert.equal((await h.request(s,'GET',path)).status,403);
 assert.equal((await h.request(s,'GET','/api/organization')).status,200);
 assert.equal((await h.request(s,'POST','/api/organization/invitations',{purpose:'invite'})).status,403);
 const org=(await h.sql('SELECT revision FROM flora_org_state'))[0];
 assert.equal((await h.request(h.owner,'POST','/api/organization/invitations',{purpose:'invite',email:'other@example.test',expectedRevision:org.revision,role:'viewer',appIds:['application_foreign']})).status,404);
});
test('reset_payload_cannot_supply_role_or_app_access',async t=>{
 const h=await invitationsFixture(t),m=await h.member();
 const r=await h.request(h.owner,'POST','/api/organization/invitations',{purpose:'reset',email:m.email,targetUserId:m.userId,expectedRevision:1,role:'admin',appIds:[h.apps[0]]});assert.equal(r.status,400);
 assert.deepEqual(await h.sql('SELECT * FROM flora_org_invites'),[]);
});
test('reset_nonce_is_stale_if_membership_changes_during_kdf',async t=>{
 const h=await invitationsFixture(t),m=await h.member(),issued=await h.issue({purpose:'reset',email:m.email,targetUserId:m.userId,expectedRevision:1,role:undefined,appIds:undefined});
 const before=await h.sql('SELECT verifier FROM flora_org_passwords WHERE user_id=?',[m.userId]);
 await h.control({holdHashAt:2});const pending=h.accept(issued.nonce,m.email);
 try{
  let held=false;for(let i=0;i<200;i++){held=(await(await h.control({action:'hash-state'})).json() as any).held;if(held)break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(held,true);await h.sql('UPDATE flora_org_memberships SET revision=2 WHERE id=?',[m.membershipId]);
 }finally{await h.control({action:'release-hash'});}
 assert.equal((await pending).status,403);assert.deepEqual(await h.sql('SELECT verifier FROM flora_org_passwords WHERE user_id=?',[m.userId]),before);
 assert.equal((await h.sql('SELECT consumed_at FROM flora_org_invites WHERE id=?',[issued.id]))[0].consumed_at,null);
});


test('busy_public_accept_rejects_before_reading_or_retaining_password_body',async t=>{
 const h=await invitationsFixture(t);await h.control({heavy:'take'});
 try{const r=await h.runtime.fetch('https://organization.example.test/__test/unread-public-accept');assert.deepEqual(await r.json(),{status:409,reads:0});}finally{await h.control({heavy:'release'});}
});
test('invite_24h_and_reset_15m_expiry_are_not_issuer_session_expiry',async t=>{
 const h=await invitationsFixture(t),issued=await h.issue();
 await h.control({now:h.now+3_600_001});assert.equal((await h.preview(issued.nonce)).status,200);
 await h.control({now:h.now+86_400_000});assert.equal((await h.preview(issued.nonce)).status,403);
 const second=await invitationsFixture(t),m=await second.member(),reset=await second.issue({purpose:'reset',email:m.email,targetUserId:m.userId,expectedRevision:1,role:undefined,appIds:undefined});
 await second.control({now:second.now+900_000});assert.equal((await second.preview(reset.nonce)).status,403);
});
