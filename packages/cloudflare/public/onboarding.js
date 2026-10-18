import {buildPublicFiles} from "./onboarding-files.js";
import {deriveOnboardingState} from "./onboarding-model.js";
const titles={owner:"관리자",github:"GitHub",sdk:"앱·SDK",runner:"PC Runner",publication:"첫 OTA"};
const labels={needed:"준비 필요",working:"진행 중",approval:"사용자 승인 대기",unknown:"확인 필요",verified:"확인됨",failed:"실패"};
export function createOnboarding(env,context){
 const document=env.document,node=id=>document.getElementById(id);
 let epoch=0,selected=null,controller=null,state=null,connection=null,currentApp=null;
 const element=(tag,text,className="")=>{const value=document.createElement(tag);value.textContent=text;value.className=className;return value;};
 function clear(){node("onboarding-content").replaceChildren();node("onboarding-steps").replaceChildren();node("onboarding-status").textContent="";}
 function leave(){epoch++;controller?.abort();controller=null;context.setActiveJobPolling(false);state=null;connection=null;clear();}
 function render(){
  if(!state||!context.isCurrent()||document.hidden)return;
  const input=context.getSnapshot();if(input.appId!==currentApp)return;
  if(!state.steps.some(s=>s.id===selected))selected=state.steps.find(s=>s.status!=="verified")?.id??"publication";
  node("onboarding-steps").replaceChildren(...state.steps.map(s=>{
   const button=element("button",titles[s.id]+" · "+labels[s.status],"onboarding-step");button.setAttribute("type","button");button.setAttribute("aria-current",s.id===selected?"step":"false");
   button.addEventListener("click",()=>{selected=s.id;render();node("onboarding-content").focus?.();});return button;
  }));
  const step=state.steps.find(s=>s.id===selected),content=node("onboarding-content");content.replaceChildren();
  content.append(element("p",labels[step.status],"onboarding-badge"),element("h2",titles[step.id]),element("p",step.reason,"onboarding-explanation"));
  const paths={owner:"/settings",github:"/projects/new",sdk:input.appId?`/apps/${input.appId}/source`:"/projects/new",runner:input.appId?`/apps/${input.appId}/runners`:"/projects",publication:input.appId?`/apps/${input.appId}/ota`:"/projects"};
  const link=element("a",({owner:"소유자 설정 보기",github:"GitHub 연결·프로젝트 등록",sdk:"앱·SDK 설정 열기",runner:"앱별 Runner 등록",publication:"OTA 배포 현황 열기"})[step.id],"button");link.setAttribute("href",paths[step.id]);
  link.addEventListener("click",event=>{if(event?.ctrlKey||event?.metaKey||event?.shiftKey||event?.altKey||event?.button)return;event?.preventDefault?.();if(step.id==="github")try{env.sessionStorage?.setItem("flora:onboarding-origin","onboarding");}catch{}context.navigate(paths[step.id]);});content.append(link);
  if(step.id==="sdk" && input.appId)renderSDK(content,input);
  const refresh=element("button","다시 확인","button secondary");refresh.setAttribute("type","button");refresh.addEventListener("click",()=>enter(currentApp));content.append(refresh);
  node("onboarding-status").textContent="현재 서버 정보로 확인했습니다. OTA 게시와 기기 적용은 따로 확인합니다.";
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
   state=deriveOnboardingState({...context.getSnapshot(),connection});render();
  }catch(error){if(!current())return;if(error?.status===401){context.expire?.();return;}node("onboarding-status").textContent="설치 상태를 확인하지 못했습니다. 다시 확인해 주세요.";}
 }
 return {enter,leave,expire:leave};
}
