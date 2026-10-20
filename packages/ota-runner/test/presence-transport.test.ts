import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRunnerClient,RunnerHttpFailure,runnerFailureDiagnostic} from '../dist/index.js';

const token='runner_fixture.'+'a'.repeat(43),origin='https://flora.example.test';
function interrupted(status=200){
 let sent=false;
 return new Response(new ReadableStream<Uint8Array>({pull(controller){
  if(!sent){sent=true;controller.enqueue(new TextEncoder().encode('{"runnerId":"runner_fixture",'));}
  else controller.error(new Error('private socket failure must not be printed'));
 }}),{status});
}
const transport=(error:unknown)=>error instanceof RunnerHttpFailure&&error.status===0&&error.message==='RUNNER_TRANSPORT_UNAVAILABLE';

test('interrupted presence body is unavailable and a later probe can recover without replay inside the client',async()=>{
 let calls=0;const now=Date.now();
 const client=createRunnerClient({origin,token,fetch:async()=>++calls===1?interrupted():Response.json({runnerId:'runner_fixture',lastSeenAt:now})});
 await assert.rejects(client.presence!(),transport);
 assert.equal(calls,1);
 assert.deepEqual(await client.presence!(),{runnerId:'runner_fixture',lastSeenAt:now});
 assert.equal(calls,2);
});

test('real HTTP presence body disconnect after headers recovers on a later explicit probe',async t=>{
 let requests=0,headersObserved=0;
 const server=createServer((request,response)=>{
  assert.equal(request.headers.authorization,'Bearer '+token);
  response.writeHead(200,{'Content-Type':'application/json'});
  if(++requests===1){response.write('{"runnerId":"runner_fixture",');setTimeout(()=>response.destroy(),30);}
  else response.end(JSON.stringify({runnerId:'runner_fixture',lastSeenAt:Date.now()}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();}));
 const address=server.address() as {port:number};
 const client=createRunnerClient({origin:'http://127.0.0.1:'+address.port,token,fetch:async(input,options)=>{
  const response=await fetch(input,options);assert.equal(response.status,200);headersObserved++;return response;
 }});
 await assert.rejects(client.presence!(),transport);assert.equal(headersObserved,1);assert.equal(requests,1);
 assert.equal((await client.presence!()).runnerId,'runner_fixture');assert.equal(requests,2);
});

test('complete malformed, oversized and incorrect presence bodies remain invalid',async()=>{
 for(const response of [()=>new Response('{'),()=>new Response('x'.repeat(1048577)),()=>new Response(null),()=>Response.json({runnerId:'runner_other',lastSeenAt:Date.now()})]){
  let calls=0;const client=createRunnerClient({origin,token,fetch:async()=>{calls++;return response();}});
  await assert.rejects(client.presence!(),/RUNNER_RESPONSE_INVALID/);assert.equal(calls,1);
 }
});

test('interrupted presence rejection keeps its authoritative HTTP status',async()=>{
 for(const status of [401,403,409]){
  let calls=0;const client=createRunnerClient({origin,token,fetch:async()=>{calls++;return interrupted(status);}});
  await assert.rejects(client.presence!(),error=>error instanceof RunnerHttpFailure&&error.status===status);assert.equal(calls,1);
 }
});

test('an interrupted successful claim response remains uncertain and must not be replayed',async()=>{
 let calls=0;const client=createRunnerClient({origin,token,fetch:async()=>{calls++;return interrupted();}});
 await assert.rejects(client.claim(),/RUNNER_RESPONSE_INVALID/);assert.equal(calls,1);
});

test('presence supervisor survives exhausted interrupted probes, visits other apps and reports actual recovery',async()=>{
 const supervisorModule=new URL('../../../scripts/local-runner/supervisor.mjs',import.meta.url).href;
 const {presenceLoop,sanitizedLine}=await import(supervisorModule);
 const controller=new AbortController(),events:Record<string,unknown>[]=[],calls:string[]=[],waits:number[]=[];
 let attempts=0,cycles=0;
 const failed=createRunnerClient({origin,token,fetch:async()=>++attempts<=3?interrupted():Response.json({runnerId:'runner_fixture',lastSeenAt:Date.now()})});
 const healthy=createRunnerClient({origin,token,fetch:async()=>Response.json({runnerId:'runner_fixture',lastSeenAt:Date.now()})});
 await presenceLoop({runnerConfigs:['first','second']},{signal:controller.signal,env:{},
  run:async(_command:unknown,args:string[])=>{calls.push(args[2]!);try{return{exitCode:0,overflow:false,records:[{state:'presence',...await(args[2]==='first'?failed:healthy).presence!()}]};}
   catch(error){return{exitCode:1,overflow:false,records:[sanitizedLine(JSON.stringify(runnerFailureDiagnostic('runner-execution',error)))]};}},
  pause:async(ms:number)=>{waits.push(ms);if(ms===60000&&++cycles===2)controller.abort();},
  log:async(event:Record<string,unknown>)=>{events.push(event);},stop:async()=>assert.fail('a lost presence body must not latch all apps')});
 assert.deepEqual(calls,['first','first','first','second','first','second']);
 assert.deepEqual(waits,[5000,5000,60000,60000]);
 assert.equal(events.filter(e=>e.event==='presence-unavailable'&&e.appIndex===0).length,1);
 assert.equal(events.filter(e=>e.state==='presence'&&e.appIndex===0).length,1);
 assert.equal(events.filter(e=>e.state==='presence'&&e.appIndex===1).length,2);
 assert.ok(!JSON.stringify(events).includes('private socket failure'));
});
