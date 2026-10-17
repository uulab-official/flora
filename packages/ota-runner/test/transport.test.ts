import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {createHash} from "node:crypto";
import * as module from "../dist/index.js";
import {createRunnerClient} from "../dist/index.js";
const api=module as unknown as {createRunnerClient(options:{origin:string;token:string}):{uploadAsset(lease:unknown,metadata:unknown,bytes:Uint8Array):Promise<unknown>}};
test("presence transport sends only an empty authenticated request and validates exact same-runner timestamps",async()=>{
 const token="runner_fixture."+"a".repeat(43),now=Date.now();let calls=0;
 const client=createRunnerClient({origin:"https://flora.example.test",token,fetch:async(input,options)=>{calls++;assert.equal(String(input),"https://flora.example.test/api/runner/presence");assert.deepEqual(JSON.parse(String(options!.body)),{});assert.equal(new Headers(options!.headers).get("Authorization"),"Bearer "+token);return Response.json({runnerId:"runner_fixture",lastSeenAt:now});}});
 assert.deepEqual(await client.presence!(),{runnerId:"runner_fixture",lastSeenAt:now});assert.equal(calls,1);
 for(const response of [{runnerId:"runner_other",lastSeenAt:now},{runnerId:"runner_fixture",lastSeenAt:now,token},{runnerId:"runner_fixture",lastSeenAt:now+60000},{runnerId:"runner_fixture",lastSeenAt:0},{runnerId:"runner_fixture",lastSeenAt:"now"},null]){
  const wrong=createRunnerClient({origin:"https://flora.example.test",token,fetch:async()=>Response.json(response)});await assert.rejects(wrong.presence!(),/RUNNER_RESPONSE_INVALID/);
 }
});
test("machine transport sends bytes and a fenced lease only to the configured origin",async t=>{
 const token="runner_11111111-1111-4111-8111-111111111111."+"a".repeat(43),lease={jobId:"job_one",appId:"app_one",attemptId:"attempt_one",runnerId:"runner_one",credentialEpoch:1,fence:3,expiresAt:Date.now()+120000},bytes=new Uint8Array([0,255,1]),hash=createHash("sha256").update(bytes).digest();let observed=false;
 const server=createServer(async(req,res)=>{const parts:Buffer[]=[];for await(const part of req)parts.push(part);assert.deepEqual(Buffer.concat(parts),Buffer.from(bytes));assert.equal(req.headers.authorization,"Bearer "+token);assert.deepEqual(JSON.parse(Buffer.from(String(req.headers["x-flora-runner-lease"]),"base64url").toString()),lease);assert.match(req.url!,/^\/api\/runner\/assets\?/);observed=true;res.writeHead(201,{"Content-Type":"application/json"});res.end(JSON.stringify({id:"asset_"+hash.toString("hex"),appId:lease.appId,digest:hash.toString("hex"),hash:hash.toString("base64url"),key:"key-one",contentType:"application/javascript",fileExtension:".js",size:bytes.length,createdAt:Date.now()}));});await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));t.after(()=>new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();}));const address=server.address() as {port:number};const client=api.createRunnerClient({origin:"http://127.0.0.1:"+address.port,token});await client.uploadAsset(lease,{key:"key-one",contentType:"application/javascript",fileExtension:".js"},bytes);assert.equal(observed,true);
});
test("control-plane redirects cannot forward a machine credential to another server",async t=>{
 let received=0;const sink=createServer((_req,res)=>{received++;res.end("{}");});await new Promise<void>(r=>sink.listen(0,"127.0.0.1",r));const sinkOrigin="http://127.0.0.1:"+(sink.address() as {port:number}).port;
 const redirect=createServer((_req,res)=>{res.writeHead(307,{Location:sinkOrigin+"/credential-sink"});res.end();});await new Promise<void>(r=>redirect.listen(0,"127.0.0.1",r));for(const server of [sink,redirect])t.after(()=>new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();}));
 const client=createRunnerClient({origin:"http://127.0.0.1:"+(redirect.address() as {port:number}).port,token:"runner_fixture."+"a".repeat(43)});await assert.rejects(client.claim(),/RUNNER_TRANSPORT_UNAVAILABLE/);assert.equal(received,0);
});
test("authoritative authentication failures remain non-transient even with a malformed response body",async()=>{
 for(const body of ["denied","x".repeat(1048577)]){const client=createRunnerClient({origin:"https://flora.example.test",token:"runner_fixture."+"a".repeat(43),fetch:async()=>new Response(body,{status:403})});
 await assert.rejects(client.claim(),(error:unknown)=>error instanceof module.RunnerHttpFailure&&error.status===403);}
});
test("checkpoint transport validates runner binding and exact clear proof without forwarding source material",async()=>{
 const origin="https://flora.example.test",lease={jobId:"job_one",appId:"app_one",attemptId:"attempt_one",runnerId:"runner_fixture",credentialEpoch:1,fence:1,expiresAt:Date.now()+120000},receipt={jobId:lease.jobId,attemptId:lease.attemptId,commitSha:"a".repeat(40),configDigest:"b".repeat(64),toolchainDigest:"c".repeat(64),sourceArchiveDigest:"d".repeat(64),launchAssetId:"asset_"+"e".repeat(64),assetIds:[],artifactDigest:"f".repeat(64)},record={schemaVersion:1 as const,origin,lease,receipt};const observed:string[]=[];
 const client=createRunnerClient({origin,token:"runner_fixture."+"a".repeat(43),fetch:async(input,options)=>{const path=new URL(String(input)).pathname,body=JSON.parse(String(options!.body));observed.push(path);
  if(path.endsWith("checkpoint-save")){assert.deepEqual(body,record);return Response.json({saved:true});}
  if(path.endsWith("checkpoint-list")){assert.deepEqual(body,{});return Response.json({checkpoints:[record]});}
  assert.deepEqual(body,{jobId:lease.jobId,attemptId:lease.attemptId});const {automationDigest}=await import("@app-ops/dogfood");return Response.json({cleared:true,disposition:"committed",appId:lease.appId,jobId:lease.jobId,attemptId:lease.attemptId,receiptDigest:await automationDigest(record.receipt)});
 }});
 await client.saveCheckpoint!(record);assert.deepEqual(await client.listCheckpoints!(),[record]);assert.equal((await client.clearCheckpoint!(record)).disposition,"committed");assert.equal(observed.length,3);
 await assert.rejects(client.saveCheckpoint!({...record,lease:{...lease,runnerId:"runner_other"}}));assert.equal(observed.length,3);
 const wrong=createRunnerClient({origin,token:"runner_fixture."+"a".repeat(43),fetch:async()=>Response.json({cleared:true,disposition:"stale",appId:lease.appId,jobId:"job_other",attemptId:lease.attemptId,receiptDigest:"a".repeat(64)})});await assert.rejects(wrong.clearCheckpoint!(record),/RUNNER_RESPONSE_INVALID/);
});
test("platform-scoped transport sends only its target selector and rejects invalid selectors before HTTP",async()=>{
 const seen:unknown[]=[];for(const platform of [undefined,"ios","android"] as const){const client=createRunnerClient({origin:"https://flora.example.test",token:"runner_fixture."+"a".repeat(43),...(platform?{claimPlatform:platform}:{}),fetch:async(_input,options)=>{seen.push(JSON.parse(String(options!.body)));return new Response(null,{status:204});}});assert.equal(await client.claim(),null);}
 assert.deepEqual(seen,[{},{platform:"ios"},{platform:"android"}]);
 assert.throws(()=>createRunnerClient({origin:"https://flora.example.test",token:"runner_fixture."+"a".repeat(43),claimPlatform:"web" as never}),/INVALID_RUNNER_CONFIG/);
});
test("a claimed sibling platform is rejected before source or export access",async()=>{
 const {automationDigest}=await import("@app-ops/dogfood"),now=Date.now(),config={schemaVersion:1,bundler:"metro",entryFile:"index.js",toolchain:{nodeVersion:"24.19.0",packageManager:{name:"npm",version:"10.9.8"}},runtimeVersion:"native-1",platforms:["ios","android"],updatesUrl:"https://flora.example.test/updates/app_test"};
 const connection={appId:"app_test",version:1,installationId:1,owner:"example",repository:"app",ref:"main",connectedAt:now};
 const detection={id:"github_001",appId:"app_test",connection,rootDirectory:".",detectedAt:now,commitSha:"a".repeat(40),framework:"flora",expoVersion:null,reactNativeVersion:null,configSource:"flora.config.json",runtimeVersion:config.runtimeVersion,platforms:config.platforms,updatesUrl:config.updatesUrl,updatesEnabled:true,reasons:[],automationConfig:config};
 const lease={jobId:"automation_001",appId:"app_test",attemptId:"attempt_001",runnerId:"runner_fixture",credentialEpoch:1,fence:1,expiresAt:now+120000};
 const job={requestKey:"queue_001",detectionId:detection.id,channel:"preview",runtimeVersion:config.runtimeVersion,platform:"android",config,id:lease.jobId,appId:lease.appId,detection,commitSha:detection.commitSha,rootDirectory:".",connection,configDigest:await automationDigest(config),toolchainDigest:await automationDigest(config.toolchain),createdAt:now,updatedAt:now,state:"leased",attemptCount:1,lease,code:null,deploymentId:null,receipt:null};
 let requests=0;const request:typeof fetch=async(input,options)=>{requests++;assert.equal(new URL(String(input)).pathname,"/api/runner/claim");assert.deepEqual(JSON.parse(String(options!.body)),{platform:"ios"});return Response.json({job,lease});};
 const client=createRunnerClient({origin:"https://flora.example.test",token:"runner_fixture."+"a".repeat(43),claimPlatform:"ios",fetch:request});
 await assert.rejects(module.runOne({client,source:{async checkout(){throw new Error("source must not run");}},executor:{async execute(){throw new Error("export must not run");}}}),/RUNNER_RESPONSE_INVALID/);assert.equal(requests,1);
});
test("BUSY backpressure retries at most twice with identical binary bytes and fenced headers",async()=>{
 const lease={jobId:"job_one",appId:"app_one",attemptId:"attempt_one",runnerId:"runner_fixture",credentialEpoch:1,fence:3,expiresAt:Date.now()+120000},bytes=new Uint8Array([0,255,1]),original=Buffer.from(bytes),hash=createHash("sha256").update(bytes).digest(),calls:{body:Buffer;headers:Headers;signal:AbortSignal|null|undefined}[]=[];
 const client=createRunnerClient({origin:"https://flora.example.test",token:"runner_fixture."+"a".repeat(43),fetch:async(_input,options)=>{calls.push({body:Buffer.from(options!.body as Uint8Array),headers:new Headers(options!.headers),signal:options!.signal});if(calls.length===1)bytes.fill(8);if(calls.length<3)return Response.json({error:"BUSY"},{status:409,headers:{"Retry-After":"0"}});bytes.set(original);return Response.json({id:"asset_"+hash.toString("hex"),appId:lease.appId,digest:hash.toString("hex"),hash:hash.toString("base64url"),key:"key-one",contentType:"application/javascript",fileExtension:".js",size:bytes.length,createdAt:Date.now()});}});
 await client.uploadAsset(lease,{key:"key-one",contentType:"application/javascript",fileExtension:".js"},bytes);assert.equal(calls.length,3);for(const call of calls){assert.deepEqual(call.body,original);assert.deepEqual([...call.headers],[...calls[0]!.headers]);assert.equal(call.signal,calls[0]!.signal,"one deadline across all attempts");}
});
test("BUSY exhaustion propagates and authority conflicts are never retried",async()=>{
 for(const [status,code,count] of [[409,"BUSY",3],[409,"CONFIG_CONFLICT",1],[409,"LEASE_STALE",1],[403,"BUSY",1],[403,"RUNNER_REVOKED",1]] as const){let calls=0;const client=createRunnerClient({origin:"https://flora.example.test",token:"runner_fixture."+"a".repeat(43),fetch:async()=>{calls++;return Response.json({error:code},{status,headers:{"Retry-After":"0"}});}});await assert.rejects(client.claim(),error=>error instanceof module.RunnerHttpFailure&&error.status===status&&error.message===code);assert.equal(calls,count);}
});
test("BUSY without a valid Retry-After uses one-second bounded backpressure",async()=>{
 let calls=0;const start=Date.now(),client=createRunnerClient({origin:"https://flora.example.test",token:"runner_fixture."+"a".repeat(43),fetch:async()=>{calls++;return calls===1?Response.json({error:"BUSY"},{status:409,headers:{"Retry-After":"not-a-duration"}}):new Response(null,{status:204});}});
 assert.equal(await client.claim(),null);assert.equal(calls,2);assert.ok(Date.now()-start>=900);
});
