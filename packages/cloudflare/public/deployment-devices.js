import { adminPath } from "./admin-routes.js";
import { isValidSdkTelemetry, isValidSdkIssueResolution } from "./project-views.js";
import { validateAutomaticRollbackDecision, renderAutomaticRollbackDecision } from "./auto-rollback.js";
const environments = { "physical-device": "실기기", "android-emulator": "Android 에뮬레이터", "ios-simulator": "iOS 시뮬레이터", unknown: "환경 미확인" };
const failures = { NETWORK_UNAVAILABLE: "네트워크 연결 실패", TIMEOUT: "응답 시간 초과", SIGNATURE_INVALID: "서명 검증 실패", ASSET_HASH_MISMATCH: "파일 무결성 불일치", UPDATE_INCOMPATIBLE: "Runtime 호환 불가", UNCONFIRMED_LAUNCH: "실행 확인 실패", STORED_UPDATE_INVALID: "저장 업데이트 검증 실패", NATIVE_OPERATION_FAILED: "네이티브 작업 실패", CHECK_FAILED: "업데이트 확인 실패", DOWNLOAD_FAILED: "다운로드 실패", ACTIVATION_FAILED: "적용 실패", LAUNCH_CONFIRMATION_FAILED: "재시작 확인 실패", UNKNOWN: "원인 미확인" };
const stages = { check: "확인", download: "다운로드", activation: "적용", launch: "실행" };
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const validRollback = value => value && uuid(value.fromDeploymentId) && uuid(value.targetDeploymentId) && text(value.reason, 500) && timestamp(value.requestedAt);
const eventLabels = { update_seen: "업데이트 확인", downloaded: "다운로드 완료", activation_requested: "적용 요청", launch_confirmed: "적용 실행 확인", restart_confirmed: "재시작 확인", failed: "실패", rolled_back: "네이티브 자동 롤백" };
const time = value => value === null ? "미기록" : new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "medium", timeZone: "Asia/Seoul" }).format(value) + " KST";
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const opaque = value => typeof value === "string" && /^[A-Za-z0-9_.-]{16,2048}$/.test(value);
const text = (value, max = 160) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value);
function validIssueResolution(value, deploymentId) {
  const proof = value.issueResolution;
  const rollbackFailure = value.rollbackFailure;
  if (rollbackFailure !== undefined && (!rollbackFailure || !uuid(rollbackFailure.deploymentId) || rollbackFailure.deploymentId === deploymentId || !timestamp(rollbackFailure.observedAt) || rollbackFailure.observedAt <= 0 || !timestamp(value.firstFailureAt) || rollbackFailure.observedAt <= value.firstFailureAt || !["unresolved", "resolved"].includes(value.issueStatus) || !(value.failed || value.rolledBack) || (rollbackFailure.stage === undefined ? rollbackFailure.code !== undefined : !Object.hasOwn(stages, rollbackFailure.stage) || !Object.hasOwn(failures, rollbackFailure.code)))) return false;
  if (proof !== undefined && (!proof || !["same-deployment", "rollback"].includes(proof.kind) || !uuid(proof.deploymentId) || ![proof.confirmedAt, proof.restartedAt].every(at => timestamp(at) && at > 0 && (value.firstFailureAt === null || timestamp(value.firstFailureAt) && at > value.firstFailureAt)))) return false;
  if (rollbackFailure && value.issueStatus === "resolved" && !(proof ? [proof.confirmedAt, proof.restartedAt] : [value.latestConfirmedAt, value.latestRestartAt]).every(at => timestamp(at) && at > rollbackFailure.observedAt)) return false;
  if (proof?.kind === "rollback" && (proof.deploymentId === deploymentId || value.issueStatus !== "resolved")) return false;
  if (proof?.kind === "same-deployment" && (proof.deploymentId !== deploymentId || proof.confirmedAt !== value.latestConfirmedAt || proof.restartedAt !== value.latestRestartAt || value.issueStatus !== "resolved")) return false;
  if (value.issueStatus === undefined) return proof === undefined;
  if (!["none", "unresolved", "resolved"].includes(value.issueStatus) || (value.issueStatus === "none" ? value.failed || value.rolledBack : !value.failed && !value.rolledBack)) return false;
  if (value.issueStatus !== "resolved") return proof === undefined;
  if (value.issueOrderKnown !== true) return false;
  if (proof?.kind === "rollback") return true;
  return value.applied && value.restarted && [value.latestConfirmedAt, value.latestRestartAt].every(at => timestamp(at) && at > 0 && (value.firstFailureAt === null || timestamp(value.firstFailureAt) && at > value.firstFailureAt));
}
function validInstallation(value, platform, deploymentId) {
  return value && (value.issueOrderKnown === undefined || typeof value.issueOrderKnown === "boolean") && validIssueResolution(value, deploymentId) && (value.automaticRollbackEligible === undefined || typeof value.automaticRollbackEligible === "boolean") && opaque(value.id) && text(value.label, 80) && Object.hasOwn(environments, value.environment) && !(platform === "ios" && value.environment === "android-emulator" || platform === "android" && value.environment === "ios-simulator") && (!value.recovered || (value.failed || value.rolledBack) && value.applied && value.restarted) && ["downloaded", "applied", "restarted", "failed", "rolledBack", "recovered"].every(key => typeof value[key] === "boolean") && timestamp(value.lastReportedAt) && ["firstFailureAt", "latestConfirmedAt", "latestRestartAt"].every(key => value[key] === null || timestamp(value[key])) && value.history && typeof value.history.complete === "boolean" && [null,"legacy","capacity"].includes(value.history.reason) && [value.history.recordedEvents,value.history.omittedEvents].every(timestamp) && (value.history.startedAt === null || timestamp(value.history.startedAt)) && Array.isArray(value.failures) && value.failures.length <= 52 && value.failures.every(item => item && Object.hasOwn(stages, item.stage) && Object.hasOwn(failures, item.code));
}
export function validateDeploymentDevices(value, appId, deploymentId, installationId = null, expectedFilter = "all") {
  if (!value || value.appId !== appId || value.deploymentId !== deploymentId || value.source !== "sdk-self-report" || !timestamp(value.observedAt) || value.pageSize !== 20 || value.nextCursor !== null && !opaque(value.nextCursor)) return false;
  const d = value.deployment;
  if (!d || d.id !== deploymentId || !["ios", "android"].includes(d.platform) || !text(d.channel, 128) || !text(d.runtimeVersion, 256) || !timestamp(d.createdAt) || d.commitSha !== null && !/^[a-f0-9]{40}$/.test(d.commitSha ?? "")) return false;
  if (d.rollback !== undefined && !validRollback(d.rollback)) return false;
  if (value.automaticRollback != null && (!validateAutomaticRollbackDecision(value.automaticRollback, appId) || ![value.automaticRollback.sourceDeploymentId,value.automaticRollback.rollbackDeploymentId].includes(deploymentId) || value.automaticRollback.platform !== d.platform || value.automaticRollback.channel !== d.channel || value.automaticRollback.runtimeVersion !== d.runtimeVersion)) return false;
  if (installationId) return validInstallation(value.installation, d.platform, deploymentId) && value.installation.id === installationId && Array.isArray(value.events) && value.events.length <= 20 && value.events.every(item => item && Object.hasOwn(eventLabels, item.type) && timestamp(item.observedAt) && timestamp(item.receivedAt) && (item.stage === undefined || Object.hasOwn(stages,item.stage)) && (item.code === undefined || Object.hasOwn(failures,item.code)));
  if (!["all", "issues", "unresolved", "resolved"].includes(expectedFilter) || (expectedFilter !== "all" ? value.filter !== expectedFilter : value.filter !== undefined)) return false;
  return (value.summary === null || isValidSdkTelemetry(value.summary, d.platform) && (value.summary.issueResolution === undefined || isValidSdkIssueResolution(value.summary))) && Array.isArray(value.installations) && value.installations.length <= 20 && value.installations.every(item => validInstallation(item, d.platform, deploymentId) && (expectedFilter === "all" || expectedFilter === "issues" ? expectedFilter === "all" || item.failed || item.rolledBack : item.issueStatus === expectedFilter)) && new Set(value.installations.map(item => item.id)).size === value.installations.length;
}
const journeyReasons = { legacy: "과거 일부 세부 이벤트 미기록", capacity: "보관 한도로 일부 이벤트 생략", missing: "해당 배포의 설치 보고 미기록", lineage: "롤백 연결 일부 미확인" };
const journeyKey = item => item.id;
export function validateDeploymentJourney(value, appId, deploymentId, installationId, expectedDeployment = null) {
  if (!value || value.appId !== appId || value.deploymentId !== deploymentId || value.source !== "sdk-self-report" || !timestamp(value.observedAt) || value.pageSize !== 20 || value.nextCursor !== null && !opaque(value.nextCursor)) return false;
  const installation = value.installation, history = value.history;
  if (!installation || installation.id !== installationId || !opaque(installation.id) || !text(installation.label, 80) || !Object.hasOwn(environments, installation.environment) || !history || typeof history.complete !== "boolean" || !Array.isArray(history.reasons) || history.reasons.length > 4 || new Set(history.reasons).size !== history.reasons.length || !history.reasons.every(reason => Object.hasOwn(journeyReasons, reason)) || history.complete !== (history.reasons.length === 0)) return false;
  if (!Array.isArray(value.deployments) || value.deployments.length < 1 || value.deployments.length > 33) return false;
  const deployments = new Map();
  for (const d of value.deployments) {
    if (!d || !uuid(d.id) || deployments.has(d.id) || !["ios", "android"].includes(d.platform) || !text(d.channel,128) || !text(d.runtimeVersion,256) || !timestamp(d.createdAt) || d.createdAt > value.observedAt || d.commitSha !== null && !/^[a-f0-9]{40}$/.test(d.commitSha ?? "") || d.rollback !== undefined && (!validRollback(d.rollback) || d.rollback.fromDeploymentId === d.id || d.rollback.targetDeploymentId === d.id) || !d.history || typeof d.history.complete !== "boolean" || ![null,"legacy","capacity","missing"].includes(d.history.reason) || ![d.history.recordedEvents,d.history.omittedEvents].every(timestamp) || d.history.startedAt !== null && !timestamp(d.history.startedAt)) return false;
    deployments.set(d.id,d);
  }
  const anchor = deployments.get(deploymentId);
  if (!anchor || [...deployments.values()].some(d => ["platform","channel","runtimeVersion"].some(key => d[key] !== anchor[key])) || expectedDeployment && ["platform","channel","runtimeVersion","createdAt"].some(key => anchor[key] !== expectedDeployment[key]) || anchor.platform === "ios" && installation.environment === "android-emulator" || anchor.platform === "android" && installation.environment === "ios-simulator") return false;
  if (value.rootDeploymentId !== null && (!uuid(value.rootDeploymentId) || !deployments.has(value.rootDeploymentId))) return false;
  if (value.rootDeploymentId === null && !history.reasons.includes("lineage")) return false;
  for (const d of deployments.values()) {
    let current = d, depth = 0; const visited = new Set();
    while (current.rollback) {
      if (++depth > 32 || visited.has(current.id)) return false;
      visited.add(current.id); const parent = deployments.get(current.rollback.fromDeploymentId);
      if (!parent) { if (value.rootDeploymentId !== null || !history.reasons.includes("lineage")) return false; break; }
      if (parent.createdAt >= current.createdAt) return false;
      current = parent;
    }
    if (value.rootDeploymentId !== null && current.id !== value.rootDeploymentId) return false;
  }
  if (!Array.isArray(value.entries) || value.entries.length > 20 || value.nextCursor !== null && !value.entries.length) return false;
  let last = -1;
  for (const event of value.entries) {
    const d = event && deployments.get(event.deploymentId);
    if (!d || typeof event.id !== "string" || !/^j1\.[A-Za-z0-9_-]{43}$/.test(event.id) || !timestamp(event.observedAt) || event.observedAt < last) return false;
    last = event.observedAt;
    if (event.kind === "publication") { if (event.observedAt !== d.createdAt) return false; }
    else if (event.kind !== "sdk-event" || !Object.hasOwn(eventLabels,event.type) || !timestamp(event.receivedAt) || event.receivedAt > value.observedAt || (["failed","rolled_back"].includes(event.type) ? !Object.hasOwn(stages,event.stage) || !Object.hasOwn(failures,event.code) : event.stage !== undefined || event.code !== undefined)) return false;
  }
  return new Set(value.entries.map(journeyKey)).size === value.entries.length;
}
/** Owner-only, on-demand reads. Cache contains only scoped public DTOs, never tickets or device IDs. */
export function createDeploymentDevices(env, options) {
  const { document } = env; const root = document.getElementById("deployment-devices");
  const cache = new Map(), pending = new Map(); let session = 0, view = 0, scope = null, cursor = null, previous = [], current = null, loading = false, selected = null, timelineCursor = null, timelinePrevious = [], timeline = null, timelineLoading = false, timelineError = false, error = false;
  const journeyCache = new Map(), journeyPending = new Map();
  let journey = null, journeyLoading = false, journeyError = false, journeyRetryAppend = false, journeyEpoch = 0;
  let rollback = null, rollbackEpoch = 0, eligibilityEpoch = 0, eligibilityWriting = false, eligibilityMessage = "";
  const now = () => env.now?.() ?? Date.now();
  const el = (tag, content, css = "") => { const node = document.createElement(tag); if (content !== undefined) node.textContent = String(content); node.className = css; return node; };
  const button = (label, handler, disabled = false) => { const node = el("button", label, "button secondary small"); node.type = "button"; node.disabled = disabled; node.addEventListener("click", handler); return node; };
  function active() { return scope && options.active() && options.route().page === "ota-detail" && options.route().appId === scope.appId && options.route().deploymentId === scope.deploymentId && (options.route().filter ?? "all") === scope.filter; }
  function path(id, pageCursor) {
    const query = []; if (!id && scope.filter !== "all") query.push("filter=" + scope.filter); if (pageCursor) query.push("cursor=" + encodeURIComponent(pageCursor));
    return `/api/apps/${encodeURIComponent(scope.appId)}/ota/deployments/${scope.deploymentId}/telemetry${id ? "/installations/" + encodeURIComponent(id) : ""}${query.length ? "?" + query.join("&") : ""}`;
  }
  async function read(url, installationId, force) {
    const entry = cache.get(url); if (!force && entry && now() - entry.at < 60_000) return entry;
    if (pending.has(url)) return pending.get(url);
    if (pending.size >= 4) throw new Error("DETAIL_REQUEST_BUSY");
    const epoch = session, requested = { ...scope };
    const request = (async () => { const value = await options.api(url); if (!validateDeploymentDevices(value, requested.appId, requested.deploymentId, installationId, requested.filter)) throw new Error("INVALID_DEVICE_DETAIL"); const entry = { value, at: now() }; if (epoch === session) { cache.delete(url); cache.set(url,entry); const isTimeline = url.includes("/installations/"); const matching = [...cache.keys()].filter(key => key.includes("/installations/") === isTimeline); while (matching.length > (isTimeline ? 16 : 8)) cache.delete(matching.shift()); } return entry; })();
    pending.set(url, request); try { return await request; } finally { if (pending.get(url) === request) pending.delete(url); }
  }
  function resetJourney() { ++journeyEpoch; journey = null; journeyLoading = false; journeyError = false; journeyRetryAppend = false; }
  function journeyPath(id, pageCursor) { return `/api/apps/${encodeURIComponent(scope.appId)}/ota/deployments/${scope.deploymentId}/telemetry/installations/${encodeURIComponent(id)}/journey${pageCursor ? "?cursor=" + encodeURIComponent(pageCursor) : ""}`; }
  async function readJourney(url, id, force = false) {
    const saved = journeyCache.get(url); if (!force && saved && now() - saved.at < 60_000) return saved;
    if (journeyPending.has(url)) return journeyPending.get(url);
    if (journeyPending.size >= 4) throw Error("JOURNEY_REQUEST_BUSY");
    const ownerSession = session, requested = {...scope}, deployment = current.value.deployment;
    const request = (async () => {
      const value = await options.api(url);
      if (!validateDeploymentJourney(value,requested.appId,requested.deploymentId,id,deployment)) throw Error("INVALID_DEVICE_JOURNEY");
      const result = {value,at:now()};
      if (ownerSession === session) { journeyCache.delete(url); journeyCache.set(url,result); while (journeyCache.size > 16) journeyCache.delete(journeyCache.keys().next().value); }
      return result;
    })();
    journeyPending.set(url,request); try { return await request; } finally { if (journeyPending.get(url) === request) journeyPending.delete(url); }
  }
  async function loadJourney(append = false, force = false) {
    if (!active() || !selected || journeyLoading || eligibilityWriting) return;
    const epoch = ++journeyEpoch, id = selected, ownerSession = session, next = append ? journey?.value.nextCursor : null;
    let firstAddedId = null;
    if (append && !next) return;
    journeyLoading = true; journeyError = false; journeyRetryAppend = append; render();
    try {
      const entry = await readJourney(journeyPath(id,next),id,force);
      if (epoch !== journeyEpoch || ownerSession !== session || !active() || selected !== id) return;
      if (append && journey) {
        if (entry.value.rootDeploymentId !== journey.value.rootDeploymentId || entry.value.observedAt !== journey.value.observedAt || JSON.stringify(entry.value.deployments.map(({history,...d})=>d)) !== JSON.stringify(journey.value.deployments.map(({history,...d})=>d)) || entry.value.nextCursor === next || journey.cursors.includes(next)) throw Error("JOURNEY_PAGING_CHANGED");
        const prior = journey.value.entries, seen = new Set(prior.map(journeyKey));
        if (entry.value.entries.some(event => seen.has(event.id) && JSON.stringify(event) !== JSON.stringify(prior.find(item=>item.id === event.id)))) throw Error("JOURNEY_ENTRY_CHANGED");
        const additions = entry.value.entries.filter(event => !seen.has(journeyKey(event)));
        firstAddedId = additions[0]?.id ?? null;
        if (additions.length && prior.length && additions[0].observedAt < prior.at(-1).observedAt) throw Error("JOURNEY_PAGING_ORDER");
        if (prior.length + additions.length > 2000) throw Error("JOURNEY_DISPLAY_LIMIT");
        journey = {...entry,value:{...entry.value,entries:[...prior,...additions]},cursors:[...journey.cursors,next]};
      } else journey = {...entry,cursors:[]};
    } catch (cause) { if (ownerSession === session && epoch === journeyEpoch && active() && selected === id) { if (cause.status === 401) options.expire(); else journeyError = cause.message === "JOURNEY_DISPLAY_LIMIT" ? "display-limit" : true; } }
    finally { if (epoch === journeyEpoch && active() && selected === id) { journeyLoading = false; render(); if (append && firstAddedId) root?.querySelector?.(`[data-journey-entry="${firstAddedId}"]`)?.focus?.({preventScroll:true}); } }
  }
  function renderJourney(container) {
    const section = el("section",undefined,"device-journey"); section.setAttribute("aria-label","문제 전체 흐름"); section.setAttribute("aria-busy",journeyLoading ? "true" : "false");
    section.append(el("h3","원래 OTA부터 롤백·복구까지"),el("p","같은 앱·설치의 원래 OTA와 연결된 롤백을 보고 시각 순으로 표시합니다. 기기·서버 시계 차이와 동시 보고가 있어 시각만으로 인과를 단정하지 않습니다. 배포 게시와 기기 적용 결과는 구분됩니다.","subtle"));
    section.append(button(journey ? "문제 흐름 새로고침" : "문제 전체 흐름 보기",()=>loadJourney(false,Boolean(journey)),journeyLoading || eligibilityWriting));
    if (journeyLoading) section.append(el("p","문제 흐름 확인 중…","subtle"));
    if (journeyError) { section.append(el("p",journeyError === "display-limit" ? "화면 표시 한도 2,000건에 도달했습니다. 표시 중인 기록과 서버 이력은 보존됩니다. 각 배포의 상세 이벤트에서 나머지 기록을 확인하세요." : "문제 흐름을 불러오지 못했습니다. 표시 중인 기록은 보존됩니다. 연결이나 이력 변경을 확인하고 다시 시도하세요.","notice notice-error"),button("문제 흐름 다시 시도",()=>loadJourney(journeyRetryAppend,true),journeyLoading)); }
    if (journey) {
      const value = journey.value, ordered = [...value.deployments].sort((a,b)=>a.createdAt-b.createdAt || a.id.localeCompare(b.id));
      const names = new Map(ordered.map((d,i)=>[d.id,d.id === value.rootDeploymentId ? "원래 OTA" : d.rollback ? `롤백 ${i + (value.rootDeploymentId ? 0 : 1)}` : "연결 미확인 배포"]));
      section.append(el("p",`서버 조회 ${time(value.observedAt)} · 최대 60초 캐시 재사용 · 자동 조회 없음`,"subtle"));
      if (!value.history.complete) section.append(el("p",`일부 흐름 미확인 · ${value.history.reasons.map(reason=>journeyReasons[reason]).join(" · ")}. 보관된 실제 기록만 표시하며 미기록 구간의 성공·실패를 추정하지 않습니다.`,"notice"));
      const list = el("ol",undefined,"device-journey-list");
      for (const event of value.entries) {
        const item = el("li",undefined,"device-journey-entry" + (event.type === "failed" || event.type === "rolled_back" ? " has-failure" : ""));
        item.setAttribute("data-journey-entry",event.id); item.setAttribute("tabindex","-1");
        const label = names.get(event.deploymentId), heading = event.kind === "publication" ? `${label} 게시` : `${label} · ${eventLabels[event.type]}`;
        item.append(el("strong",heading),el("p",event.kind === "publication" ? `게시 시각 ${time(event.observedAt)} · 다운로드·적용 성공을 뜻하지 않습니다.` : `기기 보고 시각 ${time(event.observedAt)} · 서버 수신 ${time(event.receivedAt)}`,"subtle"));
        if (event.kind === "publication") { const deployment = value.deployments.find(d=>d.id === event.deploymentId); if (deployment.rollback) item.append(el("p",`롤백 사유: ${deployment.rollback.reason}`)); }
        if (event.code) item.append(el("p",`${stages[event.stage]} · ${failures[event.code]}`,"sdk-telemetry-failure"));
        item.append(deploymentLink(`${label} 배포 상세`,event.deploymentId)); list.append(item);
      }
      section.append(list);
      if (!value.entries.length) section.append(el("p","보관된 전체 흐름 기록이 없습니다. 미보고 상태를 성공으로 해석하지 않습니다.","subtle"));
      if (value.nextCursor) section.append(button("이후 기록 더 보기",()=>loadJourney(true),journeyLoading || eligibilityWriting));
    }
    container.append(section);
  }
  function deploymentLink(label, id) { const link = el("a", label, "button secondary small"); link.setAttribute("href", adminPath("ota-detail", scope.appId, id)); return link; }
  function renderRollback() {
    const section = el("section", undefined, "record rollback-panel"); section.append(el("h3", "이전 버전으로 복구"), el("p", "같은 앱·플랫폼·채널·Runtime의 이전 번들을 새 배포로 게시합니다. 기존 배포와 이력은 보존되며 기기는 업데이트를 확인한 뒤 적용합니다.", "subtle"));
    if (!rollback) { section.append(button("이전 배포로 롤백", openRollback)); return section; }
    if (rollback.loading) section.append(el("p", "호환되는 이전 배포 확인 중…", "subtle"));
    if (rollback.error) section.append(el("p", rollback.error, "notice notice-error"));
    if (rollback.result) { section.append(el("p", "롤백 게시 완료 · 기기 다운로드·적용은 아래 새 배포에서 확인하세요.", "notice notice-success"), deploymentLink("롤백 배포의 적용 현황", rollback.result)); return section; }
    if (rollback.stale) { section.append(button("최신 배포와 이전 버전 다시 확인", openRollback)); return section; }
    if (!rollback.candidates?.length) { if (!rollback.loading) section.append(el("p", "현재 조회 범위에 호환되는 이전 배포가 없습니다.", "subtle"), button("이전 배포 다시 확인", openRollback)); return section; }
    if (rollback.review) {
      const target = rollback.candidates.find(item => item.id === rollback.target);
      section.append(el("h4", "롤백 게시 내용 확인"), el("p", `${current.value.deployment.platform === "ios" ? "iOS" : "Android"} · ${target.channel} · Runtime ${target.runtimeVersion}`), el("p", `현재 게시 ${time(current.value.deployment.createdAt)} → 복원할 원본 ${time(target.createdAt)}`), el("p", `사유: ${rollback.reason}`), el("p", "원본 번들의 코드로 돌아갑니다. 이후 GitHub 커밋 자동 배포는 기존 정책대로 계속됩니다.", "subtle"));
      section.append(button(rollback.submitting ? "롤백 게시 중…" : "확인하고 롤백 배포", submitRollback, rollback.submitting), button("선택 수정", () => { if (!rollback.submitting) { rollback.review = false; render(); } }, rollback.submitting));
    } else {
      const label = el("label", "롤백할 이전 배포"), select = el("select"); select.setAttribute("aria-label", "롤백할 이전 배포");
      for (const item of rollback.candidates) { const option = el("option", `${time(item.createdAt)} · ${item.commitSha?.slice(0, 8) ?? "커밋 미기록"}${item.rollback ? " · 롤백 배포" : ""}`); option.value = item.id; select.append(option); }
      select.value = rollback.target; select.addEventListener("change", () => { rollback.target = select.value; rollback.requestKey = null; });
      const reasonLabel = el("label", "롤백 사유"), reason = el("textarea"); reason.setAttribute("aria-label", "롤백 사유"); reason.maxLength = 500; reason.rows = 3; reason.value = rollback.reason; reason.addEventListener("input", () => { rollback.reason = reason.value; rollback.requestKey = null; });
      section.append(label, select, reasonLabel, reason, button("롤백 내용 확인", () => { if (!text(rollback.reason.trim(), 500)) { rollback.error = "롤백 사유를 1~500자로 입력하세요."; render(); return; } rollback.reason = rollback.reason.trim(); rollback.review = true; rollback.error = null; render(); }));
    }
    return section;
  }
  async function openRollback() {
    if (!active() || rollback?.loading || rollback?.submitting) return;
    const epoch = ++rollbackEpoch, requested = { ...scope }, original = current.value.deployment;
    rollback = { loading: true, reason: "", requestKey: null }; render();
    try {
      const value = await options.api(`/api/apps/${encodeURIComponent(requested.appId)}/operations`);
      if (epoch !== rollbackEpoch || !active()) return;
      if (!Array.isArray(value?.deployments) || value.deployments.length > 100 || value.deployments.some(item => item.appId !== requested.appId)) throw Error("INVALID_ROLLBACK_CANDIDATES");
      const compatible = value.deployments.filter(item => item.appId === requested.appId && ["platform", "channel", "runtimeVersion"].every(key => item[key] === original[key]) && uuid(item.id) && timestamp(item.createdAt)).sort((a,b) => b.createdAt-a.createdAt || b.id.localeCompare(a.id));
      if (compatible[0]?.id !== requested.deploymentId) { rollback.stale = true; rollback.error = "이 배포는 현재 최신 배포가 아닙니다. OTA 배포 이력에서 최신 배포를 열어 롤백하세요."; }
      else { rollback.candidates = compatible.filter(item => item.id !== original.id && item.createdAt < original.createdAt); rollback.target = rollback.candidates[0]?.id ?? null; }
    } catch (cause) { if (cause.status === 401) { options.expire(); return; } if (epoch === rollbackEpoch && active()) rollback.error = "이전 배포를 확인하지 못했습니다. 기존 배포는 유지됩니다."; }
    finally { if (epoch === rollbackEpoch && active()) { rollback.loading = false; render(); } }
  }
  async function submitRollback() {
    if (!active() || !rollback?.review || rollback.submitting || rollback.stale) return;
    const epoch = rollbackEpoch, requested = { ...scope }, target = rollback.candidates.find(item => item.id === rollback.target); if (!target) return;
    rollback.requestKey ??= "rollback_" + (env.crypto?.randomUUID?.() ?? globalThis.crypto.randomUUID()); rollback.submitting = true; rollback.error = null; render();
    try {
      const result = await options.api(`/api/apps/${encodeURIComponent(requested.appId)}/ota/rollbacks`, JSON.stringify({ requestKey: rollback.requestKey, fromDeploymentId: requested.deploymentId, targetDeploymentId: target.id, reason: rollback.reason }));
      if (epoch !== rollbackEpoch || !active()) return;
      if (!uuid(result?.id) || result.appId !== requested.appId || !validRollback(result.rollback) || result.rollback.fromDeploymentId !== requested.deploymentId || result.rollback.targetDeploymentId !== target.id) throw Error("INVALID_ROLLBACK_RESPONSE");
      rollback.result = result.id; cache.clear();
    } catch (cause) { if (cause.status === 401) { options.expire(); return; } if (epoch === rollbackEpoch && active()) { if (cause.status === 409) { rollback.stale = true; rollback.error = "최신 배포 또는 요청 상태가 변경되었습니다. 최신 이력을 확인하고 롤백 대상을 다시 선택하세요."; } else rollback.error = "롤백 완료 여부를 확인하지 못했습니다. 이력을 확인하거나 같은 요청으로 다시 시도하세요. 기존 기록은 보존됩니다."; } }
    finally { if (epoch === rollbackEpoch && active()) { rollback.submitting = false; render(); } }
  }
  function eligibilityControls(container, installation) {
    if (typeof installation.automaticRollbackEligible !== "boolean") return;
    container.append(el("p",installation.automaticRollbackEligible ? "소유자가 자동 롤백 판단에 허용한 설치" : "적용 현황에만 집계 · 자동 롤백 판단에는 미포함","subtle"));
    container.append(button(installation.automaticRollbackEligible ? "허용 해제" : "자동 롤백 판단에 허용",()=>setEligibility(installation),eligibilityWriting||loading||timelineLoading));
  }
  async function setEligibility(installation) {
    if(!active()||eligibilityWriting||loading||timelineLoading||typeof installation.automaticRollbackEligible!=="boolean")return;
    const requestEpoch=eligibilityEpoch,requested={...scope},enabled=!installation.automaticRollbackEligible;
    eligibilityWriting=true;eligibilityMessage="";render();
    try {
      const result=await options.api(`/api/apps/${encodeURIComponent(requested.appId)}/ota/rollback-installations`,JSON.stringify({deploymentId:requested.deploymentId,installationRef:installation.id,enabled}));
      if(requestEpoch!==eligibilityEpoch||!active())return;
      if(!result||result.enabled!==enabled||!Number.isSafeInteger(result.eligibleInstallations)||result.eligibleInstallations<0||result.eligibleInstallations>20000||result.policyVersion !== undefined && result.policyVersion !== null && (!Number.isSafeInteger(result.policyVersion)||result.policyVersion<1))throw Error("INVALID_INSTALLATION_PERMISSION");
      // Permission changes do not alter device outcomes or manufacture events.
      // Cached other pages are invalidated because their references are opaque.
      cache.clear();
      const update=row=>row.id===installation.id?{...row,automaticRollbackEligible:enabled}:row;
      if(current)current={...current,value:{...current.value,installations:current.value.installations.map(update)}};
      if(timeline)timeline={...timeline,value:{...timeline.value,installation:update(timeline.value.installation)}};
      eligibilityMessage=enabled ? "자동 롤백 판단 허용을 저장했습니다. 허용 설치 변경 이후 새로 게시한 배포부터 평가합니다." : "자동 롤백 판단 허용을 해제했습니다. 허용 설치 변경 이후 새로 게시한 배포부터 평가합니다. 기존 보고와 배포 이력은 보존됩니다.";
    } catch(cause) {
      if(requestEpoch!==eligibilityEpoch||!active())return;
      if(cause.status===401){options.expire();return;}
      eligibilityMessage=cause.status===409 ? "허용 설정이 변경되었거나 보관 한도에 도달했습니다. 현황을 새로고침한 뒤 확인하세요." : "허용 설정 완료 여부를 확인하지 못했습니다. 현황을 새로고침해 확인하세요. 보고 이력은 보존됩니다.";
    } finally {if(requestEpoch===eligibilityEpoch&&active()){eligibilityWriting=false;render();}}
  }
  function historyNote(installation) { if (installation.history.reason === "legacy") return installation.history.recordedEvents ? "과거 일부 세부 이벤트 미기록 · 이후 수신해 보관된 이벤트만 표시합니다. 다운로드·적용 시각을 추정하지 않습니다." : "과거 누적 결과 · 세부 이벤트 미기록. 다운로드·적용 시각을 추정하지 않습니다."; if (!installation.history.complete) return "일부 상세 이벤트가 보관 한도로 생략되었습니다. 누적 결과는 보존됩니다."; return "SDK가 보고한 이벤트 기록입니다. 미보고 동작이나 전체 기기 수를 뜻하지 않습니다."; }
  function renderSummary(summary) {
    const section = el("section", undefined, "device-summary"); section.setAttribute("aria-label", "SDK 보고 누적 현황");
    section.append(el("h3", "SDK 보고 누적 현황"));
    if (!summary) { section.append(el("p", "SDK 적용 보고 미수집", "subtle")); return section; }
    const metrics = el("dl", undefined, "device-summary-metrics");
    for (const [label, value] of [["보고 설치",summary.observedInstallations],["누적 적용률",summary.applicationRate === null ? "미확인" : summary.applicationRate.toFixed(1) + "%"],["다운로드 확인",summary.downloadedInstallations],["적용 실행 확인",summary.appliedInstallations],["재시작 확인",summary.restartedInstallations],["일반 실패 보고",summary.failedInstallations],["네이티브 자동 복구",summary.rolledBackInstallations],["동일 설치 복구",summary.recoveredInstallations ?? "미확인"]]) {
      const metric = el("div", undefined, "device-summary-metric"); metric.append(el("dt", label), el("dd", value)); metrics.append(metric);
    }
    if (isValidSdkIssueResolution(summary)) { const resolution = summary.issueResolution; for (const [label, value] of [["미복구 문제", resolution.unresolvedInstallations], ["해결된 문제", resolution.resolvedInstallations], ["롤백으로 해결됨", resolution.rollbackResolvedInstallations ?? 0], ["복구 시점 미확인", resolution.unknownInstallations]]) { const metric = el("div", undefined, "device-summary-metric"); metric.append(el("dt", label), el("dd", value)); metrics.append(metric); } }
    else section.append(el("p", "현재 문제 해결 상태 미확인 · 과거 누적 보고만 확인할 수 있습니다.", "subtle"));
    section.append(metrics, el("p", "이 배포를 보고한 익명 설치의 누적 결과입니다. 전체 설치 수나 현재 오류 수를 뜻하지 않습니다. 각 항목은 중복될 수 있어 합산하지 않습니다.", "subtle"), el("p", "일반 실패 보고와 네이티브 자동 복구는 별도 이벤트입니다. 동일 설치 복구는 같은 설치에서 실패 이후 적용 실행·재시작 확인을 모두 수신한 경우입니다. 서버의 자동 롤백 취소와 구분되며 과거 미보고 복구는 소급 집계하지 않습니다.", "subtle"));
    return section;
  }
  function renderTimeline(container) {
    renderJourney(container);
    container.append(el("h3", "선택한 익명 설치의 이벤트 · 최근 보고 순"));
    if (timelineLoading) container.append(el("p", "이벤트 확인 중…", "subtle"));
    if (timelineError) container.append(el("p", "이벤트를 불러오지 못했습니다. 마지막 확인 기록은 유지됩니다.", "notice notice-error"));
    container.append(button(timelineError ? "이벤트 다시 시도" : "이벤트 새로고침", () => loadTimeline(true), timelineLoading || eligibilityWriting));
    if (!timeline) return;
    const value = timeline.value;
    eligibilityControls(container,value.installation);
    container.append(el("p", historyNote(value.installation), "subtle"), el("p", `보관 이벤트 ${value.installation.history.recordedEvents}건 · 보관 한도 생략 ${value.installation.history.omittedEvents}건 · 기록 시작 ${time(value.installation.history.startedAt)}`, "subtle"), el("p", `서버 조회 ${time(value.observedAt)} · 자동 조회 없음`, "subtle"));
    const list = el("ol", undefined, "device-event-list");
    for (const event of value.events) { const item = el("li"); item.append(el("strong", eventLabels[event.type]), el("p", `기기 보고 시각 ${time(event.observedAt)} · 서버 수신 ${time(event.receivedAt)}`, "subtle")); if (event.code) item.append(el("p", `${stages[event.stage] ?? "단계 미확인"} · ${failures[event.code]}`)); list.append(item); }
    container.append(list); if (!value.events.length) container.append(el("p", "보관된 세부 이벤트 없음 · 누적 성공·실패 결과는 위에서 확인하세요.", "subtle"));
    const paging = el("div", undefined, "device-paging"); paging.append(button("이전 이벤트", () => { timelineCursor = timelinePrevious.pop() ?? null; return loadTimeline(); }, timelineLoading || eligibilityWriting || !timelinePrevious.length), button("다음 이벤트", () => { timelinePrevious.push(timelineCursor); timelineCursor = value.nextCursor; return loadTimeline(); }, timelineLoading || eligibilityWriting || !value.nextCursor)); container.append(paging);
  }
  function render() {
    if (!root || !active()) return;
    root.replaceChildren(); root.setAttribute("aria-busy", loading ? "true" : "false");
    const toolbar = el("div", undefined, "device-toolbar"); toolbar.append(el("p", "앱·배포별 익명 설치 기준 · 수동 조회 · 페이지당 최대 20개", "subtle"), button(error ? "다시 시도" : "현황 새로고침", () => load(true), loading || eligibilityWriting)); root.append(toolbar);
    const filters = el("nav", undefined, "device-filter-nav"); filters.setAttribute("aria-label", "설치 이력 필터");
    for (const [mode, label] of [["all", "전체 설치 이력"], ["unresolved", "미복구"], ["resolved", "해결됨"], ["issues", "실패·복구 이력만"]]) { const link = el("a", label, "button secondary small"); link.setAttribute("href", adminPath(mode === "all" ? "ota-detail" : "ota-" + mode, scope.appId, scope.deploymentId)); if (scope.filter === mode) link.setAttribute("aria-current", "page"); filters.append(link); }
    root.append(filters);
    if (scope.filter === "unresolved") root.append(el("p", "같은 설치에서 최신 실패 이후 적용 실행·재시작이 모두 확인되지 않은 문제입니다. 복구 시점이 불명확한 과거 보고도 포함합니다.", "subtle"));
    if (scope.filter === "resolved") root.append(el("p", "같은 설치에서 최신 실패 이후 원래 배포 또는 연결된 롤백 배포의 적용 실행·재시작이 모두 확인된 문제입니다. 원래 배포의 실패 이력은 보존됩니다.", "subtle"));
    if (scope.filter === "issues") root.append(el("p", "실패 또는 네이티브 자동 복구를 보고한 설치만 표시합니다. 복구 이력도 포함하며 현재 오류 목록을 뜻하지 않습니다. SDK 보고 누적 현황은 필터와 무관한 전체 배포의 누적 현황입니다.", "subtle"));
    if (loading) root.append(el("p", "배포 적용 현황 확인 중…", "subtle"));
    if (error) root.append(el("p", "현황을 불러오지 못했습니다. 연결과 접근 권한을 확인하고 다시 시도하세요. 마지막 확인 기록은 유지됩니다.", "notice notice-error"));
    if (eligibilityMessage) root.append(el("p",eligibilityMessage,"notice"));
    if (!current) return;
    const value = current.value, d = value.deployment;
    root.append(el("h2", `${d.platform === "ios" ? "iOS" : "Android"} · ${d.channel}`), el("p", `게시 ${time(d.createdAt)} · Runtime ${d.runtimeVersion}`, "subtle"), el("p", `서버 조회 ${time(value.observedAt)} · 화면 캐시 ${time(current.at)} · 최대 60초 재사용 · 최신 상태는 새로고침`, "subtle"));
    if (d.rollback) { const record = el("section", undefined, "record rollback-origin"); record.append(el("h3", value.automaticRollback?.rollbackDeploymentId === d.id ? "실패율 기준 자동 롤백 배포" : "관리자 롤백 배포"), el("p", `요청 ${time(d.rollback.requestedAt)} · 사유: ${d.rollback.reason}`), deploymentLink("롤백 전 배포", d.rollback.fromDeploymentId), deploymentLink("복원 원본 배포", d.rollback.targetDeploymentId), el("p", "아래 다운로드·적용·재시작은 이 롤백 배포에 대한 SDK 보고입니다. 네이티브 엔진의 자동 롤백과 구분됩니다.", "subtle")); root.append(record); }
    if (value.automaticRollback) root.append(renderAutomaticRollbackDecision(document,scope.appId,value.automaticRollback));
    root.append(renderRollback());
    const technical = el("details"); technical.append(el("summary", "기술 정보"), el("p", `배포 ${d.id}`), el("p", `커밋 ${d.commitSha ?? "미기록"}`)); root.append(technical);
    const summary = value.summary;
    root.append(renderSummary(summary));
    root.append(el("p", "설치 별칭은 이 앱·배포 안에서 표시됩니다. 자동 롤백 판단 허용은 이 앱의 이후 배포에도 유지됩니다. 직접 검증한 설치만 허용하세요. 기기 이름·개인정보는 수집하지 않습니다.", "subtle"));
    const list = el("div", undefined, "device-installations");
    for (const installation of value.installations) {
      const row = el("article", undefined, "record device-installation"); row.append(el("h3", `익명 ${installation.label}`), el("p", `${environments[installation.environment]} · 최근 보고 ${time(installation.lastReportedAt)}`, "subtle"));
      row.append(el("p", installation.issueStatus === "resolved" ? installation.issueResolution?.kind === "rollback" ? "롤백으로 해결됨 · 같은 설치의 롤백 적용·재시작 확인" : "해결됨 · 최신 실패 후 적용·재시작 확인" : installation.issueStatus === "unresolved" ? "미복구 · 최신 실패 후 정상 적용·재시작 미확인" : installation.issueStatus === "none" ? "문제 보고 없음" : "문제 해결 상태 미확인", "badge" + (installation.issueStatus === "resolved" ? " success" : "")));
      if (installation.rollbackFailure) {
        const failure = installation.rollbackFailure;
        row.append(el("p", installation.issueStatus === "resolved" ? "롤백 실패 후 재복구 확인 · 원래 문제 해결됨" : "연결된 롤백 실패 · 원래 문제도 미복구", "badge"), el("p", `롤백 실패 보고 ${time(failure.observedAt)} · ${failure.stage === undefined ? "실패 원인 세부 미기록" : `${stages[failure.stage]} · ${failures[failure.code]}`}`, "subtle"), deploymentLink("실패한 롤백 배포 이력", failure.deploymentId));
      }
      if (installation.issueResolution?.kind === "rollback") {
        const proof = installation.issueResolution;
        row.append(el("p", `원래 문제의 첫 실패 ${time(installation.firstFailureAt)} · 롤백 적용 확인 ${time(proof.confirmedAt)} · 롤백 재시작 확인 ${time(proof.restartedAt)}`, "subtle"), deploymentLink("정상 복구된 롤백 배포 이력", proof.deploymentId), el("p", "아래 다운로드·적용·재시작 배지는 원래 배포의 보고이며, 롤백 성공으로 바꾸지 않습니다.", "subtle"));
      }
      if (installation.issueOrderKnown === false) row.append(el("p", "복구 순서 미확인 · 과거 이벤트가 불완전하여 미복구로 유지합니다.", "subtle"));
      const stagesRow = el("div", undefined, "device-stages"); for (const [key,label] of [["downloaded","다운로드"],["applied","적용"],["restarted","재시작"]]) stagesRow.append(el("span", `${label} ${installation[key] ? "확인" : "미확인"}`, "badge" + (installation[key] ? " success" : ""))); row.append(stagesRow);
      row.append(el("p", `일반 실패 이벤트 ${installation.failed ? "보고됨" : "보고 없음"} · 네이티브 자동 복구 ${installation.rolledBack ? "보고됨" : "보고 없음"} · 동일 설치의 실패 후 복구 ${installation.recovered ? "확인" : "미확인"}`));
      row.append(el("p", `첫 실패 ${time(installation.firstFailureAt)} · 최근 적용 확인 ${time(installation.latestConfirmedAt)} · 최근 재시작 확인 ${time(installation.latestRestartAt)}`, "subtle"));
      if (installation.recovered) row.append(el("p", "같은 설치에서 실패 이후 적용 실행·재시작 확인을 모두 수신한 누적 복구 결과입니다.", "subtle"));
      if (installation.rolledBack && !installation.recovered) row.append(el("p", "네이티브 엔진이 이전 번들로 돌아갔다고 보고했습니다. 이 배포의 정상 적용·재시작을 뜻하지 않습니다.", "subtle"));
      for (const failure of installation.failures) row.append(el("p", `${stages[failure.stage]} · ${failures[failure.code]}`, "sdk-telemetry-failure"));
      row.append(el("p", historyNote(installation), "subtle"));
      eligibilityControls(row,installation);
      row.append(button(selected === installation.id ? "이벤트 닫기" : "상세 이벤트 보기", () => { if (selected === installation.id) { selected = null; timeline = null; resetJourney(); ++view; render(); return; } resetJourney(); selected = installation.id; timeline = null; timelineCursor = null; timelinePrevious = []; return loadTimeline(); }));
      if (selected === installation.id) { const detail = el("section", undefined, "device-timeline"); renderTimeline(detail); row.append(detail); } list.append(row);
    }
    root.append(list); if (!value.installations.length) root.append(el("p", scope.filter === "unresolved" ? "조회된 미복구 문제가 없습니다. 미보고 기기의 상태는 알 수 없습니다." : scope.filter === "resolved" ? "복구가 확인된 문제가 없습니다." : scope.filter === "issues" ? "조회된 실패·네이티브 복구 이력이 없습니다. 미보고 기기가 있을 수 있어 현재 정상 상태를 보장하지 않습니다." : "이 배포를 보고한 익명 설치가 없습니다. 미보고 상태를 실패나 0% 적용으로 해석하지 않습니다.", "subtle"));
    const paging = el("div", undefined, "device-paging"); paging.append(button("이전 설치", () => { previous.length && (cursor = previous.pop()); return load(); }, loading || eligibilityWriting || !previous.length), button("다음 설치", () => { previous.push(cursor); cursor = value.nextCursor; return load(); }, loading || eligibilityWriting || !value.nextCursor)); root.append(paging);
  }
  async function load(force = false, autoOpen = false) {
    if (!active() || eligibilityWriting) return; const epoch = ++view; resetJourney(); selected = null; timeline = null; timelineLoading = false; loading = true; error = false; render();
    try { const entry = await read(path(null,cursor), null, force); if (epoch === view && active()) { current = entry; if (autoOpen && scope.filter !== "all" && entry.value.installations.length) { selected = entry.value.installations[0].id; timelineCursor = null; timelinePrevious = []; } } }
    catch (cause) { if (cause.status === 401) options.expire(); else if (epoch === view && active()) error = true; }
    finally { if (epoch === view && active()) { loading = false; render(); } }
    if (autoOpen && epoch === view && active() && selected) await loadTimeline();
  }
  async function loadTimeline(force = false) {
    if (!active() || !selected || eligibilityWriting) return; const epoch = ++view, id = selected; timelineLoading = true; timelineError = false; render();
    try { const entry = await read(path(id,timelineCursor), id, force); if (epoch === view && active() && selected === id) timeline = entry; }
    catch (cause) { if (cause.status === 401) options.expire(); else if (epoch === view && active()) timelineError = true; }
    finally { if (epoch === view && active()) { timelineLoading = false; render(); } }
  }
  return {
    async open(route) { resetJourney(); ++eligibilityEpoch; eligibilityWriting=false; eligibilityMessage=""; ++rollbackEpoch; rollback = null; ++view; scope = { appId: route.appId, deploymentId: route.deploymentId, filter: route.filter ?? "all" }; cursor = null; previous = []; current = null; selected = null; timeline = null; timelineCursor = null; timelinePrevious = []; await load(false, true); },
    leave() { resetJourney(); ++eligibilityEpoch; eligibilityWriting=false; eligibilityMessage=""; ++rollbackEpoch; rollback = null; ++view; scope = null; current = null; selected = null; timeline = null; timelineCursor = null; timelinePrevious = []; root?.replaceChildren(); },
    clear() { resetJourney(); journeyCache.clear(); journeyPending.clear(); ++eligibilityEpoch; eligibilityWriting=false; eligibilityMessage=""; ++rollbackEpoch; rollback = null; ++session; ++view; scope = null; current = null; timeline = null; selected = null; timelineCursor = null; timelinePrevious = []; cache.clear(); pending.clear(); root?.replaceChildren(); },
  };
}
