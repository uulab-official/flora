import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createNativeClient } from "../dist/native-client.js";
import type { NativeClient, NativeLease, NativeArtifact } from "../dist/native-client.js";

const settings = { origin: "https://native.invalid", token: "native_runner_test." + "a".repeat(43), appId: "app_test", platform: "android" as const };
const lease = (): NativeLease => ({ jobId:"native_job_test", appId:"app_test", platform:"android", runnerId:"native_runner_test", attemptId:"attempt_test", credentialEpoch:1, fence:1, expiresAt:Date.now()+120000 });
const artifact: NativeArtifact = {fileName:"app.apk",sha256:"a".repeat(64),byteLength:1,appIdentifier:"test.app",platform:"android",signerFingerprint:"b".repeat(64)};
const actions: Record<string, (client:NativeClient, signal?:AbortSignal)=>Promise<unknown>> = {
  pending: (c,s)=>c.pending(s), presence: (c,s)=>c.presence(s), claim: (c,s)=>c.claim("native_job_test",s),
  heartbeat: (c,s)=>c.heartbeat(lease(),s), credentials: (c,s)=>c.credentials(lease(),s),
  complete: (c,s)=>c.complete(lease(),artifact,s), fail: (c,s)=>c.fail(lease(),"NATIVE_BUILD_FAILED",s),
};
const errorCode = (error:unknown) => error instanceof Error ? error.message : "NON_ERROR";
for (const [name, action] of Object.entries(actions)) {
  test(`session lifetime stops ${name} before any request even without a method signal`, async()=>{
    const scope = new AbortController(); scope.abort("PRIVATE_STOP_REASON"); let calls=0;
    const options = {...settings, signal:scope.signal, fetch:async()=>{calls++;return Response.json({});}};
    await assert.rejects(action(createNativeClient(options)), /^Error: NATIVE_CANCELLED$/);
    assert.equal(calls,0);
  });
}
for (const which of ["session", "method"] as const) {
  test(`${which} abort wins when both cancellation scopes are supplied`, async()=>{
    const scope=new AbortController(), local=new AbortController(); let settle!:(r:Response)=>void, observed:AbortSignal|null|undefined;
    const options={...settings, signal:scope.signal, fetch:async(_url:unknown, init?:RequestInit)=>{observed=init?.signal;return new Promise<Response>(resolve=>{settle=resolve;});}};
    const result=createNativeClient(options).presence(local.signal).then(()=>"SUCCESS",errorCode);
    (which==="session"?scope:local).abort("PRIVATE_STOP_REASON");
    const value=await Promise.race([result,delay(100).then(()=>"HUNG")]);
    settle(Response.json({runnerId:"native_runner_test",lastSeenAt:Date.now()}));
    await result;
    assert.equal(value,"NATIVE_CANCELLED");assert.equal(observed?.aborted,true);
    assert.equal((which==="session"?local:scope).signal.aborted,false,"cancellation does not mutate caller scopes");
  });
}
test("a client captures its original lifetime rather than a subsequently replaced options.signal", async()=>{
  const first=new AbortController(), second=new AbortController(); let calls=0;
  const options={...settings,signal:first.signal,fetch:async()=>{calls++;return Response.json({runnerId:"native_runner_test",lastSeenAt:Date.now()});}};
  const client=createNativeClient(options);options.signal=second.signal;first.abort();
  await assert.rejects(client.presence(),/NATIVE_CANCELLED/);assert.equal(calls,0);
});
test("separate client lifetimes never cancel each other and omitted lifetime retains compatibility",async()=>{
  const a=new AbortController(), b=new AbortController();let calls=0;
  const transport=async()=>{calls++;return Response.json({runnerId:"native_runner_test",lastSeenAt:Date.now()});};
  const first=createNativeClient({...settings,fetch:transport,signal:a.signal} as Parameters<typeof createNativeClient>[0]);
  const second=createNativeClient({...settings,fetch:transport,signal:b.signal} as Parameters<typeof createNativeClient>[0]);
  a.abort();await assert.rejects(first.presence(),/NATIVE_CANCELLED/);await second.presence();await createNativeClient({...settings,fetch:transport}).presence();assert.equal(calls,2);
});
for(const [name,action] of Object.entries(actions)){
  test(`real HTTP session stop interrupts held ${name} exactly once`,async t=>{
    let arrived!:()=>void;const arrival=new Promise<void>(resolve=>{arrived=resolve;});let calls=0;
    const server=createServer((request,_response)=>{calls++;request.resume();arrived();});
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
    const scope=new AbortController();const options={...settings,origin:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,signal:scope.signal};
    const result=action(createNativeClient(options)).then(()=>"SUCCESS",errorCode);
    await arrival;scope.abort("PRIVATE_REASON");
    const value=await Promise.race([result,delay(250).then(()=>"HUNG")]);
    server.closeAllConnections();await result;
    assert.equal(value,"NATIVE_CANCELLED");assert.equal(calls,1,"no automatic resend of ambiguous mutations");
  });
}
