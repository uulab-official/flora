import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { createNativePanel } = await import(new URL('../public/app.js', import.meta.url).href);
class Node {
  value=''; disabled=false; hidden=false; open=false; textContent=''; children:any[]=[]; attributes:any={}; handlers:any={};
  setAttribute(k:string,v:string){this.attributes[k]=v;} append(...n:any[]){this.children.push(...n);} replaceChildren(...n:any[]){this.children=n;this.textContent='';}
  addEventListener(k:string,v:any){this.handlers[k]=v;} get text():string{return this.textContent+this.children.map(n=>n.text).join('');}
}
function setup(onView?:(app:string,view:any)=>void){
  const nodes=new Map<string,Node>(); for(const m of readFileSync(new URL('../public/index.html',import.meta.url),'utf8').matchAll(/id="([^"]+)"/g))nodes.set(m[1]!,new Node());
  const document={getElementById:(id:string)=>{assert.ok(nodes.has(id),id);return nodes.get(id)!;},createElement:()=>new Node()};
  let app='a',active=true;const calls:any[]=[],copies:string[]=[];
  const registry=()=>({appId:app,configured:true,credentials:[{kind:'android_keystore',activeVersion:2,metadata:{appIdentifier:'kr.co.a'}},{kind:'apns',activeVersion:4,metadata:{}},{kind:'google_play',activeVersion:3,metadata:{}}]});
  let responder:any=(url:string)=>url.endsWith('/credentials')?registry():{appId:app,jobs:[],runners:[],credentialUses:[]};
  nodes.get('native-platform')!.value='android'; nodes.get('native-runner-platform')!.value='android';
  const panel=createNativePanel({document,crypto:{randomUUID:()=> '1abc1234-1234-1234-1234-123456789abc'},navigator:{clipboard:{writeText:async(s:string)=>{copies.push(s);}}}},{onView,appId:()=>app,commitSha:()=> 'a'.repeat(40),active:()=>active,ready:()=>active,api:async(url:string,body:any)=>{calls.push({url,body});return responder(url,body);},expire:()=>{active=false;panel.clear();}});
  return {nodes,panel,calls,copies,registry,setApp:(v:string)=>{app=v;panel.clear();},respond:(v:any)=>{responder=v;},node:(id:string)=>nodes.get(id)!};
}
const deferred=()=>{let resolve:any;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
test('native panel loads lazily and queues only app-specific platform signing pins',async()=>{const s=setup();assert.equal(s.calls.length,0);await s.panel.load();s.respond((url:string,body:any)=>body?{appId:'a'}:url.endsWith('/credentials')?s.registry():{appId:'a',jobs:[],runners:[],credentialUses:[]});await s.panel.enqueue();const call=s.calls.find(c=>c.body);assert.equal(call.url,'/api/apps/a/native/jobs');const body=JSON.parse(call.body);assert.deepEqual(body.credentials,[{kind:'android_keystore',version:2}]);assert.equal(body.commitSha,'a'.repeat(40));assert.match(body.requestKey,/^native_/);assert.equal('teamId' in body,false);});
test('foreign nested job response never renders another app build',async()=>{const s=setup();s.respond((url:string)=>url.endsWith('/credentials')?s.registry():{appId:'a',jobs:[{appId:'b',id:'foreign'}],runners:[],credentialUses:[]});await s.panel.load();assert.equal(s.node('native-enqueue').disabled,true);assert.equal(s.node('native-jobs').children.length,0);});
test('A to B to A switches discard old async response',async()=>{const s=setup();const wait=deferred();s.respond((url:string)=>url.endsWith('/credentials')?s.registry():wait.promise);const load=s.panel.load();s.setApp('b');s.setApp('a');s.node('native-commit').value='new draft';wait.resolve({appId:'a',jobs:[],runners:[],credentialUses:[]});await load;assert.equal(s.node('native-commit').value,'new draft');assert.equal(s.node('native-jobs').children.length,0);});
test('one-time native token clears on app switch and is only copied explicitly',async()=>{const s=setup();await s.panel.load();s.node('native-runner-name').value='QA';s.respond(()=>({runner:{appId:'a'},token:'native-token-test-only-123456789'}));await s.panel.enroll();assert.equal(s.copies.length,0);assert.equal(s.node('native-runner-token-panel').hidden,false);await s.panel.copyToken();assert.deepEqual(s.copies,['native-token-test-only-123456789']);s.setApp('b');assert.equal(s.node('native-runner-token').textContent,'');await s.panel.copyToken();assert.equal(s.copies.length,1);});
test('late Runner enrollment receipt cannot display token after same-app return',async()=>{const s=setup();await s.panel.load();s.node('native-runner-name').value='QA';const wait=deferred();s.respond(()=>wait.promise);const task=s.panel.enroll();s.setApp('b');s.setApp('a');wait.resolve({runner:{appId:'a'},token:'native-token-test-only-123456789'});await task;assert.equal(s.node('native-runner-token-panel').hidden,true);});
test('unknown enqueue outcome prevents blind retries until refresh',async()=>{const s=setup();await s.panel.load();s.respond(()=>{throw new Error('offline');});await s.panel.enqueue();assert.match(s.node('native-status').textContent,/自動|자동/);assert.equal(s.node('native-enqueue').disabled,true);await s.panel.enqueue();assert.equal(s.calls.filter(c=>c.body).length,1);});
test('missing signing pins and 401 block enqueue and clear private token',async()=>{const s=setup();s.respond((url:string)=>url.endsWith('/credentials')?{appId:'a',configured:true,credentials:[]}:{appId:'a',jobs:[],runners:[],credentialUses:[]});await s.panel.load();assert.equal(s.node('native-enqueue').disabled,true);await s.panel.enqueue();assert.equal(s.calls.filter(c=>c.body).length,0);s.respond(()=>{throw {status:401};});await s.panel.load();assert.equal(s.node('native-runner-token').textContent,'');assert.equal(s.node('native-runner-enroll').disabled,true);});
test('native UI separates signing from Google and push permission and store distribution',()=>{const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');assert.match(html,/id="native-editor"/);assert.match(html,/Google Play·APNs·FCM 키는 이 서명 요청에 포함하지/);assert.match(html,/빌드 성공은 스토어 제출이나 기기 설치를 뜻하지/);});

test('native credential use audit renders scoped pins and artifact signature receipt',async()=>{const s=setup();s.respond((url:string)=>url.endsWith('/credentials')?s.registry():{appId:'a',jobs:[{appId:'a',id:'job',platform:'android',state:'succeeded',appIdentifier:'kr.co.a',commitSha:'a'.repeat(40),createdAt:1,artifact:{fileName:'app.apk',sha256:'b'.repeat(64),signerFingerprint:'c'.repeat(64)}}],runners:[],credentialUses:[{appId:'a',jobId:'job',runnerId:'runner',createdAt:1,credentials:[{kind:'android_keystore',version:2}]}]});await s.panel.load();assert.match(s.node('native-credential-uses').text,/Android Keystore · 버전 2/);assert.match(s.node('native-jobs').text,/app.apk/);assert.match(s.node('native-jobs').text,/'?c{64}/);});


test("authenticated native panel reports scoped metadata to the build provider chooser only after a valid load", async()=>{
  const seen:{app:string;view:any}[]=[];
  const s=setup((app,view)=>seen.push({app,view}));
  await s.panel.load();
  assert.equal(seen.length,1);
  assert.equal(seen[0]!.app,"a");
  assert.equal(seen[0]!.view.appId,"a");
  const pending=deferred();
  s.respond((url:string)=>url.endsWith("/credentials")?s.registry():pending.promise);
  const loading=s.panel.load();
  s.setApp("b");
  pending.resolve({appId:"a",jobs:[],runners:[],credentialUses:[]});
  await loading;
  assert.equal(seen.length,1,"late responses from an older app must never reach the build chooser");
});

test('native queued build can be cancelled with same-app proof and exactly one request',async()=>{
 const s=setup();
 const job={appId:'a',id:'native_job_queue',platform:'android',state:'queued',appIdentifier:'kr.co.a',createdAt:1,commitSha:'a'.repeat(40)};
 let cancelled=false;
 s.respond((url:string,body:any)=>body&&url.endsWith('/cancel')?(cancelled=true,{...job,state:'cancelled'}):url.endsWith('/credentials')?s.registry():{appId:'a',jobs:cancelled?[{...job,state:'cancelled'}]:[job],runners:[],credentialUses:[]});
 await s.panel.load();
 assert.match(s.node('native-jobs').text,/대기 빌드 취소/);
 await s.panel.cancelJob(job.id);
 assert.equal(s.calls.filter(x=>x.url.endsWith('/cancel')).length,1);
 assert.match(s.node('native-status').textContent,/취소를 확인했습니다/);
 await s.panel.cancelJob(job.id);
 assert.equal(s.calls.filter(x=>x.url.endsWith('/cancel')).length,1);
});
test('foreign or stale native cancellations are denied and uncertain outcome never retries blindly',async()=>{
 const s=setup();const job={appId:'a',id:'native_job_queue',platform:'android',state:'leased',appIdentifier:'kr.co.a',createdAt:1};
 s.respond((url:string,body:any)=>body?Promise.reject(new Error('transport')):url.endsWith('/credentials')?s.registry():{appId:'a',jobs:[job],runners:[],credentialUses:[]});
 await s.panel.load();
 await s.panel.cancelJob('native_other');
 assert.equal(s.calls.filter(x=>x.url.endsWith('/cancel')).length,0);
 await s.panel.cancelJob(job.id);
 assert.equal(s.calls.filter(x=>x.url.endsWith('/cancel')).length,1);
 assert.match(s.node('native-status').textContent,/취소 완료 여부를 확인하지 못했습니다/);
 await s.panel.cancelJob(job.id);
 assert.equal(s.calls.filter(x=>x.url.endsWith('/cancel')).length,1);
 s.setApp('b');
 await s.panel.cancelJob(job.id);
 assert.equal(s.calls.filter(x=>x.url.endsWith('/cancel')).length,1);
});
