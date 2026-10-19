import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ProjectSummary } from '../public/project-views.js';
import { renderProjectRows, renderOperationalOverview, renderCompactOtaHistory, renderCompactAutomationJobs, renderWorkspaceStatus, technicalDetails, isValidSdkIssueResolution } from '../public/project-views.js';

// Synthetic DOM view contracts, separate from visual/browser verification.
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
  body=new Element('body'); nodes=new Map<string,Element>(); elements:Element[]=[]; activeElement:Element|null=null; visibilityState='visible'; listeners=new Map<string,((e:any)=>unknown)[]>();
  constructor() { for(const m of readFileSync(new URL('../public/index.html',import.meta.url),'utf8').matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/g)) { const n=new Element(m[1]); for(const a of m[2]!.matchAll(/([a-zA-Z][\w-]*)="([^"]*)"/g))n.setAttribute(a[1]!,a[2]!); n.id=n.getAttribute('id')??''; n.hidden=/\bhidden\b/.test(m[2]!); n.disabled=/\bdisabled\b/.test(m[2]!); this.elements.push(n); if(n.id)this.nodes.set(n.id,n); } }
  createElement(tag:string) { return new Element(tag); } createElementNS(_:string,tag:string) { return new Element(tag); }
  getElementById(id:string):Element { const n=this.nodes.get(id)??this.elements.flatMap(n=>n.querySelectorAll('#'+id))[0]; assert.ok(n,'Missing element '+id); return n; }
  querySelectorAll(s:string) { return this.elements.flatMap(n=>[...(matches(n,s)?[n]:[]),...n.querySelectorAll(s)]); }
  addEventListener(k:string,h:(e:any)=>unknown) { this.listeners.set(k,[...(this.listeners.get(k)??[]),h]); }
}
const at=1_900_000_000_000;
// The renderer uses the explicit mock's DOM subset; this adapter is confined to the test boundary.
const asDom=(document:Document):globalThis.Document=>document as unknown as globalThis.Document;
function project(id='app_a'):ProjectSummary { return {id,name:id==='app_a'?'Isso':'Promise',createdAt:at,repositoryId:'repo_'+id,rootDirectory:'.',github:{owner:'uulab-official',repository:id==='app_a'?'isso':'promise',ref:'main',version:1},ota:{ios:{id:'deploy_'+id+'_ios',channel:id==='app_a'?'verification':'production',runtimeVersion:'runtime_'+id,createdAt:at,commitSha:'a'.repeat(40)},android:id==='app_a'?{id:'deploy_'+id+'_android',channel:'android-qa',runtimeVersion:'runtime_'+id,createdAt:at,commitSha:'b'.repeat(40)}:null},automation:{enabled:true,channel:'verification',platforms:['ios','android'],updatedAt:at},runner:{status:id==='app_a'?'online':'offline',registeredCount:1,activeCount:1,onlineCount:id==='app_a'?1:0,lastSeenAt:at}}; }
function state() {return {applications:[project(),project('app_b')],selectedApplication:project()};}
const row=(document:Document,id='app_a')=>document.getElementById('project-card-'+id);

test('gallery keeps complete device evidence behind a closed disclosure and direct app-scoped history links',()=>{
 const document=new Document(),a=project();a.ota.android!.telemetry=telemetry();
 renderProjectRows(asDom(document),state(),[a],{status:'ready'});
 const card=row(document),details=card.children.find(n=>n.tagName==='details'&&n.className==='project-card-evidence');
 assert.ok(details,'device evidence must be available without dominating the app gallery');
 assert.equal(details.open,false);assert.ok(details.textContent.includes('다운로드 3'));assert.ok(details.textContent.includes('네트워크 연결 실패'));
 const footer=card.children.find(n=>n.className==='project-card-footer');assert.ok(footer);
 assert.ok(footer.children.some(n=>n.getAttribute('href')==='/apps/app_a/ota'));
 assert.ok(!footer.textContent.includes('deploy_app_a'));
});

test('gallery accepts only installation-owned local icons for the matching repository',()=>{
 const document=new Document(),a=project();
 for(const icon of ['/project-icons/isso.png','https://tracker.invalid/icon.png','//tracker.invalid/icon.png','/project-icons/../auth.png','data:image/svg+xml,<svg/>']){
  renderProjectRows(asDom(document),state(),[a],{status:'ready',branding:{'uulab-official/isso':icon}} as any);
  const icons=allDescendants(row(document)).filter(n=>n.tagName==='img');
  assert.equal(icons.length,icon==='/project-icons/isso.png'?1:0,icon);
  if(icons.length)assert.equal(icons[0]!.getAttribute('src'),icon);
  assert.equal(allDescendants(row(document,'app_b')).filter(n=>n.tagName==='img').length,0);
 }
});
function allDescendants(value:Element):Element[]{return value.children.flatMap(n=>[n,...allDescendants(n)]);}

test('Cloudflare quota is a closed infrastructure disclosure after the app gallery and keeps its measurement warning',()=>{
 const document=new Document();renderWorkspaceStatus(asDom(document),{projects:[project()],observedAt:at,usage:usage('stale')});
 const quota=document.getElementById('workspace-infrastructure').firstElementChild;
 assert.equal(quota?.tagName,'details');assert.equal(quota?.open,false);
 assert.match(quota?.firstElementChild?.textContent??'',/Cloudflare 인프라/);
 assert.ok(quota?.textContent.includes('이전 측정값'));assert.ok(quota?.textContent.includes('1,250,000'));
 assert.ok(!document.getElementById('workspace-status').textContent.includes('5,000,000'));
 quota!.open=true;renderWorkspaceStatus(asDom(document),{projects:[project()],observedAt:at,usage:usage('stale')});
 assert.equal(document.getElementById('workspace-infrastructure').firstElementChild?.open,true);
 const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 assert.ok(html.indexOf('id="workspace-infrastructure"')>html.indexOf('id="project-list"'));
});

test('project rows show scoped repositories, per-platform OTA channels and Runner states without exposing UUID labels',()=>{const document=new Document();renderProjectRows(asDom(document),state(),{projects:[project(),project('app_b')],observedAt:at},{status:'ready'});const first=row(document),second=row(document,'app_b');for(const value of ['Isso','uulab-official/isso','verification','android-qa','iOS','Android','온라인'])assert.ok(first.textContent.includes(value),value);for(const value of ['Promise','uulab-official/promise','production','오프라인'])assert.ok(second.textContent.includes(value),value);assert.ok(!first.textContent.includes('deploy_app_a'));assert.ok(!second.textContent.includes('android-qa'));assert.equal(first.getAttribute('data-select-application'),'app_a');assert.ok(second.textContent.includes('게시')||second.textContent.includes('없음'));});

test('project search matches repositories and channels rather than opaque app IDs',()=>{const document=new Document();for(const [query,wanted,unwanted] of [['uulab-official/promise','app_b','app_a'],['android-qa','app_a','app_b']] as const){document.getElementById('project-search').value=query;renderProjectRows(asDom(document),state(),[project(),project('app_b')],{status:'ready'});assert.ok(document.getElementById('project-list').textContent.includes(wanted==='app_a'?'Isso':'Promise'));assert.ok(!document.getElementById('project-list').textContent.includes(unwanted==='app_a'?'Isso':'Promise'));}document.getElementById('project-search').value='app_a';renderProjectRows(asDom(document),state(),[project(),project('app_b')],{status:'ready'});assert.ok(!document.getElementById('project-list').textContent.includes('Isso'));});

test('missing project summary is unknown rather than a false absent OTA or Runner claim',()=>{const document=new Document();renderProjectRows(asDom(document),state(),null,{status:'error'});const text=row(document).textContent;assert.match(text,/확인|불러오|알 수|미확인/);assert.ok(!text.includes('Runner 없음'));assert.ok(!text.includes('게시 없음'));assert.ok(!text.includes('온라인'));});

test('failed summary refresh retains known platform values with a stale snapshot notice',()=>{const document=new Document();const summary={projects:[project(),project('app_b')],observedAt:at};renderProjectRows(asDom(document),state(),summary,{status:'ready'});renderProjectRows(asDom(document),state(),summary,{status:'error'});const text=row(document).textContent;assert.ok(text.includes('verification'));assert.ok(text.includes('android-qa'));assert.match(text,/이전|마지막|갱신|현재|다시|확인/);assert.ok(row(document).querySelectorAll('[class="project-row-snapshot-note"]').length||row(document).children.some(n=>n.className.includes('project-row-snapshot-note')));});

test('operational overview is app scoped and renders plain names instead of leading with hashes',()=>{const document=new Document();renderOperationalOverview(asDom(document),project(),{summary:project(),status:'ready'});const text=document.getElementById('project-readiness').textContent;for(const value of ['uulab-official/isso','verification','Android','iOS'])assert.ok(text.includes(value),value);assert.ok(!text.includes('uulab-official/promise'));});

test('technical IDs and hashes remain available only inside initially collapsed disclosures',()=>{const document=new Document();const id='b877e6bc-902e-487b-985d-82f179f9ad64',sha='a'.repeat(64);const details=technicalDetails(asDom(document),[['배포 ID',id],['SHA-256',sha]]);assert.equal(details.tagName,'details');assert.equal(details.open,false);assert.ok(details.textContent.includes(id));assert.ok(details.textContent.includes(sha));const summary=details.firstElementChild;assert.ok(summary);assert.ok(!summary.textContent?.includes(sha));});

test('compact OTA history preserves full troubleshooting data and safe launch download separately from its summary',()=>{const document=new Document();const id='b877e6bc-902e-487b-985d-82f179f9ad64',sha='a'.repeat(40),digest='b'.repeat(64);renderCompactOtaHistory(asDom(document),'app_a',[{id,appId:'app_a',channel:'verification',platform:'android',runtimeVersion:'runtime_app_a',createdAt:at,commitSha:sha,launchAsset:{id:'asset_'+digest,digest},assets:[]}]);const container=document.getElementById('ota-history');assert.ok(container.textContent.includes('verification'));const details=container.querySelectorAll('details[data-technical]');const allDetails=details.length?details:container.children.flatMap(n=>n.children.filter(c=>c.tagName==='details'));assert.ok(allDetails.length);const technical=allDetails[0];assert.ok(technical);assert.equal(technical.open,false);assert.ok(technical.textContent.includes(id));assert.ok(technical.textContent.includes(sha));const links=container.children.flatMap(n=>n.children).filter(n=>n.tagName==='a');assert.ok(links.some(n=>(n as any).href==='/updates/app_a/assets/'+digest||n.getAttribute('href')==='/updates/app_a/assets/'+digest));});

test('overview rejects foreign summary and detection runtime instead of mixing application evidence',()=>{const document=new Document();const connection={appId:'app_b',version:1,owner:'uulab-official',repository:'promise',ref:'main'};renderOperationalOverview(asDom(document),project(),{summary:project('app_b'),operations:{connection,detections:[{appId:'app_b',connection,framework:'expo',runtimeVersion:'PRIVATE_FOREIGN_RUNTIME',commitSha:'b'.repeat(40)}],deployments:[]},status:'ready'});const text=document.getElementById('project-readiness').textContent;assert.ok(!text.includes('uulab-official/promise'));assert.ok(!text.includes('PRIVATE_FOREIGN_RUNTIME'));});

test('compact automatic jobs retain app-scoped cancel and loaded detail controls while collapsing identifiers',()=>{const document=new Document();const job={id:'job_private_uuid',appId:'app_a',platform:'android',channel:'verification',runtimeVersion:'runtime_app_a',state:'queued',attemptCount:1,createdAt:at,updatedAt:at,commitSha:'a'.repeat(40)};const state={jobs:[job,{...job,id:'foreign_job',appId:'app_b',channel:'PRIVATE_FOREIGN_CHANNEL'}]};renderCompactAutomationJobs(asDom(document),'app_a',state);const target=document.getElementById('automation-history');assert.ok(!target.textContent.includes('PRIVATE_FOREIGN_CHANNEL'));const row=target.children[0];assert.ok(row);assert.ok(row.children.some(n=>n.getAttribute('data-cancel-automation')===job.id));const detail=row.children.find(n=>n.getAttribute('data-job')===job.id);assert.ok(detail);detail.open=true;const events=detail.children[1];assert.ok(events);events.textContent='verified safe event';renderCompactAutomationJobs(asDom(document),'app_a',state);const updatedRow=target.children[0];assert.ok(updatedRow);const retained=updatedRow.children.find(n=>n.getAttribute('data-job')===job.id);assert.equal(retained,detail);assert.ok(retained);assert.equal(retained.open,true);assert.ok(retained.textContent.includes('verified safe event'));const technical=updatedRow.children.find(n=>n.tagName==='details'&&!n.getAttribute('data-job'));assert.ok(technical);assert.equal(technical.open,false);assert.ok(technical.textContent.includes(job.id));assert.ok(technical.textContent.includes(job.commitSha));});

test('unavailable automatic job history does not claim there are no jobs',()=>{const document=new Document();renderCompactAutomationJobs(asDom(document),'app_a',null,{status:'error'});const text=document.getElementById('automation-history').textContent;assert.match(text,/불러오지|미확인/);assert.ok(!text.includes('자동 작업 없음'));});

test('operations metadata without a fetched deployment array cannot prove latest OTA absence',()=>{const document=new Document();renderOperationalOverview(asDom(document),project(),{operations:{connection:{appId:'app_a',owner:'uulab-official',repository:'isso',ref:'main',version:1},detections:[]},status:'ready'});const text=document.getElementById('project-readiness').textContent;assert.match(text,/iOS 최근 OTA 게시게시 상태 미확인/);assert.match(text,/Android 최근 OTA 게시게시 상태 미확인/);assert.ok(!text.includes('게시 이력 없음'));});

test('foreign operations cannot prove another app has an empty deployment history',()=>{const document=new Document();renderOperationalOverview(asDom(document),project(),{operations:{connection:{appId:'app_b',owner:'uulab-official',repository:'promise',ref:'main',version:1},detections:[],deployments:[]},status:'ready'});const text=document.getElementById('project-readiness').textContent;assert.ok(!text.includes('uulab-official/promise'));assert.match(text,/iOS 최근 OTA 게시게시 상태 미확인/);assert.ok(!text.includes('게시 이력 없음'));});

function usage(status: 'ready'|'stale'|'pending'|'error'|'unconfigured' = 'ready') { return {status,source:'cloudflare-graphql' as const,scope:'account' as const,day:'2030-03-17',rowsRead:1_250_000,rowsWritten:25_000,readLimit:5_000_000 as const,writeLimit:100_000 as const,resetAt:at+86_400_000,observedAt:at,freshUntil:at+300_000}; }
function verification(environment: 'android-emulator'|'ios-simulator'|'physical-device'='android-emulator') {return {source:'operator-verification' as const,environment,observedAt:at,applied:true,restarted:true,signatureVerified:true,assetsVerified:true,receiptDigest:'c'.repeat(64)};}
test('workspace summary shows account-wide D1 read/write quota, sample day and reset independently of app counts',()=>{const document=new Document();renderWorkspaceStatus(asDom(document),{projects:[project(),project('app_b')],observedAt:at,usage:usage()});const target=document.getElementById('workspace-infrastructure');for(const text of ['등록 프로젝트','최근 OTA 게시','PC Runner 온라인 앱','계정 전체','1,250,000 / 5,000,000','25,000 / 100,000','25.0%','2030-03-17 UTC','일일 초기화','측정 시각','KST'])assert.ok(workspaceText(document).includes(text),text);const progress=target.children.flatMap(n=>n.children.flatMap(c=>c.children.flatMap(m=>m.children))).filter(n=>n.tagName==='progress');assert.equal(progress.length,2);assert.equal(progress[0]?.getAttribute('value'),'1250000');assert.equal(progress[1]?.getAttribute('max'),'100000');});
test('empty workspace is distinct from unavailable account usage and nullable counts never render as zero',()=>{const document=new Document();renderWorkspaceStatus(asDom(document),{projects:[],observedAt:at,usage:{...usage(),rowsRead:null,rowsWritten:null}});let text=workspaceText(document);assert.ok(text.includes('등록 프로젝트0개'));assert.ok(text.includes('사용량 미확인'));assert.ok(!text.includes('0 / 5,000,000'));renderWorkspaceStatus(asDom(document),null,{status:'loading'});text=workspaceText(document);assert.ok(text.includes('등록 프로젝트미확인'));assert.ok(text.includes('조회 대기'));assert.ok(!text.includes('등록 프로젝트0개'));});
test('stale quota retains measured numbers and warns that remaining quota is not current',()=>{const document=new Document();renderWorkspaceStatus(asDom(document),{projects:[project()],observedAt:at,usage:usage('stale')});const text=workspaceText(document);assert.ok(text.includes('1,250,000'));assert.ok(text.includes('이전 측정값'));assert.ok(text.includes('실제 남은 한도와 다를 수'));});
test('wrong-scope, pending and failed usage do not expose measurements as current remaining quota',()=>{const document=new Document();for(const value of [{...usage(),scope:'application'},usage('pending'),usage('error'),usage('unconfigured')]){renderWorkspaceStatus(asDom(document),{projects:[],observedAt:at,usage:value as any});const text=workspaceText(document);assert.ok(text.includes('사용량 미확인'));assert.ok(!text.includes('1,250,000'));assert.ok(!text.includes('3,750,000 남음'));}});
test('platform operator evidence explicitly names environment and never claims user adoption',()=>{const document=new Document();const verified=project();verified.ota.android!.verification=verification();renderProjectRows(asDom(document),state(),[verified],{status:'ready'});const text=row(document).textContent;assert.ok(text.includes('Android 에뮬레이터 · 적용·재시작 검증'));assert.ok(text.includes('운영자 검증'));assert.ok(text.includes('사용자 적용 보고 미수집'));assert.ok(text.includes('적용 검증 미확인'));assert.ok(!text.includes('c'.repeat(64)));assert.ok(!text.includes('사용자 적용 완료'));});
test('foreign deployment binding, mismatched platform, failed signature or absent receipt cannot become verified application',()=>{const document=new Document();for(const evidence of [{...verification(),deploymentId:'other_deployment'},{...verification(),appId:'app_b'},verification('ios-simulator'),{...verification(),signatureVerified:false},{...verification(),receiptDigest:''}]){const app=project();app.ota.android!.verification=evidence;renderProjectRows(asDom(document),state(),[app],{status:'ready'});const text=row(document).textContent;assert.ok(!text.includes('적용·재시작 검증'));assert.ok(text.includes('적용 검증 미확인')||text.includes('적용 검증 미완료'));assert.ok(text.includes('사용자 적용 보고 미수집'));}});

test('expired or failed cached Runner presence stays unconfirmed across rows, overview and workspace count',()=>{
 const document=new Document(),summary={projects:[project()],observedAt:at};
 for(const options of[{status:'ready' as const,now:at+120001,observedAt:at},{status:'error' as const,now:at,observedAt:at}]){
  renderProjectRows(asDom(document),state(),summary,options);assert.ok(row(document).textContent.includes('현재 연결 미확인'));assert.ok(!row(document).textContent.includes('온라인'));
  renderOperationalOverview(asDom(document),project(),{summary:project(),...options});assert.ok(document.getElementById('project-readiness').textContent.includes('현재 연결 미확인'));
  renderWorkspaceStatus(asDom(document),summary,options);assert.ok(workspaceText(document).includes('PC Runner 온라인 앱미확인'));
 }
});
test('previous-day account measurements never display current remaining quota',()=>{
 const document=new Document();renderWorkspaceStatus(asDom(document),{projects:[project()],observedAt:at,usage:{...usage(),day:'2030-01-01',collectedBy:'pc-runner'}},{status:'ready',now:at,observedAt:at});
 const text=workspaceText(document);assert.ok(text.includes('이전 측정값'));assert.ok(text.includes('현재 남은 한도 미확인'));assert.ok(!text.includes('3,750,000 남음'));assert.ok(text.includes('PC Runner가 조회한 Cloudflare 계정 지표 · 10분 간격'));
});

function telemetry() { return {source:'sdk-self-report' as const,observedInstallations:4,downloadedInstallations:3,appliedInstallations:2,restartedInstallations:1,failedInstallations:1,rolledBackInstallations:0,applicationRate:50,lastReportedAt:at,environments:{physicalDevice:3,androidEmulator:1,iosSimulator:0,unknown:0},failures:[{stage:'download' as const,code:'NETWORK_UNAVAILABLE',installations:1,lastReportedAt:at}]}; }
test('SDK installation denominator, environment and failures remain scoped to the app and separate from operator proof',()=>{const document=new Document();const a=project();a.ota.android!.telemetry=telemetry();a.ota.android!.verification=verification();renderProjectRows(asDom(document),state(),[a,project('app_b')],{status:'ready'});const text=row(document).textContent;for(const value of ['SDK 보고 설치 기준 누적 적용률 50.0%','보고 4','다운로드 3','적용 2','재시작 1','일반 실패 보고 1','네이티브 자동 복구 0','실기기 3','Android 에뮬레이터 1','운영자 검증'])assert.ok(text.includes(value),value);assert.ok(!row(document,'app_b').textContent.includes('50.0%'));renderOperationalOverview(asDom(document),a,{summary:a,status:'ready'});assert.match(document.getElementById('project-readiness').textContent,/다운로드.*네트워크/);assert.ok(document.getElementById('project-readiness').textContent.includes('전체 설치 기기 수와 다름'));});
test('missing, empty and malformed SDK reports never invent a rate or render unsafe failure text',()=>{const document=new Document();for(const value of [undefined,null,{...telemetry(),observedInstallations:0,downloadedInstallations:0,appliedInstallations:0,restartedInstallations:0,failedInstallations:0,applicationRate:null,environments:{physicalDevice:0,androidEmulator:0,iosSimulator:0,unknown:0},failures:[]},{...telemetry(),appliedInstallations:5},{...telemetry(),applicationRate:100},{...telemetry(),environments:{physicalDevice:3,androidEmulator:0,iosSimulator:1,unknown:0}},{...telemetry(),failures:[{stage:'download',code:'PRIVATE_RAW_ERROR_SECRET',installations:1,lastReportedAt:at}]}]){const a=project();a.ota.android!.telemetry=value as any;renderProjectRows(asDom(document),state(),[a],{status:'ready'});const text=row(document).textContent;assert.ok(!text.includes('SDK 보고 설치 기준 누적 적용률 0.0%'));assert.ok(!text.includes('SDK 보고 설치 기준 누적 적용률 100.0%'));assert.ok(!text.includes('PRIVATE_RAW_ERROR_SECRET'));assert.match(text,/보고 미수집|적용률 미확인/);}});

test('all bounded failure combinations keep existing SDK success counts visible',()=>{
 const document=new Document(),a=project(),value=telemetry();const codes=['NETWORK_UNAVAILABLE','TIMEOUT','SIGNATURE_INVALID','ASSET_HASH_MISMATCH','UPDATE_INCOMPATIBLE','UNCONFIRMED_LAUNCH','STORED_UPDATE_INVALID','NATIVE_OPERATION_FAILED','CHECK_FAILED','DOWNLOAD_FAILED','ACTIVATION_FAILED','LAUNCH_CONFIRMATION_FAILED','UNKNOWN'];
 value.failures=['check','download','activation','launch'].flatMap(stage=>codes.map(code=>({stage,code,installations:1,lastReportedAt:at}))) as typeof value.failures;a.ota.android!.telemetry=value;renderProjectRows(asDom(document),state(),[a],{status:'ready'});assert.ok(row(document).textContent.includes('누적 적용률 50.0%'));assert.ok(row(document).textContent.includes('추가 실패 원인 51개'));
});

test('recovery is shown only with bounded success and prior failure evidence',()=>{
 const document=new Document(),a=project();
 a.ota.android!.telemetry={...telemetry(),recoveredInstallations:1};renderProjectRows(asDom(document),state(),[a],{status:'ready'});assert.ok(row(document).textContent.includes('실패 후 적용·재시작 확인 1개 설치'));assert.ok(row(document).textContent.includes('네트워크 연결 실패'));
 for(const recoveredInstallations of[-1,2,Number.MAX_SAFE_INTEGER+1]){a.ota.android!.telemetry={...telemetry(),recoveredInstallations};renderProjectRows(asDom(document),state(),[a],{status:'ready'});assert.ok(!row(document).textContent.includes('실패 후 적용·재시작 확인'));}
});

test('historical deployment shows every retained failure and recovery only on its own row',()=>{
 const document=new Document(),oldReport={...telemetry(),observedInstallations:1,downloadedInstallations:1,appliedInstallations:1,restartedInstallations:1,failedInstallations:1,recoveredInstallations:1,applicationRate:100,environments:{physicalDevice:0,androidEmulator:1,iosSimulator:0,unknown:0},failures:[{stage:'download',code:'NETWORK_UNAVAILABLE',installations:1,lastReportedAt:at},{stage:'download',code:'NATIVE_OPERATION_FAILED',installations:1,lastReportedAt:at}]};
 const base={appId:'app_a',channel:'verification',platform:'android',runtimeVersion:'runtime_app_a',createdAt:at,commitSha:'a'.repeat(40),assets:[]};
 renderCompactOtaHistory(asDom(document),'app_a',[{...base,id:'newer'},{...base,id:'older',telemetry:oldReport},{...base,id:'foreign',appId:'app_b',channel:'FOREIGN_HISTORY',telemetry:oldReport}]);
 const rows=document.getElementById('ota-history').children;assert.equal(rows.length,2);
 assert.ok(rows[0]!.textContent.includes('사용자 적용 보고 미수집'));assert.ok(!rows[0]!.textContent.includes('실패 후 적용·재시작 확인'));
 for(const text of['누적 적용률 100.0%','일반 실패 보고 1','실패 후 적용·재시작 확인 1개 설치','네트워크 연결 실패','네이티브 엔진 작업 실패'])assert.ok(rows[1]!.textContent.includes(text),text);
 assert.ok(!rows[1]!.textContent.includes('추가 실패 원인'));assert.ok(!rows.some(row=>row.textContent.includes('FOREIGN_HISTORY')));
});

test('operator rollback history links restored source and superseded deployment within the same app',()=>{
 const document=new Document(),id='b877e6bc-902e-487b-985d-82f179f9ad64',from='a877e6bc-902e-487b-985d-82f179f9ad64',target='c877e6bc-902e-487b-985d-82f179f9ad64';
 renderCompactOtaHistory(document as any,'app_a',[{id,appId:'app_a',platform:'android',channel:'qa',runtimeVersion:'v1',createdAt:at,commitSha:'a'.repeat(40),rollback:{fromDeploymentId:from,targetDeploymentId:target,reason:'시작 화면 복구',requestedAt:at-1000}}]);
 const root=document.getElementById('ota-history');assert.match(root.textContent,/관리자 롤백/);assert.match(root.textContent,/시작 화면 복구/);const links=root.querySelectorAll('a[data-deployment-path]');assert.deepEqual(links.map(link=>link.getAttribute('href')),['/apps/app_a/ota/'+from,'/apps/app_a/ota/'+target,'/apps/app_a/ota/'+id]);assert.ok(!root.textContent.includes('자동 롤백 성공'));
});

test('policy driven rollback history shows measured failure ratio separately from operator and native recovery',()=>{
 const document=new Document(),id='b877e6bc-902e-487b-985d-82f179f9ad64',from='a877e6bc-902e-487b-985d-82f179f9ad64',target='c877e6bc-902e-487b-985d-82f179f9ad64';
 const automaticRollback={id:'auto_rollback_test',appId:'app_a',sourceDeploymentId:from,targetDeploymentId:target,rollbackDeploymentId:id,platform:'android',channel:'qa',runtimeVersion:'v1',policyVersion:1,status:'succeeded',attemptedInstallations:20,failedInstallations:3,failureRatePercent:15,triggeredAt:at,updatedAt:at,lastErrorCode:null,reason:'실패율 기준 도달'};
 const value={id,appId:'app_a',platform:'android',channel:'qa',runtimeVersion:'v1',createdAt:at,commitSha:'a'.repeat(40),rollback:{fromDeploymentId:from,targetDeploymentId:target,reason:'실패율 기준 도달',requestedAt:at-1000},automaticRollback};
 renderCompactOtaHistory(document as any,'app_a',[value]);const root=document.getElementById('ota-history');assert.match(root.textContent,/실패율 기준 자동 롤백/);assert.match(root.textContent,/실패 3 \/ 20/);assert.ok(!root.textContent.includes('관리자 롤백'));
 renderCompactOtaHistory(document as any,'app_a',[{...value,automaticRollback:{...automaticRollback,appId:'app_b'}}]);assert.ok(!root.textContent.includes('자동 롤백 감지'));assert.match(root.textContent,/관리자 롤백/);
});

function cancelledDeployment() {
 const id='a877e6bc-902e-487b-985d-82f179f9ad64';
 return {id,appId:'app_a',platform:'android',channel:'qa',runtimeVersion:'v1',createdAt:at,commitSha:'a'.repeat(40),automaticRollback:{id:'auto_rollback_cancelled',appId:'app_a',sourceDeploymentId:id,targetDeploymentId:'c877e6bc-902e-487b-985d-82f179f9ad64',rollbackDeploymentId:null,platform:'android',channel:'qa',runtimeVersion:'v1',policyVersion:1,status:'skipped',attemptedInstallations:1,failedInstallations:1,failureRatePercent:100,triggeredAt:at-120000,updatedAt:at,lastErrorCode:'AUTO_ROLLBACK_RECOVERED',reason:'최초 실패 기준 도달',confirmationDelaySeconds:120,cancellation:{checkedAt:at,attemptedInstallations:2,failedInstallations:1,confirmedHealthyInstallations:1,failureRatePercent:50}}};
}
test('native fallback without failure event or same-installation recovery stays distinct across operational summaries',()=>{
 const document=new Document(),app=project();app.ota.android!.telemetry={...telemetry(),observedInstallations:2,downloadedInstallations:2,appliedInstallations:1,restartedInstallations:1,failedInstallations:0,rolledBackInstallations:1,recoveredInstallations:0,applicationRate:50,environments:{physicalDevice:0,androidEmulator:2,iosSimulator:0,unknown:0},failures:[]};
 renderProjectRows(asDom(document),state(),[app,project('app_b')]);
 renderOperationalOverview(asDom(document),app,{summary:app});
 renderCompactOtaHistory(asDom(document),'app_a',[{...cancelledDeployment(),telemetry:app.ota.android!.telemetry}]);
 for(const text of[row(document).textContent,document.getElementById('project-readiness').textContent,document.getElementById('ota-history').textContent]){
  for(const expected of['일반 실패 보고 0','네이티브 자동 복구 1','동일 설치 실패 후 적용·재시작 확인 0개 설치','서로 겹칠 수 있어 합산하지 않습니다'])assert.ok(text.includes(expected),expected);
  assert.ok(!text.includes('일반 실패 보고 1'));assert.ok(!text.includes('동일 설치 실패 후 적용·재시작 확인 1개 설치'));
 }
 assert.ok(!row(document,'app_b').textContent.includes('네이티브 자동 복구 1'));
});
test('cancelled automatic rollback distinguishes original trigger from checked cohort and independent healthy evidence',()=>{
 const document=new Document(),value=cancelledDeployment();renderCompactOtaHistory(asDom(document),'app_a',[value]);const text=document.getElementById('ota-history').textContent;
 for(const expected of['실패 기준 미충족으로 취소','최초 감지 · 실패 1 / 1개 설치 · 100.0%','취소 시 재확인 · 실패 1 / 2개 설치 · 50.0%','동일 배포 정상 실행 확인 1개','최초 실패 설치의 회복을 뜻하지 않습니다'])assert.ok(text.includes(expected),expected);
 assert.ok(!text.includes('실행 건너뜀'));assert.ok(!text.includes('복구 배포 게시됨'));
});
test('legacy cancellation and zero healthy reports do not invent device recovery',()=>{
 const document=new Document(),base=cancelledDeployment();
 const legacy={...base,automaticRollback:{...base.automaticRollback,cancellation:undefined}};
 renderCompactOtaHistory(asDom(document),'app_a',[legacy]);let text=document.getElementById('ota-history').textContent;
 assert.ok(text.includes('실패 기준 미충족으로 취소'));assert.ok(!text.includes('취소 시 재확인 · 실패'));assert.ok(text.includes('재확인 수치는 기록되지 않았습니다'));assert.ok(!text.includes('정상 실행 확인 1개'));
 renderCompactOtaHistory(asDom(document),'app_a',[{...base,automaticRollback:{...base.automaticRollback,cancellation:{...base.automaticRollback.cancellation,confirmedHealthyInstallations:0}}}]);text=document.getElementById('ota-history').textContent;
 assert.ok(text.includes('동일 배포 정상 실행 확인 0개'));assert.ok(!text.includes('동일 배포 정상 실행 확인 1개'));
});
test('invalid cancellation and foreign scope cannot produce cancellation or healthy cohort claims',()=>{
 const document=new Document(),base=cancelledDeployment(),d=base.automaticRollback;
 for(const decision of[{...d,appId:'app_b'},{...d,platform:'ios'},{...d,channel:'foreign'},{...d,runtimeVersion:'foreign'},{...d,sourceDeploymentId:'b877e6bc-902e-487b-985d-82f179f9ad64'},{...d,cancellation:{checkedAt:at,attemptedInstallations:2}},{...d,cancellation:{...d.cancellation,confirmedHealthyInstallations:2}},{...d,cancellation:{...d.cancellation,failureRatePercent:100}},{...d,status:'queued'}]){
  renderCompactOtaHistory(asDom(document),'app_a',[{...base,automaticRollback:decision}]);const text=document.getElementById('ota-history').textContent;
  assert.ok(!text.includes('실패 기준 미충족으로 취소'));assert.ok(!text.includes('취소 시 재확인 · 실패'));assert.ok(!text.includes('정상 실행 확인 1개'));
 }
 renderCompactOtaHistory(asDom(document),'app_a',[{...base,automaticRollback:{...d,lastErrorCode:'AUTO_ROLLBACK_POLICY_CHANGED',cancellation:undefined}}]);assert.ok(document.getElementById('ota-history').textContent.includes('실행 건너뜀'));assert.ok(!document.getElementById('ota-history').textContent.includes('실패 기준 미충족으로 취소'));
});

test('overlapping cumulative failure and native fallback reports are never added into a failure total',()=>{
 const document=new Document(),app=project();app.ota.android!.telemetry={...telemetry(),observedInstallations:1,downloadedInstallations:1,appliedInstallations:1,restartedInstallations:1,failedInstallations:1,rolledBackInstallations:1,recoveredInstallations:1,applicationRate:100,environments:{physicalDevice:0,androidEmulator:1,iosSimulator:0,unknown:0}};
 renderProjectRows(asDom(document),state(),[app]);const text=row(document).textContent;
 for(const expected of['보고 1','일반 실패 보고 1','네이티브 자동 복구 1','동일 설치 실패 후 적용·재시작 확인 1개 설치','서로 겹칠 수 있어 합산하지 않습니다'])assert.ok(text.includes(expected),expected);
 assert.ok(!text.includes('실패 보고 2'));
 app.ota.android!.telemetry={...telemetry()};renderProjectRows(asDom(document),state(),[app]);assert.ok(row(document).textContent.includes('동일 설치 복구 미확인'));assert.ok(!row(document).textContent.includes('동일 설치 실패 후 적용·재시작 확인 0개 설치'));
});

const issueDeploymentId='b877e6bc-902e-487b-985d-82f179f9ad64';
function attentionDocument(filter='all',query='') { const document=new Document(); for(const id of ['project-status-filter','project-filter-status'])if(!document.nodes.has(id)){const n=new Element();n.id=id;document.nodes.set(id,n);}document.getElementById('project-status-filter').value=filter;document.getElementById('project-search').value=query;return document; }
function nativeIssueProject() {const app=project(); app.ota.android!.id=issueDeploymentId;app.ota.android!.telemetry={...telemetry(),failedInstallations:0,rolledBackInstallations:1,recoveredInstallations:0,failures:[],issueResolution:{unresolvedInstallations:1,resolvedInstallations:0,unknownInstallations:0}};return app;}
test('project attention uses last unresolved issue state rather than cumulative recovery flags',()=>{
 const document=attentionDocument('ota'),app=nativeIssueProject();renderProjectRows(asDom(document),state(),[app,project('app_b')]);let text=row(document).textContent;assert.ok(text.includes('OTA 미복구 문제'));assert.ok(text.includes('미복구 1개 설치'));assert.ok(!document.getElementById('project-list').textContent.includes('Promise'));
 app.ota.android!.telemetry={...telemetry(),recoveredInstallations:1,issueResolution:{unresolvedInstallations:0,resolvedInstallations:1,unknownInstallations:0}};
 renderProjectRows(asDom(document),state(),[app]);assert.match(document.getElementById('project-filter-status').textContent,/0.*2/);
 document.getElementById('project-status-filter').value='resolved';renderProjectRows(asDom(document),state(),[app]);text=row(document).textContent;assert.ok(text.includes('OTA 해결됨'));assert.ok(text.includes('동일 설치 실패 후 적용·재시작 확인 1개 설치'));assert.ok(!text.includes('OTA 미복구 문제'));
 // A later relapse remains unresolved even though recoveredInstallations is cumulative and sticky.
 app.ota.android!.telemetry.issueResolution={unresolvedInstallations:1,resolvedInstallations:0,unknownInstallations:0};
 document.getElementById('project-status-filter').value='ota';renderProjectRows(asDom(document),state(),[app]);assert.ok(row(document).textContent.includes('OTA 미복구 문제'));
 document.getElementById('project-status-filter').value='resolved';renderProjectRows(asDom(document),state(),[app]);assert.match(document.getElementById('project-filter-status').textContent,/0.*2/);
});
test('project issue links are scoped real anchors outside buttons and name remains selected overview control',()=>{
 const document=attentionDocument(),app=nativeIssueProject();renderProjectRows(asDom(document),state(),[app]);const outer=row(document);assert.equal(outer.tagName,'article');assert.equal(outer.getAttribute('data-selected'),'true');assert.equal(outer.getAttribute('aria-pressed'),null);const identity=outer.querySelectorAll('button[data-select-application]')[0]!;assert.equal(identity.getAttribute('aria-pressed'),'true');assert.equal(identity.getAttribute('aria-label'),'Isso 앱 개요');assert.equal(identity.querySelectorAll('a[data-project-issue]').length,0);
 const links=outer.querySelectorAll('a[data-project-issue]');assert.deepEqual(links.map(n=>[n.textContent,n.getAttribute('href')]),[['Android 문제 배포','/apps/app_a/ota/'+issueDeploymentId],['Android 미복구 기기 이력','/apps/app_a/ota/'+issueDeploymentId+'/unresolved']]);for(const link of links)assert.equal(link.getAttribute('href'),link.getAttribute('data-project-path'));
});
test('project status filter combines search and reports matching count against total without any IO',()=>{
 const document=attentionDocument('attention','promise');renderProjectRows(asDom(document),state(),[nativeIssueProject(),project('app_b')]);assert.equal(document.getElementById('project-list').children.length,1);assert.ok(document.getElementById('project-list').textContent.includes('Promise'));assert.match(document.getElementById('project-filter-status').textContent,/1.*2/);
 document.getElementById('project-status-filter').value='ota';renderProjectRows(asDom(document),state(),[nativeIssueProject(),project('app_b')]);assert.match(document.getElementById('project-filter-status').textContent,/0.*2/);assert.match(document.getElementById('project-list').textContent,/조건/);assert.equal(document.getElementById('project-total').textContent,'2개 프로젝트');
});
test('fresh enabled Runner problems include revoked while stale snapshots are unknown rather than offline',()=>{
 for(const runnerStatus of ['offline','unseen','unregistered','revoked'] as const){const app=project();app.runner.status=runnerStatus;const document=attentionDocument('runner');renderProjectRows(asDom(document),{applications:[app]},[app],{status:'ready',now:at,observedAt:at});assert.ok(row(document).textContent.includes('Runner 확인 필요'));assert.equal(row(document).querySelectorAll('a[data-project-issue]')[0]!.getAttribute('href'),'/apps/app_a/runners');
 document.getElementById('project-status-filter').value='unknown';renderProjectRows(asDom(document),{applications:[app]},[app],{status:'ready',now:at+120001,observedAt:at});assert.ok(row(document).textContent.includes('운영 상태 미확인'));assert.ok(!row(document).textContent.includes('Runner 확인 필요'));assert.ok(!row(document).textContent.includes('오프라인'));
 app.automation!.enabled=false;document.getElementById('project-status-filter').value='runner';renderProjectRows(asDom(document),{applications:[app]},[app],{status:'ready'});assert.match(document.getElementById('project-filter-status').textContent,/0.*1/);}
});
test('stale retained OTA problems remain navigable alongside unknown operational freshness',()=>{
 const document=attentionDocument('ota'),app=nativeIssueProject();renderProjectRows(asDom(document),state(),[app],{status:'error',now:at,observedAt:at});assert.ok(row(document).textContent.includes('OTA 미복구 문제'));assert.ok(row(document).textContent.includes('운영 상태 미확인'));assert.equal(row(document).querySelectorAll('a[data-project-issue]').length,2);
 document.getElementById('project-status-filter').value='unknown';renderProjectRows(asDom(document),state(),[app],{status:'loading'});assert.ok(row(document).textContent.includes('운영 상태 미확인'));
});
test('malformed telemetry and deployment identity never create issue links or leak foreign summary content',()=>{
 for(const changed of [{id:'invalid'}, {appId:'app_b'}, {platform:'ios'}, {telemetry:{...telemetry(),applicationRate:100}}]){const document=attentionDocument('unknown'),app=nativeIssueProject();Object.assign(app.ota.android!,changed);renderProjectRows(asDom(document),{applications:[app]},[app]);assert.ok(row(document).textContent.includes('운영 상태 미확인'));assert.ok(!row(document).textContent.includes('OTA 미복구 문제'));assert.equal(row(document).querySelectorAll('a[data-project-issue]').length,0);}
 const document=attentionDocument('ota');renderProjectRows(asDom(document),{applications:[project()]},[nativeIssueProject(),{...project('app_b'),name:'FOREIGN_REPOSITORY'}]);assert.ok(!row(document).textContent.includes('FOREIGN_REPOSITORY'));
});

test('unknown filter handles missing reports, absent summaries and unknown Runner without treating them as failures',()=>{
 for(const summary of [null,project(),{...project(),runner:{...project().runner,status:'unknown' as const}}]){const document=attentionDocument('unknown');renderProjectRows(asDom(document),{applications:[project()]},summary?[summary]:null,{status:summary?'ready':'loading'});assert.ok(row(document).textContent.includes('운영 상태 미확인'));assert.ok(!row(document).textContent.includes('OTA 미복구 문제'));assert.ok(!row(document).textContent.includes('Runner 확인 필요'));}
 const document=attentionDocument('attention');renderProjectRows(asDom(document),{applications:[]},[]);assert.match(document.getElementById('project-filter-status').textContent,/0.*0/);assert.match(document.getElementById('project-list').textContent,/프로젝트를 등록/);
});
test('malformed app identity cannot create Runner navigation and foreign platform metadata is not presented as local OTA',()=>{
 const document=attentionDocument('unknown'),bad={...project('invalid/app')};bad.runner.status='offline';renderProjectRows(asDom(document),{applications:[bad]},[bad]);assert.ok(row(document,bad.id).textContent.includes('운영 상태 미확인'));assert.equal(row(document,bad.id).querySelectorAll('a[data-project-issue]').length,0);
 const app=nativeIssueProject();Object.assign(app.ota.android!,{appId:'app_b',channel:'FOREIGN_PRIVATE_CHANNEL'});renderProjectRows(asDom(document),{applications:[app]},[app]);assert.ok(!row(document).textContent.includes('FOREIGN_PRIVATE_CHANNEL'));assert.ok(!row(document).textContent.includes('네이티브 자동 복구 1'));
});

test('missing or malformed resolution stays unknown and never infers a current failure or recovery from cumulative counters',()=>{
 for(const resolution of [undefined,{}, {unresolvedInstallations:-1,resolvedInstallations:0,unknownInstallations:0},{unresolvedInstallations:0,resolvedInstallations:0,unknownInstallations:1},{unresolvedInstallations:1,resolvedInstallations:1,unknownInstallations:0},{unresolvedInstallations:0,resolvedInstallations:1.5,unknownInstallations:0}]) {
  const app=nativeIssueProject();app.ota.android!.telemetry!.issueResolution=resolution as any;const document=attentionDocument('unknown');renderProjectRows(asDom(document),{applications:[app]},[app]);assert.ok(row(document).textContent.includes('운영 상태 미확인'));assert.ok(row(document).textContent.includes('네이티브 자동 복구 1'));assert.equal(row(document).querySelectorAll('a[data-project-issue]').length,0);
  for(const filter of ['ota','resolved','attention']){document.getElementById('project-status-filter').value=filter;renderProjectRows(asDom(document),{applications:[app]},[app]);assert.match(document.getElementById('project-filter-status').textContent,/0.*1/);}
 }
});
test('mixed platform unresolved and resolved rows offer both scoped histories and combine resolved filter with search',()=>{
 const app=nativeIssueProject();app.ota.ios={...app.ota.android!,id:'c877e6bc-902e-487b-985d-82f179f9ad64',telemetry:{...telemetry(),environments:{physicalDevice:3,iosSimulator:1,androidEmulator:0,unknown:0},recoveredInstallations:1,issueResolution:{unresolvedInstallations:0,resolvedInstallations:1,unknownInstallations:0}}};
 const document=attentionDocument('resolved','isso');renderProjectRows(asDom(document),state(),[app,project('app_b')]);const text=row(document).textContent;assert.ok(text.includes('Android · 미복구 1개 설치'));assert.ok(text.includes('iOS · 해결됨 1개 설치'));
 const links=row(document).querySelectorAll('a[data-project-issue]');assert.ok(links.some(n=>n.getAttribute('href')==='/apps/app_a/ota/'+app.ota.ios!.id+'/resolved'));assert.ok(links.some(n=>n.getAttribute('href')==='/apps/app_a/ota/'+issueDeploymentId+'/unresolved'));
 document.getElementById('project-search').value='promise';renderProjectRows(asDom(document),state(),[app,project('app_b')]);assert.match(document.getElementById('project-filter-status').textContent,/0.*2/);
});
test('legacy issue with unknown chronology remains conservatively unresolved and explicitly uncertain',()=>{
 const app=nativeIssueProject();app.ota.android!.telemetry!.issueResolution={unresolvedInstallations:1,resolvedInstallations:0,unknownInstallations:1};const document=attentionDocument('ota');renderProjectRows(asDom(document),{applications:[app]},[app]);assert.ok(row(document).textContent.includes('이 중 복구 시점 미확인 1개'));assert.ok(row(document).textContent.includes('운영 상태 미확인'));
});
test('resolved only project leaves attention unless an independently fresh Runner problem exists',()=>{
 const app=nativeIssueProject();app.ota.android!.telemetry={...telemetry(),recoveredInstallations:1,issueResolution:{unresolvedInstallations:0,resolvedInstallations:1,unknownInstallations:0}};const document=attentionDocument('attention');renderProjectRows(asDom(document),{applications:[app]},[app]);assert.match(document.getElementById('project-filter-status').textContent,/0.*1/);
 app.runner.status='offline';renderProjectRows(asDom(document),{applications:[app]},[app]);assert.ok(row(document).textContent.includes('OTA 해결됨'));assert.ok(row(document).textContent.includes('Runner 확인 필요'));assert.ok(!row(document).textContent.includes('OTA 미복구 문제'));
});

test('resolution classification cannot hide an existing issue or claim recovery without success and restart',()=>{
 const base={...telemetry(),issueResolution:{unresolvedInstallations:1,resolvedInstallations:0,unknownInstallations:0}};assert.equal(isValidSdkIssueResolution(base),true);
 const invalid=[{...base,issueResolution:{unresolvedInstallations:0,resolvedInstallations:0,unknownInstallations:0}}, {...base,rolledBackInstallations:2}, {...base,appliedInstallations:0,issueResolution:{unresolvedInstallations:0,resolvedInstallations:1,unknownInstallations:0}}, {...base,restartedInstallations:0,issueResolution:{unresolvedInstallations:0,resolvedInstallations:1,unknownInstallations:0}}, {...base,failedInstallations:NaN}];
 for(const report of invalid)assert.equal(isValidSdkIssueResolution(report),false);
 for(const report of invalid.slice(0,4)) {const app=nativeIssueProject();app.ota.android!.telemetry=report;const document=attentionDocument('unknown');renderProjectRows(asDom(document),{applications:[app]},[app]);assert.ok(row(document).textContent.includes('운영 상태 미확인'));assert.ok(!row(document).textContent.includes('OTA 해결됨'));assert.equal(row(document).querySelectorAll('a[data-project-issue]').length,0);}
 assert.equal(isValidSdkIssueResolution({...base,failedInstallations:1,rolledBackInstallations:1}),true,'overlapping cumulative failure and fallback do not require two issue installations');
});

test('rollback resolved count validates separately from original deployment success counters',()=>{
 const source={...telemetry(),appliedInstallations:0,restartedInstallations:0,applicationRate:0,issueResolution:{unresolvedInstallations:0,resolvedInstallations:1,rollbackResolvedInstallations:1,unknownInstallations:0}};
 assert.ok(isValidSdkIssueResolution(source));
 for(const rollbackResolvedInstallations of [-1,1.5,2,NaN,null])assert.equal(isValidSdkIssueResolution({...source,issueResolution:{...source.issueResolution,rollbackResolvedInstallations}}),false);
 assert.equal(isValidSdkIssueResolution({...source,issueResolution:{...source.issueResolution,rollbackResolvedInstallations:0}}),false);
});
test('latest rollback displays linked original resolution and keeps unresolved source visible until same-install proof',()=>{
 const app=nativeIssueProject(), original=app.ota.android!.id, rollback='d877e6bc-902e-487b-985d-82f179f9ad64';
 app.ota.android={...app.ota.android!,id:rollback,telemetry:{...telemetry(),failedInstallations:0,rolledBackInstallations:0,recoveredInstallations:0,failures:[],issueResolution:{unresolvedInstallations:0,resolvedInstallations:0,unknownInstallations:0}},rollback:{fromDeploymentId:original,targetDeploymentId:'a877e6bc-902e-487b-985d-82f179f9ad64',reason:'복구',requestedAt:10},rollbackIssue:{deploymentId:original,telemetry:{...telemetry(),appliedInstallations:0,restartedInstallations:0,recoveredInstallations:0,applicationRate:0,issueResolution:{unresolvedInstallations:1,resolvedInstallations:0,unknownInstallations:0}}}};
 const document=attentionDocument('ota');renderProjectRows(asDom(document),{applications:[app]},[app]);assert.match(row(document).textContent,/OTA 미복구 문제/);
 const report=app.ota.android.rollbackIssue!.telemetry!;report.issueResolution={unresolvedInstallations:0,resolvedInstallations:1,rollbackResolvedInstallations:1,unknownInstallations:0};
 renderProjectRows(asDom(document),{applications:[app]},[app]);assert.match(document.getElementById('project-filter-status').textContent,/0.*1/);
 document.getElementById('project-status-filter').value='resolved';renderProjectRows(asDom(document),{applications:[app]},[app]);assert.match(row(document).textContent,/롤백으로 해결됨 1개/);
 const links=row(document).querySelectorAll('a[data-project-issue]');assert.ok(links.some(n=>n.getAttribute('href')==='/apps/app_a/ota/'+original+'/resolved'));assert.ok(links.some(n=>n.getAttribute('href')==='/apps/app_a/ota/'+rollback));
 app.ota.android.rollbackIssue!.deploymentId=rollback;renderProjectRows(asDom(document),{applications:[app]},[app]);assert.match(document.getElementById('project-filter-status').textContent,/0.*1/);
 document.getElementById('project-status-filter').value='unknown';renderProjectRows(asDom(document),{applications:[app]},[app]);assert.match(row(document).textContent,/운영 상태 미확인/);assert.ok(!row(document).textContent.includes('롤백으로 해결됨'));
});

test('rollback and original issue links have distinct names and scopes without combining their installation counts',()=>{
 for(const status of ['resolved','unresolved'] as const){
  const app=nativeIssueProject(),original=app.ota.android!.id,rollback='d877e6bc-902e-487b-985d-82f179f9ad64';
  const resolution={unresolvedInstallations:status==='unresolved'?1:0,resolvedInstallations:status==='resolved'?1:0,unknownInstallations:0};
  app.ota.android={...app.ota.android!,id:rollback,telemetry:{...telemetry(),issueResolution:resolution},rollback:{fromDeploymentId:original,targetDeploymentId:'a877e6bc-902e-487b-985d-82f179f9ad64',reason:'복구',requestedAt:10},rollbackIssue:{deploymentId:original,telemetry:{...telemetry(),issueResolution:{...resolution,...(status==='resolved'?{rollbackResolvedInstallations:1}:{})}}}};
  const document=attentionDocument(status==='resolved'?'resolved':'ota');renderProjectRows(asDom(document),{applications:[app]},[app]);
  const suffix=status==='resolved'?'해결된 기기 이력':'미복구 기기 이력';
  const links=row(document).querySelectorAll('a[data-project-issue]');
  for(const [label,target] of [['Android 롤백 배포의 '+suffix,rollback],['Android 원래 문제의 '+suffix,original]])assert.equal(links.find(n=>n.textContent===label)?.getAttribute('href'),'/apps/app_a/ota/'+target+'/'+status);
  assert.equal(links.filter(n=>n.textContent==='Android '+suffix).length,0);
  if(status==='unresolved')for(const [label,target] of [['Android 문제가 발생한 롤백 배포',rollback],['Android 원래 문제 배포',original]])assert.equal(links.find(n=>n.textContent===label)?.getAttribute('href'),'/apps/app_a/ota/'+target);
  assert.ok(!row(document).textContent.includes((status==='resolved'?'해결됨':'미복구')+' 2개 설치'),'separate deployment cohorts are never added');
 }
});

for(const name of ['Isso','Promise','Reward'])for(const os of ['ios','android'] as const)test(`${name} ${os} oldest original issue follows rollback relapse and re-recovery without IO`,()=>{
 const app=project('app_'+name.toLowerCase());app.name=name;app.runner.status='online';app.ota={ios:null,android:null};
 const original=issueDeploymentId, immediate='d877e6bc-902e-487b-985d-82f179f9ad64', latest='e877e6bc-902e-487b-985d-82f179f9ad64';
 const nativeTelemetry={...telemetry(),environments:{physicalDevice:4,androidEmulator:0,iosSimulator:0,unknown:0}};
 const source={...nativeTelemetry,appliedInstallations:0,restartedInstallations:0,applicationRate:0,issueResolution:{unresolvedInstallations:0,resolvedInstallations:1,rollbackResolvedInstallations:1,unknownInstallations:0}};
 app.ota[os]={id:latest,appId:app.id,platform:os,channel:'qa',runtimeVersion:'v1',createdAt:at,commitSha:'a'.repeat(40),telemetry:{...nativeTelemetry,failedInstallations:0,rolledBackInstallations:0,recoveredInstallations:0,failures:[],issueResolution:{unresolvedInstallations:0,resolvedInstallations:0,unknownInstallations:0}},rollback:{fromDeploymentId:immediate,targetDeploymentId:'a877e6bc-902e-487b-985d-82f179f9ad64',reason:'재복구',requestedAt:at-1},rollbackIssue:{deploymentId:original,telemetry:source,depth:3}};
 const document=attentionDocument('resolved');
 for(const unresolved of [false,true,false]){
  source.issueResolution={unresolvedInstallations:unresolved?1:0,resolvedInstallations:unresolved?0:1,rollbackResolvedInstallations:unresolved?0:1,unknownInstallations:0};
  document.getElementById('project-status-filter').value=unresolved?'ota':'resolved';renderProjectRows(asDom(document),{applications:[app]},[app]);
  assert.equal(row(document,app.id).querySelectorAll('a[data-project-issue]').filter(n=>n.getAttribute('href')===`/apps/${app.id}/ota/${original}/${unresolved?'unresolved':'resolved'}`).length,1);
  assert.ok(!row(document,app.id).querySelectorAll('a[data-project-issue]').some(n=>n.getAttribute('href')?.includes(immediate)),'root issue is not replaced with its immediate descendant');
  document.getElementById('project-status-filter').value=unresolved?'resolved':'ota';renderProjectRows(asDom(document),{applications:[app]},[app]);assert.match(document.getElementById('project-filter-status').textContent,/0.*1/);
 }
});

test('transitive root metadata requires bounded chain depth and scoped evidence while unknown lineage stays unknown',()=>{
 const app=nativeIssueProject(),original=app.ota.android!.id,immediate='d877e6bc-902e-487b-985d-82f179f9ad64',latest='e877e6bc-902e-487b-985d-82f179f9ad64';
 const source={...app.ota.android!.telemetry!,appId:app.id,deploymentId:original,platform:'android'};
 app.ota.android={...app.ota.android!,id:latest,telemetry:{...telemetry(),failedInstallations:0,recoveredInstallations:0,failures:[],issueResolution:{unresolvedInstallations:0,resolvedInstallations:0,unknownInstallations:0}},rollback:{fromDeploymentId:immediate,targetDeploymentId:original,reason:'이전 번들 복구',requestedAt:at-1},rollbackIssue:{deploymentId:original,telemetry:source,depth:2}};
 const document=attentionDocument('ota');renderProjectRows(asDom(document),{applications:[app]},[app]);assert.ok(row(document).querySelectorAll('a[data-project-issue]').some(n=>n.getAttribute('href')===`/apps/app_a/ota/${original}/unresolved`),'validated root can also be the reused bundle target in a transitive chain');
 const valid=app.ota.android.rollbackIssue!;
 const {depth: _depth,...withoutDepth}=valid;
 for(const origin of [null,withoutDepth,{...valid,depth:1},{...valid,depth:0},{...valid,depth:33},{...valid,depth:2.5},{...valid,deploymentId:latest},{...valid,deploymentId:immediate},{...valid,deploymentId:'https://foreign.test'}, {...valid,telemetry:{...source,appId:'app_b'}},{...valid,telemetry:{...source,deploymentId:immediate}},{...valid,telemetry:{...source,platform:'ios'}}]){
  app.ota.android.rollbackIssue=origin;document.getElementById('project-status-filter').value='unknown';renderProjectRows(asDom(document),{applications:[app]},[app]);assert.match(row(document).textContent,/운영 상태 미확인/);assert.equal(row(document).querySelectorAll('a[data-project-issue]').length,0);
 }
});

function workspaceText(document:Document):string{return document.getElementById('workspace-status').textContent+document.getElementById('workspace-infrastructure').textContent;}

test('app overview presents two platform panels and retains detailed reports behind disclosures',()=>{
 const document=new Document(),app=project();app.ota.android!.id=issueDeploymentId;app.ota.android!.telemetry=telemetry();
 renderOperationalOverview(asDom(document),app,{summary:app,status:'ready',now:at,observedAt:at});
 const root=document.getElementById('project-readiness'),panels=allDescendants(root).filter(n=>n.className==='overview-release');
 assert.equal(panels.length,2);const details=allDescendants(panels[1]!).find(n=>n.tagName==='details');assert.ok(details);assert.equal(details.open,false);
 assert.ok(details.textContent.includes('다운로드 3'));assert.ok(details.textContent.includes('네트워크 연결 실패'));
 const links=allDescendants(root).filter(n=>n.tagName==='a');assert.ok(links.some(n=>n.getAttribute('href')==='/apps/app_a/ota/'+issueDeploymentId));
 assert.ok(links.some(n=>n.getAttribute('href')==='/apps/app_a/runners'));
});

test('overview publication headers reject foreign app and platform bindings as unknown rather than empty or published',()=>{
 for(const binding of [{appId:'app_b'},{platform:'ios'}]){
  const document=new Document(),app=project();Object.assign(app.ota.android!,binding,{channel:'FOREIGN_PRIVATE_CHANNEL'});
  renderOperationalOverview(asDom(document),app,{summary:app,status:'ready'});
  const text=document.getElementById('project-readiness').textContent;assert.ok(!text.includes('FOREIGN_PRIVATE_CHANNEL'));assert.ok(text.includes('게시 상태 미확인'));
 }
});

test('overview keeps unresolved and recovered installation links distinct for the selected app',()=>{
 const document=new Document(),app=nativeIssueProject();
 renderOperationalOverview(asDom(document),app,{summary:app,status:'ready',now:at,observedAt:at});
 const root=document.getElementById('project-readiness'),links=allDescendants(root).filter(n=>n.tagName==='a');
 assert.ok(links.some(n=>n.getAttribute('href')==='/apps/app_a/ota/'+issueDeploymentId+'/unresolved'));
 assert.match(root.textContent,/미복구/);assert.ok(!root.textContent.includes('정상 운영'));
});

test('overview refresh retains evidence but does not present cached Runner presence as current',()=>{
 const document=new Document(),app=project();app.runner.status='online';
 renderOperationalOverview(asDom(document),app,{summary:app,status:'loading',now:at,observedAt:at});
 const root=document.getElementById('project-readiness');
 assert.ok(!root.textContent.includes('Runner 온라인'));assert.match(root.textContent,/새로 확인 중/);assert.match(root.textContent,/현재 연결 미확인/);assert.match(root.textContent,/최근 게시 이력/);
 renderOperationalOverview(asDom(document),app,{summary:app,status:'ready',now:at,observedAt:at});
 assert.match(root.textContent,/Runner 온라인/);assert.ok(!root.textContent.includes('새로 확인 중'));
});
