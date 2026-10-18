import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
const modulePath="../dist/setup/provision.js";
const plan={installationId:"install-1234",accountId:"a".repeat(32),workerName:"flora-qa-install-1234",databaseName:"flora-qa-install-1234",hostname:"qa.example.com",zoneId:"b".repeat(32),origin:"https://qa.example.com",ownerEmail:"owner@example.com",ownerId:"qa-owner",dbIdentity:"22222222-2222-4222-8222-222222222222"},dbId="11111111-1111-4111-8111-111111111111";
async function fixture(t:test.TestContext){
 const dir=await fs.mkdtemp(join(await fs.realpath(tmpdir()),"flora-provision-"));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=join(dir,"new-install","journal.json"),calls:string[]=[],messages:string[]=[],configs:Record<string,any>[]=[];let created=false,deployed=0,identity=false,failHTTPS=false;
 async function pending(action:string){const state=JSON.parse(await fs.readFile(file,"utf8"));assert.ok(state.receipts.some((r:{action:string;state:string})=>r.action===action&&r.state==="pending"),action+" needs durable intent first");calls.push(action);}
 const snapshot=()=>({accountId:plan.accountId,workerName:plan.workerName,databaseId:created?dbId:null,namespaceId:deployed?"d".repeat(32):null,deploymentId:deployed?"44444444-4444-4444-8444-444444444444":null,configFingerprint:deployed?String(deployed).repeat(64):null,routeFingerprint:"e".repeat(64)});
 const provider={inspect:async()=>snapshot(),createDatabase:async()=>{await pending("create-db");created=true;return {databaseId:dbId,databaseName:plan.databaseName};},migrate:async()=>{await pending("migrate");},readIdentity:async()=>identity?{ownerId:plan.ownerId,origin:plan.origin,dbIdentity:plan.dbIdentity}:null,insertIdentity:async()=>{await pending("identity");identity=true;},readOwnerState:async()=>({ownerId:plan.ownerId,ownerEmail:plan.ownerEmail,origin:plan.origin,dbIdentity:plan.dbIdentity,enrolled:false,epoch:0,setupGeneration:configs.at(-1)?.vars.FLORA_SETUP.generation??0,setupClosed:true,activeSessions:0}),deploy:async(_p:unknown,path:string)=>{const config=JSON.parse(await fs.readFile(path,"utf8")),generation=config.vars.FLORA_SETUP?.generation;await pending(!deployed?"initial-deploy":generation>1?`setup-renew-${generation}-deploy`:generation?"setup-deploy":"setup-remove");configs.push(config);deployed++;return snapshot();},probeHTTPS:async()=>{calls.push("https");if(failHTTPS)throw Error("synthetic-private-error");}};
 const confirmations=[true,false],io={choose:async()=>"new",readPublic:async()=>plan.origin,readSecret:async()=>assert.fail("password must not be read in CLI"),confirm:async()=>confirmations.shift()??false,notice:(s:string)=>messages.push(s),report:(r:unknown)=>messages.push(JSON.stringify(r))};
 return {dir,file,provider,io,calls,messages,configs,confirmations,failHTTPS:()=>{failHTTPS=true;}};
}
test("fresh_install_runs_once_with_durable_intents_and_exact_first_setup",async t=>{
 const f=await fixture(t),api=await import(modulePath);
 const result=await api.provisionNew(plan,f.file,f.provider,f.io,new AbortController().signal);assert.equal(result.state,"needs-operator");
 assert.deepEqual(f.calls,["create-db","migrate","identity","initial-deploy","https","setup-deploy"]);
 const journal=JSON.parse(await fs.readFile(f.file,"utf8"));assert.equal(journal.stage,"setup-deployed");
 const token=(await fs.readFile(join(f.dir,"new-install","approval-code.txt"),"utf8")).trim();
 assert.equal(Buffer.from(token,"base64url").length,32);assert.equal(journal.setup.digest,createHash("sha256").update(Buffer.from(token,"base64url")).digest("hex"));assert.equal(journal.setup.expiresAt-journal.setup.issuedAt,600000);assert.equal(journal.setup.generation,1);
 assert.ok(!f.messages.join("\n").includes(token));
 await assert.rejects(api.issueFirstSetup(f.file,journal.setup.expiresAt+1));assert.equal((await fs.readFile(join(f.dir,"new-install","approval-code.txt"),"utf8")).trim(),token);
 const before=f.calls.length;assert.equal((await api.provisionNew(plan,f.file,f.provider,f.io,new AbortController().signal)).state,"needs-operator");assert.equal(f.calls.length,before);
});
test("close_setup_preserves_other_fields_and_records_operator_confirmation",async t=>{
 const f=await fixture(t),api=await import(modulePath);await api.provisionNew(plan,f.file,f.provider,f.io,new AbortController().signal);
 f.confirmations.push(true);assert.equal((await api.resumeProvision(f.file,f.provider,f.io,new AbortController().signal)).state,"ready");
 const before=structuredClone(f.configs[1]!),after=f.configs[2]!;delete before.vars.FLORA_SETUP;assert.deepEqual(after,before);
 const journal=JSON.parse(await fs.readFile(f.file,"utf8"));assert.equal(journal.stage,"setup-removed");assert.ok(journal.receipts.some((r:{action:string})=>r.action==="operator-confirmed"));
});
test("cancel_free_scope_or_https_failure_never_issues_a_token",async t=>{
 const f=await fixture(t),api=await import(modulePath);f.confirmations.splice(0,2,false);
 assert.equal((await api.provisionNew(plan,f.file,f.provider,f.io,new AbortController().signal)).state,"cancelled");assert.equal(f.calls.length,0);await assert.rejects(fs.access(f.file));
 const g=await fixture(t);g.failHTTPS();await api.provisionNew(plan,g.file,g.provider,g.io,new AbortController().signal);
 await assert.rejects(fs.access(join(g.dir,"new-install","approval-code.txt")));assert.equal(JSON.parse(await fs.readFile(g.file,"utf8")).setup,null);
});
test("lost_mutation_reply_keeps_unknown_intent_and_resume_never_reposts",async t=>{
 const f=await fixture(t),api=await import(modulePath);let creates=0;
 const provider={...f.provider,createDatabase:async()=>{creates++;throw Error("synthetic-private-error");}};
 const result=await api.provisionNew(plan,f.file,provider,f.io,new AbortController().signal);assert.equal(result.state,"unknown");
 const before=await fs.readFile(f.file);
 assert.equal((await api.resumeProvision(f.file,provider,f.io,new AbortController().signal)).state,"unknown");assert.equal(creates,1);assert.deepEqual(await fs.readFile(f.file),before);assert.ok(!JSON.stringify(result).includes("synthetic-private-error"));
});
test("existing_install_never_bootstraps",async t=>{
 const f=await fixture(t),api=await import(modulePath),before=Buffer.from("retained private configuration");await fs.writeFile(join(f.dir,"existing-keys"),before,{mode:0o600});
 const result=await api.connectExisting(f.io,new AbortController().signal);assert.equal(result.state,"needs-operator");assert.equal(f.calls.length,0);assert.deepEqual(await fs.readFile(join(f.dir,"existing-keys")),before);assert.ok(f.messages.some(s=>s.includes("/login?returnTo=%2Fonboarding")));
});
test("dns_read_denial_keeps_installation_resumable_without_issuing_or_mutating",async t=>{
 const f=await fixture(t),api=await import(modulePath);
 const provider={...f.provider,inspect:async()=>{throw Error("SETUP_PROVIDER_DNS_READ_REQUIRED");}};
 const result=await api.provisionNew(plan,f.file,provider,f.io,new AbortController().signal);
 assert.deepEqual(result,{state:"needs-operator",code:"SETUP_PROVIDER_DNS_READ_REQUIRED"});
 assert.equal(f.calls.length,0);
 const journal=JSON.parse(await fs.readFile(f.file,"utf8"));assert.equal(journal.stage,"planned");assert.ok(journal.receipts.every((r:{state:string})=>r.state==="confirmed"));
 await assert.rejects(fs.access(join(f.dir,"new-install","approval-code.txt")));
 assert.ok(f.messages.some(s=>s.includes("DNS")&&s.includes(plan.hostname)));
 const before=await fs.readFile(f.file);await api.resumeProvision(f.file,provider,f.io,new AbortController().signal);assert.deepEqual(await fs.readFile(f.file),before);
});
test("dns_denial_after_durable_mutation_intent_remains_unknown_and_never_replays",async t=>{
 const f=await fixture(t),api=await import(modulePath);let creates=0;
 const provider={...f.provider,createDatabase:async()=>{creates++;throw Error("SETUP_PROVIDER_DNS_READ_REQUIRED");}};
 assert.deepEqual(await api.provisionNew(plan,f.file,provider,f.io,new AbortController().signal),{state:"unknown",code:"SETUP_OPERATION_UNCONFIRMED"});
 const before=await fs.readFile(f.file);assert.equal((await api.resumeProvision(f.file,provider,f.io,new AbortController().signal)).state,"unknown");assert.equal(creates,1);assert.deepEqual(await fs.readFile(f.file),before);
});
test("prompt_cancellation_without_signal_abort_returns_cancelled_and_preserves_planned_journal",async t=>{
 const f=await fixture(t),api=await import(modulePath),signal=new AbortController().signal;
 const result=await api.provisionNew(plan,f.file,{...f.provider,inspect:async()=>{throw Error("SETUP_CANCELLED");}},f.io,signal);
 assert.deepEqual(result,{state:"cancelled",code:"SETUP_CANCELLED"});assert.equal(signal.aborted,false);assert.equal(f.calls.length,0);assert.equal(JSON.parse(await fs.readFile(f.file,"utf8")).stage,"planned");
});
test("inspect_is_one_public_json_result_without_provider_or_token",async t=>{
 const f=await fixture(t),api=await import(modulePath);await api.provisionNew(plan,f.file,f.provider,f.io,new AbortController().signal);
 const before=await fs.readFile(f.file),token=(await fs.readFile(join(f.dir,"new-install","approval-code.txt"),"utf8")).trim(),reports:unknown[]=[];
 const commandPath="../dist/setup-command.js",{runSetupCommand}=await import(commandPath);
 assert.equal(await runSetupCommand(["inspect","--state",f.file,"--json"],{...f.io,notice:()=>assert.fail("inspect prints only JSON"),report:(r:unknown)=>reports.push(r)}),0);
 assert.equal(reports.length,1);const text=JSON.stringify(reports);assert.ok(!text.includes(token)&&!text.includes("digest")&&!text.includes(f.dir));assert.ok(text.includes("setup-deployed"));assert.deepEqual(await fs.readFile(f.file),before);
});
test("all_pending_issuance_states_and_source_drift_fail_without_reissue",async t=>{
 const api=await import(modulePath);
 for(const action of ["setup-issue","setup-deploy","setup-remove"]){
  const f=await fixture(t);await api.provisionNew(plan,f.file,f.provider,f.io,new AbortController().signal);
  const state=JSON.parse(await fs.readFile(f.file,"utf8"));state.receipts.find((r:{action:string})=>r.action===action)?.state;
  state.receipts.push({action:action+"-crash",state:"pending",resourceId:null,expectedFingerprint:null,observedFingerprint:null});
  await fs.writeFile(f.file,JSON.stringify(state),{mode:0o600});const before=await fs.readFile(f.file),code=await fs.readFile(join(f.dir,"new-install","approval-code.txt")),count=f.calls.length;
  assert.equal((await api.resumeProvision(f.file,f.provider,f.io,new AbortController().signal)).state,"unknown");assert.equal(f.calls.length,count);assert.deepEqual(await fs.readFile(f.file),before);assert.deepEqual(await fs.readFile(join(f.dir,"new-install","approval-code.txt")),code);
 }
 const f=await fixture(t);await api.provisionNew(plan,f.file,f.provider,f.io,new AbortController().signal);const state=JSON.parse(await fs.readFile(f.file,"utf8"));state.receipts.find((r:{action:string})=>r.action==="install-source").observedFingerprint="0".repeat(64);await fs.writeFile(f.file,JSON.stringify(state),{mode:0o600});const count=f.calls.length;
 assert.equal((await api.resumeProvision(f.file,f.provider,f.io,new AbortController().signal)).state,"needs-operator");assert.equal(f.calls.length,count);
});

test("explicit_renewal_preserves_old_code_history_and_uses_a_new_generation",async t=>{
 const f=await fixture(t),api=await import(modulePath);await api.provisionNew(plan,f.file,f.provider,f.io,new AbortController().signal);
 const old=JSON.parse(await fs.readFile(f.file,"utf8")),oldCode=await fs.readFile(join(f.dir,"new-install","approval-code.txt")),oldConfig=await fs.readFile(join(f.dir,"new-install","setup-config.json"));
 const result=await api.renewSetup(f.file,f.provider,f.io,new AbortController().signal,old.setup.expiresAt+1);
 assert.equal(result.state,"needs-operator");assert.equal(result.code,"SETUP_OWNER_CONFIRMATION_REQUIRED");
 const current=JSON.parse(await fs.readFile(f.file,"utf8")),token=(await fs.readFile(join(f.dir,"new-install","approval-code-g2.txt"),"utf8")).trim();
 assert.equal(current.stage,"setup-deployed");assert.equal(current.setup.generation,2);assert.equal(current.setup.purpose,"enroll");assert.equal(current.setup.expiresAt-current.setup.issuedAt,600000);
 assert.deepEqual(current.setupHistory,[old.setup]);assert.equal(current.setup.digest,createHash("sha256").update(Buffer.from(token,"base64url")).digest("hex"));
 assert.notEqual(token,oldCode.toString().trim());assert.deepEqual(await fs.readFile(join(f.dir,"new-install","approval-code.txt")),oldCode);assert.deepEqual(await fs.readFile(join(f.dir,"new-install","setup-config.json")),oldConfig);
 assert.deepEqual(current.receipts.slice(0,old.receipts.length),old.receipts);assert.ok(!f.messages.join("\n").includes(token));
 assert.equal((await api.renewSetup(f.file,f.provider,f.io,new AbortController().signal,current.setup.expiresAt+1)).state,"needs-operator");
 const third=JSON.parse(await fs.readFile(f.file,"utf8"));assert.equal(third.setup.generation,3);assert.deepEqual(third.setupHistory,[old.setup,current.setup]);assert.deepEqual(third.receipts.slice(0,current.receipts.length),current.receipts);
 assert.equal((await fs.readFile(join(f.dir,"new-install","approval-code-g2.txt"),"utf8")).trim(),token);
 f.confirmations.push(true);assert.equal((await api.resumeProvision(f.file,f.provider,f.io,new AbortController().signal)).state,"ready");
 assert.ok(!f.configs.at(-1)!.vars.FLORA_SETUP);assert.equal(JSON.parse(await fs.readFile(f.file,"utf8")).setupHistory.length,2);
});

test("renewal_rejects_live_windows_enrolled_owners_drift_or_identity_mismatch_without_new_files",async t=>{
 const f=await fixture(t),api=await import(modulePath);await api.provisionNew(plan,f.file,f.provider,f.io,new AbortController().signal);
 const before=await fs.readFile(f.file),j=JSON.parse(before.toString()),files=await fs.readdir(join(f.dir,"new-install"));
 assert.equal((await api.renewSetup(f.file,f.provider,f.io,new AbortController().signal,j.setup.issuedAt)).state,"needs-operator");
 const state=await f.provider.readOwnerState();
 const cases=[{...f.provider,readOwnerState:async()=>({...state,enrolled:true,epoch:1})},{...f.provider,readOwnerState:async()=>({...state,activeSessions:1})},{...f.provider,readOwnerState:async()=>({...state,ownerId:"different-owner"})},{...f.provider,readOwnerState:async()=>({...state,setupGeneration:2})},{...f.provider,inspect:async()=>({...await f.provider.inspect(),configFingerprint:"0".repeat(64)})},{...f.provider,readIdentity:async()=>({ownerId:"different-owner",origin:plan.origin,dbIdentity:plan.dbIdentity})}];
 for(const provider of cases){assert.equal((await api.renewSetup(f.file,provider,f.io,new AbortController().signal,j.setup.expiresAt+1)).state,"needs-operator");assert.deepEqual(await fs.readFile(f.file),before);assert.deepEqual(await fs.readdir(join(f.dir,"new-install")),files);}
 const cancelled=await api.renewSetup(f.file,{...f.provider,readOwnerState:async()=>{throw Error("SETUP_CANCELLED");}},f.io,new AbortController().signal,j.setup.expiresAt+1);assert.equal(cancelled.state,"cancelled");assert.equal(cancelled.code,"SETUP_CANCELLED");assert.deepEqual(await fs.readFile(f.file),before);
 const original=await fs.readFile(join(f.dir,"new-install","approval-code.txt"));await fs.writeFile(join(f.dir,"new-install","approval-code.txt"),"unverified-old-code\n");
 assert.equal((await api.renewSetup(f.file,f.provider,f.io,new AbortController().signal,j.setup.expiresAt+1)).state,"needs-operator");assert.deepEqual(await fs.readFile(f.file),before);await fs.writeFile(join(f.dir,"new-install","approval-code.txt"),original);
});

test("lost_renewal_deploy_reply_stays_unknown_and_never_reissues_or_reposts",async t=>{
 const f=await fixture(t),api=await import(modulePath);await api.provisionNew(plan,f.file,f.provider,f.io,new AbortController().signal);
 const old=JSON.parse(await fs.readFile(f.file,"utf8"));let posts=0;
 const provider={...f.provider,deploy:async()=>{posts++;throw Error("synthetic-private-failure");}};
 assert.equal((await api.renewSetup(f.file,provider,f.io,new AbortController().signal,old.setup.expiresAt+1)).state,"unknown");
 const before=await fs.readFile(f.file),code=await fs.readFile(join(f.dir,"new-install","approval-code-g2.txt"));
 assert.equal((await api.resumeProvision(f.file,provider,f.io,new AbortController().signal)).state,"unknown");
 assert.equal((await api.renewSetup(f.file,provider,f.io,new AbortController().signal,old.setup.expiresAt+600001)).state,"unknown");
 assert.equal(posts,1);assert.deepEqual(await fs.readFile(f.file),before);assert.deepEqual(await fs.readFile(join(f.dir,"new-install","approval-code-g2.txt")),code);
});

test("renewal_cancelled_during_read_only_preflight_never_mints_a_new_code",async t=>{
 const f=await fixture(t),api=await import(modulePath);await api.provisionNew(plan,f.file,f.provider,f.io,new AbortController().signal);
 const before=await fs.readFile(f.file),j=JSON.parse(before.toString()),files=await fs.readdir(join(f.dir,"new-install")),controller=new AbortController();
 const provider={...f.provider,readOwnerState:async()=>{const value=await f.provider.readOwnerState();controller.abort();return value;}};
 assert.equal((await api.renewSetup(f.file,provider,f.io,controller.signal,j.setup.expiresAt+1)).state,"cancelled");
 assert.deepEqual(await fs.readFile(f.file),before);assert.deepEqual(await fs.readdir(join(f.dir,"new-install")),files);
});
