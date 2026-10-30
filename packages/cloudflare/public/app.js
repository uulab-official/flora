import {evaluatePublications} from "./onboarding-model.js";
import {buildRunnerBinding} from "./onboarding-files.js";
import { createOnboarding } from "./onboarding.js";
import { createDeploymentDevices } from "./deployment-devices.js";
import { createAutoRollback } from "./auto-rollback.js";
import { createBuildProviderPanel } from "./build-provider-panel.js";
import { ADMIN_PAGES, adminPath, parseAdminPath } from "./admin-routes.js";
import { renderProjectRows, renderOperationalOverview, renderCompactOtaHistory, renderCompactAutomationJobs, renderWorkspaceStatus, technicalDetails, isValidSdkTelemetry } from "./project-views.js";
const LABELS = { passed: "통과", failed: "실패", invalid: "증거 불충분", blocked: "차단됨", interrupted: "중단됨" };
const PRIVATE_FIELDS = ["app-name", "freshness", "snapshot-select", "snapshot-page", "source-meta", "trust-note", "source-details", "flavor-count", "flavor-select", "flavor-detail", "runtime", "profile", "provider", "history-page", "baseline-history", "empty", "app-count", "source-count", "app-rows", "app-pagination", "app-page-number", "app-search", "app-source-filter", "mobile-source-name", "mobile-flavor-count", "detail-title", "history-scope", "recent-history"];
function safe(value, max = 2048) {
  const cleaned = String(value ?? "—").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
  const bytes = new TextEncoder().encode(cleaned); const suffix = "\n… 표시 제한에 따라 생략됨";
  return bytes.length > max ? new TextDecoder().decode(bytes.slice(0, max - new TextEncoder().encode(suffix).length)).replace(/\ufffd$/, "") + suffix : cleaned;
}
function element(document, tag, text, className = "") { const node = document.createElement(tag); if (text !== undefined) node.textContent = safe(text, tag === "pre" ? 65_536 : 2048); node.className = className; return node; }
function pair(document, label, value, mono = false) { const row = element(document, "div", undefined, "fact-row"); row.append(element(document, "span", label, "fact-label"), element(document, "span", value, (mono ? "mono " : "") + "fact-value")); return row; }
function icon(document, name) { const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("class", "icon"); svg.setAttribute("aria-hidden", "true"); const use = document.createElementNS("http://www.w3.org/2000/svg", "use"); use.setAttribute("href", "/icons.svg#icon-" + name); svg.append(use); return svg; }
function date(value) { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? "시각 알 수 없음" : parsed.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) + " KST"; }
function select(document, id, items, value) { const node = document.getElementById(id); node.replaceChildren(...items.map(([id, text]) => { const option = element(document, "option", text); option.value = id; return option; })); node.value = value ?? ""; }
function validState(value) {
  return value && [value.snapshots, value.history].every(page => page && Array.isArray(page.items) && page.items.length <= 20 && (page.nextCursor === null || typeof page.nextCursor === "string")) && (value.selected === null || typeof value.selected?.id === "string") && value.profile && value.runner === "unavailable";
}




function launchDownloadURL(appId, asset) {
  const digest = asset?.digest ?? (/^asset_[a-f0-9]{64}$/.test(asset?.id ?? "") ? asset.id.slice(6) : null);
  return typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest) ? `/updates/${encodeURIComponent(appId)}/assets/${digest}` : null;
}
function githubSourceError(code) {
  return ({ GITHUB_ACCESS_DENIED: "Flora에서 저장소를 읽을 수 없습니다. GitHub App 설치의 저장소 허용 범위를 확인한 뒤 소스 동기화를 다시 실행하세요.", GITHUB_REPOSITORY_UNAVAILABLE: "Flora에서 저장소를 읽을 수 없습니다. 저장소 존재 여부와 GitHub App 허용 범위를 확인한 뒤 다시 동기화하세요.", GITHUB_REF_NOT_FOUND: "저장소는 읽을 수 있지만 선택한 branch·tag·commit을 찾을 수 없습니다. Ref를 확인해 다시 연결하세요.", GITHUB_APP_UNSUPPORTED: "앱 루트에서 React Native 또는 Expo 앱을 인식하지 못했습니다. 프로젝트 폴더와 package.json을 확인하세요." })[code] ?? null;
}
function currentDetection(result) {
  const connection = result?.connection;
  if (!connection) return null;
  return result.detections?.find(item => item.appId === connection.appId && (result.expectedRootDirectory === undefined || item.rootDirectory === result.expectedRootDirectory) && item.connection && ["appId", "version", "installationId", "owner", "repository", "ref"].every(key => item.connection[key] === connection[key]) && Number.isSafeInteger(item.detectedAt) && item.detectedAt >= connection.connectedAt) ?? null;
}
function renderReadiness(document, appId, detection, state, operations = null, status) {
  const app = { id: appId, name: document.getElementById("selected-project-title").textContent, repositoryId: operations?.connection ? `${operations.connection.owner}/${operations.connection.repository}` : undefined, rootDirectory: operations?.expectedRootDirectory ?? detection?.rootDirectory };
  const source = operations ?? { connection: detection?.connection ?? null, detections: detection ? [detection] : [], expectedRootDirectory: detection?.rootDirectory };
  renderOperationalOverview(document, app, { operations: source, detection, automation: state ? { ...state, appId } : null, status });
}
function renderOperations(document, appId, result) {
  if (!result || !Array.isArray(result.detections) || !Array.isArray(result.assets) || !Array.isArray(result.deployments) || result.connection && result.connection.appId !== appId || [...result.detections, ...result.assets, ...result.deployments].some(item => item.appId !== appId)) throw new Error("INVALID_OPERATIONS");
  const connection = result.connection;
  document.getElementById("github-connection").replaceChildren(...(connection ? [pair(document, "GitHub", `${connection.owner}/${connection.repository} · ${connection.ref}`), pair(document, "연결 버전", connection.version), element(document, "p", currentDetection(result) ? "소스 읽기 확인 · 현재 연결의 고정 커밋" : "연결 정보 저장됨 · 소스 읽기 미검증", "badge " + (currentDetection(result) ? "success" : "neutral"))] : [element(document, "p", "GitHub 연결 없음", "subtle")]));
  renderReadiness(document, appId, currentDetection(result), null, result);
  document.getElementById("github-access-recover").hidden = !connection || Boolean(currentDetection(result));
  if (connection) for (const [id, value] of [["github-installation", connection.installationId], ["github-owner", connection.owner], ["github-repository", connection.repository], ["github-ref", connection.ref]]) document.getElementById(id).value = String(value);
  const detection = currentDetection(result); if (!document.getElementById("ota-channel").value) document.getElementById("ota-channel").value = "preview"; if (!document.getElementById("ota-platform").value && detection?.platforms?.length) document.getElementById("ota-platform").value = detection.platforms[0]; document.getElementById("github-resolved-config-field").hidden = detection?.configSource !== "dynamic-required"; const target = document.getElementById("framework-detection"); target.replaceChildren();
  if (detection) {
    const empty = document.getElementById("empty"); if (empty?.className.includes("application-empty") && !document.getElementById("snapshot-select").value) empty.replaceChildren(element(document, "h2", "연결한 GitHub 소스"), element(document, "p", `${connection?.owner ?? ""}/${connection?.repository ?? ""} · ${detection.framework} · ${detection.commitSha.slice(0, 12)}`, "mono"), element(document, "p", "설정 근거와 앱별 OTA 이력을 아래에서 확인하세요.", "subtle"));
    target.append(element(document, "h3", "고정 소스의 앱 인식"), pair(document, "Framework", detection.framework), pair(document, "Expo / React Native", `${detection.expoVersion ?? "없음"} / ${detection.reactNativeVersion ?? "없음"}`), pair(document, "설정 근거", detection.configSource), pair(document, "Runtime", detection.runtimeVersion ?? "미확인"), pair(document, "OTA", ["flora", "expo", "react-native"].includes(detection.framework) && detection.updatesEnabled && detection.runtimeVersion && detection.configSource !== "dynamic-required" ? "업데이트 설정 확인 · 배포 시 대상 재검증" : "배포 차단 · 앱 설정 확인 필요"), technicalDetails(document, [["Commit SHA", detection.commitSha], ["Updates URL", detection.updatesUrl ?? "미확인"], ["설정 근거", detection.configSource]]));
    for (const reason of detection.reasons ?? []) target.append(element(document, "p", reason, "subtle"));
  } else {
    target.append(element(document, "p", "소스를 동기화하면 commit을 고정해 Expo / React Native 설정을 확인합니다.", "subtle"));
    const empty = document.getElementById("empty");
    if (empty?.className.includes("application-empty") && !document.getElementById("snapshot-select").value) empty.replaceChildren(element(document, "h2", connection ? "GitHub 소스 읽기 미검증" : "GitHub 소스를 연결해 주세요"), element(document, "p", "연결 정보 저장 후 설치 권한과 소스 동기화를 확인하세요.", "subtle"));
  }
  const guidance = document.getElementById("ota-export-guidance"); guidance.replaceChildren(element(document, "p", "설치된 앱 바이너리에 Flora SDK와 native update engine, 이 앱의 /updates/ URL과 channel이 먼저 설정되어 있어야 합니다. 같은 commit의 작업 디렉터리에서 Metro 또는 OSS Expo export를 실행하고 생성한 플랫폼 launch bundle과 모든 자산을 선택하세요. 동적 app.config는 실행하지 않으며, 확인 가능한 export 설정이 없으면 배포가 차단됩니다.", "subtle"), element(document, "pre", detection?.automationConfig?.bundler === "metro" ? `./node_modules/.bin/react-native bundle --platform ios --dev false --entry-file ${detection.automationConfig.entryFile} --bundle-output dist/main.jsbundle --assets-dest dist/assets` : "npx expo export --platform ios --output-dir dist", "log"));
  renderCompactOtaHistory(document, appId, result.deployments);
  return detection;
}


function validCITrust(value, workflow) {
  if (!value || ["repositoryId", "repositoryOwnerId", "ref", ...(workflow ? ["jobWorkflowRef", "jobWorkflowSha"] : [])].some(key => typeof value[key] !== "string" || /[\x00-\x20\x7f]/.test(value[key])) || !/^[1-9][0-9]{0,19}$/.test(value.repositoryId ?? "") || !/^[1-9][0-9]{0,19}$/.test(value.repositoryOwnerId ?? "") || !/^refs\/heads\/[A-Za-z0-9_./-]+$/.test(value.ref ?? "") || value.ref.includes("..") || value.ref.includes("//") || value.ref.endsWith("/") || value.ref.endsWith(".lock")) return false;
  if (value.repository !== undefined && !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(value.repository)) return false;
  return !workflow || /^[a-f0-9]{40}$/.test(value.jobWorkflowSha ?? "") && /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml@[a-f0-9]{40}$/.test(value.jobWorkflowRef ?? "") && value.jobWorkflowRef.endsWith("@" + value.jobWorkflowSha);
}
function clearCIOutput(document) {
  for (const id of ["ci-summary", "ci-workflow-yaml"]) document.getElementById(id).replaceChildren();
  document.getElementById("ci-download").hidden = true; document.getElementById("ci-download").removeAttribute("href");
  for (const id of ["ci-copy", "ci-save", "ci-disable"]) document.getElementById(id).disabled = true;
}
function clearCI(document) {
  clearCIOutput(document); document.getElementById("ci-status").replaceChildren();
  for (const id of ["ci-repository-id", "ci-owner-id", "ci-ref", "ci-workflow"]) document.getElementById(id).value = "";
}
function clearAutomation(document) {
  clearCI(document);
  for (const id of ["automation-history-platform", "automation-history-result"]) document.getElementById(id).value = "all";
  if (document.getElementById("automation-policy-enabled")) document.getElementById("automation-policy-enabled").checked = false;
  for (const id of ["project-readiness", "automation-status", "automation-checklist", "runner-config-template", "automation-config", "automation-runners", "automation-history", "runner-token", "automation-policy-status"]) document.getElementById(id)?.replaceChildren();
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
function renderAutomation(document, appId, state, detection, origin, operations = null) {
  if (!state || !Array.isArray(state.jobs) || !Array.isArray(state.runners) || state.jobs.some(job => job.appId !== appId) || state.runners.some(runner => !Array.isArray(runner.appIds) || !runner.appIds.includes(appId))) throw new Error("INVALID_AUTOMATION");
  if (state.policy && state.policy.appId !== appId) throw new Error("INVALID_POLICY");
  document.getElementById("automation-policy-enabled").checked = state.policy?.enabled === true;
  document.getElementById("automation-policy-status").textContent = state.policy ? `자동 OTA ${state.policy.enabled ? "켜짐" : "꺼짐"} · 정책 버전 ${state.policy.version} · ${state.policy.channel} / ${policyPlatforms(state.policy).map(value => value === "ios" ? "iOS" : "Android").join(" + ")}` : "자동 OTA 꺼짐 · 명시적으로 저장한 뒤 적용됩니다.";
  renderReadiness(document, appId, detection, state, operations);
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
  for (const [label, ready] of [["GitHub 커밋 인식", Boolean(detection?.commitSha)], ["체크인한 Flora SDK 설정", detection?.configSource === "flora.config.json" && Boolean(config)], ["이 앱의 PC Runner 온라인", state.runners.some(runner => runner.revokedAt === null && runnerPresence(runner).label === "온라인")], ["GitHub push 자동 OTA 정책", state.policy?.enabled === true], ["Runner 산출물 게시", Boolean(detection?.updatesEnabled && state.policy && evaluatePublications({appId,commitSha:detection.commitSha,channel:state.policy.channel,runtimeVersion:detection.runtimeVersion,platforms:policyPlatforms(state.policy)},state.jobs,(operations?.deployments??[]).map(deployment=>({appId,deploymentId:deployment.id,deployment}))).status === "published")]]) checklist.append(element(document, "li", `${ready ? "확인됨" : "준비 필요"} · ${label}`));
  checklist.append(element(document, "li", "기기 적용 미검증 · 설치된 바이너리의 네이티브 엔진과 실제 업데이트를 별도로 확인하세요."));
  document.getElementById("runner-config-template").textContent = JSON.stringify({ origin: origin || "https://flora.example.com", token: "REPLACE_WITH_ONE_TIME_RUNNER_ENROLLMENT_TOKEN", dockerImage: "registry.example.com/flora-export@sha256:REPLACE_WITH_VERIFIED_IMAGE_DIGEST", dockerNetwork: "none", resourceProfile: "github-hosted", dependencyPreparation: config?.toolchain?.packageManager?.name === "pnpm" ? "pnpm-registry" : "npm-registry", workDirectory: "/private/runner/scratch/work", recoveryDirectory: "/private/runner/recovery" }, null, 2);
  document.getElementById("runner-scope-note").textContent = `선택 앱 ${appId}에 권한을 등록하세요. 앱 ID는 서버의 등록 권한에 묶이며 설정 파일에 추가하지 않습니다.`;
  const target = document.getElementById("automation-config"); target.replaceChildren();
  if (config) target.append(pair(document, "SDK 설정 근거", detection.configSource), pair(document, "Bundler / Entry", `${config.bundler} / ${config.entryFile}`), pair(document, "고정 도구 버전", `Node ${config.toolchain.nodeVersion} · ${config.toolchain.packageManager.name} ${config.toolchain.packageManager.version}`), pair(document, "Native runtime", config.runtimeVersion), technicalDetails(document, [["고정 Commit SHA", detection.commitSha]]));
  else target.append(element(document, "p", "자동 작업에는 Flora SDK와 GitHub 소스에 체크인한 flora.config.json이 필요합니다. 소스를 동기화해 설정을 확인하세요.", "subtle"));
  const runners = document.getElementById("automation-runners"); runners.replaceChildren();
  for (const runner of state.runners) {
    const presence = runnerPresence(runner); const row = element(document, "div", undefined, "record"); row.append(element(document, "p", runner.name, "record-note"), element(document, "p", presence.label, "badge " + presence.tone), pair(document, "마지막 연결 확인", presence.lastSeenAt === null ? "연결 기록 없음" : date(presence.lastSeenAt)), technicalDetails(document, [["Runner ID", runner.id], ["Runner 적용 앱", runner.appIds.join(" · ")]]));
    if (runner.revokedAt === null) { const button = element(document, "button", "Runner 전체 권한 폐기", "button secondary small"); button.type = "button"; button.setAttribute("data-revoke-runner", runner.id); row.append(button); } runners.append(row);
  }
  if (!state.runners.some(runner => runner.revokedAt === null)) runners.append(element(document, "p", "이 앱의 활성 Runner 없음 · 자동 작업 요청 불가", "warning-text"));
  renderCompactAutomationJobs(document, appId, state);
  if (!document.getElementById("automation-channel").value) document.getElementById("automation-channel").value = "preview";
  if (!document.getElementById("automation-platform").value && config?.platforms?.length) document.getElementById("automation-platform").value = config.platforms[0];
  if (!document.getElementById("runner-name").value) document.getElementById("runner-name").value = "UULab Runner";
}

function clearOperations(document) {
  clearAutomation(document);
  document.getElementById("github-access-recover").hidden = true;
  for (const id of ["operations-status", "github-connection", "framework-detection", "ota-export-guidance", "ota-history", "signing-key-status"]) document.getElementById(id)?.replaceChildren();
  for (const id of ["github-installation", "github-owner", "github-repository", "github-ref", "github-resolved-config", "ota-channel", "ota-platform", "ota-launch", "ota-assets"]) { const input = document.getElementById(id); if (input) input.value = ""; }
  const certificate = document.getElementById("signing-certificate-download"); if (certificate) { certificate.hidden = true; certificate.removeAttribute?.("href"); }
  const panel = document.getElementById("application-operations"); if (panel) panel.hidden = true;
  const config = document.getElementById("github-resolved-config-field"); if (config) config.hidden = true;
  const manual = document.getElementById("ota-manual-editor"); if (manual) manual.open = false;
  const editor = document.getElementById("operations-editor"); if (editor) editor.open = false;
}

function renderProjectCards(document, state) {
  renderProjectRows(document, state, state?.projectSummary ?? null, { status: state?.projectStatus ?? "loading", now: state?.projectNow, observedAt: state?.projectSummary?.observedAt });
}
function resetProjectRegistration(document) {
  document.getElementById("application-form")?.reset?.();
  for (const id of ["project-search", "application-name", "application-repository"]) { const input = document.getElementById(id); if (input) input.value = ""; }
  const projectFilter = document.getElementById("project-status-filter"); if (projectFilter) projectFilter.value = "all";
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
  select(document, "application-select", [["", "전체 프로젝트"], ...(state.applications ?? []).map(item => [item.id, item.name])], app?.id);
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
  if (all) { for (const id of ["project-list", "project-total", "application-select", "application-count", "project-filter-status"]) document.getElementById(id)?.replaceChildren(); for (const id of ["project-search", "application-name", "application-repository", "application-root"]) { const input = document.getElementById(id); if (input) input.value = ""; } const filter=document.getElementById("project-status-filter"); if(filter)filter.value="all"; if (document.getElementById("application-panel")) { document.getElementById("application-panel").hidden = true; document.getElementById("application-panel").setAttribute("data-selected-app", ""); } }
}
function publicValues(text) {
  const values = JSON.parse(text);
  if (!values || Array.isArray(values) || typeof values !== "object" || Object.keys(values).length > 64 || Object.entries(values).some(([key, value]) => !/^[A-Z][A-Z0-9_]{0,127}$/.test(key) || typeof value !== "string" || value.length > 2048 || value.includes("\0"))) throw new Error("INVALID_INPUT");
  if (new TextEncoder().encode(JSON.stringify(values)).length > 8192) throw new Error("INVALID_INPUT");
  return values;
}

/** Original files stay byte-for-byte intact. Only the server parses their envelopes. */
const CREDENTIAL_KINDS = { ios_distribution: "iOS 배포 인증서", ios_provisioning: "iOS 프로비저닝 프로파일", android_keystore: "Android Keystore", app_store_connect: "App Store Connect API 키", google_play: "Google Play 서비스 계정", apns: "APNs 푸시 키", fcm: "FCM 서비스 계정", firebase_android: "Firebase Android 설정", firebase_ios: "Firebase iOS 설정" };
const CREDENTIAL_FIELDS = { appIdentifier: "credential-app-identifier", teamId: "credential-team-id", keyId: "credential-key-id", issuerId: "credential-issuer-id", projectId: "credential-project-id", environment: "credential-environment" };
// No persistent storage, clipboard, plaintext preview or credential export exists here.
export function createCredentialPanel(env, context) {
  const { document } = env; const node = id => document.getElementById(id);
  let epoch = 0; let known = false; let loading = false; let writing = false; let view = null;
  const sensitive = ["credential-file", "credential-password", "credential-key-alias", "credential-key-password"];
  const current = (app, version) => context.active() && app === context.appId() && version === epoch;
  function status(text) { node("credential-status").textContent = text; }
  function clearInputs() { for (const id of sensitive) node(id).value = ""; }
  function controls() {
    const ready = context.ready() && !loading && !writing && Boolean(context.appId());
    node("credential-refresh").disabled = !ready;
    node("credential-register").disabled = !ready || !known || !view?.configured;
    for (const id of ["credential-kind", "credential-label", ...sensitive, ...Object.values(CREDENTIAL_FIELDS)]) node(id).disabled = !ready || !known || !view?.configured;
    // Buttons created by the renderer also obey in-flight and auth state.
    for (const item of node("credential-list").children) for (const child of item.children) if (child.getAttribute?.("data-credential-disable")) child.disabled = !ready || !known || !view?.configured;
  }
  function clear() {
    epoch++; known = false; loading = false; writing = false; view = null; clearInputs();
    node("credential-label").value = ""; for (const id of Object.values(CREDENTIAL_FIELDS)) node(id).value = "";
    node("credential-app-name").textContent = ""; node("credential-list").replaceChildren(); node("credential-history").replaceChildren(); status(""); node("credential-editor").open = false; controls();
  }
  function kindChanged() {
    clearInputs(); const kind = node("credential-kind").value;
    node("credential-password-field").hidden = !["ios_distribution", "android_keystore"].includes(kind);
    node("credential-alias-field").hidden = kind !== "android_keystore";
    node("credential-file-hint").textContent = ["app_store_connect", "apns", "google_play", "fcm", "firebase_android"].includes(kind) ? "PEM / Google JSON: 최대 64 KiB" : "파일 최대 1 MiB · 서명 도구 검증은 별도로 필요합니다.";
    const accepts = { ios_distribution: ".p12,.pfx", ios_provisioning: ".mobileprovision", android_keystore: ".jks,.keystore", app_store_connect: ".p8,.pem", apns: ".p8,.pem", google_play: ".json", fcm: ".json", firebase_android: ".json", firebase_ios: ".plist" };
    node("credential-file").setAttribute("accept", accepts[kind] ?? "");
  }
  function validate(result, app) {
    if (!result || result.appId !== app || typeof result.configured !== "boolean" || !Array.isArray(result.credentials) || result.credentials.length > 9 || !Array.isArray(result.history) || result.history.length > 360) throw new Error("INVALID_CREDENTIAL_VIEW");
    const kinds = new Set();
    for (const item of result.credentials) {
      if (!CREDENTIAL_KINDS[item?.kind] || kinds.has(item.kind) || !Number.isSafeInteger(item.version) || item.version < 1 || !(item.activeVersion === null || Number.isSafeInteger(item.activeVersion) && item.activeVersion > 0) || typeof item.label !== "string" || !item.metadata || typeof item.metadata !== "object") throw new Error("INVALID_CREDENTIAL_VIEW");
      kinds.add(item.kind);
    }
    for (const item of result.history) if (!CREDENTIAL_KINDS[item?.kind] || !["registered", "rotated", "disabled"].includes(item.action) || !Number.isSafeInteger(item.version) || item.version < 1) throw new Error("INVALID_CREDENTIAL_HISTORY");
    return result;
  }
  function render() {
    node("credential-list").replaceChildren(); node("credential-history").replaceChildren();
    for (const item of view.credentials) {
      const card = element(document, "section", undefined, "credential-item");
      card.append(element(document, "h3", CREDENTIAL_KINDS[item.kind]), element(document, "p", item.label), pair(document, "등록 상태", item.activeVersion === null ? "Flora 사용 중지" : `보관됨 · 버전 ${item.activeVersion}`), pair(document, "설정 revision", item.version));
      card.append(element(document, "p", "암호화 보관 · 제공 서비스 권한과 실제 서명·푸시 동작은 미확인", "subtle"));
      const verification = { stored_unverified: "암호화 보관됨 · 서명 도구 검증 필요", key_format_verified: "암호 키 형식 검증됨 · 서비스 권한 미확인", app_identity_verified: "파일의 앱 식별 정보 검증됨 · 서비스 권한 미확인" };
      card.append(pair(document, "파일 검증", verification[item.verification] ?? "검증 상태 확인 필요"));
      if (item.fingerprint) card.append(pair(document, "Fingerprint", item.fingerprint, true));
      if (item.expiresAt) card.append(pair(document, "만료 시각", date(item.expiresAt)));
      if (item.createdAt) card.append(pair(document, "등록 시각", date(item.createdAt)));
      for (const key of Object.keys(CREDENTIAL_FIELDS)) if (typeof item.metadata[key] === "string") card.append(pair(document, key, item.metadata[key]));
      if (item.activeVersion !== null) { const button = element(document, "button", "Flora에서 사용 중지", "button secondary small"); button.type = "button"; button.setAttribute("data-credential-disable", item.kind); button.addEventListener("click", () => { void disable(item.kind); }); card.append(button); }
      node("credential-list").append(card);
    }
    if (!view.credentials.length) node("credential-list").append(element(document, "p", "이 앱에 등록한 인증서 / 서비스 키가 없습니다.", "subtle"));
    for (const item of view.history) node("credential-history").append(element(document, "p", `${CREDENTIAL_KINDS[item.kind]} · ${ { registered: "등록", rotated: "교체", disabled: "Flora 사용 중지" }[item.action]} · revision ${item.version} · ${date(item.createdAt)}`, "credential-history-row"));
    if (!view.history.length) node("credential-history").append(element(document, "p", "이 앱의 변경 이력이 없습니다.", "subtle"));
    status(view.configured ? "선택한 앱의 암호화 보관소입니다. Flora 사용 중지는 제공 서비스의 키 폐기가 아닙니다." : "암호화 보관소가 아직 설정되지 않았습니다. 서버 설정 후 등록할 수 있습니다."); controls();
  }
  async function load() {
    if (!context.ready() || loading || writing || !context.appId()) return;
    const app = context.appId(); node("credential-app-name").textContent = `선택 앱 · ${safe(context.appName?.() ?? app)}`; const version = ++epoch; loading = true; known = false; controls(); status("이 앱의 키와 이력을 불러오는 중…");
    try { const result = await context.api(`/api/apps/${encodeURIComponent(app)}/credentials`); if (!current(app, version)) return; view = validate(result, app); known = true; render(); }
    catch (error) { if (!current(app, version)) return; view = null; node("credential-list").replaceChildren(); node("credential-history").replaceChildren(); if (error.status === 401) context.expire(); else status("키와 이력을 불러오지 못했습니다. 다시 확인해 주세요."); }
    finally { if (version === epoch) { loading = false; controls(); } }
  }
  async function mutation(kind, body, file) {
    if (!context.ready() || loading || writing || !known || !view?.configured || !context.appId()) return;
    const app = context.appId(); const version = ++epoch; writing = true; controls(); status("선택한 앱의 암호화 등록을 처리하는 중…");
    let requestSent = false;
    try {
      if (file) {
        const limit = ["app_store_connect", "apns", "google_play", "fcm", "firebase_android"].includes(kind) ? 65536 : 1048576;
        if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > limit) throw new Error("FILE_SIZE");
        const bytes = new Uint8Array(await file.arrayBuffer()); if (!current(app, version)) return;
        if (bytes.length !== file.size || bytes.length > limit) throw new Error("FILE_SIZE");
        let binary = ""; for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        body.payload.fileBase64 = env.btoa(binary); binary = "";
      }
      if (!current(app, version)) return;
      clearInputs(); requestSent = true;
      const receipt = await context.api(`/api/apps/${encodeURIComponent(app)}/credentials${file ? "" : "/disable"}`, JSON.stringify(body));
      if (!current(app, version)) return;
      validate(receipt, app);
      known = false; writing = false; await load();
    } catch (error) {
      if (!current(app, version)) return;
      if (error.status === 401) context.expire();
      else if (!requestSent) status(error.message === "FILE_SIZE" ? "파일 크기를 확인해 주세요. PEM / Google JSON은 64 KiB, 다른 파일은 1 MiB까지입니다." : "입력값을 확인해 주세요.");
      else { known = false; status(error.status === 409 ? "다른 변경과 충돌했습니다. 이력을 새로 확인한 후 등록하세요." : error.status === 400 || error.status === 422 ? "파일 형식 또는 식별 정보를 확인해 주세요. 기존 키는 보존됩니다. 이력을 다시 확인하세요." : "처리 완료 여부를 확인하지 못했습니다. 이력을 새로 확인한 후 교체 여부를 확인하세요. 자동으로 재등록하지 않습니다."); }
    } finally { if (version === epoch) { clearInputs(); writing = false; controls(); } body.payload = undefined; }
  }
  async function register() {
    const kind = node("credential-kind").value; const label = node("credential-label").value.trim(); const file = node("credential-file").files?.[0];
    if (!CREDENTIAL_KINDS[kind] || !label || !file) { status("종류, 관리 이름과 파일을 선택하세요."); clearInputs(); return; }
    const metadata = {}; for (const [key, id] of Object.entries(CREDENTIAL_FIELDS)) if (node(id).value.trim()) metadata[key] = node(id).value.trim();
    const payload = {};
    if (["ios_distribution", "android_keystore"].includes(kind) && node("credential-password").value) payload.password = node("credential-password").value;
    if (kind === "android_keystore") { if (node("credential-key-alias").value) payload.keyAlias = node("credential-key-alias").value; if (node("credential-key-password").value) payload.keyPassword = node("credential-key-password").value; }
    await mutation(kind, { kind, label, expectedVersion: view?.credentials.find(item => item.kind === kind)?.version ?? 0, metadata, payload }, file);
  }
  async function disable(kind) {
    const summary = view?.credentials.find(item => item.kind === kind); if (!summary || summary.activeVersion === null) return;
    await mutation(kind, { kind, expectedVersion: summary.version });
  }
  node("credential-kind").addEventListener("change", kindChanged);
  node("credential-refresh").addEventListener("click", () => { void load(); });
  node("credential-form").addEventListener("submit", event => { event.preventDefault(); void register(); });
  node("credential-editor").addEventListener("toggle", () => { if (node("credential-editor").open && !node("page-credentials")?.hidden) void load(); else if (!node("credential-editor").open) clearInputs(); });
  kindChanged(); controls();
  return { load, register, disable, clear, controls };
}

// Native credentials remain on the server; only a one-time scoped Runner token is shown.
export function createNativePanel(env, context) {
  const { document } = env, node = id => document.getElementById(id);
  let epoch = 0, loading = false, writing = false, known = false, view = null, credentials = [], token = "", requestKey = null;
  const current = (app, version) => context.active() && app === context.appId() && version === epoch;
  const signingKinds = platform => platform === "ios" ? ["ios_distribution", "ios_provisioning"] : ["android_keystore"];
  const selectedCredentials = () => signingKinds(node("native-platform").value).map(kind => credentials.find(item => item.kind === kind && Number.isSafeInteger(item.activeVersion) && item.activeVersion > 0));
  function hideToken() { token = ""; node("native-runner-token").textContent = ""; node("native-runner-token-panel").hidden = true; node("native-runner-copy").disabled = true; }
  function status(text) { node("native-status").textContent = text; }
  function controls() {
    const ready = context.ready() && !!context.appId() && !loading && !writing;
    node("native-refresh").disabled = !ready;
    for (const id of ["native-platform", "native-commit", "native-app-identifier", "native-team-id", "native-runner-name", "native-runner-platform"]) node(id).disabled = !ready || !known;
    node("native-enqueue").disabled = !ready || !known || selectedCredentials().some(item => !item);
    node("native-runner-enroll").disabled = !ready || !known;
    node("native-runner-copy").disabled = !ready || !token;
  }
  function clear() {
    epoch++; loading = false; writing = false; known = false; view = null; credentials = []; requestKey = null; hideToken();
    for (const id of ["native-commit", "native-app-identifier", "native-team-id", "native-runner-name"]) node(id).value = "";
    for (const id of ["native-jobs", "native-runners", "native-credential-uses"]) node(id).replaceChildren();
    node("native-editor").open = false; node("native-app-name").textContent = ""; status(""); controls();
  }
  function validate(result, app) {
    if (!result || result.appId !== app || !Array.isArray(result.jobs) || result.jobs.length > 200 || !Array.isArray(result.runners) || result.runners.length > 100 || !Array.isArray(result.credentialUses) || result.credentialUses.length > 500) throw new Error("INVALID_NATIVE_VIEW");
    for (const item of [...result.jobs, ...result.runners, ...result.credentialUses]) if (!item || item.appId !== app) throw new Error("INVALID_NATIVE_SCOPE");
    return result;
  }
  function render() {
    for (const id of ["native-jobs", "native-runners", "native-credential-uses"]) node(id).replaceChildren();
    const states = { queued: "대기", leased: "Runner 처리 중", running: "빌드 중", succeeded: "서명 빌드 완료", failed: "실패", cancel_requested: "취소 요청", cancelled: "취소" };
    for (const job of view.jobs) {
      const card = element(document, "section", undefined, "credential-item");
      card.append(element(document, "h3", `${job.platform === "ios" ? "iOS" : job.platform === "android" ? "Android" : "플랫폼 확인 필요"} · ${states[job.state] ?? "상태 확인 필요"}`), pair(document, "앱 식별자", job.appIdentifier), pair(document, "등록", date(job.createdAt)));
      if (job.updatedAt) card.append(pair(document, "최근 변경", date(job.updatedAt)));
      if (job.code) card.append(pair(document, "결과 코드", job.code));
      if (job.artifact) card.append(pair(document, "서명 산출물", job.artifact.fileName));
      card.append(technicalDetails(document, [["작업", job.id], ["Commit", job.commitSha], ...(job.artifact ? [["산출물 SHA-256", job.artifact.sha256], ["서명자 SHA-256", job.artifact.signerFingerprint]] : [])]));
      node("native-jobs").append(card);
    }
    for (const runner of view.runners) {
      const card = element(document, "section", undefined, "credential-item");
      card.append(element(document, "h3", runner.name), pair(document, "플랫폼", runner.platform), pair(document, "상태", runner.revokedAt ? "사용 중지" : runner.lastSeenAt ? "연결 기록 있음" : "연결 대기"), technicalDetails(document, [["Runner", runner.id]]));
      if (runner.lastSeenAt) card.append(pair(document, "마지막 연결", date(runner.lastSeenAt)));
      node("native-runners").append(card);
    }
    for (const use of view.credentialUses) {
      const card = element(document, "section", undefined, "credential-item");
      card.append(pair(document, "전달 시각", date(use.createdAt)), technicalDetails(document, [["작업 / Runner", `${safe(use.jobId)} / ${safe(use.runnerId)}`]]));
      for (const pin of Array.isArray(use.credentials) ? use.credentials : []) card.append(element(document, "p", `${CREDENTIAL_KINDS[pin.kind] ?? "서명 키"} · 버전 ${safe(pin.version)}`, "credential-history-row"));
      node("native-credential-uses").append(card);
    }
    for (const [id, label] of [["native-jobs", "이 앱의 네이티브 빌드 이력이 없습니다."], ["native-runners", "이 앱의 네이티브 Runner가 없습니다."], ["native-credential-uses", "이 앱의 서명 키 전달 이력이 없습니다."]]) if (!node(id).children.length) node(id).append(element(document, "p", label, "subtle"));
    status("선택 앱의 네이티브 빌드와 키 전달 이력입니다. OTA Runner와 별도 권한으로 동작합니다."); controls();
    context.onView?.(context.appId(), view);
  }
  function defaults() {
    const selected = selectedCredentials();
    if (!node("native-app-identifier").value) node("native-app-identifier").value = selected.find(item => item?.metadata?.appIdentifier)?.metadata.appIdentifier ?? "";
    if (!node("native-team-id").value) node("native-team-id").value = selected.find(item => item?.metadata?.teamId)?.metadata.teamId ?? "";
    node("native-signing-hint").textContent = selected.some(item => !item) ? "이 플랫폼의 활성 서명 키를 먼저 등록하세요." : selected.map(item => `${CREDENTIAL_KINDS[item.kind]} · 버전 ${item.activeVersion}`).join(" / "); controls();
  }
  async function load() {
    if (!context.ready() || !context.appId() || loading || writing) return;
    const app = context.appId(), version = ++epoch; loading = true; known = false; hideToken(); controls(); status("네이티브 빌드 이력을 확인하는 중…");
    try {
      const [result, registry] = await Promise.all([context.api(`/api/apps/${encodeURIComponent(app)}/native`), context.api(`/api/apps/${encodeURIComponent(app)}/credentials`)]);
      if (!current(app, version)) return;
      view = validate(result, app);
      if (!registry || registry.appId !== app || !Array.isArray(registry.credentials) || registry.credentials.length > 9) throw new Error("INVALID_CREDENTIAL_VIEW");
      credentials = registry.configured ? registry.credentials : []; known = true;
      node("native-app-name").textContent = `선택 앱 · ${safe(context.appName?.() ?? app)}`;
      if (!node("native-commit").value) node("native-commit").value = context.commitSha?.() ?? "";
      render(); defaults();
    } catch (error) { if (current(app, version)) { known = false; if (error.status === 401) context.expire(); else status("네이티브 빌드 이력을 확인하지 못했습니다. 다시 확인해 주세요."); } }
    finally { if (version === epoch) { loading = false; controls(); } }
  }
  async function write(suffix, body, enrollment = false) {
    if (!context.ready() || !known || loading || writing || !context.appId()) return;
    const app = context.appId(), version = ++epoch; writing = true; hideToken(); controls();
    try {
      const receipt = await context.api(`/api/apps/${encodeURIComponent(app)}/native/${suffix}`, JSON.stringify(body));
      if (!current(app, version)) return;
      if (!receipt || (enrollment ? receipt.runner?.appId : receipt.appId) !== app) throw new Error("INVALID_NATIVE_RECEIPT");
      if (enrollment) {
        if (typeof receipt.token !== "string" || receipt.token.length < 16 || receipt.token.length > 2048) throw new Error("INVALID_NATIVE_TOKEN");
        token = receipt.token; node("native-runner-token").textContent = token; node("native-runner-token-panel").hidden = false;
        status("네이티브 Runner를 등록했습니다. 토큰은 한 번만 표시됩니다. 안전한 Runner 설정에 보관하세요.");
      } else { requestKey = null; writing = false; await load(); }
    } catch (error) {
      if (!current(app, version)) return;
      if (error.status === 401) context.expire();
      else { known = false; status("처리 결과를 확인하지 못했습니다. 이력을 새로 확인한 뒤 진행하세요. 자동으로 다시 요청하지 않습니다."); }
    } finally { if (version === epoch) { writing = false; controls(); } }
  }
  async function enqueue() {
    const platform = node("native-platform").value, commitSha = node("native-commit").value.trim(), appIdentifier = node("native-app-identifier").value.trim(), teamId = node("native-team-id").value.trim(), selected = selectedCredentials();
    if (!known || selected.some(item => !item) || !["ios", "android"].includes(platform) || !/^[a-f0-9]{40}$/.test(commitSha) || !/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+$/.test(appIdentifier) || platform === "ios" && !/^[A-Z0-9]{10}$/.test(teamId)) { status("GitHub Commit SHA, 앱 식별자와 활성 서명 키를 확인하세요. iOS는 Apple Team ID가 필요합니다."); return; }
    if (!requestKey && env.crypto?.randomUUID) requestKey = "native_" + env.crypto.randomUUID(); if (!requestKey) { status("안전한 작업 ID를 생성할 수 없습니다."); return; }
    await write("jobs", { requestKey, commitSha, platform, appIdentifier, ...(platform === "ios" ? { teamId } : {}), credentials: selected.map(item => ({ kind: item.kind, version: item.activeVersion })) });
  }
  async function enroll() {
    const name = node("native-runner-name").value.trim(), platform = node("native-runner-platform").value;
    if (!name || name.length > 80 || !["ios", "android"].includes(platform)) { status("Runner 이름과 플랫폼을 확인하세요."); return; }
    await write("runners", { name, platform }, true);
  }
  async function copyToken() {
    if (!token || !context.ready()) return;
    const app = context.appId(), version = epoch;
    try { await env.navigator.clipboard.writeText(token); if (current(app, version)) status("네이티브 Runner 토큰을 복사했습니다. 안전한 설정에 저장하세요."); }
    catch { if (current(app, version)) status("복사하지 못했습니다. 표시된 토큰을 안전하게 보관하세요."); }
  }
  node("native-refresh").addEventListener("click", () => { void load(); });
  node("native-editor").addEventListener("toggle", () => { if (node("native-editor").open && !node("page-builds")?.hidden) void load(); else if (!node("native-editor").open) hideToken(); });
  node("native-platform").addEventListener("change", () => { requestKey = null; node("native-app-identifier").value = ""; node("native-team-id").value = ""; defaults(); });
  for (const id of ["native-commit", "native-app-identifier", "native-team-id"]) node(id).addEventListener("input", () => { requestKey = null; });
  node("native-form").addEventListener("submit", event => { event.preventDefault(); void enqueue(); });
  node("native-runner-form").addEventListener("submit", event => { event.preventDefault(); void enroll(); });
  node("native-runner-copy").addEventListener("click", () => { void copyToken(); });
  node("native-runner-hide").addEventListener("click", hideToken);
  controls(); return { load, clear, controls, enqueue, enroll, copyToken, hideToken };
}

export async function startClient(env) {
  const { document } = env; const node = id => document.getElementById(id);
  const now = () => env.now?.() ?? Date.now();
  let csrf = ""; let expiresAt = 0; let expiryTimer; let closed = false; let busy = false; let reading = false; let generation = 0; let viewGeneration = 0; let data = null; let selectedId = null; let selectedAppId = null;
  let snapshotCursors = [null]; let historyCursors = [null];
  let currentRoute = parseAdminPath(env.location?.pathname ?? "/") ?? parseAdminPath("/");
  let routeEpoch = 0;
  let projectSummary = null; let projectStatus = "loading"; let projectEpoch = 0; let projectLoading = false; let projectRequest = null; let projectTimer; let projectLastAttempt = -Infinity;
  selectedAppId = currentRoute.appId;
  let currentView = ADMIN_PAGES[currentRoute.page].legacy; let appPage = 0; let filteredCount = 0; let detailTrigger = null; const pageSize = 10;
  let ciBinding = null; let ciAppId = null; let ciKnown = false; let ciIdentity = null; let ciEpoch = 0; let ciConflict = false;
  let overviewEpoch = 0; let operations = null; let operationsAppId = null; let deploymentRequestKey = null; let automation = null; let automationAppId = null; let automationRequestKey = null; let runnerToken = ""; let runnerTokenAppId = null; let automationTimer; let automationPollDelay = 5000; let automationLoading = null; let detailEpoch = 0; const detailLoading = new Set();
  const requests = new Set(); const logs = new Map();
  const credentialsPanel = createCredentialPanel(env, { appId: () => selectedAppId, appName: () => data?.selectedApplication?.name, active, ready: () => !closed && Boolean(csrf) && !busy && !reading && active(), api, expire });
  const buildPanel = createBuildProviderPanel(env, { appId: () => selectedAppId, active: () => !closed && !!csrf && active(), navigate: (page, appId) => navigate(page, appId) });
  const nativePanel = createNativePanel(env, { onView: (app, view) => buildPanel.setNativeView(app, view), appId: () => selectedAppId, appName: () => data?.selectedApplication?.name, commitSha: () => operationsAppId === selectedAppId ? currentDetection(operations)?.commitSha : null, active, ready: () => !closed && Boolean(csrf) && !busy && !reading && active(), api, expire });
  const deploymentDevices = createDeploymentDevices(env, { route: () => currentRoute, active: () => !closed && Boolean(csrf) && active(), api, expire });
  const autoRollback = createAutoRollback(env, { route: () => currentRoute, active: () => !closed && Boolean(csrf) && active(), api, expire });
  let wizardPolling = false;
  const onboardingPanel = createOnboarding(env, {
    api: (path,body,signal) => api(path,body,csrf,false,signal),
    isCurrent: () => !closed && Boolean(csrf) && active() && currentRoute.page === "onboarding",
    getSnapshot: () => ({authenticated:!closed && Boolean(csrf),appId:selectedAppId,connection:null,operations:operationsAppId===selectedAppId?operations:null,automation:automationAppId===selectedAppId?automation:null,target:null}),
    refreshData: async (selection,signal) => {if(selection.operations)await loadOperations(signal);if(!signal?.aborted&&selection.automation)await loadAutomation(signal);},
    setActiveJobPolling: active => {wizardPolling=active;if(!active)stopAutomationPoll();else scheduleAutomationPoll();},navigate:path=>navigate(path),expire,
  });
  let githubExchangeUnknown = false; const runnerEnrollmentUnknown = new Set(); let runnerReceiptId = null;
  let githubEpoch = 0; let githubInstallations = []; let githubRepositories = []; let githubCursor = null; let githubSelection = null; let githubRepositoryPages = 0;
  // Clear the one-use authorization callback before any async work or private rendering.
  const callbackHash = String(env.location?.hash ?? "");
  const callbackParams = new URLSearchParams(callbackHash.slice(1));
  let githubCallback = callbackParams.has("github-app-code") || callbackParams.has("github-app-state") ? { code: callbackParams.get("github-app-code"), state: callbackParams.get("github-app-state") } : null;
  if (githubCallback) env.history?.replaceState(null, "", "/");

  function notice(text = "", error = false, retry = false, success = false) {
    node("notice").textContent = text; node("notice").hidden = !text;
    node("notice").className = "notice" + (error ? " notice-error" : success ? " notice-success" : ""); node("notice").setAttribute("role", error ? "alert" : "status");
    node("retry-button").hidden = !retry || closed;
  }
  function scoped(url) { return selectedAppId ? url + (url.includes("?") ? "&" : "?") + "appId=" + encodeURIComponent(selectedAppId) : url; }
  function controls() {
    operationControls();
    node("github-open").disabled = closed || !csrf;
    for (const id of ["github-managed-refresh", "github-manifest-start", "github-repository-use", "github-repositories-more"]) node(id).disabled = closed || !csrf || busy || reading;
    if (githubExchangeUnknown) node("github-manifest-start").disabled = true;
    node("signing-key-create").disabled = closed || !csrf || busy || reading || !selectedAppId;
    for (const id of ["application-register", "settings-save"]) node(id).disabled = closed || !csrf || busy || reading;
    node("settings-json").disabled = closed || busy || reading || !data?.selectedApplication;
    node("application-select").disabled = closed || !csrf;
    node("workspace").setAttribute("aria-busy", reading || busy ? "true" : "false");
    node("source-file").disabled = closed || !csrf || busy || reading;
    node("baseline-file").disabled = closed || busy || reading || !data?.selected || data.selected.id !== selectedId;
    node("snapshot-select").disabled = closed || busy;
    node("flavor-select").disabled = closed || busy || !data?.selected;
    node("logout-button").disabled = closed || !csrf;
    node("snapshot-previous").disabled = closed || busy || reading || snapshotCursors.length < 2;
    node("snapshot-next").disabled = closed || busy || reading || !data?.snapshots.nextCursor;
    node("history-previous").disabled = closed || busy || reading || historyCursors.length < 2;
    node("history-next").disabled = closed || busy || reading || !data?.history.nextCursor;
    node("retry-button").disabled = closed || busy || reading;
    for (const id of ["app-search", "app-source-filter", "app-sort"]) node(id).disabled = closed || !data?.selected || busy;
    node("app-previous").disabled = closed || appPage === 0;
    node("app-next").disabled = closed || (appPage + 1) * pageSize >= filteredCount;
    for (const view of ["apps", "updates", "sources", "history", "account"]) for (const prefix of ["nav-", "mobile-"]) node(prefix + view).disabled = closed || !csrf;
    ciControls();
    credentialsPanel.controls(); nativePanel.controls();
    for (const id of ["ci-refresh", "ci-resolve"]) node(id).disabled = closed || busy || reading || !selectedAppId;
    if (node("project-summary-refresh")) node("project-summary-refresh").disabled = closed || !csrf || reading || projectLoading || !data;
    renderRoute();
  }
  function erase(preserveProjects = false) {
    stopProjectsPoll(); projectEpoch++; if (!preserveProjects) { projectSummary = null; projectStatus = "loading"; projectLastAttempt = -Infinity; node("workspace-status")?.replaceChildren(); } projectLoading = false; node("project-summary-status")?.replaceChildren();
    credentialsPanel.clear(); nativePanel.clear(); buildPanel.clear(); deploymentDevices.clear(); autoRollback.clear(); onboardingPanel.leave();
    ciBinding = null; ciAppId = null; ciKnown = false; ciIdentity = null; ciEpoch++; ciConflict = false; clearCI(document);
    githubCallback = null; githubEpoch++; githubInstallations = []; githubRepositories = []; githubCursor = null; githubSelection = null; githubRepositoryPages = 0;
    for (const id of ["github-installation-select", "github-repository-select", "github-managed-status", "github-repository-scope", "github-repository-count", "signing-key-status"]) node(id)?.replaceChildren();
    for (const id of ["github-install-link", "github-access-settings", "github-repository-picker", "github-manifest-form", "signing-certificate-download"]) { const value = node(id); if (value) { value.hidden = true; value.removeAttribute?.("href"); } }
    if (node("github-organization")) node("github-organization").value = "";
    node("github-repository-search").value = "";
    automation = null; automationAppId = null; automationRequestKey = null; runnerToken = ""; runnerTokenAppId = null;
    operations = null; operationsAppId = null; deploymentRequestKey = null;
    clearApplications(document, true);
    viewGeneration++;
    for (const id of PRIVATE_FIELDS) { node(id).replaceChildren(); node(id).value = ""; }
    for (const id of ["source-file", "baseline-file"]) node(id).value = "";
    node("dashboard-content").hidden = true; node("empty").hidden = true; node("app-detail").hidden = true; node("view-account").hidden = true; node("view-updates").hidden = true; appPage = 0; filteredCount = 0; detailTrigger = null;
    data = null; selectedId = null; selectedAppId = null; logs.clear(); snapshotCursors = [null]; historyCursors = [null];
  }
  function close(message = "") {
    closed = true; busy = false; reading = false; generation++; stopAutomationPoll(); csrf = ""; expiresAt = 0; env.clearTimeout(expiryTimer);
    for (const request of requests) request.abort(); requests.clear(); erase(); notice(message, Boolean(message));
    node("login-link").hidden = !message; sidebar(false); renderRoute(); controls();
  }
  function expire() { close("세션이 없거나 만료되었습니다. 다시 로그인해 주세요."); }
  function active() { if (!closed && csrf && now() >= expiresAt) expire(); return !closed; }
  function armExpiry() {
    env.clearTimeout(expiryTimer);
    if (closed) return;
    const remaining = expiresAt - now();
    if (remaining <= 0) { expire(); return; }
    // This one-shot local deadline clears the screen; it never fetches or polls.
    expiryTimer = env.setTimeout(() => { if (now() >= expiresAt) expire(); else armExpiry(); }, remaining);
  }
  async function api(url, body, csrfValue = csrf, raw = false, signal) {
    const controller = new AbortController(); requests.add(controller);
    try {
      const response = await env.fetch(url, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", headers: body === undefined ? {} : { "Content-Type": raw ? "application/octet-stream" : "application/json", "X-Flora-CSRF": csrfValue }, ...(body === undefined ? {} : { body }), signal: signal ? AbortSignal.any([controller.signal,signal]) : controller.signal });
      if (!response.ok) {
        let code = "";
        try { const payload = await response.json(); const value = payload?.error ?? payload?.code; if (["CONFLICT", "APP_CONFLICT", "IDEMPOTENCY_CONFLICT", "CAPACITY", "CAPACITY_EXCEEDED", "BUSY", "GITHUB_ACCESS_DENIED", "GITHUB_REPOSITORY_UNAVAILABLE", "GITHUB_REF_NOT_FOUND", "GITHUB_APP_UNSUPPORTED", "D1_DAILY_READ_LIMIT", "D1_DAILY_WRITE_LIMIT", "D1_ACCOUNT_STORAGE_LIMIT", "D1_DATABASE_SIZE_LIMIT", "D1_OVERLOADED"].includes(value)) code = value; } catch { /* Do not display raw server or proxy text. */ }
        throw Object.assign(new Error("REQUEST_FAILED"), { status: response.status, code });
      }
      return response.status === 204 ? null : await response.json();
    } finally { requests.delete(controller); }
  }
  function failure(error, importing = false) {
    if (closed) return;
    if (error.status === 401) { expire(); return; }
    let text = importing ? "반입 완료 여부를 확인하지 못했습니다. 연결을 확인한 뒤 이력을 다시 불러오세요. 기록이 없다면 같은 원본 파일로 다시 시도할 수 있습니다." : "이력을 불러오지 못했습니다. 연결 또는 저장소를 사용할 수 없는 상태일 수 있습니다. 잠시 후 다시 시도해 주세요.";
    if (["D1_DAILY_READ_LIMIT", "D1_DAILY_WRITE_LIMIT"].includes(error.code)) {
      const reset = new Date(); reset.setUTCHours(24, 0, 0, 0);
      const label = new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Seoul" }).format(reset);
      text = `Cloudflare 무료 데이터 ${error.code === "D1_DAILY_READ_LIMIT" ? "조회" : "기록"} 한도에 도달했습니다. ${label} KST에 한도가 초기화됩니다. 기존 데이터와 이력은 보존됩니다. 자동 배포는 한도 해제 후 재개할 수 있습니다.`;
    } else if (["D1_ACCOUNT_STORAGE_LIMIT", "D1_DATABASE_SIZE_LIMIT"].includes(error.code)) text = "Cloudflare 저장 용량 한도에 도달했습니다. 기존 데이터와 이력은 보존됩니다. 작업공간 저장 사용량을 확인해 주세요.";
    else if (error.code === "D1_OVERLOADED") text = "데이터 연결이 일시적으로 혼잡합니다. 잠시 후 운영 정보를 다시 확인해 주세요.";
    else if (error.status === 413) text = "파일이 허용 크기를 초과했습니다. 소스는 최대 1 MiB, baseline은 최대 128 KiB입니다.";
    else if (error.code === "CONFLICT") text = "저장소·앱 경로가 맞지 않거나 저장 한도에 도달했을 수 있어 반입을 완료하지 못했습니다. 기존 이력과 현재 앱에 해당하는 원본 파일을 확인해 주세요.";
    else if (error.code === "APP_CONFLICT") text = "이 작업실에 저장된 앱과 파일의 저장소 또는 루트가 맞지 않습니다. 현재 앱에 해당하는 원본 파일을 선택해 주세요.";
    else if (error.code === "IDEMPOTENCY_CONFLICT") text = "같은 반입 식별자에 다른 내용이 이미 저장되어 있습니다. 기존 이력과 원본 baseline을 확인해 주세요.";
    else if (["CAPACITY", "CAPACITY_EXCEEDED"].includes(error.code)) text = "저장 용량 한도로 새 반입을 완료하지 못했습니다. 기존 이력은 다시 불러올 수 있습니다.";
    else if (error.code === "BUSY" || error.status === 429) text = "현재 처리 중이거나 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.";
    else if (error.status === 403) text = "요청 권한을 확인하지 못했습니다. 다시 로그인한 뒤 시도해 주세요.";
    else if (error.status === 400 || error.status === 415 || error.status === 409) text = "파일이나 요청을 받아들이지 못했습니다. 선택한 revision, 파일 형식과 반입 이력을 확인해 주세요.";
    if (data) text += " 화면에는 마지막으로 확인한 이력이 남아 있습니다.";
    if (!data && currentRoute.page === "projects") {
      if (node("project-total")) node("project-total").textContent = "프로젝트 수 미확인";
      projectStatus = "error"; paintProjects();
    }
    notice(text, true, true);
  }
  function renderFlavor() {
    const selected = data?.selected; if (!selected) return;
    const flavor = selected.flavors.find(item => item.id === node("flavor-select").value) ?? selected.flavors[0];
    node("flavor-detail").replaceChildren();
    node("detail-title").textContent = flavor ? safe(flavor.appName.value) : "앱 상세";
    if (flavor) for (const [label, fact] of [["앱 이름", flavor.appName], ["제품 유형", flavor.productType], ["패키지 선언", flavor.declaredPackage], ...(selected.runtime.appVersion ? [["선언 버전", selected.runtime.appVersion]] : [])]) node("flavor-detail").append(pair(document, label, fact.value), element(document, "p", `${fact.provenance.path} · ${fact.provenance.pointer}`, "source-pointer mono"));
  }
  function showView(view, focus = false) {
    if (!active()) return;
    // Rendering may re-enter this helper; it must never push another history entry.
    if (view === currentView) { renderRoute(focus); return; }
    void navigate(({ apps: "projects", updates: "ota", sources: "source", history: "activity", account: "settings" })[view], selectedAppId, { focus });
  }
  function sidebar(open = false) {
    document.body.setAttribute("data-menu-open", String(open));
    node("sidebar-toggle").setAttribute("aria-expanded", String(open));
    node("sidebar-toggle").setAttribute("aria-label", open ? "메뉴 닫기" : "메뉴 열기");
    if (open) node("nav-apps").focus();
  }
  function renderRoute(focus = false) {
    const meta = ADMIN_PAGES[currentRoute.page];
    const appReady = Boolean(currentRoute.appId && data?.selectedApplication?.id === currentRoute.appId);
    document.body.setAttribute("data-admin-page", currentRoute.page);
    document.title = `${meta.title}${appReady ? " · " + safe(data.selectedApplication.name) : ""} · Flora`;
    node("view-title").textContent = meta.title; node("view-label").textContent = appReady ? `${safe(data.selectedApplication.name)} / ${meta.title}` : meta.title; node("view-description").textContent = meta.description;
    for (const [page, entry] of Object.entries(ADMIN_PAGES)) node(entry.section).hidden = closed || page !== currentRoute.page || Boolean(currentRoute.appId && !appReady);
    node("route-empty").hidden = closed || !currentRoute.appId || appReady || reading;
    node("application-select").value = currentRoute.page === "onboarding" ? selectedAppId ?? "" : currentRoute.appId ?? "";
    node("sidebar-app-name").textContent = appReady ? safe(data.selectedApplication.name) : "프로젝트를 선택하세요";
    node("sidebar-app-nav").hidden = !currentRoute.appId || !appReady;
    node("project-register-open").hidden = currentRoute.page !== "projects";
    node("dashboard-content").hidden = currentRoute.page !== "source" || !data?.selected;
    node("view-apps").hidden = currentRoute.page !== "source"; node("view-sources").hidden = currentRoute.page !== "source";
    node("view-history").hidden = currentRoute.page !== "activity";
    node("empty").hidden = currentRoute.page !== "source" || Boolean(data?.selected) || !appReady;
    for (const [id, page] of Object.entries({ "nav-onboarding": "onboarding", "nav-apps": "projects", "nav-account": "settings", "nav-overview": "overview", "nav-sources": "source", "nav-updates": "ota", "nav-runners": "runners", "nav-builds": "builds", "nav-credentials": "credentials", "nav-app-settings": "app-settings", "nav-history": "activity" })) {
      const item = node(id), path = adminPath(page, currentRoute.appId ?? selectedAppId);
      item.setAttribute("aria-current", (currentRoute.page === page || page === "ota" && currentRoute.page === "ota-detail") ? "page" : "false"); item.className = "nav-item" + ((currentRoute.page === page || page === "ota" && currentRoute.page === "ota-detail") ? " active" : "");
      item.disabled = closed || !csrf || !path || Boolean(!["projects", "settings", "onboarding"].includes(page) && !appReady);
      if (path) item.setAttribute("data-admin-path", path);
    }
    for (const link of document.querySelectorAll?.("a[data-admin-page]") ?? []) { const path = adminPath(link.getAttribute("data-admin-page"), currentRoute.appId ?? selectedAppId); if (path) link.setAttribute("href", path); }
    if (focus) { sidebar(false); node("workspace").focus(); env.scrollTo?.({ top: 0, behavior: "instant" }); }
  }
  async function loadRoute(epoch = routeEpoch) {
    if (!active() || !csrf || !data || epoch !== routeEpoch) return;
    const page = currentRoute.page, app = currentRoute.appId;
    if (app && data.selectedApplication?.id !== app) return;
    const current = () => active() && epoch === routeEpoch && currentRoute.page === page && currentRoute.appId === app;
    if (page === "onboarding") await onboardingPanel.enter(selectedAppId);
    else if (page === "projects") await loadProjects();
    else if (page === "register") { node("application-registration").open = true; await loadGitHubConnection(); }
    else if (page === "credentials") { node("credential-editor").open = true; await credentialsPanel.load(); }
    else if (page === "builds") { if (operationsAppId !== app) await loadOperations(); if (current()) { buildPanel.open(app); if (operationsAppId === app) buildPanel.setOTAView(app, operations); if (operationsAppId === app) buildPanel.setGithubSource(app, operations?.connection, currentDetection(operations)?.commitSha); node("native-editor").open = true; await nativePanel.load(); } }
    else if (page === "runners") { node("automation-editor").open = true; await loadProjectOverview(); if (current()) await nativePanel.load(); }
    else if (page === "ota-detail") await deploymentDevices.open(currentRoute);
    else if (page === "overview") await loadProjectOverview();
    else if (page === "source" || page === "ota") { node("operations-editor").open = page === "source"; await loadOperations(); if (page === "ota" && current()) await autoRollback.open(app, operationsAppId === app ? operations?.deployments : []); }
    else if (page === "app-settings") node("settings-editor").open = true;
  }
  async function navigate(page, appId = null, options = {}) {
    if (!active() || !csrf) return false;
    const route = typeof page === "string" && page.startsWith("/") ? parseAdminPath(page) : parseAdminPath(adminPath(page, appId ?? selectedAppId));
    if (!route) return false;
    const epoch = ++routeEpoch, previous = currentRoute;
    if (previous.page !== route.page || previous.appId !== route.appId) { projectEpoch++; projectLoading = false; stopProjectsPoll(); credentialsPanel.clear(); nativePanel.clear(); buildPanel.clear(); hideRunnerToken(); stopAutomationPoll(); node("operations-editor").open = false; node("automation-editor").open = false; }
    deploymentDevices.leave(); autoRollback.leave(); onboardingPanel.leave();
    currentRoute = route; currentView = ADMIN_PAGES[route.page].legacy;
    if (!options.fromHistory) { const method = options.replace ? "replaceState" : "pushState"; if (env.location?.pathname !== route.path) env.history?.[method]?.({ flora: true }, "", route.path); }
    sidebar(false);
    const changingApp = route.appId !== selectedAppId;
    if (changingApp) {
      const projectSearch=node("project-search")?.value??"",projectFilter=node("project-status-filter")?.value??"all";
      const apps = data?.applications ?? []; generation++; erase(true); selectedAppId = route.appId;
      if(node("project-search"))node("project-search").value=projectSearch;
      if(node("project-status-filter"))node("project-status-filter").value=projectFilter;
      renderApplications(document, { applications: apps, selectedApplication: null }); renderRoute();
      if (!await refresh() || epoch !== routeEpoch) { renderRoute(); return false; }
    }
    renderRoute(options.focus !== false);
    await loadRoute(epoch); return epoch === routeEpoch;
  }
  function openFlavor(id, trigger) {
    if (!active() || !data?.selected?.flavors.some(flavor => flavor.id === id)) return;
    node("flavor-select").value = id; renderFlavor(); detailTrigger = trigger;
    node("app-detail").hidden = false; node("detail-title").focus();
  }
  function renderTable() {
    const selected = data?.selected; if (!selected) return;
    const query = node("app-search").value.trim().toLocaleLowerCase();
    const source = node("app-source-filter").value;
    let flavors = selected.flavors.filter(flavor => (!source || source === "all" || source === selected.id) && [flavor.appName.value, flavor.id, flavor.declaredPackage.value, selected.repository.fullName].some(value => String(value).toLocaleLowerCase().includes(query)));
    const sort = node("app-sort").value;
    if (sort === "name-asc" || sort === "name-desc") flavors = [...flavors].sort((a, b) => String(a.appName.value).localeCompare(String(b.appName.value), "ko", { numeric: true }) * (sort === "name-desc" ? -1 : 1));
    filteredCount = flavors.length; appPage = Math.min(appPage, Math.max(0, Math.ceil(filteredCount / pageSize) - 1));
    const shown = flavors.slice(appPage * pageSize, (appPage + 1) * pageSize);
    node("app-rows").replaceChildren(...shown.map(flavor => {
      const row = element(document, "tr"); const nameCell = element(document, "td", undefined, "name-cell");
      const button = element(document, "button", undefined, "app-open"); button.type = "button"; button.id = "flavor-row-" + flavor.id; button.setAttribute("aria-label", `${safe(flavor.appName.value)} 상세 보기`);
      const index = selected.flavors.findIndex(item => item.id === flavor.id);
      const monogram = String(flavor.appName.value).trim().split(/\s+/).map(part => Array.from(part)[0] ?? "").slice(0, 2).join("").toLocaleUpperCase() || Array.from(flavor.id).slice(0, 2).join("");
      const label = element(document, "span", undefined, "app-label"); label.append(element(document, "strong", flavor.appName.value), element(document, "span", flavor.id, "app-id"), element(document, "span", selected.runtime.appVersion?.value ?? "선언 없음", "mobile-version"));
      const mark = element(document, "span", monogram, "app-monogram tone-" + index % 6); mark.setAttribute("aria-hidden", "true"); button.append(mark, label); button.addEventListener("click", () => openFlavor(flavor.id, button)); nameCell.append(button); row.append(nameCell);
      row.append(element(document, "td", selected.repository.fullName, "source-cell"), element(document, "td", selected.runtime.appVersion?.value ?? "선언 없음", "version-cell"));
      const status = element(document, "td", undefined, "state-cell"); status.append(element(document, "span", "반입됨", "badge")); row.append(status);
      for (const metric of ["배포", "오류", "수익"]) { const label = metric === "배포" ? "선택 앱 OTA에서 확인" : "미연결"; const cell = element(document, "td", label, "metric-cell"); cell.setAttribute("aria-label", metric + " " + label); row.append(cell); }
      const arrow = element(document, "td", undefined, "arrow-cell"); const detail = element(document, "button", undefined, "icon-button row-arrow"); detail.type = "button"; detail.setAttribute("aria-label", `${safe(flavor.appName.value)} 상세 보기`); detail.append(icon(document, "chevron-right")); detail.addEventListener("click", () => openFlavor(flavor.id, detail)); arrow.append(detail); row.append(arrow); return row;
    }));
    node("app-empty").hidden = shown.length > 0;
    node("app-pagination").textContent = `${selected.flavors.length}개 flavor 중 ${query ? `검색 ${filteredCount}개 · ` : ""}${shown.length ? appPage * pageSize + 1 : 0}–${appPage * pageSize + shown.length}개 표시`;
    node("app-page-number").textContent = `${appPage + 1} / ${Math.max(1, Math.ceil(filteredCount / pageSize))}`;
    controls();
  }
  function renderConsole() {
    const selected = data.selected;
    node("app-count").textContent = String(selected?.flavors.length ?? 0); node("source-count").textContent = selected ? "1" : "0";
    if (!selected) { showView(currentView); return; }
    select(document, "app-source-filter", [["all", "모든 소스"], [selected.id, selected.repository.fullName]], "all");
    node("mobile-source-name").textContent = safe(selected.repository.fullName); node("mobile-flavor-count").textContent = selected.flavors.length + " flavor";
    node("history-scope").textContent = safe(`${selected.repository.fullName} · ${selected.commitSha.slice(0, 12)} 소스 기준입니다. 선택한 flavor의 실행 결과가 아닙니다.`);
    const recent = node("recent-history"); recent.replaceChildren();
    const entries = [{ at: selected.importedAt, text: "소스 스냅샷 반입", name: "file" }, ...data.history.items.map(record => ({ at: record.createdAt, text: "개발 baseline 반입 · " + (LABELS[record.state] ?? "상태 알 수 없음") + (record.assessment ? ` · 파일 ${record.assessment.files}개 / 테스트 ${record.assessment.tests}개` : ""), name: "file" }))].sort((a, b) => b.at - a.at).slice(0, 3);
    for (const entry of entries) { const row = element(document, "div", undefined, "recent-row"); row.append(icon(document, entry.name), element(document, "time", date(entry.at)), element(document, "span", entry.text)); recent.append(row); }
    renderTable(); showView(currentView);
  }
  function render() {
    renderApplications(document, projectView());
    const selected = data.selected; viewGeneration++; logs.clear(); node("app-detail").hidden = true; detailTrigger = null; renderConsole();
    if (!active() || !data) return;
    node("dashboard-content").hidden = !selected || currentRoute.page !== "source"; node("empty").hidden = Boolean(selected) || currentRoute.page !== "source";
    if (!selected) {
      if (data.selectedApplication || data.applications?.length) { node("empty").replaceChildren(element(document, "h2", data.selectedApplication ? "프로젝트의 연결과 배포 상태를 확인하세요" : "프로젝트를 선택해 주세요"), element(document, "p", "위의 프로젝트 카드를 열면 앱별 GitHub 소스와 OTA 배포 이력을 확인할 수 있습니다.", "subtle")); controls(); return; }
      node("empty").replaceChildren(element(document, "p", "SOURCE SNAPSHOT", "eyebrow"), element(document, "h2", "첫 소스 snapshot을 가져오세요"), element(document, "p", "소스 JSON에서 앱·flavor·런타임 선언을 확인합니다. 최대 1 MiB의 원본 파일을 선택해 주세요."), element(document, "p", "반입은 파일 안의 코드를 실행하지 않습니다.", "subtle")); controls(); return;
    }
    node("app-name").textContent = safe(selected.repository.fullName);
    const fresh = data.freshness === "observed_current" ? "관측 시점에 일치" : data.freshness === "stale" ? "관측 HEAD와 다름" : "최신 여부 알 수 없음";
    node("freshness").textContent = fresh; node("freshness").className = "badge " + (data.freshness === "observed_current" ? "neutral" : "warning");
    const summaries = data.snapshots.items.map(item => [item.id, `${item.commitSha.slice(0, 12)} · ${date(item.importedAt)}`]);
    if (!data.snapshots.items.some(item => item.id === selected.id)) summaries.unshift([selected.id, `현재 선택 · ${selected.commitSha.slice(0, 12)} · ${date(selected.importedAt)}`]);
    select(document, "snapshot-select", summaries, selected.id);
    node("snapshot-page").textContent = `${snapshotCursors.length}페이지 · 이 페이지 ${data.snapshots.items.length}개 · 페이지당 최대 20개`;
    node("source-meta").replaceChildren(pair(document, "소스 수집", date(selected.fetchedAt)), pair(document, "화면에 반입", date(selected.importedAt)));
    node("trust-note").textContent = "사용자 반입 · 일회성 소스 snapshot. 해시는 반입 파일의 내부 일치성을 확인합니다. 실시간 연결이나 실행·격리 인증을 뜻하지 않습니다.";
    const details = node("source-details"); details.replaceChildren(pair(document, "Commit", selected.commitSha, true), pair(document, "Source digest", selected.digest, true), pair(document, "Root", selected.rootDirectory, true), pair(document, "Snapshot", selected.id, true));
    if (data.headObservation) details.append(pair(document, "반입한 HEAD 관측", `${data.headObservation.headCommitSha} · ${date(data.headObservation.observedAt)}`));
    for (const file of selected.files) details.append(pair(document, file.path, `${file.byteLength} bytes · blob ${file.gitBlobSha} · sha256 ${file.sha256}`, true));
    node("flavor-count").textContent = `${selected.flavors.length}개`;
    const flavorId = selected.flavors.some(item => item.id === node("flavor-select").value) ? node("flavor-select").value : selected.selectedFlavor;
    select(document, "flavor-select", selected.flavors.map(item => [item.id, `${item.id} · ${item.appName.value}`]), flavorId); renderFlavor();
    const runtime = selected.runtime;
    node("runtime").replaceChildren(...[["앱 버전", runtime.appVersion?.value ?? "선언 없음"], ["Node engine", runtime.nodeEngine?.value ?? "선언 없음"], ...Object.entries(runtime.versions).map(([key, value]) => [key, value?.value ?? "선언 없음"]), ["Lockfile", `v${runtime.lockfileVersion.value} · ${runtime.packageEntryCount.value}개 항목`], ["runtimeVersion", "미평가"], ["설치된 바이너리", "확인하지 않음"]].map(([label, value]) => pair(document, label, value)));
    node("profile").replaceChildren(element(document, "h3", "반입 결과의 고정 검증 범위"), element(document, "p", data.profile.id, "mono profile-id"), element(document, "p", `${data.profile.files.length}개 파일 · ${data.profile.expectedTests}개 테스트`, "coverage-count"), element(document, "p", data.profile.coverage, "subtle"), ...data.profile.files.map(file => element(document, "p", file, "source-pointer mono")));
    node("provider").replaceChildren(element(document, "h3", "호스팅에서는 실행할 수 없음"), element(document, "p", "Runner 미제공 · 개발 환경에서 수집한 baseline만 반입할 수 있습니다.", "warning-text"), element(document, "p", "통과 결과도 반입된 개발 증거이며 현재 소스의 최신 여부나 격리 실행을 보증하지 않습니다.", "subtle"));
    node("history-page").textContent = `${historyCursors.length}페이지 · 이 페이지 ${data.history.items.length}개 · 페이지당 최대 20개`;
    node("baseline-history").replaceChildren(...data.history.items.map(record => {
      const card = element(document, "article", undefined, "record"); const head = element(document, "div", undefined, "record-heading");
      head.append(element(document, "span", "반입 결과 · " + (LABELS[record.state] ?? record.state), "badge " + (record.state === "passed" ? "success" : "warning")), element(document, "span", date(record.createdAt), "timestamp"));
      card.append(head, element(document, "p", record.id, "mono record-id"));
      if (record.code) card.append(element(document, "p", record.code, "mono record-code"));
      if (record.assessment) card.append(element(document, "p", `${record.assessment.files}개 파일 · ${record.assessment.tests}개 테스트 · 통과 ${record.assessment.passed} / 실패 ${record.assessment.failed} / 건너뜀 ${record.assessment.skipped}`, "record-note"));
      card.append(element(document, "p", `${record.platform} · Node ${record.node} · exit ${record.exitCode ?? "미확인"}`, "record-note"), element(document, "p", "원본 baseline digest · " + record.evidenceDigest, "mono record-id"));
      const disclosure = element(document, "details"); disclosure.id = "log-" + record.id; disclosure.append(element(document, "summary", "반입 로그 보기"));
      disclosure.addEventListener("toggle", () => disclosure.open ? loadLog(record.id, disclosure) : undefined); card.append(disclosure); return card;
    }));
    if (!data.history.items.length) node("baseline-history").append(element(document, "p", "이 페이지에는 반입한 baseline이 없습니다.", "empty-history"));
    controls();
  }
  async function refresh(pages = {}) {
    if (!active()) return false;
    const version = ++generation; reading = true; controls(); notice("세션과 반입 이력을 불러오는 중…");
    const nextSnapshots = pages.snapshots ?? snapshotCursors; const nextHistory = pages.history ?? historyCursors;
    const query = new URLSearchParams(); if (selectedId) query.set("snapshotId", selectedId); if (nextSnapshots.at(-1)) query.set("snapshotCursor", nextSnapshots.at(-1)); if (nextHistory.at(-1)) query.set("historyCursor", nextHistory.at(-1));
    try {
      const next = await api(scoped("/api/state" + (query.size ? "?" + query : "")));
      if (!active() || version !== generation) return false;
      if (!validState(next) || (selectedId && next.selected?.id !== selectedId) || (currentRoute.appId && next.selectedApplication?.id !== currentRoute.appId)) throw new Error("INVALID_STATE");
      if (selectedAppId !== (next.selectedApplication?.id ?? null)) { credentialsPanel.clear(); nativePanel.clear(); }
      data = next; selectedId = data.selected?.id ?? null; selectedAppId = data.selectedApplication?.id ?? null; snapshotCursors = nextSnapshots; historyCursors = nextHistory; render();
      if (!active()) return false;
      notice(); return true;
    } catch (error) { if (!closed && version === generation) failure(error); return false; }
    finally { if (version === generation) { reading = false; controls(); renderRoute(); } }
  }
  async function chooseSnapshot(id) { if (!active() || busy) return; selectedId = id; historyCursors = [null]; await refresh(); }
  async function page(kind, direction) {
    if (!active() || busy || reading || !data) return;
    const cursors = [...(kind === "snapshots" ? snapshotCursors : historyCursors)];
    if (direction === "previous" && cursors.length > 1) cursors.pop();
    else if (direction === "next" && data[kind].nextCursor) cursors.push(data[kind].nextCursor);
    else return;
    await refresh({ [kind]: cursors });
  }
  async function loadLog(id, target) {
    if (!active() || !data?.history.items.some(item => item.id === id) || logs.has(id)) return;
    // A failed state/import request leaves this rendered view valid and retryable.
    const version = viewGeneration; logs.set(id, true); const summary = target.firstElementChild;
    target.replaceChildren(summary, element(document, "p", "로그 불러오는 중…", "subtle"));
    try {
      const log = await api(scoped("/api/baselines/" + encodeURIComponent(id) + "/log"));
      if (!active() || version !== viewGeneration) return;
      if (log?.id !== id || typeof log.safeLog !== "string" || typeof log.logTruncated !== "boolean") throw new Error("INVALID_LOG");
      target.replaceChildren(summary, element(document, "pre", log.safeLog || "로그 없음", "log"));
      if (log.logTruncated) target.append(element(document, "p", "원본 로그가 표시 제한에 따라 생략되었습니다.", "subtle"));
    } catch (error) {
      if (closed || version !== viewGeneration) return;
      if (error.status === 401) { expire(); return; }
      logs.delete(id); target.replaceChildren(summary, element(document, "p", "로그를 불러오지 못했습니다. 닫았다가 다시 열어 재시도해 주세요.", "warning-text"));
    }
  }
  async function importFile(kind, file) {
    if (!file || !["source", "baseline"].includes(kind) || !active() || busy || reading || !csrf) return;
    if (kind === "baseline" && (!selectedId || selectedId !== data?.selected?.id)) return;
    const limit = kind === "source" ? 1_048_576 : 131_072;
    if (!Number.isSafeInteger(file.size) || file.size > limit || file.size < 0) { failure({ status: 413 }); return; }
    const version = ++generation; busy = true; controls(); notice("반입 처리 중… 완료 후 저장된 이력을 다시 확인합니다.");
    try {
      const receipt = await api(kind === "source" ? "/api/sources" : scoped("/api/baselines?snapshotId=" + encodeURIComponent(selectedId)), file);
      if (!active() || version !== generation) return;
      if (typeof receipt?.id !== "string" || !receipt.id || (kind === "baseline" && receipt.snapshotId !== selectedId)) throw new Error("INVALID_RECEIPT");
      if (kind === "source") { credentialsPanel.clear(); nativePanel.clear(); selectedId = receipt.id; selectedAppId = null; snapshotCursors = [null]; }
      historyCursors = [null];
      const ready = await refresh(); if (ready && !closed) notice("반입 완료 · 사용자 반입 이력에서 확인됨", false, false, true);
    } catch (error) { if (!closed && version === generation) failure(error, true); }
    finally { busy = false; node(kind === "source" ? "source-file" : "baseline-file").value = ""; if (!closed) controls(); }
  }
  async function chooseApplication(id) {
    if (!active()) return false;
    if (!id) return navigate("projects");
    if (!data?.applications?.some(app => app.id === id)) return false;
    if(currentRoute.page==="onboarding"){
      generation++; onboardingPanel.leave(); operations=null;operationsAppId=null;automation=null;automationAppId=null;selectedAppId=id;
      if(!await refresh())return false;await onboardingPanel.enter(id);return true;
    }
    return navigate(currentRoute.page === "ota-detail" ? "ota" : currentRoute.appId ? currentRoute.page : "overview", id);
  }
  async function applicationWrite(url, body, registration = false) {
    if (!active() || busy || reading || !csrf) return;
    const version = ++generation; busy = true; controls(); notice("앱 설정 저장 중…");
    try {
      const result = await api(url, JSON.stringify(body));
      if (!active() || version !== generation) return;
      if (typeof result?.id !== "string") throw new Error("INVALID_RECEIPT");
      if (registration) { credentialsPanel.clear(); nativePanel.clear(); operations = null; operationsAppId = null; automation = null; automationAppId = null; runnerToken = ""; runnerTokenAppId = null; automationRequestKey = null; deploymentRequestKey = null; clearOperations(document); node("application-registration").open = false; resetProjectRegistration(document); selectedAppId = result.id; selectedId = null; snapshotCursors = [null]; historyCursors = [null]; }
      await refresh();
      if (registration && active() && version + 1 === generation && data?.selectedApplication?.id === result.id) { document.getElementById("project-card-" + result.id)?.focus(); notice("프로젝트를 등록했습니다. GitHub 소스를 연결하세요."); return result; }
    } catch (error) { if (!closed && version === generation) { if (error.status === 409) notice("설정 버전이 변경되었거나 앱이 이미 등록되어 저장하지 못했습니다. 이력을 다시 불러온 뒤 확인해 주세요.", true, true); else failure(error); } }
    finally { busy = false; if (!closed) controls(); }
  }
  function automationWrite(work) { const epoch = routeEpoch; return operationWrite((id, current) => work(id, () => current() && epoch === routeEpoch), "automation-status"); }
  function automationControls() {
    const ready = !closed && !busy && !reading && Boolean(selectedAppId);
    for (const id of ["automation-refresh", "runner-enroll"]) { const input = document.getElementById(id); if (input) input.disabled = !ready || id === "runner-enroll" && runnerEnrollmentUnknown.has(selectedAppId); }
    const detection = operationsAppId === selectedAppId ? currentDetection(operations) : null;
    const runners = automationAppId === selectedAppId ? automation?.runners ?? [] : [];
    const enabled = ready && detection?.updatesEnabled && detection.configSource === "flora.config.json" && detection.automationConfig && runners.some(runner => runner.revokedAt === null && runner.appIds.includes(selectedAppId));
    const button = document.getElementById("automation-queue"); if (button) button.disabled = !enabled;
    const policy = document.getElementById("automation-policy-save"); if (policy) policy.disabled = !ready || (document.getElementById("automation-policy-enabled").checked && !enabled);
    const copy = document.getElementById("runner-token-copy"); if (copy) copy.disabled = !ready || !runnerToken || runnerTokenAppId !== selectedAppId;
  }
  function stopAutomationPoll() { env.clearTimeout(automationTimer); automationTimer = undefined; detailEpoch++; detailLoading.clear(); }
  function scheduleAutomationPoll() {
    env.clearTimeout(automationTimer); automationTimer = undefined;
    if (!active() || document.hidden || !(currentRoute.page === "runners" && document.getElementById("automation-editor").open || currentRoute.page === "onboarding" && wizardPolling) || automationAppId !== selectedAppId || !automation || (!automation.jobs.some(job => ["queued", "leased", "cancel_requested"].includes(job.state)) && (currentRoute.page === "onboarding" || !automation.runners.some(runner => runner.revokedAt === null)))) return;
    automationTimer = env.setTimeout(() => { env.clearTimeout(automationTimer); automationTimer = undefined; if (busy || reading) scheduleAutomationPoll(); else void loadAutomation(); }, automation.jobs.some(job => ["queued", "leased", "cancel_requested"].includes(job.state)) ? automationPollDelay : 30000);
  }
  function ciControls() {
    const scopedReady = !!active() && !busy && !reading && ciAppId === selectedAppId;
    const ready = scopedReady && ciKnown;
    const connection = operationsAppId === selectedAppId ? operations?.connection : null;
    const identity = ciIdentity ?? ciBinding;
    const matched = connection && identity && identity.connectionVersion === connection.version && identity.repository === connection.owner + "/" + connection.repository && identity.ref === "refs/heads/" + connection.ref;
    node("ci-save").disabled = !ready || ciConflict || !matched;
    const revokeReady = scopedReady && ciBinding?.appId === selectedAppId && ciBinding.enabled;
    node("ci-disable").disabled = !revokeReady || ciConflict;
    node("ci-copy").disabled = !ready || !matched || !node("ci-workflow-yaml").textContent;
  }
  function renderCI(binding, identity, hydrate) {
    const connection = operationsAppId === selectedAppId ? operations?.connection : null;
    if (identity && (!connection || identity.appId !== selectedAppId || identity.connectionVersion !== connection.version || identity.repository !== connection.owner + "/" + connection.repository || identity.ref !== "refs/heads/" + connection.ref || !validCITrust(identity, false))) throw new Error("INVALID_CI_IDENTITY");
    if (binding && (typeof binding.repository !== "string" || /[\x00-\x20\x7f]/.test(binding.repository) || binding.appId !== selectedAppId || !Number.isSafeInteger(binding.version) || binding.version < 1 || typeof binding.enabled !== "boolean" || !Number.isSafeInteger(binding.connectionVersion) || typeof binding.runnerId !== "string" || !/^[A-Za-z0-9_-]+$/.test(binding.runnerId) || !validCITrust(binding, true))) throw new Error("INVALID_CI_BINDING");
    const target = node("ci-summary"); target.replaceChildren();
    if (binding) target.append(pair(document, "GitHub 실행 권한", `${binding.enabled ? "허용됨" : "꺼짐"} · 버전 ${binding.version} · 실행 상태 미확인`), pair(document, "저장소", binding.repository), pair(document, "고정 Workflow", binding.jobWorkflowRef, true));
    else target.append(element(document, "p", "GitHub 실행 권한 미설정 · 저장소 정보를 확인한 뒤 명시적으로 저장하세요.", "subtle"));
    if (hydrate || identity) {
      const trust = identity ?? binding;
      for (const [id, key] of [["ci-repository-id","repositoryId"],["ci-owner-id","repositoryOwnerId"],["ci-ref","ref"]]) node(id).value = trust?.[key] ?? "";
      if (hydrate || !node("ci-workflow").value) node("ci-workflow").value = binding?.jobWorkflowRef ?? (env.location?.origin === "https://flora.uulab.co.kr" ? "uulab-official/flora/.github/workflows/flora-ota-runner.yml@32fdba841d0c613754138521a8bad13f88c80f5a" : "");
    }
    node("ci-workflow-yaml").replaceChildren(); node("ci-download").hidden = true; node("ci-download").removeAttribute("href");
    // Only saved, enabled trust generates a caller; a draft never implies admission.
    if (binding?.enabled && connection && binding.connectionVersion === connection.version && binding.repository === connection.owner + "/" + connection.repository && binding.ref === "refs/heads/" + connection.ref && /^[A-Za-z0-9_-]+$/.test(binding.appId) && !/[\x00-\x20\x7f]/.test(binding.appId)) {
      const yaml = `name: Flora OTA\non:\n  push:\n    branches: [${JSON.stringify(binding.ref.slice(11))}]\npermissions:\n  contents: read\n  id-token: write\njobs:\n  flora:\n    uses: ${binding.jobWorkflowRef}\n    with:\n      app-id: ${JSON.stringify(binding.appId)}\n`;
      node("ci-workflow-yaml").textContent = yaml; node("ci-download").href = "data:text/yaml;charset=utf-8," + encodeURIComponent(yaml); node("ci-download").hidden = false;
    }
  }
  async function loadCI(resolve = false, explicit = false) {
    const appId = selectedAppId, version = generation, epoch = ++ciEpoch;
    if (!active() || !appId) return false;
    const current = () => !!active() && selectedAppId === appId && generation === version && ciEpoch === epoch;
    node("ci-status").textContent = "GitHub 실행 권한을 확인하는 중…";
    try {
      if (operationsAppId !== appId) await loadOperations(); if (!current()) return false;
      const result = await api("/api/apps/" + encodeURIComponent(appId) + "/automation/ci" + (resolve ? "?resolve=1" : "")); if (!current()) return false;
      if (!result || !("binding" in result) || resolve && !result.identity) throw new Error("INVALID_CI");
      const hydrate = explicit || ciAppId !== appId || !ciConflict && ciBinding?.version !== result.binding?.version;
      renderCI(result.binding, result.identity, hydrate);
      ciBinding = result.binding; ciAppId = appId; ciKnown = true; if (result.identity) ciIdentity = result.identity;
      if (explicit || resolve) ciConflict = false;
      node("ci-status").textContent = "저장된 권한을 확인했습니다. 실행 결과는 자동 작업 이력에서 확인하세요."; ciControls(); return true;
    } catch (error) {
      if (!current()) return false; if (error.status === 401) expire(); else {
        ciKnown = false; ciIdentity = null;
        if (String(error.message).startsWith("INVALID_CI") || error.status && error.status < 500) ciBinding = null;
        if (error.status === 409) ciConflict = true;
        clearCIOutput(document); ciControls();
        node("ci-status").textContent = "GitHub 실행 권한을 확인하지 못했습니다. 자동 작업 이력은 별도로 확인할 수 있습니다." + (ciBinding?.enabled ? " 이전에 확인한 이 앱의 실행 권한 끄기는 사용할 수 있습니다." : "");
      } return false;
    }
  }
  async function saveCI(enabled = true) {
    const appId = selectedAppId, version = generation;
    if (!active() || busy || reading || ciAppId !== appId || enabled && !ciKnown || ciConflict || !enabled && (!ciBinding || ciBinding.appId !== appId)) return;
    const input = enabled ? {repositoryId:node("ci-repository-id").value,repositoryOwnerId:node("ci-owner-id").value,ref:node("ci-ref").value,jobWorkflowRef:node("ci-workflow").value,jobWorkflowSha:node("ci-workflow").value.split("@").at(-1)} : ciBinding;
    const connection = operationsAppId === appId ? operations?.connection : null;
    const identity = ciIdentity ?? ciBinding;
    if (!validCITrust(input, true) || enabled && (!identity || !connection || identity.repository !== connection.owner + "/" + connection.repository || identity.connectionVersion !== connection.version || input.repositoryId !== identity.repositoryId || input.repositoryOwnerId !== identity.repositoryOwnerId || input.ref !== "refs/heads/" + connection.ref)) { node("ci-status").textContent = "현재 앱의 GitHub 저장소 정보와 SHA 고정 Workflow를 확인하세요."; return; }
    ciEpoch++; busy = true; controls(); ciControls();
    try {
      const result = await api("/api/apps/" + encodeURIComponent(appId) + "/automation/ci", JSON.stringify({expectedVersion:ciBinding?.version ?? 0,enabled,repositoryId:input.repositoryId,repositoryOwnerId:input.repositoryOwnerId,ref:input.ref,jobWorkflowRef:input.jobWorkflowRef,jobWorkflowSha:input.jobWorkflowSha}));
      if (!active() || generation !== version || selectedAppId !== appId) return;
      if (!result?.binding || result.binding.enabled !== enabled || result.binding.version !== (ciBinding?.version ?? 0) + 1) throw new Error("INVALID_CI_RECEIPT");
      renderCI(result.binding, null, true); ciBinding = result.binding; ciIdentity = null; await loadAutomation(); if (!active() || generation !== version || selectedAppId !== appId) return; node("ci-status").textContent = enabled ? "GitHub 실행 권한을 저장했습니다. push 정책을 먼저 켜서 저장한 뒤 Workflow를 배포 branch에 commit·push하세요." : "이 앱의 GitHub 실행 권한을 껐습니다.";
    } catch (error) {
      if (!active() || generation !== version || selectedAppId !== appId) return;
      if (error.status === 401) expire(); else { if (error.status === 409) ciConflict = true; node("ci-status").textContent = error.status === 409 ? "연결 버전이 변경되었습니다. 입력은 보존했습니다. 저장된 연결 다시 확인 후 검토해 주세요." : "GitHub 실행 권한을 저장하지 못했습니다."; }
    } finally { busy = false; if (active()) { controls(); ciControls(); } }
  }
  async function copyCI() {
    const appId = selectedAppId, version = generation; if (!active() || ciAppId !== appId || !ciKnown || !ciBinding?.enabled || node("ci-copy").disabled || !node("ci-workflow-yaml").textContent) return;
    try { if (!env.navigator?.clipboard) throw new Error("NO_CLIPBOARD"); await env.navigator.clipboard.writeText(node("ci-workflow-yaml").textContent); if (active() && generation === version && selectedAppId === appId) node("ci-status").textContent = "공개 Workflow를 복사했습니다."; }
    catch { if (active() && generation === version && selectedAppId === appId) node("ci-status").textContent = "복사 기능을 사용할 수 없습니다. Workflow 다운로드를 사용하세요."; }
  }
  async function copyRunnerConfig() {
    const version = generation; const appId = selectedAppId; if (!active()) return;
    try { if (!env.navigator?.clipboard) throw new Error("CLIPBOARD_UNAVAILABLE"); await env.navigator.clipboard.writeText(document.getElementById("runner-config-template").textContent); }
    catch { if (generation === version && selectedAppId === appId && !(!active())) document.getElementById("automation-status").textContent = "복사 기능을 사용할 수 없습니다. 표시된 비밀 없는 템플릿을 직접 복사하세요."; }
  }
  async function loadAutomationJob(jobId) {
    const appId = selectedAppId; const version = generation; const epoch = detailEpoch;
    if (!active() || automationAppId !== appId || !automation?.jobs.some(job => job.id === jobId) || detailLoading.has(jobId)) return;
    const target = document.getElementById("automation-job-" + jobId); detailLoading.add(jobId); target.textContent = "작업별 이력을 확인하는 중…";
    const current = () => !(!active()) && generation === version && selectedAppId === appId && detailEpoch === epoch;
    try {
      const result = await api("/api/apps/" + encodeURIComponent(appId) + "/automation/jobs/" + encodeURIComponent(jobId)); if (!current()) return;
      if (result?.job?.appId !== appId || result.job.id !== jobId || !Array.isArray(result.attempts) || !Array.isArray(result.events) || result.attempts.some(item => item.jobId !== jobId) || result.events.some(item => item.jobId !== jobId)) throw new Error("INVALID_JOB_DETAIL");
      target.replaceChildren();
      const help = { EXPORT_FAILED: "고정 Node·패키지 관리자, lockfile, export 이미지와 오프라인 의존성 캐시를 확인하세요.", SOURCE_UNAVAILABLE: "GitHub App 설치 권한과 고정 커밋 접근을 확인하세요.", CONFIG_CHANGED: "체크인한 flora.config.json을 다시 동기화하고 새 작업을 요청하세요.", ARTIFACT_INVALID: "export 자산 경로·크기·해시와 플랫폼 번들을 확인하세요.", LEASE_EXPIRED: "Runner 프로세스와 heartbeat 연결을 확인하세요. 만료된 시도는 게시할 수 없습니다.", RUNNER_REVOKED: "폐기된 토큰을 재사용하지 말고 새 Runner 권한을 등록하세요.", CANCELLED: "취소된 작업입니다. 다시 게시하려면 새 작업을 요청하세요.", PUBLICATION_REJECTED: "앱·runtime·channel 설정과 더 최근 작업의 게시 이력을 확인하세요." };
      if (result.job.code) target.append(element(document, "p", help[result.job.code] ?? "작업 결과 코드를 확인하세요.", "subtle"));
      for (const attempt of result.attempts) target.append(element(document, "p", `시도 ${attempt.id} · ${attempt.outcome ? automationEventLabel(attempt.outcome) : "진행 중"} · ${date(attempt.claimedAt)}${attempt.code ? " · " + attempt.code : ""}`, "record-note"));
      for (const event of result.events) target.append(element(document, "p", `${date(event.createdAt)} · ${automationEventLabel(event.kind)}${event.code ? " · " + event.code : ""}`, "record-note"));
      if (!result.attempts.length && !result.events.length) target.append(element(document, "p", "등록된 시도·상태 변경 없음", "subtle"));
    } catch (error) { if (current()) { if (error.status === 401) expire(); else target.textContent = "작업별 이력을 확인하지 못했습니다. 닫았다가 다시 열어 확인하세요."; } }
    finally { if (detailEpoch === epoch) detailLoading.delete(jobId); }
  }
  async function loadAutomation(signal) {
    const appId = selectedAppId; const version = generation; const loadKey = appId + ":" + version; if (!appId || !active() || automationLoading === loadKey) return false;
    automationLoading = loadKey;
    const current = () => !!active() && version === generation && selectedAppId === appId;
    document.getElementById("automation-status").textContent = "Runner와 자동 작업을 확인하는 중…";
    try {
      if (operationsAppId !== appId) await loadOperations(signal); if (!current()) return false;
      const result = await api("/api/apps/" + encodeURIComponent(appId) + "/automation",undefined,csrf,false,signal); if (!current()) return false;
      renderAutomation(document, appId, result, operationsAppId === appId ? currentDetection(operations) : null, env.location?.origin, operationsAppId === appId ? operations : null);
      if (result.policy && (automationAppId !== appId || automation?.policy?.version !== result.policy.version)) {
        document.getElementById("automation-channel").value = result.policy.channel;
        document.getElementById("automation-platform").value = policyPlatforms(result.policy)[0];
        document.getElementById("automation-policy-platforms").value = policyPlatformValue(policyPlatforms(result.policy));
      }
      automation = result; automationAppId = appId; automationPollDelay = 5000; automationControls();renderRunnerBinding();if(currentRoute.page === "onboarding")void onboardingPanel.update();
      document.getElementById("automation-status").textContent = "Runner와 자동 작업 이력을 확인했습니다."; if (currentRoute.page !== "onboarding" && ciAppId !== appId) void loadCI(); return true;
    } catch (error) {
      if (!current()) return false;
      if (error.status === 401) { expire(); return false; }
      renderReadiness(document, appId, operationsAppId === appId ? currentDetection(operations) : null, automationAppId === appId ? automation : null, operationsAppId === appId ? operations : null, "error");
      automationPollDelay = 10000; document.getElementById("automation-status").textContent = "자동 작업 이력을 확인하지 못했습니다. 다시 확인해 주세요."; return false;
    } finally { if (automationLoading === loadKey) { automationLoading = null; scheduleAutomationPoll(); } }
  }
  async function queueAutomation() {
    const appId = selectedAppId; const detection = operationsAppId === appId ? currentDetection(operations) : null;
    if (!active() || busy || reading || !detection?.updatesEnabled || detection.configSource !== "flora.config.json" || !detection.automationConfig || automationAppId !== appId || !automation?.runners.some(runner => runner.revokedAt === null && runner.appIds.includes(appId))) return;
    const channel = document.getElementById("automation-channel").value; const platform = document.getElementById("automation-platform").value;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(channel) || !detection.automationConfig.platforms.includes(platform)) { document.getElementById("automation-status").textContent = "고정 설정에 맞는 channel과 플랫폼을 선택하세요."; return; }
    if (!automationRequestKey) automationRequestKey = "job_" + globalThis.crypto.randomUUID();
    const input = { requestKey: automationRequestKey, detectionId: detection.id, channel, platform, runtimeVersion: detection.automationConfig.runtimeVersion, config: detection.automationConfig };
    return automationWrite(async (id, current) => { const result = await api("/api/apps/" + encodeURIComponent(id) + "/automation/jobs", JSON.stringify(input)); if (!current()) return; if (result?.appId !== id || typeof result.id !== "string") throw new Error("INVALID_JOB"); automationRequestKey = null; await loadAutomation(); return "작업 요청 접수 · " + ({ queued: "Runner 대기", leased: "Runner 할당됨 · 결과 대기", succeeded: "산출물 게시 완료", failed: "실패", cancelled: "취소됨", cancel_requested: "취소 처리 중" }[result.state] ?? "상태 미확인"); });
  }
  async function saveAutomationPolicy() {
    if (!active() || busy || reading || automationAppId !== selectedAppId || !automation) return;
    const enabled = document.getElementById("automation-policy-enabled").checked;
    const detection = operationsAppId === selectedAppId ? currentDetection(operations) : null;
    if (enabled && (!detection?.updatesEnabled || detection.configSource !== "flora.config.json" || !detection.automationConfig || !automation.runners.some(runner => runner.revokedAt === null && runner.appIds.includes(selectedAppId)))) return;
    const channel = document.getElementById("automation-channel").value; const platforms = selectedPolicyPlatforms(document);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(channel) || !platforms.length || platforms.some(platform => !detection?.automationConfig?.platforms.includes(platform))) { document.getElementById("automation-status").textContent = "앱 설정에 맞는 channel과 자동 배포 플랫폼을 선택하세요."; return; }
    const input = { expectedVersion: automation.policy?.version ?? 0, enabled, channel, platforms };
    return automationWrite(async (id, current) => { const result = await api("/api/apps/" + encodeURIComponent(id) + "/automation/policy", JSON.stringify(input)); if (!current()) return; if (result?.appId !== id) throw new Error("INVALID_POLICY"); await loadAutomation(); });
  }
  async function cancelAutomation(jobId) {
    if (automationAppId !== selectedAppId || !automation?.jobs.some(job => job.id === jobId && ["queued", "leased"].includes(job.state))) return;
    return automationWrite(async (id, current) => { await api("/api/apps/" + encodeURIComponent(id) + "/automation/jobs/" + encodeURIComponent(jobId) + "/cancel", "{}"); if (current()) await loadAutomation(); });
  }
  async function enrollRunner() {
    const name = document.getElementById("runner-name").value.trim(); if (!name || runnerEnrollmentUnknown.has(selectedAppId)) return;
    return automationWrite(async (id, current) => {
      runnerEnrollmentUnknown.add(id);
      let result;
      try{result = await api("/api/runners", JSON.stringify({ name, appIds: [id] }));}
      catch(error){if(error.status===401)throw error;if(current()){await loadAutomation();return "Runner 등록 결과 확인 필요 · 목록에서 새 Runner를 확인하세요. 토큰을 잃었다면 정확한 Runner만 폐기한 뒤 다시 등록하세요.";}return;}
      if (!current()) return;
      if (!Array.isArray(result?.runner?.appIds) || result.runner.appIds.length !== 1 || result.runner.appIds[0] !== id || typeof result.token !== "string" || !result.token) throw new Error("INVALID_RUNNER");
      runnerToken = result.token; runnerTokenAppId = id; runnerReceiptId=result.runner.id;runnerEnrollmentUnknown.delete(id);
      document.getElementById("runner-token").textContent = runnerToken; document.getElementById("runner-token-panel").hidden = false; await loadAutomation();
    });
  }
  function renderRunnerBinding(){
    const link=node("runner-binding-download");if(!link)return;link.hidden=true;link.removeAttribute("href");
    if(!runnerToken||runnerTokenAppId!==selectedAppId||automationAppId!==selectedAppId||!runnerToken.startsWith(runnerReceiptId+"."))return;
    const runner=automation?.runners.find(r=>r.id===runnerReceiptId);if(!runner)return;
    try{const binding=buildRunnerBinding(env.location?.origin,selectedAppId,runner);link.setAttribute("href","data:application/json;charset=utf-8,"+encodeURIComponent(JSON.stringify(binding,null,2)+"\n"));link.setAttribute("download","flora.runner-binding.json");link.hidden=false;}catch{}
  }
  async function revokeRunner(runnerId) {
    if (automationAppId !== selectedAppId || !automation?.runners.some(runner => runner.id === runnerId && runner.revokedAt === null)) return;
    return automationWrite(async (id, current) => { await api("/api/runners/" + encodeURIComponent(runnerId) + "/revoke", "{}"); if (!current()) return; runnerEnrollmentUnknown.delete(id);runnerToken = ""; runnerTokenAppId = null; document.getElementById("runner-token").replaceChildren(); document.getElementById("runner-token-panel").hidden = true; await loadAutomation(); });
  }
  function hideRunnerToken() { runnerReceiptId=null;node("runner-binding-download")?.removeAttribute("href");if(node("runner-binding-download"))node("runner-binding-download").hidden=true;runnerToken = ""; runnerTokenAppId = null; document.getElementById("runner-token").replaceChildren(); document.getElementById("runner-token-panel").hidden = true; automationControls(); }
  async function copyRunnerToken() {
    if (!active() || !runnerToken || runnerTokenAppId !== selectedAppId) return;
    const version = generation;
    try { await env.navigator?.clipboard?.writeText(runnerToken); if (version === generation && !!active()) document.getElementById("automation-status").textContent = env.navigator?.clipboard ? "Runner 토큰을 복사했습니다." : "브라우저에서 복사 기능을 사용할 수 없습니다. 표시된 토큰을 직접 복사하세요."; }
    catch { if (version === generation && !!active()) document.getElementById("automation-status").textContent = "복사하지 못했습니다. 표시된 토큰을 직접 복사하세요."; }
  }
  function operationControls() {
    automationControls();
    const ready = !closed && !busy && !reading && Boolean(selectedAppId);
    for (const id of ["github-connect", "github-sync", "operations-refresh"]) { const input = document.getElementById(id); if (input) input.disabled = !ready; }
    const detection = operationsAppId === selectedAppId ? currentDetection(operations) : null;
    const publish = ready && ["flora", "expo", "react-native"].includes(detection?.framework) && detection.updatesEnabled && detection.runtimeVersion && detection.configSource !== "dynamic-required";
    const button = document.getElementById("ota-deploy"); if (button) button.disabled = !publish;
  }
  async function operationWrite(work, statusTarget = "operations-status") {
    if (!active() || busy || reading || !selectedAppId) return;
    const appId = selectedAppId; const version = generation; const current = () => !!active() && generation === version && selectedAppId === appId;
    busy = true; controls(); notice("GitHub / OTA 작업 처리 중…");
    try { const outcome = await work(appId, current); if (current() && await loadOperations()) { document.getElementById(statusTarget).textContent = outcome || (statusTarget === "automation-status" ? "요청 완료 · Runner와 자동 작업 이력을 다시 확인했습니다." : "요청 완료 · 앱별 연결과 배포 이력을 다시 확인했습니다."); } }
    catch (error) { if (current()) { if (error.status === 401) { expire(); return; } if (githubSourceError(error.code)) { await loadOperations(); if (!current()) return; } document.getElementById(statusTarget).textContent = githubSourceError(error.code) ?? (error.status === 409 ? "연결 버전이나 배포 조건이 변경되어 완료하지 못했습니다. 이력을 다시 확인해 주세요." : "GitHub / OTA 작업을 완료하지 못했습니다. 연결 권한, 앱 설정과 export 파일을 확인해 주세요."); } }
    finally { busy = false; if (current()) notice(); controls(); }
  }
  async function connectGitHub() {
    if (operationsAppId !== selectedAppId) { await loadOperations(); if (operationsAppId !== selectedAppId) return; }
    const input = { expectedVersion: operations?.connection?.version ?? 0, installationId: Number(document.getElementById("github-installation").value), owner: document.getElementById("github-owner").value, repository: document.getElementById("github-repository").value, ref: document.getElementById("github-ref").value };
    if (!Number.isSafeInteger(input.installationId) || input.installationId <= 0 || !input.owner || !input.repository || !input.ref) { document.getElementById("operations-status").textContent = "GitHub 설치 ID, 소유자, 저장소와 ref를 확인해 주세요."; return; }
    return operationWrite(async (appId, current) => { const file = document.getElementById("github-resolved-config").files?.[0]; if (file) { if (file.size > 1024 * 1024) throw new Error("INVALID_CONFIG"); const config = JSON.parse(await file.text()); const commitSha = operationsAppId === appId ? currentDetection(operations)?.commitSha : null; if (!commitSha) throw new Error("SOURCE_REQUIRED"); if (config?.commitSha !== undefined && (config.commitSha !== commitSha || !config.config)) throw new Error("SOURCE_MISMATCH"); input.resolvedConfig = config?.commitSha !== undefined ? config : { commitSha, config }; } if (!current()) return; await api("/api/apps/" + encodeURIComponent(appId) + "/github", JSON.stringify(input)); });
  }
  async function syncGitHub() { return operationWrite(async (appId, current) => { const input = {}; const file = document.getElementById("github-resolved-config").files?.[0]; if (file) { if (file.size > 1024 * 1024) throw new Error("INVALID_CONFIG"); const config = JSON.parse(await file.text()); const commitSha = operationsAppId === appId ? currentDetection(operations)?.commitSha : null; if (!commitSha) throw new Error("SOURCE_REQUIRED"); if (config?.commitSha !== undefined && (config.commitSha !== commitSha || !config.config)) throw new Error("SOURCE_MISMATCH"); input.resolvedConfig = config?.commitSha !== undefined ? config : { commitSha, config }; } if (!current()) return; await api("/api/apps/" + encodeURIComponent(appId) + "/github/sync", JSON.stringify(input)); }); }
  async function deployOTA() {
    const detection = operationsAppId === selectedAppId ? currentDetection(operations) : null;
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
      await api("/api/apps/" + encodeURIComponent(appId) + "/ota/deployments", JSON.stringify({ requestKey, detectionId: detection.id, commitSha: detection.commitSha, runtimeVersion: detection.runtimeVersion, channel, platform, launchAssetId, assetIds }));
      if (current()) deploymentRequestKey = null;
    });
  }
  const summaryInterval = 60000;
  const visibleSummaryPage = () => ["projects", "overview"].includes(currentRoute.page) && !document.hidden && document.visibilityState !== "hidden";
  function stopProjectsPoll() { env.clearTimeout(projectTimer); projectTimer = undefined; }
  function scheduleProjectsPoll() {
    stopProjectsPoll();
    if (!active() || !csrf || !data || !visibleSummaryPage() || projectRequest) return;
    projectTimer = env.setTimeout(() => { projectTimer = undefined; paintProjects(); void loadProjects(); }, Math.max(1000, summaryInterval - (now() - projectLastAttempt)));
  }
  function validSummaryMetadata(result) {
    const time = value => value === null || Number.isSafeInteger(value) && value >= 0;
    if (result.usage !== undefined) {
      const usage = result.usage;
      if (!usage || !["ready", "stale", "unconfigured", "error", "pending"].includes(usage.status) || usage.source !== "cloudflare-graphql" || usage.scope !== "account" || !(usage.day === null || typeof usage.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(usage.day)) || ![usage.rowsRead, usage.rowsWritten, usage.resetAt, usage.observedAt, usage.freshUntil].every(time) || usage.readLimit !== 5000000 || usage.writeLimit !== 100000 || usage.freshUntil !== null && usage.observedAt !== null && usage.freshUntil < usage.observedAt) return false;
    }
    return result.projects.every(app => ["ios", "android"].every(os => {
      const telemetry = app.ota[os]?.telemetry;
      if (telemetry !== undefined && telemetry !== null && !isValidSdkTelemetry(telemetry, os)) return false;
      const value = app.ota[os]?.verification;
      return value === undefined || value === null || value && value.source === "operator-verification" && ["android-emulator", "ios-simulator", "physical-device"].includes(value.environment) && !(os === "ios" && value.environment === "android-emulator" || os === "android" && value.environment === "ios-simulator") && Number.isSafeInteger(value.observedAt) && value.observedAt >= 0 && /^[a-f0-9]{64}$/.test(value.receiptDigest) && ["applied", "restarted", "signatureVerified", "assetsVerified"].every(key => typeof value[key] === "boolean") && (value.appId === undefined || value.appId === app.id) && (value.deploymentId === undefined || value.deploymentId === app.ota[os].id);
    }));
  }
  function projectView() { return { ...data, projectSummary, projectStatus, projectNow: now() }; }
  function paintProjects() {
    if (!active()) return;
    if (currentRoute.page === "projects") { if (data) renderProjectCards(document, projectView()); renderWorkspaceStatus(document, projectSummary, { status: projectStatus, now: now(), observedAt: projectSummary?.observedAt }); }
    if (currentRoute.page === "overview" && data?.selectedApplication?.id === currentRoute.appId) renderOperationalOverview(document, data.selectedApplication, { summary: projectSummary?.projects.find(app => app.id === currentRoute.appId) ?? null, status: projectStatus, now: now(), observedAt: projectSummary?.observedAt });
    const status = node("project-summary-status"), button = node("project-summary-refresh");
    if (status) status.textContent = projectStatus === "error" ? projectSummary ? "운영 정보를 다시 확인하지 못했습니다. 이전 확인 정보를 표시합니다." : "운영 정보를 불러오지 못했습니다. OTA·Runner 상태는 미확인입니다." : projectStatus === "loading" ? "저장소·OTA·Runner 상태 확인 중…" : "마지막 상태 확인 · " + date(projectSummary?.observedAt);
    if (button) button.disabled = closed || !csrf || projectLoading || !data;
  }
  async function loadProjects() {
    if (!active() || !csrf || !visibleSummaryPage() || !data) return false;
    if (projectRequest) return projectRequest;
    if (now() - projectLastAttempt < summaryInterval) { paintProjects(); scheduleProjectsPoll(); return Boolean(projectSummary); }
    const epoch = ++projectEpoch, route = routeEpoch, app = currentRoute.appId;
    const current = () => active() && epoch === projectEpoch && route === routeEpoch && currentRoute.appId === app && visibleSummaryPage();
    projectLastAttempt = now(); projectLoading = true; projectStatus = "loading"; paintProjects();
    const request = (async () => {
      try {
        const result = await api("/api/projects"); if (!current()) return false;
        const valid = result && Array.isArray(result.projects) && result.projects.length <= 100 && Number.isSafeInteger(result.observedAt) && result.observedAt >= 0 && new Set(result.projects.map(app => app?.id)).size === result.projects.length && result.projects.every(app => app && /^[a-z][a-z0-9_-]{2,95}$/.test(app.id) && typeof app.name === "string" && typeof app.repositoryId === "string" && typeof app.rootDirectory === "string" && app.ota && app.runner && ["unregistered", "unseen", "online", "offline", "revoked"].includes(app.runner.status) && ["ios", "android"].every(os => app.ota[os] === null || app.ota[os] && typeof app.ota[os].id === "string" && typeof app.ota[os].channel === "string" && typeof app.ota[os].runtimeVersion === "string" && /^[a-f0-9]{40}$/.test(app.ota[os].commitSha) && Number.isSafeInteger(app.ota[os].createdAt))) && validSummaryMetadata(result);
        if (!valid) throw new Error("INVALID_PROJECTS");
        projectSummary = result; projectStatus = "ready"; return true;
      } catch (error) {
        if (error.status === 401 && active()) { expire(); return false; }
        if (!current()) return false;
        projectStatus = "error"; return false;
      } finally { if (current()) { projectLoading = false; paintProjects(); } }
    })();
    projectRequest = request;
    try { return await request; } finally { if (projectRequest === request) { projectRequest = null; projectLoading = false; scheduleProjectsPoll(); } }
  }
  async function loadProjectOverview() {
    const appId = selectedAppId; const version = generation; const epoch = ++overviewEpoch, route = routeEpoch;
    const current = () => !!active() && selectedAppId === appId && generation === version && overviewEpoch === epoch && routeEpoch === route;
    if (!appId || !current()) return;
    if (currentRoute.page === "overview") { await loadProjects(); if (current()) paintProjects(); return; }
    if (await loadOperations() && current()) await loadAutomation();
  }
  async function loadOperations(signal) {
    const appId = selectedAppId; const version = generation;
    if (!appId || !active()) return;
    document.getElementById("operations-status").textContent = "GitHub 연결과 OTA 이력을 확인하는 중…";
    try {
      const received = await api("/api/apps/" + encodeURIComponent(appId) + "/operations",undefined,csrf,false,signal);
      const result = {...received, expectedRootDirectory: data?.selectedApplication?.rootDirectory};
      if (!active() || version !== generation || selectedAppId !== appId) return;
      renderOperations(document, appId, result); if (currentDetection(operations)?.id !== currentDetection(result)?.id) automationRequestKey = null; operations = result; operationsAppId = appId;
      if (currentRoute.page === "builds" && buildPanel.state().appId === appId) {
        buildPanel.setOTAView(appId, result);
        buildPanel.setGithubSource(appId, result.connection, currentDetection(result)?.commitSha);
      }
      if (ciAppId === appId) {
        const connection = result.connection;
        const matched = trust => connection && trust && trust.connectionVersion === connection.version && trust.repository === connection.owner + "/" + connection.repository && trust.ref === "refs/heads/" + connection.ref;
        if (ciIdentity && !matched(ciIdentity)) ciIdentity = null;
        if (ciBinding && !matched(ciBinding)) {
          renderCI(ciBinding, null, false);
          node("ci-status").textContent = "GitHub 연결이 변경되었습니다. 저장소 정보를 다시 확인하고 실행 권한을 저장하세요. 이전 권한 끄기는 계속 사용할 수 있습니다.";
        }
        ciControls();
      }
      if (automationAppId === appId) renderAutomation(document, appId, automation, currentDetection(result), env.location?.origin, result);
      operationControls();
      document.getElementById("operations-status").textContent = "연결과 배포 이력을 확인했습니다."; return true;
    } catch (error) {
      if (!active() || version !== generation || selectedAppId !== appId) return;
      if (error.status === 401) { expire(); return; }
      renderReadiness(document, appId, operationsAppId === appId ? currentDetection(operations) : null, automationAppId === appId ? automation : null, operationsAppId === appId ? operations : null, "error");
      document.getElementById("operations-status").textContent = "연결과 배포 이력을 확인하지 못했습니다. 다시 확인해 주세요.";
    }
  }
  function githubCurrent(epoch) { return active() && epoch === githubEpoch; }
  function githubError(error) { if (error?.status === 401) expire(); else node("github-managed-status").textContent = "GitHub 연결을 확인하지 못했습니다. 연결 앱과 저장소 접근 권한을 확인한 뒤 다시 시도하세요."; }
  function githubURL(value, installation = false) {
    const url = new URL(value); if (url.origin !== "https://github.com" || url.username || url.password || url.hash) throw new Error("INVALID_GITHUB_URL");
    if (installation && !/^\/apps\/[a-z0-9-]+\/installations\/new$/.test(url.pathname)) throw new Error("INVALID_GITHUB_URL");
    return url;
  }
  async function loadGitHubConnection() {
    if (!active() || !csrf) return;
    const preferredInstallation = node("github-installation-select").value;
    const epoch = ++githubEpoch; githubSelection = null; githubInstallations = []; githubRepositories = []; githubCursor = null; githubRepositoryPages = 0;
    node("github-access-settings").hidden = true; node("github-access-settings").removeAttribute("href");
    node("github-managed-status").textContent = "GitHub 연결 확인 중…";
    try {
      const connection = await api("/api/github/connection"); if (!githubCurrent(epoch)) return;
      if (typeof connection?.configured !== "boolean") throw new Error("INVALID_CONNECTION");
      if (githubExchangeUnknown && !connection.configured) {node("github-manifest-form").hidden=true;node("github-manifest-start").disabled=true;node("github-managed-status").textContent="GitHub 연결 완료 여부 확인 필요 · 기존 App 설정을 확인하세요. 변환 코드는 재전송하지 않습니다.";return;}
      node("github-manifest-form").hidden = connection.configured; node("github-install-link").hidden = true; node("github-repository-picker").hidden = true;
      if (!connection.configured) { node("github-managed-status").textContent = "GitHub 연결 앱을 먼저 생성하세요. 인증 키는 Flora 서버가 관리합니다."; return; }
      if (connection.installationUrl) { const url = githubURL(connection.installationUrl, true); node("github-install-link").setAttribute("href", url.href); node("github-install-link").hidden = false; }
      const result = await api("/api/github/installations"); if (!githubCurrent(epoch)) return;
      if (!Array.isArray(result?.items)) throw new Error("INVALID_INSTALLATIONS");
      githubInstallations = result.items.filter(item => Number.isSafeInteger(item.id) && item.id > 0 && typeof item.account === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(item.account) && ["selected", "all"].includes(item.repositorySelection) && !item.suspended);
      select(document, "github-installation-select", githubInstallations.map(item => [String(item.id), item.account ?? String(item.id)]), githubInstallations.some(item => String(item.id) === preferredInstallation) ? preferredInstallation : String(githubInstallations[0]?.id ?? ""));
      node("github-repository-picker").hidden = !githubInstallations.length;
      node("github-managed-status").textContent = githubInstallations.length ? "GitHub에서 허용한 저장소를 선택하세요." : "연결 앱이 준비되었습니다. 저장소 접근을 허용한 뒤 연결을 다시 확인하세요.";
      if (githubInstallations.length) await loadGitHubRepositories();
    } catch (error) { if (githubCurrent(epoch)) githubError(error); }
  }
  function renderGitHubRepositories() {
    const installation = githubInstallations.find(item => item.id === Number(node("github-installation-select").value));
    const settings = node("github-access-settings"); settings.hidden = true; settings.removeAttribute("href");
    if (installation && ["Organization", "User"].includes(installation.accountType)) {
      const path = installation.accountType === "Organization" ? `/organizations/${installation.account}/settings/installations/${installation.id}` : `/settings/installations/${installation.id}`;
      settings.setAttribute("href", "https://github.com" + path); settings.hidden = false;
    }
    node("github-repository-scope").textContent = installation ? `${installation.account} · ${installation.repositorySelection === "all" ? "전체 저장소 접근 허용" : "선택한 저장소만 접근 허용"}` : "연결된 계정을 선택하세요.";
    const search = node("github-repository-search").value.trim().toLowerCase();
    const matches = githubRepositories.filter(item => (item.owner + "/" + item.repository).toLowerCase().includes(search));
    const previous = node("github-repository-select").value;
    select(document, "github-repository-select", matches.map(item => [String(item.id), item.owner + "/" + item.repository]), matches.some(item => String(item.id) === previous) ? previous : String(matches[0]?.id ?? ""));
    node("github-repository-use").disabled = !matches.length;
    node("github-repository-count").textContent = `허용된 저장소 ${githubRepositories.length}개 불러옴 · 검색 결과 ${matches.length}개${githubCursor ? " · 아직 불러오지 않은 저장소 있음" : ""}`;
    node("github-repositories-more").hidden = !githubCursor || githubRepositoryPages >= 10;
    node("github-managed-status").textContent = githubRepositoryPages >= 10 && githubCursor ? "10페이지 (최대 1,000개) 조회 한도에 도달했습니다. 아직 불러오지 않은 저장소는 검색에 포함되지 않습니다." : matches.length ? "저장소를 선택하고 프로젝트 이름과 앱 폴더를 입력하세요." : search ? "검색 결과가 없습니다. 허용된 저장소 이름을 확인하거나 접근 설정 후 새로 불러오세요." : "접근 가능한 저장소가 없습니다. 저장소 접근 설정에서 권한을 확인하세요.";
  }
  async function loadGitHubRepositories(next = false) {
    const id = Number(node("github-installation-select").value); if (!active() || !githubInstallations.some(item => item.id === id) || (next && (!githubCursor || githubRepositoryPages >= 10))) return;
    const epoch = ++githubEpoch; githubSelection = null;
    let cursor = next ? githubCursor : null;
    if (!next) { githubRepositories = []; githubCursor = null; githubRepositoryPages = 0; }
    renderGitHubRepositories(); node("github-repository-use").disabled = true;
    node("github-managed-status").textContent = "GitHub App에 허용된 저장소를 불러오는 중…";
    const seen = new Set();
    try {
      do {
        if (cursor && (!/^[1-9][0-9]{0,3}$/.test(cursor) || Number(cursor) > 1000 || seen.has(cursor))) throw new Error("INVALID_CURSOR");
        seen.add(cursor);
        const result = await api("/api/github/repositories?installationId=" + encodeURIComponent(id) + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
        if (!githubCurrent(epoch) || Number(node("github-installation-select").value) !== id) return;
        if (result?.installationId !== id || !Array.isArray(result.items) || result.items.length > 100 || result.items.some(item => !Number.isSafeInteger(item.id) || item.id <= 0 || typeof item.owner !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(item.owner) || typeof item.repository !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(item.repository)) || (result.nextCursor !== null && typeof result.nextCursor !== "string")) throw new Error("INVALID_REPOSITORIES");
        const repositories = new Map(githubRepositories.map(item => [item.id, item])); for (const item of result.items) repositories.set(item.id, item);
        githubRepositories = [...repositories.values()]; githubRepositoryPages++; githubCursor = result.nextCursor; cursor = githubCursor;
      } while (cursor && githubRepositoryPages < 10);
      renderGitHubRepositories();
    } catch (error) { if (githubCurrent(epoch)) { renderGitHubRepositories(); githubError(error); } }
  }
  function useGitHubRepository() {
    const item = githubRepositories.find(repo => String(repo.id) === node("github-repository-select").value);
    const installationId = Number(node("github-installation-select").value);
    if (!active() || !item || !githubInstallations.some(value => value.id === installationId)) return;
    const fullName = item.owner + "/" + item.repository; const [owner, repository] = String(fullName).split("/");
    if (!owner || !repository || String(fullName).split("/").length !== 2) return;
    githubSelection = { installationId, owner, repository, ref: item.defaultBranch ?? item.default_branch ?? "main", repositoryId: fullName };
    node("application-repository").value = fullName; if (!node("application-name").value) node("application-name").value = repository;
    node("github-managed-status").textContent = fullName + " · 프로젝트 등록 시 GitHub 소스도 연결합니다.";
  }
  async function startGitHubManifest() {
    if (githubExchangeUnknown || !active() || !csrf || busy || reading) return;
    const epoch = ++githubEpoch;
    try {
      const result = await api("/api/github/manifest/start", JSON.stringify({ organization: node("github-organization").value.trim() || undefined })); if (!githubCurrent(epoch)) return;
      const url = githubURL(result.action);
      if (!/^\/(?:settings\/apps\/new|organizations\/[a-zA-Z0-9-]{1,39}\/settings\/apps\/new)$/.test(url.pathname) || !url.searchParams.get("state") || !result.manifest || typeof result.manifest !== "object") throw new Error("INVALID_MANIFEST");
      const form = document.createElement("form"); form.method = "POST"; form.action = url.href; form.hidden = true;
      const input = document.createElement("input"); input.type = "hidden"; input.name = "manifest"; input.value = JSON.stringify(result.manifest); form.append(input); document.body.append(form); form.submit(); form.remove();
    } catch (error) { if (githubCurrent(epoch)) githubError(error); }
  }
  async function completeGitHubManifest(callback) {
    if (!active() || !csrf || !callback || !/^[a-zA-Z0-9_-]{1,256}$/.test(callback.code ?? "") || !/^[a-zA-Z0-9_-]{16,256}$/.test(callback.state ?? "")) { if (callback) node("github-managed-status").textContent = "GitHub 연결 응답이 올바르지 않습니다. 연결을 다시 시작하세요."; return; }
    const epoch = ++githubEpoch;
    const destination=()=>{let hint=null;try{hint=env.sessionStorage?.getItem("flora:onboarding-origin");env.sessionStorage?.removeItem("flora:onboarding-origin");}catch{}return hint==="onboarding"?"onboarding":"register";};
    try { await api("/api/github/manifest/complete", JSON.stringify(callback)); if (!githubCurrent(epoch)) return; await navigate(destination()); }
    catch (error) {
      if(!githubCurrent(epoch))return;githubExchangeUnknown=true;
      try{const current=await api("/api/github/connection");if(!githubCurrent(epoch))return;if(current?.configured===true){githubExchangeUnknown=false;await navigate(destination());return;}}catch{}
      if(githubCurrent(epoch)){node("github-manifest-form").hidden=true;node("github-manifest-start").disabled=true;node("github-managed-status").textContent="GitHub 연결 완료 여부 확인 필요 · 설정을 다시 확인하세요. 변환 코드는 재전송하거나 새 App을 만들지 않습니다.";}
    }
  }
  async function prepareSigningKey() {
    const appId = selectedAppId; const version = generation; if (!appId || !active() || !csrf || busy || reading) return;
    node("signing-key-status").textContent = "서버에서 앱별 OTA 서명을 준비하는 중…";
    try {
      const result = await api("/api/apps/" + encodeURIComponent(appId) + "/signing-key", "{}"); if (!active() || version !== generation || selectedAppId !== appId) return;
      const certificate = result.certificate ?? result.certificatePem;
      if (result.appId !== appId || !/^[A-Za-z0-9._-]{1,128}$/.test(result.keyId ?? "") || typeof certificate !== "string" || certificate.length > 65536 || !certificate.startsWith("-----BEGIN CERTIFICATE-----")) throw new Error("INVALID_CERTIFICATE");
      node("signing-certificate-download").setAttribute("href", "data:application/x-pem-file;charset=utf-8," + encodeURIComponent(certificate)); node("signing-certificate-download").setAttribute("download", "flora-" + appId + ".pem"); node("signing-certificate-download").hidden = false;
      node("signing-key-status").textContent = "OTA 서명이 준비되었습니다. SDK에 공개 인증서를 포함한 최초 앱 빌드를 PC 또는 자체 Runner에서 실행하세요.";
    } catch (error) { if (!active() || version !== generation || selectedAppId !== appId) return; if (error.status === 401) expire(); else node("signing-key-status").textContent = "OTA 서명을 준비하지 못했습니다. 서버의 서명 저장소 설정을 확인하세요."; }
  }
  async function registerApplication() {
    const existing=data?.applications?.find(app=>app.repositoryId===node("application-repository").value && (app.rootDirectory??".")===node("application-root").value);
    if(existing){await navigate("source",existing.id);notice("이미 등록된 저장소·앱 경로입니다. 기존 프로젝트로 이어갑니다.");return;}
    const selection = githubSelection && githubSelection.repositoryId === node("application-repository").value ? { ...githubSelection } : null;
    const registered = await applicationWrite("/api/apps", { name: node("application-name").value, repositoryId: node("application-repository").value, rootDirectory: node("application-root").value }, true);
    const appId = selectedAppId;
    if (!registered || registered.id !== appId || !active() || !appId) return;
    if (!selection || data?.selectedApplication?.repositoryId !== selection.repositoryId) { await navigate("overview", appId); return; }
    await loadOperations(); if (!active() || selectedAppId !== appId || operationsAppId !== appId) return;
    await operationWrite(async (id, current) => { if (id !== appId || !current()) return; await api("/api/apps/" + encodeURIComponent(id) + "/github", JSON.stringify({ expectedVersion: operationsAppId === id ? operations?.connection?.version ?? 0 : 0, installationId: selection.installationId, owner: selection.owner, repository: selection.repository, ref: selection.ref })); });
    if (active() && selectedAppId === appId) await navigate("source", appId);
  }
  async function saveSettings() {
    const app = data?.selectedApplication; if (!app || reading || busy || !active()) return;
    try { return await applicationWrite("/api/apps/" + encodeURIComponent(app.id) + "/settings", { expectedVersion: app.settings.version, values: publicValues(node("settings-json").value) }); }
    catch { notice("공개 설정 JSON의 대문자 키, 문자열 값과 크기를 확인해 주세요.", true); }
  }
  document.getElementById("github-open")?.addEventListener("click", () => {
    void navigate("register").then(() => node("github-managed-refresh").focus());
  });
  node("github-managed-refresh").addEventListener("click", () => { void loadGitHubConnection(); });
  node("github-manifest-form").addEventListener("submit", event => { event.preventDefault(); void startGitHubManifest(); });
  node("github-installation-select").addEventListener("change", () => { node("github-repository-search").value = ""; void loadGitHubRepositories(); });
  node("github-repository-search").addEventListener("input", () => { githubSelection = null; renderGitHubRepositories(); });
  node("github-repositories-more").addEventListener("click", () => { void loadGitHubRepositories(true); });
  node("github-repository-use").addEventListener("click", useGitHubRepository);
  node("application-repository").addEventListener("input", () => { githubSelection = null; });
  node("signing-key-create").addEventListener("click", () => { void prepareSigningKey(); });
  node("ci-refresh").addEventListener("click", () => { void loadCI(false, true); });
  node("ci-resolve").addEventListener("click", () => { void loadCI(true, true); });
  node("ci-form").addEventListener("submit", event => { event.preventDefault(); void saveCI(); });
  node("ci-disable").addEventListener("click", () => { void saveCI(false); });
  node("ci-copy").addEventListener("click", () => { void copyCI(); });
  document.getElementById("automation-editor")?.addEventListener("toggle", () => { if (currentRoute.page === "runners" && document.getElementById("automation-editor").open) scheduleAutomationPoll(); else stopAutomationPoll(); });
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
  for (const id of ["automation-history-platform", "automation-history-result"]) document.getElementById(id).addEventListener("change", () => { if (automationAppId === selectedAppId && automation) renderAutomation(document, selectedAppId, automation, currentDetection(operations), env.location?.origin, operations); });
  document.getElementById("github-access-recover").addEventListener("click", () => { const installationId = operations?.connection?.installationId; if (installationId) node("github-installation-select").value = String(installationId); void navigate("register"); });
  document.getElementById("operations-refresh")?.addEventListener("click", () => { void loadProjectOverview(); });
  document.getElementById("runners-native-refresh")?.addEventListener("click", () => { void nativePanel.load(); });
  document.getElementById("ota-history")?.addEventListener("click", event => { const link = event.target.closest?.("a[data-deployment-path]"); if (!link || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button && event.button !== 0) return; const path = link.getAttribute("data-deployment-path"); if (!parseAdminPath(path)) return; event.preventDefault(); return navigate(path); });
  document.getElementById("project-list")?.addEventListener("click", event => {
    const link=event.target.closest?.("a[data-project-path]");
    if(link){
      if(event.defaultPrevented||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey||event.button&&event.button!==0)return;
      const path=link.getAttribute("data-project-path"),route=parseAdminPath(path);event.preventDefault();
      if(!route?.appId||link.getAttribute("href")!==path||!data?.applications?.some(app=>app.id===route.appId))return;
      return navigate(path);
    }
    if(event.defaultPrevented||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey||event.button&&event.button!==0)return;
    const card = event.target.closest?.("button[data-select-application]");
    const id = card?.getAttribute?.("data-select-application"); if (id && data?.applications?.some(app => app.id === id)) return navigate("overview", id);
  });
  document.getElementById("project-search")?.addEventListener("input", () => { if (data) renderProjectCards(document, projectView()); });
  document.getElementById("page-overview")?.addEventListener("click", event => {
    const link = event.target.closest?.("a[data-project-path]");
    if (!link || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button && event.button !== 0) return;
    const path = link.getAttribute("data-project-path"), route = parseAdminPath(path); event.preventDefault();
    if (currentRoute.page !== "overview" || !route?.appId || route.appId !== selectedAppId || link.getAttribute("href") !== path) return;
    return navigate(path);
  });
  document.getElementById("project-status-filter")?.addEventListener("change", () => { if (data) renderProjectCards(document, projectView()); });
  document.getElementById("project-register-open")?.addEventListener("click", () => navigate("register").then(() => node("application-name").focus()));
  document.getElementById("registration-close")?.addEventListener("click", () => navigate("projects"));
  for (const nav of document.querySelectorAll?.("[data-admin-page]") ?? []) nav.addEventListener("click", event => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || (event.button !== undefined && event.button !== 0) || nav.getAttribute("download") !== null || (nav.getAttribute("target") && nav.getAttribute("target") !== "_self")) return;
    const page = nav.getAttribute("data-admin-page"); const path = adminPath(page, currentRoute.appId ?? selectedAppId);
    if (!path) return; event.preventDefault(); return navigate(path);
  });
  node("sidebar-toggle").addEventListener("click", () => sidebar(document.body.getAttribute("data-menu-open") !== "true"));
  node("sidebar-backdrop").addEventListener("click", () => sidebar(false));
  document.addEventListener?.("keydown", event => { if (event.key === "Escape" && document.body.getAttribute("data-menu-open") === "true") { sidebar(false); node("sidebar-toggle").focus(); } });
  node("project-summary-refresh")?.addEventListener("click", () => loadProjects());
  node("application-select").addEventListener("change", event => chooseApplication(event.target.value));
  node("application-form").addEventListener("submit", event => { event.preventDefault(); return registerApplication(); });
  node("credential-open").addEventListener("click", () => { return navigate("credentials", selectedAppId); });
  node("settings-form").addEventListener("submit", event => { event.preventDefault(); return saveSettings(); });
  async function logout() {
    if (!active() || !csrf) return;
    const value = csrf;
    close("화면을 비웠습니다. 서버 로그아웃을 확인하는 중…");
    const version = generation;
    try { await api("/api/auth/logout", "{}", value); if (version === generation) notice("로그아웃했습니다. 다시 보려면 로그인해 주세요."); }
    catch (error) { if (version === generation) notice(error.status === 401 ? "세션이 종료되었습니다. 다시 보려면 로그인해 주세요." : "화면은 비웠지만 서버 로그아웃을 확인하지 못했습니다. 연결을 확인하고 페이지를 새로 연 뒤 로그아웃을 다시 시도해 주세요.", error.status !== 401); }
  }
  for (const view of ["apps", "updates", "sources", "history", "account"]) node("mobile-" + view).addEventListener("click", () => navigate(({ apps: "projects", updates: "ota", sources: "source", history: "activity", account: "settings" })[view], selectedAppId));
  for (const [id, event] of [["app-search", "input"], ["app-source-filter", "change"], ["app-sort", "change"]]) node(id).addEventListener(event, () => { if (!active()) return; appPage = 0; renderTable(); });
  for (const [id, direction] of [["app-previous", -1], ["app-next", 1]]) node(id).addEventListener("click", () => { if (!active()) return; appPage = Math.max(0, appPage + direction); renderTable(); });
  node("detail-close").addEventListener("click", () => { node("app-detail").hidden = true; detailTrigger?.focus(); detailTrigger = null; });
  node("detail-source").addEventListener("click", () => showView("sources", true));
  node("recent-history-link").addEventListener("click", () => showView("history", true));
  node("source-file").addEventListener("change", event => importFile("source", event.target.files?.[0]));
  node("baseline-file").addEventListener("change", event => importFile("baseline", event.target.files?.[0]));
  node("snapshot-select").addEventListener("change", event => chooseSnapshot(event.target.value));
  node("flavor-select").addEventListener("change", renderFlavor);
  for (const kind of ["snapshot", "history"]) for (const direction of ["previous", "next"]) node(kind + "-" + direction).addEventListener("click", () => page(kind === "snapshot" ? "snapshots" : "history", direction));
  node("retry-button").addEventListener("click", () => csrf ? refresh() : initialize());
  node("logout-button").addEventListener("click", logout);
  env.addEventListener?.("popstate", () => { const path = env.location?.pathname; if (!parseAdminPath(path)) { close("페이지 주소를 확인한 뒤 프로젝트 목록을 다시 열어 주세요."); return; } return navigate(path, null, { fromHistory: true }); });
  env.addEventListener?.("pagehide", () => close());
  env.addEventListener?.("pageshow", event => { if (event.persisted) { close(); env.location.replace("/"); } });
  env.addEventListener?.("focus", () => { if (active() && visibleSummaryPage()) { paintProjects(); void loadProjects(); } });
  document.addEventListener?.("visibilitychange", () => { if(document.hidden)stopAutomationPoll();if(currentRoute.page === "onboarding"){if(document.hidden)onboardingPanel.leave();else if(active())void onboardingPanel.enter(selectedAppId);} if (!active() || !visibleSummaryPage()) { stopProjectsPoll(); return; } paintProjects(); void loadProjects(); });
  async function initialize() {
    if (closed || reading) return;
    reading = true; controls();
    try {
      const session = await api("/api/auth/session"); if (closed) return;
      if (!session || typeof session.csrfToken !== "string" || !session.csrfToken || !Number.isSafeInteger(session.expiresAt)) throw new Error("INVALID_SESSION");
      if (typeof session.workspaceName === "string" && session.workspaceName.trim()) node("workspace-name").textContent = session.workspaceName;
      csrf = session.csrfToken; expiresAt = session.expiresAt; armExpiry();
      if (!closed) await refresh();
    } catch (error) { failure(error); }
    finally { reading = false; controls(); }
    if (active() && data) await loadRoute();
  }
  node("app-sort").value = "name-asc";
  await initialize();
  if (githubCallback && active() && csrf) { const callback = githubCallback; githubCallback = null; await completeGitHubManifest(callback); }
  return { loadProjects, navigate, route: () => ({ ...currentRoute }), loadNative: nativePanel.load, enqueueNative: nativePanel.enqueue, enrollNativeRunner: nativePanel.enroll, loadCredentials: credentialsPanel.load, registerCredential: credentialsPanel.register, disableCredential: credentialsPanel.disable, loadCI, resolveCI: () => loadCI(true), saveCI, disableCI: () => saveCI(false), copyCI, loadGitHubConnection, loadGitHubRepositories, useGitHubRepository, startGitHubManifest, completeGitHubManifest, prepareSigningKey, refresh, loadOperations, loadAutomation, loadAutomationJob, copyRunnerConfig, queueAutomation, saveAutomationPolicy, cancelAutomation, enrollRunner, revokeRunner, copyRunnerToken, hideRunnerToken, connectGitHub, syncGitHub, deployOTA, chooseSnapshot, chooseApplication, registerApplication, saveSettings, pageSnapshots: direction => page("snapshots", direction), pageHistory: direction => page("history", direction), importFile, logout, close: () => close() };
}

if (typeof window !== "undefined") void startClient(window);
