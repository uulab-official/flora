import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {createRunnerClient,RunnerHttpFailure} from "../dist/index.js";

const origin="https://flora.example.test",token="runner_fixture."+"a".repeat(43);
function lease(){return {jobId:"job_one",appId:"app_one",attemptId:"attempt_one",runnerId:"runner_fixture",credentialEpoch:1,fence:3,expiresAt:Date.now()+60000};}
const transportFailure=(error:unknown)=>error instanceof RunnerHttpFailure&&error.status===0&&error.message==="RUNNER_TRANSPORT_UNAVAILABLE";
const invalidResponse=(error:unknown)=>error instanceof Error&&error.message==="RUNNER_RESPONSE_INVALID"&&!(error instanceof RunnerHttpFailure);

test("heartbeat recovers a real disconnected HTTP response with the same fenced request",async t=>{
 const original=lease(),renewed={...original,expiresAt:original.expiresAt+1000},seen:{body:unknown;authorization:string|undefined;origin:string|undefined}[]=[];
 const server=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);assert.equal(req.url,"/api/runner/heartbeat");seen.push({body:JSON.parse(Buffer.concat(chunks).toString()),authorization:req.headers.authorization,origin:req.headers.origin});if(seen.length===1){req.socket.destroy();return;}res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify(renewed));});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();}));
 const localOrigin="http://127.0.0.1:"+(server.address() as {port:number}).port,client=createRunnerClient({origin:localOrigin,token});
 assert.deepEqual(await client.heartbeat(original),renewed);assert.equal(seen.length,2);assert.deepEqual(seen[0],seen[1]);assert.deepEqual(seen[1],{body:{lease:original},authorization:"Bearer "+token,origin:localOrigin});
});

test("heartbeat retry payload, credential headers and deadline cannot observe caller mutation",async()=>{
 const input=lease(),original={...input},renewed={...original,expiresAt:original.expiresAt+1000},seen:{url:string;body:string;headers:[string,string][];signal:AbortSignal|null|undefined}[]=[];
 const options={origin,token,fetch:async(url:unknown,request?:RequestInit)=>{seen.push({url:String(url),body:String(request!.body),headers:[...new Headers(request!.headers)],signal:request!.signal});if(seen.length===1){input.fence=99;input.appId="app_other";input.expiresAt+=60000;options.origin="https://credential-sink.example.test";options.token="runner_other."+"b".repeat(43);if(request!.headers instanceof Headers)request!.headers.set("Authorization","changed");throw new TypeError("fetch failed");}return Response.json(renewed);}};
 const client=createRunnerClient(options);assert.deepEqual(await client.heartbeat(input),renewed);assert.equal(seen.length,2);assert.deepEqual(seen[0],seen[1]);assert.deepEqual(JSON.parse(seen[1]!.body),{lease:original});assert.equal(new Headers(seen[1]!.headers).get("Authorization"),"Bearer "+token);
});

test("heartbeat recovers a server outage without changing lease authority",async()=>{
 const original=lease(),renewed={...original,expiresAt:original.expiresAt+1000};let calls=0;
 const client=createRunnerClient({origin,token,fetch:async(_url,request)=>{calls++;assert.deepEqual(JSON.parse(String(request!.body)),{lease:original});return calls===1?Response.json({error:"DEPENDENCY_UNAVAILABLE"},{status:503}):Response.json(renewed);}});
 assert.deepEqual(await client.heartbeat(original),renewed);assert.equal(calls,2);
});

test("heartbeat retries transient outages and HTTP 500-599 at most twice",async()=>{
 for(const failure of ["transport",500,502,503,599] as const){let calls=0;const input=lease(),client=createRunnerClient({origin,token,fetch:async()=>{calls++;if(failure==="transport")throw new TypeError("fetch failed");return new Response("temporarily unavailable",{status:failure});}});
  await assert.rejects(client.heartbeat(input),error=>failure==="transport"?transportFailure(error):error instanceof RunnerHttpFailure&&error.status===failure);assert.equal(calls,3);
 }
});

test("heartbeat does not retry expired authority, authentication, conflicts or unknown responses",async()=>{
 for(const [status,code] of [[401,"UNAUTHORIZED"],[403,"RUNNER_REVOKED"],[409,"LEASE_STALE"],[409,"BUSY"],[429,"BUSY"],[500,"LEASE_STALE"],[503,"PERMISSION_DENIED"],[500,"UNAUTHENTICATED"],[500,"FORBIDDEN"],[500,"AUTH_REJECTED"],[500,"CONFIGURATION_REJECTED"]] as const){let calls=0;const client=createRunnerClient({origin,token,fetch:async()=>{calls++;return Response.json({error:code},{status,headers:{"Retry-After":"0"}});}});
  await assert.rejects(client.heartbeat(lease()),error=>error instanceof RunnerHttpFailure&&error.status===status&&error.message===code);assert.equal(calls,1);
 }
 for(const response of [()=>new Response("not json"),()=>new Response("x".repeat(1048577)),()=>new Response(null),()=>Response.json({}),()=>Response.json({...lease(),fence:99}),()=>Response.json({...lease(),runnerId:"runner_other"}),()=>Response.json({...lease(),expiresAt:1}),()=>new Response(new ReadableStream({start(controller){controller.error(new Error("body failed"));}})),()=>Response.error()]){let calls=0;const client=createRunnerClient({origin,token,fetch:async()=>{calls++;return response();}});await assert.rejects(client.heartbeat(lease()),invalidResponse);assert.equal(calls,1);}
});

test("heartbeat must start with a live lease bound to its own runner",async()=>{
 let calls=0;const client=createRunnerClient({origin,token,fetch:async()=>{calls++;return Response.json(lease());}});
 await assert.rejects(client.heartbeat({...lease(),expiresAt:Date.now()-1}),/LEASE_EXPIRED/);
 await assert.rejects(client.heartbeat({...lease(),runnerId:"runner_other"}),/RUNNER_RESPONSE_INVALID/);assert.equal(calls,0);
});

test("heartbeat retry stops at the original confirmed expiry even if the caller extends it",async t=>{
 const start=Date.now(),input={...lease(),expiresAt:start+1000};let clock=start,calls=0;t.mock.method(Date,"now",()=>clock);
 const client=createRunnerClient({origin,token,fetch:async()=>{calls++;input.expiresAt+=60000;clock=start+1000;throw new TypeError("fetch failed");}});
 await assert.rejects(client.heartbeat(input),transportFailure);assert.equal(calls,1);
});

test("heartbeat retries cannot reset their original twenty-second request deadline",async t=>{
 const start=Date.now(),input=lease();let clock=start,calls=0;t.mock.method(Date,"now",()=>clock);
 const client=createRunnerClient({origin,token,fetch:async()=>{calls++;clock=start+20000;throw new TypeError("fetch failed");}});
 await assert.rejects(client.heartbeat(input),transportFailure);assert.equal(calls,1);
});

test("heartbeat aborts an in-flight request at its original lease expiry",async()=>{
 let calls=0,signal:AbortSignal|null|undefined;const start=Date.now(),input={...lease(),expiresAt:start+100};
 const client=createRunnerClient({origin,token,fetch:async(_url,request)=>{calls++;signal=request!.signal;return await new Promise<Response>((resolve,reject)=>{const timer=setTimeout(()=>resolve(Response.json({...input,expiresAt:Date.now()+60000})),1000);const abort=()=>{clearTimeout(timer);reject(signal!.reason);};signal!.addEventListener("abort",abort,{once:true});if(signal!.aborted)abort();});}});
 await assert.rejects(client.heartbeat(input),transportFailure);assert.equal(calls,1);assert.equal(signal!.aborted,true);assert.ok(Date.now()-start<1000);
});

test("a heartbeat response that arrives after the original deadline is rejected",async t=>{
 const start=Date.now(),input={...lease(),expiresAt:start+1000};let clock=start,calls=0;t.mock.method(Date,"now",()=>clock);
 const client=createRunnerClient({origin,token,fetch:async()=>{calls++;clock=start+1000;return Response.json({...input,expiresAt:start+60000});}});
 await assert.rejects(client.heartbeat(input),/LEASE_EXPIRED/);assert.equal(calls,1);
});

test("claim and finalize never receive heartbeat transport or HTTP server-error retries",async()=>{
 for(const operation of ["claim","finalize"] as const)for(const failure of ["transport",500,503] as const){let calls=0;const client=createRunnerClient({origin,token,fetch:async()=>{calls++;if(failure==="transport")throw new TypeError("fetch failed");return Response.json({error:"UNAVAILABLE"},{status:failure});}});
  await assert.rejects(operation==="claim"?client.claim():client.finalize(lease(),{} as never),error=>failure==="transport"?transportFailure(error):error instanceof RunnerHttpFailure&&error.status===failure);assert.equal(calls,1);
 }
});

test("malformed successful claim or finalize responses are invalid rather than retryable transport errors",async()=>{
 for(const operation of ["claim","finalize"] as const){let calls=0;const client=createRunnerClient({origin,token,fetch:async()=>{calls++;return new Response("malformed JSON",{status:200});}});await assert.rejects(operation==="claim"?client.claim():client.finalize(lease(),{} as never),invalidResponse);assert.equal(calls,1);}
});
