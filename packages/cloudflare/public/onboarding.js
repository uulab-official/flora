import {probeLaunchDownload} from "./onboarding-download.js";
import {buildPublicFiles} from "./onboarding-files.js";
import {deriveOnboardingState,freezePublicationTarget,evaluatePublications} from "./onboarding-model.js";
const titles={owner:"관리자",github:"GitHub",sdk:"앱·SDK",runner:"PC Runner",publication:"첫 OTA"};
const labels={needed:"준비 필요",working:"진행 중",approval:"사용자 승인 대기",unknown:"확인 필요",verified:"확인됨",failed:"실패"};
export function createOnboarding(env,context){
 const document=env.document,node=id=>document.getElementById(id);
 let epoch=0,selected=null,controller=null,state=null,connection=null,currentApp=null,target=null;
 const knownJobs=new Map(),publications=new Map(),attempted=new Set(),pending=new Map();
 const element=(tag,text,className="")=>{const value=document.createElement(tag);value.textContent=text;value.className=className;return value;};
 function clear(){node("onboarding-content").replaceChildren();node("onboarding-steps").replaceChildren();node("onboarding-status").textContent="";}
 function leave(){epoch++;controller?.abort();controller=null;context.setActiveJobPolling(false);state=null;connection=null;target=null;knownJobs.clear();publications.clear();attempted.clear();pending.clear();clear();}
 function render(){
  if(!state||!context.isCurrent()||document.hidden)return;
  const input=context.getSnapshot();if(input.appId!==currentApp)return;
  if(!state.steps.some(s=>s.id===selected))selected=state.steps.find(s=>s.status!=="verified")?.id??"publication";
  node("onboarding-steps").replaceChildren(...state.steps.map(s=>{
   const button=element("button",titles[s.id]+" · "+labels[s.status],"onboarding-step");button.setAttribute("type","button");button.setAttribute("aria-current",s.id===selected?"step":"false");
   button.addEventListener("click",()=>{selected=s.id;if(selected!=="publication")context.setActiveJobPolling(false);render();if(selected==="publication")void update();node("onboarding-content").focus?.();});return button;
  }));
  const step=state.steps.find(s=>s.id===selected),content=node("onboarding-content");content.replaceChildren();
  content.append(element("p",labels[step.status],"onboarding-badge"),element("h2",titles[step.id]),element("p",step.reason,"onboarding-explanation"));
  const paths={owner:"/settings",github:"/projects/new",sdk:input.appId?`/apps/${input.appId}/source`:"/projects/new",runner:input.appId?`/apps/${input.appId}/runners`:"/projects",publication:input.appId?`/apps/${input.appId}/ota`:"/projects"};
  const link=element("a",({owner:"소유자 설정 보기",github:"GitHub 연결·프로젝트 등록",sdk:"앱·SDK 설정 열기",runner:"앱별 Runner 등록",publication:"OTA 배포 현황 열기"})[step.id],"button");link.setAttribute("href",paths[step.id]);
  link.addEventListener("click",event=>{if(event?.ctrlKey||event?.metaKey||event?.shiftKey||event?.altKey||event?.button)return;event?.preventDefault?.();if(step.id==="github")try{env.sessionStorage?.setItem("flora:onboarding-origin","onboarding");}catch{}context.navigate(paths[step.id]);});content.append(link);
  if(step.id==="sdk" && input.appId)renderSDK(content,input);
  if(step.id==="publication" && input.appId)renderPublication(content,input);
  const refresh=element("button","다시 확인","button secondary");refresh.setAttribute("type","button");refresh.addEventListener("click",()=>check());content.append(refresh);
  node("onboarding-status").textContent="현재 서버 정보로 확인했습니다. OTA 게시와 기기 적용은 따로 확인합니다.";
 }
 async function collectPublications(){
  if(!target)return;const currentTarget=target,version=epoch;
  const input=context.getSnapshot(),jobs=input.automation?.jobs??[];
  const matches=job=>job?.appId===currentTarget.appId&&job.commitSha===currentTarget.commitSha&&job.channel===currentTarget.channel&&job.runtimeVersion===currentTarget.runtimeVersion&&currentTarget.platforms.includes(job.platform);
  const active=job=>["queued","leased","cancel_requested"].includes(job?.state);
  // The server returns newest first. Retain successful evidence across retries.
  for(const platform of currentTarget.platforms){
   const candidates=jobs.filter(job=>matches(job)&&job.platform===platform),prior=knownJobs.get(platform);
   const selected=candidates.find(job=>job.state==="succeeded"&&job.deploymentId)??(prior?.state==="succeeded"?prior:candidates[0]);
   if(selected)knownJobs.set(platform,selected);
  }
  // A pinned job can leave the bounded recent list while still running. Refresh
  // only its known ID; failures wait for manual retry instead of scanning history.
  for(const job of [...knownJobs.values()]){
   if(!active(job)||jobs.some(item=>item.id===job.id)||!/^automation_[a-z0-9_-]{1,80}$/.test(job.id??""))continue;
   const key="job:"+job.id;if(pending.has(key)){await pending.get(key);continue;}if(attempted.has(key))continue;attempted.add(key);
   const work=(async()=>{try{
    const view=await context.api(`/api/apps/${currentTarget.appId}/automation/jobs/${job.id}`,undefined,controller?.signal),updated=view?.job;
    if(version===epoch&&target===currentTarget&&context.isCurrent()&&context.getSnapshot().appId===currentTarget.appId&&updated?.id===job.id&&updated.platform===job.platform&&matches(updated)){
     knownJobs.set(job.platform,updated);attempted.delete(key);
    }
   }catch{}})();pending.set(key,work);await work;if(pending.get(key)===work)pending.delete(key);
  }
  if(version!==epoch||target!==currentTarget||!context.isCurrent())return;
  for(const deployment of input.operations?.deployments??[])if(deployment.appId===target.appId)publications.set(deployment.id,{appId:target.appId,deploymentId:deployment.id,deployment});
  for(const job of knownJobs.values()){
   if(version!==epoch||target!==currentTarget||!context.isCurrent())return;
   if(job.state!=="succeeded"||!job.deploymentId||publications.has(job.deploymentId))continue;
   const id=job.deploymentId;if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))continue;if(pending.has(id)){await pending.get(id);continue;}if(attempted.has(id))continue;attempted.add(id);
   const work=(async()=>{try{const receipt=await context.api(`/api/apps/${currentTarget.appId}/ota/deployments/${id}/publication`,undefined,controller?.signal);if(version===epoch&&target===currentTarget&&context.isCurrent()&&context.getSnapshot().appId===currentTarget.appId&&receipt?.appId===currentTarget.appId&&receipt.deploymentId===id)publications.set(id,receipt);}catch{}})();
   pending.set(id,work);await work;if(pending.get(id)===work)pending.delete(id);
  }
 }
 function result(){return target?evaluatePublications(target,[...knownJobs.values()],[...publications.values()]):null;}
 async function update(){
  if(!controller||controller.signal.aborted||!context.isCurrent()||document.hidden||context.getSnapshot().appId!==currentApp)return;
  const version=epoch,selectedAtStart=selected;await collectPublications();if(version!==epoch||!context.isCurrent()||selected!==selectedAtStart)return;
  const input=context.getSnapshot();state=deriveOnboardingState({...input,origin:env.location?.origin,connection,target});
  const publication=result();if(publication){const step=state.steps.find(s=>s.id==="publication");step.status=publication.status==="published"?"verified":publication.status==="partial"?"working":"unknown";step.reason=publication.status==="published"?"모든 선택 플랫폼의 작업과 실제 게시 배포를 확인했습니다.":publication.status==="partial"?"일부 플랫폼만 게시됐습니다. 나머지 플랫폼을 확인하세요.":"고정한 커밋의 배포를 기다리고 있습니다.";}
  context.setActiveJobPolling(Boolean(selected==="publication"&&target&&[...knownJobs.values()].some(j=>!attempted.has("job:"+j.id)&&["queued","leased","cancel_requested"].includes(j.state))));render();
 }
 async function check(){
  if(!controller||!context.isCurrent())return;const version=epoch;
  try{if(currentApp)await context.refreshData({operations:true,automation:true},controller.signal);if(version!==epoch)return;attempted.clear();await update();}catch{if(version===epoch)node("onboarding-status").textContent="배포를 확인하지 못했습니다. 다시 확인해 주세요.";}
 }
 function renderPublication(content,input){
  const detection=input.operations?.detections?.find(d=>d.appId===input.appId&&d.updatesEnabled&&d.automationConfig),policy=input.automation?.policy;
  content.append(element("p","첫 확인용 JS 변경을 앱 저장소에 [skip ci] 커밋·push하고, 아래에서 검증 대상을 고정하세요. 정책 변경은 Runner 화면에서 명시적으로 저장합니다.","onboarding-note"));
  if(!target){const button=element("button","현재 커밋·선택 플랫폼으로 확인","button secondary");button.setAttribute("type","button");button.setAttribute("id","onboarding-pin-target");button.disabled=!detection||!policy?.enabled;
   button.addEventListener("click",async()=>{if(button.disabled)return;try{target=freezePublicationTarget({appId:input.appId,commitSha:detection.commitSha,channel:policy.channel,runtimeVersion:detection.automationConfig.runtimeVersion,platforms:policy.platforms??[policy.platform]});await update();}catch{node("onboarding-status").textContent="앱 소스와 자동 배포 정책을 먼저 확인하세요.";}});content.append(button);return;}
  content.append(element("p",`검증 커밋 ${target.commitSha.slice(0,12)} · ${target.channel} · ${target.runtimeVersion}`,"subtle"));
  const publication=result();
  for(const item of publication.platforms){
   const row=element("div","","onboarding-publication");row.append(element("strong",item.platform+" · "+(item.verified?"게시 확인":"확인 대기")));
   if(item.verified){
    const link=element("a","배포 상세 이력","button secondary small");link.setAttribute("href",`/apps/${target.appId}/ota/${item.deploymentId}`);row.append(link);
    const download=element("button","매니페스트·시작 번들 확인","button secondary small"),status=element("p","웹 전송·해시 확인입니다. 기기 적용·재시작은 상세 이력의 SDK 보고에서 확인하세요.","subtle");download.setAttribute("type","button");
    download.addEventListener("click",async()=>{if(download.disabled)return;const version=epoch;download.disabled=true;
     try{const checked=await probeLaunchDownload(env.location?.origin,target,item.platform,item.deploymentId,{fetch:env.fetch.bind(env),subtle:(env.crypto??globalThis.crypto).subtle},controller.signal);if(version===epoch)status.textContent=`웹 전송·해시 확인 · ${checked.bytes} bytes · 기기 적용은 별도 확인`;}catch(error){if(version===epoch)status.textContent=error?.message==="DOWNLOAD_INTEGRITY_FAILED"?"무결성 확인 실패 · 자산 해시가 일치하지 않습니다.":"다운로드를 확인하지 못했습니다. 연결과 선택 배포를 확인한 뒤 다시 시도하세요.";}finally{if(version===epoch)download.disabled=false;}
    });row.append(download,status);
   }content.append(row);
  }
 }
 function renderSDK(content,input){
  const known=input.operations?.detections?.find(d=>d.appId===input.appId&&d.configSource==="flora.config.json"&&d.automationConfig)?.automationConfig;
  content.append(element("p",known?"인식된 설정을 사용합니다. 기존 파일을 덮어쓰지 말고 변경 내용을 확인하세요.":"아래 기본값은 사용자 선언입니다. 앱 entry·lockfile·지원 플랫폼을 확인한 뒤 생성하세요.","onboarding-note"));
  const form=element("form","","onboarding-config-form"),fields={};
  const add=(key,label,value,choices)=>{const row=element("label",label);const control=element(choices?"select":"input","");control.setAttribute("name",key);control.setAttribute("id","onboarding-"+key);if(choices)for(const choice of choices){const option=element("option",choice);option.value=choice;control.append(option);}else control.setAttribute("type","text");control.value=value;row.append(control);form.append(row);fields[key]=control;};
  add("runtime","Runtime version",known?.runtimeVersion??"native-1");add("channel","OTA channel",input.automation?.policy?.channel??"production");
  add("platforms","플랫폼",known?.platforms?.join(",")??"ios,android",["ios,android","ios","android"]);
  add("bundler","Export bundler",known?.bundler??"metro",["metro","expo"]);add("entry","앱 entry 파일",known?.entryFile??"index.js");
  add("node","Node 버전",known?.toolchain?.nodeVersion??"24.19.0");add("manager","Package manager",known?.toolchain?.packageManager?.name??"npm",["npm","pnpm","yarn"]);add("manager-version","Package manager 버전",known?.toolchain?.packageManager?.version??"10.9.8");
  const button=element("button","설정 확인·공개 파일 생성","button"),status=element("p","","subtle");button.setAttribute("type","submit");form.append(button,status);content.append(form);
  const downloads=element("div","");content.append(downloads);
  form.addEventListener("submit",async event=>{
   event.preventDefault();if(button.disabled)return;const version=epoch,app=input.appId;button.disabled=true;downloads.replaceChildren();
   try{
    const signing=await context.api(`/api/apps/${app}/signing-key`,"{}",controller?.signal);
    if(version!==epoch||!context.isCurrent()||context.getSnapshot().appId!==app)return;
    const files=buildPublicFiles({appId:app,origin:env.location?.origin,channel:fields.channel.value,runtimeVersion:fields.runtime.value,platforms:fields.platforms.value.split(","),bundler:fields.bundler.value,entryFile:fields.entry.value,nodeVersion:fields.node.value,packageManager:{name:fields.manager.value,version:fields["manager-version"].value}},{appId:signing?.appId,keyId:signing?.keyId,certificate:signing?.certificate??signing?.certificatePem});
    for(const [name,text] of [["flora.connection.json",files.connection],["flora.config.json",files.config]]){const link=element("a",name+" 다운로드","button secondary");link.setAttribute("download",name);link.setAttribute("href","data:application/json;charset=utf-8,"+encodeURIComponent(text));downloads.append(link);}
    status.textContent="공개 파일을 생성했습니다. 앱 저장소에 SDK·네이티브 연결과 함께 커밋하고, 첫 바이너리를 빌드한 뒤 소스를 동기화하세요. 아직 설치 완료가 아닙니다.";
   }catch{if(version===epoch)status.textContent="공개 설정을 만들지 못했습니다. 앱·runtime·도구 버전과 공개 서명 응답을 확인하세요.";}
   finally{if(version===epoch)button.disabled=false;}
  });
 }
 async function enter(appId){
  leave();currentApp=appId;const version=epoch;controller=new AbortController();const signal=controller.signal;
  const current=()=>version===epoch&&!signal.aborted&&context.isCurrent()&&!document.hidden&&context.getSnapshot().appId===appId;
  if(!current())return;
  node("onboarding-status").textContent="설치 상태를 확인하는 중…";
  try{
   connection=await context.api("/api/github/connection",undefined,signal);if(!current())return;
   if(typeof connection?.configured!=="boolean")throw Error("INVALID_CONNECTION");
   if(appId)await context.refreshData({operations:true,automation:true},signal);if(!current())return;
   await update();
  }catch(error){if(!current())return;if(error?.status===401){context.expire?.();return;}node("onboarding-status").textContent="설치 상태를 확인하지 못했습니다. 다시 확인해 주세요.";}
 }
 return {enter,leave,expire:leave,update};
}
