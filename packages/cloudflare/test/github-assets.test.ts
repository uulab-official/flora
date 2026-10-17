import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {prepareOTAAsset,automationDigest} from '@app-ops/dogfood';
import {canonicalJson} from '@app-ops/config';
import {createTestRuntime} from './runtime.ts';
const origin='https://flora.example.test',repository='uulab-official/flora-ota-assets';
const privateKey=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}}).privateKey;
const reference=Buffer.from(canonicalJson({schemaVersion:1,releaseId:91,assetId:92})).toString('base64url');
async function fixture(t:test.TestContext,calls=3000,timeout=15000){
 const bytes=new Uint8Array(8).fill(1),asset=await prepareOTAAsset('app_isso',{key:'launch',contentType:'application/javascript',fileExtension:'.js'},bytes,1),body={schemaVersion:1,origin,appId:asset.appId,jobId:'job_isso',attemptId:'attempt_isso',commitSha:'a'.repeat(40),platform:'ios',asset:{digest:asset.digest,hash:asset.hash,key:asset.key,contentType:asset.contentType,fileExtension:asset.fileExtension,size:asset.size}},tag='flora-ota-v1-'+await automationDigest(body),requests:{url:string;headers:Headers;body:string}[]=[];let failure='';
 const r=await createTestRuntime({entrypoint:new URL('./fixtures/github-assets-entry.mjs',import.meta.url),durableObjects:{TEST:'TestGitHubAssets'},bindings:{PRIVATE_KEY:privateKey,CALL_LIMIT:calls,TIMEOUT:timeout},outboundService:async request=>{
  const url=new URL(request.url);requests.push({url:request.url,headers:request.headers,body:request.method==='POST'?await request.text():''});
  if(url.hostname==='release-assets.githubusercontent.com'){if(failure==='second-redirect')return new Response(null,{status:302,headers:{Location:'https://attacker.invalid/private'}});assert.equal(request.headers.get('Authorization'),null);assert.equal(request.headers.get('Cookie'),null);return new Response(failure==='corrupt-bytes'?new Uint8Array(8).fill(2):failure==='oversized'?new Uint8Array(9):bytes,{headers:failure==='compressed'?{'Content-Encoding':'gzip'}:failure==='length'?{'Content-Length':'7'}:{}});}
  assert.equal(url.origin,'https://api.github.com');assert.ok(request.headers.get('Authorization')?.startsWith('Bearer '));
  if(url.pathname.endsWith('/access_tokens')){assert.deepEqual(JSON.parse(requests.at(-1)!.body),{repositories:['flora-ota-assets'],permissions:{contents:'read'}});return Response.json({token:'synthetic_read_token',expires_at:new Date(Date.UTC(2026,9,17)+3600000).toISOString()},{status:201});}
  if(url.pathname==='/repos/'+repository&&failure==='secondary-reset')return new Response('private-canary',{status:403,headers:{'X-RateLimit-Remaining':'1','X-RateLimit-Reset':String((Date.UTC(2026,9,17)+10000)/1000)}});
  if(url.pathname==='/repos/'+repository&&failure==='secondary')return new Response('private-canary',{status:403});
  if(url.pathname==='/repos/'+repository&&failure==='rate')return new Response('private-canary',{status:429,headers:{'Retry-After':'60'}});
  if(url.pathname==='/repos/'+repository)return Response.json({id:9001,full_name:repository,private:true});
  if(url.pathname==='/repos/'+repository+'/releases/91')return Response.json({id:91,draft:false,prerelease:true,tag_name:failure==='tag'?'other':tag,body:failure==='body'?'{}':canonicalJson(body),assets:[{id:92,name:'flora-'+asset.digest+'.bin',state:'uploaded',size:asset.size,content_type:'application/octet-stream',digest:failure==='digest'?'sha256:'+'0'.repeat(64):'sha256:'+asset.digest}]});
  if(url.pathname==='/repos/'+repository+'/releases/assets/92'){assert.equal(request.headers.get('Accept'),'application/octet-stream');if(failure==='direct')return new Response(bytes);return new Response(null,{status:302,headers:{Location:failure==='redirect'?'https://attacker.invalid/private':'https://release-assets.githubusercontent.com/github-production-release-asset/9001/mock?sig=private-canary'}});}
  return new Response('private-canary',{status:404});
 }});t.after(()=>r.dispose());const call=async(body:Record<string,unknown>)=>{const response=await r.fetch(origin,{method:'POST',body:JSON.stringify(body)});return {status:response.status,data:await response.json() as any};};return {r,requests,call,fail:(value:string)=>{failure=value;}};
}
test('GitHub external proof requires a bounded reference before I/O, verifies private release bytes, and pins old repository locator',async t=>{
 const f=await fixture(t);assert.equal((await f.call({action:'put'})).status,428);assert.equal(f.requests.length,0);assert.equal((await f.call({action:'put',reference:'garbage'})).status,400);assert.equal(f.requests.length,0);
 const result=await f.call({action:'put',reference});assert.equal(result.status,200,JSON.stringify(result.data));assert.match(result.data.proof.objectKey,/^github-release\/v1\/[a-f0-9]{64}\/app_isso\/[a-f0-9]{64}$/);assert.ok(result.data.proof.version.length<=768);assert.equal(JSON.parse(result.data.proof.version).repositoryId,9001);
 const read=await f.call({action:'get',jobId:'job_reconnected',attemptId:'attempt_other',proof:result.data.proof});assert.equal(read.status,200);assert.deepEqual(read.data.bytes,Array(8).fill(1));
 const before=f.requests.length;assert.equal((await f.call({action:'get',appId:'app_promise',proof:result.data.proof})).status,503);assert.equal((await f.call({action:'get',owner:'other',proof:result.data.proof})).status,503);assert.equal(f.requests.length,before);
});
test('GitHub rejects corrupted metadata, byte bodies, unsafe redirects and authority changes without leaking provider diagnostics',async t=>{
 const f=await fixture(t),valid=await f.call({action:'put',reference});assert.equal(valid.status,200);
 for(const failure of ['body','tag','digest','corrupt-bytes','oversized','redirect','compressed','length','second-redirect']){f.fail(failure);const result=await f.call({action:'get',proof:valid.data.proof});assert.equal(result.status,503,failure);assert.ok(!JSON.stringify(result.data).includes('private-canary'));}
 f.fail('direct');assert.equal((await f.call({action:'get',proof:valid.data.proof})).status,200);f.fail('');assert.equal((await f.call({action:'put',reference,flip:'/releases/91'})).data.error,'AUTHORITY_CHANGED');assert.equal((await f.call({action:'put',reference,attemptId:'attempt_wrong'})).status,503);
});
test('GitHub calls reserve durable hourly credits before network and fail closed at the configured ceiling',async t=>{
 const f=await fixture(t,1);assert.equal((await f.call({action:'put',reference})).status,429);assert.equal(f.requests.length,1);assert.equal((await f.call({action:'put',reference})).status,429);assert.equal(f.requests.length,1);
});
test('GitHub throttle cooldown survives reconstruction and prevents repeated provider calls',async t=>{
 const f=await fixture(t);f.fail('rate');assert.equal((await f.call({action:'put',reference})).status,429);const before=f.requests.length;
 await f.call({action:'restart'});assert.equal((await f.call({action:'put',reference})).status,429);assert.equal(f.requests.length,before);f.fail('');
 assert.equal((await f.call({action:'put',reference,now:Date.UTC(2026,9,17)+61000})).status,200);
});
test('GitHub reference rejects noncanonical JSON, unknown fields and unsafe numeric identifiers before I/O',async t=>{
 const f=await fixture(t);for(const raw of [{schemaVersion:0,releaseId:91,assetId:92},{schemaVersion:1,releaseId:0,assetId:92},{schemaVersion:1,releaseId:91,assetId:Number.MAX_SAFE_INTEGER+1},{schemaVersion:1,releaseId:91,assetId:92,url:'https://attacker.invalid'}]){const value=Buffer.from(canonicalJson(raw)).toString('base64url');assert.equal((await f.call({action:'put',reference:value})).status,400);}
 const unsorted=Buffer.from(JSON.stringify({schemaVersion:1,releaseId:91,assetId:92})).toString('base64url');assert.equal((await f.call({action:'put',reference:unsorted})).status,400);assert.equal(f.requests.length,0);
});
test('GitHub headerless secondary-limit403 pauses calls across helper reconstruction',async t=>{
 const f=await fixture(t);f.fail('secondary');assert.equal((await f.call({action:'put',reference})).status,429);const before=f.requests.length;await f.call({action:'restart'});assert.equal((await f.call({action:'put',reference})).status,429);assert.equal(f.requests.length,before);
});
test('GitHub bounded deadline cancels an unfinished binary body and releases read admission',async t=>{
 const f=await fixture(t,3000,500),timed=await f.call({action:'put',reference,hang:true});assert.equal(timed.status,503);assert.ok((await f.call({action:'stats'})).data.cancelled>=1);assert.equal((await f.call({action:'put',reference})).status,200);
});
test('GitHub secondary throttle cannot borrow an earlier primary reset when requests remain',async t=>{
 const f=await fixture(t);f.fail('secondary-reset');assert.equal((await f.call({action:'put',reference})).status,429);const before=f.requests.length;await f.call({action:'restart'});assert.equal((await f.call({action:'put',reference,now:Date.UTC(2026,9,17)+20000})).status,429);assert.equal(f.requests.length,before);f.fail('');assert.equal((await f.call({action:'put',reference,now:Date.UTC(2026,9,17)+61000})).status,200);
});
