import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeClient,type NativeLease} from '../dist/native-client.js';
const at=1_900_000_000_000;
const lease=(expiresAt:number):NativeLease=>({jobId:'native_job_clock',appId:'app_clock',platform:'android',runnerId:'native_runner_clock',attemptId:'attempt_clock',credentialEpoch:1,fence:1,expiresAt});
const client=(fetch:typeof globalThis.fetch)=>createNativeClient({origin:'https://flora.example.test',appId:'app_clock',platform:'android',token:'native_runner_clock.'+'a'.repeat(43),fetch});
function keepAlive(t:import('node:test').TestContext){const timer=setTimeout(()=>{},1000);t.after(()=>clearTimeout(timer));}
test('native lease timeout is terminal even when wall clock lags its monotonic timer',async t=>{
 keepAlive(t);t.mock.method(Date,'now',()=>at);let requests=0;
 const api=client(async(_url,init)=>{requests++;return new Promise<Response>((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(new Error('PRIVATE_TRANSPORT_DETAIL')),{once:true});});});
 await assert.rejects(api.heartbeat(lease(at+15)),/^Error: NATIVE_LEASE_EXPIRED$/);assert.equal(requests,1);
});
test('native request timeout remains transport failure while its longer lease is valid',async t=>{
 keepAlive(t);let clock=at;t.mock.method(Date,'now',()=>clock);const realTimeout=AbortSignal.timeout.bind(AbortSignal);
 t.mock.method(AbortSignal,'timeout',(duration:number)=>{assert.equal(duration,20000);const signal=realTimeout(10);signal.addEventListener('abort',()=>{clock=at+20000;},{once:true});return signal;});
 const api=client(async(_url,init)=>new Promise<Response>((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(new Error('PRIVATE_TRANSPORT_DETAIL')),{once:true});}));
 await assert.rejects(api.heartbeat(lease(at+60000)),/^Error: NATIVE_TRANSPORT_UNAVAILABLE$/);
});
test('native body timeout uses the same lease boundary and cancels its unread stream',async t=>{
 keepAlive(t);t.mock.method(Date,'now',()=>at);let cancelled=0;
 const api=client(async()=>new Response(new ReadableStream<Uint8Array>({cancel(){cancelled++;}})));
 await assert.rejects(api.heartbeat(lease(at+15)),/^Error: NATIVE_LEASE_EXPIRED$/);assert.equal(cancelled,1);
});
