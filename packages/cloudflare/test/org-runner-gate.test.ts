import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import type {D1Database} from '@cloudflare/workers-types';
import {canonicalJson} from '@app-ops/config';
import {automationDigest,createAutomationService} from '@app-ops/dogfood';
import {createD1ImportStore} from '../dist/d1-import-store.js';
import {createTestRuntime} from './runtime.ts';
const config={ownerId:'owner-gate',ownerEmail:'owner@example.test',origin:'https://gate.example.test',dbIdentity:'gate-db',setup:null};
async function migrate(db:D1Database,name:string){const sql=await readFile(new URL('../migrations/'+name,import.meta.url),'utf8');await db.exec(sql.replace(/^--.*$/gm,'').split(/;\s*(?=CREATE|INSERT|DROP|PRAGMA|$)/).filter(s=>s.trim()).map(s=>s.replace(/\s*\n\s*/g,' ').trim()+';').join('\n'));}
async function harness(t:TestContext){
 const runtime=await createTestRuntime({entrypoint:new URL('./fixtures/runtime-entry.ts',import.meta.url)});t.after(()=>runtime.dispose());const db=runtime.d1 as unknown as D1Database;
 for(const name of ['0001_private_imports.sql','0002_multi_app.sql','0003_github_ota.sql','0004_automation.sql'])await migrate(db,name);
 await db.prepare('INSERT INTO flora_deployment VALUES(1,?,?,?)').bind(config.ownerId,config.origin,config.dbIdentity).run();
 const store=createD1ImportStore(db,config,()=>{}),apps:import('@app-ops/dogfood').ManagedApplication[]=[];
 for(const name of ['one','two'])apps.push(await store.applications!.registerApplication({name,repositoryId:name,rootDirectory:'.'},Date.now()));
 const runner=(id:string,appIds=[apps[0]!.id])=>({id,name:'Synthetic PC',appIds,createdAt:Date.now(),credentialEpoch:1,revokedAt:null,tokenHash:'a'.repeat(64)});
 const statement=(id:string,appIds=[apps[0]!.id],changed:Record<string,unknown>={})=>{const values=[config.ownerId,id,1,canonicalJson({...runner(id,appIds),...changed})];return db.prepare('INSERT INTO automation_runners(owner_id,id,version,data,stored_bytes) VALUES(?,?,?,?,?)').bind(...values,Buffer.byteLength(canonicalJson(values)));};
 const before=async()=>({runners:(await db.prepare('SELECT * FROM automation_runners ORDER BY id,version').all()).results,capacity:await db.prepare('SELECT * FROM flora_capacity').first()});
 const initialize=async()=>{await migrate(db,'0014_org_runner_access.sql');const {RunnerGate}=await import('../dist/org/runner-gate.js');return new RunnerGate(db,config.ownerId);};
 return {runtime,db,store,apps,runner,statement,before,initialize};
}
test('RF5_late_old_enrollment_cannot_cross_barrier',async t=>{
 const h=await harness(t);await h.statement('runner_existing').run();const before=await h.before();
 const originalTriggers=(await h.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all()).results;
 const gate=await h.initialize();assert.deepEqual(await h.before(),before);assert.deepEqual((await h.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name NOT LIKE 'flora_org_%' ORDER BY name").all()).results,originalTriggers);
 // Prepared before block, submitted only after the actual committed barrier.
 const heldBeforeBlock=h.statement('runner_late_blocked'),heldBeforeSeal=h.statement('runner_late_sealed');
 assert.deepEqual(await gate.block(1,'operation_cutover'),{ownerId:config.ownerId,generation:1,phase:'blocked',protocol:1});
 await assert.rejects(heldBeforeBlock.run(),/org runner/);
 await gate.seal(1);await assert.rejects(heldBeforeSeal.run(),/org runner/);
 assert.deepEqual(await h.before(),before);
 await assert.rejects(gate.block(2,'operation_unseal'));
 assert.equal((await gate.read()).phase,'ledger_only');
});
test('reservation_consumption_rolls_back_on_capacity_failure',async t=>{
 const h=await harness(t),gate=await h.initialize();await gate.block(1,'operation_cutover');await gate.seal(1);
 await gate.reserve({runnerId:'runner_reserved',operationId:'operation_issue',appIds:[h.apps[0]!.id],generation:1});
 // A later statement's actual SQLite trigger failure must undo the first insert
 // and its reservation consumption; no mocked successful/failed D1 receipts.
 await h.db.exec("CREATE TABLE fixture_capacity(value INTEGER);\nCREATE TRIGGER fixture_capacity_failure BEFORE INSERT ON fixture_capacity BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;");
 const before=await h.before();await assert.rejects(h.db.batch([h.statement('runner_reserved'),h.db.prepare('INSERT INTO fixture_capacity VALUES(1)')]),/flora capacity exceeded/);
 assert.equal((await h.db.prepare('SELECT consumed_at FROM flora_org_runner_reservations WHERE runner_id=?').bind('runner_reserved').first<any>()).consumed_at,null);assert.deepEqual(await h.before(),before);
 await h.statement('runner_reserved').run();assert.equal(typeof(await h.db.prepare('SELECT consumed_at FROM flora_org_runner_reservations WHERE runner_id=?').bind('runner_reserved').first<any>()).consumed_at,'number');
});
test('reservation_scope_generation_and_reuse_rejected',async t=>{
 const h=await harness(t),gate=await h.initialize();await gate.block(1,'operation_cutover');await gate.seal(1);
 await assert.rejects(gate.reserve({runnerId:'runner_wrong_gen',operationId:'operation_wrong_gen',appIds:[h.apps[0]!.id],generation:2}));
 await assert.rejects(gate.reserve({runnerId:'runner_wrong_app',operationId:'operation_wrong_app',appIds:['application_other_installation'],generation:1}));
 await gate.reserve({runnerId:'runner_reserved',operationId:'operation_issue',appIds:h.apps.map(a=>a.id),generation:1});
 await assert.rejects(h.statement('runner_reserved',[h.apps[0]!.id]).run(),/org runner/);
 await assert.rejects(h.statement('runner_reserved',h.apps.map(a=>a.id),{id:'runner_different_payload'}).run(),/org runner|automation conflict/);
 await h.statement('runner_reserved',[h.apps[1]!.id,h.apps[0]!.id]).run(); // scope is a set, not presentation order
 await assert.rejects(gate.reserve({runnerId:'runner_reserved',operationId:'operation_issue',appIds:h.apps.map(a=>a.id),generation:1}));
 await assert.rejects(h.statement('runner_other_id',h.apps.map(a=>a.id)).run(),/org runner/);
 await assert.rejects(h.statement('runner_reserved',h.apps.map(a=>a.id)).run());
 const {RunnerGate}=await import('../dist/org/runner-gate.js');await assert.rejects(new RunnerGate(h.db,'another-owner').block(1,'operation_other_owner'));
 assert.equal((await h.db.prepare('SELECT count(*) n FROM automation_runners').first<any>()).n,1);
});
test('existing_revoke_and_leases_are_unchanged',async t=>{
 const h=await harness(t),app=h.apps[0]!,ops=h.store.operations!,auto=h.store.automation!,now=Date.now();
 const connection=await ops.saveGitHubConnection(app.id,{expectedVersion:0,installationId:1,owner:'fixture',repository:'one',ref:'main'},now);
 const recipe={schemaVersion:1 as const,bundler:'expo' as const,entryFile:'index.js',toolchain:{nodeVersion:'24.19.0',packageManager:{name:'pnpm' as const,version:'11.19.0'}},runtimeVersion:'1',platforms:['ios' as const,'android' as const],updatesUrl:config.origin+'/updates/'+app.id};
 const detection=await ops.saveGitHubDetection({id:'github_fixture',appId:app.id,connection,rootDirectory:'.',detectedAt:now,commitSha:'a'.repeat(40),framework:'expo',expoVersion:'55.0.0',reactNativeVersion:'0.82.0',configSource:'app.json',runtimeVersion:'1',platforms:['ios','android'],updatesEnabled:true,updatesUrl:recipe.updatesUrl,reasons:[],automationConfig:recipe});
 const runner={...h.runner('runner_existing'),createdAt:now};await auto.registerRunner(runner);const authority={runnerId:runner.id,credentialEpoch:1,tokenHash:runner.tokenHash};
 await auto.enqueueAutomationJob({id:'job_existing',appId:app.id,requestKey:'request_existing',detectionId:detection.id,channel:'qa',runtimeVersion:'1',platform:'ios',config:recipe,detection,commitSha:detection.commitSha,rootDirectory:'.',connection,configDigest:await automationDigest(recipe),toolchainDigest:await automationDigest(recipe.toolchain),createdAt:now,updatedAt:now,state:'queued',attemptCount:0,lease:null,code:null,deploymentId:null,receipt:null});
 const claimed=await auto.claimAutomationJob(authority,now,60_000);assert.ok(claimed);
 const history=()=>h.db.prepare('SELECT * FROM automation_transitions ORDER BY app_id,job_id,version').all();const before=(await history()).results;
 const gate=await h.initialize();await gate.block(1,'operation_cutover');assert.deepEqual((await history()).results,before);await auto.requireAutomationLease(authority,claimed.lease,now+1);
 await gate.seal(1);await auto.heartbeatAutomationJob(authority,claimed.lease,now+2,60_000);
 const revoked=await auto.revokeRunner(runner.id,now+3);assert.equal(revoked.credentialEpoch,2);await assert.rejects(auto.requireAutomationLease(authority,claimed.lease,now+4));
 assert.deepEqual((await history()).results.slice(0,before.length),before);
});
test('expired_cleanup_is_bounded',async t=>{
 const h=await harness(t),gate=await h.initialize();await gate.block(1,'operation_cutover');await gate.seal(1);
 // Expired, never-consumed reservations are the only cleanup candidates.
 for(let n=0;n<75;n++)await h.db.prepare('INSERT INTO flora_org_runner_reservations(owner_id,runner_id,operation_id,app_ids,generation,expires_at,consumed_at) VALUES(?,?,?,?,?,?,NULL)').bind(config.ownerId,'runner_expired_'+n,'operation_expired_'+n,JSON.stringify([h.apps[0]!.id]),1,1).run();
 await gate.reserve({runnerId:'runner_live',operationId:'operation_live',appIds:[h.apps[0]!.id],generation:1});
 assert.equal((await h.db.prepare('SELECT count(*) n FROM flora_org_runner_reservations WHERE expires_at=1').first<any>()).n,25);
 assert.equal((await h.db.prepare('SELECT count(*) n FROM flora_org_runner_reservations WHERE runner_id=?').bind('runner_live').first<any>()).n,1);
});
test('missing_or_replaced_guard_never_creates_a_barrier_or_reservation',async t=>{
 const h=await harness(t),gate=await h.initialize();
 await h.db.exec('DROP TRIGGER flora_org_runner_first_insert;');
 await assert.rejects(gate.block(1,'operation_cutover'));assert.equal((await h.db.prepare('SELECT count(*) n FROM flora_org_runner_gate').first<any>()).n,0);
 await h.db.exec('CREATE TRIGGER flora_org_runner_first_insert BEFORE INSERT ON automation_runners BEGIN SELECT 1; END;');await assert.rejects(gate.block(1,'operation_cutover'));
});
test('server_allocation_uses_the_reserved_id_but_HTTP_input_stays_closed',async t=>{
 const h=await harness(t),gate=await h.initialize();await gate.block(1,'operation_cutover');await gate.seal(1);
 await gate.reserve({runnerId:'runner_server_allocated',operationId:'operation_issue',appIds:[h.apps[0]!.id],generation:1});
 const service=createAutomationService({applications:h.store.applications!,operations:h.store.operations!,automation:h.store.automation!},{publicOrigin:config.origin});
 const result=await service.enrollRunner({name:'PC',appIds:[h.apps[0]!.id]},{runnerId:'runner_server_allocated'});assert.equal(result.runner.id,'runner_server_allocated');assert.ok(result.token.startsWith('runner_server_allocated.'));
 await assert.rejects(service.enrollRunner({name:'PC',appIds:[h.apps[0]!.id],runnerId:'runner_client_chosen'}as any));
 assert.equal((await h.db.prepare('SELECT count(*) n FROM automation_runners').first<any>()).n,1);
});

test('lost_barrier_response_is_unavailable_until_committed_receipt_readback',async t=>{
 const h=await harness(t);await h.initialize();const {RunnerGate}=await import('../dist/org/runner-gate.js');let calls=0;
 const db=new Proxy(h.db,{get(target,key){if(key==='batch')return async(...args:any[])=>{const result=await (target.batch as any)(...args);if(++calls===2)throw new Error('synthetic-sensitive-transport-details');return result;};const value=(target as any)[key];return typeof value==='function'?value.bind(target):value;}});
 const uncertain=new RunnerGate(db,config.ownerId);
 await assert.rejects(uncertain.block(1,'operation_cutover'),(error:any)=>error.status===503&&error.code==='RUNNER_GATE_UNAVAILABLE'&&!error.message.includes('sensitive'));
 const receipt=await new RunnerGate(h.db,config.ownerId).block(1,'operation_cutover');assert.equal(receipt.phase,'blocked');assert.equal((await h.db.prepare('SELECT count(*) n FROM flora_org_runner_gate').first<any>()).n,1);
});
