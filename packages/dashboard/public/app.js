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

/** Render imported evidence with text nodes only; no evidence becomes markup or navigation. */
export function renderDashboard(document, state) {
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
    document.getElementById("dashboard-content").hidden = true; document.getElementById("empty").hidden = true;
    for (const id of ["app-name", "source-meta", "source-details", "flavor-detail", "runtime", "profile", "provider", "baseline-history", "run-history", "snapshot-select", "flavor-select", "trust-note", "freshness", "flavor-count"]) document.getElementById(id).replaceChildren();
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
  let csrf = ""; let data = null; let selectedId; let timer; let stopped = false; let generation = 0; let busy = false;
  const requestKeys = new Map();
  async function api(url, body) {
    const response = await env.fetch(url, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", headers: body === undefined ? {} : { "Content-Type": "application/json", "X-Flora-CSRF": csrf }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
    if (!response.ok) { const error = new Error(response.status === 401 ? "SESSION_REQUIRED" : response.status === 413 ? "BODY_TOO_LARGE" : "REQUEST_FAILED"); error.status = response.status; throw error; }
    return response.status === 204 ? null : response.json();
  }
  function failure(error) { if (stopped) return; if (error.status === 401) { stopped = true; data = null; csrf = ""; requestKeys.clear(); env.clearTimeout(timer); renderStatus(document, "session"); } else renderStatus(document, "error", error.message === "BODY_TOO_LARGE" ? "BODY_TOO_LARGE" : error.message === "INVALID_INPUT" ? "INVALID_INPUT" : "REQUEST_FAILED"); }
  function schedule() {
    env.clearTimeout(timer);
    if (!stopped && data?.history.some(record => ACTIVE.has(record.state))) timer = env.setTimeout(() => { void refresh().catch(failure); }, 1000);
  }
  async function refresh() {
    const version = ++generation;
    let next;
    try { next = await api("/api/state" + (selectedId ? "?snapshotId=" + encodeURIComponent(selectedId) : "")); }
    catch (error) { if (stopped || version !== generation) return false; throw error; }
    if (stopped || version !== generation) return false;
    data = next; selectedId = data.selectedSnapshotId;
    const active = data.history.find(record => record.requestKind === "run-request" && ACTIVE.has(record.state));
    if (active) requestKeys.set(selectedId, active.requestKey);
    else if (data.history.some(record => record.requestKey === requestKeys.get(selectedId))) requestKeys.delete(selectedId);
    renderDashboard(document, data); schedule(); return true;
  }
  async function mutate(work) {
    if (stopped || busy) return;
    busy = true; renderStatus(document, "saving"); document.getElementById("run-button").disabled = true;
    document.getElementById("source-file").disabled = true; document.getElementById("baseline-file").disabled = true;
    try { await work(); const current = await refresh(); if (current && !stopped) renderStatus(document, "ready"); }
    catch (error) { failure(error); schedule(); }
    finally { busy = false; if (!stopped) { document.getElementById("source-file").disabled = false; document.getElementById("baseline-file").disabled = !data?.selectedSnapshotId; if (data) renderDashboard(document, data); } }
  }
  async function importFile(kind, file) {
    if (!file) return;
    await mutate(async () => {
      if (file.size > 2 * 1024 * 1024) throw new Error("BODY_TOO_LARGE");
      const content = await file.text();
      try { JSON.parse(content); } catch { throw new Error("INVALID_INPUT"); }
      if (kind === "source") { const imported = await api("/api/sources", content); selectedId = imported.id; }
      else if (selectedId) await api("/api/baselines?snapshotId=" + encodeURIComponent(selectedId), content);
    });
  }
  async function run() {
    if (!selectedId) return;
    const snapshotId = selectedId;
    let requestKey = requestKeys.get(snapshotId); if (!requestKey) { requestKey = env.crypto.randomUUID(); requestKeys.set(snapshotId, requestKey); }
    await mutate(async () => { await api("/api/runs", { snapshotId, requestKey }); });
  }
  async function cancel(recordId) { if (!data?.history.some(record => record.id === recordId && ACTIVE.has(record.state))) return; await mutate(async () => { await api("/api/runs/" + encodeURIComponent(recordId) + "/cancel", {}); }); }
  async function chooseSnapshot(id) { selectedId = id; renderStatus(document, "loading"); try { const current = await refresh(); if (current && !stopped) renderStatus(document, "ready"); } catch (error) { failure(error); } }
  document.getElementById("source-file").addEventListener("change", event => { const file = event.target.files?.[0]; event.target.value = ""; void importFile("source", file); });
  document.getElementById("baseline-file").addEventListener("change", event => { const file = event.target.files?.[0]; event.target.value = ""; void importFile("baseline", file); });
  document.getElementById("snapshot-select").addEventListener("change", event => { void chooseSnapshot(event.target.value); });
  document.getElementById("flavor-select").addEventListener("change", () => { if (data) renderDashboard(document, data); });
  document.getElementById("run-button").addEventListener("click", () => { void run(); });
  document.getElementById("retry-button").addEventListener("click", () => { if (!stopped) void chooseSnapshot(selectedId); });
  document.getElementById("run-history").addEventListener("click", event => { const recordId = event.target.getAttribute?.("data-cancel"); if (recordId) void cancel(recordId); });
  renderStatus(document, "loading");
  try {
    const session = await api("/api/session", bootstrap ? { bootstrap } : undefined); csrf = session.csrfToken;
    document.getElementById("source-file").disabled = false; const current = await refresh(); if (current && !stopped) renderStatus(document, "ready");
  } catch (error) { failure(error); }
  return { close() { stopped = true; generation++; data = null; csrf = ""; requestKeys.clear(); env.clearTimeout(timer); }, refresh, run, cancel, importFile, chooseSnapshot };
}
if (typeof window !== "undefined") void startClient({ document: window.document, location: window.location, history: window.history, fetch: window.fetch.bind(window), setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window), crypto: window.crypto });
