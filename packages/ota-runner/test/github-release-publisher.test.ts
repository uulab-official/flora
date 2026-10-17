import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,chmod,rm,readFile,readdir,realpath,symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {automationDigest,parseAutomationJob,parseAutomationLease} from "@app-ops/dogfood";
import {createRunnerClient,readRunnerConfig} from "../dist/index.js";
import {createGitHubReleasePublisher} from "../dist/github-release-publisher.js";

async function fixture(t:import("node:test").TestContext){
 const root=await realpath(await mkdtemp(join(tmpdir(),"flora-gh-assets-")));t.after(()=>rm(root,{recursive:true,force:true}));await chmod(root,0o700);
 const ghPath=join(root,"gh"),cacheDirectory=join(root,"cache");await writeFile(ghPath,"#!/bin/sh\nexit 1\n",{mode:0o700});await mkdir(cacheDirectory,{mode:0o700});
 const storage={provider:"github-releases" as const,repository:"uulab-official/flora-ota-assets" as const,ghPath,cacheDirectory};
 const now=Date.now(),origin="https://flora.example.test",config={schemaVersion:1,bundler:"metro",entryFile:"index.js",toolchain:{nodeVersion:"24.19.0",packageManager:{name:"npm",version:"10.9.8"}},runtimeVersion:"native-1",platforms:["ios","android"],updatesUrl:origin+"/updates/app_test"};
 const connection={appId:"app_test",version:1,installationId:1,owner:"example",repository:"app",ref:"main",connectedAt:now};
 const detection={id:"github_001",appId:"app_test",connection,rootDirectory:".",detectedAt:now,commitSha:"a".repeat(40),framework:"flora",expoVersion:null,reactNativeVersion:null,configSource:"flora.config.json",runtimeVersion:config.runtimeVersion,platforms:config.platforms,updatesUrl:config.updatesUrl,updatesEnabled:true,reasons:[],automationConfig:config};
 const lease=parseAutomationLease({jobId:"automation_001",appId:"app_test",attemptId:"attempt_001",runnerId:"runner_fixture",credentialEpoch:1,fence:1,expiresAt:now+120000});
 const job=parseAutomationJob({requestKey:"queue_001",detectionId:detection.id,channel:"preview",runtimeVersion:config.runtimeVersion,platform:"android",config,id:lease.jobId,appId:lease.appId,detection,commitSha:detection.commitSha,rootDirectory:".",connection,configDigest:await automationDigest(config),toolchainDigest:await automationDigest(config.toolchain),createdAt:now,updatedAt:now,state:"leased",attemptCount:1,lease,code:null,deploymentId:null,receipt:null});
 const bytes=new Uint8Array([0,255,1]),upload={key:"bundle",contentType:"application/javascript",fileExtension:".js"},hash=createHash("sha256").update(bytes).digest(),asset={id:"asset_"+hash.toString("hex"),appId:lease.appId,digest:hash.toString("hex"),hash:hash.toString("base64url"),...upload,size:bytes.length,createdAt:now};
 return {root,storage,origin,job,lease,bytes,upload,asset};
}

test("private GitHub release config is opt-in, exact and never accepts token overrides",async t=>{
 const f=await fixture(t),file=join(f.root,"runner.json"),base={origin:f.origin,token:"runner_fixture."+"a".repeat(43),dockerImage:"sha256:"+"a".repeat(64)};
 await writeFile(file,JSON.stringify({...base,assetStorage:f.storage}),{mode:0o600});assert.deepEqual(await readRunnerConfig(file),{...base,assetStorage:f.storage});
 for(const overrides of [{token:"secret"},{repository:"other/repo"},{provider:"public"},{ghPath:"gh"},{cacheDirectory:"relative"}]){await writeFile(file,JSON.stringify({...base,assetStorage:{...f.storage,...overrides}}));await assert.rejects(readRunnerConfig(file),/INVALID_RUNNER_CONFIG/);}
 await chmod(f.storage.cacheDirectory,0o755);await writeFile(file,JSON.stringify({...base,assetStorage:f.storage}));await assert.rejects(readRunnerConfig(file),/INVALID_RUNNER_CONFIG/);
});

test("only exact 428 requests a host publication, then resubmits identical bytes and fenced reference",async t=>{
 const f=await fixture(t),original=new Uint8Array(f.bytes),requests:{body:Buffer;headers:Headers}[]=[],reference={schemaVersion:1 as const,releaseId:123,assetId:456};let publications=0;
 const client=createRunnerClient({origin:f.origin,token:"runner_fixture."+"a".repeat(43),assetPublisher:async input=>{publications++;assert.deepEqual(input.job,f.job);assert.deepEqual(input.lease,f.lease);assert.deepEqual(input.bytes,original);assert.equal(input.origin,f.origin);return reference;},fetch:async(url,options)=>{
  if(String(url).endsWith("/claim"))return Response.json({job:f.job,lease:f.lease});
  requests.push({body:Buffer.from(options!.body as Uint8Array),headers:new Headers(options!.headers)});
  if(requests.length===1)f.bytes.fill(7);
  return requests.length===1?Response.json({error:"ASSET_STORAGE_REFERENCE_REQUIRED"},{status:428}):Response.json(f.asset,{status:201});
 }});
 await client.claim();assert.deepEqual(await client.uploadAsset(f.lease,f.upload,f.bytes),f.asset);assert.equal(publications,1);assert.equal(requests.length,2);assert.deepEqual(requests[0]!.body,requests[1]!.body);assert.equal(requests[0]!.headers.get("X-Flora-Asset-Reference"),null);assert.deepEqual(JSON.parse(Buffer.from(requests[1]!.headers.get("X-Flora-Asset-Reference")!,"base64url").toString()),reference);
});

test("a publisher cannot add URLs selectors or malformed references to the control plane",async t=>{
 const f=await fixture(t);for(const reference of [{schemaVersion:2,releaseId:1,assetId:2},{schemaVersion:1,releaseId:0,assetId:2},{schemaVersion:1,releaseId:1,assetId:2,url:"https://attacker.test"},null]){let uploads=0;const c=createRunnerClient({origin:f.origin,token:"runner_fixture."+"a".repeat(43),assetPublisher:async()=>reference as never,fetch:async(url)=>{if(String(url).endsWith("/claim"))return Response.json({job:f.job,lease:f.lease});uploads++;return Response.json({error:"ASSET_STORAGE_REFERENCE_REQUIRED"},{status:428});}});await c.claim();await assert.rejects(c.uploadAsset(f.lease,f.upload,f.bytes));assert.equal(uploads,1,"malformed reference never reaches a second upload");}
});

test("legacy assets and authority failures never trigger GitHub writes; 428 needs bound claim and live lease",async t=>{
 const f=await fixture(t);for(const [status,code] of [[201,""],[403,"FORBIDDEN"],[409,"LEASE_STALE"],[428,"OTHER_REQUIRED"],[503,"ASSET_STORAGE_REFERENCE_REQUIRED"]] as const){let calls=0;const c=createRunnerClient({origin:f.origin,token:"runner_fixture."+"a".repeat(43),assetPublisher:async()=>{calls++;throw Error("unexpected");},fetch:async()=>Response.json(status===201?f.asset:{error:code},{status})});if(status===201)await c.uploadAsset(f.lease,f.upload,f.bytes);else await assert.rejects(c.uploadAsset(f.lease,f.upload,f.bytes));assert.equal(calls,0);}
 let published=0;const c=createRunnerClient({origin:f.origin,token:"runner_fixture."+"a".repeat(43),assetPublisher:async()=>{published++;return {schemaVersion:1,releaseId:1,assetId:2};},fetch:async()=>Response.json({error:"ASSET_STORAGE_REFERENCE_REQUIRED"},{status:428})});await assert.rejects(c.uploadAsset(f.lease,f.upload,f.bytes));assert.equal(published,0);
});

test("publisher creates draft, uploads once, publishes and readback-verifies immutable bytes and target asset repo HEAD",async t=>{
 const f=await fixture(t);let time=Date.now(),release:Record<string,unknown>|null=null,writes=0;const calls:{method:string;path:string;body?:unknown}[]=[],delays:number[]=[];
 const publisher=createGitHubReleasePublisher(f.storage,{now:()=>time,pause:async ms=>{delays.push(ms);time+=ms;},request:async input=>{calls.push(input);if(input.method!=="GET")writes++;
  if(input.path.endsWith("/releases?per_page=100"))return {status:200,body:release?[release]:[]};
  if(input.path.includes("/releases/tags/"))return release?{status:200,body:release}:{status:404,body:{}};
  if(input.path.endsWith("flora-ota-assets"))return {status:200,body:{private:true,full_name:f.storage.repository,default_branch:"main"}};
  if(input.path.endsWith("/commits/main"))return {status:200,body:{sha:"b".repeat(40)}};
  if(input.method==="POST"&&!input.file){const p=input.body as Record<string,unknown>;assert.equal(p.target_commitish,"b".repeat(40));assert.notEqual(p.target_commitish,f.job.commitSha);assert.equal(p.draft,true);assert.equal(p.make_latest,"false");release={id:10,...p,assets:[]};return {status:201,body:release};}
  if(input.file){assert.deepEqual(await readFile(input.file),Buffer.from(f.bytes));const asset={id:20,name:"flora-"+f.asset.digest+".bin",digest:"sha256:"+f.asset.digest,size:f.bytes.length,state:"uploaded",content_type:"application/octet-stream"};release!.assets=[asset];return {status:201,body:asset};}
  if(input.method==="PATCH"){release!.draft=false;return {status:200,body:release};}
  return {status:200,body:release};
 }});
 const input={origin:f.origin,job:f.job,lease:f.lease,upload:f.upload,bytes:f.bytes};assert.deepEqual(await publisher(input),{schemaVersion:1,releaseId:10,assetId:20});assert.equal(writes,3);assert.deepEqual(delays,[1050,1050]);
 assert.deepEqual(await publisher(input),{schemaVersion:1,releaseId:10,assetId:20});assert.equal(writes,3,"confirmed tag is reused without clobber");const parsed=JSON.parse(String(release!.body));assert.equal(parsed.appId,f.job.appId);assert.equal(parsed.attemptId,f.lease.attemptId);assert.equal(parsed.asset.hash,f.asset.hash);assert.equal((await readdir(f.storage.cacheDirectory)).length,1);assert.ok(calls.every(c=>!c.path.includes("delete")));
});

function provider(f:Awaited<ReturnType<typeof fixture>>,fault:"create"|"upload"|"publish"|"absent"|"digest"|"starter"|"none"="none",controller?:AbortController){
 let release:Record<string,unknown>|null=null,time=Date.now(),writes=0;
 const options={now:()=>time,pause:async(ms:number)=>{time+=ms;},...(controller?{signal:controller.signal}:{}),request:async(input:Parameters<NonNullable<NonNullable<Parameters<typeof createGitHubReleasePublisher>[1]>["request"]>>[0])=>{
  if(input.path.endsWith("/releases?per_page=100"))return {status:200,body:release?[release]:[]};
  if(input.path.includes("/releases/tags/"))return release&&!release.draft?{status:200,body:release}:{status:404,body:{}};
  if(input.path.endsWith("flora-ota-assets"))return {status:200,body:{private:true,full_name:f.storage.repository,default_branch:"main"}};
  if(input.path.endsWith("/commits/main"))return {status:200,body:{sha:"b".repeat(40)}};
  if(input.method!=="GET")writes++;
  if(input.method==="POST"&&!input.file){if(fault==="absent")throw Error("lost before confirmation");release={id:10,...input.body as object,assets:[]};if(fault==="create")throw Error("lost create response");return {status:201,body:release};}
  if(input.file){const asset={id:20,name:"flora-"+f.asset.digest+".bin",digest:"sha256:"+(fault==="digest"?"0".repeat(64):f.asset.digest),size:f.bytes.length,state:fault==="starter"?"starter":"uploaded",content_type:"application/octet-stream"};release!.assets=[asset];controller?.abort();if(fault==="upload")throw Error("lost upload response");return {status:fault==="starter"?502:201,body:asset};}
  if(input.method==="PATCH"){release!.draft=false;if(fault==="publish")throw Error("lost publish response");return {status:200,body:release};}
  return {status:200,body:release};
 }};
 return {options,writes:()=>writes};
}

test("lost create upload and publish responses reconcile exact resources without mutation replay",async t=>{
 for(const stage of ["create","upload","publish"] as const){const f=await fixture(t),p=provider(f,stage),input={origin:f.origin,job:f.job,lease:f.lease,upload:f.upload,bytes:f.bytes};assert.deepEqual(await createGitHubReleasePublisher(f.storage,p.options)(input),{schemaVersion:1,releaseId:10,assetId:20});assert.equal(p.writes(),3,stage);assert.deepEqual(await createGitHubReleasePublisher(f.storage,p.options)(input),{schemaVersion:1,releaseId:10,assetId:20});assert.equal(p.writes(),3,"a fresh controller uses the durable private journal");}
});

test("unconfirmed create remains fenced across restart, preserves bytes and never blindly creates again",async t=>{
 const f=await fixture(t),p=provider(f,"absent"),input={origin:f.origin,job:f.job,lease:f.lease,upload:f.upload,bytes:f.bytes};
 await assert.rejects(createGitHubReleasePublisher(f.storage,p.options)(input),/ASSET_STORAGE_UNAVAILABLE/);assert.equal(p.writes(),1);
 await assert.rejects(createGitHubReleasePublisher(f.storage,p.options)(input),/ASSET_STORAGE_UNAVAILABLE/);assert.equal(p.writes(),1);
 const dir=join(f.storage.cacheDirectory,(await readdir(f.storage.cacheDirectory))[0]!);assert.deepEqual(await readFile(join(dir,"asset.bin")),Buffer.from(f.bytes));assert.equal(JSON.parse(await readFile(join(dir,"state.json"),"utf8")).phase,"creating");
});

test("wrong digest and GitHub starter assets are preserved but never published or overwritten",async t=>{
 for(const fault of ["digest","starter"] as const){const f=await fixture(t),p=provider(f,fault),input={origin:f.origin,job:f.job,lease:f.lease,upload:f.upload,bytes:f.bytes};await assert.rejects(createGitHubReleasePublisher(f.storage,p.options)(input),/ASSET_STORAGE_CONFLICT/);assert.equal(p.writes(),2);await assert.rejects(createGitHubReleasePublisher(f.storage,p.options)(input),/ASSET_STORAGE_CONFLICT/);assert.equal(p.writes(),2);}
});

test("expired sibling attempt cancelled publisher and private-path substitutions never write remotely",async t=>{
 const f=await fixture(t),p=provider(f),input={origin:f.origin,job:f.job,lease:f.lease,upload:f.upload,bytes:f.bytes};
 await assert.rejects(createGitHubReleasePublisher(f.storage,p.options)({...input,lease:{...f.lease,attemptId:"attempt_other"}}),/ASSET_STORAGE_CONFLICT/);
 await assert.rejects(createGitHubReleasePublisher(f.storage,p.options)({...input,lease:{...f.lease,expiresAt:1}}),/LEASE_EXPIRED/);
 const stop=new AbortController();stop.abort();await assert.rejects(createGitHubReleasePublisher(f.storage,{...p.options,signal:stop.signal})(input),/LEASE_EXPIRED/);
 const alias=join(f.root,"cache-alias");await symlink(f.storage.cacheDirectory,alias);await assert.rejects(createGitHubReleasePublisher({...f.storage,cacheDirectory:alias},p.options)(input));assert.equal(p.writes(),0);
});

test("cancellation after a successful upload preserves its journal and prevents publication",async t=>{
 const f=await fixture(t),stop=new AbortController(),p=provider(f,"none",stop);await assert.rejects(createGitHubReleasePublisher(f.storage,p.options)({origin:f.origin,job:f.job,lease:f.lease,upload:f.upload,bytes:f.bytes}),/LEASE_EXPIRED/);assert.equal(p.writes(),2);
 const dir=join(f.storage.cacheDirectory,(await readdir(f.storage.cacheDirectory))[0]!);assert.equal(JSON.parse(await readFile(join(dir,"state.json"),"utf8")).phase,"uploading");assert.deepEqual(await readFile(join(dir,"asset.bin")),Buffer.from(f.bytes));
});

test("read-only Retry-After backpressure is bounded and long secondary limits never spin",async t=>{
 for(const [status,seconds,expected] of [[503,"0",3],[503,"3600",1],[429,"3600",1],[403,undefined,1]] as const){const f=await fixture(t);let calls=0;const publisher=createGitHubReleasePublisher(f.storage,{pause:async()=>{},request:async()=>{calls++;return {status,body:{},...(seconds?{retryAfter:seconds}:{})};}});await assert.rejects(publisher({origin:f.origin,job:f.job,lease:f.lease,upload:f.upload,bytes:f.bytes}),status===503?/ASSET_STORAGE_UNAVAILABLE/:/ASSET_STORAGE_RATE_LIMITED/);assert.equal(calls,expected);}
});

test("actual host gh subprocess errors expose fixed codes and never retain private stderr",async t=>{
 const f=await fixture(t);await writeFile(f.storage.ghPath,"#!/bin/sh\nprintf 'PRIVATE_GH_CREDENTIAL' >&2\nprintf 'HTTP/2.0 403 Forbidden\\nContent-Type: application/json\\n\\n{\"message\":\"PRIVATE_PROVIDER_TEXT\"}'\nexit 1\n");
 await assert.rejects(createGitHubReleasePublisher(f.storage)({origin:f.origin,job:f.job,lease:f.lease,upload:f.upload,bytes:f.bytes}),error=>error instanceof Error&&error.message==="ASSET_STORAGE_RATE_LIMITED");
});

test("mutation 403 and 429 persist cooldown and prohibit immediate readback or restart calls",async t=>{
 for(const stage of ["create","upload","publish"] as const)for(const status of [403,429]){
  const f=await fixture(t),p=provider(f),calls:{method:string;path:string}[]=[];let limited=false;
  const options={...p.options,request:async(input:Parameters<typeof p.options.request>[0])=>{calls.push({method:input.method,path:input.path});const matches=stage==="create"?input.method==="POST"&&!input.file:stage==="upload"?!!input.file:input.method==="PATCH";if(matches){limited=true;return {status,body:{},...(status===429?{retryAfter:"3600"}:{})};}assert.equal(limited,false,"no provider call follows explicit rate rejection");return p.options.request(input);}};
  const input={origin:f.origin,job:f.job,lease:f.lease,upload:f.upload,bytes:f.bytes};await assert.rejects(createGitHubReleasePublisher(f.storage,options)(input),/ASSET_STORAGE_RATE_LIMITED/);assert.equal(limited,true);
  const count=calls.length;await assert.rejects(createGitHubReleasePublisher(f.storage,options)(input),/ASSET_STORAGE_RATE_LIMITED/);assert.equal(calls.length,count,"fresh controller honors durable cooldown before any provider query");
  const cooldown=JSON.parse(await readFile(join(f.storage.cacheDirectory,"provider-cooldown.json"),"utf8"));assert.ok(cooldown.until>=Date.now()+(status===429?3590:50)*1000);const directory=(await readdir(f.storage.cacheDirectory)).find(name=>name.startsWith("flora-ota-v1-"))!;const state=JSON.parse(await readFile(join(f.storage.cacheDirectory,directory,"state.json"),"utf8"));assert.equal(state.cooldownUntil,cooldown.until);assert.deepEqual(await readFile(join(f.storage.cacheDirectory,directory,"asset.bin")),Buffer.from(f.bytes));
 }
});

test("host publisher abort drains the gh process group without passing environment tokens",async t=>{
 const f=await fixture(t),pidFile=join(f.root,"gh-pids.json"),stop=new AbortController();
 await writeFile(f.storage.ghPath,"#!"+process.execPath+"\nconst {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); require('node:fs').writeFileSync("+JSON.stringify(pidFile)+",JSON.stringify({pid:process.pid,child:child.pid,hasToken:!!(process.env.GH_TOKEN||process.env.GITHUB_TOKEN),hasHome:!!process.env.HOME}));setInterval(()=>{},1000);\n");
 const original=process.env.GH_TOKEN;process.env.GH_TOKEN="fixture-token-not-real";
 try{
  const pending=assert.rejects(createGitHubReleasePublisher(f.storage,{signal:stop.signal})({origin:f.origin,job:f.job,lease:f.lease,upload:f.upload,bytes:f.bytes}),/LEASE_EXPIRED/);
  let pids:{pid:number;child:number;hasToken:boolean;hasHome:boolean}|undefined;
  for(let i=0;i<200&&!pids;i++){try{pids=JSON.parse(await readFile(pidFile,"utf8"));}catch{await new Promise(resolve=>setTimeout(resolve,10));}}
  stop.abort();await pending;assert.ok(pids,"actual host subprocess started");assert.equal(pids.hasToken,false);assert.equal(pids.hasHome,true);
  for(const pid of [pids.pid,pids.child]){let alive=true;for(let i=0;i<100&&alive;i++){try{process.kill(pid,0);await new Promise(resolve=>setTimeout(resolve,10));}catch{alive=false;}}assert.equal(alive,false,"process group is fully stopped");}
 }finally{stop.abort();if(original===undefined)delete process.env.GH_TOKEN;else process.env.GH_TOKEN=original;}
});
