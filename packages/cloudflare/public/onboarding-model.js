/** Evidence derived from current, scoped server responses; never persist completion flags. */
export function deriveOnboardingState(input) {
  const authenticated=input?.authenticated===true,appId=input?.appId??null;
  const step=(id,status,reason)=>({id,status,reason});
  if(!authenticated)return {steps:["owner","github","sdk","runner","publication"].map(id=>step(id,"needed","소유자 로그인이 필요합니다."))};
  const connection=input.connection,operations=input.operations,automation=input.automation;
  const linked=operations?.connection?.appId===appId?operations.connection:null;
  const detection=linked?operations.detections?.find(d=>d.appId===appId&&d.rootDirectory!==(undefined)&&["appId","version","installationId","owner","repository","ref"].every(k=>d.connection?.[k]===linked[k])&&d.detectedAt>=linked.connectedAt):null;
  let sdk=false;
  if(detection?.configSource==="flora.config.json" && detection.updatesEnabled && detection.automationConfig){
    const config=detection.automationConfig;
    try{sdk=config.updatesUrl===detection.updatesUrl && new URL(config.updatesUrl).pathname===`/updates/${appId}` && config.runtimeVersion===detection.runtimeVersion && Array.isArray(config.platforms) && config.platforms.length>0;}catch{}
  }
  const online=automation?.runners?.some(r=>r.revokedAt===null&&r.appIds?.length===1&&r.appIds[0]===appId&&r.presence?.status==="online"&&Number.isSafeInteger(r.presence?.lastSeenAt));
  return {steps:[step("owner","verified","현재 소유자 세션으로 확인했습니다."),
    step("github",connection?.configured===true?"verified":connection===null?"unknown":"needed",connection?.configured?"연결된 GitHub App을 재사용합니다. 저장소 권한은 앱 등록 단계에서 확인합니다.":"GitHub App 생성과 저장소 설치 승인을 진행하세요."),
    step("sdk",sdk?"verified":"needed",!appId?"프로젝트를 등록하거나 상단에서 앱을 선택하세요.":sdk?"현재 저장소에서 앱별 Flora 설정을 인식했습니다.":"공개 SDK 설정을 앱에 커밋하고 소스를 동기화하세요. 첫 네이티브 바이너리 준비도 필요합니다."),
    step("runner",online?"verified":"needed",online?"이 앱 하나에 연결된 Runner의 현재 온라인 상태를 확인했습니다.":"앱 전용 Runner를 등록하고 PC에서 실행하세요."),
    step("publication","needed","검증할 커밋과 모든 선택 플랫폼의 실제 배포를 확인하세요.")]};
}
