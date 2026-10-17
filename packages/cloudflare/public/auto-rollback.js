import { adminPath } from "./admin-routes.js";
const uuid = v => typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const count = v => Number.isSafeInteger(v) && v >= 0;
const safe = (v, max = 160) => typeof v === "string" && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(v);
const channel = v => safe(v,128) && v.trim().length > 0;
const percent = v => Number.isSafeInteger(v) && v >= 1 && v <= 100;
const smallSample = p => p && Number.isSafeInteger(p.minInstallations) && p.minInstallations >= 1 && p.minInstallations < 5;
const safeSample = p => !smallSample(p) || p.failureRatePercent === 100;
const time = v => new Date(v).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) + " KST";
const states = { queued: "자동 롤백 대기", executing: "자동 롤백 게시 중", retrying: "자동 롤백 재시도 대기", succeeded: "자동 롤백 게시 완료", skipped: "자동 롤백 건너뜀", failed: "자동 롤백 게시 실패" };
function validCancellation(d) {
  if(d.cancellation === undefined)return true;
  const c=d.cancellation;
  if(!c||typeof c !== "object"||Array.isArray(c)||d.status !== "skipped"||d.lastErrorCode !== "AUTO_ROLLBACK_RECOVERED"||d.rollbackDeploymentId !== null)return false;
  const fields=["checkedAt","attemptedInstallations","failedInstallations","confirmedHealthyInstallations","failureRatePercent"];
  if(Object.keys(c).length !== fields.length||!fields.every(key=>Object.hasOwn(c,key))||![c.checkedAt,c.attemptedInstallations,c.failedInstallations,c.confirmedHealthyInstallations].every(count))return false;
  if(c.checkedAt>8_640_000_000_000_000||c.checkedAt<d.triggeredAt||c.checkedAt>d.updatedAt||c.failedInstallations>c.attemptedInstallations||c.confirmedHealthyInstallations>c.attemptedInstallations-c.failedInstallations)return false;
  if(c.attemptedInstallations===0)return c.failureRatePercent===null;
  return Number.isFinite(c.failureRatePercent)&&c.failureRatePercent>=0&&c.failureRatePercent<=100&&Math.abs(c.failureRatePercent-c.failedInstallations*100/c.attemptedInstallations)<=1e-9;
}
export function validateAutomaticRollbackDecision(d, appId) {
  if(d?.confirmationDelaySeconds !== undefined && d.confirmationDelaySeconds !== 120)return false;
  if(d && !validCancellation(d))return false;
  return d && safe(d.id, 200) && d.appId === appId && [d.sourceDeploymentId,d.targetDeploymentId].every(uuid) && ["ios","android"].includes(d.platform) && channel(d.channel) && safe(d.runtimeVersion,256) && count(d.policyVersion) && d.policyVersion > 0 && Object.hasOwn(states,d.status) && [d.attemptedInstallations,d.failedInstallations,d.triggeredAt,d.updatedAt].every(count) && d.failedInstallations <= d.attemptedInstallations && Number.isFinite(d.failureRatePercent) && d.failureRatePercent >= 0 && d.failureRatePercent <= 100 && (d.rollbackDeploymentId === null || uuid(d.rollbackDeploymentId)) && (d.lastErrorCode === null || /^[A-Z][A-Z0-9_]{0,99}$/.test(d.lastErrorCode)) && safe(d.reason,1000);
}
export function validateRollbackPolicy(value, appId) {
  if (!value || value.appId !== appId || value.eligibleInstallations !== undefined && !count(value.eligibleInstallations) || !Array.isArray(value.decisions) || value.decisions.length > 20 || !value.decisions.every(d => validateAutomaticRollbackDecision(d,appId))) return false;
  if(value.installationHistory !== undefined && (!Array.isArray(value.installationHistory)||value.installationHistory.length>20||!value.installationHistory.every(change=>change&&safe(change.id,200)&&safe(change.installationLabel,80)&&typeof change.enabled === "boolean"&&(change.previousEnabled===null||typeof change.previousEnabled === "boolean")&&count(change.changedAt))))return false;
  const p = value.policy;
  return p === null || p && p.appId === appId && count(p.version) && p.version > 0 && typeof p.enabled === "boolean" && percent(p.failureRatePercent) && count(p.minInstallations) && p.minInstallations >= 1 && p.minInstallations <= 10000 && count(p.windowMinutes) && p.windowMinutes >= 1 && p.windowMinutes <= 1440 && channel(p.channel) && p.targets && ["ios","android"].every(os => p.targets[os] === null || uuid(p.targets[os])) && count(p.updatedAt);
}
export function eligibleRollbackTargets(values, appId, selectedChannel, os) {
  const scoped = (Array.isArray(values) ? values : []).filter(d => d.appId === appId && d.platform === os && d.channel === selectedChannel && uuid(d.id) && safe(d.runtimeVersion,256) && count(d.createdAt));
  const head = [...scoped].sort((a,b) => b.createdAt-a.createdAt || b.id.localeCompare(a.id))[0];
  return scoped.filter(d => d.runtimeVersion === head?.runtimeVersion && d.telemetry?.appliedInstallations >= 1 && d.telemetry?.restartedInstallations >= 1 && d.telemetry?.failedInstallations === 0 && d.telemetry?.rolledBackInstallations === 0).sort((a,b) => b.createdAt-a.createdAt);
}
export function renderAutomaticRollbackDecision(document, appId, d) {
  const el=(tag,text,css="")=>{const n=document.createElement(tag);n.className=css;if(text!==undefined)n.textContent=String(text);return n;};
  const row=el("section",undefined,"record automatic-rollback-decision");
  if(!validateAutomaticRollbackDecision(d,appId))return row;
  const link=(label,id)=>{const n=el("a",label,"button secondary small");n.setAttribute("href",adminPath("ota-detail",appId,id));return n;};
  const guarded = d.confirmationDelaySeconds === 120 && smallSample(d.policy) && safeSample(d.policy);
  const confirmingAgain = guarded && d.status === "executing" && d.lastErrorCode === "AUTO_ROLLBACK_CONFIRMATION_PENDING";
  const status = d.lastErrorCode === "AUTO_ROLLBACK_ACCOUNTING_CAPACITY" ? "집계 용량 부족으로 자동 롤백 중단" : d.lastErrorCode === "AUTO_ROLLBACK_RECOVERED" ? "실패 기준 미충족으로 자동 롤백 취소" : confirmingAgain ? "새 실패의 2분 확인 대기" : guarded && d.status === "queued" ? "2분 복구 확인 대기" : states[d.status];
  row.append(el("h4",`${d.platform === "ios"?"iOS":"Android"} · ${d.channel} · ${status}`),el("p",`최초 감지 ${time(d.triggeredAt)} · 실패 ${d.failedInstallations} / ${d.attemptedInstallations}개 설치 · ${d.failureRatePercent.toFixed(1)}%`),el("p",d.reason),el("p",`Runtime ${d.runtimeVersion} · 설정 버전 ${d.policyVersion}`,"subtle"),el("p","실패율과 정상 실행 수는 소유자가 자동 롤백 판단에 허용한 설치 기준입니다. SDK 누적 현황에는 허용하지 않은 설치의 보고도 포함됩니다.","subtle"));
  if(d.lastErrorCode)row.append(el("p",`결과 코드 · ${d.lastErrorCode}`,"record-code"));
  if(d.lastErrorCode === "AUTO_ROLLBACK_RECOVERED")row.append(el("p","정상 보고 또는 추가 설치 보고로 기준이 더 이상 충족되지 않아 게시를 취소했습니다. 취소 상태만으로 정상 적용·재시작을 확인했다고 해석하지 않습니다. 기존 실패 보고와 최초 판단 사유는 이력에 보존됩니다.","subtle"));
  if(d.cancellation){const c=d.cancellation;row.append(el("p",`취소 시 재확인 · 실패 ${c.failedInstallations} / ${c.attemptedInstallations}개 설치 · ${c.failureRatePercent===null?"실패율 미확인":c.failureRatePercent.toFixed(1)+"%"}`,"automatic-rollback-cancellation-counts"),el("p",`재확인 시각 ${time(c.checkedAt)}`,"subtle"),el("p",`동일 배포의 정상 실행 확인 ${c.confirmedHealthyInstallations}개 · 최초 실패 설치의 회복을 뜻하지 않습니다.`,"subtle"));if(c.confirmedHealthyInstallations===0)row.append(el("p","이 재확인에는 정상 실행이 확인된 설치가 없습니다.","subtle"));}
  if(d.lastErrorCode === "AUTO_ROLLBACK_ACCOUNTING_CAPACITY")row.append(el("p","새 보고를 온전히 집계할 수 없어 안전을 위해 게시를 중단했습니다. 기존 이력은 보존됩니다.","subtle"));
  if(d.status === "retrying" && count(d.nextAttemptAt))row.append(el("p",`다음 재시도 ${time(d.nextAttemptAt)} · 시도 ${d.attemptCount??0}회`,"subtle"));
  if(guarded && (d.status === "queued" || confirmingAgain) && count(d.nextAttemptAt))row.append(el("p",`확인 예정 ${time(d.nextAttemptAt)} · 2분 뒤에도 실패 기준이 유지되는지 확인합니다. 같은 배포의 정상 보고 또는 추가 설치 보고로 실패 기준을 충족하지 않게 되면 취소합니다.`,"subtle"));
  row.append(link("실패 감지 배포",d.sourceDeploymentId),link("정상 복원 원본",d.targetDeploymentId));
  if(d.rollbackDeploymentId)row.append(link("자동 롤백 배포·기기 상세",d.rollbackDeploymentId),el("p","게시 결과입니다. 기기 적용은 새 배포의 상세 이력에서 확인하세요.","subtle"));
  row.append(el("p","SDK 보고를 기준으로 한 서버 자동 롤백 판단입니다. 네이티브 엔진의 자동 복구와 구분됩니다.","subtle"));
  return row;
}
/** Policy and decision reads occur on OTA page entry or explicit refresh only. */
export function createAutoRollback(env, options) {
  const { document } = env, root = document.getElementById("auto-rollback-policy");
  let scope = null, epoch = 0, current = null, form = null, deployments = [], loading = false, saving = false, stale = false, message = "";
  const el = (tag, content, css = "") => { const n = document.createElement(tag); n.className = css; if(content !== undefined)n.textContent = String(content); return n; };
  const button = (label, action, disabled=false) => { const n=el("button",label,"button secondary small"); n.type="button"; n.disabled=disabled; n.addEventListener("click",action); return n; };
  const active = () => scope && options.active() && options.route().page === "ota" && options.route().appId === scope;
  const path = appId => `/api/apps/${encodeURIComponent(appId)}/ota/rollback-policy`;
  function draft() { const p=current?.policy; return { enabled:p?.enabled ?? false, failureRatePercent:p?.failureRatePercent ?? 10, minInstallations:p?.minInstallations ?? 20, windowMinutes:p?.windowMinutes ?? 30, channel:p?.channel ?? deployments[0]?.channel ?? "production", targets:{ios:p?.targets.ios ?? null,android:p?.targets.android ?? null} }; }
  function field(label, key, type="number") {
    const wrap=el("label",label,"field"), input=el("input"); input.setAttribute("aria-label",label); input.type=type; input.disabled=loading||saving;
    if(type === "checkbox")input.checked=form[key];else input.value=String(form[key]);
    if(type === "number") { input.min="1"; input.max=key === "failureRatePercent"?"100":key === "windowMinutes"?"1440":"10000"; }
    input.addEventListener(type === "checkbox"?"change":"input",()=>{form[key]=type === "checkbox"?input.checked:type === "number"?Number(input.value):input.value;});
    if(key === "channel") input.addEventListener("change",()=>{form.channel=input.value.trim();form.targets={ios:null,android:null};render();});
    wrap.append(input);return wrap;
  }
  function target(os) {
    const label=os === "ios"?"iOS 정상 복원 배포":"Android 정상 복원 배포",wrap=el("label",label,"field"),select=el("select");select.setAttribute("aria-label",label);select.disabled=loading||saving;
    const empty=el("option","자동 롤백 대상 없음");empty.value="";select.append(empty);
    const eligible=eligibleRollbackTargets(deployments,scope,form.channel,os);
    for(const d of eligible){const n=el("option",`${time(d.createdAt)} · Runtime ${d.runtimeVersion} · ${d.commitSha?.slice(0,8) ?? "커밋 미기록"}`);n.value=d.id;select.append(n);}
    if(form.targets[os] && !eligible.some(d=>d.id===form.targets[os])){const n=el("option","저장된 복원 대상 · 현재 조회 범위에서 정상 여부 재확인 필요");n.value=form.targets[os];select.append(n);}
    select.value=form.targets[os]??"";select.addEventListener("change",()=>{form.targets[os]=select.value||null;});wrap.append(select);return wrap;
  }
  function render() {
    if(!root||!active())return;
    const section=el("section",undefined,"card automatic-rollback-panel");section.append(el("h2","실패율 기준 자동 롤백"),el("p","SDK 자체 보고 설치 기준입니다. 중복 설치 보고는 한 번만 집계하고 적용·실행 실패와 네이티브 자동 복구를 감지합니다. 업데이트 확인·다운로드의 네트워크 실패는 기준에 포함하지 않습니다.","subtle"));
    section.append(el("p","실패율의 분모는 적용·실행을 시도한 보고 설치 수입니다. 설정 저장 이후 게시된 신규 배포를 SDK 보고가 도착할 때 평가합니다. 보고되지 않은 크래시는 감지하지 못하며, 앱·플랫폼·채널·Runtime별 정상 복원 대상을 사용합니다. 배포당 한 번만 실행합니다.","subtle"));
    if(current) {
      section.append(el("p",`자동 롤백 판단에 허용한 설치 ${current.eligibleInstallations??0}개 · 앱 전체 합계이며 플랫폼별 설치 수가 아닙니다. iOS·Android는 각각 최소 표본을 충족해야 합니다.`,"automatic-rollback-eligible-count"));
      section.append(el("p","OTA 배포의 기기별 적용 현황에서 직접 검증한 설치를 선택해 ‘자동 롤백 판단에 허용’을 눌러 주세요. 소유자가 명시적으로 허용한 설치의 보고만 자동 판단에 사용합니다. 허용 설치 변경 이후 새로 게시한 배포부터 평가합니다. 일반 익명 보고는 적용 현황에 계속 표시됩니다.","subtle"));
      if(!(current.eligibleInstallations>0))section.append(el("p","허용한 설치가 없어 자동 롤백이 실행되지 않습니다. 정책을 저장한 뒤 판단에 사용할 설치를 먼저 허용하세요.","notice"));
    }
    if(current?.policy?.enabled && !safeSample(current.policy))section.append(el("p","저장된 이전 소규모 설정을 표시합니다. 켠 상태로 다시 저장하려면 최소 1~4개 설치의 실패율을 100%로 바꿔 주세요. 자동 롤백 사용을 끄는 저장은 기존 값 그대로 가능합니다.","notice"));
    if(current?.capacityLimited)section.append(el("p","자동 롤백 집계 보관 한도에 도달했습니다. 추가 감지가 제한되며 기존 설정·판단·SDK 이력은 보존됩니다.","notice notice-error"));
    if(message)section.append(el("p",message,stale?"notice notice-error":"notice"));
    if(loading&&!form)section.append(el("p","자동 롤백 설정을 확인하는 중…","subtle"));
    if(form){const fields=el("div",undefined,"application-form");fields.append(field("자동 롤백 사용","enabled","checkbox"),field("배포 채널","channel","text"),field("실패율 기준 (%)","failureRatePercent"),field("최소 보고 설치 수","minInstallations"),field("관찰 기간 (분)","windowMinutes"),target("ios"),target("android"));section.append(fields,el("p","기본 기준은 실패율 10% · 최소 20개 설치 · 게시 후 30분입니다. 정상 적용·재시작이 보고되고 실패·네이티브 롤백이 없는 배포를 복원 대상으로 지정하세요.","subtle"));
      section.append(el("h3","소규모 앱 보호 · 최소 1~4개 설치"),el("p","최소 1~4개 설치에서는 실패율 100%가 필수입니다. 표본이 작으면 한 번의 중단도 크게 반영되므로, 일반 적용·실행 실패는 자동 롤백을 유발하지 않습니다. activation_requested 이후 네이티브가 launch 단계의 UNCONFIRMED_LAUNCH로 복구했다고 보고한 경우만 실패로 판단합니다.","subtle"),el("p","2분 복구 확인 후에도 실패 기준이 유지될 때 실행합니다. 같은 배포에서 정상 적용 실행 확인 또는 재시작 확인 보고를 받으면 취소합니다. 네트워크·다운로드 실패, 일반 실패와 중복 보고는 이 보호 모드의 트리거가 아닙니다. 소유자가 직접 확인해 허용한 설치만 판단하며 기기 attestation을 뜻하지 않습니다.","subtle"),button("소규모 앱 보호 기준 사용 · 1개·100%",()=>{if(loading||saving||stale||!active())return;form.minInstallations=1;form.failureRatePercent=100;message="소규모 앱 보호 기준을 입력했습니다. 설정 저장을 눌러 적용하세요.";render();},loading||saving||stale),button(saving?"설정 저장 중…":"자동 롤백 설정 저장",save,loading||saving||stale));}
    section.append(button(stale?"최신 설정 다시 불러오기":"설정·감지 이력 새로고침",()=>load(true),loading||saving));
    const log=el("section",undefined,"automatic-rollback-decisions");log.append(el("h3","자동 롤백 감지·실행 이력"));
    if(!current?.decisions.length)log.append(el("p",current?"기록된 자동 롤백 판단 없음":"이력 미확인","subtle"));
    for(const d of current?.decisions??[])log.append(renderAutomaticRollbackDecision(document,scope,d));
    if(current?.installationHistory?.length){const history=el("details",undefined,"technical-details");history.append(el("summary","판단 설치 허용·해제 이력 · 최근 20건"));for(const change of current.installationHistory)history.append(el("p",`${time(change.changedAt)} · ${change.installationLabel} · ${change.enabled?"소유자 허용":"허용 해제"}`));log.append(history);}
    section.append(log,el("p","최근 20건 · 화면 진입 또는 새로고침 시 조회 · 자동 조회 없음","subtle"));root.replaceChildren(section);
  }
  async function load(force=false) {
    if(!active()||loading||saving)return;const appId=scope,requestEpoch=epoch;loading=true;message="";render();
    try{const result=await options.api(path(appId));if(!validateRollbackPolicy(result,appId))throw Error("INVALID_ROLLBACK_POLICY");if(requestEpoch!==epoch||!active())return;current=result;if(force||!form)form=draft();stale=false;}
    catch(e){if(requestEpoch!==epoch||!active())return;if(e.status===401){options.expire();return;}message="자동 롤백 설정을 확인하지 못했습니다. 기존 설정과 이력은 유지됩니다.";}
    finally{if(requestEpoch===epoch&&active()){loading=false;render();}}
  }
  async function save() {
    if(!active()||!current||!form||saving||loading||stale)return;
    if(!channel(form.channel)||!percent(form.failureRatePercent)||!Number.isSafeInteger(form.minInstallations)||form.minInstallations<1||form.minInstallations>10000||!Number.isSafeInteger(form.windowMinutes)||form.windowMinutes<1||form.windowMinutes>1440||form.enabled&&!form.targets.ios&&!form.targets.android){message="배포 채널·실패율·최소 설치 수·관찰 기간과 정상 복원 대상을 확인하세요.";render();return;}
    if(form.enabled&&!safeSample(form)){message="최소 1~4개 설치에서는 실패율 기준을 100%로 설정해야 합니다. 입력은 유지됩니다.";render();return;}
    const appId=scope,requestEpoch=epoch,body={expectedVersion:current.policy?.version??0,...form,targets:{...form.targets}};saving=true;message="";render();
    try{const result=await options.api(path(appId),JSON.stringify(body));if(!validateRollbackPolicy(result,appId))throw Error("INVALID_ROLLBACK_POLICY");if(requestEpoch!==epoch||!active())return;current=result;form=draft();message="자동 롤백 설정을 저장했습니다.";}
    catch(e){if(requestEpoch!==epoch||!active())return;if(e.status===401){options.expire();return;}if(e.status===409){stale=true;message="설정 또는 정상 복원 배포가 다른 곳에서 변경되었습니다. 입력은 보존했습니다. 최신 설정을 확인한 뒤 다시 저장하세요.";}else message="설정을 저장하지 못했습니다. 입력과 기존 이력은 유지됩니다. 연결과 정상 복원 대상을 확인하세요.";}
    finally{if(requestEpoch===epoch&&active()){saving=false;render();}}
  }
  function leave(){++epoch;scope=null;current=null;form=null;deployments=[];loading=false;saving=false;stale=false;message="";root?.replaceChildren();}
  return {async open(appId,values){leave();scope=appId;deployments=(values??[]).filter(d=>d.appId===appId);await load();},leave,clear:leave};
}
