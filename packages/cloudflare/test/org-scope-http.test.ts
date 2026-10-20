import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {createMemberAuthFixture,orgOrigin} from './org-fixtures.ts';
import {syntheticSourceBundle,syntheticBaseline} from '../../../tests/dogfood-fixtures.ts';

async function harness(t:TestContext,role:'admin'|'deployer'|'viewer'='viewer'){
 const h=await createMemberAuthFixture(t,{FLORA_VAULT_KEYS:JSON.stringify({active:'v1',keys:{v1:randomBytes(32).toString('base64url')}})});
 for(const name of ['0001_private_imports.sql','0002_multi_app.sql','0003_github_ota.sql','0004_automation.sql']){
  const sql=await readFile(new URL('../migrations/'+name,import.meta.url),'utf8');
  await h.runtime.d1.exec(sql.replace(/^--.*$/gm,'').split(/;\s*(?=CREATE|INSERT|DROP|PRAGMA|$)/).filter(s=>s.trim()).map(s=>s.replace(/\s*\n\s*/g,' ').trim()+';').join('\n'));
 }
 await h.runtime.d1.prepare('INSERT INTO flora_deployment(singleton,owner_id,origin,db_identity) VALUES(1,?,?,?)').bind('synthetic-owner',orgOrigin,'synthetic-db').run();
 const apps:string[]=[];
 for(const name of ['First','Second']){
  const r=await h.request(h.owner,'POST','/api/apps',{name,repositoryId:'github:synthetic/'+name.toLowerCase(),rootDirectory:'.'});assert.equal(r.status,201);apps.push((await r.json() as any).id);
 }
 const member=await h.member(role);
 await h.sql('DELETE FROM flora_org_app_access WHERE membership_id=?',[member.membershipId]);
 await h.sql('INSERT INTO flora_org_app_access VALUES(?,?,1)',[member.membershipId,apps[0]]);
 const session=await h.login(member);
 return {...h,createMember:h.member,apps,member,session};
}
test('all_management_routes_are_classified',async()=>{
 const {managementRequirement}=await import('../dist/org/route-policy.js');
 const app='application_qa',base='/api/apps/'+app;
 for(const [method,path,action,ownerOnly]of [
  ['GET','/api/projects','org.self',false],['GET','/api/apps','org.self',false],['POST','/api/apps','org.manage',true],
  ['GET',base+'/operations','app.read',false],['POST',base+'/settings','app.manage',false],
  ['POST',base+'/github','org.manage',true],['POST',base+'/github/sync','app.manage',false],
  ['POST',base+'/ota/assets','app.deploy',false],['POST',base+'/ota/deployments','app.deploy',false],['POST',base+'/ota/rollbacks','app.deploy',false],
  ['GET',base+'/credentials','credential.read',false],['POST',base+'/credentials','credential.manage',false],['POST',base+'/credentials/disable','credential.manage',false],
  ['POST',base+'/signing-key','credential.manage',false],['GET',base+'/native','app.read',false],['POST',base+'/native/jobs','app.deploy',false],
  ['POST',base+'/native/runners','runner.organization',true],['POST',base+'/native/runners/runner_qa/revoke','runner.organization',true],['POST',base+'/native/jobs/job_qa/cancel','app.deploy',false],
  ['GET',base+'/automation','app.read',false],['GET',base+'/automation/jobs/job_qa','app.read',false],['POST',base+'/automation/jobs','app.deploy',false],['POST',base+'/automation/jobs/job_qa/cancel','app.deploy',false],
  ['POST',base+'/automation/policy','app.manage',false],['GET',base+'/automation/ci','app.read',false],['POST',base+'/automation/ci','app.manage',false],
  ['GET',base+'/ota/rollback-policy','app.read',false],['POST',base+'/ota/rollback-policy','app.manage',false],['POST',base+'/ota/rollback-installations','app.manage',false],
  ['POST',base+'/ota/verification','app.deploy',false],['POST','/api/runners','runner.organization',true],['POST','/api/runners/runner_qa/revoke','runner.organization',true],
  ['GET','/api/github/repositories','org.manage',true],['POST',base+'/future-dangerous-route','org.manage',true],
 ]as const){const r=managementRequirement(method,path);assert.equal(r.action,action,path);assert.equal(r.ownerOnly,ownerOnly,path);if(path.startsWith(base)&&!ownerOnly)assert.equal(r.appId,app,path);}
});
test('RF1_two_installations_same_app_id_are_isolated',async t=>{
 const h=await harness(t);
 const r=await h.request(h.session,'GET','/api/projects');assert.equal(r.status,200);const result=await r.json() as any;assert.deepEqual(result.projects.map((p:any)=>p.id),[h.apps[0]]);assert.equal('usage'in result,false);
 const list=await h.request(h.session,'GET','/api/apps');assert.equal(list.status,200);assert.deepEqual((await list.json() as any[]).map(a=>a.id),[h.apps[0]]);
 const state=await h.request(h.session,'GET','/api/state');assert.equal(state.status,200);const value=await state.json() as any;assert.deepEqual(value.applications.map((a:any)=>a.id),[h.apps[0]]);
 for(const suffix of ['/operations','/credentials','/native','/automation','/ota/rollback-policy','/automation/ci']){
  assert.equal((await h.request(h.session,'GET','/api/apps/'+h.apps[1]+suffix)).status,404,suffix);
  assert.equal((await h.request(h.session,'GET','/api/apps/application_absent'+suffix)).status,404,suffix);
 }
 // Local fault injection simulates binding this DO to another deployment's D1.
 await h.runtime.d1.exec('DROP TRIGGER deployment_update;');
 await h.runtime.d1.prepare("UPDATE flora_deployment SET db_identity='different-installation'").run();
 const drift=await h.request(h.session,'GET','/api/projects');assert.equal(drift.status,503);assert.ok(!(await drift.text()).includes('Second'));
});
test('viewer_cannot_import_or_rollback',async t=>{
 const h=await harness(t),base='/api/apps/'+h.apps[0];
 for(const path of [base+'/ota/rollbacks',base+'/ota/deployments',base+'/native/jobs',base+'/automation/jobs','/api/sources?appId='+h.apps[0],'/api/baselines?snapshotId=snapshot_qa&appId='+h.apps[0],'/api/head?appId='+h.apps[0]])assert.equal((await h.request(h.session,'POST',path,{})).status,403,path);
 for(const path of ['/api/sources','/api/head'])assert.equal((await h.request(h.session,'POST',path,{})).status,403,path);
});
test('deployer_cannot_change_policy',async t=>{
 const h=await harness(t,'deployer'),base='/api/apps/'+h.apps[0];
 for(const suffix of ['/settings','/automation/policy','/ota/rollback-policy','/ota/rollback-installations','/automation/ci','/credentials','/signing-key'])assert.equal((await h.request(h.session,'POST',base+suffix,{})).status,403,suffix);
 const allowed=await h.request(h.session,'POST',base+'/settings',{expectedVersion:0,values:{}});assert.equal(allowed.status,403);
});
test('credential_metadata_is_role_scoped',async t=>{
 const h=await harness(t,'viewer'),path='/api/apps/'+h.apps[0]+'/credentials';
 const candidate={kind:'android_keystore',label:'Private key label',expectedVersion:0,metadata:{appIdentifier:'private.example.app'},payload:{fileBase64:Buffer.from('synthetic-private-keystore').toString('base64'),password:'private-key-password',keyAlias:'private-alias'}};
 assert.equal((await h.request(h.owner,'POST',path,candidate)).status,201);
 const read=await h.request(h.session,'GET',path);assert.equal(read.status,200);const view=await read.json() as any;assert.equal(view.credentials.length,1);assert.equal(view.credentials[0].kind,'android_keystore');assert.equal(view.credentials[0].configured,true);assert.doesNotMatch(JSON.stringify(view),/Private key label|private.example|private-alias|private-key-password|fingerprint|metadata|history|version/i);
 const native=await h.request(h.session,'GET','/api/apps/'+h.apps[0]+'/native');assert.equal(native.status,200);assert.equal('credentialUses'in(await native.json()as any),false);
 const full=await h.request(h.owner,'GET',path);assert.equal((await full.json()as any).history.length,1);
});
test('github_search_is_owner_only',async t=>{
 const h=await harness(t,'admin');
 for(const path of ['/api/github/repositories?installationId=42','/api/github/installations','/api/github/connection'])assert.equal((await h.request(h.session,'GET',path)).status,403,path);
 assert.equal((await h.request(h.session,'POST','/api/apps/'+h.apps[0]+'/github',{})).status,403);
 assert.equal((await h.request(h.session,'POST','/api/runners',{})).status,403);
});
test('RF2_completed_settings_write_is_audited_and_new_requests_use_current_role',async t=>{
 const h=await harness(t,'admin'),path='/api/apps/'+h.apps[0]+'/settings';
 const done=await h.request(h.session,'POST',path,{expectedVersion:0,values:{PUBLIC_ENV:'qa'}});assert.equal(done.status,200);
 const events=await h.sql("SELECT phase,data FROM flora_org_audit WHERE json_extract(data,'$.actor.id')=? OR operation_id IN(SELECT operation_id FROM flora_org_audit WHERE json_extract(data,'$.actor.id')=?)",[h.member.userId,h.member.userId]);
 assert.ok(events.some(e=>e.phase==='pending'));assert.ok(events.some(e=>e.phase==='completed'));
 await h.sql("UPDATE flora_org_memberships SET role='viewer',revision=revision+1 WHERE id=?",[h.member.membershipId]);
 assert.equal((await h.request(h.session,'POST',path,{expectedVersion:1,values:{PUBLIC_ENV:'wrong'}})).status,403);
 const row=await h.runtime.d1.prepare('SELECT count(*) n FROM application_settings WHERE app_id=?').bind(h.apps[0]).first<{n:number}>();assert.equal(row?.n,2);
});

async function waitForDB(h:Awaited<ReturnType<typeof harness>>){
 for(let n=0;n<200;n++){const state=await(await h.control({action:'db-state'})).json()as any;if(state.held)return state;await new Promise(r=>setTimeout(r,5));}assert.fail('Database operation was not held');
}
test('RF2_scoped_cursor_and_after_submit_revoke',async t=>{
 const h=await harness(t,'admin'),path='/api/apps/'+h.apps[0]+'/settings';
 await h.control({action:'db-gate',kind:'read'});
 const rejected=h.request(h.session,'POST',path,{expectedVersion:0,values:{PUBLIC_ENV:'blocked'}});
 assert.equal((await waitForDB(h)).batches,0);
 await h.sql('UPDATE flora_org_memberships SET revision=revision+1 WHERE id=?',[h.member.membershipId]);
 await h.control({action:'db-release'});assert.equal((await rejected).status,403);
 assert.equal((await(await h.control({action:'db-state'})).json()as any).batches,0);
 const current=await h.login(h.member);
 await h.control({action:'db-gate',kind:'batch-after'});
 const committed=h.request(current,'POST',path,{expectedVersion:0,values:{PUBLIC_ENV:'committed'}});
 assert.equal((await waitForDB(h)).batches,1);
 await h.sql('UPDATE flora_org_memberships SET revision=revision+1 WHERE id=?',[h.member.membershipId]);
 await h.control({action:'db-release'});assert.equal((await committed).status,403);
 assert.equal((await(await h.control({action:'db-state'})).json()as any).batches,1);
 const rows=await h.runtime.d1.prepare('SELECT version FROM application_settings WHERE app_id=? ORDER BY version').bind(h.apps[0]).all<{version:number}>();assert.deepEqual(rows.results.map(r=>r.version),[0,1]);
 const events=await h.sql("SELECT phase FROM flora_org_audit WHERE operation_id IN(SELECT operation_id FROM flora_org_audit WHERE json_extract(data,'$.actor.id')=? AND json_extract(data,'$.action')='app.manage') ORDER BY sequence",[h.member.userId]);assert.deepEqual(events.map(e=>e.phase),['pending','completed']);
});
test('member_app_cursor_is_bound_to_actor_revision_and_endpoint_without_page_filling',async t=>{
 const h=await harness(t);
 // The first page deliberately contains grants to removed apps: no owner-wide refill.
 await h.sql('DELETE FROM flora_org_app_access WHERE membership_id=?',[h.member.membershipId]);
 for(let n=0;n<26;n++)await h.sql('INSERT INTO flora_org_app_access VALUES(?,?,1)',[h.member.membershipId,'app_removed_'+String(n).padStart(2,'0')]);
 const first=await h.request(h.session,'GET','/api/projects');assert.equal(first.status,200);const page=await first.json()as any;assert.deepEqual(page.projects,[]);assert.equal(typeof page.nextCursor,'string');
 assert.equal((await h.request(h.session,'GET','/api/apps?appCursor='+encodeURIComponent(page.nextCursor))).status,403);
 const second=await h.request(h.session,'GET','/api/projects?appCursor='+encodeURIComponent(page.nextCursor));assert.equal(second.status,200);assert.equal((await second.json()as any).nextCursor,null);
 await h.sql('UPDATE flora_org_memberships SET revision=revision+1 WHERE id=?',[h.member.membershipId]);const changed=await h.login(h.member);
 assert.equal((await h.request(changed,'GET','/api/projects?appCursor='+encodeURIComponent(page.nextCursor))).status,403);
});
test('local_key_mutation_and_org_audit_share_one_transaction',async t=>{
 const h=await harness(t,'admin'),path='/api/apps/'+h.apps[0]+'/credentials';
 const candidate={kind:'android_keystore',label:'QA',expectedVersion:0,metadata:{appIdentifier:'test.example.app'},payload:{fileBase64:Buffer.from('synthetic-keystore').toString('base64'),password:'synthetic-password',keyAlias:'qa'}};
 assert.equal((await h.request(h.session,'POST',path,candidate)).status,201);
 const first=await h.sql("SELECT data FROM flora_org_audit WHERE phase='completed' AND json_extract(data,'$.action')='credential.manage'");assert.equal(first.length,1);assert.equal(JSON.parse(first[0].data).actor.id,h.member.userId);assert.equal(JSON.parse(first[0].data).refs.credentialVersion,'1');
 await h.control({action:'restart',env:{FLORA_ORG_AUDIT_BYTES:'1'}});
 const rejected=await h.request(h.session,'POST',path,{...candidate,expectedVersion:1});assert.equal(rejected.status,409);
 const versions=await h.sql('SELECT version FROM flora_credential_versions WHERE app_id=?',[h.apps[0]]);assert.deepEqual(versions.map(r=>r.version),[1]);
});
test('signing_and_rollback_policy_changes_are_atomic_org_audit_events',async t=>{
 const h=await harness(t,'admin'),base='/api/apps/'+h.apps[0];
 assert.equal((await h.request(h.session,'POST',base+'/signing-key',{})).status,201);
 const input={expectedVersion:0,enabled:false,failureRatePercent:100,minInstallations:2,windowMinutes:10,channel:'qa',targets:{ios:null,android:null}};
 assert.equal((await h.request(h.session,'POST',base+'/ota/rollback-policy',input)).status,200);
 const events=await h.sql("SELECT data FROM flora_org_audit WHERE phase='completed' AND json_extract(data,'$.actor.id')=? AND json_extract(data,'$.action') IN ('credential.manage','app.manage')",[h.member.userId]);assert.equal(events.length,2);
 await h.control({action:'restart',env:{FLORA_ORG_AUDIT_BYTES:'1'}});
 assert.equal((await h.request(h.session,'POST',base+'/ota/rollback-policy',{...input,expectedVersion:1})).status,409);
 const [{data}]=await h.sql('SELECT data FROM flora_auto_rollback_policies WHERE app_id=?',[h.apps[0]]);assert.equal(JSON.parse(data).version,1);
});

test('member_inventory_baseline_and_log_reads_never_cross_app_or_actor_scope',async t=>{
 const h=await harness(t,'admin');
 const bundle=(repository:string,n=0)=>({...syntheticSourceBundle(),repository:{id:'github:synthetic/'+repository,fullName:'synthetic/'+repository,visibility:'private'},rootDirectory:'.',commitSha:n.toString(16).padStart(40,'a')});
 const ids:string[]=[],logs:string[]=[];
 for(let n=0;n<2;n++){
  const r=await h.request(h.owner,'POST','/api/sources?appId='+h.apps[n],bundle(n?'second':'first'));assert.equal(r.status,201);const source=await r.json()as any;ids.push(source.id);
  const baseline=await h.request(h.owner,'POST','/api/baselines?appId='+h.apps[n]+'&snapshotId='+source.id,syntheticBaseline(source));assert.equal(baseline.status,201);logs.push((await baseline.json()as any).id);
 }
 const permitted=await h.request(h.session,'GET','/api/state');assert.equal(permitted.status,200);const page=await permitted.json()as any;assert.deepEqual(page.snapshots.items.map((s:any)=>s.id),[ids[0]]);assert.equal(page.history.items[0].id,logs[0]);
 assert.equal((await h.request(h.session,'GET','/api/baselines/'+logs[0]+'/log')).status,200);
 assert.equal((await h.request(h.session,'GET','/api/baselines/'+logs[1]+'/log')).status,404);
 assert.equal((await h.request(h.session,'GET','/api/state?snapshotId='+ids[1])).status,404);
 const imported=await h.request(h.session,'POST','/api/sources?appId='+h.apps[0],bundle('first',1));assert.equal(imported.status,201);
 assert.equal((await h.request(h.session,'POST','/api/sources?appId='+h.apps[0],bundle('second',1))).status,404);
 for(let n=2;n<22;n++)assert.equal((await h.request(h.session,'POST','/api/sources?appId='+h.apps[0],bundle('first',n))).status,201);
 const first=await h.request(h.session,'GET','/api/state?appId='+h.apps[0]);assert.equal(first.status,200);const cursor=(await first.json()as any).snapshots.nextCursor;assert.equal(typeof cursor,'string');
 const same=await h.request(h.session,'GET','/api/state?appId='+h.apps[0]+'&snapshotCursor='+cursor);assert.equal(same.status,200);
 const other=await h.createMember('viewer','other');await h.sql('DELETE FROM flora_org_app_access WHERE membership_id=?',[other.membershipId]);await h.sql('INSERT INTO flora_org_app_access VALUES(?,?,1)',[other.membershipId,h.apps[0]]);const second=await h.login(other);
 assert.equal((await h.request(second,'GET','/api/state?appId='+h.apps[0]+'&snapshotCursor='+cursor)).status,400);
 const registry=await h.runtime.d1.prepare('SELECT count(*) n FROM applications').first<{n:number}>();assert.equal(registry?.n,2);
});

test('member_management_admission_uses_at_most_four_local_point_lookups_and_zero_D1',async t=>{
 const h=await harness(t);
 const r=await h.control({action:'capture-management-grant',path:'/api/apps/'+h.apps[0]+'/operations',headers:{Cookie:h.session.cookie}});assert.equal(r.status,200);const counts=await r.json()as any;assert.ok(counts.pointQueries<=4,JSON.stringify(counts));assert.equal(counts.d1Reads,0);
});
