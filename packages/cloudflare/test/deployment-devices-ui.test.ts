import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeploymentDevices, validateDeploymentDevices, validateDeploymentJourney} from '../public/deployment-devices.js';
class Node {
  children:Node[]=[]; text=''; className=''; disabled=false; attributes:Record<string,string>={}; handlers:Record<string,()=>unknown>={}; type='';
  set textContent(value:string) {this.text=value;this.children=[];} get textContent():string {return this.text+this.children.map(n=>n.textContent).join('');}
  set innerHTML(_:string) {assert.fail('Unsafe HTML');}
  append(...values:Node[]) {this.children.push(...values);} replaceChildren(...values:Node[]) {this.text='';this.children=values;}
  setAttribute(key:string,value:string) {this.attributes[key]=value;} addEventListener(key:string,handler:()=>unknown) {this.handlers[key]=handler;}
}
const at=1_900_000_000_000, id='b877e6bc-902e-487b-985d-82f179f9ad64', ref='A'.repeat(100), cursor='B'.repeat(100);
const install=(change:any={})=>({id:ref,label:'설치 abcdef123456',environment:'android-emulator',downloaded:true,applied:true,restarted:true,failed:true,rolledBack:false,recovered:true,lastReportedAt:at,firstFailureAt:at-4000,latestConfirmedAt:at-2000,latestRestartAt:at-1000,history:{complete:false,reason:'legacy',recordedEvents:0,omittedEvents:0,startedAt:null},failures:[{stage:'download',code:'NETWORK_UNAVAILABLE'}],...change});
const page=(change:any={})=>({appId:'app_a',deploymentId:id,source:'sdk-self-report',observedAt:at,deployment:{id,platform:'android',channel:'qa',runtimeVersion:'v1',createdAt:at,commitSha:null},summary:null,installations:[install()],nextCursor:null,pageSize:20,...change});
const detail=(change:any={})=>({ ...page(),installation:install(),events:[],...change });
const deferred=()=>{let resolve!:(value:any)=>void;const promise=new Promise<any>(r=>resolve=r);return {promise,resolve};};
test('current issue status validates ordered recovery and never uses cumulative recovery as current resolution',()=>{
 for(const mode of ['unresolved','resolved'] as const){
  const row=install({issueStatus:mode,issueOrderKnown:true});
  assert.ok(validateDeploymentDevices(page({filter:mode,installations:[row]}),'app_a',id,null,mode));
  assert.equal(validateDeploymentDevices(page({filter:mode,installations:[install()]}),'app_a',id,null,mode),false);
  assert.equal(validateDeploymentDevices(page({filter:mode,installations:[row]}),'app_a',id,null,mode==='resolved'?'unresolved':'resolved'),false);
 }
 for(const row of [install({issueStatus:'none'}),install({issueStatus:'resolved',issueOrderKnown:false}),install({issueStatus:'resolved'}),install({issueStatus:'resolved',applied:false}),install({issueStatus:'resolved',issueOrderKnown:true,latestConfirmedAt:null}),install({issueStatus:'resolved',issueOrderKnown:true,latestRestartAt:0}),install({issueStatus:'resolved',issueOrderKnown:true,latestConfirmedAt:at-4000}),install({issueStatus:'resolved',issueOrderKnown:true,latestRestartAt:at-5000}),install({issueStatus:'unexpected'}),install({issueOrderKnown:'yes'})])assert.equal(validateDeploymentDevices(page({installations:[row]}),'app_a',id),false);
 assert.ok(validateDeploymentDevices(page({filter:'unresolved',installations:[install({issueStatus:'unresolved',issueOrderKnown:false,recovered:true})]}),'app_a',id,null,'unresolved'),'historical recovery may relapse or have unknown ordering');
});
function setup(api:(path:string,body?:string)=>Promise<any>=async path=>path.includes('/installations/')?detail():page()) {
  const root=new Node(),calls:string[]=[]; let now=at, live=true, route:{page:string,appId:string,deploymentId:string,filter?:'issues'|'unresolved'|'resolved'}={page:'ota-detail',appId:'app_a',deploymentId:id};
  const panel=createDeploymentDevices({document:{getElementById:()=>root,createElement:()=>new Node()},now:()=>now,crypto:globalThis.crypto},{route:()=>route,active:()=>live,expire:()=>{live=false;panel.clear();},api:async(path:string,body?:string)=>{calls.push(path);return api(path,body);}});
  const find=(label:string):Node=>{const nodes=(n:Node):Node[]=>[n,...n.children.flatMap(nodes)];const all=nodes(root);const found=all.find(n=>n.attributes['aria-label']===label)??all.find(n=>n.text===label);assert.ok(found,'missing '+label);return found;};
  return {panel,root,calls,route,find,setTime(value:number){now=value;}};
}
for(const mode of ['unresolved','resolved'] as const)test(mode+' entry loads a separate bounded list and one unfiltered timeline, with no follow-up polling',async()=>{
 const row=install({issueStatus:mode,issueOrderKnown:mode==='resolved'});
 const s=setup(async path=>path.includes('/installations/')?detail({installation:row}):page({filter:mode,installations:[row]}));s.route.filter=mode;
 await s.panel.open(s.route);assert.equal(s.calls.length,2);assert.ok(s.calls[0]!.endsWith('/telemetry?filter='+mode));assert.ok(s.calls[1]!.includes('/installations/'));assert.ok(!s.calls[1]!.includes('filter='));
 assert.match(s.root.textContent,mode==='resolved'?/해결됨 · 최신 실패 후 적용·재시작 확인/:/복구 순서 미확인/);
 assert.equal(s.find(mode==='resolved'?'해결됨':'미복구').attributes['aria-current'],'page');
 s.panel.leave();await s.panel.open(s.route);assert.equal(s.calls.length,2,'scoped list and timeline caches reused');
});
test('DTO validator rejects foreign scope, oversized pages and arbitrary failure/event text',()=>{assert.ok(validateDeploymentDevices(page(),'app_a',id));assert.ok(validateDeploymentDevices(detail(),'app_a',id,ref));for(const value of [page({appId:'app_b'}),page({deploymentId:'foreign'}),page({installations:Array.from({length:21},()=>install())}),page({installations:[install({failures:[{stage:'download',code:'RAW_SERVER_MESSAGE'}]})]}),page({installations:[install({environment:'ios-simulator'})]}),page({installations:[install({failed:false,rolledBack:false})]})])assert.equal(validateDeploymentDevices(value,'app_a',id),false);for(const event of [{type:'recovered',observedAt:at,receivedAt:at},{type:'failed',observedAt:at,receivedAt:at,code:'UNSAFE_TEXT'}])assert.equal(validateDeploymentDevices(detail({events:[event]}),'app_a',id,ref),false);});
test('legacy installation shows real cumulative outcomes but never invents event times or raw sealed identifiers',async()=>{const s=setup();await s.panel.open(s.route);assert.match(s.root.textContent,/다운로드 확인/);assert.match(s.root.textContent,/실패 후 복구 확인/);assert.match(s.root.textContent,/네트워크 연결 실패/);assert.match(s.root.textContent,/세부 이벤트 미기록/);assert.ok(!s.root.textContent.includes(ref));assert.equal(s.calls.length,1);await s.find('상세 이벤트 보기').handlers.click!();assert.equal(s.calls.length,2);assert.match(s.root.textContent,/보관된 세부 이벤트 없음/);assert.ok(!s.root.textContent.includes('다운로드 완료'));});
test('timeline opens on demand, distinguishes device and server times and uses bounded manual paging',async()=>{const s=setup(async path=>path.includes('/installations/')?detail({events:[{type:'failed',observedAt:at-3000,receivedAt:at-2000,stage:'download',code:'TIMEOUT'},{type:'launch_confirmed',observedAt:at-1000,receivedAt:at}],nextCursor:path.includes('?cursor=')?null:cursor}):page());await s.panel.open(s.route);await s.find('상세 이벤트 보기').handlers.click!();assert.match(s.root.textContent,/기기 보고 시각/);assert.match(s.root.textContent,/서버 수신/);assert.match(s.root.textContent,/응답 시간 초과/);assert.match(s.root.textContent,/적용 실행 확인/);await s.find('다음 이벤트').handlers.click!();assert.ok(s.calls.at(-1)!.endsWith('?cursor='+cursor));assert.equal(s.find('다음 이벤트').disabled,true);await s.find('이전 이벤트').handlers.click!();assert.equal(s.calls.length,3,'previous page is cached');});
test('manual refresh is singleflight and cached reads survive leave while logout clears them',async()=>{const gate=deferred();let slow=false;const s=setup(async()=>slow?gate.promise:page());await s.panel.open(s.route);s.panel.leave();await s.panel.open(s.route);assert.equal(s.calls.length,1);slow=true;const first=s.find('현황 새로고침').handlers.click!();const second=s.find('현황 새로고침').handlers.click!();assert.equal(s.calls.length,2);gate.resolve(page());await Promise.all([first,second]);s.panel.clear();slow=false;await s.panel.open(s.route);assert.equal(s.calls.length,3);});
test('late timeline and list responses cannot restore data after page leave or session expiry',async()=>{const gate=deferred();const s=setup(async path=>path.includes('/installations/')?gate.promise:page());await s.panel.open(s.route);const pending=s.find('상세 이벤트 보기').handlers.click!();s.panel.leave();gate.resolve(detail());await pending;assert.equal(s.root.textContent,'');const denied=setup(async()=>{throw Object.assign(new Error('DENIED'),{status:401});});await denied.panel.open(denied.route);assert.equal(denied.root.textContent,'');});
test('error retains last known results with retry, while unknown stages remain unknown rather than failure',async()=>{let reject=false;const s=setup(async()=>{if(reject)throw Error('offline');return page({installations:[install({downloaded:false,applied:false,restarted:false,failed:false,recovered:false,failures:[]})]});});await s.panel.open(s.route);assert.match(s.root.textContent,/다운로드 미확인/);assert.match(s.root.textContent,/일반 실패 이벤트 보고 없음/);reject=true;await s.find('현황 새로고침').handlers.click!();assert.match(s.root.textContent,/마지막 확인 기록은 유지/);assert.match(s.root.textContent,/다운로드 미확인/);reject=false;await s.find('다시 시도').handlers.click!();assert.ok(!s.root.textContent.includes('불러오지 못했습니다'));});


test('legacy installation with newly recorded reports shows partial history without claiming all events are missing',async()=>{const installation=install({history:{complete:false,reason:'legacy',recordedEvents:2,omittedEvents:0,startedAt:at-1000}});const s=setup(async path=>path.includes('/installations/')?detail({installation,events:[{type:'launch_confirmed',observedAt:at-1000,receivedAt:at-500},{type:'restart_confirmed',observedAt:at-500,receivedAt:at}]}):page({installations:[installation]}));await s.panel.open(s.route);assert.match(s.root.textContent,/과거 일부 세부 이벤트 미기록/);await s.find('상세 이벤트 보기').handlers.click!();assert.match(s.root.textContent,/이후 수신해 보관된 이벤트만 표시/);assert.match(s.root.textContent,/보관 이벤트 2건/);assert.match(s.root.textContent,/적용 실행 확인/);assert.match(s.root.textContent,/재시작 확인/);assert.ok(!s.root.textContent.includes('보관된 세부 이벤트 없음'));});

test('deployment metadata admits backend runtime256 and channel128 bounds',()=>{const value=page();value.deployment.runtimeVersion='r'.repeat(256);value.deployment.channel='c'.repeat(128);assert.ok(validateDeploymentDevices(value,'app_a',id));value.deployment.runtimeVersion+='r';assert.equal(validateDeploymentDevices(value,'app_a',id),false);value.deployment.runtimeVersion='r';value.deployment.channel+='c';assert.equal(validateDeploymentDevices(value,'app_a',id),false);});

const previousId='a877e6bc-902e-487b-985d-82f179f9ad64';
const deployment=(change:any={})=>({appId:'app_a',...page().deployment,...change});
test('rollback reads candidates only on demand, excludes foreign scope and reviews before a deduplicated POST',async()=>{
 const calls:{path:string,body:string|undefined}[]=[],gate=deferred(); const root=new Node(); const route={page:'ota-detail',appId:'app_a',deploymentId:id};
 const current=deployment(),old=deployment({id:previousId,createdAt:at-10000});
 const panel=createDeploymentDevices({document:{getElementById:()=>root,createElement:()=>new Node()},crypto:{randomUUID:()=>"12345678-1234-4234-8234-123456789abc"}},{active:()=>true,route:()=>route,expire(){},api:async(path:string,body?:string)=>{calls.push({path,body});if(body)return gate.promise;if(path.endsWith('/operations'))return {deployments:[current,old,deployment({id:'wrong-os',platform:'ios',createdAt:at-20000}),deployment({id:'wrong-channel',channel:'production',createdAt:at-20000}),deployment({id:'wrong-runtime',runtimeVersion:'v2',createdAt:at-20000})]};return page();}});
 const find=(label:string)=>{const nodes=(n:Node):Node[]=>[n,...n.children.flatMap(nodes)];const all=nodes(root);const n=all.find(n=>n.attributes['aria-label']===label)??all.find(n=>n.text===label);assert.ok(n,'missing '+label);return n;};
 await panel.open(route);assert.equal(calls.length,1);await find('이전 배포로 롤백').handlers.click!();assert.equal(calls.length,2);
 const select=find('롤백할 이전 배포');assert.equal(select.children.length,1);assert.equal((select.children[0] as any).value,previousId);
 const reason=find('롤백 사유');(reason as any).value='시작 화면 오류 복구';await reason.handlers.input!();await find('롤백 내용 확인').handlers.click!();assert.equal(calls.filter(c=>c.body).length,0);assert.match(root.textContent,/시작 화면 오류 복구/);
 const confirm=find('확인하고 롤백 배포');const first=confirm.handlers.click!(),second=confirm.handlers.click!();assert.equal(calls.filter(c=>c.body).length,1);const body=JSON.parse(calls.at(-1)!.body!);assert.equal(body.fromDeploymentId,id);assert.equal(body.targetDeploymentId,previousId);assert.equal(body.reason,'시작 화면 오류 복구');assert.equal(body.requestKey,'rollback_12345678-1234-4234-8234-123456789abc');assert.match(body.requestKey,/^[a-z][a-zA-Z0-9_-]*$/);
 panel.leave();gate.resolve(deployment({id:'c877e6bc-902e-487b-985d-82f179f9ad64',rollback:{fromDeploymentId:id,targetDeploymentId:previousId,reason:body.reason,requestedAt:at}}));await Promise.all([first,second]);assert.equal(root.textContent,'');
});
test('rollback deployment renders operator history separately from native automatic rollback',async()=>{
 const s=setup(async()=>page({deployment:{...page().deployment,rollback:{fromDeploymentId:previousId,targetDeploymentId:'c877e6bc-902e-487b-985d-82f179f9ad64',reason:'오류 복구',requestedAt:at-1000}}}));await s.panel.open(s.route);assert.match(s.root.textContent,/관리자 롤백 배포/);assert.match(s.root.textContent,/오류 복구/);assert.match(s.root.textContent,/롤백 전 배포/);assert.match(s.root.textContent,/복원 원본 배포/);
});

async function reviewRollback(s:ReturnType<typeof setup>) { await s.panel.open(s.route); await s.find('이전 배포로 롤백').handlers.click!(); (s.find('롤백 사유') as any).value='문제 버전 복구'; await s.find('롤백 사유').handlers.input!(); await s.find('롤백 내용 확인').handlers.click!(); }
test('ambiguous rollback response can retry the exact request key, conflict blocks further writes',async()=>{
 const bodies:any[]=[]; const s=setup(async(path,body)=>{if(body){bodies.push(JSON.parse(body));throw Object.assign(Error('offline'),bodies.length===2?{status:409}:{});}return path.endsWith('/operations')?{deployments:[deployment(),deployment({id:previousId,createdAt:at-1000})]}:page();});
 await reviewRollback(s);await s.find('확인하고 롤백 배포').handlers.click!();assert.match(s.root.textContent,/완료 여부를 확인하지 못했습니다/);await s.find('확인하고 롤백 배포').handlers.click!();assert.equal(bodies.length,2);assert.deepEqual(bodies[0],bodies[1]);assert.match(s.root.textContent,/최신 배포 또는 요청 상태가 변경/);assert.ok(!s.root.textContent.includes('확인하고 롤백 배포'));
});
test('nonlatest detail and foreign app candidate responses fail closed without any POST',async()=>{
 for(const deployments of [[deployment(),deployment({id:previousId,createdAt:at+1000})],[deployment(),deployment({appId:'app_b',id:previousId,createdAt:at-1000})]]) {let posts=0;const s=setup(async(path,body)=>{if(body)posts++;return path.endsWith('/operations')?{deployments}:page();});await s.panel.open(s.route);await s.find('이전 배포로 롤백').handlers.click!();assert.ok(!s.root.textContent.includes('롤백 내용 확인'));assert.match(s.root.textContent,/최신 배포가 아닙니다|이전 배포를 확인하지 못했습니다/);assert.equal(posts,0);}
});
test('leaving during candidate lookup cannot restore a rollback form to another app',async()=>{const gate=deferred();const s=setup(async path=>path.endsWith('/operations')?gate.promise:page());await s.panel.open(s.route);const pending=s.find('이전 배포로 롤백').handlers.click!();s.panel.leave();s.route.appId='app_b';gate.resolve({deployments:[deployment(),deployment({id:previousId,createdAt:at-1000})]});await pending;assert.equal(s.root.textContent,'');});
test('deployment metadata rejects malformed rollback IDs and unsafe reason text',()=>{for(const rollback of [{fromDeploymentId:'app_b/foreign',targetDeploymentId:previousId,reason:'복구',requestedAt:at},{fromDeploymentId:id,targetDeploymentId:previousId,reason:'unsafe\nreason',requestedAt:at}])assert.equal(validateDeploymentDevices(page({deployment:{...page().deployment,rollback}}),'app_a',id),false);});

const automaticDecision=()=>({id:'auto_rollback_test',appId:'app_a',sourceDeploymentId:previousId,targetDeploymentId:previousId,rollbackDeploymentId:id,platform:'android',channel:'qa',runtimeVersion:'v1',policyVersion:1,status:'succeeded',attemptedInstallations:20,failedInstallations:3,failureRatePercent:15,triggeredAt:at,updatedAt:at,lastErrorCode:null,reason:'실패율 기준 도달'});
const measuredSummary=(change:any={})=>({source:'sdk-self-report',observedInstallations:2,downloadedInstallations:2,appliedInstallations:1,restartedInstallations:1,failedInstallations:0,rolledBackInstallations:1,recoveredInstallations:0,applicationRate:50,lastReportedAt:at,environments:{physicalDevice:0,androidEmulator:2,iosSimulator:0,unknown:0},failures:[{stage:'launch',code:'UNCONFIRMED_LAUNCH',installations:1,lastReportedAt:at}],...change});
test('malformed issue resolution cannot render false solved metrics, while legacy cumulative summaries remain valid',async()=>{
 for(const issueResolution of [null,{unresolvedInstallations:0,resolvedInstallations:0,unknownInstallations:0},{unresolvedInstallations:0,resolvedInstallations:2,unknownInstallations:0},{unresolvedInstallations:1,resolvedInstallations:0,unknownInstallations:2}]){
  const value=page({summary:measuredSummary({issueResolution})});assert.equal(validateDeploymentDevices(value,'app_a',id),false);
  const s=setup(async()=>value);await s.panel.open(s.route);assert.match(s.root.textContent,/현황을 불러오지 못했습니다/);assert.ok(!s.root.textContent.includes('해결된 문제'));assert.ok(!s.root.textContent.includes('미복구 문제'));
 }
 const legacy=setup(async()=>page({summary:measuredSummary()}));await legacy.panel.open(legacy.route);assert.match(legacy.root.textContent,/현재 문제 해결 상태 미확인/);assert.match(legacy.root.textContent,/누적 적용률50.0%/);
 const valid=setup(async()=>page({summary:measuredSummary({issueResolution:{unresolvedInstallations:0,resolvedInstallations:1,unknownInstallations:0}})}));await valid.panel.open(valid.route);assert.match(valid.root.textContent,/해결된 문제1/);
});
test('native fallback remains visible when general failure count is zero and another installation cancels server rollback',async()=>{
 const failed=install({applied:false,restarted:false,failed:false,rolledBack:true,recovered:false,latestConfirmedAt:null,latestRestartAt:null,failures:[{stage:'launch',code:'UNCONFIRMED_LAUNCH'}]}),healthy=install({id:'C'.repeat(100),label:'설치 healthy',failed:false,rolledBack:false,recovered:false,firstFailureAt:null,failures:[]});
 const decision={...automaticDecision(),sourceDeploymentId:id,rollbackDeploymentId:null,status:'skipped',lastErrorCode:'AUTO_ROLLBACK_RECOVERED',attemptedInstallations:1,failedInstallations:1,failureRatePercent:100,cancellation:{checkedAt:at,attemptedInstallations:2,failedInstallations:1,confirmedHealthyInstallations:1,failureRatePercent:50}};
 const s=setup(async()=>page({summary:measuredSummary(),installations:[failed,healthy],automaticRollback:decision}));await s.panel.open(s.route);
 const summary=s.find('SDK 보고 누적 현황');for(const label of ['보고 설치2','누적 적용률50.0%','다운로드 확인2','적용 실행 확인1','재시작 확인1','일반 실패 보고0','네이티브 자동 복구1','동일 설치 복구0'])assert.ok(summary.textContent.includes(label),label);
 assert.match(s.root.textContent,/최초 실패 설치의 회복을 뜻하지 않습니다/);assert.match(s.root.textContent,/네이티브 자동 복구 보고됨/);assert.match(s.root.textContent,/일반 실패 이벤트 보고 없음/);assert.equal(s.calls.length,1,'summary uses the existing detail response only');
});
test('overlapping failure and native fallback reports remain separate cumulative counts after same installation recovery',async()=>{
 const s=setup(async()=>page({summary:measuredSummary({appliedInstallations:2,restartedInstallations:2,failedInstallations:1,recoveredInstallations:1,applicationRate:100}),installations:[install({rolledBack:true})]}));await s.panel.open(s.route);
 const summary=s.find('SDK 보고 누적 현황');for(const label of ['일반 실패 보고1','네이티브 자동 복구1','동일 설치 복구1'])assert.ok(summary.textContent.includes(label),label);assert.match(summary.textContent,/중복될 수 있어 합산하지 않습니다/);assert.match(s.root.textContent,/같은 설치에서 실패 이후/);
});
test('missing legacy recovery measurement remains unknown and absent summary never invents zero percent',async()=>{
 const legacy=measuredSummary();delete legacy.recoveredInstallations;const s=setup(async()=>page({summary:legacy}));await s.panel.open(s.route);assert.match(s.find('SDK 보고 누적 현황').textContent,/동일 설치 복구미확인/);
 const missing=setup();await missing.panel.open(missing.route);assert.match(missing.root.textContent,/SDK 적용 보고 미수집/);assert.ok(!missing.root.textContent.includes('누적 적용률0.0%'));
});
test('automatic policy rollback and native automatic recovery remain distinct in deployment details',async()=>{
 const s=setup(async()=>page({automaticRollback:automaticDecision(),deployment:{...page().deployment,rollback:{fromDeploymentId:previousId,targetDeploymentId:previousId,reason:'실패율 기준 도달',requestedAt:at}}}));await s.panel.open(s.route);assert.match(s.root.textContent,/실패율 기준 자동 롤백 배포/);assert.match(s.root.textContent,/3 \/ 20/);assert.match(s.root.textContent,/SDK 보고를 기준으로 한 서버 자동 롤백 판단/);assert.ok(!s.root.textContent.includes('관리자 롤백 배포'));
});
test('automatic decision metadata rejects foreign app, platform, runtime and unrelated deployment before render',()=>{
 for(const change of [{appId:'app_b'},{platform:'ios'},{runtimeVersion:'foreign'},{sourceDeploymentId:previousId,rollbackDeploymentId:previousId},{lastErrorCode:'raw user message'}])assert.equal(validateDeploymentDevices(page({automaticRollback:{...automaticDecision(),...change}}),'app_a',id),false);
});

test('owner explicitly allows a reported installation without publishing, polling or exposing its sealed reference',async()=>{
 const posts:any[]=[];const s=setup(async(_path,body)=>{if(body){posts.push(JSON.parse(body));return {enabled:posts.at(-1).enabled,eligibleInstallations:posts.at(-1).enabled?1:0};}return page({installations:[install({automaticRollbackEligible:false})]});});await s.panel.open(s.route);await s.find('자동 롤백 판단에 허용').handlers.click!();assert.equal(posts.length,1);assert.deepEqual(posts[0],{deploymentId:id,installationRef:ref,enabled:true});assert.match(s.calls.at(-1)!,/\/ota\/rollback-installations$/);assert.match(s.root.textContent,/소유자가 자동 롤백 판단에 허용한 설치/);assert.ok(!s.root.textContent.includes(ref));await s.find('허용 해제').handlers.click!();assert.equal(posts.length,2);assert.equal(posts[1].enabled,false);
});
test('allowlist writes are singleflight and fenced after leave or expiry; malformed flags fail closed',async()=>{
 const gate=deferred();let posts=0;const s=setup(async(_path,body)=>{if(body){posts++;return gate.promise;}return page({installations:[install({automaticRollbackEligible:false})]});});await s.panel.open(s.route);const action=s.find('자동 롤백 판단에 허용');const a=action.handlers.click!(),b=action.handlers.click!();assert.equal(posts,1);s.panel.leave();gate.resolve({enabled:true,eligibleInstallations:1});await Promise.all([a,b]);assert.equal(s.root.textContent,'');assert.equal(validateDeploymentDevices(page({installations:[install({automaticRollbackEligible:'yes'})]}),'app_a',id),false);
 const denied=setup(async(_path,body)=>{if(body)throw Object.assign(Error('401'),{status:401});return page({installations:[install({automaticRollbackEligible:false})]});});await denied.panel.open(denied.route);await denied.find('자동 롤백 판단에 허용').handlers.click!();assert.equal(denied.root.textContent,'');
});


test('issue mode rejects mismatched filters and normal rows, but retains recovered problem history',()=>{
 assert.ok(validateDeploymentDevices(page({filter:'issues'}),'app_a',id,null,'issues'));
 assert.equal(validateDeploymentDevices(page(),'app_a',id,null,'issues'),false);
 assert.equal(validateDeploymentDevices(page({filter:'issues'}),'app_a',id),false);
 assert.equal(validateDeploymentDevices(page({filter:'issues',installations:[install({failed:false,rolledBack:false,recovered:false})]}),'app_a',id,null,'issues'),false);
 assert.ok(validateDeploymentDevices(detail(),'app_a',id,ref,'issues'),'timeline response stays unfiltered');
});
test('issue direct entry requests one filtered page and exactly one first installation timeline; paging remains manual',async()=>{
 const rows=Array.from({length:20},(_,i)=>install({id:String(i).padStart(100,'X'),label:'설치 '+i}));
 const s=setup(async path=>path.includes('/installations/')?detail({installation:rows[0]}):page({filter:'issues',installations:rows,nextCursor:path.includes('cursor=')?null:cursor}));s.route.filter='issues';
 await s.panel.open(s.route);assert.equal(s.calls.length,2);assert.ok(s.calls[0]!.endsWith('/telemetry?filter=issues'));assert.ok(s.calls[1]!.includes('/installations/'));assert.ok(!s.calls[1]!.includes('filter='));assert.match(s.root.textContent,/복구 이력도 포함/);assert.match(s.root.textContent,/전체 배포의 누적 현황/);
 assert.equal(s.find('전체 설치 이력').attributes.href,'/apps/app_a/ota/'+id);
 await s.find('다음 설치').handlers.click!();assert.equal(s.calls.length,3);assert.ok(s.calls[2]!.endsWith('?filter=issues&cursor='+cursor));assert.ok(!s.root.textContent.includes('선택한 익명 설치의 이벤트'));
 await s.find('현황 새로고침').handlers.click!();assert.equal(s.calls.length,4,'refresh never fans out to timelines');
});
test('empty issue page never requests a timeline and does not claim current health',async()=>{
 const s=setup(async()=>page({filter:'issues',installations:[]}));s.route.filter='issues';await s.panel.open(s.route);assert.equal(s.calls.length,1);assert.match(s.root.textContent,/조회된 실패·네이티브 복구 이력이 없습니다/);assert.match(s.root.textContent,/현재 정상 상태를 보장하지 않습니다/);
});
test('all and issue modes use distinct list cache keys and fence delayed mode responses',async()=>{
 const gate=deferred();let slow=false;const s=setup(async path=>path.includes('/installations/')?detail():path.includes('filter=issues')?(slow?gate.promise:page({filter:'issues'})):page());
 await s.panel.open(s.route);s.panel.leave();s.route.filter='issues';await s.panel.open(s.route);assert.equal(s.calls.length,3);s.panel.leave();delete s.route.filter;await s.panel.open(s.route);assert.equal(s.calls.length,3,'all list remains separately cached');
 s.panel.clear();s.route.filter='issues';slow=true;const pending=s.panel.open(s.route);s.panel.leave();delete s.route.filter;await s.panel.open(s.route);gate.resolve(page({filter:'issues',deployment:{...page().deployment,channel:'PRIVATE_ISSUES'}}));await pending;assert.ok(!s.root.textContent.includes('PRIVATE_ISSUES'));assert.ok(!s.root.textContent.includes('선택한 익명 설치의 이벤트'));assert.equal(s.calls.filter(path=>path.includes('/installations/')).length,1);
});

test('automatic first issue timeline cannot render after same deployment changes filter or leaves',async()=>{
 for(const leave of [false,true]) {
  const gate=deferred();const s=setup(async path=>path.includes('/installations/')?gate.promise:page({filter:'issues'}));s.route.filter='issues';
  const opening=s.panel.open(s.route);await new Promise(resolve=>setImmediate(resolve));assert.equal(s.calls.length,2);
  if(leave)s.panel.leave();else delete s.route.filter;
  const before=s.root.textContent;gate.resolve(detail({events:[{type:'failed',observedAt:at,receivedAt:at,stage:'activation',code:'SIGNATURE_INVALID'}]}));await opening;
  assert.equal(s.root.textContent,before);assert.ok(!s.root.textContent.includes('서명 검증 실패'));
 }
});

test('issue first timeline resets old event cursor across deployments, apps and lifecycle transitions',async()=>{
 const other='c877e6bc-902e-487b-985d-82f179f9ad64';
 for(const transition of ['open','leave','clear']) {
  const s=setup(async path=>{
   const deploymentId=path.includes(other)?other:id,appId=path.includes('/app_b/')?'app_b':'app_a';
   const base=page({appId,deploymentId,deployment:{...page().deployment,id:deploymentId},...(path.includes('filter=issues')?{filter:'issues'}:{})});
   return path.includes('/installations/')?{...base,installation:install(),events:[],nextCursor:cursor}:base;
  });
  await s.panel.open(s.route);await s.find('상세 이벤트 보기').handlers.click!();await s.find('다음 이벤트').handlers.click!();assert.ok(s.calls.at(-1)!.endsWith('?cursor='+cursor));
  if(transition==='leave')s.panel.leave();if(transition==='clear')s.panel.clear();
  s.route.appId='app_b';s.route.deploymentId=other;s.route.filter='issues';await s.panel.open(s.route);
  assert.equal(s.calls.at(-1),'/api/apps/app_b/ota/deployments/'+other+'/telemetry/installations/'+ref);
  assert.equal(s.find('이전 이벤트').disabled,true);
 }
});


test('current unresolved and resolved list caches are distinct and delayed old classifications cannot restore rows',async()=>{
 const gate=deferred();let slow=false;
 const s=setup(async path=>path.includes('/installations/')?detail({installation:install({issueStatus:'resolved',issueOrderKnown:true})}):path.includes('filter=resolved')?(slow?gate.promise:page({filter:'resolved',installations:[install({issueStatus:'resolved',issueOrderKnown:true})]})):page({filter:'unresolved',installations:[]}));
 s.route.filter='unresolved';await s.panel.open(s.route);assert.equal(s.calls.length,1);
 s.panel.leave();s.route.filter='resolved';await s.panel.open(s.route);assert.equal(s.calls.length,3);
 s.panel.leave();s.route.filter='unresolved';await s.panel.open(s.route);assert.equal(s.calls.length,3);assert.match(s.root.textContent,/조회된 미복구 문제가 없습니다/);
 s.panel.clear();slow=true;s.route.filter='resolved';const pending=s.panel.open(s.route);s.panel.leave();s.route.filter='unresolved';await s.panel.open(s.route);
 gate.resolve(page({filter:'resolved',installations:[install({issueStatus:'resolved',issueOrderKnown:true,label:'PRIVATE_LATE_RESOLVED'})]}));await pending;
 assert.ok(!s.root.textContent.includes('PRIVATE_LATE_RESOLVED'));assert.equal(s.calls.filter(path=>path.includes('/installations/')).length,1);
});

const rollbackId='d877e6bc-902e-487b-985d-82f179f9ad64';
const rollbackResolved=(change:any={})=>install({issueStatus:'resolved',issueOrderKnown:true,applied:false,restarted:false,recovered:false,latestConfirmedAt:null,latestRestartAt:null,issueResolution:{kind:'rollback',deploymentId:rollbackId,confirmedAt:at-2000,restartedAt:at-1000},...change});
test('rollback evidence resolves original issue without manufacturing original OTA success',async()=>{
 const row=rollbackResolved();assert.ok(validateDeploymentDevices(page({filter:'resolved',installations:[row]}),'app_a',id,null,'resolved'));
 const s=setup(async path=>path.includes('/installations/')?detail({installation:row}):page({filter:'resolved',installations:[row]}));s.route.filter='resolved';await s.panel.open(s.route);
 assert.match(s.root.textContent,/롤백으로 해결됨 · 같은 설치의 롤백 적용·재시작 확인/);assert.match(s.root.textContent,/적용 미확인/);assert.match(s.root.textContent,/재시작 미확인/);assert.match(s.root.textContent,/원래 문제의 첫 실패/);assert.match(s.root.textContent,/네트워크 연결 실패/);
 assert.equal(s.find('정상 복구된 롤백 배포 이력').attributes.href,'/apps/app_a/ota/'+rollbackId);assert.equal(s.calls.length,2,'no rollback fan-out read');
});
test('invalid or contradictory resolution proofs cannot label an original issue solved',()=>{
 const row=rollbackResolved(), proof=row.issueResolution;
 for(const change of [{issueResolution:null},{issueResolution:{...proof,kind:'published'}},{issueResolution:{...proof,deploymentId:id}},{issueResolution:{...proof,deploymentId:'https://foreign.test'}},{issueResolution:{...proof,confirmedAt:at-4000}},{issueResolution:{...proof,restartedAt:null}},{issueOrderKnown:false},{issueStatus:'unresolved'},{issueStatus:undefined},{failed:false,rolledBack:false},{issueResolution:{...proof,kind:'same-deployment'}}, {issueResolution:{...proof,kind:'same-deployment',deploymentId:id}}])assert.equal(validateDeploymentDevices(page({installations:[{...row,...change}]}),'app_a',id),false);
 const direct=install({issueStatus:'resolved',issueOrderKnown:true,issueResolution:{kind:'same-deployment',deploymentId:id,confirmedAt:at-2000,restartedAt:at-1000}});assert.ok(validateDeploymentDevices(page({installations:[direct]}),'app_a',id));assert.equal(validateDeploymentDevices(page({installations:[{...direct,issueResolution:{...direct.issueResolution,confirmedAt:at-1500}}]}),'app_a',id),false);
});

test('original detail retains the linked rollback failure cause through relapse and re-recovery with no rollback fan-out reads',async()=>{
 const rollbackFailure={deploymentId:rollbackId,observedAt:at-3000,stage:'download',code:'NETWORK_UNAVAILABLE'};
 let row=rollbackResolved({issueStatus:'unresolved',issueResolution:undefined,rollbackFailure});
 const s=setup(async path=>path.includes('/installations/')?detail({installation:row}):page({installations:[row]}));
 await s.panel.open(s.route);assert.match(s.root.textContent,/연결된 롤백 실패 · 원래 문제도 미복구/);assert.match(s.root.textContent,/네트워크 연결 실패/);
 assert.equal(s.find('실패한 롤백 배포 이력').attributes.href,'/apps/app_a/ota/'+rollbackId);assert.equal(s.calls.length,1);
 assert.ok(!s.root.textContent.includes('롤백으로 해결됨'));
 row=rollbackResolved({rollbackFailure});await s.find('현황 새로고침').handlers.click!();
 assert.match(s.root.textContent,/롤백 실패 후 재복구 확인 · 원래 문제 해결됨/);assert.match(s.root.textContent,/롤백으로 해결됨/);assert.match(s.root.textContent,/적용 미확인/);assert.match(s.root.textContent,/재시작 미확인/);assert.equal(s.calls.length,2);
});

test('rollback failure context rejects unsafe foreign or contradictory links and incomplete cause pairs',()=>{
 const context={deploymentId:rollbackId,observedAt:at-3000,stage:'download',code:'NETWORK_UNAVAILABLE'};
 const row=rollbackResolved({issueStatus:'unresolved',issueResolution:undefined,rollbackFailure:context});
 assert.ok(validateDeploymentDevices(page({installations:[row]}),'app_a',id));
 for(const rollbackFailure of [null,{...context,deploymentId:id},{...context,deploymentId:'https://foreign.test'},{...context,observedAt:at-5000},{...context,observedAt:0},{...context,stage:'unsafe'},{...context,code:'private_error'},{...context,stage:undefined},{...context,code:undefined}])assert.equal(validateDeploymentDevices(page({installations:[{...row,rollbackFailure}]}),'app_a',id),false);
 assert.ok(validateDeploymentDevices(page({installations:[{...row,rollbackFailure:{deploymentId:rollbackId,observedAt:at-3000}}]}),'app_a',id),'capacity-limited journals preserve the known failure time without inventing a cause');
 assert.equal(validateDeploymentDevices(page({installations:[rollbackResolved({rollbackFailure:{...context,observedAt:at-1000}})]}),'app_a',id),false,'recovery must be strictly newer than the linked rollback failure');
 assert.equal(validateDeploymentDevices(page({installations:[{...row,issueStatus:'none',failed:false,rolledBack:false}]}),'app_a',id),false);
});

const journeyIds = [id,previousId,'c877e6bc-902e-487b-985d-82f179f9ad64','d877e6bc-902e-487b-985d-82f179f9ad64'];
function journeyPage(change:any={}) {
 const history={complete:true,reason:null,recordedEvents:2,omittedEvents:0,startedAt:at-9000};
 const deployments=journeyIds.map((deploymentId,index)=>({id:deploymentId,platform:'android',channel:'qa',runtimeVersion:'v1',createdAt:at+index*2000,commitSha:null,history,...(index?{rollback:{fromDeploymentId:journeyIds[index-1],targetDeploymentId:'e877e6bc-902e-487b-985d-82f179f9ad64',reason:'문제 버전 복구',requestedAt:at+index*2000}}:{})}));
 const entries:any[]=[];
 for(let i=0;i<4;i++) {const d=deployments[i]!;entries.push({kind:'publication',deploymentId:d.id,observedAt:d.createdAt}); if(i===0||i===2)entries.push({kind:'sdk-event',deploymentId:d.id,type:'failed',observedAt:d.createdAt+100,receivedAt:d.createdAt+200,stage:'launch',code:'UNCONFIRMED_LAUNCH'});else for(const [j,type] of ['launch_confirmed','restart_confirmed'].entries())entries.push({kind:'sdk-event',deploymentId:d.id,type,observedAt:d.createdAt+100+j*100,receivedAt:d.createdAt+300});}
 entries.forEach((entry,i)=>entry.id='j1.'+String(i).padStart(43,'A'));
 return {appId:'app_a',deploymentId:id,rootDeploymentId:id,source:'sdk-self-report',observedAt:at+10000,pageSize:20,nextCursor:null,installation:{id:ref,label:'설치 abcdef123456',environment:'android-emulator'},deployments,history:{complete:true,reasons:[]},entries,...change};
}
test('unified journey validates six app/platform contracts and displays original rollback relapse recovery in one chronology',async()=>{
 for(const app of ['isso','promise','reward'])for(const platform of ['ios','android']) {
  const appId='app_'+app,environment=platform==='ios'?'ios-simulator':'android-emulator';
  const value=journeyPage({appId});value.installation.environment=environment;value.deployments=value.deployments.map((d:any)=>({...d,platform}));
  assert.ok(validateDeploymentJourney(value,appId,id,ref));
  const base=page({appId,deployment:{...page().deployment,platform},installations:[install({environment})]});
  const s=setup(async path=>path.includes('/journey')?value:path.includes('/installations/')?{...base,installation:base.installations[0],events:[]}:base);s.route.appId=appId;
  await s.panel.open(s.route);assert.equal(s.calls.length,1);await s.find('상세 이벤트 보기').handlers.click!();assert.equal(s.calls.length,2,'existing raw detail remains independent');
  await s.find('문제 전체 흐름 보기').handlers.click!();assert.equal(s.calls.length,3);assert.ok(s.calls.at(-1)!.endsWith('/installations/'+ref+'/journey'));
  for(const label of ['원래 OTA 게시','롤백 1 · 적용 실행 확인','롤백 1 · 재시작 확인','롤백 2 · 실패','롤백 3 · 적용 실행 확인','롤백 3 · 재시작 확인','실행 확인 실패','게시와 기기 적용 결과는 구분'])assert.ok(s.root.textContent.includes(label),label);
  assert.equal(s.find('롤백 3 배포 상세').attributes.href,'/apps/'+appId+'/ota/'+journeyIds[3]);assert.ok(!s.root.textContent.includes(ref));
 }
});
test('journey rejects foreign app/device/platform, invalid ancestry, unordered and oversized entries, unsafe codes and broken cursors',()=>{
 assert.ok(validateDeploymentJourney(journeyPage(),'app_a',id,ref));
 for(const mutate of [
  (v:any)=>v.appId='app_b',(v:any)=>v.installation.id='Z'.repeat(100),(v:any)=>v.deployments[1].platform='ios',
  (v:any)=>v.deployments[1].channel='production',(v:any)=>v.deployments[1].runtimeVersion='foreign',
  (v:any)=>v.rootDeploymentId=journeyIds[3],(v:any)=>v.deployments[1].rollback.fromDeploymentId=journeyIds[2],
  (v:any)=>{delete v.entries[1].stage;delete v.entries[1].code;},
  (v:any)=>{v.entries[3].stage='launch';v.entries[3].code='UNCONFIRMED_LAUNCH';},
  (v:any)=>v.entries.reverse(),(v:any)=>v.entries=Array.from({length:21},()=>v.entries[0]),(v:any)=>v.entries[1].code='<script>alert(1)</script>',
  (v:any)=>v.deployments[3].createdAt=v.observedAt+1,(v:any)=>v.entries[1].receivedAt=v.observedAt+1,
  (v:any)=>v.entries[1].receivedAt=Number.MAX_SAFE_INTEGER,(v:any)=>v.entries[1].id='raw-device-id',
  (v:any)=>v.entries[0].observedAt+=1,(v:any)=>v.entries[1].deploymentId='e877e6bc-902e-487b-985d-82f179f9ad64',
  (v:any)=>v.nextCursor='../../private',(v:any)=>v.history={complete:true,reasons:['legacy']},
  (v:any)=>v.installation.label='unsafe\nlabel',(v:any)=>v.deployments[0].history.reason='arbitrary',
 ]) {const value=journeyPage();mutate(value);assert.equal(validateDeploymentJourney(value,'app_a',id,ref),false);}
});
test('journey appends later pages, deduplicates stable IDs, preserves earlier rows on failed retry, and caches repeat viewing',async()=>{
 const full=journeyPage(),first={...full,entries:full.entries.slice(0,5),nextCursor:cursor},last={...full,entries:full.entries.slice(4)};let fail=false;
 const s=setup(async path=>path.includes('/journey')?(path.includes('?cursor=')?(fail?Promise.reject(Error('offline')):last):first):path.includes('/installations/')?detail():page());
 await s.panel.open(s.route);await s.find('상세 이벤트 보기').handlers.click!();await s.find('문제 전체 흐름 보기').handlers.click!();assert.ok(!s.root.textContent.includes('롤백 3 게시'));
 fail=true;await s.find('이후 기록 더 보기').handlers.click!();assert.match(s.root.textContent,/표시 중인 기록은 보존/);assert.match(s.root.textContent,/원래 OTA 게시/);
 fail=false;await s.find('문제 흐름 다시 시도').handlers.click!();assert.match(s.root.textContent,/롤백 3 · 재시작 확인/);
 const collect=(n:Node):Node[]=>[n,...n.children.flatMap(collect)];const entries=collect(s.root).filter(n=>n.className.startsWith('device-journey-entry'));assert.equal(entries.length,full.entries.length);
 const calls=s.calls.length;await s.find('문제 흐름 새로고침').handlers.click!();assert.equal(s.calls.length,calls+1,'explicit refresh reads one fresh first page before cache expiry');
 await s.find('이벤트 닫기').handlers.click!();await s.find('상세 이벤트 보기').handlers.click!();await s.find('문제 전체 흐름 보기').handlers.click!();assert.equal(s.calls.length,calls+1,'repeat detail and journey viewing remains cached');
 s.setTime(at+60_001);await s.find('문제 흐름 새로고침').handlers.click!();assert.equal(s.calls.length,calls+2,'explicit refresh reads exactly one first page');
});
test('journey reports missing legacy or capacity gaps explicitly and never invents milestones',async()=>{
 const value=journeyPage({entries:[],rootDeploymentId:null,deployments:[{...journeyPage().deployments[0],history:{complete:false,reason:'legacy',recordedEvents:0,omittedEvents:3,startedAt:null}}],history:{complete:false,reasons:['legacy','capacity','missing','lineage']}});
 assert.ok(validateDeploymentJourney(value,'app_a',id,ref));const s=setup(async path=>path.includes('/journey')?value:path.includes('/installations/')?detail():page());await s.panel.open(s.route);await s.find('상세 이벤트 보기').handlers.click!();await s.find('문제 전체 흐름 보기').handlers.click!();assert.match(s.root.textContent,/롤백 연결 일부 미확인/);assert.match(s.root.textContent,/미기록 구간의 성공·실패를 추정하지 않습니다/);assert.match(s.root.textContent,/보관된 전체 흐름 기록이 없습니다/);assert.ok(!s.root.textContent.includes('롤백 1 게시'));
});
test('journey late response is fenced across app switches, installation switches, logout and A to B to A',async()=>{
 for(const action of ['leave','clear','switch','aba','device']) {
  const gate=deferred();const s=setup(async path=>path.includes('/journey')?gate.promise:path.includes('/installations/')?detail():page());await s.panel.open(s.route);await s.find('상세 이벤트 보기').handlers.click!();const pending=s.find('문제 전체 흐름 보기').handlers.click!();
  if(action==='clear')s.panel.clear();else if(action==='switch'){s.panel.leave();s.route.appId='app_b';}else if(action==='aba'){s.panel.leave();s.route.appId='app_b';s.route.appId='app_a';await s.panel.open(s.route);}else if(action==='device')await s.find('이벤트 닫기').handlers.click!();else s.panel.leave();
  gate.resolve(journeyPage());await pending;assert.ok(!s.root.textContent.includes('롤백 3 게시'),action);
 }
});
test('journey fails closed on inconsistent cursor snapshot and does not replace preceding history',async()=>{
 const full=journeyPage();const first={...full,entries:full.entries.slice(0,5),nextCursor:cursor};
 for(const last of [{...full,observedAt:at+1,entries:full.entries.slice(5)},{...full,entries:full.entries.slice(5),nextCursor:cursor},{...full,entries:[{...full.entries[0],id:'j1.'+'Z'.repeat(43)}]}]) {
  const s=setup(async path=>path.includes('/journey')?(path.includes('?cursor=')?last:first):path.includes('/installations/')?detail():page());await s.panel.open(s.route);await s.find('상세 이벤트 보기').handlers.click!();await s.find('문제 전체 흐름 보기').handlers.click!();await s.find('이후 기록 더 보기').handlers.click!();assert.match(s.root.textContent,/표시 중인 기록은 보존/);assert.ok(!s.root.textContent.includes('롤백 3 게시'));
 }
});

test('journey concurrent opens are singleflight and logout clears caches without restoring an old owner response',async()=>{
 const gate=deferred();let delayed=true;const s=setup(async path=>path.includes('/journey')?(delayed?gate.promise:journeyPage()):path.includes('/installations/')?detail():page());await s.panel.open(s.route);await s.find('상세 이벤트 보기').handlers.click!();const button=s.find('문제 전체 흐름 보기');const a=button.handlers.click!(),b=button.handlers.click!();assert.equal(s.calls.filter(p=>p.includes('/journey')).length,1);s.panel.clear();gate.resolve(journeyPage());await Promise.all([a,b]);assert.equal(s.root.textContent,'');delayed=false;await s.panel.open(s.route);await s.find('상세 이벤트 보기').handlers.click!();await s.find('문제 전체 흐름 보기').handlers.click!();assert.equal(s.calls.filter(p=>p.includes('/journey')).length,2,'old session data never warms the new session cache');
});
test('journey validates bounded depth and safe rendering without HTML execution or foreign links',async()=>{
 const value=journeyPage();value.deployments[1].rollback!.reason='<img src=x onerror=alert(1)>';assert.ok(validateDeploymentJourney(value,'app_a',id,ref));
 const s=setup(async path=>path.includes('/journey')?value:path.includes('/installations/')?detail():page());await s.panel.open(s.route);await s.find('상세 이벤트 보기').handlers.click!();await s.find('문제 전체 흐름 보기').handlers.click!();assert.ok(s.root.textContent.includes('<img src=x onerror=alert(1)>'),'untrusted reason is literal text, never innerHTML');
 const tooDeep=journeyPage({deployments:Array.from({length:34},(_,i)=>({...value.deployments[0],id:(i.toString(16).padStart(8,'0')+'-902e-487b-985d-82f179f9ad64')}))});assert.equal(validateDeploymentJourney(tooDeep,'app_a',id,ref),false);
});
test('journey mobile styles retain flowing content and wrapping navigation',async()=>{
 const {readFile}=await import('node:fs/promises');const css=await readFile(new URL('../public/app.css',import.meta.url),'utf8');assert.match(css,/\.device-journey-entry[^}]*overflow-wrap:anywhere/);assert.match(css,/\.device-journey-entry \.button[^}]*white-space:normal/);assert.match(css,/@media \(max-width:640px\)[^\n]*\.device-journey/);assert.ok(!/\.device-journey[^}]*min-width:\s*\d{3,}px/.test(css));
});
test('explicit journey refresh displays new reports within sixty seconds and resets prior pagination',async()=>{
 let updated=false;const value=journeyPage();const s=setup(async path=>path.includes('/journey')?(updated?value:{...value,entries:value.entries.slice(0,2),nextCursor:cursor}):path.includes('/installations/')?detail():page());await s.panel.open(s.route);await s.find('상세 이벤트 보기').handlers.click!();await s.find('문제 전체 흐름 보기').handlers.click!();assert.ok(!s.root.textContent.includes('롤백 3 게시'));updated=true;await s.find('문제 흐름 새로고침').handlers.click!();assert.match(s.root.textContent,/롤백 3 · 재시작 확인/);assert.equal(s.calls.filter(p=>p.includes('/journey')).length,2);assert.ok(!s.calls.at(-1)!.includes('cursor='));
});

test('old journey 401 cannot expire a newly opened owner session, current journey 401 still expires',async()=>{
 let reject!:(reason:unknown)=>void;const old=new Promise((_resolve,rejectOld)=>{reject=rejectOld;});let stale=true;
 const s=setup(async path=>path.includes('/journey')?(stale?old:journeyPage()):path.includes('/installations/')?detail():page());
 await s.panel.open(s.route);await s.find('상세 이벤트 보기').handlers.click!();const pending=s.find('문제 전체 흐름 보기').handlers.click!();
 s.panel.clear();stale=false;await s.panel.open(s.route);await s.find('상세 이벤트 보기').handlers.click!();await s.find('문제 전체 흐름 보기').handlers.click!();
 reject(Object.assign(Error('old owner expired'),{status:401}));await pending;assert.match(s.root.textContent,/롤백 3 · 재시작 확인/);
 const live=setup(async path=>{if(path.includes('/journey'))throw Object.assign(Error('owner expired'),{status:401});return path.includes('/installations/')?detail():page();});
 await live.panel.open(live.route);await live.find('상세 이벤트 보기').handlers.click!();await live.find('문제 전체 흐름 보기').handlers.click!();assert.equal(live.root.textContent,'');
});
