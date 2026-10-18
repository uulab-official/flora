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
  link.addEventListener("click",event=>{if(event?.ctrlKey||event?.metaKey||event?.shiftKey||event?.altKey||event?.button)return;event?.preventDefault?.();context.navigate(paths[step.id]);});content.append(link);
  const refresh=element("button","다시 확인","button secondary");refresh.setAttribute("type","button");refresh.addEventListener("click",()=>enter(currentApp));content.append(refresh);
  node("onboarding-status").textContent="현재 서버 정보로 확인했습니다. OTA 게시와 기기 적용은 따로 확인합니다.";
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
