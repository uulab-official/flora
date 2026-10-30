/**
 * Read-only provider chooser for the owner-only Flora console.
 * Native jobs are still dispatched ONLY by the existing authenticated native
 * form. External provider commands stay on the user's own computer.
 *
 * No auth token, credential, user-supplied URL, third-party script, or remote
 * build request enters this module.
 */
const OPTIONS = Object.freeze([
  Object.freeze({ id: "flora-pc-native", title: "내 PC · Flora Native Runner", mode: "local" }),
  Object.freeze({ id: "github-actions-native", title: "GitHub Actions · 내 비공개 저장소", mode: "workflow" }),
  Object.freeze({ id: "expo-eas", title: "Expo EAS · 내 계정", mode: "external" }),
  Object.freeze({ id: "codemagic", title: "Codemagic · 내 계정", mode: "external" }),
  Object.freeze({ id: "bitrise", title: "Bitrise · 내 계정", mode: "external" }),
]);
const DOC = "https://github.com/uulab-official/flora/blob/main/docs/development/build-provider-options.ko.md";
const HELP = Object.freeze({
  "flora-pc-native": Object.freeze({
    description: "이미 구현된 앱별 네이티브 Runner 작업 큐를 사용합니다. 아래 서명 키와 GitHub SHA를 확인하고 빌드를 요청하세요.",
    status: "선택한 앱의 Runner와 서명 키를 직접 확인해야 합니다. 실행할 PC가 꺼져 있으면 작업은 대기합니다.",
    command: "",
    action: "기존 네이티브 빌드 양식으로 이동",
  }),
  "github-actions-native": Object.freeze({
    description: "Flora의 공개 재사용 Workflow를 각 비공개 앱 저장소에서 호출합니다. 소스와 Artifacts는 호출 저장소에 남고 비용·실행 할당량도 호출 저장소 소유입니다.",
    status: "현재 Flora 웹에서 Actions 빌드를 직접 시작하지 않습니다. 비공개 저장소에 Workflow를 설치한 뒤 GitHub에서 실행하세요.",
    command: "name: Flora native build\non:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  native:\n    uses: uulab-official/flora/.github/workflows/reusable-expo-build.yml@REVIEWED_40_CHARACTER_SHA\n    with:\n      platform: android\n      profile: preview\n      runner-type: github-hosted",
    action: "Workflow 예제 복사",
  }),
  "expo-eas": Object.freeze({
    description: "본인 Expo 계정의 EAS CLI를 앱 폴더에서 사용합니다. Flora OTA SDK와 런타임 호환성은 별도로 검증해야 합니다.",
    status: "이 웹 화면은 Expo 계정 연결이나 EAS 실행을 확인하지 않았습니다. 아래 명령은 로컬 CLI의 사전 검사만 수행합니다.",
    command: "node /PATH/TO/FLORA/packages/cli/dist/main.js providers eas start --platform android --profile preview",
    action: "로컬 CLI 명령 복사",
  }),
  "codemagic": Object.freeze({
    description: "본인 Codemagic 계정의 API 토큰을 PC에만 설정해 CLI로 빌드를 요청할 수 있습니다.",
    status: "웹 연결 미구현. CLI는 기본 dry-run이며 실제 요청에는 본인 PC에서 --execute가 별도로 필요합니다.",
    command: "node /PATH/TO/FLORA/packages/cli/dist/main.js providers codemagic start --app YOUR_APP_ID --workflow YOUR_WORKFLOW --branch main",
    action: "로컬 CLI 명령 복사",
  }),
  bitrise: Object.freeze({
    description: "본인 Bitrise 계정의 API 토큰을 PC에만 설정해 CLI로 빌드 요청·조회·중단을 수행할 수 있습니다.",
    status: "웹 연결 미구현. CLI는 기본 dry-run이며 실제 요청에는 본인 PC에서 --execute가 별도로 필요합니다.",
    command: "node /PATH/TO/FLORA/packages/cli/dist/main.js providers bitrise start --app YOUR_APP_SLUG --workflow YOUR_WORKFLOW --branch main",
    action: "로컬 CLI 명령 복사",
  }),
});
const NATIVE_STATES = Object.freeze({
  queued: "Runner 대기",
  leased: "Runner 작업 중",
  running: "빌드 중",
  succeeded: "서명 결과 보고됨",
  failed: "빌드 실패",
  cancel_requested: "취소 요청",
  cancelled: "취소됨",
});
const scopedId = value => typeof value === "string" && /^[a-z][a-z0-9_-]{2,95}$/.test(value);

export function listBuildProviders() { return OPTIONS.map(item => ({ ...item })); }
export function buildProviderHelp(id) { return Object.hasOwn(HELP, id) ? HELP[id] : null; }

/** App-scoped, bounded, public-only summary. A Runner last-seen is NOT online proof. */
export function summarizeNativeBuilds(appId, view) {
  if (!scopedId(appId) || !view || view.appId !== appId || !Array.isArray(view.jobs) ||
      !Array.isArray(view.runners) || view.jobs.length > 100 || view.runners.length > 100 ||
      [...view.jobs, ...view.runners].some(item => item?.appId !== appId)) throw new Error("INVALID_BUILD_PROVIDER_SCOPE");
  const runnerCount = view.runners.filter(item => item.revokedAt === null).length;
  const observedRunners = view.runners.filter(item => item.revokedAt === null && Number.isSafeInteger(item.lastSeenAt) && item.lastSeenAt > 0).length;
  const latest = view.jobs[0];
  if (latest && (!Object.hasOwn(NATIVE_STATES, latest.state) || typeof latest.platform !== "string" ||
      !["ios", "android"].includes(latest.platform))) throw new Error("INVALID_BUILD_PROVIDER_JOB");
  return {
    appId, runnerCount, observedRunners, jobCount: view.jobs.length,
    latest: latest ? {
      platform: latest.platform, state: latest.state,
      ...(latest.artifact && typeof latest.artifact.fileName === "string" &&
        /^[A-Za-z0-9_.-]{1,180}$/.test(latest.artifact.fileName) &&
        typeof latest.artifact.sha256 === "string" && /^[a-f0-9]{64}$/.test(latest.artifact.sha256) ?
        { artifactName: latest.artifact.fileName, artifactSha256: latest.artifact.sha256 } : {}),
    } : null,
  };
}

/**
 * OTA metadata is read-only: published manifests do not establish device-level
 * download, apply, restart or Store build success.
 */
export function summarizeOtaPublications(appId, result) {
  const items = result?.deployments;
  if (!scopedId(appId) || !Array.isArray(items) || items.length > 200 ||
      items.some(item => item?.appId !== appId || !["ios", "android"].includes(item.platform)))
    throw new Error("INVALID_BUILD_OTA_SCOPE");
  return { appId, total: items.length,
    ios: items.filter(item => item.platform === "ios").length,
    android: items.filter(item => item.platform === "android").length };
}

/** The selected app is an authority boundary for display and callbacks. */
export function createBuildProviderPanel(env, context) {
  const node = id => env.document.getElementById(id);
  let app = null, native = null, ota = null, selection = "flora-pc-native", notice = "";
  const current = () => context.active() && scopedId(app) && app === context.appId();
  function render() {
    const authorized = current();
    const provider = OPTIONS.find(item => item.id === selection) ?? OPTIONS[0];
    const help = HELP[provider.id];
    node("build-provider-select").disabled = !authorized;
    node("build-provider-select").value = provider.id;
    node("build-provider-title").textContent = authorized ? provider.title : "프로젝트를 선택하세요";
    node("build-provider-description").textContent = authorized ? help.description : "";
    node("build-provider-state").textContent = authorized ? (notice || help.status) : "";
    node("build-provider-command").textContent = authorized && help.command ? help.command : "";
    node("build-provider-command").hidden = !authorized || !help.command;
    node("build-provider-copy").disabled = !authorized || !help.command;
    node("build-provider-copy").hidden = !authorized || !help.command;
    node("build-provider-native").hidden = !authorized || selection !== "flora-pc-native";
    node("build-provider-native").disabled = !authorized || selection !== "flora-pc-native";
    // Do not leave an active native submit form visible under a different provider.
    node("native-editor").hidden = authorized && selection !== "flora-pc-native";
    node("build-provider-runners").disabled = !authorized;
    node("build-provider-ota").disabled = !authorized;
    const link = node("build-provider-docs");
    if (authorized) { link.setAttribute("href", DOC); link.hidden = false; }
    else { link.hidden = true; link.removeAttribute("href"); }
    const otaText = node("build-provider-ota-summary");
    otaText.hidden = !authorized;
    otaText.textContent = authorized ? ota?.appId === app ?
      "Flora OTA 게시 이력 " + ota.total + "건 (iOS " + ota.ios + "건 / Android " + ota.android + "건). 기기 다운로드·적용·재시작은 OTA 상세에서 별도 확인하세요." :
      "Flora OTA 게시 현황 미확인 · 이력 조회 후 확인할 수 있습니다." : "";
    const summary = node("build-provider-summary");
    if (!authorized || selection !== "flora-pc-native") { summary.textContent = ""; summary.hidden = true; return; }
    summary.hidden = false;
    if (!native || native.appId !== app) {
      summary.textContent = "네이티브 Runner 상태 미확인 · 아래 기존 빌드 이력을 새로 확인하세요.";
      return;
    }
    const last = native.latest;
    summary.textContent = "현재 앱의 등록 Runner " + native.runnerCount +
      "개 (연결 이력 " + native.observedRunners + "개 · 온라인 보장 아님). 빌드 이력 " + native.jobCount +
      "건." + (last ? " 최근 " + last.platform.toUpperCase() + " · " + NATIVE_STATES[last.state] +
      (last.artifactName ? " · " + last.artifactName + " (SHA-256 메타데이터 확인, 바이너리는 실행 PC에 보관)" : "") : "");
  }
  function open(nextApp) {
    if (!scopedId(nextApp) || !context.active() || nextApp !== context.appId()) { clear(); return; }
    if (app !== nextApp) { app = nextApp; native = null; ota = null; selection = "flora-pc-native"; notice = ""; }
    render();
  }
  function clear() {
    app = null; native = null; ota = null; selection = "flora-pc-native"; notice = ""; render();
  }
  function setNativeView(nextApp, view) {
    if (!current() || nextApp !== app) return false;
    try { native = summarizeNativeBuilds(nextApp, view); notice = ""; }
    catch { native = null; notice = "Runner 이력의 앱 식별자를 확인하지 못했습니다. 다른 앱의 정보를 표시하지 않습니다."; }
    render(); return Boolean(native);
  }
  function setOTAView(nextApp, result) {
    if (!current() || nextApp !== app) return false;
    try { ota = summarizeOtaPublications(nextApp, result); } catch { ota = null; }
    render(); return Boolean(ota);
  }
  function select(id) {
    if (!current() || !OPTIONS.some(item => item.id === id)) { if (current()) render(); return false; }
    selection = id; notice = ""; render(); return true;
  }
  async function copy() {
    if (!current() || !HELP[selection]?.command) return false;
    const sourceApp = app, sourceSelection = selection, command = HELP[selection].command;
    try {
      if (typeof env.navigator?.clipboard?.writeText !== "function") throw new Error("NO_CLIPBOARD");
      await env.navigator.clipboard.writeText(command);
      if (current() && app === sourceApp && selection === sourceSelection) { notice = "비밀값 없는 실행 예제를 복사했습니다. 자신의 PC/비공개 저장소에서 설정과 비용을 먼저 확인하세요."; render(); }
      return true;
    } catch {
      if (current() && app === sourceApp && selection === sourceSelection) { notice = "복사할 수 없습니다. 표시된 예제를 직접 확인하세요."; render(); }
      return false;
    }
  }
  function go(page) {
    if (!current() || !["ota", "runners"].includes(page)) return;
    return context.navigate(page, app);
  }
  function nativeForm() {
    if (!current() || selection !== "flora-pc-native") return;
    node("native-editor").open = true;
    node("native-platform").focus?.();
  }
  node("build-provider-select").addEventListener("change", event => select(event?.target?.value));
  node("build-provider-copy").addEventListener("click", () => { void copy(); });
  node("build-provider-native").addEventListener("click", nativeForm);
  node("build-provider-runners").addEventListener("click", () => { void go("runners"); });
  node("build-provider-ota").addEventListener("click", () => { void go("ota"); });
  clear();
  return { open, clear, setNativeView, setOTAView, select, copy, go, state: () => ({ appId: app, selection, native, ota }) };
}
