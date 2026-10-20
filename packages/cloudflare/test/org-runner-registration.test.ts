import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {createMemberAuthFixture,orgOrigin} from './org-fixtures.ts';
import {RunnerGate} from '../dist/org/runner-gate.js';

async function harness(t:TestContext){
 const h=await createMemberAuthFixture(t);
 for(const name of ['0001_private_imports.sql','0002_multi_app.sql','0003_github_ota.sql','0004_automation.sql','0014_org_runner_access.sql']){
  const sql=await readFile(new URL('../migrations/'+name,import.meta.url),'utf8');await h.runtime.d1.exec(sql.replace(/^--.*$/gm,'').split(/;\s*(?=CREATE|INSERT|DROP|PRAGMA|$)/).filter(s=>s.trim()).map(s=>s.replace(/\s*\n\s*/g,' ').trim()+';').join('\n'));
 }
 await h.runtime.d1.prepare('INSERT INTO flora_deployment VALUES(1,?,?,?)').bind('synthetic-owner',orgOrigin,'synthetic-db').run();
 const apps:string[]=[];for(const name of ['First','Second']){const r=await h.request(h.owner,'POST','/api/apps',{name,repositoryId:name.toLowerCase(),rootDirectory:'.'});assert.equal(r.status,201);apps.push((await r.json()as any).id);}
 const gate=new RunnerGate(h.runtime.d1 as any,'synthetic-owner');await gate.block(1,'operation_fixture_cutover');await gate.seal(1);
 async function account(role:'admin'|'deployer'|'viewer',suffix:string){const user=await h.member(role,suffix);await h.sql('DELETE FROM flora_org_app_access WHERE membership_id=?',[user.membershipId]);await h.sql('INSERT INTO flora_org_app_access VALUES(?,?,1)',[user.membershipId,apps[0]]);return {...user,session:await h.login(user)};}
 const requester=await account('deployer','requester'),approver=await account('admin','approver');
 async function reauth(actor=approver){const r=await h.request(actor.session,'POST','/api/auth/reauth',{password:actor.password});assert.equal(r.status,200);}
 const base='/api/apps/'+apps[0]+'/runner-requests';
 async function requestPC(kind='ota',platforms=['ios','android'],actor=requester){const r=await h.request(actor.session,'POST',base,{kind,name:'QA PC',platforms});assert.equal(r.status,201);return await r.json()as any;}
 async function approve(row:any,actor=approver){const r=await h.request(actor.session,'POST',base+'/'+row.id+'/approve',{expectedRevision:row.revision});assert.equal(r.status,200);return await r.json()as any;}
 const claim=(row:any,actor=requester)=>h.request(actor.session,'POST',base+'/'+row.id+'/claim',{expectedRevision:row.revision});
 async function service(ref:{kind:string;runnerId:string},appId=apps[0],platform='ios'){return h.control({action:'runner-service',ref,appId,platform});}
 await reauth();return {...h,apps,base,gate,account,requester,approver,reauth,requestPC,approve,claim,service};
}
test('RF3_approver_demotion_and_claim_timeout',async t=>{
 const h=await harness(t),row=await h.approve(await h.requestPC());
 await h.sql("UPDATE flora_org_memberships SET role='deployer',revision=revision+1 WHERE id=?",[h.approver.membershipId]);
 assert.equal((await h.claim(row)).status,403);
 assert.equal((await h.runtime.d1.prepare('SELECT count(*) n FROM automation_runners').first<any>()).n,0);
 await h.sql("UPDATE flora_org_memberships SET role='admin',revision=revision+1 WHERE id=?",[h.approver.membershipId]);h.approver.session=await h.login(h.approver);await h.reauth();
 const expiring=await h.approve(await h.requestPC());await h.control({now:h.now+600000});assert.equal((await h.claim(expiring)).status,403);assert.equal((await h.runtime.d1.prepare('SELECT count(*) n FROM automation_runners').first<any>()).n,0);
});
test('self_approval_requires_owner',async t=>{
 const h=await harness(t),own=await h.requestPC('ota',['android'],h.approver);
 assert.equal((await h.request(h.approver.session,'POST',h.base+'/'+own.id+'/approve',{expectedRevision:own.revision})).status,403);
 const response=await h.request(h.owner,'POST',h.base,{kind:'ota',name:'Owner PC',platforms:['ios']});assert.equal(response.status,201);const row=await response.json()as any;
 assert.equal((await h.request(h.owner,'POST',h.base+'/'+row.id+'/approve',{expectedRevision:row.revision})).status,403);
 assert.equal((await h.request(h.owner,'POST','/api/auth/reauth',{password:h.ownerPassword})).status,200);
 const approved=await h.request(h.owner,'POST',h.base+'/'+row.id+'/approve',{expectedRevision:row.revision});assert.equal(approved.status,200);
});
test('claim_response_loss_never_reissues',async t=>{
 const h=await harness(t),row=await h.approve(await h.requestPC());
 const first=await h.claim(row);assert.equal(first.status,201);const issued=await first.json()as any;assert.equal(typeof issued.token,'string');
 await h.control({action:'restart'});
 const repeat=await h.claim(row);assert.equal(repeat.status,409);assert.doesNotMatch(await repeat.text(),/tokenHash|Bearer|runner_.*\./);
 const list=await h.request(h.requester.session,'GET',h.base);assert.equal(list.status,200);const body=await list.json()as any;assert.equal(body.items[0].state,'claimed');assert.ok(!JSON.stringify(body).includes(issued.token));
 assert.equal((await h.runtime.d1.prepare('SELECT count(*) n FROM automation_runners').first<any>()).n,1);
 assert.equal((await h.service({kind:'ota',runnerId:issued.runner.id})).status,200);
 // Web logout is not personal-PC revocation.
 assert.equal((await h.request(h.requester.session,'POST','/api/auth/logout',{})).status,200);assert.equal((await h.service({kind:'ota',runnerId:issued.runner.id})).status,200);
});
test('native_access_and_credential_roll_back_together',async t=>{
 const h=await harness(t),row=await h.approve(await h.requestPC('native',['android']));
 await h.control({action:'runner-ready-failure',enabled:true});const failed=await h.claim(row);assert.equal(failed.status,503);
 assert.equal((await h.sql('SELECT count(*) n FROM flora_native_runners'))[0].n,0);assert.equal((await h.sql("SELECT count(*) n FROM flora_org_runner_access WHERE state='ready'"))[0].n,0);
 await h.control({action:'runner-ready-failure',enabled:false});
 const next=await h.approve(await h.requestPC('native',['android'])),issued=await h.claim(next);assert.equal(issued.status,201);const result=await issued.json()as any;
 assert.equal((await h.service({kind:'native',runnerId:result.runner.id},h.apps[0],'android')).status,200);assert.equal((await h.service({kind:'native',runnerId:result.runner.id},h.apps[0],'ios')).status,403);
 const original=await h.sql('SELECT data FROM flora_native_runners');assert.equal(original.length,1);assert.ok(!JSON.stringify(original).includes(result.token));
});
test('ota_unknown_is_not_ready',async t=>{
 const h=await harness(t),row=await h.approve(await h.requestPC());
 await h.control({action:'runner-ota-response-loss',enabled:true});const response=await h.claim(row);assert.equal(response.status,503);
 const [access]=await h.sql("SELECT * FROM flora_org_runner_access WHERE kind='ota'");assert.equal(access.state,'unknown');assert.equal((await h.service({kind:'ota',runnerId:access.runner_id})).status,403);
 assert.equal((await h.runtime.d1.prepare('SELECT count(*) n FROM automation_runners').first<any>()).n,1);
 assert.equal((await h.claim(row)).status,409);
});
test('one_personal_pc_revoke_preserves_other_pc',async t=>{
 const h=await harness(t),first=await h.approve(await h.requestPC()),second=await h.approve(await h.requestPC());
 const a=await h.claim(first),b=await h.claim(second);assert.equal(a.status,201);assert.equal(b.status,201);const issuedA=await a.json()as any,issuedB=await b.json()as any;
 const list=await(await h.request(h.requester.session,'GET',h.base)).json()as any;const selected=list.items.find((r:any)=>r.id===first.id);
 const revoked=await h.request(h.approver.session,'POST',h.base+'/'+first.id+'/revoke',{expectedRevision:selected.revision});assert.equal(revoked.status,200);
 assert.equal((await h.service({kind:'ota',runnerId:issuedA.runner.id})).status,403);assert.equal((await h.service({kind:'ota',runnerId:issuedB.runner.id})).status,200);
 const rows=await h.runtime.d1.prepare('SELECT id,version FROM automation_runners ORDER BY id,version').all<any>();assert.equal(rows.results.filter(r=>r.id===issuedA.runner.id).length,2);assert.equal(rows.results.filter(r=>r.id===issuedB.runner.id).length,1);
});
test('requester_revisions_owner_epoch_and_pause_never_revive_a_personal_pc',async t=>{
 const h=await harness(t),row=await h.approve(await h.requestPC());const issued=await h.claim(row);assert.equal(issued.status,201);const result=await issued.json()as any,ref={kind:'ota',runnerId:result.runner.id};
 assert.equal((await h.service(ref)).status,200);await h.sql('UPDATE flora_org_users SET auth_epoch=auth_epoch+1 WHERE id=?',[h.requester.userId]);assert.equal((await h.service(ref)).status,403);await h.sql('UPDATE flora_org_users SET auth_epoch=auth_epoch+1 WHERE id=?',[h.requester.userId]);assert.equal((await h.service(ref)).status,403);
 const extra=await h.account('deployer','another');const approved=await h.approve(await h.requestPC('ota',['ios'],extra)),created=await h.claim(approved,extra);assert.equal(created.status,201);const next={kind:'ota',runnerId:(await created.json()as any).runner.id};
 await h.sql("UPDATE flora_org_state SET mode='paused',org_access_epoch=org_access_epoch+1");assert.equal((await h.service(next)).status,403);await h.sql("UPDATE flora_org_state SET mode='active'");assert.equal((await h.service(next)).status,403);
});
test('Runner requests are bounded per-app and reject viewer writes or native platform merging',async t=>{
 const h=await harness(t),viewer=await h.account('viewer','viewer');assert.equal((await h.request(viewer.session,'POST',h.base,{kind:'ota',name:'PC',platforms:['ios']})).status,403);
 assert.equal((await h.request(h.requester.session,'POST',h.base,{kind:'native',name:'PC',platforms:['ios','android']})).status,400);
 const row=await h.requestPC();assert.equal((await h.request(viewer.session,'POST',h.base+'/'+row.id+'/approve',{unexpected:true})).status,403);assert.equal((await h.request(viewer.session,'POST',h.base+'/'+row.id+'/claim',{unexpected:true})).status,403);assert.equal((await h.request(h.requester.session,'GET','/api/apps/'+h.apps[1]+'/runner-requests')).status,404);
 const other=await h.account('deployer','other');const read=await h.request(other.session,'GET',h.base);assert.equal(read.status,200);assert.deepEqual((await read.json()as any).items,[]);
 assert.equal((await h.request(h.approver.session,'GET',h.base)).status,200);assert.equal((await h.request(h.requester.session,'POST',h.base+'/'+row.id+'/claim',{expectedRevision:row.revision})).status,409);
});

test('existing_Owner_OTA_enrollment_uses_positive_organization_access_after_activation',async t=>{
 const h=await harness(t),apps=[h.apps[1]!,h.apps[0]!];const response=await h.request(h.owner,'POST','/api/runners',{name:'Shared PC',appIds:apps});assert.equal(response.status,201);const result=await response.json()as any;assert.deepEqual(result.runner.appIds,apps);
 assert.equal((await h.service({kind:'ota',runnerId:result.runner.id})).status,200);const [row]=await h.sql('SELECT owner_mode FROM flora_org_runner_access WHERE runner_id=?',[result.runner.id]);assert.equal(row.owner_mode,'organization');
});
test('existing_Owner_native_enrollment_uses_positive_organization_access_after_activation',async t=>{
 const h=await harness(t),response=await h.request(h.owner,'POST','/api/apps/'+h.apps[0]+'/native/runners',{name:'Shared native PC',platform:'android'});assert.equal(response.status,201);const result=await response.json()as any;
 assert.equal((await h.service({kind:'native',runnerId:result.runner.id},h.apps[0],'android')).status,200);const [row]=await h.sql('SELECT owner_mode FROM flora_org_runner_access WHERE runner_id=?',[result.runner.id]);assert.equal(row.owner_mode,'organization');
});
test('same_PC_OTA_and_native_tokens_remain_separate_authorities',async t=>{
 const h=await harness(t),ota=await h.claim(await h.approve(await h.requestPC('ota',['ios']))),native=await h.claim(await h.approve(await h.requestPC('native',['android'])));assert.equal(ota.status,201);assert.equal(native.status,201);const a=await ota.json()as any,b=await native.json()as any;assert.notEqual(a.token,b.token);
 for(const [token,path]of [[a.token,'/api/native-runner/presence'],[b.token,'/api/runner/presence']]){const r=await h.runtime.fetch(orgOrigin+path,{method:'POST',headers:{Connection:'close','Content-Type':'application/json',Authorization:'Bearer '+token},body:'{}'});assert.ok([401,403].includes(r.status));await r.arrayBuffer();}
 assert.equal((await h.service({kind:'native',runnerId:a.runner.id})).status,403);assert.equal((await h.service({kind:'ota',runnerId:b.runner.id})).status,403);
});
test('real_Owner_recover_invalidates_personal_access_but_retains_organization_OTA_access',async t=>{
 const h=await harness(t),response=await h.claim(await h.approve(await h.requestPC()));assert.equal(response.status,201);const personal=await response.json()as any;
 const shared=await h.request(h.owner,'POST','/api/runners',{name:'Organization PC',appIds:[h.apps[0]]});assert.equal(shared.status,201);const organization=await shared.json()as any,token=randomBytes(32),next='synthetic-owner-recovered-password';
 await h.control({action:'restart',env:{FLORA_SETUP:{digest:createHash('sha256').update(token).digest('hex'),issuedAt:h.now,expiresAt:h.now+600000,generation:2,purpose:'recover'}}});
 const recovery=await h.request(null,'POST','/api/auth/recover',{email:'Owner@example.test',password:next,confirmation:next,token:token.toString('base64url')});assert.equal(recovery.status,200);await recovery.arrayBuffer();
 assert.equal((await h.service({kind:'ota',runnerId:personal.runner.id})).status,403);assert.equal((await h.service({kind:'ota',runnerId:organization.runner.id})).status,200);
 assert.equal((await h.request(h.owner,'GET','/api/auth/session')).status,401);
});

async function waitHeld(h:Awaited<ReturnType<typeof harness>>,action:string){for(let n=0;n<200;n++){const state=await(await h.control({action})).json()as any;if(state.held)return state;await new Promise(r=>setTimeout(r,5));}assert.fail('Expected held local boundary');}
test('wrong_app_native_revoke_cannot_mutate_another_app_organization_runner',async t=>{
 const h=await harness(t),created=await h.request(h.owner,'POST','/api/apps/'+h.apps[1]+'/native/runners',{name:'Other app PC',platform:'android'});assert.equal(created.status,201);const result=await created.json()as any;
 const rejected=await h.request(h.owner,'POST','/api/apps/'+h.apps[0]+'/native/runners/'+result.runner.id+'/revoke',{});assert.equal(rejected.status,404);
 assert.equal((await h.service({kind:'native',runnerId:result.runner.id},h.apps[1],'android')).status,200);
});
test('paused_during_final_native_delivery_never_returns_a_personal_token',async t=>{
 const h=await harness(t);assert.equal((await h.request(h.owner,'POST','/api/auth/reauth',{password:h.ownerPassword})).status,200);
 const created=await h.request(h.owner,'POST',h.base,{kind:'native',name:'Owner personal PC',platforms:['ios']});assert.equal(created.status,201);const row=await created.json()as any;
 const approved=await h.request(h.owner,'POST',h.base+'/'+row.id+'/approve',{expectedRevision:row.revision});assert.equal(approved.status,200);const request=await approved.json()as any;
 await h.control({action:'sync-hold',at:2});const pending=h.request(h.owner,'POST',h.base+'/'+row.id+'/claim',{expectedRevision:request.revision});await waitHeld(h,'sync-state');
 await h.sql("UPDATE flora_org_state SET mode='paused',org_access_epoch=org_access_epoch+1");await h.control({action:'sync-release'});const response=await pending;assert.equal(response.status,403);assert.equal('token'in(await response.json()as any),false);
 const [access]=await h.sql("SELECT * FROM flora_org_runner_access WHERE kind='native'");assert.equal((await h.service({kind:'native',runnerId:access.runner_id},h.apps[0],'ios')).status,403);await h.sql("UPDATE flora_org_state SET mode='active'");assert.equal((await h.service({kind:'native',runnerId:access.runner_id},h.apps[0],'ios')).status,403);
});
test('revoke_pending_claim_closes_its_original_audit_without_reviving_access',async t=>{
 const h=await harness(t),request=await h.approve(await h.requestPC());await h.control({action:'db-gate',kind:'batch-after'});
 const pending=h.claim(request);await waitHeld(h,'db-state');const [current]=await h.sql('SELECT * FROM flora_org_runner_requests WHERE id=?',[request.id]);
 const revoked=await h.request(h.approver.session,'POST',h.base+'/'+request.id+'/revoke',{expectedRevision:current.revision});assert.ok([200,503].includes(revoked.status));await revoked.arrayBuffer();
 await h.control({action:'db-release'});assert.equal((await pending).status,403);
 const [audit]=await h.sql('SELECT phase FROM flora_org_audit WHERE operation_id=? ORDER BY sequence DESC LIMIT 1',[current.operation_id]);assert.equal(audit.phase,'unknown');
 const [access]=await h.sql('SELECT state FROM flora_org_runner_access WHERE runner_id=?',[current.runner_id]);assert.equal(access.state,'revoked');assert.equal((await h.runtime.d1.prepare('SELECT count(*) n FROM automation_runners').first<any>()).n,0);
});
test('request_revisions_overflow_before_any_credential_is_issued',async t=>{
 const h=await harness(t),request=await h.approve(await h.requestPC('ota',['android']));
 for(const revision of [Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER-1,Number.MAX_SAFE_INTEGER-2]){
  await h.sql('UPDATE flora_org_runner_requests SET revision=? WHERE id=?',[revision,request.id]);const response=await h.claim({...request,revision});assert.equal(response.status,400);
  assert.equal((await h.runtime.d1.prepare('SELECT count(*) n FROM automation_runners').first<any>()).n,0);assert.equal((await h.sql('SELECT count(*) n FROM flora_org_runner_access'))[0].n,0);
 }
});
