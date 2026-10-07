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
function date(value) { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? "시각 알 수 없음" : parsed.toLocaleString("ko-KR", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) + " UTC"; }
function select(document, id, items, value) { const node = document.getElementById(id); node.replaceChildren(...items.map(([id, text]) => { const option = element(document, "option", text); option.value = id; return option; })); node.value = value ?? ""; }
function validState(value) {
  return value && [value.snapshots, value.history].every(page => page && Array.isArray(page.items) && page.items.length <= 20 && (page.nextCursor === null || typeof page.nextCursor === "string")) && (value.selected === null || typeof value.selected?.id === "string") && value.profile && value.runner === "unavailable";
}

/** Original files stay byte-for-byte intact. Only the server parses their envelopes. */
export async function startClient(env) {
  const { document } = env; const node = id => document.getElementById(id);
  const now = () => env.now?.() ?? Date.now();
  let csrf = ""; let expiresAt = 0; let expiryTimer; let closed = false; let busy = false; let reading = false; let generation = 0; let viewGeneration = 0; let data = null; let selectedId = null;
  let snapshotCursors = [null]; let historyCursors = [null];
  let currentView = "apps"; let appPage = 0; let filteredCount = 0; let detailTrigger = null; const pageSize = 10;
  const requests = new Set(); const logs = new Map();

  function notice(text = "", error = false, retry = false, success = false) {
    node("notice").textContent = text; node("notice").hidden = !text;
    node("notice").className = "notice" + (error ? " notice-error" : success ? " notice-success" : ""); node("notice").setAttribute("role", error ? "alert" : "status");
    node("retry-button").hidden = !retry || closed;
  }
  function controls() {
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
    for (const view of ["apps", "sources", "history", "account"]) for (const prefix of ["nav-", "mobile-"]) node(prefix + view).disabled = closed || !csrf;
  }
  function erase() {
    viewGeneration++;
    for (const id of PRIVATE_FIELDS) { node(id).replaceChildren(); node(id).value = ""; }
    for (const id of ["source-file", "baseline-file"]) node(id).value = "";
    node("dashboard-content").hidden = true; node("empty").hidden = true; node("app-detail").hidden = true; node("view-account").hidden = true; appPage = 0; filteredCount = 0; detailTrigger = null;
    data = null; selectedId = null; logs.clear(); snapshotCursors = [null]; historyCursors = [null];
  }
  function close(message = "") {
    closed = true; busy = false; reading = false; generation++; csrf = ""; expiresAt = 0; env.clearTimeout(expiryTimer);
    for (const request of requests) request.abort(); requests.clear(); erase(); notice(message, Boolean(message));
    node("login-link").hidden = !message; controls();
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
  async function api(url, body, csrfValue = csrf) {
    const controller = new AbortController(); requests.add(controller);
    try {
      const response = await env.fetch(url, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", headers: body === undefined ? {} : { "Content-Type": "application/json", "X-Flora-CSRF": csrfValue }, ...(body === undefined ? {} : { body }), signal: controller.signal });
      if (!response.ok) {
        let code = "";
        try { const payload = await response.json(); const value = payload?.error ?? payload?.code; if (["CONFLICT", "APP_CONFLICT", "IDEMPOTENCY_CONFLICT", "CAPACITY", "CAPACITY_EXCEEDED", "BUSY"].includes(value)) code = value; } catch { /* Do not display raw server or proxy text. */ }
        throw Object.assign(new Error("REQUEST_FAILED"), { status: response.status, code });
      }
      return response.status === 204 ? null : await response.json();
    } finally { requests.delete(controller); }
  }
  function failure(error, importing = false) {
    if (closed) return;
    if (error.status === 401) { expire(); return; }
    let text = importing ? "반입 완료 여부를 확인하지 못했습니다. 연결을 확인한 뒤 이력을 다시 불러오세요. 기록이 없다면 같은 원본 파일로 다시 시도할 수 있습니다." : "이력을 불러오지 못했습니다. 연결 또는 저장소를 사용할 수 없는 상태일 수 있습니다. 잠시 후 다시 시도해 주세요.";
    if (error.status === 413) text = "파일이 허용 크기를 초과했습니다. 소스는 최대 1 MiB, baseline은 최대 128 KiB입니다.";
    else if (error.code === "CONFLICT") text = "저장소·앱 경로가 맞지 않거나 저장 한도에 도달했을 수 있어 반입을 완료하지 못했습니다. 기존 이력과 현재 앱에 해당하는 원본 파일을 확인해 주세요.";
    else if (error.code === "APP_CONFLICT") text = "이 작업실에 저장된 앱과 파일의 저장소 또는 루트가 맞지 않습니다. 현재 앱에 해당하는 원본 파일을 선택해 주세요.";
    else if (error.code === "IDEMPOTENCY_CONFLICT") text = "같은 반입 식별자에 다른 내용이 이미 저장되어 있습니다. 기존 이력과 원본 baseline을 확인해 주세요.";
    else if (["CAPACITY", "CAPACITY_EXCEEDED"].includes(error.code)) text = "저장 용량 한도로 새 반입을 완료하지 못했습니다. 기존 이력은 다시 불러올 수 있습니다.";
    else if (error.code === "BUSY" || error.status === 429) text = "현재 처리 중이거나 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.";
    else if (error.status === 403) text = "요청 권한을 확인하지 못했습니다. 다시 로그인한 뒤 시도해 주세요.";
    else if (error.status === 400 || error.status === 415 || error.status === 409) text = "파일이나 요청을 받아들이지 못했습니다. 선택한 revision, 파일 형식과 반입 이력을 확인해 주세요.";
    if (data) text += " 화면에는 마지막으로 확인한 이력이 남아 있습니다.";
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
    if (!active() || !["apps", "sources", "history", "account"].includes(view)) return;
    currentView = view;
    const labels = { apps: ["앱", "반입한 앱과 설정을 한곳에서 확인하세요."], sources: ["소스", "반입한 소스의 revision과 선언된 설정을 확인하세요."], history: ["반입 이력", "선택한 소스 revision에 반입된 개발 결과입니다."], account: ["설정", "비공개 작업실의 계정과 반입 범위를 확인하세요."] };
    node("view-title").textContent = labels[view][0]; node("view-label").textContent = labels[view][0]; node("view-description").textContent = labels[view][1];
    for (const other of Object.keys(labels)) {
      node("view-" + other).hidden = other !== view;
      for (const prefix of ["nav-", "mobile-"]) { const button = node(prefix + other); button.setAttribute("aria-current", other === view ? "page" : "false"); button.className = (prefix === "nav-" ? "nav-item" : "") + (other === view ? " active" : ""); }
    }
    node("dashboard-content").hidden = !data?.selected || view === "account";
    node("empty").hidden = Boolean(data?.selected) || view === "account";
    if (focus) node("workspace").focus();
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
      for (const metric of ["배포", "오류", "수익"]) { const cell = element(document, "td", "미연결", "metric-cell"); cell.setAttribute("aria-label", metric + " 미연결"); row.append(cell); }
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
    const selected = data.selected; viewGeneration++; logs.clear(); node("app-detail").hidden = true; detailTrigger = null; renderConsole();
    if (!active() || !data) return;
    node("dashboard-content").hidden = !selected || currentView === "account"; node("empty").hidden = Boolean(selected) || currentView === "account";
    if (!selected) {
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
      const next = await api("/api/state" + (query.size ? "?" + query : ""));
      if (!active() || version !== generation) return false;
      if (!validState(next) || (selectedId && next.selected?.id !== selectedId)) throw new Error("INVALID_STATE");
      data = next; selectedId = data.selected?.id ?? null; snapshotCursors = nextSnapshots; historyCursors = nextHistory; render();
      if (!active()) return false;
      notice(); return true;
    } catch (error) { if (!closed && version === generation) failure(error); return false; }
    finally { if (version === generation) { reading = false; controls(); } }
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
      const log = await api("/api/baselines/" + encodeURIComponent(id) + "/log");
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
      const receipt = await api(kind === "source" ? "/api/sources" : "/api/baselines?snapshotId=" + encodeURIComponent(selectedId), file);
      if (!active() || version !== generation) return;
      if (typeof receipt?.id !== "string" || !receipt.id || (kind === "baseline" && receipt.snapshotId !== selectedId)) throw new Error("INVALID_RECEIPT");
      if (kind === "source") { selectedId = receipt.id; snapshotCursors = [null]; }
      historyCursors = [null];
      const ready = await refresh(); if (ready && !closed) notice("반입 완료 · 사용자 반입 이력에서 확인됨", false, false, true);
    } catch (error) { if (!closed && version === generation) failure(error, true); }
    finally { busy = false; node(kind === "source" ? "source-file" : "baseline-file").value = ""; if (!closed) controls(); }
  }
  async function logout() {
    if (!active() || !csrf) return;
    const value = csrf;
    close("화면을 비웠습니다. 서버 로그아웃을 확인하는 중…");
    const version = generation;
    try { await api("/api/auth/logout", "{}", value); if (version === generation) notice("로그아웃했습니다. 다시 보려면 로그인해 주세요."); }
    catch (error) { if (version === generation) notice(error.status === 401 ? "세션이 종료되었습니다. 다시 보려면 로그인해 주세요." : "화면은 비웠지만 서버 로그아웃을 확인하지 못했습니다. 연결을 확인하고 페이지를 새로 연 뒤 로그아웃을 다시 시도해 주세요.", error.status !== 401); }
  }
  for (const view of ["apps", "sources", "history", "account"]) for (const prefix of ["nav-", "mobile-"]) node(prefix + view).addEventListener("click", () => showView(view, true));
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
  env.addEventListener?.("pagehide", () => close());
  env.addEventListener?.("pageshow", event => { if (event.persisted) { close(); env.location.replace("/"); } });
  env.addEventListener?.("focus", active);
  document.addEventListener?.("visibilitychange", active);
  async function initialize() {
    if (closed || reading) return;
    reading = true; controls();
    try {
      const session = await api("/api/auth/session"); if (closed) return;
      if (!session || typeof session.csrfToken !== "string" || !session.csrfToken || !Number.isSafeInteger(session.expiresAt)) throw new Error("INVALID_SESSION");
      csrf = session.csrfToken; expiresAt = session.expiresAt; armExpiry();
      if (!closed) await refresh();
    } catch (error) { failure(error); }
    finally { reading = false; controls(); }
  }
  node("app-sort").value = "name-asc";
  await initialize();
  return { refresh, chooseSnapshot, pageSnapshots: direction => page("snapshots", direction), pageHistory: direction => page("history", direction), importFile, logout, close: () => close() };
}

if (typeof window !== "undefined") void startClient(window);
