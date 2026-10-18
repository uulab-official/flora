import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
const path="../dist/setup/cloudflare.js";
const plan={installationId:"install-1234",accountId:"a".repeat(32),workerName:"flora-qa-install-1234",databaseName:"flora-qa-install-1234",hostname:"qa.example.com",zoneId:"b".repeat(32),origin:"https://qa.example.com",ownerEmail:"owner@example.com",ownerId:"qa-owner",dbIdentity:"22222222-2222-4222-8222-222222222222"};
const databaseId="11111111-1111-4111-8111-111111111111";
async function fixture(t:test.TestContext){
 const dir=await fs.mkdtemp(join(await fs.realpath(tmpdir()),"flora-provider-"));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const runtime={root:await fs.realpath(process.cwd()),nodePath:process.execPath,wranglerEntry:"/pinned/wrangler.js",dockerPath:"/pinned/docker",supervisorMain:"/pinned/supervisor.mjs"};
 const calls:{args:readonly string[];cwd:string}[]=[],requests:string[]=[];let databases:{uuid:string;name:string}[]=[],lost=false,wrongAccount=false,worker=false,drift=false,extraSetting=false,omitDomain=false;
 const deps={run:async(_exe:string,args:readonly string[],options:{cwd:string})=>{
  calls.push({args,cwd:options.cwd});
  if(args.includes("auth"))return{exitCode:0,stdout:JSON.stringify({type:"oauth",token:"synthetic-provider-secret"})};
  if(args.includes("create")){databases=[{uuid:databaseId,name:plan.databaseName}];if(lost)throw Error("synthetic-provider-secret");return{exitCode:0,stdout:await fs.readFile(new URL("./fixtures/setup-cloudflare/create.json.txt",import.meta.url),"utf8")};}
  if(args.includes("deploy")){if(args.includes("--dry-run")){if(drift)extraSetting=true;return{exitCode:0,stdout:"dry run"};}worker=true;return{exitCode:0,stdout:"Current Version ID: 33333333-3333-4333-8333-333333333333\n"};}
  return{exitCode:0,stdout:"[]"};
 },fetch:async(url:string,init:RequestInit)=>{
  const address=new URL(url);requests.push(address.pathname+address.search);assert.equal(address.origin,"https://api.cloudflare.com");assert.equal(init.method,"GET");assert.equal(init.redirect,"error");assert.equal(new Headers(init.headers).get("Authorization"),"Bearer synthetic-provider-secret");
  let result:unknown=null;let status=200;let success=true;let errors:unknown[]=[];
  if(address.pathname.endsWith("/accounts/"+plan.accountId))result={id:wrongAccount?"c".repeat(32):plan.accountId};
  else if(address.pathname.endsWith("/zones/"+plan.zoneId))result={id:plan.zoneId,name:"example.com",account:{id:plan.accountId},status:"active"};
  else if(address.pathname.endsWith("/d1/database"))result=databases;
  else if(address.pathname.endsWith("/workers/domains"))result=worker&&!omitDomain?[{id:"domain-id",hostname:plan.hostname,service:plan.workerName,zone_id:plan.zoneId,enabled:true}]:[];
  else if(address.pathname.endsWith("/workers/routes")||address.pathname.endsWith("/dns_records"))result=[];
  else if(address.pathname.endsWith("/deployments"))result={deployments:[{id:"44444444-4444-4444-8444-444444444444",versions:[{version_id:"33333333-3333-4333-8333-333333333333",percentage:100}]}]};
  else if(address.pathname.endsWith("/settings")){
   if(!worker){status=404;success=false;errors=[{code:10007,message:"synthetic-provider-secret"}];}
   else result={extraSetting,bindings:[{name:"FLORA_DB",type:"d1",id:databaseId},{name:"FLORA_AUTH",type:"durable_object_namespace",namespace_id:"d".repeat(32),class_name:"FloraAuth"},...Object.entries({FLORA_ORIGIN:plan.origin,FLORA_OWNER_ID:plan.ownerId,FLORA_OWNER_EMAIL:plan.ownerEmail,FLORA_DB_IDENTITY:plan.dbIdentity}).map(([name,text])=>({name,type:"plain_text",text}))]};
  }
  else assert.fail("unexpected API path "+address.pathname);
  return new Response(JSON.stringify({success,result,errors,result_info:{total_pages:1,total_count:Array.isArray(result)?result.length:1}}),{status,headers:{"Content-Type":"application/json"}});
 }};
 return {dir,runtime,deps,calls,requests,loseReply:()=>{lost=true;},wrongAccount:()=>{wrongAccount=true;},liveWorker:()=>{worker=true;},driftAfterDryRun:()=>{drift=true;},omitDomain:()=>{omitDomain=true;}};
}
test("create_is_new_only_and_requires_exact_account",async t=>{
 const f=await fixture(t),{createWranglerProvider}=await import(path),provider=createWranglerProvider(f.runtime,f.dir,f.deps);
 assert.deepEqual(await provider.createDatabase(plan,new AbortController().signal),{databaseId,databaseName:plan.databaseName});
 const create=f.calls.filter(c=>c.args.includes("create"));assert.equal(create.length,1);assert.ok(create[0]!.args.includes("--update-config=false"));assert.ok(!create[0]!.args.includes("--json"));assert.equal(create[0]!.cwd,f.dir);
 assert.ok(!JSON.stringify(f.calls).includes("synthetic-provider-secret"));
 await assert.rejects(provider.createDatabase(plan,new AbortController().signal));assert.equal(f.calls.filter(c=>c.args.includes("create")).length,1);
});
test("wrong_account_never_mutates_and_errors_do_not_expose_provider_secret",async t=>{
 const f=await fixture(t),{createWranglerProvider}=await import(path);f.wrongAccount();
 await assert.rejects(createWranglerProvider(f.runtime,f.dir,f.deps).createDatabase(plan,new AbortController().signal),e=>e instanceof Error&&!e.message.includes("synthetic-provider-secret"));
 assert.equal(f.calls.filter(c=>c.args.includes("create")).length,0);
});
test("lost_create_reply_never_adopts_name_or_reposts",async t=>{
 const f=await fixture(t),{createWranglerProvider}=await import(path),p=createWranglerProvider(f.runtime,f.dir,f.deps);f.loseReply();
 await assert.rejects(p.createDatabase(plan,new AbortController().signal),e=>e instanceof Error&&!e.message.includes("synthetic-provider-secret"));
 await assert.rejects(p.createDatabase(plan,new AbortController().signal));assert.equal(f.calls.filter(c=>c.args.includes("create")).length,1);
});
test("output_requires_one_uuid_and_name_in_complete_config",async()=>{
 const {parseCreatedDatabase}=await import(path),valid=await fs.readFile(new URL("./fixtures/setup-cloudflare/create.json.txt",import.meta.url),"utf8");
 assert.deepEqual(parseCreatedDatabase(valid,plan.databaseName),{databaseId,databaseName:plan.databaseName});
 for(const invalid of ["<html>403 synthetic-provider-secret</html>",valid.slice(0,-5),valid+valid,valid.replace(plan.databaseName,"another-name").replaceAll(plan.databaseName,"another-name"),valid.replace(databaseId,"invalid")])assert.throws(()=>parseCreatedDatabase(invalid,plan.databaseName),e=>e instanceof Error&&!e.message.includes("synthetic-provider-secret"));
});
test("provider_auth_and_response_shapes_fail_closed_without_writes",async t=>{
 const f=await fixture(t),{createWranglerProvider}=await import(path);
 for(const response of [()=>new Response("synthetic-provider-secret",{status:403}),()=>new Response("{",{status:200}),()=>new Response(JSON.stringify({success:true,result:{}}),{status:200})]){
  const p=createWranglerProvider(f.runtime,f.dir,{...f.deps,fetch:async()=>response()});
  await assert.rejects(p.inspect(plan,new AbortController().signal),e=>e instanceof Error&&!e.message.includes("synthetic-provider-secret"));
 }
 assert.equal(f.calls.filter(c=>c.args.includes("create")||c.args.includes("deploy")).length,0);
});

test("drift_stops_before_deploy_and_keeps_unrelated_settings",async t=>{
 const f=await fixture(t),api=await import(path),p=api.createWranglerProvider(f.runtime,f.dir,f.deps);
 await p.createDatabase(plan,new AbortController().signal);f.liveWorker();
 const expected=await p.inspect(plan,new AbortController().signal),configPath=join(f.dir,"worker.json");
 await fs.writeFile(configPath,JSON.stringify(api.createSetupConfig(plan,databaseId,f.runtime.root)),{mode:0o600});f.driftAfterDryRun();
 await assert.rejects(p.deploy(plan,configPath,expected,new AbortController().signal),/SETUP_PROVIDER_DRIFT/);
 assert.equal(f.calls.filter(c=>c.args.includes("deploy")&&!c.args.includes("--dry-run")).length,0);
});
test("deploy_readback_requires_the_expected_hostname_binding",async t=>{
 const f=await fixture(t),api=await import(path),p=api.createWranglerProvider(f.runtime,f.dir,f.deps);
 await p.createDatabase(plan,new AbortController().signal);const configPath=join(f.dir,"worker.json");
 await fs.writeFile(configPath,JSON.stringify(api.createSetupConfig(plan,databaseId,f.runtime.root)),{mode:0o600});f.omitDomain();
 await assert.rejects(p.deploy(plan,configPath,null,new AbortController().signal),/SETUP_PROVIDER_DEPLOY_UNKNOWN/);
});
test("pinned_wrangler_auth_capture_writes_no_token_log_in_an_isolated_home",async t=>{
 const dir=await fs.mkdtemp(join(await fs.realpath(tmpdir()),"flora-auth-log-"));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const authDir=join(dir,".wrangler","config");await fs.mkdir(authDir,{recursive:true,mode:0o700});
 const synthetic="synthetic-memory-only-token-1234567890",authFile=join(authDir,"default.toml");
 await fs.writeFile(authFile,`oauth_token = "${synthetic}"\nexpiration_time = "2099-01-01T00:00:00.000Z"\nscopes = []\n`,{mode:0o600});
 const runtimeModule="../dist/setup/runtime.js",{resolveSetupRuntime,runBoundedTool}=await import(runtimeModule);
 const runtime=await resolveSetupRuntime(process.cwd());
 const before=await fs.readFile(authFile),saved={HOME:process.env.HOME,XDG_CONFIG_HOME:process.env.XDG_CONFIG_HOME};
 try{
  process.env.HOME=dir;process.env.XDG_CONFIG_HOME=join(dir,"xdg");
  const result=await runBoundedTool(runtime.nodePath,[runtime.wranglerEntry,"auth","token","--json"],{cwd:dir,timeoutMs:20000,maxBytes:4096,signal:new AbortController().signal});
  assert.equal(JSON.parse(result.stdout).token,synthetic);
 }finally{
  for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;
 }
 assert.deepEqual(await fs.readFile(authFile),before);
 async function files(folder:string):Promise<string[]>{const entries=await fs.readdir(folder,{withFileTypes:true});return (await Promise.all(entries.map(async e=>e.isDirectory()?files(join(folder,e.name)):[join(folder,e.name)]))).flat();}
 const created=await files(dir);assert.ok(!created.some(p=>p.endsWith(".log")),"Wrangler must not persist its auth output");
 for(const file of created.filter(p=>p!==authFile))assert.ok(!(await fs.readFile(file,"utf8")).includes(synthetic));
});
test("dot_dot_named_child_is_still_inside_checkout",async t=>{
 const f=await fixture(t),api=await import(path),directory=join(f.dir,"..private");await fs.mkdir(directory,{mode:0o700});let tools=0;
 const provider=api.createWranglerProvider({...f.runtime,root:f.dir},directory,{run:async()=>{tools++;throw Error("must reject before credential capture");},fetch:async()=>assert.fail("no API")});
 await assert.rejects(provider.inspect(plan,new AbortController().signal));assert.equal(tools,0);
});
