const ACTIVE = new Set(["queued", "running", "cancelling", "timing_out"]);
const LABELS = { queued: "대기 중", running: "실행 중", cancelling: "취소 처리 중", timing_out: "시간 초과 정리 중", passed: "통과", failed: "실패", invalid: "증거 불충분", blocked: "실행 차단", cancelled: "취소됨", interrupted: "중단됨" };
const CHECKS = { toolchain: "도구·SDK", filesystem: "파일 경계", network: "네트워크 격리", cpu: "CPU 제한", resources: "메모리·디스크", processTreeCancel: "전체 실행 취소", outputBoundary: "출력 제한", cleanup: "실행 후 정리" };
const MAX_TEXT = 65_536;
function safe(value, max = 2048) {
  const source = String(value ?? "—");
  const cleaned = source.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
  const encoded = new TextEncoder().encode(cleaned);
  const suffix = "\n… 표시 제한에 따라 생략됨";
  return encoded.length > max ? new TextDecoder().decode(encoded.slice(0, max - new TextEncoder().encode(suffix).length)).replace(/\ufffd$/, "") + suffix : cleaned;
}
function element(document, tag, text, className = "") {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = safe(text, tag === "pre" ? MAX_TEXT : 2048); node.className = className; return node;
}
function set(document, id, text) { document.getElementById(id).textContent = safe(text); }
function date(value) { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? "시각 알 수 없음" : parsed.toLocaleString("ko-KR", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) + " UTC"; }
function pair(document, label, value, mono = false) { const row = element(document, "div", undefined, "fact-row"); row.append(element(document, "span", label, "fact-label"), element(document, "span", value, mono ? "mono fact-value" : "fact-value")); return row; }
function pointer(fact) { return fact ? `${fact.provenance.path} · ${fact.provenance.pointer}` : "선언 없음"; }
function select(document, id, items, selected) { const node = document.getElementById(id); node.replaceChildren(...items.map(([value, label]) => { const option = element(document, "option", label); option.value = value; return option; })); node.value = selected ?? ""; }
function emptyHistory(document, target, message) { document.getElementById(target).replaceChildren(element(document, "p", message, "empty-history")); }
function disclosureId(kind, id) { return "disclosure-" + kind + "-" + encodeURIComponent(id); }
function disclosure(document, id, title, content, preserved) {
  const details = preserved.get(id) ?? element(document, "details");
  details.id = id; details.setAttribute("data-disclosure", id);
  const summary = details.firstElementChild ?? element(document, "summary", title);
  summary.id = "summary-" + id;
  // Retain unchanged content nodes as well as the native open state and scroll.
  const nextText = summary.textContent + content.map(node => node.textContent).join("");
  if (details.textContent !== nextText) details.replaceChildren(summary, ...content);
  return details;
}
function history(document, target, records, preserved) {
  if (!records.length) { emptyHistory(document, target, target === "baseline-history" ? "아직 반입한 baseline이 없습니다. 해당 revision의 결과 JSON을 가져오세요." : "미실행 · 실행 가능 여부를 확인하면 요청과 차단 이유가 여기에 기록됩니다."); return; }
  const cards = [...records].reverse().map(record => {
    const card = element(document, "article", undefined, "record");
    const head = element(document, "div", undefined, "record-heading");
    head.append(element(document, "span", LABELS[record.state] ?? record.state, "badge " + (record.state === "passed" ? "success" : ACTIVE.has(record.state) ? "progress" : "warning")), element(document, "span", date(record.createdAt), "timestamp"));
    card.append(head, element(document, "p", record.id, "mono record-id"));
    if (record.code) card.append(element(document, "p", record.code, "record-code mono"));
    if (record.cleanupCode && record.cleanupCode !== record.code) card.append(element(document, "p", record.cleanupCode, "record-code mono"));
    if (record.code === "CLEANUP_UNCONFIRMED" || record.cleanupCode === "CLEANUP_UNCONFIRMED") card.append(element(document, "p", "정리 확인 안 됨 · 실행 종료와 작업 공간 정리를 별도로 확인해야 합니다.", "warning-text"));
    if (record.state === "blocked") card.append(element(document, "p", "실행하지 않았습니다. 아래 환경 조건을 충족하는 격리 Runner를 먼저 검증해야 합니다.", "record-note"));
    if (record.assessment) card.append(element(document, "p", `${record.assessment.files}개 파일 · ${record.assessment.tests}개 테스트 · 통과 ${record.assessment.passed} / 실패 ${record.assessment.failed} / 건너뜀 ${record.assessment.skipped}`, "record-note"));
    if (record.evidence) {
      card.append(element(document, "p", `${record.evidence.platform ?? "실행 OS 미기록"} · Node ${record.evidence.runtime?.node ?? "미기록"} · exit ${record.evidence.exitCode ?? "미확인"}`, "record-note"));
      const content = [element(document, "pre", record.evidence.safeLog || "로그 없음", "log")];
      if (record.evidence.logTruncated) content.push(element(document, "p", "원본 로그가 표시 제한에 따라 생략되었습니다.", "subtle"));
      card.append(disclosure(document, disclosureId("log", record.id), "반입 로그 보기", content, preserved));
    }
    if (ACTIVE.has(record.state)) {
      const button = element(document, "button", record.state === "cancelling" || record.state === "timing_out" ? "정리 확인 중…" : "요청 취소", "button small secondary"); button.type = "button";
      button.id = "cancel-" + record.id; button.setAttribute("data-cancel", record.id); button.disabled = record.state === "cancelling" || record.state === "timing_out"; card.append(button);
    }
    return card;
  }); document.getElementById(target).replaceChildren(...cards);
}




function launchDownloadURL(appId, asset) {
  const digest = asset?.digest ?? (/^asset_[a-f0-9]{64}$/.test(asset?.id ?? "") ? asset.id.slice(6) : null);
  return typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest) ? `/updates/${encodeURIComponent(appId)}/assets/${digest}` : null;
}
function renderOperations(document, appId, result) {
  if (!result || !Array.isArray(result.detections) || !Array.isArray(result.assets) || !Array.isArray(result.deployments) || result.connection && result.connection.appId !== appId || [...result.detections, ...result.assets, ...result.deployments].some(item => item.appId !== appId)) throw new Error("INVALID_OPERATIONS");
  const connection = result.connection;
  document.getElementById("github-connection").replaceChildren(...(connection ? [pair(document, "GitHub", `${connection.owner}/${connection.repository} · ${connection.ref}`), pair(document, "연결 버전", connection.version)] : [element(document, "p", "GitHub 연결 없음", "subtle")]));
  if (connection) for (const [id, value] of [["github-installation", connection.installationId], ["github-owner", connection.owner], ["github-repository", connection.repository], ["github-ref", connection.ref]]) document.getElementById(id).value = String(value);
  const detection = result.detections[0]; if (!document.getElementById("ota-channel").value) document.getElementById("ota-channel").value = "preview"; if (!document.getElementById("ota-platform").value && detection?.platforms?.length) document.getElementById("ota-platform").value = detection.platforms[0]; document.getElementById("github-resolved-config-field").hidden = detection?.configSource !== "dynamic-required"; const target = document.getElementById("framework-detection"); target.replaceChildren();
  if (detection) {
    const empty = document.getElementById("empty"); if (empty?.className.includes("application-empty") && !document.getElementById("snapshot-select").value) empty.replaceChildren(element(document, "h2", "연결한 GitHub 소스"), element(document, "p", `${connection?.owner ?? ""}/${connection?.repository ?? ""} · ${detection.framework} · ${detection.commitSha.slice(0, 12)}`, "mono"), element(document, "p", "설정 근거와 앱별 OTA 이력을 아래에서 확인하세요.", "subtle"));
    target.append(element(document, "h3", "고정 소스의 앱 인식"), pair(document, "Framework", detection.framework), pair(document, "Commit SHA", detection.commitSha, true), pair(document, "Expo / React Native", `${detection.expoVersion ?? "없음"} / ${detection.reactNativeVersion ?? "없음"}`), pair(document, "설정 근거", detection.configSource), pair(document, "Runtime", detection.runtimeVersion ?? "미확인"), pair(document, "Updates URL", detection.updatesUrl ?? "미확인"), pair(document, "OTA", ["flora", "expo", "react-native"].includes(detection.framework) && detection.updatesEnabled && detection.runtimeVersion && detection.configSource !== "dynamic-required" ? "업데이트 설정 확인 · 배포 시 대상 재검증" : "배포 차단 · 앱 설정 확인 필요"));
    for (const reason of detection.reasons ?? []) target.append(element(document, "p", reason, "subtle"));
  } else target.append(element(document, "p", "소스를 동기화하면 commit을 고정해 Expo / React Native 설정을 확인합니다.", "subtle"));
  const guidance = document.getElementById("ota-export-guidance"); guidance.replaceChildren(element(document, "p", "설치된 앱 바이너리에 Flora SDK와 native update engine, 이 앱의 /updates/ URL과 channel이 먼저 설정되어 있어야 합니다. 같은 commit의 작업 디렉터리에서 Metro 또는 OSS Expo export를 실행하고 생성한 플랫폼 launch bundle과 모든 자산을 선택하세요. 동적 app.config는 실행하지 않으며, 확인 가능한 export 설정이 없으면 배포가 차단됩니다.", "subtle"), element(document, "pre", detection?.automationConfig?.bundler === "metro" ? `./node_modules/.bin/react-native bundle --platform ios --dev false --entry-file ${detection.automationConfig.entryFile} --bundle-output dist/main.jsbundle --assets-dest dist/assets` : "npx expo export --platform ios --output-dir dist", "log"));
  const records = document.getElementById("ota-history"); records.replaceChildren();
  for (const deployment of result.deployments) {
    const card = element(document, "article", undefined, "record");
    const launchURL = launchDownloadURL(appId, deployment.launchAsset);
    card.append(element(document, "p", "게시됨 · " + date(deployment.createdAt), "badge success"), pair(document, "앱 / Channel", `${appId} / ${deployment.channel}`), pair(document, "Runtime / Platform", `${deployment.runtimeVersion} / ${deployment.platform}`), pair(document, "Commit SHA", deployment.commitSha, true), pair(document, "Deployment ID", deployment.id, true), pair(document, "업데이트 URL", `/updates/${encodeURIComponent(appId)}?channel=${encodeURIComponent(deployment.channel)}`), pair(document, "Launch 다운로드", launchURL ?? "다운로드 주소 확인 필요"));
    if (launchURL) { const download = element(document, "a", "Launch bundle 다운로드", "button secondary small"); download.href = launchURL; download.download = ""; card.append(download); }
    records.append(card);
  }
  if (!result.deployments.length) records.append(element(document, "p", "게시한 OTA 없음 · 게시 이력은 기기의 다운로드나 설치 확인을 뜻하지 않습니다.", "subtle"));
  return detection;
}


function clearAutomation(document) {
  if (document.getElementById("automation-policy-enabled")) document.getElementById("automation-policy-enabled").checked = false;
  for (const id of ["automation-status", "automation-checklist", "runner-config-template", "automation-config", "automation-runners", "automation-history", "runner-token", "automation-policy-status"]) document.getElementById(id)?.replaceChildren();
  for (const id of ["automation-channel", "automation-platform", "automation-policy-platforms", "runner-name"]) { const input = document.getElementById(id); if (input) input.value = ""; }
  if (document.getElementById("runner-token-panel")) document.getElementById("runner-token-panel").hidden = true;
  if (document.getElementById("automation-editor")) document.getElementById("automation-editor").open = false;
  if (document.getElementById("runner-editor")) document.getElementById("runner-editor").open = false;
}
function policyPlatforms(policy) {
  const values = policy?.platforms ?? (policy?.platform ? [policy.platform] : []);
  if (!Array.isArray(values) || values.length > 2 || values.some(value => !["ios", "android"].includes(value)) || new Set(values).size !== values.length || policy && !values.length) throw new Error("INVALID_POLICY");
  return ["ios", "android"].filter(value => values.includes(value));
}
function policyPlatformValue(platforms) { return platforms.length === 2 ? "both" : platforms[0] ?? ""; }
function selectedPolicyPlatforms(document) {
  const value = document.getElementById("automation-policy-platforms").value;
  return value === "both" ? ["ios", "android"] : ["ios", "android"].includes(value) ? [value] : [];
}
function runnerPresence(runner) {
  if (runner.revokedAt !== null) return { label: "폐기됨", tone: "neutral", lastSeenAt: null };
  const presence = runner.presence;
  if (!presence || !["online", "offline"].includes(presence.status) || !Number.isSafeInteger(presence.lastSeenAt) || presence.lastSeenAt < 0) return { label: "연결 기록 없음", tone: "neutral", lastSeenAt: null };
  return { label: presence.status === "online" ? "온라인" : "오프라인", tone: presence.status === "online" ? "success" : "neutral", lastSeenAt: presence.lastSeenAt };
}
const automationEventLabels = { queued: "작업 대기", claimed: "Runner 작업 시작", heartbeat: "작업 연결 확인", cancel_requested: "취소 요청", succeeded: "OTA 게시 완료", failed: "작업 실패", expired: "작업 연결 만료", cancelled: "취소 완료" };
function automationEventLabel(kind) { return automationEventLabels[kind] ?? "상태 변경"; }
function renderAutomation(document, appId, state, detection, origin) {
  if (!state || !Array.isArray(state.jobs) || !Array.isArray(state.runners) || state.jobs.some(job => job.appId !== appId) || state.runners.some(runner => !Array.isArray(runner.appIds) || !runner.appIds.includes(appId))) throw new Error("INVALID_AUTOMATION");
  if (state.policy && state.policy.appId !== appId) throw new Error("INVALID_POLICY");
  document.getElementById("automation-policy-enabled").checked = state.policy?.enabled === true;
  document.getElementById("automation-policy-status").textContent = state.policy ? `자동 OTA ${state.policy.enabled ? "켜짐" : "꺼짐"} · 정책 버전 ${state.policy.version} · ${state.policy.channel} / ${policyPlatforms(state.policy).map(value => value === "ios" ? "iOS" : "Android").join(" + ")}` : "자동 OTA 꺼짐 · 명시적으로 저장한 뒤 적용됩니다.";
  const config = detection?.automationConfig;
  const platformInput = document.getElementById("automation-policy-platforms");
  const supported = config?.platforms ?? [];
  const draft = platformInput.value;
  const options = [["both", "iOS + Android"], ["ios", "iOS"], ["android", "Android"]].map(([value, label]) => {
    const option = element(document, "option", label); option.value = value;
    option.disabled = (value === "both" ? ["ios", "android"] : [value]).some(platform => !supported.includes(platform)); return option;
  });
  platformInput.replaceChildren(...options); platformInput.value = draft || policyPlatformValue(state.policy ? policyPlatforms(state.policy) : ["ios", "android"].filter(value => supported.includes(value)));
  const checklist = document.getElementById("automation-checklist"); checklist.replaceChildren();
  for (const [label, ready] of [["GitHub 커밋 인식", Boolean(detection?.commitSha)], ["체크인한 Flora SDK 설정", detection?.configSource === "flora.config.json" && Boolean(config)], ["이 앱의 PC Runner 온라인", state.runners.some(runner => runner.revokedAt === null && runnerPresence(runner).label === "온라인")], ["GitHub push 자동 OTA 정책", state.policy?.enabled === true], ["Runner 산출물 게시", state.jobs.some(job => job.state === "succeeded" && job.deploymentId)]]) checklist.append(element(document, "li", `${ready ? "확인됨" : "준비 필요"} · ${label}`));
  checklist.append(element(document, "li", "기기 적용 미검증 · 설치된 바이너리의 네이티브 엔진과 실제 업데이트를 별도로 확인하세요."));
  document.getElementById("runner-config-template").textContent = JSON.stringify({ origin: origin || "https://flora.example.com", token: "REPLACE_WITH_ONE_TIME_RUNNER_ENROLLMENT_TOKEN", dockerImage: "registry.example.com/flora-export@sha256:REPLACE_WITH_VERIFIED_IMAGE_DIGEST", workDirectory: "/private/runner/work" }, null, 2);
  document.getElementById("runner-scope-note").textContent = `선택 앱 ${appId}에 권한을 등록하세요. 앱 ID는 서버의 등록 권한에 묶이며 설정 파일에 추가하지 않습니다.`;
  const target = document.getElementById("automation-config"); target.replaceChildren();
  if (config) target.append(pair(document, "고정 Commit SHA", detection.commitSha, true), pair(document, "SDK 설정 근거", detection.configSource), pair(document, "Bundler / Entry", `${config.bundler} / ${config.entryFile}`), pair(document, "고정 도구 버전", `Node ${config.toolchain.nodeVersion} · ${config.toolchain.packageManager.name} ${config.toolchain.packageManager.version}`), pair(document, "Native runtime", config.runtimeVersion));
  else target.append(element(document, "p", "자동 작업에는 Flora SDK와 GitHub 소스에 체크인한 flora.config.json이 필요합니다. 소스를 동기화해 설정을 확인하세요.", "subtle"));
  const runners = document.getElementById("automation-runners"); runners.replaceChildren();
  for (const runner of state.runners) {
    const presence = runnerPresence(runner); const row = element(document, "div", undefined, "record"); row.append(element(document, "p", runner.name, "record-note"), element(document, "p", presence.label, "badge " + presence.tone), pair(document, "마지막 연결 확인", presence.lastSeenAt === null ? "연결 기록 없음" : date(presence.lastSeenAt)), element(document, "p", runner.id, "mono"), pair(document, "Runner 적용 앱", runner.appIds.join(" · ")));
    if (runner.revokedAt === null) { const button = element(document, "button", "Runner 전체 권한 폐기", "button secondary small"); button.type = "button"; button.setAttribute("data-revoke-runner", runner.id); row.append(button); } runners.append(row);
  }
  if (!state.runners.some(runner => runner.revokedAt === null)) runners.append(element(document, "p", "이 앱의 활성 Runner 없음 · 자동 작업 요청 불가", "warning-text"));
  const history = document.getElementById("automation-history"); const disclosures = new Map(Array.from(history.querySelectorAll?.("details[data-job]") ?? []).map(node => [node.getAttribute("data-job"), node])); history.replaceChildren();
  const names = { queued: "Runner 대기", leased: "Runner 할당됨 · 결과 대기", cancel_requested: "취소 처리 중", succeeded: "Runner 산출물 게시 완료", failed: "작업 실패", cancelled: "취소됨" };
  for (const job of state.jobs) {
    const card = element(document, "article", undefined, "record");
    card.append(element(document, "p", names[job.state] ?? "상태 미확인", "badge " + (job.state === "succeeded" ? "success" : "neutral")), pair(document, "작업 / 앱", `${job.id} / ${job.appId}`), pair(document, "Channel / Platform", `${job.channel} / ${job.platform}`), pair(document, "Commit SHA", job.commitSha, true), pair(document, "Runtime", job.runtimeVersion), pair(document, "Runner 시도", job.attemptCount), pair(document, "작업 등록", date(job.createdAt)), pair(document, "마지막 상태 변경", date(job.updatedAt)));
    if (job.lease) card.append(pair(document, "Claim / Runner", `${job.lease.attemptId} / ${job.lease.runnerId}`), pair(document, "Lease 만료", date(job.lease.expiresAt)));
    if (job.code) card.append(pair(document, "결과 코드", job.code));
    if (job.deploymentId) card.append(pair(document, "자동 OTA 게시 ID", job.deploymentId, true));
    if (["queued", "leased"].includes(job.state)) { const button = element(document, "button", "자동 작업 취소", "button secondary small"); button.type = "button"; button.setAttribute("data-cancel-automation", job.id); card.append(button); }
    const detail = disclosures.get(job.id) ?? element(document, "details"); detail.setAttribute("data-job", job.id); const summary = element(document, "summary", "시도 · 상태 변경 · 실패 도움말");
    const detailBody = element(document, "div", "열어서 작업별 이력을 확인하세요.", "automation-job-detail"); detailBody.id = "automation-job-" + job.id;
    if (!disclosures.has(job.id)) detail.append(summary, detailBody);
    summary.setAttribute("data-automation-job", job.id); card.append(detail); history.append(card);
  }
  if (!state.jobs.length) history.append(element(document, "p", "자동 작업 없음 · 아래 수동 파일 게시와 별도로 기록됩니다.", "subtle"));
  if (!document.getElementById("automation-channel").value) document.getElementById("automation-channel").value = "preview";
  if (!document.getElementById("automation-platform").value && config?.platforms?.length) document.getElementById("automation-platform").value = config.platforms[0];
  if (!document.getElementById("runner-name").value) document.getElementById("runner-name").value = "UULab Runner";
}

function clearOperations(document) {
  clearAutomation(document);
  for (const id of ["operations-status", "github-connection", "framework-detection", "ota-export-guidance", "ota-history"]) document.getElementById(id)?.replaceChildren();
  for (const id of ["github-installation", "github-owner", "github-repository", "github-ref", "github-resolved-config", "ota-channel", "ota-platform", "ota-launch", "ota-assets"]) { const input = document.getElementById(id); if (input) input.value = ""; }
  const panel = document.getElementById("application-operations"); if (panel) panel.hidden = true;
  const config = document.getElementById("github-resolved-config-field"); if (config) config.hidden = true;
  const manual = document.getElementById("ota-manual-editor"); if (manual) manual.open = false;
  const editor = document.getElementById("operations-editor"); if (editor) editor.open = false;
}

function renderProjectCards(document, state) {
  const target = document.getElementById("project-list"); if (!target) return;
  const apps = state.applications ?? [];
  const query = (document.getElementById("project-search")?.value ?? "").trim().toLocaleLowerCase();
  const total = document.getElementById("project-total"); if (total) total.textContent = `${apps.length}개 프로젝트`;
  const visible = apps.filter(app => `${app.name} ${app.id}`.toLocaleLowerCase().includes(query));
  const cards = visible.map(app => {
    const selected = state.selectedApplication?.id === app.id;
    const card = element(document, "button", undefined, "project-card" + (selected ? " selected" : ""));
    card.type = "button"; card.id = "project-card-" + app.id;
    card.setAttribute("data-select-application", app.id); card.setAttribute("aria-pressed", String(selected));
    const head = element(document, "div", undefined, "project-card-head");
    head.append(element(document, "span", app.name?.trim().slice(0, 1).toUpperCase() || "F", "project-avatar"), element(document, "span", selected ? "선택됨" : "프로젝트", "project-card-state"));
    card.append(head, element(document, "h3", app.name, "project-card-title"), element(document, "p", app.id, "project-card-meta mono"));
    if (selected) card.append(element(document, "p", state.selectedApplication.repositoryId + " · " + state.selectedApplication.rootDirectory, "project-card-meta"));
    card.append(element(document, "span", app.createdAt ? "등록 " + date(app.createdAt) : "앱별 설정과 배포 관리", "project-card-footer"));
    return card;
  });
  target.replaceChildren(...(cards.length ? cards : [element(document, "p", apps.length ? "검색한 프로젝트가 없습니다." : "첫 프로젝트를 등록해 GitHub 소스와 OTA 배포를 연결하세요.", "project-empty")]));
}
function resetProjectRegistration(document) {
  document.getElementById("application-form")?.reset?.();
  for (const id of ["project-search", "application-name", "application-repository"]) { const input = document.getElementById(id); if (input) input.value = ""; }
  const root = document.getElementById("application-root"); if (root) root.value = ".";
}

function renderApplications(document, state) {
  renderProjectCards(document, state);
  const panel = document.getElementById("application-panel"); if (!panel) return;
  panel.hidden = !Array.isArray(state.applications);
  const app = state.selectedApplication;
  const title = document.getElementById("selected-project-title"); if (title) title.textContent = app ? safe(app.name) : "선택한 프로젝트";
  if (panel.getAttribute("data-selected-app") !== (app?.id ?? "")) { clearOperations(document); panel.setAttribute("data-selected-app", app?.id ?? ""); }
  if (document.getElementById("application-operations")) document.getElementById("application-operations").hidden = !app;
  select(document, "application-select", (state.applications ?? []).map(item => [item.id, item.name + " · " + item.id.slice(-8)]), app?.id);
  document.getElementById("application-count").textContent = `${state.applications?.length ?? 0}개`;
  document.getElementById("application-settings").hidden = !app;
  document.getElementById("application-identity").textContent = app ? safe(`${app.name} · ${app.repositoryId} · ${app.rootDirectory}`) : "";
  const input = document.getElementById("settings-json");
  const revision = app ? `${app.id}:${app.settings.version}` : "";
  if (input.getAttribute("data-version") !== revision) { if (document.getElementById("settings-editor") && !input.getAttribute("data-version")?.startsWith(app?.id + ":")) document.getElementById("settings-editor").open = false; input.value = app ? JSON.stringify(app.settings.values, null, 2) : ""; input.setAttribute("data-version", revision); }
  document.getElementById("settings-version").textContent = app ? `설정 버전 ${app.settings.version}` : "";
}
function clearApplications(document, all = false) {
  clearOperations(document);
  for (const id of ["selected-project-title", "application-identity", "settings-version"]) document.getElementById(id)?.replaceChildren();
  const input = document.getElementById("settings-json"); if (input) { input.value = ""; input.setAttribute("data-version", ""); }
  if (document.getElementById("settings-editor")) document.getElementById("settings-editor").open = false;
  if (document.getElementById("application-settings")) document.getElementById("application-settings").hidden = true;
  if (all) { for (const id of ["project-list", "project-total", "application-select", "application-count"]) document.getElementById(id)?.replaceChildren(); for (const id of ["project-search", "application-name", "application-repository", "application-root"]) { const input = document.getElementById(id); if (input) input.value = ""; } if (document.getElementById("application-panel")) { document.getElementById("application-panel").hidden = true; document.getElementById("application-panel").setAttribute("data-selected-app", ""); } }
}
function publicValues(text) {
  const values = JSON.parse(text);
  if (!values || Array.isArray(values) || typeof values !== "object" || Object.keys(values).length > 64 || Object.entries(values).some(([key, value]) => !/^[A-Z][A-Z0-9_]{0,127}$/.test(key) || typeof value !== "string" || value.length > 2048 || value.includes("\0"))) throw new Error("INVALID_INPUT");
  if (new TextEncoder().encode(JSON.stringify(values)).length > 8192) throw new Error("INVALID_INPUT");
  return values;
}

/** Render imported evidence with text nodes only; no evidence becomes markup or navigation. */
export function renderDashboard(document, state) {
  renderApplications(document, state);
  const focusedId = document.activeElement?.id;
  const preserved = new Map();
  for (const id of [...state.history.map(record => disclosureId("log", record.id)), ...state.providers.map(report => disclosureId("provider", report.providerId))]) {
    const previous = document.getElementById(id);
    if (previous?.getAttribute("data-disclosure") === id) preserved.set(id, previous);
  }
  const selected = state.snapshots.find(snapshot => snapshot.id === state.selectedSnapshotId);
  document.getElementById("workspace").setAttribute("aria-busy", "false");
  document.getElementById("dashboard-content").hidden = !selected;
  document.getElementById("empty").hidden = Boolean(selected);
  document.getElementById("baseline-file").disabled = !selected;
  document.getElementById("run-button").disabled = !selected;
  if (!selected) {
    if (state.selectedApplication) { const empty = document.getElementById("empty"); empty.className = "empty-card application-empty"; empty.replaceChildren(element(document, "h2", "GitHub 앱 소스를 확인하세요"), element(document, "p", "GitHub 연결 · 앱 인식 버튼에서 설치 ID와 저장소를 연결하세요. 일회성 소스 JSON 반입은 아래 고급 메뉴에서 사용할 수 있습니다.", "subtle")); return; }
    if (state.applications?.length) { const empty = document.getElementById("empty"); empty.className = "empty-card application-empty"; empty.replaceChildren(element(document, "h2", "프로젝트를 선택해 주세요"), element(document, "p", "위의 프로젝트 카드를 열면 앱별 GitHub 소스와 OTA 배포 이력을 확인할 수 있습니다.", "subtle")); return; }
    const empty = document.getElementById("empty"); empty.replaceChildren(element(document, "p", "시작할 준비가 됐어요", "eyebrow"), element(document, "h2", "첫 소스 snapshot을 가져오세요"), element(document, "p", "소스 JSON을 선택하면 앱·revision·11개 flavor와 런타임 선언을 한곳에서 확인할 수 있습니다."), element(document, "p", "파일 경로나 .env 설정은 필요 없습니다. 이 화면은 파일 안의 코드를 실행하지 않습니다.", "subtle"));
    return;
  }
  set(document, "app-name", selected.repository.fullName);
  const fresh = state.freshness === "observed_current" ? "관측 시점에 일치" : state.freshness === "stale" ? "관측 HEAD와 다름" : "최신 여부 알 수 없음";
  set(document, "freshness", fresh); document.getElementById("freshness").className = "badge " + (state.freshness === "observed_current" ? "neutral" : "warning");
  select(document, "snapshot-select", [...state.snapshots].reverse().map(item => [item.id, `${item.commitSha.slice(0, 12)} · ${date(item.importedAt)}`]), selected.id);
  document.getElementById("source-meta").replaceChildren(pair(document, "소스 수집", date(selected.fetchedAt)), pair(document, "화면에 반입", date(selected.importedAt)));
  set(document, "trust-note", "사용자 반입 · 일회성 소스 snapshot. 해시는 반입한 파일의 내부 일치성을 확인합니다. 실시간 GitHub 연결이나 실행·격리 인증을 뜻하지 않습니다.");
  const details = document.getElementById("source-details"); details.replaceChildren(pair(document, "Commit", selected.commitSha, true), pair(document, "Source digest", selected.digest, true), pair(document, "Root", selected.rootDirectory, true), pair(document, "Snapshot", selected.id, true));
  if (state.headObservation) details.append(pair(document, "반입한 HEAD 관측", `${state.headObservation.headCommitSha} · ${date(state.headObservation.observedAt)}`));
  for (const file of selected.files) details.append(pair(document, file.path, `${file.byteLength} bytes · blob ${file.gitBlobSha}`, true));
  set(document, "flavor-count", `${selected.flavors.length}개`);
  const existingFlavor = document.getElementById("flavor-select").value;
  const flavorId = selected.flavors.some(item => item.id === existingFlavor) ? existingFlavor : selected.selectedFlavor;
  select(document, "flavor-select", selected.flavors.map(flavor => [flavor.id, `${flavor.id} · ${flavor.appName.value}`]), flavorId);
  const flavor = selected.flavors.find(item => item.id === flavorId) ?? selected.flavors[0];
  const flavorDetail = document.getElementById("flavor-detail"); flavorDetail.replaceChildren();
  if (flavor) {
    for (const [label, fact] of [["앱 이름", flavor.appName], ["제품 유형", flavor.productType], ["패키지 선언", flavor.declaredPackage]]) {
      flavorDetail.append(pair(document, label, fact.value), element(document, "p", pointer(fact), "source-pointer mono"));
    }
  }
  const runtime = selected.runtime;
  document.getElementById("runtime").replaceChildren(...[
    ["앱 버전", runtime.appVersion?.value ?? "선언 없음"], ["Node engine", runtime.nodeEngine?.value ?? "선언 없음"],
    ...Object.entries(runtime.versions).map(([key, value]) => [key, value?.value ?? "선언 없음"]),
    ["Lockfile", `v${runtime.lockfileVersion.value} · ${runtime.packageEntryCount.value}개 항목`],
    ["runtimeVersion / 광고 / OTA", "미평가"], ["설치된 바이너리", "확인하지 않음"],
  ].map(([label, value]) => pair(document, label, value)));
  const profile = document.getElementById("profile"); profile.replaceChildren(element(document, "h3", "고정 검증 범위"), element(document, "p", state.profile.id, "mono profile-id"), element(document, "p", "2개 파일 · 4개 테스트", "coverage-count"), element(document, "p", state.profile.coverage, "subtle"));
  for (const file of state.profile.files) profile.append(element(document, "p", file, "mono source-pointer"));
  const provider = document.getElementById("provider"); provider.replaceChildren(element(document, "h3", "실행 환경 준비 상태"));
  if (!state.providers.length) provider.append(element(document, "p", "등록된 격리 Runner 없음 · 실행 차단", "warning-text"));
  for (const report of state.providers) {
    const ready = Object.values(report.checks).every(value => value === "passed");
    provider.append(element(document, "p", ready ? "보고된 환경 조건 충족 · 요청 시 재확인" : "실행 차단 · 검증된 격리 환경이 필요합니다", ready ? "record-note" : "warning-text"), element(document, "p", `${report.providerId} · 실행 OS: ${report.os ?? "미확인"}`, "mono source-pointer"));
    const checks = element(document, "div", undefined, "checks");
    for (const [key, value] of Object.entries(report.checks)) checks.append(element(document, "span", `${CHECKS[key] ?? key} · ${value === "passed" ? "확인" : value === "failed" ? "실패" : "미확인"}`, "check"));
    provider.append(checks);
    provider.append(disclosure(document, disclosureId("provider", report.providerId), "조건과 차단 이유 확인", report.reasons.map(reason => element(document, "p", reason, "reason")), preserved));
  }
  const active = state.history.find(record => ACTIVE.has(record.state));
  document.getElementById("run-button").disabled = Boolean(active);
  set(document, "run-button", active ? "진행 중 · 이력에서 확인" : "실행 가능 여부 확인");
  history(document, "baseline-history", state.history.filter(record => record.evidenceKind === "development-baseline"), preserved);
  history(document, "run-history", state.history.filter(record => record.evidenceKind === "isolated-runner-result"), preserved);
  if (focusedId) { const focused = document.getElementById(focusedId); if (focused && !focused.disabled) focused.focus(); }
}

export function renderStatus(document, status, code = "") {
  const node = document.getElementById("notice"); node.hidden = status === "ready";
  document.getElementById("retry-button").hidden = status !== "error";
  node.className = "notice " + (status === "error" || status === "session" ? "notice-error" : "");
  node.setAttribute("role", status === "error" || status === "session" ? "alert" : "status");
  node.textContent = status === "loading" ? "불러오는 중… 세션과 반입 이력을 확인하고 있습니다." : status === "session" ? "세션이 없거나 만료되었습니다. 실행 중인 서버가 안내한 최초 접속 링크를 열어주세요. 이미 사용한 링크라면 서버를 재시작해 새 링크를 받으세요." : status === "error" ? `요청을 완료하지 못했습니다 (${safe(code, 96)}). 선택한 revision과 JSON 파일의 형식·크기를 확인한 뒤 다시 시도하세요. 연결 오류라면 로컬 서버가 실행 중인지 확인하세요.` : status === "saving" ? "처리 중… 완료 후 이력을 갱신합니다." : "";
  document.getElementById("workspace").setAttribute("aria-busy", status === "loading" ? "true" : "false");
  if (status === "session") {
    clearApplications(document, true);
    for (const id of ["application-select", "application-register", "settings-save", "settings-json"]) { const node = document.getElementById(id); if (node) node.disabled = true; }
    document.getElementById("dashboard-content").hidden = true; document.getElementById("empty").hidden = true;
    for (const id of ["app-name", "source-meta", "source-details", "flavor-detail", "runtime", "profile", "provider", "baseline-history", "run-history", "snapshot-select", "flavor-select", "trust-note", "freshness", "flavor-count", "empty"]) document.getElementById(id).replaceChildren();
    document.getElementById("source-file").disabled = true; document.getElementById("baseline-file").disabled = true; document.getElementById("run-button").disabled = true;
  }
}

/** Injectable browser boundary keeps rendering and reload behavior testable in Node. */
export async function startClient(env) {
  const { document } = env;
  const fragment = env.location.hash.slice(1);
  const bootstrap = /^[a-f0-9]{64}$/.test(fragment) ? fragment : "";
  // Remove the secret before the first network request or asynchronous work.
  if (bootstrap) env.history.replaceState(null, "", env.location.pathname + env.location.search);
  let csrf = ""; let data = null; let selectedId; let selectedAppId; let reading = false; let timer; let stopped = false; let generation = 0; let busy = false;
  let operations = null; let operationsAppId = null; let deploymentRequestKey = null; let automation = null; let automationAppId = null; let automationRequestKey = null; let runnerToken = ""; let runnerTokenAppId = null; let automationTimer; let automationPollDelay = 5000; let automationLoading = null; let detailEpoch = 0; const detailLoading = new Set();
  const requestKeys = new Map();
  async function api(url, body, csrfValue = csrf, raw = false) {
    const response = await env.fetch(url, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", headers: body === undefined ? {} : { "Content-Type": raw ? "application/octet-stream" : "application/json", "X-Flora-CSRF": csrfValue }, ...(body === undefined ? {} : { body: raw ? body : typeof body === "string" ? body : JSON.stringify(body) }) });
    if (!response.ok) { const error = new Error(response.status === 401 ? "SESSION_REQUIRED" : response.status === 413 ? "BODY_TOO_LARGE" : "REQUEST_FAILED"); error.status = response.status; throw error; }
    return response.status === 204 ? null : response.json();
  }
  function appControls() { operationControls(); const githubOpen = document.getElementById("github-open"); if (githubOpen) githubOpen.disabled = stopped || !csrf; for (const id of ["application-register", "settings-save", "settings-json"]) { const input = document.getElementById(id); if (input) input.disabled = stopped || busy || reading || (id !== "application-register" && !data?.selectedApplication); } }
  function scoped(url) { return selectedAppId ? url + (url.includes("?") ? "&" : "?") + "appId=" + encodeURIComponent(selectedAppId) : url; }
  function failure(error) { if (stopped) return; if (error.status === 401) { stopped = true; stopAutomationPoll(); runnerToken = ""; runnerTokenAppId = null; automation = null; automationAppId = null; operations = null; operationsAppId = null; data = null; csrf = ""; requestKeys.clear(); env.clearTimeout(timer); renderStatus(document, "session"); appControls(); } else renderStatus(document, "error", error.message === "BODY_TOO_LARGE" ? "BODY_TOO_LARGE" : error.message === "INVALID_INPUT" ? "INVALID_INPUT" : "REQUEST_FAILED"); }
  function schedule() {
    env.clearTimeout(timer);
    if (!stopped && data?.history.some(record => ACTIVE.has(record.state))) timer = env.setTimeout(() => { void refresh().catch(failure); }, 1000);
  }
  async function refresh() {
    const version = ++generation; reading = true; appControls();
    let next;
    try { next = await api(scoped("/api/state" + (selectedId ? "?snapshotId=" + encodeURIComponent(selectedId) : ""))); }
    catch (error) { if (stopped || version !== generation) return false; reading = false; appControls(); throw error; }
    if (stopped || version !== generation) return false;
    data = next; selectedId = data.selectedSnapshotId; selectedAppId = data.selectedApplication?.id; reading = false;
    const active = data.history.find(record => record.requestKind === "run-request" && ACTIVE.has(record.state));
    if (active) requestKeys.set(selectedId, active.requestKey);
    else if (data.history.some(record => record.requestKey === requestKeys.get(selectedId))) requestKeys.delete(selectedId);
    renderDashboard(document, data); appControls(); schedule(); return true;
  }
  async function mutate(work) {
    if (stopped || busy || reading) return;
    const version = generation; busy = true; appControls(); renderStatus(document, "saving"); document.getElementById("run-button").disabled = true;
    document.getElementById("source-file").disabled = true; document.getElementById("baseline-file").disabled = true;
    try { await work(); if (stopped || version !== generation) return; const current = await refresh(); if (current && !stopped) renderStatus(document, "ready"); }
    catch (error) { if (version === generation) { failure(error); schedule(); } }
    finally { busy = false; appControls(); if (!stopped && version <= generation && !reading) { document.getElementById("source-file").disabled = false; document.getElementById("baseline-file").disabled = !data?.selectedSnapshotId; if (data) renderDashboard(document, data); } }
  }
  async function importFile(kind, file) {
    if (!file) return;
    const appAtStart = selectedAppId; const version = generation;
    await mutate(async () => {
      if (file.size > 2 * 1024 * 1024) throw new Error("BODY_TOO_LARGE");
      const content = await file.text();
      if (stopped || version !== generation) return;
      try { JSON.parse(content); } catch { throw new Error("INVALID_INPUT"); }
      if (kind === "source") { const imported = await api("/api/sources", content); if (stopped || version !== generation || appAtStart !== selectedAppId) return; selectedId = imported.id; selectedAppId = undefined; }
      else if (selectedId) await api(scoped("/api/baselines?snapshotId=" + encodeURIComponent(selectedId)), content);
    });
  }
  async function run() {
    if (!selectedId || reading || busy) return;
    const snapshotId = selectedId;
    let requestKey = requestKeys.get(snapshotId); if (!requestKey) { requestKey = env.crypto.randomUUID(); requestKeys.set(snapshotId, requestKey); }
    await mutate(async () => { await api(scoped("/api/runs"), { snapshotId, requestKey }); });
  }
  async function cancel(recordId) { if (!data?.history.some(record => record.id === recordId && ACTIVE.has(record.state))) return; await mutate(async () => { await api(scoped("/api/runs/" + encodeURIComponent(recordId) + "/cancel"), {}); }); }
  async function chooseSnapshot(id) { if (stopped || busy) return; selectedId = id; renderStatus(document, "loading"); try { const current = await refresh(); if (current && !stopped) renderStatus(document, "ready"); } catch (error) { failure(error); } }
  async function chooseApplication(id) {
    if (stopped) return;
    generation++; stopAutomationPoll(); automation = null; automationAppId = null; automationRequestKey = null; runnerToken = ""; runnerTokenAppId = null; operations = null; operationsAppId = null; deploymentRequestKey = null; selectedAppId = id; selectedId = undefined; data = null; requestKeys.clear(); env.clearTimeout(timer);
    clearApplications(document);
    for (const id of ["app-name", "source-meta", "source-details", "flavor-detail", "runtime", "profile", "provider", "baseline-history", "run-history", "snapshot-select", "flavor-select", "trust-note", "freshness", "flavor-count", "empty"]) document.getElementById(id).replaceChildren();
    document.getElementById("dashboard-content").hidden = true; document.getElementById("empty").hidden = true;
    document.getElementById("run-button").disabled = true; document.getElementById("baseline-file").disabled = true;
    env.addEventListener?.("pagehide", () => { stopped = true; generation++; stopAutomationPoll(); runnerToken = ""; runnerTokenAppId = null; automation = null; automationAppId = null; operations = null; operationsAppId = null; data = null; csrf = ""; requestKeys.clear(); env.clearTimeout(timer); renderStatus(document, "session"); });
  renderStatus(document, "loading"); try { if (await refresh()) renderStatus(document, "ready"); } catch (error) { reading = false; failure(error); }
  }
  function automationWrite(work) { return operationWrite(work, "automation-status"); }
  function automationControls() {
    const ready = !stopped && !busy && !reading && Boolean(selectedAppId);
    for (const id of ["automation-refresh", "runner-enroll"]) { const input = document.getElementById(id); if (input) input.disabled = !ready; }
    const detection = operationsAppId === selectedAppId ? operations?.detections[0] : null;
    const runners = automationAppId === selectedAppId ? automation?.runners ?? [] : [];
    const enabled = ready && detection?.updatesEnabled && detection.configSource === "flora.config.json" && detection.automationConfig && runners.some(runner => runner.revokedAt === null && runner.appIds.includes(selectedAppId));
    const button = document.getElementById("automation-queue"); if (button) button.disabled = !enabled;
    const policy = document.getElementById("automation-policy-save"); if (policy) policy.disabled = !ready || (document.getElementById("automation-policy-enabled").checked && !enabled);
    const copy = document.getElementById("runner-token-copy"); if (copy) copy.disabled = !ready || !runnerToken || runnerTokenAppId !== selectedAppId;
  }
  function stopAutomationPoll() { env.clearTimeout(automationTimer); automationTimer = undefined; detailEpoch++; detailLoading.clear(); }
  function scheduleAutomationPoll() {
    env.clearTimeout(automationTimer); automationTimer = undefined;
    if (stopped || document.hidden || !document.getElementById("automation-editor").open || automationAppId !== selectedAppId || !automation || (!automation.jobs.some(job => ["queued", "leased", "cancel_requested"].includes(job.state)) && !automation.runners.some(runner => runner.revokedAt === null))) return;
    automationTimer = env.setTimeout(() => { env.clearTimeout(automationTimer); automationTimer = undefined; if (busy || reading) scheduleAutomationPoll(); else void loadAutomation(); }, automation.jobs.some(job => ["queued", "leased", "cancel_requested"].includes(job.state)) ? automationPollDelay : 30000);
  }
  async function copyRunnerConfig() {
    const version = generation; const appId = selectedAppId; if (stopped) return;
    try { if (!env.navigator?.clipboard) throw new Error("CLIPBOARD_UNAVAILABLE"); await env.navigator.clipboard.writeText(document.getElementById("runner-config-template").textContent); }
    catch { if (generation === version && selectedAppId === appId && !(stopped)) document.getElementById("automation-status").textContent = "복사 기능을 사용할 수 없습니다. 표시된 비밀 없는 템플릿을 직접 복사하세요."; }
  }
  async function loadAutomationJob(jobId) {
    const appId = selectedAppId; const version = generation; const epoch = detailEpoch;
    if (stopped || automationAppId !== appId || !automation?.jobs.some(job => job.id === jobId) || detailLoading.has(jobId)) return;
    const target = document.getElementById("automation-job-" + jobId); detailLoading.add(jobId); target.textContent = "작업별 이력을 확인하는 중…";
    const current = () => !(stopped) && generation === version && selectedAppId === appId && detailEpoch === epoch;
    try {
      const result = await api("/api/apps/" + encodeURIComponent(appId) + "/automation/jobs/" + encodeURIComponent(jobId)); if (!current()) return;
      if (result?.job?.appId !== appId || result.job.id !== jobId || !Array.isArray(result.attempts) || !Array.isArray(result.events) || result.attempts.some(item => item.jobId !== jobId) || result.events.some(item => item.jobId !== jobId)) throw new Error("INVALID_JOB_DETAIL");
      target.replaceChildren();
      const help = { EXPORT_FAILED: "고정 Node·패키지 관리자, lockfile, export 이미지와 오프라인 의존성 캐시를 확인하세요.", SOURCE_UNAVAILABLE: "GitHub App 설치 권한과 고정 커밋 접근을 확인하세요.", CONFIG_CHANGED: "체크인한 flora.config.json을 다시 동기화하고 새 작업을 요청하세요.", ARTIFACT_INVALID: "export 자산 경로·크기·해시와 플랫폼 번들을 확인하세요.", LEASE_EXPIRED: "Runner 프로세스와 heartbeat 연결을 확인하세요. 만료된 시도는 게시할 수 없습니다.", RUNNER_REVOKED: "폐기된 토큰을 재사용하지 말고 새 Runner 권한을 등록하세요.", CANCELLED: "취소된 작업입니다. 다시 게시하려면 새 작업을 요청하세요.", PUBLICATION_REJECTED: "앱·runtime·channel 설정과 더 최근 작업의 게시 이력을 확인하세요." };
      if (result.job.code) target.append(element(document, "p", help[result.job.code] ?? "작업 결과 코드를 확인하세요.", "subtle"));
      for (const attempt of result.attempts) target.append(element(document, "p", `시도 ${attempt.id} · ${attempt.outcome ? automationEventLabel(attempt.outcome) : "진행 중"} · ${date(attempt.claimedAt)}${attempt.code ? " · " + attempt.code : ""}`, "record-note"));
      for (const event of result.events) target.append(element(document, "p", `${date(event.createdAt)} · ${automationEventLabel(event.kind)}${event.code ? " · " + event.code : ""}`, "record-note"));
      if (!result.attempts.length && !result.events.length) target.append(element(document, "p", "등록된 시도·상태 변경 없음", "subtle"));
    } catch (error) { if (current()) { if (error.status === 401) failure(error); else target.textContent = "작업별 이력을 확인하지 못했습니다. 닫았다가 다시 열어 확인하세요."; } }
    finally { if (detailEpoch === epoch) detailLoading.delete(jobId); }
  }
  async function loadAutomation() {
    const appId = selectedAppId; const version = generation; const loadKey = appId + ":" + version; if (!appId || stopped || automationLoading === loadKey) return false;
    automationLoading = loadKey;
    const current = () => !stopped && version === generation && selectedAppId === appId;
    document.getElementById("automation-status").textContent = "Runner와 자동 작업을 확인하는 중…";
    try {
      if (operationsAppId !== appId) await loadOperations(); if (!current()) return false;
      const result = await api("/api/apps/" + encodeURIComponent(appId) + "/automation"); if (!current()) return false;
      renderAutomation(document, appId, result, operationsAppId === appId ? operations?.detections[0] : null, env.location?.origin);
      if (result.policy && (automationAppId !== appId || automation?.policy?.version !== result.policy.version)) {
        document.getElementById("automation-channel").value = result.policy.channel;
        document.getElementById("automation-platform").value = policyPlatforms(result.policy)[0];
        document.getElementById("automation-policy-platforms").value = policyPlatformValue(policyPlatforms(result.policy));
      }
      automation = result; automationAppId = appId; automationPollDelay = 5000; automationControls();
      document.getElementById("automation-status").textContent = "Runner와 자동 작업 이력을 확인했습니다."; return true;
    } catch (error) {
      if (!current()) return false;
      if (error.status === 401) { failure(error); return false; }
      automationPollDelay = 10000; document.getElementById("automation-status").textContent = "자동 작업 이력을 확인하지 못했습니다. 다시 확인해 주세요."; return false;
    } finally { if (automationLoading === loadKey) { automationLoading = null; scheduleAutomationPoll(); } }
  }
  async function queueAutomation() {
    const appId = selectedAppId; const detection = operationsAppId === appId ? operations?.detections[0] : null;
    if (stopped || busy || reading || !detection?.updatesEnabled || detection.configSource !== "flora.config.json" || !detection.automationConfig || automationAppId !== appId || !automation?.runners.some(runner => runner.revokedAt === null && runner.appIds.includes(appId))) return;
    const channel = document.getElementById("automation-channel").value; const platform = document.getElementById("automation-platform").value;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(channel) || !detection.automationConfig.platforms.includes(platform)) { document.getElementById("automation-status").textContent = "고정 설정에 맞는 channel과 플랫폼을 선택하세요."; return; }
    if (!automationRequestKey) automationRequestKey = "job_" + globalThis.crypto.randomUUID();
    const input = { requestKey: automationRequestKey, detectionId: detection.id, channel, platform, runtimeVersion: detection.automationConfig.runtimeVersion, config: detection.automationConfig };
    return automationWrite(async (id, current) => { const result = await api("/api/apps/" + encodeURIComponent(id) + "/automation/jobs", input); if (!current()) return; if (result?.appId !== id || typeof result.id !== "string") throw new Error("INVALID_JOB"); automationRequestKey = null; await loadAutomation(); return "작업 요청 접수 · " + ({ queued: "Runner 대기", leased: "Runner 할당됨 · 결과 대기", succeeded: "산출물 게시 완료", failed: "실패", cancelled: "취소됨", cancel_requested: "취소 처리 중" }[result.state] ?? "상태 미확인"); });
  }
  async function saveAutomationPolicy() {
    if (stopped || busy || reading || automationAppId !== selectedAppId || !automation) return;
    const enabled = document.getElementById("automation-policy-enabled").checked;
    const detection = operationsAppId === selectedAppId ? operations?.detections[0] : null;
    if (enabled && (!detection?.updatesEnabled || detection.configSource !== "flora.config.json" || !detection.automationConfig || !automation.runners.some(runner => runner.revokedAt === null && runner.appIds.includes(selectedAppId)))) return;
    const channel = document.getElementById("automation-channel").value; const platforms = selectedPolicyPlatforms(document);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(channel) || !platforms.length || platforms.some(platform => !detection?.automationConfig?.platforms.includes(platform))) { document.getElementById("automation-status").textContent = "앱 설정에 맞는 channel과 자동 배포 플랫폼을 선택하세요."; return; }
    const input = { expectedVersion: automation.policy?.version ?? 0, enabled, channel, platforms };

    return automationWrite(async (id, current) => { const result = await api("/api/apps/" + encodeURIComponent(id) + "/automation/policy", input); if (!current()) return; if (result?.appId !== id) throw new Error("INVALID_POLICY"); await loadAutomation(); });
  }
  async function cancelAutomation(jobId) {
    if (automationAppId !== selectedAppId || !automation?.jobs.some(job => job.id === jobId && ["queued", "leased"].includes(job.state))) return;
    return automationWrite(async (id, current) => { await api("/api/apps/" + encodeURIComponent(id) + "/automation/jobs/" + encodeURIComponent(jobId) + "/cancel", {}); if (current()) await loadAutomation(); });
  }
  async function enrollRunner() {
    const name = document.getElementById("runner-name").value.trim(); if (!name) return;
    return automationWrite(async (id, current) => {
      const result = await api("/api/runners", { name, appIds: [id] }); if (!current()) return;
      if (!Array.isArray(result?.runner?.appIds) || result.runner.appIds.length !== 1 || result.runner.appIds[0] !== id || typeof result.token !== "string" || !result.token) throw new Error("INVALID_RUNNER");
      runnerToken = result.token; runnerTokenAppId = id;
      document.getElementById("runner-token").textContent = runnerToken; document.getElementById("runner-token-panel").hidden = false; await loadAutomation();
    });
  }
  async function revokeRunner(runnerId) {
    if (automationAppId !== selectedAppId || !automation?.runners.some(runner => runner.id === runnerId && runner.revokedAt === null)) return;
    return automationWrite(async (id, current) => { await api("/api/runners/" + encodeURIComponent(runnerId) + "/revoke", {}); if (!current()) return; runnerToken = ""; runnerTokenAppId = null; document.getElementById("runner-token").replaceChildren(); document.getElementById("runner-token-panel").hidden = true; await loadAutomation(); });
  }
  function hideRunnerToken() { runnerToken = ""; runnerTokenAppId = null; document.getElementById("runner-token").replaceChildren(); document.getElementById("runner-token-panel").hidden = true; automationControls(); }
  async function copyRunnerToken() {
    if (stopped || !runnerToken || runnerTokenAppId !== selectedAppId) return;
    const version = generation;
    try { await env.navigator?.clipboard?.writeText(runnerToken); if (version === generation && !stopped) document.getElementById("automation-status").textContent = env.navigator?.clipboard ? "Runner 토큰을 복사했습니다." : "브라우저에서 복사 기능을 사용할 수 없습니다. 표시된 토큰을 직접 복사하세요."; }
    catch { if (version === generation && !stopped) document.getElementById("automation-status").textContent = "복사하지 못했습니다. 표시된 토큰을 직접 복사하세요."; }
  }
  function operationControls() {
    automationControls();
    const ready = !stopped && !busy && !reading && Boolean(selectedAppId);
    for (const id of ["github-connect", "github-sync", "operations-refresh"]) { const input = document.getElementById(id); if (input) input.disabled = !ready; }
    const detection = operationsAppId === selectedAppId ? operations?.detections[0] : null;
    const publish = ready && ["flora", "expo", "react-native"].includes(detection?.framework) && detection.updatesEnabled && detection.runtimeVersion && detection.configSource !== "dynamic-required";
    const button = document.getElementById("ota-deploy"); if (button) button.disabled = !publish;
  }
  async function operationWrite(work, statusTarget = "operations-status") {
    if (stopped || busy || reading || !selectedAppId) return;
    const appId = selectedAppId; const version = generation; const current = () => !stopped && generation === version && selectedAppId === appId;
    busy = true; appControls(); renderStatus(document, "saving");
    try { const outcome = await work(appId, current); if (current() && await loadOperations()) { document.getElementById(statusTarget).textContent = outcome || (statusTarget === "automation-status" ? "요청 완료 · Runner와 자동 작업 이력을 다시 확인했습니다." : "요청 완료 · 앱별 연결과 배포 이력을 다시 확인했습니다."); } }
    catch (error) { if (current()) { if (error.status === 401) { failure(error); return; } document.getElementById(statusTarget).textContent = error.status === 409 ? "연결 버전이나 배포 조건이 변경되어 완료하지 못했습니다. 이력을 다시 확인해 주세요." : "GitHub / OTA 작업을 완료하지 못했습니다. 연결 권한, 앱 설정과 export 파일을 확인해 주세요."; } }
    finally { busy = false; if (current()) renderStatus(document, "ready"); appControls(); }
  }
  async function connectGitHub() {
    if (operationsAppId !== selectedAppId) { await loadOperations(); if (operationsAppId !== selectedAppId) return; }
    const input = { expectedVersion: operations?.connection?.version ?? 0, installationId: Number(document.getElementById("github-installation").value), owner: document.getElementById("github-owner").value, repository: document.getElementById("github-repository").value, ref: document.getElementById("github-ref").value };
    if (!Number.isSafeInteger(input.installationId) || input.installationId <= 0 || !input.owner || !input.repository || !input.ref) { document.getElementById("operations-status").textContent = "GitHub 설치 ID, 소유자, 저장소와 ref를 확인해 주세요."; return; }
    return operationWrite(async (appId, current) => { const file = document.getElementById("github-resolved-config").files?.[0]; if (file) { if (file.size > 1024 * 1024) throw new Error("INVALID_CONFIG"); const config = JSON.parse(await file.text()); const commitSha = operationsAppId === appId ? operations?.detections[0]?.commitSha : null; if (!commitSha) throw new Error("SOURCE_REQUIRED"); if (config?.commitSha !== undefined && (config.commitSha !== commitSha || !config.config)) throw new Error("SOURCE_MISMATCH"); input.resolvedConfig = config?.commitSha !== undefined ? config : { commitSha, config }; } if (!current()) return; await api("/api/apps/" + encodeURIComponent(appId) + "/github", input); });
  }
  async function syncGitHub() { return operationWrite(async (appId, current) => { const input = {}; const file = document.getElementById("github-resolved-config").files?.[0]; if (file) { if (file.size > 1024 * 1024) throw new Error("INVALID_CONFIG"); const config = JSON.parse(await file.text()); const commitSha = operationsAppId === appId ? operations?.detections[0]?.commitSha : null; if (!commitSha) throw new Error("SOURCE_REQUIRED"); if (config?.commitSha !== undefined && (config.commitSha !== commitSha || !config.config)) throw new Error("SOURCE_MISMATCH"); input.resolvedConfig = config?.commitSha !== undefined ? config : { commitSha, config }; } if (!current()) return; await api("/api/apps/" + encodeURIComponent(appId) + "/github/sync", input); }); }
  async function deployOTA() {
    const detection = operationsAppId === selectedAppId ? operations?.detections[0] : null;
    const launch = document.getElementById("ota-launch").files?.[0]; const assets = [...(document.getElementById("ota-assets").files ?? [])];
    const platform = document.getElementById("ota-platform").value; const channel = document.getElementById("ota-channel").value;
    if (!detection || !["flora", "expo", "react-native"].includes(detection.framework) || !detection.updatesEnabled || !detection.runtimeVersion || detection.configSource === "dynamic-required" || !detection.platforms.includes(platform) || !launch || assets.length > 64 || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(channel)) { document.getElementById("operations-status").textContent = "확인된 Expo OTA 설정, channel, 플랫폼과 같은 export의 launch bundle을 확인해 주세요."; return; }
    if (!deploymentRequestKey) deploymentRequestKey = "ota_" + globalThis.crypto.randomUUID();
    const requestKey = deploymentRequestKey;
    return operationWrite(async (appId, current) => {
      const upload = async file => {
        if (!current()) throw new Error("STALE_OPERATION");
        if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 16 * 1024 * 1024) throw new Error("INVALID_EXPORT");
        const extension = (file.name?.split(".").at(-1) ?? "bin").replace(/[^a-zA-Z0-9]/g, "").slice(0, 16) || "bin";
        const contentType = file.type || (extension === "js" ? "application/javascript" : "application/octet-stream");
        const key = file.name?.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128) || "export_" + extension;
        const receipt = await api("/api/apps/" + encodeURIComponent(appId) + "/ota/assets?" + new URLSearchParams({ key, contentType, fileExtension: "." + extension }), file, csrf, true);
        if (!current() || receipt?.appId !== appId || typeof receipt?.id !== "string") throw new Error("INVALID_RECEIPT");
        return receipt.id;
      };
      const launchAssetId = await upload(launch); const assetIds = [];
      for (const file of assets) assetIds.push(await upload(file));
      if (!current()) return;
      await api("/api/apps/" + encodeURIComponent(appId) + "/ota/deployments", { requestKey, detectionId: detection.id, commitSha: detection.commitSha, runtimeVersion: detection.runtimeVersion, channel, platform, launchAssetId, assetIds });
      if (current()) deploymentRequestKey = null;
    });
  }
  async function loadOperations() {
    const appId = selectedAppId; const version = generation;
    if (!appId || stopped) return;
    document.getElementById("operations-status").textContent = "GitHub 연결과 OTA 이력을 확인하는 중…";
    try {
      const result = await api("/api/apps/" + encodeURIComponent(appId) + "/operations");
      if (stopped || version !== generation || selectedAppId !== appId) return;
      renderOperations(document, appId, result); if (operations?.detections[0]?.id !== result.detections[0]?.id) automationRequestKey = null; operations = result; operationsAppId = appId; operationControls();
      document.getElementById("operations-status").textContent = "연결과 배포 이력을 확인했습니다."; return true;
    } catch (error) {
      if (stopped || version !== generation || selectedAppId !== appId) return;
      if (error.status === 401) { failure(error); return; }
      document.getElementById("operations-status").textContent = "연결과 배포 이력을 확인하지 못했습니다. 다시 확인해 주세요.";
    }
  }
  async function registerApplication() {
    const version = generation; let registeredId = null;
    await mutate(async () => { const app = await api("/api/apps", { name: document.getElementById("application-name").value, repositoryId: document.getElementById("application-repository").value, rootDirectory: document.getElementById("application-root").value }); if (stopped || version !== generation) return; operations = null; operationsAppId = null; automation = null; automationAppId = null; runnerToken = ""; runnerTokenAppId = null; automationRequestKey = null; deploymentRequestKey = null; clearOperations(document); registeredId = app.id; selectedAppId = app.id; selectedId = undefined; if (document.getElementById("application-registration")) document.getElementById("application-registration").open = false; resetProjectRegistration(document); });
    if (!stopped && registeredId && version + 1 === generation && data?.selectedApplication?.id === registeredId) document.getElementById("project-card-" + registeredId)?.focus();
  }
  async function saveSettings() {
    const app = data?.selectedApplication; const version = generation; if (!app) return;
    await mutate(async () => { const result = await api("/api/apps/" + encodeURIComponent(app.id) + "/settings", { expectedVersion: app.settings.version, values: publicValues(document.getElementById("settings-json").value) }); if (!stopped && version === generation && data?.selectedApplication?.id === app.id) { data.selectedApplication = result; renderApplications(document, data); } });
  }
  document.getElementById("github-open")?.addEventListener("click", () => {
    if (!selectedAppId) { document.getElementById("notice").hidden = false; document.getElementById("notice").textContent = "먼저 앱 이름, 저장소 식별자와 앱 루트를 등록한 뒤 GitHub를 연결하세요."; document.getElementById("application-registration").open = true; document.getElementById("application-name").focus(); return; }

    document.getElementById("operations-editor").open = true; document.getElementById("github-installation").focus();
    document.getElementById("application-operations").scrollIntoView?.({ block: "start", behavior: "smooth" });
  });
  document.getElementById("automation-editor")?.addEventListener("toggle", () => { if (document.getElementById("automation-editor").open) void loadAutomation(); else stopAutomationPoll(); });
  document.addEventListener?.("visibilitychange", () => { if (document.hidden) stopAutomationPoll(); else scheduleAutomationPoll(); });
  document.getElementById("runner-config-copy")?.addEventListener("click", () => { void copyRunnerConfig(); });
  document.getElementById("automation-refresh")?.addEventListener("click", () => { void loadAutomation(); });
  document.getElementById("automation-policy-form")?.addEventListener("submit", event => { event.preventDefault(); void saveAutomationPolicy(); });
  document.getElementById("automation-policy-enabled")?.addEventListener("change", automationControls);
  document.getElementById("automation-form")?.addEventListener("submit", event => { event.preventDefault(); void queueAutomation(); });
  document.getElementById("runner-form")?.addEventListener("submit", event => { event.preventDefault(); void enrollRunner(); });
  document.getElementById("runner-token-hide")?.addEventListener("click", hideRunnerToken);
  document.getElementById("runner-token-copy")?.addEventListener("click", () => { void copyRunnerToken(); });
  document.getElementById("automation-history")?.addEventListener("click", event => { const job = event.target.getAttribute?.("data-automation-job"); if (job) void loadAutomationJob(job); const id = event.target.getAttribute?.("data-cancel-automation"); if (id) void cancelAutomation(id); });
  document.getElementById("automation-runners")?.addEventListener("click", event => { const id = event.target.getAttribute?.("data-revoke-runner"); if (id) void revokeRunner(id); });
  for (const id of ["automation-channel", "automation-platform"]) document.getElementById(id)?.addEventListener("change", () => { automationRequestKey = null; });
  document.getElementById("github-form")?.addEventListener("submit", event => { event.preventDefault(); void connectGitHub(); });
  document.getElementById("github-sync")?.addEventListener("click", () => { void syncGitHub(); });
  document.getElementById("ota-form")?.addEventListener("submit", event => { event.preventDefault(); void deployOTA(); });
  for (const id of ["ota-launch", "ota-assets", "ota-channel", "ota-platform"]) document.getElementById(id)?.addEventListener("change", () => { deploymentRequestKey = null; });
  document.getElementById("operations-refresh")?.addEventListener("click", () => { void loadOperations(); });
  document.getElementById("operations-editor")?.addEventListener("toggle", () => { if (document.getElementById("operations-editor").open) void loadOperations(); });
  document.getElementById("project-list")?.addEventListener("click", event => {
    const card = event.target.closest?.("[data-select-application]") ?? event.target;
    const id = card.getAttribute?.("data-select-application"); if (id) void chooseApplication(id).then(() => {
      if (data?.selectedApplication?.id !== id) return;
      const editor = document.getElementById("operations-editor"); if (editor) editor.open = true;
      document.getElementById("application-operations")?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    });
  });
  document.getElementById("project-search")?.addEventListener("input", () => { if (data) renderProjectCards(document, data); });
  document.getElementById("project-register-open")?.addEventListener("click", () => {
    const registration = document.getElementById("application-registration"); if (registration) registration.open = true;
    document.getElementById("application-name")?.focus(); registration?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  });
  document.getElementById("registration-close")?.addEventListener("click", () => {
    const registration = document.getElementById("application-registration"); if (registration) registration.open = false;
    document.getElementById("project-register-open")?.focus();
  });
  for (const nav of document.querySelectorAll?.("[data-workspace-nav]") ?? []) nav.addEventListener("click", () => {
    const kind = nav.getAttribute("data-workspace-nav");
    const targets = { projects: "application-panel", updates: "application-operations", sources: "source-details", settings: "application-settings" };
    const editor = document.getElementById(kind === "updates" ? "operations-editor" : kind === "settings" ? "settings-editor" : "application-panel");
    if (editor && (kind === "updates" || kind === "settings")) editor.open = true;
    for (const other of document.querySelectorAll?.("[data-workspace-nav]") ?? []) other.setAttribute("aria-current", other === nav ? "page" : "false");
    document.getElementById(targets[kind])?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  });
  document.getElementById("nav-history")?.addEventListener("click", () => document.getElementById("baseline-history")?.scrollIntoView?.({ block: "start", behavior: "smooth" }));
  document.getElementById("application-select")?.addEventListener("change", event => { void chooseApplication(event.target.value); });
  document.getElementById("application-form")?.addEventListener("submit", event => { event.preventDefault(); void registerApplication(); });
  document.getElementById("settings-form")?.addEventListener("submit", event => { event.preventDefault(); void saveSettings(); });
  document.getElementById("source-file").addEventListener("change", event => { const file = event.target.files?.[0]; event.target.value = ""; void importFile("source", file); });
  document.getElementById("baseline-file").addEventListener("change", event => { const file = event.target.files?.[0]; event.target.value = ""; void importFile("baseline", file); });
  document.getElementById("snapshot-select").addEventListener("change", event => { void chooseSnapshot(event.target.value); });
  document.getElementById("flavor-select").addEventListener("change", () => { if (data) renderDashboard(document, data); });
  document.getElementById("run-button").addEventListener("click", () => { void run(); });
  document.getElementById("retry-button").addEventListener("click", () => { if (!stopped) void chooseSnapshot(selectedId); });
  document.getElementById("run-history").addEventListener("click", event => { const recordId = event.target.getAttribute?.("data-cancel"); if (recordId) void cancel(recordId); });
  env.addEventListener?.("pagehide", () => { stopped = true; generation++; stopAutomationPoll(); runnerToken = ""; runnerTokenAppId = null; automation = null; automationAppId = null; operations = null; operationsAppId = null; data = null; csrf = ""; requestKeys.clear(); env.clearTimeout(timer); renderStatus(document, "session"); });
  renderStatus(document, "loading");
  try {
    const session = await api("/api/session", bootstrap ? { bootstrap } : undefined); csrf = session.csrfToken;
    document.getElementById("source-file").disabled = false; const current = await refresh(); if (current && !stopped) renderStatus(document, "ready");
  } catch (error) { failure(error); }
  return { close() { stopped = true; generation++; stopAutomationPoll(); runnerToken = ""; runnerTokenAppId = null; automation = null; automationAppId = null; operations = null; operationsAppId = null; data = null; csrf = ""; requestKeys.clear(); env.clearTimeout(timer); renderStatus(document, "session"); }, refresh, loadOperations, loadAutomation, loadAutomationJob, copyRunnerConfig, queueAutomation, saveAutomationPolicy, cancelAutomation, enrollRunner, revokeRunner, copyRunnerToken, hideRunnerToken, connectGitHub, syncGitHub, deployOTA, run, cancel, importFile, chooseSnapshot, chooseApplication, registerApplication, saveSettings };
}
if (typeof window !== "undefined") void startClient({ document: window.document, location: window.location, history: window.history, fetch: window.fetch.bind(window), setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window), crypto: window.crypto });
