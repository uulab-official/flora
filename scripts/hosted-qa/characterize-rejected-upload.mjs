// Manual, bounded characterization of https://github.com/cloudflare/workerd/issues/7634.
// A passing sample does not close this risk gate or establish deployed behavior.
// No Flora code, D1, credentials, retries, delays, or socket configuration.
import { createRequire } from 'node:module';
import { subscribe } from 'node:diagnostics_channel';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../../packages/cloudflare/package.json', import.meta.url));
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const runtimeRequire = createRequire(require.resolve('miniflare'));
const { fetch: undiciFetch } = runtimeRequire('undici');
const sockets = new WeakMap(), requests = new WeakMap(); let sid = 0, rid = 0; const trace = [];
const record = value => { trace.push(value); if(trace.length>50)trace.shift(); };
subscribe('undici:client:sendHeaders', ({ request, socket, headers }) => {
  if (!sockets.has(socket)) {
    sockets.set(socket, ++sid);
    socket.on('close', error => record({ event: 'socket.close', socket: sockets.get(socket), error }));
    socket.on('error', error => record({ event: 'socket.error', socket: sockets.get(socket), code:error.code }));
  }
  if (!requests.has(request)) requests.set(request, ++rid);
  record({event:'send', request:requests.get(request), socket:sockets.get(socket), path:request.path, contentLength:request.contentLength, bodyType:request.body?.constructor?.name, framing: headers.split('\r\n').filter(h => /^(content-length|transfer-encoding|connection):/i.test(h))});
});
for (const event of ['bodySent', 'headers', 'trailers', 'error']) subscribe('undici:request:' + event, data => record({event, request:requests.get(data.request), status:data.response?.statusCode, responseConnection:data.response?.headers?.map(x=>x.toString()).filter((x,i,a)=>x.toLowerCase()==='connection'||a[i-1]?.toLowerCase()==='connection'), code:data.error?.code}));
const bytes = Buffer.alloc(6376, 32); bytes[0]=123; bytes[6375]=125;
const mode = process.argv[2] ?? 'dispatch';
const framing = process.argv[3] ?? 'default';
const layer = process.argv[4] ?? 'do';
if (!['dispatch','direct','native'].includes(mode) || !['default','length'].includes(framing) || !['worker','do','do-async'].includes(layer)) throw new Error('Usage: node scripts/hosted-qa/characterize-rejected-upload.mjs [dispatch|direct|native] [default|length] [worker|do|do-async]');
const handler = `let entered=0; const handler = {async fetch(request){entered++; ${layer.includes('async') ? `await crypto.subtle.digest('SHA-256',new Uint8Array(32)); await crypto.subtle.digest('SHA-256',new Uint8Array(32));` : ''} if(new URL(request.url).pathname==='/deny') return Response.json({denied:true,entered},{status:403}); const body=await request.arrayBuffer();return Response.json({bytes:body.byteLength,entered});}};`;
const script = layer==='worker' ? handler+'export default handler;' : `import { DurableObject } from 'cloudflare:workers';`+handler+`export class Rejector extends DurableObject { fetch(request){return handler.fetch(request);} } export default {async fetch(request,env){const response = await env.REJECTOR.get(env.REJECTOR.idFromName('one')).fetch(request); return new Response(response.body,{status:response.status,headers:response.headers});}};`;
const mf = new Miniflare(convertV4MiniflareOptions({
  name:'reject-repro', modules:true, script, ...(layer.startsWith('do') ? {durableObjects:{REJECTOR:{className:'Rejector',useSQLite:true}}}:{}),
  compatibilityDate:'2026-10-07',host:'127.0.0.1',port:0,cf:false,telemetry:{enabled:false},
}));
let completed=0;
try {
  const origin = (await mf.ready).origin;
  console.log(JSON.stringify({gate:'unresolved-workerd-7634',mode,framing,layer,origin,bytes:bytes.length,node:process.version,nativeUndici:process.versions.undici,miniflare:require('miniflare/package.json').version,workerd:runtimeRequire('workerd/package.json').version,undici:runtimeRequire('undici/package.json').version}));
  const fetch = mode==='dispatch' ? (url,init)=>mf.dispatchFetch('https://flora.example.test'+url,init) : (url,init)=>(mode==='native'?globalThis.fetch:undiciFetch)(origin+url,init);
  for(let sequence=0;sequence<100;sequence++) {
    for(const path of ['/deny','/accept','/accept']) {
      const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json',...(framing==='length'?{'content-length':String(bytes.length)}:{})},body:bytes});
      assert.equal(response.status,path==='/deny'?403:200);
      const result=await response.json();if(path!='/deny')assert.equal(result.bytes,bytes.length);
      completed++;
    }
  }
  console.log(JSON.stringify({result:'passed',completed,trace}));
} catch(error) {
  console.log(JSON.stringify({result:'failed',completed,message:error.message,cause:error.cause?.code,trace}));
  process.exitCode=1;
} finally { await mf.dispose(); }
