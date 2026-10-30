import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AdminRoute } from '../public/admin-routes.js';
import { ADMIN_PAGES, adminPath, parseAdminPath } from '../public/admin-routes.js';

// Controller contract tests with an explicit synthetic DOM and in-memory API.
// These establish routing and stale-response isolation, not browser visual evidence.
class Element {
  children: Element[] = []; attributes: Record<string,string> = {}; value=''; disabled=false; hidden=false; text=''; className=''; id=''; type=''; open=false; required=false; checked=false; files:any[]=[];
  listeners = new Map<string, ((event:any)=>unknown)[]>();
  tagName:string;
  constructor(tagName='div') { this.tagName=tagName; }
  set textContent(v:string) { this.text=v; this.children=[]; }
  get textContent():string { return this.text+this.children.map(n=>n.textContent).join(''); }
  set innerHTML(_:string) { assert.fail('Unsafe HTML insertion'); }
  get firstElementChild(): Element | null { return this.children[0]??null; }
  focus() {} remove() {} submit() {}
  setAttribute(k:string,v:string) { assert.ok(!/^on/.test(k)); this.attributes[k]=String(v); }
  getAttribute(k:string) { return this.attributes[k]??null; }
  removeAttribute(k:string) { delete this.attributes[k]; }
  append(...nodes:Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes:Element[]) { this.text=''; this.children=nodes; }
  addEventListener(k:string,h:(event:any)=>unknown) { this.listeners.set(k,[...(this.listeners.get(k)??[]),h]); }
  async dispatch(k:string,event:any={}) { for(const h of this.listeners.get(k)??[]) await h({target:this,preventDefault(){},...event}); }
  querySelectorAll(selector:string):Element[] { return this.children.flatMap(n=>[...(matches(n,selector)?[n]:[]),...n.querySelectorAll(selector)]); }
  closest(selector:string) { return matches(this,selector)?this:null; }
}
function matches(n:Element,s:string) {
  return s.split(',').some(raw=>{ const q=raw.trim(); if(q.startsWith('#'))return n.id===q.slice(1); const m=/^(?:([a-z]+))?\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/.exec(q); return !!m&&(!m[1]||n.tagName===m[1])&&n.getAttribute(m[2]!)!==null&&(!m[3]||n.getAttribute(m[2]!)===m[3]); });
}
class Document {
  body=new Element('body'); nodes=new Map<string,Element>(); elements:Element[]=[]; activeElement:Element|null=null; visibilityState='visible'; hidden=false; listeners=new Map<string,((e:any)=>unknown)[]>();
  constructor() { for(const m of readFileSync(new URL('../public/index.html',import.meta.url),'utf8').matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/g)) { const n=new Element(m[1]); for(const a of m[2]!.matchAll(/([a-zA-Z][\w-]*)="([^"]*)"/g))n.setAttribute(a[1]!,a[2]!); n.id=n.getAttribute('id')??''; n.hidden=/\bhidden\b/.test(m[2]!); n.disabled=/\bdisabled\b/.test(m[2]!); this.elements.push(n); if(n.id)this.nodes.set(n.id,n); } }
  createElement(tag:string) { return new Element(tag); } createElementNS(_:string,tag:string) { return new Element(tag); }
  getElementById(id:string):Element { const n=this.nodes.get(id)??this.elements.flatMap(n=>n.querySelectorAll('#'+id))[0]; assert.ok(n,'Missing element '+id); return n; }
  querySelectorAll(s:string) { return this.elements.flatMap(n=>[...(matches(n,s)?[n]:[]),...n.querySelectorAll(s)]); }
  addEventListener(k:string,h:(e:any)=>unknown) { this.listeners.set(k,[...(this.listeners.get(k)??[]),h]); }
}
const at=1_900_000_000_000;
const deployment='b877e6bc-902e-487b-985d-82f179f9ad64';
function devicePage(appId:string, id=deployment) { return {appId,deploymentId:id,source:'sdk-self-report',observedAt:at,deployment:{id,platform:'android',channel:'qa',runtimeVersion:'v1',createdAt:at,commitSha:null},summary:null,installations:[],nextCursor:null,pageSize:20}; }
function state(id:string|null) { return { selected:null, snapshots:{items:[],nextCursor:null},history:{items:[],nextCursor:null},headObservation:null,freshness:'freshness_unknown',runner:'unavailable',profile:{id:'config-runtime-smoke-v1',files:[],expectedTests:0,coverage:'Synthetic'},applications:['app_a','app_b'].map(id=>({id,name:'Project '+id,createdAt:at})), selectedApplication:id?{id,name:'Project '+id,repositoryId:'repo_'+id,rootDirectory:'.',createdAt:at,settings:{version:1,values:{PUBLIC_NAME:id},updatedAt:at}}:null }; }
const response=(body:unknown,status=200)=>({ok:status<400,status,headers:new Headers(),json:async()=>body});
function deferred() { let resolve!:(value:any)=>void; const promise=new Promise<any>(r=>resolve=r);return {promise,resolve}; }
interface TestClient {
  route(): AdminRoute;
  navigate(page: string, appId?: string): Promise<unknown>;
  close(): void;
  loadCredentials(): Promise<unknown>;
  loadProjects(): Promise<unknown>;
  enrollNativeRunner(): Promise<unknown>;
  enrollRunner(): Promise<unknown>;
}
async function setup(path='/projects',intercept:(url:string,init:any)=>any=()=>undefined) {
  const { startClient }: { startClient(env: Record<string, unknown>): Promise<TestClient> }=await import(new URL('../public/app.js',import.meta.url).href); const document=new Document(); const calls:{url:string;init:any}[]=[]; const events=new Map<string,()=>unknown>(); const location={pathname:path,origin:'https://flora.example.test',hash:'',replace(_url:string){}}; const entries=[path]; let position=0; let time=at;const timers=new Map<number,{callback:()=>unknown,delay:number}>();let timerId=0;
  const history={pushState(_a:any,_b:any,path:string){entries.splice(++position);entries.push(path);location.pathname=path;},replaceState(_a:any,_b:any,path:string){entries[position]=path;location.pathname=path;}};
  const client=await startClient({document,location,history,now:()=>time,crypto:globalThis.crypto,addEventListener:(k:string,h:()=>unknown)=>events.set(k,h),setTimeout:(callback:()=>unknown,delay:number)=>{const id=++timerId;timers.set(id,{callback:()=>{timers.delete(id);return callback();},delay});return id;},clearTimeout:(id:number)=>{timers.delete(id);},fetch:async(url:string,init:any)=>{calls.push({url,init});const handled=await intercept(url,init);if(handled!==undefined)return handled;if(url==='/api/auth/session')return response({csrfToken:'s'.repeat(43),expiresAt:at+3600000});if(url.startsWith('/api/state')){const id=new URL(url,location.origin).searchParams.get('appId');return id==='foreign'?response({error:'NOT_FOUND'},404):response(state(id??'app_a'));}const id=/\/api\/apps\/([^/]+)/.exec(url)?.[1];if(url.endsWith('/telemetry'))return response(devicePage(id!));if(url.endsWith('/credentials'))return response({appId:id,configured:true,credentials:[],history:[]});if(url.endsWith('/native'))return response({appId:id,jobs:[],runners:[],events:[],credentialUses:[]});if(url.endsWith('/automation'))return response({appId:id,policy:null,jobs:[],runners:[]});if(url.endsWith('/operations'))return response({connection:null,detections:[],assets:[],deployments:[]});return response({});}});
  return {client,document,calls,location,entries,events,timers,setTime(value:number){time=value;},async visibility(hidden:boolean){document.hidden=hidden;document.visibilityState=hidden?"hidden":"visible";for(const handler of document.listeners.get("visibilitychange")??[])await handler({});await new Promise(resolve=>setImmediate(resolve));},async back(){assert.ok(position>0);location.pathname=entries[--position]!;await events.get('popstate')?.();},async pop(path:string){location.pathname=path;await events.get('popstate')?.();}};
}
function visiblePage(s:Awaited<ReturnType<typeof setup>>,page:string) { for(const [name,definition] of Object.entries(ADMIN_PAGES))assert.equal(s.document.getElementById(definition.section).hidden,name!==page,`${name} visibility on ${page}`); }

test('canonical routes distinguish app pages and reject malformed or unknown paths',()=>{ for(const page of Object.keys(ADMIN_PAGES)){const path=adminPath(page,'app_a',deployment);assert.ok(path);const route=parseAdminPath(path);assert.ok(route);assert.equal(route.page,page);}for(const path of ['/apps/app_a/nope','/apps/app_a/credentials/','/apps/%61pp_a','/apps/app_a?x=1','//projects','/unknown'])assert.equal(parseAdminPath(path),null);assert.equal(adminPath('credentials','../app_a'),null); });

test('credential deep link selects its app before private reads and restores on reload',async()=>{const s=await setup('/apps/app_a/credentials');assert.deepEqual(s.client.route(),{page:'credentials',appId:'app_a',path:'/apps/app_a/credentials'});assert.ok(s.calls.some(c=>c.url.startsWith('/api/state?')&&c.url.includes('appId=app_a')));assert.ok(s.calls.some(c=>c.url==='/api/apps/app_a/credentials'));assert.ok(!s.calls.some(c=>c.url.endsWith('/native')));visiblePage(s,'credentials');s.client.close();const reload=await setup(s.location.pathname);visiblePage(reload,'credentials');assert.equal(reload.client.route().appId,'app_a');reload.client.close();});

test('every management page has one visible wrapper and app details exclude the project list',async()=>{const s=await setup();for(const page of Object.keys(ADMIN_PAGES)){await s.client.navigate(page==='ota-detail'?adminPath(page,'app_a',deployment)!:page,'app_a');visiblePage(s,page);assert.equal(s.location.pathname,adminPath(page,'app_a',deployment));if(!['projects','register','settings'].includes(page))assert.equal(s.document.getElementById('application-panel').hidden,true);}s.client.close();});

test('native builds deep link keeps provider, Runner and OTA summaries bound to the selected app',async()=>{
  const s=await setup('/apps/app_a/builds',url=>url==='/api/apps/app_a/native'?response({
    appId:'app_a',credentialUses:[],events:[],
    runners:[{appId:'app_a',id:'native_runner_a',name:'Owned Mac',platform:'ios',revokedAt:null,lastSeenAt:at}],
    jobs:[{appId:'app_a',id:'native_job_a',platform:'ios',state:'succeeded',appIdentifier:'kr.co.test.a',createdAt:at,
      artifact:{fileName:'app-a.ipa',sha256:'b'.repeat(64),signerFingerprint:'c'.repeat(64)}}],
  }):undefined);
  visiblePage(s,'builds');
  assert.equal(s.document.getElementById('build-provider-select').value,'flora-pc-native');
  assert.match(s.document.getElementById('build-provider-summary').textContent,/app-a\.ipa/);
  assert.match(s.document.getElementById('build-provider-ota-summary').textContent,/OTA 게시 이력 0건/);
  assert.equal(s.document.getElementById('build-provider-native').disabled,false);
  assert.equal(s.document.getElementById('native-enqueue').disabled,true,'missing signing keys must not be bypassed by provider selection');
  const chooser=s.document.getElementById('build-provider-select');
  chooser.value='codemagic';await chooser.dispatch('change');
  assert.equal(s.document.getElementById('native-editor').hidden,true,'unrelated provider must hide the native submit form');
  assert.ok(!s.calls.some(call=>call.url.includes('codemagic')),'remote build must never be triggered by the web');
  await s.client.navigate('builds','app_b');
  assert.equal(s.document.getElementById('native-editor').hidden,false);
  assert.equal(s.document.getElementById('build-provider-select').value,'flora-pc-native');
  assert.ok(!s.document.getElementById('build-provider-summary').textContent.includes('app-a.ipa'));
  assert.ok(s.calls.some(call=>call.url==='/api/apps/app_b/native'));
  s.client.close();
});

test('history back restores the app and page without creating another history entry',async()=>{const s=await setup('/apps/app_a/credentials');await s.client.navigate('credentials','app_b');await s.client.navigate('builds','app_b');const count=s.entries.length;await s.back();assert.equal(s.client.route().appId,'app_b');assert.equal(s.client.route().page,'credentials');await s.back();assert.equal(s.client.route().appId,'app_a');assert.equal(s.entries.length,count);visiblePage(s,'credentials');assert.ok(s.calls.some(c=>c.url==='/api/apps/app_a/credentials'));s.client.close();});

test('app switch and page leave erase file passwords and one-time native token',async()=>{const s=await setup('/apps/app_a/credentials');for(const id of ['credential-file','credential-password','credential-key-password'])s.document.getElementById(id).value='private draft';await s.client.navigate('credentials','app_b');for(const id of ['credential-file','credential-password','credential-key-password'])assert.equal(s.document.getElementById(id).value,'');s.document.getElementById('credential-password').value='second draft';await s.client.navigate('overview','app_b');assert.equal(s.document.getElementById('credential-password').value,'');assert.equal(s.document.getElementById('native-runner-token').textContent,'');s.client.close();});

test('late credentials response cannot render after app switch',async()=>{const gate=deferred();let delay=false;const s=await setup('/apps/app_a/credentials',(url)=>delay&&url==='/api/apps/app_a/credentials'?gate.promise:undefined);delay=true;const pending=s.client.loadCredentials();await s.client.navigate('credentials','app_b');gate.resolve(response({appId:'app_a',configured:true,credentials:[{kind:'apns',version:1,activeVersion:1,label:'PRIVATE APP A',metadata:{}}],history:[]}));await pending;assert.ok(!s.document.getElementById('credential-list').textContent.includes('PRIVATE APP A'));assert.equal(s.client.route().appId,'app_b');s.client.close();});

test('late native enrollment token is discarded on leave and same-app return',async()=>{const gate=deferred();const s=await setup('/apps/app_a/builds',(url,init)=>url==='/api/apps/app_a/native/runners'&&init.method==='POST'?gate.promise:undefined);s.document.getElementById('native-runner-name').value='QA';s.document.getElementById('native-runner-platform').value='android';const pending=s.client.enrollNativeRunner();await new Promise(resolve=>setImmediate(resolve));assert.ok(s.calls.some(c=>c.url==='/api/apps/app_a/native/runners'));await s.client.navigate('overview','app_a');await s.client.navigate('builds','app_a');gate.resolve(response({runner:{appId:'app_a'},token:'native-token-test-only-123456789'}));await pending;assert.equal(s.document.getElementById('native-runner-token-panel').hidden,true);assert.equal(s.document.getElementById('native-runner-token').textContent,'');s.client.close();});

test('foreign app and unknown deep links never read default app private panels',async()=>{for(const path of ['/apps/foreign/credentials','/apps/app_a/unknown']){const s=await setup(path);assert.ok(!s.calls.some(c=>/^\/api\/apps\/app_a\/(credentials|native|operations|automation)$/.test(c.url)));assert.equal(s.document.getElementById('credential-list').children.length,0);assert.equal(s.document.getElementById('native-runner-token').textContent,'');s.client.close();}});

test('modified navigation anchor clicks preserve native browser behavior',async()=>{const s=await setup('/apps/app_a/credentials');const anchor=s.document.querySelectorAll('a[data-admin-page]')[0];assert.ok(anchor,'A semantic navigation anchor exists');for(const modifier of [{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:true},{button:1}]){let prevented=false;await anchor.dispatch('click',{button:0,...modifier,preventDefault(){prevented=true;}});assert.equal(prevented,false);assert.equal(s.client.route().page,'credentials');}s.client.close();});

test('a mismatched state response cannot substitute default app for a requested app',async()=>{const s=await setup('/apps/app_b/credentials',url=>url.startsWith('/api/state')?response(state('app_a')):undefined);assert.ok(s.calls.some(c=>c.url.includes('appId=app_b')));assert.ok(!s.calls.some(c=>/^\/api\/apps\/(app_a|app_b)\/credentials$/.test(c.url)));assert.equal(s.document.getElementById('credential-list').children.length,0);assert.equal(s.document.getElementById('route-empty').hidden,false);s.client.close();});

test('late credential receipt is discarded after leaving and returning to the same app',async()=>{const gate=deferred();let delay=false;const s=await setup('/apps/app_a/credentials',url=>delay&&url==='/api/apps/app_a/credentials'?gate.promise:undefined);delay=true;const pending=s.client.loadCredentials();await s.client.navigate('overview','app_a');delay=false;await s.client.navigate('credentials','app_a');gate.resolve(response({appId:'app_a',configured:true,credentials:[{kind:'apns',version:1,activeVersion:1,label:'STALE RECEIPT',metadata:{}}],history:[]}));await pending;assert.ok(!s.document.getElementById('credential-list').textContent.includes('STALE RECEIPT'));visiblePage(s,'credentials');s.client.close();});

test('an already displayed native enrollment token is erased on app switch',async()=>{const token='native-token-test-only-123456789';const s=await setup('/apps/app_a/builds',(url,init)=>url==='/api/apps/app_a/native/runners'&&init.method==='POST'?response({runner:{appId:'app_a'},token}):undefined);s.document.getElementById('native-runner-name').value='QA';s.document.getElementById('native-runner-platform').value='android';await s.client.enrollNativeRunner();assert.equal(s.document.getElementById('native-runner-token').textContent,token);assert.equal(s.document.getElementById('native-runner-token-panel').hidden,false);await s.client.navigate('builds','app_b');assert.equal(s.document.getElementById('native-runner-token').textContent,'');assert.equal(s.document.getElementById('native-runner-token-panel').hidden,true);assert.equal(s.client.route().appId,'app_b');s.client.close();});

test('late OTA Runner enrollment token is discarded after leave and same-app return',async()=>{const gate=deferred();const s=await setup('/apps/app_a/runners',(url,init)=>url==='/api/runners'&&init.method==='POST'?gate.promise:undefined);s.document.getElementById('runner-name').value='QA PC';const pending=s.client.enrollRunner();await new Promise(resolve=>setImmediate(resolve));assert.ok(s.calls.some(c=>c.url==='/api/runners'));await s.client.navigate('ota','app_a');await s.client.navigate('runners','app_a');gate.resolve(response({runner:{appIds:['app_a']},token:'ota-token-test-only-123456789'}));await pending;assert.equal(s.document.getElementById('runner-token').textContent,'');assert.equal(s.document.getElementById('runner-token-panel').hidden,true);assert.equal(s.client.route().page,'runners');s.client.close();});

function projectSummary(id='app_a') {return {id,name:id==='app_a'?'Isso':'Promise',createdAt:at,repositoryId:'repo_'+id,rootDirectory:'.',truncated:{repositoryId:false,rootDirectory:false},github:{owner:'uulab-official',repository:id==='app_a'?'isso':'promise',ref:'main',version:1,truncated:{owner:false,repository:false,ref:false}},ota:{ios:{id:'deploy_'+id+'_ios',channel:'verification',runtimeVersion:'runtime_'+id,createdAt:at,commitSha:'a'.repeat(40)},android:null},automation:{enabled:true,channel:'verification',platforms:['ios','android'],updatedAt:at},runner:{status:id==='app_a'?'online':'offline',registeredCount:1,activeCount:1,onlineCount:id==='app_a'?1:0,lastSeenAt:at}};}

test('project list performs one bounded summary read rather than private per-app reads',async()=>{const s=await setup('/projects',url=>url==='/api/projects'?response({projects:[projectSummary(),projectSummary('app_b')],observedAt:at}):undefined);assert.equal(s.calls.filter(c=>c.url==='/api/projects').length,1);assert.equal(s.calls.filter(c=>/^\/api\/apps\//.test(c.url)).length,0);assert.ok(s.document.getElementById('project-list').textContent.includes('uulab-official/isso'));assert.ok(s.document.getElementById('project-list').textContent.includes('uulab-official/promise'));const calls=s.calls.length;s.document.getElementById('project-search').value='uulab-official/promise';await s.document.getElementById('project-search').dispatch('input');assert.equal(s.calls.length,calls);s.client.close();});

test('project aggregation remains lazy on app detail deep links',async()=>{const s=await setup('/apps/app_a/credentials');assert.equal(s.calls.filter(c=>c.url==='/api/projects').length,0);s.client.close();});

test('late project summary after session close cannot restore private rows',async()=>{const gate=deferred();const s=await setup('/apps/app_a/credentials',url=>url==='/api/projects'?gate.promise:undefined);const pending=s.client.navigate('projects');await new Promise(resolve=>setImmediate(resolve));assert.equal(s.calls.filter(c=>c.url==='/api/projects').length,1);s.client.close();gate.resolve(response({projects:[projectSummary(),projectSummary('app_b')],observedAt:at}));await pending;assert.equal(s.document.getElementById('project-list').children.length,0);assert.ok(!s.document.getElementById('project-list').textContent.includes('uulab-official'));});

test('summary refresh failure preserves verified rows and labels their snapshot as stale',async()=>{let failed=false;const s=await setup('/projects',url=>url==='/api/projects'?failed?response({error:'UNAVAILABLE'},503):response({projects:[projectSummary(),projectSummary('app_b')],observedAt:at}):undefined);failed=true;s.setTime(at+60000);await s.client.loadProjects();const text=s.document.getElementById('project-list').textContent;assert.ok(text.includes('uulab-official/isso'));assert.ok(text.includes('verification'));assert.match(text,/이전|마지막|갱신|현재|다시|확인/);assert.ok(!text.includes('첫 프로젝트'));s.client.close();});

test('failed first summary fetch shows unavailable values without inventing no deployment',async()=>{const s=await setup('/projects',url=>url==='/api/projects'?response({error:'UNAVAILABLE'},503):undefined);const text=s.document.getElementById('project-list').textContent;assert.match(text,/확인|알 수|불러오|미확인/);assert.ok(!text.includes('게시 없음'));assert.ok(!text.includes('Runner 없음'));assert.ok(!text.includes('온라인'));s.client.close();});

test('visible summary refresh uses one request per minute across clicks, focus, and overview navigation',async()=>{
 const s=await setup('/projects',url=>url==='/api/projects'?response({projects:[projectSummary(),projectSummary('app_b')],observedAt:at}):undefined);
 for(let i=0;i<5;i++){await s.client.loadProjects();s.events.get('focus')?.();}await new Promise(resolve=>setImmediate(resolve));
 assert.equal(s.calls.filter(call=>call.url==='/api/projects').length,1);
 await s.client.navigate('overview','app_a');assert.equal(s.calls.filter(call=>call.url==='/api/projects').length,1);assert.ok(s.document.getElementById('project-readiness').textContent.includes('uulab-official/isso'));assert.equal(s.calls.filter(call=>/\/(operations|automation|native)$/.test(call.url)).length,0);
 s.setTime(at+60000);const timer=[...s.timers.values()].find(timer=>timer.delay===60000);assert.ok(timer);timer.callback();await new Promise(resolve=>setImmediate(resolve));assert.equal(s.calls.filter(call=>call.url==='/api/projects').length,2);s.client.close();assert.equal(s.timers.size,0);
});
test('summary singleflight and visibility fences discard a hidden response without querying private panels',async()=>{
 const gate=deferred();let hold=false;const s=await setup('/projects',url=>url==='/api/projects'?hold?gate.promise:response({projects:[projectSummary()],observedAt:at}):undefined);
 hold=true;s.setTime(at+60000);const first=s.client.loadProjects(),second=s.client.loadProjects();await new Promise(resolve=>setImmediate(resolve));assert.equal(s.calls.filter(call=>call.url==='/api/projects').length,2);
 await s.visibility(true);assert.equal([...s.timers.values()].some(timer=>timer.delay===60000),false);gate.resolve(response({projects:[{...projectSummary(),name:'LATE HIDDEN PRIVATE'}],observedAt:at+60000}));await Promise.all([first,second]);assert.ok(!s.document.getElementById('project-list').textContent.includes('LATE HIDDEN PRIVATE'));s.events.get('focus')?.();await new Promise(resolve=>setImmediate(resolve));assert.equal(s.calls.filter(call=>call.url==='/api/projects').length,2);s.client.close();
});
test('optional measured usage and applied verification are admitted while invalid metadata preserves prior snapshots',async()=>{
 const verified={...projectSummary(),ota:{ios:{...projectSummary().ota.ios,verification:{source:'operator-verification',environment:'ios-simulator',observedAt:at,applied:true,restarted:true,signatureVerified:true,assetsVerified:true,receiptDigest:'a'.repeat(64)}},android:null}};
 const usage={status:'ready',source:'cloudflare-graphql',scope:'account',day:'2030-03-17',rowsRead:42,rowsWritten:7,readLimit:5000000,writeLimit:100000,resetAt:at+86400000,observedAt:at,freshUntil:at+600000};let invalid=false;
 const s=await setup('/projects',url=>url==='/api/projects'?response({projects:[verified],observedAt:at,usage:{...usage,rowsRead:invalid?-1:42}}):undefined);
 assert.ok(s.document.getElementById('workspace-infrastructure').textContent.includes('42'));assert.match(s.document.getElementById('project-list').textContent,/적용·재시작 검증/);
 invalid=true;s.setTime(at+60000);await s.client.loadProjects();assert.ok(s.document.getElementById('workspace-infrastructure').textContent.includes('42'));assert.match(s.document.getElementById('project-summary-status').textContent,/이전/);s.client.close();
});
test('wrong-platform verification metadata cannot manufacture applied proof',async()=>{
 const invalid={...projectSummary(),ota:{ios:{...projectSummary().ota.ios,verification:{source:'operator-verification',environment:'android-emulator',observedAt:at,applied:true,restarted:true,signatureVerified:true,assetsVerified:true,receiptDigest:'a'.repeat(64)}},android:null}};
 const s=await setup('/projects',url=>url==='/api/projects'?response({projects:[invalid],observedAt:at}):undefined);assert.ok(!s.document.getElementById('project-list').textContent.includes('적용·재시작 검증'));assert.match(s.document.getElementById('project-summary-status').textContent,/미확인|불러오지/);s.client.close();
});

test('late summary across app overview switches cannot restore foreign operational metadata',async()=>{
 const gate=deferred();const s=await setup('/apps/app_a/credentials',url=>url==='/api/projects'?gate.promise:undefined);
 const first=s.client.navigate('overview','app_a');await new Promise(resolve=>setImmediate(resolve));const next=s.client.navigate('overview','app_b');await new Promise(resolve=>setImmediate(resolve));gate.resolve(response({projects:[{...projectSummary(),name:'PRIVATE APP A LATE'}],observedAt:at}));await Promise.all([first,next]);
 assert.equal(s.client.route().appId,'app_b');assert.ok(!s.document.getElementById('project-readiness').textContent.includes('uulab-official/isso'));assert.ok(!s.document.getElementById('project-readiness').textContent.includes('PRIVATE APP A LATE'));assert.equal(s.calls.filter(call=>call.url==='/api/projects').length,1);s.client.close();
});
test('known authorization rejection clears cached workspace state even if its response arrives while hidden',async()=>{
 const gate=deferred();let hold=false;const s=await setup('/projects',url=>url==='/api/projects'?hold?gate.promise:response({projects:[projectSummary()],observedAt:at}):undefined);
 hold=true;s.setTime(at+60000);const pending=s.client.loadProjects();await new Promise(resolve=>setImmediate(resolve));await s.visibility(true);gate.resolve(response({error:'UNAUTHENTICATED'},401));await pending;
 assert.equal(s.document.getElementById('project-list').children.length,0);assert.equal(s.document.getElementById('workspace-status').children.length,0);assert.equal(s.timers.size,0);
});

test('SDK telemetry controller preserves cached app-bound reports and rejects malformed rate, count or environment metadata',async()=>{
 const report={source:'sdk-self-report',observedInstallations:4,downloadedInstallations:3,appliedInstallations:2,restartedInstallations:1,failedInstallations:1,rolledBackInstallations:0,applicationRate:50,lastReportedAt:at,environments:{physicalDevice:3,androidEmulator:0,iosSimulator:1,unknown:0},failures:[{stage:'download',code:'NETWORK_UNAVAILABLE',installations:1,lastReportedAt:at}]};
 let current:any=report;const s=await setup('/projects',url=>url==='/api/projects'?response({projects:[{...projectSummary(),ota:{ios:{...projectSummary().ota.ios,telemetry:current},android:null}}],observedAt:at}):undefined);
 assert.ok(s.document.getElementById('project-list').textContent.includes('SDK 보고 설치 기준 누적 적용률 50.0%'));
 for(const invalid of [{...report,applicationRate:99},{...report,appliedInstallations:Number.MAX_SAFE_INTEGER+1},{...report,environments:{physicalDevice:3,androidEmulator:1,iosSimulator:0,unknown:0}},{...report,failures:[{stage:'download',code:'SECRET_RAW_MESSAGE',installations:1,lastReportedAt:at}]}]){current=invalid;s.setTime(at+60000*(s.calls.filter(call=>call.url==='/api/projects').length));await s.client.loadProjects();assert.ok(s.document.getElementById('project-list').textContent.includes('SDK 보고 설치 기준 누적 적용률 50.0%'));assert.ok(!s.document.getElementById('project-list').textContent.includes('SECRET_RAW_MESSAGE'));assert.match(s.document.getElementById('project-summary-status').textContent,/이전/);}
 current=null;s.setTime(at+360000);await s.client.loadProjects();assert.ok(!s.document.getElementById('project-list').textContent.includes('50.0%'));assert.match(s.document.getElementById('project-list').textContent,/보고 미수집/);s.client.close();
});


test('deployment device deep link reads only scoped detail and app switch returns to its OTA list',async()=>{const s=await setup('/apps/app_a/ota/'+deployment);visiblePage(s,'ota-detail');assert.ok(s.calls.some(c=>c.url==='/api/apps/app_a/ota/deployments/'+deployment+'/telemetry'));assert.ok(!s.calls.some(c=>c.url.endsWith('/operations')));assert.match(s.document.getElementById('deployment-devices').textContent,/미수집|익명/);await (s.client as any).chooseApplication('app_b');assert.equal(s.client.route().page,'ota');assert.equal(s.client.route().appId,'app_b');assert.equal(s.document.getElementById('deployment-devices').textContent,'');s.client.close();});

test('ordinary OTA list never eagerly reads installation details and detail cache expires only on demand',async()=>{const s=await setup('/apps/app_a/ota');assert.ok(!s.calls.some(c=>c.url.includes('/telemetry')));await s.client.navigate('/apps/app_a/ota/'+deployment);await s.client.navigate('ota','app_a');await s.client.navigate('/apps/app_a/ota/'+deployment);assert.equal(s.calls.filter(c=>c.url.includes('/telemetry')).length,1);s.setTime(at+61_000);await s.client.navigate('ota','app_a');await s.client.navigate('/apps/app_a/ota/'+deployment);assert.equal(s.calls.filter(c=>c.url.includes('/telemetry')).length,2);s.client.close();assert.equal(s.document.getElementById('deployment-devices').textContent,'');});

test('late deployment response is fenced after leaving or switching to another deployment',async()=>{const gate=deferred();const newer='c877e6bc-902e-487b-985d-82f179f9ad64';const s=await setup('/apps/app_a/ota',(url)=>url.includes('/'+deployment+'/telemetry')?gate.promise:url.includes('/'+newer+'/telemetry')?response(devicePage('app_a',newer)):undefined);const pending=s.client.navigate('/apps/app_a/ota/'+deployment);await new Promise(resolve=>setImmediate(resolve));await s.client.navigate('/apps/app_a/ota/'+newer);gate.resolve(response({...devicePage('app_a'),deployment:{...devicePage('app_a').deployment,channel:'PRIVATE_OLD_DETAIL'}}));await pending;assert.ok(!s.document.getElementById('deployment-devices').textContent.includes('PRIVATE_OLD_DETAIL'));assert.equal(s.client.route().deploymentId,newer);s.client.close();});

test('automatic rollback policy is fetched only on its OTA page without new timers or installation fanout',async()=>{
 const s=await setup('/apps/app_a/credentials',url=>url.endsWith('/rollback-policy')?response({appId:'app_a',policy:null,decisions:[]}):undefined);
 assert.ok(!s.calls.some(c=>c.url.endsWith('/rollback-policy')));const timers=s.timers.size;
 await s.client.navigate('ota','app_a');assert.equal(s.calls.filter(c=>c.url.endsWith('/rollback-policy')).length,1);assert.match(s.document.getElementById('auto-rollback-policy').textContent,/기록된 자동 롤백 판단 없음/);assert.equal(s.timers.size,timers);assert.ok(!s.calls.some(c=>c.url.includes('/telemetry')));
 await s.client.navigate('credentials','app_a');assert.equal(s.document.getElementById('auto-rollback-policy').textContent,'');s.client.close();
});
test('late automatic rollback policy cannot restore another app or a closed session',async()=>{
 const gate=deferred();const s=await setup('/apps/app_a/credentials',url=>url==='/api/apps/app_a/ota/rollback-policy'?gate.promise:undefined);
 const pending=s.client.navigate('ota','app_a');await new Promise(resolve=>setImmediate(resolve));await s.client.navigate('credentials','app_b');gate.resolve(response({appId:'app_a',policy:null,decisions:[]}));await pending;assert.equal(s.document.getElementById('auto-rollback-policy').textContent,'');s.client.close();
});


test('issue deployment deep link is canonical and retains its mode through login restoration',async()=>{
 const path='/apps/app_a/ota/'+deployment+'/issues';assert.equal(adminPath('ota-issues','app_a',deployment),path);assert.deepEqual(parseAdminPath(path),{page:'ota-detail',appId:'app_a',deploymentId:deployment,filter:'issues',path});
 for(const bad of [path+'/',path+'/extra',path+'?filter=all',path.replace('/issues','/ISSUES')])assert.equal(parseAdminPath(bad),null);
 const {authReturnPath}=await import(new URL('../public/auth.js',import.meta.url).href);assert.equal(authReturnPath({pathname:'/login',search:'?returnTo='+encodeURIComponent(path)}),path);
 const s=await setup(path,url=>url.endsWith('/telemetry?filter=issues')?response({...devicePage('app_a'),filter:'issues'}):undefined);assert.equal(s.client.route().filter,'issues');visiblePage(s,'ota-detail');assert.equal(s.calls.filter(c=>c.url.endsWith('/telemetry?filter=issues')).length,1);s.client.close();
});
for(const mode of ['unresolved','resolved'] as const)test(mode+' deep link retains current issue selection through login',async()=>{
 const path='/apps/app_a/ota/'+deployment+'/'+mode;
 assert.equal(adminPath('ota-'+mode,'app_a',deployment),path);
 assert.deepEqual(parseAdminPath(path),{page:'ota-detail',appId:'app_a',deploymentId:deployment,filter:mode,path});
 const {authReturnPath}=await import(new URL('../public/auth.js',import.meta.url).href);
 assert.equal(authReturnPath({pathname:'/login',search:'?returnTo='+encodeURIComponent(path)}),path);
 for(const suffix of ['/', '/extra', '?filter=issues'])assert.equal(parseAdminPath(path+suffix),null);
 const s=await setup(path,url=>url.endsWith('/telemetry?filter='+mode)?response({...devicePage('app_a'),filter:mode,installations:[]}):undefined);
 assert.equal(s.client.route().filter,mode);visiblePage(s,'ota-detail');assert.equal(s.calls.filter(c=>c.url.endsWith('/telemetry?filter='+mode)).length,1);s.client.close();
});

test('expanding a gallery report cannot bubble into selecting the app or issue another state read',async()=>{
 const s=await setup('/projects');const card=new Element('article');card.setAttribute('data-select-application','app_a');
 const summary={closest:(selector:string)=>selector==='[data-select-application]'?card:null};
 const before=s.calls.length;await s.document.getElementById('project-list').dispatch('click',{target:summary});
 assert.equal(s.client.route().page,'projects');assert.equal(s.calls.length,before);s.client.close();
});

test('overview shortcuts keep SPA navigation and modified clicks while rejecting foreign app paths',async()=>{
 for(const mode of ['same','modified','foreign']){
  const s=await setup('/apps/app_a');const link=new Element('a'),path=mode==='foreign'?'/apps/app_b/ota':'/apps/app_a/ota';link.setAttribute('href',path);link.setAttribute('data-project-path',path);
  const before=s.calls.filter(c=>c.url.startsWith('/api/state')).length;let prevented=false;
  await s.document.getElementById('page-overview').dispatch('click',{target:link,metaKey:mode==='modified',preventDefault(){prevented=true;}});
  assert.equal(s.client.route().page,mode==='same'?'ota':'overview');assert.equal(s.client.route().appId,'app_a');
  assert.equal(prevented,mode!=='modified');assert.equal(s.calls.filter(c=>c.url.startsWith('/api/state')).length,before);s.client.close();
 }
});
