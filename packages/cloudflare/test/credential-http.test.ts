import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,generateKeyPairSync} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createTestRuntime} from './runtime.ts';

const origin='https://flora.example.test',email='owner@example.test';
async function harness(t:TestContext,configured=true){
  const token=randomBytes(32),password=randomBytes(24).toString('base64url'),now=Date.now();
  const runtime=await createTestRuntime({entrypoint:new URL('./fixtures/credential-http-entry.ts',import.meta.url),durableObjects:{FLORA_AUTH:'CredentialHttpFixture'},bindings:{
    FLORA_ORIGIN:origin,FLORA_OWNER_ID:'synthetic-owner',FLORA_OWNER_EMAIL:email,FLORA_DB_IDENTITY:'synthetic-db',
    ...(configured?{FLORA_VAULT_KEYS:JSON.stringify({active:'v1',keys:{v1:randomBytes(32).toString('base64url')}})}:{}),
    FLORA_SETUP:{digest:createHash('sha256').update(token).digest('hex'),issuedAt:now,expiresAt:now+600000,generation:1,purpose:'enroll'},
  }});t.after(()=>runtime.dispose());
  const schema=(await Promise.all(['0001_private_imports.sql','0002_multi_app.sql','0003_github_ota.sql','0004_automation.sql'].map(name=>readFile(new URL('../migrations/'+name,import.meta.url),'utf8')))).join('\n');
  await runtime.d1.exec(schema.replace(/^--.*$/gm,'').split(/;\s*(?=CREATE|INSERT|PRAGMA|$)/).filter(s=>s.trim()).map(s=>s.replace(/\s*\n\s*/g,' ').trim()+';').join('\n'));
  await runtime.d1.prepare('INSERT INTO flora_deployment(singleton,owner_id,origin,db_identity) VALUES(1,?,?,?)').bind('synthetic-owner',origin,'synthetic-db').run();
  let cookie='',csrf='';
  // Authority probes intentionally leave rejected POST bodies unread. Independent
  // connections avoid racing workerd's rejection close against the next request.
  const call=(path:string,input?:unknown,headers:Record<string,string>={})=>runtime.fetch(origin+path,{method:input===undefined?'GET':'POST',headers:{Connection:'close',Cookie:cookie,...(input===undefined?{}:{Origin:origin,'Content-Type':'application/json','X-Flora-CSRF':csrf}),...headers},...(input===undefined?{}:{body:JSON.stringify(input)})});
  const enroll=await call('/api/auth/enroll',{email,password,confirmation:password,token:token.toString('base64url')});assert.equal(enroll.status,200);
  cookie=enroll.headers.getSetCookie().map(c=>c.split(';',1)[0]).join('; ');csrf=(await enroll.json() as {csrfToken:string}).csrfToken;
  const apps:string[]=[];
  for(let i=0;i<2;i++){const r=await call('/api/apps',{name:'Credential app '+i,repositoryId:'synthetic/repo-'+i,rootDirectory:'.'});assert.equal(r.status,201);apps.push((await r.json() as {id:string}).id);}
  return {runtime,call,apps};
}
function candidate(expectedVersion=0,label='APNs QA'){
  const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1',privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
  return {kind:'apns',label,expectedVersion,metadata:{teamId:'TEAM123456',keyId:'KEY1234567',appIdentifier:'test.example.app',environment:'sandbox'},payload:{fileBase64:Buffer.from(privateKey).toString('base64')}};
}
test('credential API isolates two apps rotation history and preserves legacy trust and settings',async t=>{
  const h=await harness(t),a=h.apps[0]!,b=h.apps[1]!;
  const states=[];const trust=[];
  for(const appId of h.apps){await (await h.call(`/api/apps/${appId}/settings`,{expectedVersion:0,values:{PUBLIC_APP:appId}})).json();trust.push(await (await h.call(`/api/apps/${appId}/signing-key`,{})).json());states.push(await (await h.call('/api/state?appId='+appId)).json());}
  const first=candidate();const one=await h.call(`/api/apps/${a}/credentials`,first);assert.equal(one.status,201);const av=await one.json() as any;
  assert.equal(av.appId,a);assert.equal(av.credentials[0].activeVersion,1);assert.equal(av.history.length,1);
  const other=await h.call(`/api/apps/${b}/credentials`);assert.equal(other.status,200);assert.equal((await other.json() as any).credentials.length,0);
  const b1=await h.call(`/api/apps/${b}/credentials`,candidate(0,'B credential'));assert.equal(b1.status,201);const bv=await b1.json();
  const rotated=await h.call(`/api/apps/${a}/credentials`,candidate(1,'A replacement'));assert.equal(rotated.status,201);const a2=await rotated.json() as any;
  assert.equal(a2.credentials[0].version,2);assert.equal(a2.credentials[0].activeVersion,2);assert.deepEqual(a2.history.map((v:any)=>v.action).sort(),['registered','rotated']);
  assert.deepEqual(await (await h.call(`/api/apps/${b}/credentials`)).json(),bv);
  const stale=await h.call(`/api/apps/${a}/credentials`,candidate(1));assert.equal(stale.status,409);await stale.json();
  const invalid=await h.call(`/api/apps/${a}/credentials`,{...candidate(2),payload:{fileBase64:'broken'}});assert.equal(invalid.status,400);await invalid.json();
  assert.deepEqual(await (await h.call(`/api/apps/${a}/credentials`)).json(),a2);
  const disabled=await h.call(`/api/apps/${a}/credentials/disable`,{kind:'apns',expectedVersion:2});assert.equal(disabled.status,200);const off=await disabled.json() as any;assert.equal(off.credentials[0].activeVersion,null);assert.equal(off.credentials[0].version,3);
  assert.deepEqual(await (await h.call(`/api/apps/${b}/credentials`)).json(),bv);
  await (await h.call('/__test/control',{restart:true})).json();assert.deepEqual(await (await h.call(`/api/apps/${a}/credentials`)).json(),off);
  for(let i=0;i<h.apps.length;i++){assert.deepEqual(await (await h.call('/api/state?appId='+h.apps[i])).json(),states[i]);assert.deepEqual(await (await h.call(`/api/apps/${h.apps[i]}/signing-key`,{})).json(),trust[i]);}
  const publicText=JSON.stringify([av,bv,a2,off,await (await h.call('/__test/logs')).json()]);assert.ok(!publicText.includes(first.payload.fileBase64));assert.ok(!publicText.includes('BEGIN PRIVATE KEY'));assert.ok(!publicText.includes('wrappedDek'));
});
test('credentials require session csrf registered app and reject Runner authority or raw export',async t=>{
  const h=await harness(t),path=`/api/apps/${h.apps[0]}/credentials`;
  for(const [url,input,headers,status]of [
    [path,undefined,{Cookie:''},401],[path,candidate(),{'X-Flora-CSRF':''},403],
    [path,undefined,{Cookie:'',Authorization:'Bearer synthetic-runner'},401],
    ['/api/apps/application_absent/credentials',undefined,{},404],
    [path+'/export',undefined,{},404],[path+'/raw',undefined,{},404],
  ] as const){const r=await h.call(url,input,headers);assert.equal(r.status,status);assert.ok(!(await r.text()).includes('PRIVATE KEY'));}
  const probe=await h.call('/__test/unread?appId='+h.apps[0]);assert.deepEqual(await probe.json(),{status:401,reads:0});
});
test('missing Vault secret leaves legacy app APIs available and registration fails closed',async t=>{
  const h=await harness(t,false),path=`/api/apps/${h.apps[0]}/credentials`;
  const list=await h.call(path);assert.equal(list.status,200);assert.equal((await list.json() as any).configured,false);
  const rejected=await h.call(path,candidate());assert.equal(rejected.status,503);await rejected.json();
  const state=await h.call('/api/state?appId='+h.apps[0]);assert.equal(state.status,200);await state.json();
  const trust=await h.call(`/api/apps/${h.apps[0]}/signing-key`,{});assert.equal(trust.status,201);await trust.json();
});
test('revoking the session while reading a credential body prevents registration',async t=>{
  const h=await harness(t);await (await h.call('/__test/control',{hold:true})).json();
  const pending=h.call(`/api/apps/${h.apps[0]}/credentials`,candidate());
  await (await h.call('/__test/control',{wait:true})).json();await (await h.call('/__test/control',{revoke:true,release:true})).json();
  const r=await pending;assert.equal(r.status,401);await r.json();
  const rows=await h.call('/__test/control',{sql:"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%credential%'"});const tables=await rows.json() as {name:string}[];
  for(const table of tables){const result=await h.call('/__test/control',{sql:`SELECT count(*) AS total FROM ${table.name}`});assert.deepEqual(await result.json(),[{total:0}]);}
});
test('workerd stores native Google and push types with honest validation levels and no password responses',async t=>{
  const h=await harness(t),path=`/api/apps/${h.apps[0]}/credentials`;
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
  const google=Buffer.from(JSON.stringify({type:'service_account',project_id:'test-project',client_email:'qa@test-project.iam.gserviceaccount.com',private_key_id:'private-key-id',private_key:privateKey,token_uri:'https://oauth2.googleapis.com/token'})).toString('base64');
  const opaque=Buffer.from('SYNTHETIC_SIGNING_FILE').toString('base64');
  const apple=candidate();
  const imports=[
    {kind:'ios_distribution',payload:{fileBase64:opaque,password:'QA-only-private-password'},metadata:{}},
    {kind:'ios_provisioning',payload:{fileBase64:opaque},metadata:{}},
    {kind:'android_keystore',payload:{fileBase64:opaque,password:'QA-only-private-password',keyAlias:'qa',keyPassword:'QA-only-private-password'},metadata:{}},
    {kind:'firebase_ios',payload:{fileBase64:opaque},metadata:{}},
    {kind:'apns',payload:apple.payload,metadata:apple.metadata},
    {kind:'app_store_connect',payload:apple.payload,metadata:{keyId:'KEY1234567',issuerId:'12345678-1234-1234-1234-123456789abc'}},
    {kind:'google_play',payload:{fileBase64:google},metadata:{appIdentifier:'test.example.app'}},
    {kind:'fcm',payload:{fileBase64:google},metadata:{projectId:'test-project'}},
    {kind:'firebase_android',payload:{fileBase64:Buffer.from(JSON.stringify({project_info:{project_id:'test-project'},client:[{client_info:{android_client_info:{package_name:'test.example.app'}}}]})).toString('base64')},metadata:{appIdentifier:'test.example.app'}},
  ];
  for(const input of imports){const r=await h.call(path,{...input,label:input.kind,expectedVersion:0});assert.equal(r.status,201,input.kind);const result=await r.json() as any;const found=result.credentials.find((c:any)=>c.kind===input.kind);assert.equal(found.verification,['ios_distribution','ios_provisioning','android_keystore','firebase_ios'].includes(input.kind)?'stored_unverified':input.kind==='firebase_android'?'app_identity_verified':'key_format_verified');assert.ok(!JSON.stringify(result).includes('QA-only-private-password'));assert.ok(!JSON.stringify(result).includes(input.payload.fileBase64));}
  const all=await h.call(path);const beforeOversize=await all.json() as any;assert.equal(beforeOversize.credentials.length,9);
  assert.equal((await (await h.call(`/api/apps/${h.apps[1]}/credentials`)).json() as any).history.length,0);
  // A real oversized HTTP upload can close with EPIPE after the Worker rejects
  // its Content-Length without reading. The fixture relays bounded local streams
  // through the same production Worker/auth path; failures are never retried.
  for(const mode of ['header','stream'] as const){
    const response=await h.call('/__test/oversized',{appId:h.apps[0],mode});assert.equal(response.status,200);
    const oversized=await response.json() as {status:number;result:{error:string};reads:number;bytes:number};
    assert.equal(oversized.status,413,mode);assert.deepEqual(oversized.result,{error:'BODY_TOO_LARGE'},mode);
    assert.ok(Number.isSafeInteger(oversized.reads)&&oversized.reads>=0&&oversized.reads<=24,mode+' bounded stream pulls');
    assert.ok(Number.isSafeInteger(oversized.bytes)&&oversized.bytes>=0&&oversized.bytes<=1_500_001,mode+' bounded produced bytes');
    if(mode==='stream')assert.equal(oversized.bytes,1_500_001,'stream rejects on the exact first excess byte');
    t.diagnostic(JSON.stringify({boundary:'credential-oversized-'+mode,status:oversized.status,reads:oversized.reads,bytes:oversized.bytes}));
    assert.deepEqual(await (await h.call(path)).json(),beforeOversize,mode+' rejected body must not mutate credentials');
  }
});
