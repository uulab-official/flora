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
    try{
      const destination=new URL(config.updatesUrl),server=new URL(input.origin),query=[...destination.searchParams];
      const channel=query.length===0 || query.length===1 && query[0][0]==="channel" && query[0][1]===input.automation?.policy?.channel;
      sdk=server.origin===input.origin && server.protocol==="https:" && destination.origin===server.origin && !destination.username && !destination.password && !destination.hash && destination.href===config.updatesUrl && channel && config.updatesUrl===detection.updatesUrl && destination.pathname===`/updates/${appId}` && config.runtimeVersion===detection.runtimeVersion && Array.isArray(config.platforms) && config.platforms.length>0;
    }catch{}
  }
  const online=automation?.runners?.some(r=>r.revokedAt===null&&r.appIds?.length===1&&r.appIds[0]===appId&&r.presence?.status==="online"&&Number.isSafeInteger(r.presence?.lastSeenAt));
  return {steps:[step("owner","verified","현재 소유자 세션으로 확인했습니다."),
    step("github",connection?.configured===true?"verified":connection===null?"unknown":"needed",connection?.configured?"연결된 GitHub App을 재사용합니다. 저장소 권한은 앱 등록 단계에서 확인합니다.":"GitHub App 생성과 저장소 설치 승인을 진행하세요."),
    step("sdk",sdk?"verified":"needed",!appId?"프로젝트를 등록하거나 상단에서 앱을 선택하세요.":sdk?"현재 저장소에서 앱별 Flora 설정을 인식했습니다.":"공개 SDK 설정을 앱에 커밋하고 소스를 동기화하세요. 첫 네이티브 바이너리 준비도 필요합니다."),
    step("runner",online?"verified":"needed",online?"이 앱 하나에 연결된 Runner의 현재 온라인 상태를 확인했습니다.":"앱 전용 Runner를 등록하고 PC에서 실행하세요."),
    step("publication","needed","검증할 커밋과 모든 선택 플랫폼의 실제 배포를 확인하세요.")]};
}

export function freezePublicationTarget(input){
 const keys=["appId","commitSha","channel","runtimeVersion","platforms"];
 if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).length!==keys.length||keys.some(k=>!Object.hasOwn(input,k))||["appId","commitSha","channel","runtimeVersion"].some(k=>typeof input[k]!=="string")||!/^[a-z][a-z0-9_-]{2,95}$/.test(input.appId??"")||!/^[a-f0-9]{40}$/.test(input.commitSha??"")||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.channel??"")||typeof input.runtimeVersion!=="string"||!input.runtimeVersion||new TextEncoder().encode(input.runtimeVersion).length>128||/[\u0000-\u001f\u007f]/.test(input.runtimeVersion)||!Array.isArray(input.platforms)||input.platforms.length<1||input.platforms.length>2||new Set(input.platforms).size!==input.platforms.length||input.platforms.some(p=>!["ios","android"].includes(p)))throw Error("ONBOARDING_TARGET_INVALID");
 return Object.freeze({appId:input.appId,commitSha:input.commitSha,channel:input.channel,runtimeVersion:input.runtimeVersion,platforms:Object.freeze([...input.platforms])});
}
export function evaluatePublications(input,jobs,publications){
 const target=freezePublicationTarget(input),matches=(value,platform)=>value?.appId===target.appId&&value.commitSha===target.commitSha&&value.channel===target.channel&&value.runtimeVersion===target.runtimeVersion&&value.platform===platform;
 const platforms=target.platforms.map(platform=>{
  const candidates=jobs.filter(job=>matches(job,platform)&&job.state==="succeeded"&&typeof job.id==="string"&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(job.deploymentId??""));
  for(const job of candidates){
   const publication=publications.find(p=>p.appId===target.appId&&p.deploymentId===job.deploymentId&&p.deployment?.id===job.deploymentId&&matches({appId:p.appId,...p.deployment},platform));
   if(publication)return {platform,jobId:job.id,deploymentId:job.deploymentId,verified:true};
  }
  return {platform,jobId:candidates[0]?.id??null,deploymentId:candidates[0]?.deploymentId??null,verified:false};
 });
 const count=platforms.filter(p=>p.verified).length;
 return {status:count===platforms.length?"published":count?"partial":"waiting",platforms};
}
