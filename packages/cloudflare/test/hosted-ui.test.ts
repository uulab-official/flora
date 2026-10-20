import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertContrast, contrastStyles } from "../../../tests/css-contrast.ts";
import { randomBytes } from "node:crypto";

// Synthetic DOM/transport contract tests, not browser or backend integration tests.
class Element {
  children: Element[] = []; attributes: Record<string, string> = {}; value = ""; disabled = false; hidden = false; text = ""; className = ""; id = ""; type = ""; open = false; required = false; checked = false;
  files: File[] = []; listeners = new Map<string, ((event: any) => unknown)[]>();
  tagName: string; submitted = false;
  submit() { assert.equal(this.tagName, "form"); this.submitted = true; }
  remove() {}
  removeAttribute(name: string) { delete this.attributes[name]; }
  constructor(tagName = "div") { this.tagName = tagName; }
  set textContent(value: string) { this.text = value; this.children = []; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  set innerHTML(_value: string) { assert.fail("Untrusted content reached innerHTML"); }
  set outerHTML(_value: string) { assert.fail("Untrusted content reached outerHTML"); }
  get firstElementChild(): Element | null { return this.children[0] ?? null; }
  focus() {}
  setAttribute(name: string, value: string) { assert.ok(!/^on/.test(name)); this.attributes[name] = value; }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  closest(selector:string) { const match=/^(?:([a-z]+))?\[([^=\]]+)\]$/.exec(selector);return match&&(!match[1]||this.tagName===match[1])&&this.getAttribute(match[2]!)!==null?this:null; }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.text = ""; this.children = nodes; }
  addEventListener(type: string, handler: (event: any) => unknown) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]); }
  async dispatch(type: string) { for (const handler of this.listeners.get(type) ?? []) await handler({ target: this, preventDefault() {} }); }
}
class Document {
  body = new Element("body");
  nodes = new Map<string, Element>(); activeElement: Element | null = null; visibilityState = "visible";
  listeners = new Map<string, ((event: any) => unknown)[]>();
  constructor(file: string) {
    for (const match of readFileSync(new URL("../public/" + file, import.meta.url), "utf8").matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
      const node = new Element(match[1]); node.id = match[2]!; for (const attr of match[0].matchAll(/([a-zA-Z][\w-]*)="([^"]*)"/g)) node.attributes[attr[1]!] = attr[2]!; node.hidden = /\bhidden\b/.test(match[0]); node.disabled = /\bdisabled\b/.test(match[0]); this.nodes.set(node.id, node);
    }
  }
  querySelectorAll(selector: string) { return [...this.nodes.values()].filter(node => { const match = /^(?:([a-z]+))?\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/.exec(selector); return match && (!match[1] || node.tagName === match[1]) && node.getAttribute(match[2]!) !== null && (!match[3] || node.getAttribute(match[2]!) === match[3]); }); }
  createElement(tag: string) { return new Element(tag); }
  createElementNS(_namespace: string, tag: string) { return new Element(tag); }
  getElementById(id: string): Element {
    const find = (node: Element): Element | undefined => node.id === id ? node : node.children.map(find).find(Boolean);
    for (const node of this.nodes.values()) { const match = find(node); if (match) return match; }
    assert.fail("Missing HTML element: " + id);
  }
  addEventListener(type: string, handler: (event: any) => unknown) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]); }
  get text() { return [...this.nodes.values()].map(node => node.textContent).join("\n"); }
}
const appPath = new URL("../public/app.js", import.meta.url).href;
const authPath = new URL("../public/auth.js", import.meta.url).href;
const loadApp = () => import(appPath);
const loadAuth = () => import(authPath);
const now = 1_900_000_000_000;
const fact = (value: string | number) => ({ value, provenance: { path: "package.json", pointer: "/version", commitSha: "a".repeat(40), gitBlobSha: "b".repeat(40), repositoryId: "synthetic", fetchedAt: new Date(now).toISOString() } });
function state(id = "snapshot_a") {
  const selected = { id, digest: "d".repeat(64), repository: { id: "synthetic", fullName: "synthetic/app", visibility: "private" }, commitSha: "a".repeat(40), rootDirectory: ".", fetchedAt: new Date(now).toISOString(), importedAt: now, selectedFlavor: "demo", files: [{ path: "package.json", byteLength: 42, gitBlobSha: "b".repeat(40), sha256: "c".repeat(64) }], flavors: [{ id: "demo", appName: fact("합성 앱"), productType: fact("demo"), declaredPackage: fact("example.demo") }], runtime: { appVersion: fact("1.0.0"), nodeEngine: fact(">=24"), lockfileVersion: fact(9), packageEntryCount: fact(1), versions: { vite: null, vitest: null, expo: null, "react-native": null } }, evidenceOrigin: "operator-import", connection: "one-shot-source-snapshot" };
  return { selected, snapshots: { items: [{ id, digest: selected.digest, commitSha: selected.commitSha, importedAt: now }], nextCursor: null as string | null }, history: { items: [] as any[], nextCursor: null as string | null }, headObservation: null, freshness: "freshness_unknown", profile: { id: "config-runtime-smoke-v1", files: ["config.test.ts", "runtime.test.ts"], expectedTests: 4, coverage: "고정된 합성 검증 범위" }, runner: "unavailable" };
}
function record(id = "baseline_a") { return { id, snapshotId: "snapshot_a", state: "passed", code: null, createdAt: now, assessment: { files: 2, tests: 4, passed: 4, failed: 0, skipped: 0 }, platform: "linux", node: "24.19.0", exitCode: 0, evidenceDigest: "e".repeat(64), logTruncated: false }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function response(body: unknown, status = 200) { return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body }; }
type ClientState = ReturnType<typeof state> & { applications?: Array<{ id: string; name: string; createdAt: number }> };
async function controller(initial: ClientState = state(), intercept: (url: string, init: RequestInit) => Promise<any> = async () => undefined, overrides: Record<string, unknown> = {}) {
  const { startClient } = await loadApp(); const document = new Document("index.html"); const calls: { url: string; init: RequestInit }[] = []; const timers = new Map<number, { callback: () => void; delay: number }>(); const events = new Map<string, () => void>(); let nextTimer = 0; let current = initial; const csrf = randomBytes(32).toString("base64url"); let time = now;
  const env = { document, now: () => time, location: { pathname: "/projects", replace() {} }, history: { pushState() {}, replaceState() {} }, addEventListener: (type: string, handler: () => void) => events.set(type, handler),
    fetch: async (url: string, init: RequestInit) => { calls.push({ url, init }); return await intercept(url, init) ?? response(url === "/api/auth/session" ? { csrfToken: csrf, expiresAt: now + 3_600_000 } : url === "/api/projects" ? {projects: (current.applications ?? []).map(item => registrySummary(item.id, item.name)), observedAt: now} : current); },
    setTimeout(callback: () => void, delay: number) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; }, clearTimeout(id: number) { timers.delete(id); } };
  const client = await startClient({ ...env, ...overrides });
  return { client, document, calls, timers, events, csrf, setState(value: any) { current = value; }, setTime(value: number) { time = value; } };
}
async function authController(pathname = "/login", intercept: (url: string, init: RequestInit) => Promise<any> = async () => response({ csrfToken: randomBytes(32).toString("base64url"), expiresAt: now + 3_600_000 })) {
  const { startAuth } = await loadAuth(); const document = new Document("auth.html"); const calls: { url: string; init: RequestInit }[] = []; const navigations: string[] = []; const events = new Map<string, () => void>();
  const client = startAuth({ document, now: () => now, location: { pathname, replace: (url: string) => navigations.push(url) }, addEventListener: (type: string, handler: () => void) => events.set(type, handler), fetch: async (url: string, init: RequestInit) => { calls.push({ url, init }); return intercept(url, init); } });
  return { client, document, calls, navigations, events };
}
function credentials(document: Document, setup = false) {
  const password = " " + randomBytes(16).toString("hex") + "🙂 ";
  document.getElementById("email").value = "synthetic@example.test";
  document.getElementById("password").value = password;
  if (setup) { document.getElementById("confirmation").value = password; document.getElementById("token").value = randomBytes(32).toString("base64url"); }
  return password;
}

test("two_browser_sessions_revisit_same_imports", async () => {
  const data = state(); data.history.items = [record()]; const first = await controller(data); const second = await controller(data);
  for (const app of [first, second]) {
    assert.equal(app.calls[0]!.url, "/api/auth/session"); assert.equal(app.calls[1]!.url, "/api/me"); assert.equal(app.calls[2]!.url, "/api/state"); assert.ok(app.document.text.includes(data.selected.repository.fullName)); assert.ok(app.document.text.includes("사용자 반입")); assert.ok(app.document.text.includes("최신 여부 알 수 없음")); assert.ok(app.document.text.includes("호스팅에서는 실행할 수 없음")); app.client.close();
  }
  assert.notEqual(first.csrf, second.csrf);
});
test("page_navigation_preserves_selected_snapshot", async () => {
  const data = state(); data.snapshots.nextCursor = "synthetic-next"; data.history.nextCursor = "history-next";
  const app = await controller(data, async url => { if (url.includes("snapshotCursor=")) { const page = state(); page.snapshots.items = [state("snapshot_b").snapshots.items[0]!]; return response(page); } });
  await app.client.pageSnapshots("next");
  assert.equal(new URL(app.calls.at(-1)!.url, "https://synthetic.test").searchParams.get("snapshotId"), "snapshot_a");
  assert.equal(app.document.getElementById("snapshot-select").value, "snapshot_a"); assert.ok(app.document.getElementById("snapshot-select").textContent.includes("현재 선택"));
  await app.client.pageSnapshots("previous"); assert.equal(new URL(app.calls.at(-1)!.url, "https://synthetic.test").searchParams.get("snapshotCursor"), null);
  await app.client.pageHistory("next"); assert.equal(new URL(app.calls.at(-1)!.url, "https://synthetic.test").searchParams.get("historyCursor"), "history-next"); app.client.close();
});
for (const kind of ["snapshots", "history"] as const) test(`failed_${kind}_next_preserves_page_history_for_retry_and_previous`, async () => {
  const initial = state(); initial[kind].nextCursor = "second-page";
  const second = state(); second[kind].nextCursor = "third-page";
  let attempts = 0;
  const cursorName = kind === "snapshots" ? "snapshotCursor" : "historyCursor";
  const label = kind === "snapshots" ? "snapshot-page" : "history-page";
  const app = await controller(initial, async url => {
    if (new URL(url, "https://synthetic.test").searchParams.get(cursorName) === "second-page") {
      if (++attempts === 1) return response({ error: "UNAVAILABLE" }, 503);
      return response(second);
    }
  });
  const page = kind === "snapshots" ? app.client.pageSnapshots : app.client.pageHistory;
  await page("next"); assert.ok(app.document.getElementById(label).textContent.startsWith("1페이지"));
  await page("next"); assert.ok(app.document.getElementById(label).textContent.startsWith("2페이지"));
  await page("previous"); assert.equal(new URL(app.calls.at(-1)!.url, "https://synthetic.test").searchParams.get(cursorName), null);
  assert.ok(app.document.getElementById(label).textContent.startsWith("1페이지")); app.client.close();
});
for (const kind of ["snapshots", "history"] as const) test(`failed_${kind}_previous_keeps_the_current_page_until_retry_succeeds`, async () => {
  const initial = state(); initial[kind].nextCursor = "second-page"; const second = state(); let failPrevious = false;
  const cursorName = kind === "snapshots" ? "snapshotCursor" : "historyCursor"; const label = kind === "snapshots" ? "snapshot-page" : "history-page";
  const app = await controller(initial, async url => {
    if (!url.startsWith("/api/state")) return;
    if (new URL(url, "https://synthetic.test").searchParams.get(cursorName) === "second-page") return response(second);
    if (failPrevious) { failPrevious = false; return response({ error: "UNAVAILABLE" }, 503); }
  });
  const page = kind === "snapshots" ? app.client.pageSnapshots : app.client.pageHistory;
  await page("next"); failPrevious = true; await page("previous");
  assert.ok(app.document.getElementById(label).textContent.startsWith("2페이지"));
  await page("previous"); assert.ok(app.document.getElementById(label).textContent.startsWith("1페이지")); app.client.close();
});
test("logs_load_only_on_expand_and_remain_text_only", async () => {
  const data = state(); data.history.items = [record()]; const app = await controller(data, async url => url.endsWith("/log") ? response({ id: "baseline_a", safeLog: '<img src=x onerror="bad">' + "🙂".repeat(30_000), logTruncated: true }) : undefined);
  assert.equal(app.calls.filter(call => call.url.endsWith("/log")).length, 0);
  const details = app.document.getElementById("log-baseline_a"); details.open = true; await details.dispatch("toggle");
  assert.equal(app.calls.filter(call => call.url.endsWith("/log")).length, 1); assert.ok(details.textContent.includes("<img"));
  const log = details.children.find(child => child.tagName === "pre")!; assert.ok(Buffer.byteLength(log.textContent) <= 65_536);
  await details.dispatch("toggle"); assert.equal(app.calls.filter(call => call.url.endsWith("/log")).length, 1); app.client.close();
});
for (const operation of ["refresh", "import"] as const) for (const status of [200, 503]) test(`pending_log_${status}_remains_recoverable_after_failed_${operation}`, async () => {
  const data = state(); data.history.items = [record()]; const pending = deferred<any>(); let refreshFails = false; let logCalls = 0;
  const app = await controller(data, async url => {
    if (url.endsWith("/log")) { if (++logCalls === 1) return pending.promise; return response({ id: "baseline_a", safeLog: "recovered synthetic log", logTruncated: false }); }
    if (refreshFails && url.startsWith("/api/state")) return response({ error: "UNAVAILABLE" }, 503);
    if (url === "/api/sources") return response({ error: "UNAVAILABLE" }, 503);
  });
  const details = app.document.getElementById("log-baseline_a"); details.open = true; const opening = details.dispatch("toggle");
  if (operation === "refresh") { refreshFails = true; await app.client.refresh(); }
  else await app.client.importFile("source", new File(["{}"], "synthetic.json"));
  pending.resolve(response({ id: "baseline_a", safeLog: "completed synthetic log", logTruncated: false }, status)); await opening;
  details.open = false; await details.dispatch("toggle"); details.open = true; await details.dispatch("toggle");
  assert.ok(details.textContent.includes("synthetic log")); assert.ok(!details.textContent.includes("불러오는 중"));
  assert.ok(app.document.getElementById("notice").textContent.includes(operation === "refresh" ? "불러오지 못" : "확인하지 못")); app.client.close();
});
test("old_log_failure_cannot_delete_the_new_view_pending_marker", async () => {
  const data = state(); data.history.items = [record()]; const old = deferred<any>(); const newer = deferred<any>(); let calls = 0;
  const app = await controller(data, async url => url.endsWith("/log") ? ++calls === 1 ? old.promise : newer.promise : undefined);
  const oldDetails = app.document.getElementById("log-baseline_a"); oldDetails.open = true; const oldOpening = oldDetails.dispatch("toggle");
  await app.client.refresh(); const newDetails = app.document.getElementById("log-baseline_a"); newDetails.open = true; const newOpening = newDetails.dispatch("toggle");
  old.resolve(response({ error: "UNAVAILABLE" }, 503)); await oldOpening;
  await newDetails.dispatch("toggle"); assert.equal(calls, 2);
  newer.resolve(response({ id: "baseline_a", safeLog: "new view log", logTruncated: false })); await newOpening;
  assert.ok(newDetails.textContent.includes("new view log")); app.client.close();
});
test("session_expiry_clears_private_dom_without_network_polling", async () => {
  const app = await controller(); assert.equal(app.timers.size, 2); const expiry = [...app.timers.values()].find(timer=>timer.delay===3_600_000)!; assert.equal(expiry.delay, 3_600_000);
  const calls = app.calls.length; app.setTime(now + 3_600_000); expiry.callback();
  assert.ok(!app.document.text.includes("synthetic/app")); assert.equal(app.document.getElementById("source-file").disabled, true); assert.equal(app.document.getElementById("login-link").hidden, false);
  await app.client.refresh(); assert.equal(app.calls.length, calls); app.client.close();
});
test("hosted_ui_never_calls_legacy_runs_and_only_polls_lightweight_visible_summary", async () => {
  const app = await controller(); await app.client.refresh();
  assert.ok(app.calls.every(call => !/runs|cancel|providers/.test(call.url))); assert.deepEqual([...app.timers.values()].map(timer=>timer.delay).sort((a,b)=>a-b),[60000,3600000]);
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8"); assert.ok(!/setInterval|\/api\/runs|localStorage|console\./.test(source)); app.client.close();
});
test("original_file_bytes_and_exact_import_limits_use_session_csrf", async () => {
  const app = await controller(state(), async url => url === "/api/sources" ? response(state().selected) : url.startsWith("/api/baselines?") ? response(record()) : undefined);
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x20, 0x7d, 0x0a]); const file = new File([bytes], "synthetic.json", { type: "application/json" });
  await app.client.importFile("source", file);
  const request = app.calls.find(call => call.url === "/api/sources")!; assert.equal(request.init.body, file); assert.equal(new Headers(request.init.headers).get("X-Flora-CSRF"), app.csrf);
  await app.client.importFile("source", new File([new Uint8Array(1_048_576)], "boundary.json"));
  const count = app.calls.length; await app.client.importFile("source", new File([new Uint8Array(1_048_577)], "too-large.json")); assert.equal(app.calls.length, count);
  await app.client.importFile("baseline", new File([new Uint8Array(131_072)], "boundary.json"));
  const baselineCount = app.calls.length; await app.client.importFile("baseline", new File([new Uint8Array(131_073)], "too-large.json")); assert.equal(app.calls.length, baselineCount); app.client.close();
});
test("lost_import_response_is_not_success_and_repeat_clicks_are_serialized", async () => {
  const gate = deferred<void>(); const app = await controller(state(), async url => { if (url === "/api/sources") { await gate.promise; throw new Error("synthetic response lost"); } }); const file = new File(["{}"], "synthetic.json");
  const pending = app.client.importFile("source", file); await app.client.importFile("source", file); assert.equal(app.calls.filter(call => call.url === "/api/sources").length, 1);
  gate.resolve(); await pending; assert.ok(app.document.getElementById("notice").textContent.includes("확인하지 못")); assert.equal(app.document.getElementById("retry-button").hidden, false); app.client.close();
});
// These fail if upload errors auto-resubmit, the retry control sends a POST,
// 403 erases a valid session, or 401 leaves private state / late responses alive.
for (const kind of ["source", "baseline"] as const) for (const outcome of ["network", "forbidden"] as const) test(`${kind}_${outcome}_keeps_verified_history_until_explicit_reload_and_file_reselection`, async () => {
  const data = state(); data.history.items = [record()]; let posts = 0;
  const path = kind === "source" ? "/api/sources" : "/api/baselines?snapshotId=snapshot_a";
  const app = await controller(data, async url => {
    if (url.endsWith("/log")) return response({ id: "baseline_a", safeLog: "verified private log", logTruncated: false });
    if (url !== path) return;
    if (++posts === 1) {
      if (outcome === "network") throw new TypeError("Failed to fetch");
      return response({ error: "FORBIDDEN" }, 403);
    }
    return response(kind === "source" ? data.selected : data.history.items[0], 201);
  });
  const log = app.document.getElementById("log-baseline_a"); log.open = true; await log.dispatch("toggle");
  const before = ["app-name", "source-details", "baseline-history", "flavor-detail"].map(id => app.document.getElementById(id).textContent);
  const file = new File([" original bytes\n"], "original.json", { type: "application/json" });
  const input = app.document.getElementById(kind + "-file"); input.files = [file]; input.value = "original.json";
  await input.dispatch("change");
  const notice = app.document.getElementById("notice");
  assert.equal(notice.getAttribute("role"), "alert"); assert.ok(!notice.className.includes("notice-success"));
  assert.ok(notice.textContent.includes(outcome === "network" ? "반입 완료 여부를 확인하지 못" : "요청 권한"));
  if (outcome === "forbidden") assert.ok(!notice.textContent.includes("반입 완료 여부"));
  assert.deepEqual(["app-name", "source-details", "baseline-history", "flavor-detail"].map(id => app.document.getElementById(id).textContent), before);
  assert.equal(app.document.getElementById("workspace").getAttribute("aria-busy"), "false");
  assert.equal(input.value, ""); assert.equal(input.disabled, false); assert.equal(posts, 1);
  assert.equal(app.document.getElementById("login-link").hidden, true);
  assert.equal(app.document.getElementById("retry-button").hidden, false);
  const callsBeforeReload = app.calls.length; await app.document.getElementById("retry-button").dispatch("click");
  assert.deepEqual(app.calls.slice(callsBeforeReload).map(call => [call.url, call.init.method]), [["/api/me","GET"],["/api/state?snapshotId=snapshot_a", "GET"]]);
  assert.equal(posts, 1); assert.equal(input.value, "");
  input.files = [file]; input.value = "original.json"; await input.dispatch("change");
  assert.equal(posts, 2); assert.equal(input.value, "");
  assert.ok(notice.className.includes("notice-success"));
  for (const call of app.calls.filter(call => call.url === path)) assert.strictEqual(call.init.body, file);
  assert.equal(app.document.getElementById("baseline-history").children.length, 1); app.client.close();
});
for (const kind of ["source", "baseline"] as const) test(`${kind}_401_erases_private_dom_inputs_and_fences_late_log_then_requires_fresh_login`, async () => {
  const data = state(); data.history.items = [record()]; const lateLog = deferred<any>();
  const path = kind === "source" ? "/api/sources" : "/api/baselines?snapshotId=snapshot_a";
  const app = await controller(data, async url => url.endsWith("/log") ? lateLog.promise : url === path ? response({ error: "UNAUTHENTICATED" }, 401) : undefined);
  const log = app.document.getElementById("log-baseline_a"); log.open = true; const loading = log.dispatch("toggle");
  for (const id of ["source-file", "baseline-file"]) app.document.getElementById(id).value = "original.json";
  const file = new File([" original bytes\n"], "original.json"); await app.client.importFile(kind, file);
  function cleared() {
    for (const id of ["app-name", "snapshot-select", "flavor-select", "source-details", "baseline-history", "flavor-detail", "app-rows", "recent-history", "app-search"]) {
      assert.equal(app.document.getElementById(id).textContent, "", id); assert.equal(app.document.getElementById(id).value, "", id);
    }
    for (const id of ["source-file", "baseline-file"]) { assert.equal(app.document.getElementById(id).value, ""); assert.equal(app.document.getElementById(id).disabled, true); }
    for (const id of ["snapshot-select", "flavor-select", "logout-button", "snapshot-previous", "snapshot-next", "history-previous", "history-next", "retry-button", "app-search", "app-source-filter", "app-sort", "app-previous", "app-next", "nav-apps", "mobile-apps"]) assert.equal(app.document.getElementById(id).disabled, true, id);
    assert.equal(app.document.getElementById("dashboard-content").hidden, true);
    assert.equal(app.document.getElementById("app-detail").hidden, true);
    assert.ok(!app.document.text.includes("synthetic/app")); assert.ok(!app.document.text.includes("baseline_a"));
    assert.equal(app.document.getElementById("login-link").hidden, false);
    assert.equal(app.document.getElementById("retry-button").hidden, true);
    assert.ok(app.document.getElementById("notice").textContent.includes("다시 로그인"));
    assert.ok(!app.document.getElementById("notice").className.includes("notice-success"));
  }
  cleared(); lateLog.resolve(response({ id: "baseline_a", safeLog: "late private log", logTruncated: false })); await loading; cleared();
  assert.ok(!app.document.text.includes("late private log")); const count = app.calls.length;
  await app.client.refresh(); await app.client.importFile(kind, file); assert.equal(app.calls.length, count);
  app.client.close();
  // A 401 is not evidence of no write: the authority can recheck after D1
  // commits. Backend commit/revocation is covered in worker.test.ts; this
  // client contract checks the fresh-session path over an existing receipt.
  const fresh = await controller(data, async url => url === path ? response(kind === "source" ? data.selected : data.history.items[0], 201) : undefined);
  assert.equal(fresh.calls[0]!.url, "/api/auth/session"); assert.notEqual(fresh.csrf, app.csrf);
  await fresh.client.importFile(kind, file);
  assert.strictEqual(fresh.calls.find(call => call.url === path)!.init.body, file);
  assert.equal(fresh.document.getElementById("snapshot-select").value, data.selected.id);
  assert.equal(fresh.document.getElementById("baseline-history").children.length, 1);
  assert.ok(fresh.document.getElementById("notice").className.includes("notice-success")); fresh.client.close();
});
test("quota_network_and_database_failure_never_become_empty_history", async () => {
  const app = await controller(state(), async url => url === "/api/state" ? response({ error: "UNAVAILABLE" }, 503) : undefined);
  assert.equal(app.document.getElementById("empty").hidden, true); assert.equal(app.document.getElementById("dashboard-content").hidden, true); assert.ok(app.document.getElementById("notice").textContent.includes("불러오지 못"));
  app.client.close();
});
test("D1 daily quota shows reset guidance and never reports an unread project registry as zero", async () => {
  for (const code of ["D1_DAILY_READ_LIMIT", "D1_DAILY_WRITE_LIMIT"]) {
    const app = await controller(state(), async url => url === "/api/state" ? response({ error: code }, 503) : undefined);
    assert.ok(app.document.getElementById("notice").textContent.includes("한도가 초기화"));
    assert.ok(app.document.getElementById("notice").textContent.includes("기존 데이터와 이력은 보존"));
    assert.equal(app.document.getElementById("project-total").textContent, "프로젝트 수 미확인");
    assert.equal(app.document.getElementById("project-summary-refresh").disabled, true);
    assert.ok(app.document.getElementById("project-summary-status").textContent.includes("미확인"));
    app.client.close();
  }
});
test("logout_and_navigation_clear_dom_and_discard_late_responses", async () => {
  const gate = deferred<any>(); let hold = false; const app = await controller(state(), async (url, init) => { if (url === "/api/auth/logout") return response(null, 204); if (hold && url.startsWith("/api/state")) return gate.promise; });
  hold = true; const pending = app.client.refresh(); await app.client.logout(); assert.ok(!app.document.text.includes("synthetic/app"));
  const logout = app.calls.find(call => call.url === "/api/auth/logout")!; assert.equal(new Headers(logout.init.headers).get("X-Flora-CSRF"), app.csrf);
  gate.resolve(response(state())); await pending; assert.ok(!app.document.text.includes("synthetic/app"));
  const second = await controller(); second.events.get("pagehide")!(); assert.ok(!second.document.text.includes("synthetic/app")); second.client.close(); app.client.close();
});
test("new_snapshot_selection_fences_old_success_and_failure", async () => {
  for (const status of [200, 401, 503]) {
    const gate = deferred<any>(); const next = state("snapshot_b"); next.selected.repository.fullName = "synthetic/new";
    const app = await controller(state(), async url => url.includes("snapshotId=snapshot_old") ? gate.promise : url.includes("snapshotId=snapshot_b") ? response(next) : undefined);
    const pending = app.client.chooseSnapshot("snapshot_old"); await app.client.chooseSnapshot("snapshot_b"); gate.resolve(response(state(), status)); await pending;
    assert.equal(app.document.getElementById("app-name").textContent, "synthetic/new"); assert.equal(app.document.getElementById("notice").hidden, true); app.client.close();
  }
});
test("login_and_setup_allow_paste_without_password_storage", async () => {
  const html = readFileSync(new URL("../public/auth.html", import.meta.url), "utf8"); assert.ok(!/maxlength|onpaste|oncopy|oncut|uulab|gmail\.com/.test(html));
  for (const pathname of ["/login", "/setup"]) {
    const app = await authController(pathname); const password = credentials(app.document, pathname === "/setup"); await app.client.submit();
    const sent = JSON.parse(String(app.calls[0]!.init.body)); assert.equal(sent.password, password); assert.deepEqual(app.navigations, [pathname === "/setup" ? "/onboarding" : "/"]); assert.equal(app.document.getElementById("password").value, "");
    if (pathname === "/setup") { assert.equal(sent.confirmation, password); assert.equal(app.calls[0]!.url, "/api/auth/enroll"); assert.equal(app.document.getElementById("token").value, ""); }
    app.client.close();
  }
  for (const name of ["auth.js", "app.js"]) assert.ok(!/localStorage|console\.|document\.cookie|history\.(?:pushState|replaceState)/.test(readFileSync(new URL("../public/" + name, import.meta.url), "utf8")));
});
test("setup_validates_codepoints_without_normalizing_and_requires_owner_code", async () => {
  const { validPassword } = await loadAuth(); assert.equal(validPassword("🙂".repeat(128)), true); assert.equal(validPassword("🙂".repeat(129)), false); assert.equal(validPassword(" ".repeat(15)), true); assert.equal(validPassword("a".repeat(14)), false); assert.equal(validPassword("a".repeat(15) + "\ud800"), false);
  const app = await authController("/setup"); credentials(app.document, true); app.document.getElementById("token").value = ""; await app.client.submit(); assert.equal(app.calls.length, 0);
  assert.ok(app.document.getElementById("auth-description").textContent.includes("소유자")); assert.ok(app.document.getElementById("auth-description").textContent.includes("승인 코드")); app.client.close();
});
test("recovery_mode_uses_exact_endpoint_and_no_url_secret", async () => {
  const app = await authController("/setup"); app.document.getElementById("setup-mode").value = "recover"; await app.document.getElementById("setup-mode").dispatch("change"); credentials(app.document, true); await app.client.submit();
  assert.equal(app.calls[0]!.url, "/api/auth/recover"); assert.deepEqual(Object.keys(JSON.parse(String(app.calls[0]!.init.body))).sort(), ["confirmation", "email", "password", "token"]); app.client.close();
});
test("auth_duplicate_submission_navigation_and_errors_never_show_stale_success", async () => {
  const gate = deferred<any>(); const app = await authController("/login", async () => gate.promise); credentials(app.document); const pending = app.client.submit(); await app.client.submit(); assert.equal(app.calls.length, 1);
  assert.equal(app.document.getElementById("password").value, ""); app.events.get("pagehide")!(); gate.resolve(response({ csrfToken: randomBytes(32).toString("base64url"), expiresAt: now + 3_600_000 })); await pending; assert.deepEqual(app.navigations, []);
  const failed = await authController("/login", async () => response({ error: "UNAVAILABLE" }, 503)); credentials(failed.document); await failed.client.submit(); assert.deepEqual(failed.navigations, []); assert.equal(failed.document.getElementById("auth-submit").disabled, false); assert.ok(failed.document.getElementById("auth-status").textContent.includes("완료하지 못")); app.client.close(); failed.client.close();
});
test("interrupted_setup_guides_to_login_without_reusing_a_consumed_code", async () => {
  const app = await authController("/setup", async () => { throw new Error("synthetic response lost"); }); credentials(app.document, true); await app.client.submit();
  assert.ok(app.document.getElementById("auth-status").textContent.includes("새 비밀번호로 로그인")); assert.equal(app.document.getElementById("token").value, ""); assert.deepEqual(app.navigations, []); app.client.close();
});
test("private_rendering_preserves_provenance_and_rejects_markup", async () => {
  const data = state(); data.selected.repository.fullName = '<svg onload="bad">\x1b[31m'; const app = await controller(data);
  assert.ok(app.document.text.includes("<svg")); assert.ok(!app.document.text.includes("\x1b")); assert.ok(app.document.text.includes("package.json · /version")); assert.ok(app.document.text.includes(data.selected.files[0]!.sha256)); app.client.close();
});

test("late_logout_response_after_navigation_cannot_restore_status", async () => {
  const gate = deferred<any>(); const app = await controller(state(), async url => url === "/api/auth/logout" ? gate.promise : undefined);
  const pending = app.client.logout(); app.events.get("pagehide")!(); gate.resolve(response(null, 204)); await pending;
  assert.equal(app.document.getElementById("notice").textContent, ""); app.client.close();
});
test("baseline_receipt_must_match_selected_snapshot_before_success", async () => {
  for (const receipt of [{}, { ...record(), snapshotId: "wrong_snapshot" }]) {
    const app = await controller(state(), async url => url.startsWith("/api/baselines?") ? response(receipt) : undefined);
    await app.client.importFile("baseline", new File(["{}"], "synthetic.json"));
    assert.ok(app.document.getElementById("notice").textContent.includes("확인하지 못")); assert.ok(!app.document.getElementById("notice").className.includes("notice-success")); app.client.close();
  }
});
test("compact_import_confirmation_never_hides_loading_failure_or_expiry_status", async () => {
  let nextRead: ReturnType<typeof deferred<any>> | undefined;
  const readStarted = deferred<void>();
  const app = await controller(state(), async url => {
    if (url === "/api/sources") return response(state().selected);
    if (url.startsWith("/api/state") && nextRead) { readStarted.resolve(); return nextRead.promise; }
  });
  await app.client.importFile("source", new File(["{}"], "synthetic.json"));
  const notice = app.document.getElementById("notice");
  assert.equal(notice.hidden, false); assert.equal(notice.getAttribute("role"), "status");
  assert.ok(notice.className.includes("notice-success")); assert.ok(notice.textContent.includes("사용자 반입"));
  nextRead = deferred<any>(); const refreshing = app.client.refresh(); await readStarted.promise;
  assert.equal(notice.hidden, false); assert.ok(!notice.className.includes("notice-success")); assert.ok(notice.textContent.includes("불러오는 중"));
  nextRead.resolve(response({ error: "UNAVAILABLE" }, 503)); await refreshing;
  assert.equal(notice.hidden, false); assert.equal(notice.getAttribute("role"), "alert");
  assert.ok(!notice.className.includes("notice-success")); assert.equal(app.document.getElementById("retry-button").hidden, false);
  nextRead = undefined; await app.client.importFile("source", new File(["{}"], "synthetic.json"));
  assert.ok(notice.className.includes("notice-success"));
  app.setTime(now + 3_600_000); [...app.timers.values()][0]!.callback();
  assert.equal(notice.hidden, false); assert.equal(notice.getAttribute("role"), "alert");
  assert.ok(!notice.className.includes("notice-success")); assert.ok(notice.textContent.includes("만료")); app.client.close();
});
test("malformed_session_never_reveals_state_or_navigates", async () => {
  const app = await controller(state(), async url => url === "/api/auth/session" ? response({ csrfToken: "", expiresAt: now + 1000 }) : undefined);
  assert.equal(app.calls.length, 1); assert.equal(app.document.getElementById("dashboard-content").hidden, true); app.client.close();
  const auth = await authController("/login", async () => response({ csrfToken: "", expiresAt: now + 1000 })); credentials(auth.document); await auth.client.submit(); assert.deepEqual(auth.navigations, []); auth.client.close();
});
test("log_denial_clears_every_private_field_and_network_failure_is_retryable", async () => {
  for (const status of [401, 503]) {
    const data = state(); data.history.items = [record()]; const app = await controller(data, async url => url.endsWith("/log") ? response({ error: "UNAVAILABLE" }, status) : undefined);
    const details = app.document.getElementById("log-baseline_a"); details.open = true; await details.dispatch("toggle");
    if (status === 401) assert.ok(!app.document.text.includes("synthetic/app"));
    else { assert.ok(details.textContent.includes("불러오지 못")); await details.dispatch("toggle"); assert.equal(app.calls.filter(call => call.url.endsWith("/log")).length, 2); }
    app.client.close();
  }
});
test("generic_conflict_explains_possible_app_or_storage_limit_causes", async () => {
  const app = await controller(state(), async url => url === "/api/sources" ? response({ error: "CONFLICT" }, 409) : undefined);
  await app.client.importFile("source", new File(["{}"], "synthetic.json"));
  const text = app.document.getElementById("notice").textContent; assert.ok(text.includes("현재 앱")); assert.ok(text.includes("저장 한도")); assert.ok(text.includes("기존 이력")); assert.ok(!text.includes("맞지 않습니다")); assert.ok(!text.includes("새 앱")); app.client.close();
});
test("auth_style_keeps_keyboard_focus_and_readable_contrast", () => {
  const html = readFileSync(new URL("../public/auth.html", import.meta.url), "utf8"); const css = readFileSync(new URL("../public/auth.css", import.meta.url), "utf8");
  assert.ok(css.includes(":focus-visible")); assert.ok(css.includes("@media(max-width:580px)")); assert.ok(html.includes('lang="ko"')); assert.ok(html.includes('type="password" autocomplete="current-password"'));
  const styles = contrastStyles(css);
  for (const [foreground, backgrounds] of Object.entries({
    ":root": [":root", ".auth-card"], "a": [".auth-card"], ".private-label": [".auth-brand"], ".auth-brand .private-label": [".auth-brand"],
    ".auth-brand>span:first-child": [".auth-brand"], ".auth-brand .brand": [".auth-brand"], ".eyebrow": [".auth-card"],
    ".description": [".auth-card"], "input,select": ["input,select"], ".field-note": [".auth-card"], "button": ["button", "button:hover"],
    ".auth-status": [".auth-status"], ".auth-footer": [":root"],
  })) {
    for (const background of backgrounds) assertContrast(styles.color(foreground), styles.color(background, "background"), 4.5, foreground);
  }
  for (const surface of [":root", ".auth-card", ".auth-brand", "input,select"]) {
    assertContrast(styles.color("a:focus-visible,input:focus-visible,select:focus-visible,button:focus-visible", "outline"), styles.color(surface, "background"), 3, "auth focus on " + surface);
  }
});

test("shared_palette_uses_actual_control_navigation_and_focus_colors", () => {
  const app = contrastStyles(readFileSync(new URL("../public/app.css", import.meta.url), "utf8"));
  const auth = contrastStyles(readFileSync(new URL("../public/auth.css", import.meta.url), "utf8"));
  const local = contrastStyles(readFileSync(new URL("../../dashboard/public/app.css", import.meta.url), "utf8"));
  // Each surface may have its own palette; verify controls against that surface.
  assert.equal(app.color(".primary", "background"), app.color(":root", "--accent"));
  assert.equal(auth.color("button", "background"), auth.color(":root", "--accent"));
  assert.equal(local.color(".primary", "background"), local.color(":root", "--accent"));
  const activeNav = '.nav-item.active,.nav-item[aria-current="page"],.nav-item[data-admin-current="true"]';
  const success = '.badge.success,.success';
  for (const [foreground, background] of [
    [".primary", ".primary"], [".primary", ".primary:hover:enabled"],
    ["a", ":root"], ["a", ".studio-sidebar"], [activeNav, activeNav],
    [".nav-item:hover", ".nav-item:hover"], [".page-number", ".page-number"],
    [".text-button", ":root"], [".secondary", ".secondary"], [".secondary", ".secondary:hover:enabled"],
    [".icon-button:hover:enabled", ".icon-button:hover:enabled"],
    [".app-open", ".app-table tbody tr:hover,.app-table tbody tr:focus-within"],
    [success, success], [".badge.warning,.warning-text", ".badge.warning"],
  ] as const) assertContrast(app.color(foreground), app.color(background, "background"), 4.5, foreground);
  for (const surface of [":root", ".studio-sidebar", activeNav, ".app-table tbody tr:hover,.app-table tbody tr:focus-within", ".page-number"])
    assertContrast(app.color(":focus-visible", "outline"), app.color(surface, "background"), 3, "console focus on " + surface);

});

function multipleFlavors(count = 11) {
  const data = state();
  data.selected.flavors = Array.from({ length: count }, (_, index) => ({ id: `sample-${index + 1}`, appName: fact(`Sample App ${index + 1}`), productType: fact("demo"), declaredPackage: fact(`example.sample${index + 1}`) }));
  data.selected.selectedFlavor = "sample-1";
  return data;
}

test("console_reports_one_imported_source_and_declared_flavors_without_live_metrics", async () => {
  const data = multipleFlavors(); const app = await controller(data);
  assert.equal(app.document.getElementById("app-count").textContent, "11");
  assert.equal(app.document.getElementById("source-count").textContent, "1");
  const rows = app.document.getElementById("app-rows").children;
  assert.equal(rows.length, 10); assert.ok(rows[0]!.textContent.includes("Sample App 1"));
  assert.ok(rows[0]!.textContent.includes("synthetic/app")); assert.ok(rows[0]!.textContent.includes("1.0.0"));
  assert.equal((rows[0]!.textContent.match(/미연결/g) ?? []).length, 2);
  assert.ok(rows[0]!.textContent.includes("선택 앱 OTA에서 확인"));
  assert.ok(!rows[0]!.textContent.includes("통과"));
  assert.ok(app.document.getElementById("app-pagination").textContent.includes("11개 flavor")); app.client.close();
});

test("console_search_sort_and_local_paging_use_imported_facts_without_requests", async () => {
  const app = await controller(multipleFlavors()); const count = app.calls.length;
  await app.document.getElementById("app-next").dispatch("click");
  assert.equal(app.document.getElementById("app-rows").children.length, 1);
  assert.ok(app.document.getElementById("app-rows").textContent.includes("Sample App 11"));
  const search = app.document.getElementById("app-search"); search.value = "example.sample3"; await search.dispatch("input");
  assert.equal(app.document.getElementById("app-rows").children.length, 1);
  assert.ok(app.document.getElementById("app-rows").textContent.includes("Sample App 3"));
  search.value = "no matching app"; await search.dispatch("input"); assert.equal(app.document.getElementById("app-empty").hidden, false);
  search.value = ""; await search.dispatch("input"); const sort = app.document.getElementById("app-sort"); sort.value = "name-desc"; await sort.dispatch("change");
  assert.ok(app.document.getElementById("app-rows").children[0]!.textContent.includes("Sample App 11"));
  assert.equal(app.calls.length, count); app.client.close();
});

test("console_navigation_and_row_details_preserve_source_scoped_history", async () => {
  const data = { ...multipleFlavors(), applications: registryState("app_a").applications, selectedApplication: registryApp("app_a") }; data.history.items = [record()];
  const app = await controller(data as any, async url => url.endsWith("/operations") ? response(ops()) : undefined);
  await app.client.navigate("source", "app_a");
  await app.document.getElementById("flavor-row-sample-2").dispatch("click");
  assert.equal(app.document.getElementById("app-detail").hidden, false);
  assert.equal(app.document.getElementById("flavor-select").value, "sample-2");
  assert.ok(app.document.getElementById("flavor-detail").textContent.includes("example.sample2"));
  assert.ok(app.document.getElementById("flavor-detail").textContent.includes("선언 버전1.0.0"));
  assert.ok(app.document.getElementById("flavor-detail").textContent.includes("package.json · /version"));
  await app.document.getElementById("detail-close").dispatch("click"); assert.equal(app.document.getElementById("app-detail").hidden, true);
  for (const [page, section] of [["source", "page-source"], ["activity", "page-activity"], ["projects", "application-panel"]] as const) {
    await app.client.navigate(page, "app_a");
    assert.equal(app.document.getElementById(section).hidden, false);
    for (const other of ["page-source", "page-activity", "application-panel"]) assert.equal(app.document.getElementById(other).hidden, other !== section);
  }
  await app.client.navigate("activity", "app_a");
  assert.ok(app.document.getElementById("history-scope").textContent.includes("synthetic/app"));
  assert.ok(app.document.getElementById("history-scope").textContent.includes("flavor의 실행 결과가 아닙니다"));
  app.client.close();
});

test("console_empty_source_never_invents_apps_or_metrics", async () => {
  const data: any = registryState("app_a"); data.selected = null; data.snapshots.items = [];
  const app = await controller(data); await app.client.navigate("source", "app_a"); assert.equal(app.document.getElementById("empty").hidden, false);
  assert.equal(app.document.getElementById("dashboard-content").hidden, true);
  assert.equal(app.document.getElementById("app-count").textContent, "0");
  assert.equal(app.document.getElementById("source-count").textContent, "0"); app.client.close();
});

test("console_session_close_erases_table_detail_search_and_recent_history", async () => {
  const data = multipleFlavors(); data.history.items = [record()]; const app = await controller(data);
  const search = app.document.getElementById("app-search"); search.value = "Sample App 2"; await search.dispatch("input");
  await app.document.getElementById("flavor-row-sample-2").dispatch("click"); app.client.close();
  assert.equal(search.value, ""); assert.ok(!app.document.text.includes("Sample App")); assert.ok(!app.document.text.includes("synthetic/app"));
  assert.ok(!app.document.text.includes("baseline_a")); assert.equal(app.document.getElementById("app-detail").hidden, true);
  assert.equal(app.document.getElementById("app-rows").children.length, 0);
});

test("console_landing_naturally_orders_names_while_explicit_source_order_preserves_provenance", async () => {
  const data = multipleFlavors(); data.selected.flavors.sort((a, b) => a.id.localeCompare(b.id));
  const originalIds = data.selected.flavors.map(flavor => flavor.id); const app = await controller(data);
  const rowNames = () => app.document.getElementById("app-rows").children.map(row => row.children[0]!.textContent);
  assert.equal(app.document.getElementById("app-sort").value, "name-asc");
  for (let index = 0; index < 4; index++) assert.ok(rowNames()[index]!.includes(`Sample App ${index + 1}`));
  const sort = app.document.getElementById("app-sort"); sort.value = "source-order"; await sort.dispatch("change");
  assert.ok(rowNames()[1]!.includes("Sample App 10")); assert.ok(rowNames()[2]!.includes("Sample App 11"));
  assert.deepEqual(data.selected.flavors.map(flavor => flavor.id), originalIds); app.client.close();
});

test("expiry_during_console_render_cannot_repopulate_private_dom_or_clear_expiry_notice", async () => {
  const { startClient } = await loadApp(); const document = new Document("index.html"); const data = state(); data.history.items = [record()];
  const deadline = now + 10; let reads = 0; let calls = 0;
  const client = await startClient({ document, now: () => ++reads < 4 ? deadline - 1 : deadline,
    fetch: async (url: string) => { calls++; return response(url === "/api/auth/session" ? { csrfToken: randomBytes(32).toString("base64url"), expiresAt: deadline } : data); },
    setTimeout: () => 1, clearTimeout() {}, addEventListener() {}, location: { replace() {} } });
  assert.ok(reads >= 4);
  for (const id of ["app-name", "freshness", "snapshot-select", "snapshot-page", "source-meta", "trust-note", "source-details", "flavor-count", "flavor-select", "flavor-detail", "runtime", "profile", "provider", "history-page", "baseline-history", "empty", "app-count", "source-count", "app-rows", "app-pagination", "app-page-number", "app-search", "app-source-filter", "mobile-source-name", "mobile-flavor-count", "detail-title", "history-scope", "recent-history"]) {
    assert.equal(document.getElementById(id).textContent, "", `${id} must remain erased`);
    assert.equal(document.getElementById(id).value, "", `${id} must not retain a private value`);
  }
  for (const id of ["dashboard-content", "app-detail", "view-account", "empty"]) assert.equal(document.getElementById(id).hidden, true, `${id} must remain hidden`);
  assert.ok(document.getElementById("notice").textContent.includes("만료")); assert.equal(document.getElementById("login-link").hidden, false);
  await client.refresh(); assert.equal(calls, 2); client.close();
});

function registryApp(id: string, version = 0) { return { id, name: "앱 " + id, repositoryId: "repo_" + id, rootDirectory: ".", createdAt: now, settings: { version, values: { PUBLIC_NAME: id }, updatedAt: now } }; }
function registryState(id: string) { const app = registryApp(id); return { ...state("snapshot_" + id), applications: [registryApp("app_a"), registryApp("app_b")].map(({ id, name, createdAt }) => ({ id, name, createdAt })), selectedApplication: app }; }
function registrySummary(id: string, name: string) { const app=registryApp(id); return {id,name,createdAt:now,repositoryId:app.repositoryId,rootDirectory:app.rootDirectory,github:{owner:"synthetic",repository:app.repositoryId,ref:"main",version:1},ota:{ios:null,android:null},automation:null,runner:{status:"unregistered",registeredCount:0,activeCount:0,onlineCount:0,lastSeenAt:null}}; }

test("registered apps without snapshots remain selectable and public settings are separate", async () => {
  const data = { ...registryState("app_a"), selected: null, snapshots: { items: [], nextCursor: null }, history: { items: [], nextCursor: null } };
  const app = await controller(data as any);
  assert.equal(app.document.getElementById("application-panel").hidden, false);
  assert.equal(app.document.getElementById("application-settings").hidden, false);
  assert.equal(app.document.getElementById("application-count").textContent, "2개");
  assert.equal(app.document.getElementById("settings-editor").open, false);
  assert.ok(!app.document.getElementById("application-select").textContent.includes("undefined"));
  assert.equal(app.document.getElementById("baseline-file").disabled, true);
  assert.equal(JSON.parse(app.document.getElementById("settings-json").value).PUBLIC_NAME, "app_a");
  app.client.close();
  assert.equal(app.document.getElementById("settings-json").value, "");
  assert.equal(app.document.getElementById("application-select").textContent, "");
});

test("switching apps erases prior private content immediately and ignores late state responses", async () => {
  const gate = deferred<any>(); let gated = false;
  const app = await controller(registryState("app_a") as any, async url => {
    if (url.includes("appId=app_a") && gated) return gate.promise;
    if (url.includes("appId=app_b")) return response(registryState("app_b"));
  });
  gated = true; const older = app.client.refresh();
  const switching = app.client.chooseApplication("app_b");
  assert.equal(app.document.getElementById("settings-json").value, "");
  assert.equal(app.document.getElementById("baseline-file").disabled, true);
  await switching; gate.resolve(response(registryState("app_a"))); await older;
  assert.equal(app.document.getElementById("application-select").value, "app_b");
  assert.equal(JSON.parse(app.document.getElementById("settings-json").value).PUBLIC_NAME, "app_b");
  assert.ok(app.calls.some(call => call.url === "/api/state?appId=app_b"));
  app.client.close();
});

test("public settings save uses app identity and expected version; stale versions fail honestly", async () => {
  const app = await controller(registryState("app_a") as any, async (url, init) => {
    if (url === "/api/apps/app_a/settings") { assert.deepEqual(JSON.parse(init.body as string), { expectedVersion: 0, values: { PUBLIC_NAME: "updated" } }); return response({ error: "CONFLICT" }, 409); }
  });
  app.document.getElementById("settings-json").value = '{"PUBLIC_NAME":"updated"}';
  await app.client.saveSettings();
  assert.ok(app.document.getElementById("notice").textContent.includes("저장하지 못했습니다"));
  assert.equal(app.document.getElementById("settings-json").value, '{"PUBLIC_NAME":"updated"}');
  app.client.close();
});

test("late settings receipt cannot restore another app or an expired session", async () => {
  const gate = deferred<any>();
  const app = await controller(registryState("app_a") as any, async url => url === "/api/apps/app_a/settings" ? gate.promise : url.includes("appId=app_b") ? response(registryState("app_b")) : undefined);
  const saving = app.client.saveSettings(); await app.client.chooseApplication("app_b");
  gate.resolve(response(registryApp("app_a", 1))); await saving;
  assert.equal(app.document.getElementById("application-select").value, "app_b");
  app.client.close(); assert.equal(app.document.getElementById("settings-json").value, "");
});

test("registered hosted app logs and baselines carry the selected app scope", async () => {
  const data = { ...registryState("app_a"), history: { items: [record()], nextCursor: null } };
  const app = await controller(data as any, async url => {
    if (url === "/api/baselines/baseline_a/log?appId=app_a") return response({ id: "baseline_a", safeLog: "scoped log", logTruncated: false });
    if (url.startsWith("/api/baselines?")) return response({ id: "baseline_b", snapshotId: "snapshot_app_a" });
  });
  const details = app.document.getElementById("log-baseline_a"); details.open = true; await details.dispatch("toggle");
  assert.ok(details.textContent.includes("scoped log"));
  await app.client.importFile("baseline", new File(["{}"], "baseline.json", { type: "application/json" }));
  assert.ok(app.calls.some(call => call.url === "/api/baselines?snapshotId=snapshot_app_a&appId=app_a"));
  app.client.close();
});

test("invalid public settings never issue a write", async () => {
  const app = await controller(registryState("app_a") as any);
  for (const input of ['{"lowercase":"value"}', '{"PUBLIC_NAME":42}', JSON.stringify({ PUBLIC_NAME: "x".repeat(2049) })]) {
    app.document.getElementById("settings-json").value = input; await app.client.saveSettings();
  }
  assert.ok(!app.calls.some(call => call.url.endsWith("/settings")));
  assert.ok(app.document.getElementById("notice").textContent.includes("JSON"));
  app.client.close();
});

test("successful hosted registration closes its disclosure and CONFIG stays in its app settings page", async () => {
  const app = await controller(registryState("app_a") as any, async url => url === "/api/apps" ? response(registryApp("app_b"), 201) : url.includes("appId=app_b") ? response(registryState("app_b")) : undefined);
  app.document.getElementById("application-registration").open = true;
  app.document.getElementById("application-name").value = "앱 b";
  app.document.getElementById("application-repository").value = "repo_b";
  app.document.getElementById("application-root").value = ".";
  await app.client.registerApplication();
  assert.equal(app.document.getElementById("application-registration").open, false);
  assert.equal(app.document.getElementById("settings-editor").open, false);
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.ok(html.indexOf('id="application-settings"') > html.indexOf('id="page-app-settings"'));
  assert.ok(html.indexOf('id="application-settings"') < html.indexOf('id="page-activity"'));
  app.client.close();
});

test("app operations are loaded on demand and late responses cannot cross an app switch", async () => {
  const gate = deferred<any>();
  const app = await controller(registryState("app_a") as any, async url => url === "/api/apps/app_a/operations" ? gate.promise : url.includes("appId=app_b") ? response(registryState("app_b")) : undefined);
  assert.ok(!app.calls.some(call => call.url.endsWith("/operations")));
  const loading = app.client.loadOperations();
  await app.client.navigate("app-settings", "app_b");
  gate.resolve(response({ applicationId: "app_a", connection: null, detection: null, deployments: [] })); await loading;
  assert.equal(app.document.getElementById("operations-status").textContent, "");
  app.client.close();
});

function ops(id = "app_a", dynamic = false) {
  const connection = { appId: id, version: 1, installationId: 123, owner: "synthetic", repository: "expo-app", ref: "main", connectedAt: now };
  const detection = { id: "detection_" + id, appId: id, connection, commitSha: "a".repeat(40), framework: "expo", expoVersion: "57.0.0", reactNativeVersion: "0.86.0", configSource: dynamic ? "dynamic-required" : "app.json", runtimeVersion: dynamic ? null : "1.0.0", platforms: ["ios", "android"], updatesEnabled: !dynamic, updatesUrl: "/updates/" + id, reasons: dynamic ? ["DYNAMIC_CONFIG_REQUIRED"] : [], rootDirectory: ".", detectedAt: now };
  return { connection, detections: [detection], assets: [], deployments: [] };
}

test("GitHub connect uses selected app and CAS; pinned source detection distinguishes dynamic config", async () => {
  let detection = ops("app_a", true);
  const app = await controller(registryState("app_a") as any, async (url, init) => {
    if (url === "/api/apps/app_a/operations") return response(detection);
    if (url === "/api/apps/app_a/github") { const input = JSON.parse(init.body as string); assert.equal(input.expectedVersion, 1); assert.equal(input.installationId, 456); assert.equal(input.repository, "expo-app"); return response(detection); }
  });
  await app.client.loadOperations();
  assert.ok(app.document.getElementById("framework-detection").textContent.includes("DYNAMIC_CONFIG_REQUIRED"));
  assert.equal(app.document.getElementById("ota-deploy").disabled, true);
  app.document.getElementById("github-installation").value = "456";
  await app.client.connectGitHub();
  assert.ok(app.calls.some(call => call.url === "/api/apps/app_a/github"));
  app.client.close();
});

test("real export bytes upload before publication using pinned detection SHA and runtime", async () => {
  const current = ops(); const uploads: RequestInit[] = []; let published: any;
  const app = await controller(registryState("app_a") as any, async (url, init) => {
    if (url === "/api/apps/app_a/operations") return response(current);
    if (url.startsWith("/api/apps/app_a/ota/assets?")) { uploads.push(init); const query = new URL(url, "http://fixture.local").searchParams; assert.ok(/^[A-Za-z0-9_-]+$/.test(query.get("key")!)); assert.ok(/^\.[A-Za-z0-9]{1,15}$/.test(query.get("fileExtension")!)); assert.equal((init.headers as any)["Content-Type"], "application/octet-stream"); assert.ok(init.body instanceof File); return response({ id: "asset_" + uploads.length, appId: "app_a" }, 201); }
    if (url === "/api/apps/app_a/ota/deployments") { published = JSON.parse(init.body as string); return response({ id: "deployment_1", appId: "app_a" }, 201); }
  });
  await app.client.loadOperations();
  app.document.getElementById("ota-platform").value = "ios"; app.document.getElementById("ota-channel").value = "preview";
  app.document.getElementById("ota-launch").files = [new File(["export bundle"], "ios.js", { type: "application/javascript" })];
  app.document.getElementById("ota-assets").files = [new File(["asset bytes"], "image.png", { type: "image/png" })];
  await app.client.deployOTA();
  assert.equal(uploads.length, 2); assert.equal(published.detectionId, "detection_app_a"); assert.equal(published.commitSha, current.detections[0]!.commitSha); assert.equal(published.runtimeVersion, "1.0.0"); assert.equal(published.launchAssetId, "asset_1"); assert.deepEqual(published.assetIds, ["asset_2"]);
  app.client.close();
});

test("a late GitHub write cannot restore a switched app or expired operations", async () => {
  const gate = deferred<any>();
  const app = await controller(registryState("app_a") as any, async url => url === "/api/apps/app_a/operations" ? response(ops()) : url === "/api/apps/app_a/github" ? gate.promise : url.includes("appId=app_b") ? response(registryState("app_b")) : undefined);
  await app.client.loadOperations();
  const writing = app.client.connectGitHub(); await app.client.navigate("app-settings", "app_b"); gate.resolve(response(ops())); await writing;
  assert.equal(app.document.getElementById("operations-status").textContent, "");
  assert.equal(app.document.getElementById("github-owner").value, "");
  app.client.close(); assert.equal(app.document.getElementById("ota-history").textContent, "");
});

test("dynamic config accepts exported JSON on sync without executing source files", async () => {
  const app = await controller(registryState("app_a") as any, async (url, init) => {
    if (url === "/api/apps/app_a/operations") return response(ops("app_a", true));
    if (url === "/api/apps/app_a/github/sync") { assert.deepEqual(JSON.parse(init.body as string), { resolvedConfig: { commitSha: "a".repeat(40), config: { expo: { runtimeVersion: "1.0.0" } } } }); return response(ops().detections[0]); }
  });
  await app.client.loadOperations(); assert.equal(app.document.getElementById("github-resolved-config-field").hidden, false);
  app.document.getElementById("github-resolved-config").files = [new File([JSON.stringify({ expo: { runtimeVersion: "1.0.0" } })], "resolved.json")];
  await app.client.syncGitHub(); assert.ok(app.calls.some(call => call.url.endsWith("/github/sync"))); app.client.close();
});

test("switching during asset upload prevents publication and clears every operation field", async () => {
  const gate = deferred<any>();
  const app = await controller(registryState("app_a") as any, async url => url === "/api/apps/app_a/operations" ? response(ops()) : url.includes("/ota/assets?") ? gate.promise : url.includes("appId=app_b") ? response(registryState("app_b")) : undefined);
  await app.client.loadOperations();
  app.document.getElementById("ota-channel").value = "preview"; app.document.getElementById("ota-platform").value = "ios";
  app.document.getElementById("ota-launch").files = [new File(["actual bytes"], "ios.js")];
  const publishing = app.client.deployOTA(); await app.client.chooseApplication("app_b"); gate.resolve(response({ appId: "app_a", id: "asset_1" })); await publishing;
  assert.ok(!app.calls.some(call => call.url.endsWith("/ota/deployments")));
  for (const id of ["github-owner", "github-repository", "ota-channel", "ota-launch", "github-resolved-config"]) assert.equal(app.document.getElementById(id).value, "");
  app.client.close();
});

test("OTA history displays app channel runtime platform SHA publication ID and download route", async () => {
  const result: any = ops(); result.deployments = [{ id: "deployment_1", appId: "app_a", channel: "preview", runtimeVersion: "1.0.0", platform: "ios", commitSha: "a".repeat(40), createdAt: now, launchAsset: { id: "asset_" + "f".repeat(64), digest: "f".repeat(64) }, assets: [] }];
  const app = await controller(registryState("app_a") as any, async url => url === "/api/apps/app_a/operations" ? response(result) : undefined);
  await app.client.loadOperations(); const text = app.document.getElementById("ota-history").textContent;
  for (const value of ["게시됨", "app_a", "preview", "Runtime 1.0.0", "iOS", "a".repeat(40), "deployment_1", "/updates/app_a/assets/" + "f".repeat(64), "다운로드"]) assert.ok(text.includes(value), value);
  const link = app.document.getElementById("ota-history").children[0]!.children.find(child => child.tagName === "a")!;
  assert.equal((link as any).href, "/updates/app_a/assets/" + "f".repeat(64));
  assert.ok(!(link as any).href.includes("asset_"));
  app.setTime(now + 3_600_001); app.events.get("focus")!();
  assert.equal(app.document.getElementById("ota-history").textContent, "");
  assert.equal(app.document.getElementById("github-installation").value, "");
});

function automatedOps(id = "app_a") { const result: any = ops(id); const detection = result.detections[0]; detection.configSource = "flora.config.json"; detection.automationConfig = { schemaVersion: 1, bundler: "metro", entryFile: "index.js", toolchain: { nodeVersion: "24.19.0", packageManager: { name: "pnpm", version: "11.19.0" } }, runtimeVersion: "1.0.0", platforms: ["ios", "android"], updatesUrl: "/updates/" + id }; return result; }
const runner = { id: "runner_a", name: "UULab Runner", appIds: ["app_a"], createdAt: now, credentialEpoch: 1, revokedAt: null };
test("automation fields load each app's saved policy without replacing an unchanged-policy draft", async () => {
  const app = await controller(registryState("app_a") as any, async url => {
    if (url === "/api/apps/app_a/operations") return response(automatedOps("app_a"));
    if (url === "/api/apps/app_b/operations") return response(automatedOps("app_b"));
    if (url === "/api/apps/app_a/automation") return response({ jobs: [], runners: [runner], policy: {appId:"app_a",version:1,enabled:true,channel:"flora-verification",platform:"ios"} });
    if (url === "/api/apps/app_b/automation") return response({ jobs: [], runners: [{...runner,id:"runner_b",appIds:["app_b"]}], policy: {appId:"app_b",version:1,enabled:true,channel:"promise-preview",platform:"android"} });
    if (url.includes("appId=app_b")) return response(registryState("app_b"));
  });
  await app.client.loadAutomation();assert.equal(app.document.getElementById("automation-channel").value,"flora-verification");
  app.document.getElementById("automation-channel").value="draft-channel";await app.client.loadAutomation();assert.equal(app.document.getElementById("automation-channel").value,"draft-channel");
  await app.client.chooseApplication("app_b");await app.client.loadAutomation();assert.equal(app.document.getElementById("automation-channel").value,"promise-preview");assert.equal(app.document.getElementById("automation-platform").value,"android");
  assert.ok(!app.calls.some(call=>call.url.endsWith("/automation/policy")));app.client.close();
});
test("automation queue requires source-bound SDK config and a scoped registered Runner", async () => {
  let queued: any;const app = await controller(registryState("app_a") as any, async (url, init) => {
    if (url === "/api/apps/app_a/operations") return response(automatedOps());
    if (url === "/api/apps/app_a/automation") return response({ jobs: [], runners: [runner] });
    if (url === "/api/apps/app_a/automation/jobs") { queued = JSON.parse(init.body as string); return response({ id: "job_a", appId: "app_a", state: "queued" }, 201); }
  });
  await app.client.loadOperations();assert.equal(app.document.getElementById("automation-queue").disabled, true);
  await app.client.loadAutomation();assert.equal(app.document.getElementById("automation-queue").disabled, false);
  await app.client.queueAutomation();assert.deepEqual(queued.config, automatedOps().detections[0].automationConfig);assert.equal(queued.detectionId, "detection_app_a");assert.equal(queued.channel, "preview");
  app.client.close();
});

test("GitHub push policy stays off until explicit CAS save for the selected app", async () => {
  let saved: any;const app = await controller(registryState("app_a") as any, async (url, init) => {
    if (url === "/api/apps/app_a/operations") return response(automatedOps());
    if (url === "/api/apps/app_a/automation") return response({ jobs: [], runners: [runner], policy: null });
    if (url === "/api/apps/app_a/automation/policy") { saved = JSON.parse(init.body as string); return response({ appId: "app_a", version: 1, ...saved }); }
  });
  await app.client.loadAutomation();assert.equal(app.document.getElementById("automation-policy-enabled").checked, false);
  assert.ok(!app.calls.some(call => call.url.endsWith("/policy")));
  app.document.getElementById("automation-policy-enabled").checked = true;await app.client.saveAutomationPolicy();
  assert.deepEqual(saved, { expectedVersion: 0, enabled: true, channel: "preview", platforms: ["ios", "android"] });app.client.close();
});

test("Runner enrollment token is displayed once and late token responses cannot cross apps", async () => {
  const gate = deferred<any>();const app = await controller(registryState("app_a") as any, async url => {
    if (url === "/api/apps/app_a/operations") return response(automatedOps());
    if (url === "/api/apps/app_a/automation") return response({ jobs: [], runners: [runner] });
    if (url === "/api/runners") return gate.promise;
    if (url.includes("appId=app_b")) return response(registryState("app_b"));
  });
  await app.client.loadAutomation();app.document.getElementById("runner-name").value = "UULab Runner";
  const enrolling = app.client.enrollRunner();await app.client.chooseApplication("app_b");gate.resolve(response({ runner, token: "machine_fixture_secret" }));await enrolling;
  assert.equal(app.document.getElementById("runner-token").textContent, "");assert.equal(app.document.getElementById("runner-token-panel").hidden, true);
  app.client.close();assert.ok(!app.document.text.includes("machine_fixture_secret"));
});

test("active job phases and receipts stay distinct from queued requests; app changes fence late automation state", async () => {
  const gate = deferred<any>();let delayed = false;
  const job = { id: "job_a", appId: "app_a", state: "leased", channel: "preview", platform: "ios", commitSha: "a".repeat(40), runtimeVersion: "1.0.0", attemptCount: 1, lease: { attemptId: "attempt_a", runnerId: "runner_a", expiresAt: now + 5000 }, code: null, deploymentId: null };
  const app = await controller(registryState("app_a") as any, async url => url === "/api/apps/app_a/operations" ? response(automatedOps()) : url === "/api/apps/app_a/automation" ? delayed ? gate.promise : response({ jobs: [job], runners: [runner] }) : url.includes("appId=app_b") ? response(registryState("app_b")) : undefined);
  await app.client.loadAutomation();assert.ok(app.document.getElementById("automation-history").textContent.includes("Runner 작업 중"));assert.ok(app.document.getElementById("automation-history").textContent.includes("attempt_a"));assert.ok(!app.document.getElementById("automation-history").textContent.includes("게시 완료"));
  delayed = true;const reading = app.client.loadAutomation();await app.client.chooseApplication("app_b");gate.resolve(response({ jobs: [{ ...job, state: "succeeded", deploymentId: "deployment_a" }], runners: [{...runner,presence:{status:"online",lastSeenAt:now}}] }));await reading;
  assert.equal(app.document.getElementById("automation-runners").textContent, "");
  assert.equal(app.document.getElementById("automation-history").textContent, "");app.client.close();
});

test("stale push policy conflicts preserve the last saved state and explain failure", async () => {
  const app = await controller(registryState("app_a") as any, async url => url === "/api/apps/app_a/operations" ? response(automatedOps()) : url === "/api/apps/app_a/automation" ? response({ jobs: [], runners: [runner], policy: { appId: "app_a", version: 3, enabled: false, channel: "preview", platform: "ios" } }) : url.endsWith("/policy") ? response({ error: "CONFLICT" }, 409) : undefined);
  await app.client.loadAutomation();app.document.getElementById("automation-policy-enabled").checked = true;await app.client.saveAutomationPolicy();
  assert.ok(app.document.getElementById("automation-status").textContent.includes("완료하지 못했습니다"));assert.ok(app.document.getElementById("automation-policy-status").textContent.includes("꺼짐"));assert.ok(app.document.getElementById("automation-policy-status").textContent.includes("버전 3"));app.client.close();
});

test("successful Runner enrollment uses only the current app and erases its one-time token on expiry", async () => {
  const app = await controller(registryState("app_a") as any, async (url, init) => {
    if (url === "/api/apps/app_a/operations") return response(automatedOps());
    if (url === "/api/apps/app_a/automation") return response({ jobs: [], runners: [runner] });
    if (url === "/api/runners") { assert.deepEqual(JSON.parse(init.body as string), { name: "UULab Runner", appIds: ["app_a"] });return response({ runner, token: "machine_fixture_secret" }); }
  });
  await app.client.loadAutomation();await app.client.enrollRunner();assert.equal(app.document.getElementById("runner-token").textContent, "machine_fixture_secret");assert.equal(app.document.getElementById("runner-token-panel").hidden, false);
  app.setTime(now + 3_600_001);app.events.get("focus")!();assert.equal(app.document.getElementById("runner-token").textContent, "");assert.equal(app.document.getElementById("automation-policy-enabled").checked, false);assert.ok(!app.document.text.includes("machine_fixture_secret"));
});

test("UULab server options alone enable the 12-character setup rule and owner prefill", async () => {
  const { startAuth, validPassword } = await loadAuth();
  assert.equal(validPassword("a".repeat(12), { workspaceName: "UULab", passwordMinimum: 12 }), true);
  for (const options of [{ passwordMinimum: 12 }, { workspaceName: "other", passwordMinimum: 12 }, { workspaceName: "UULab", passwordMinimum: 15 }]) assert.equal(validPassword("a".repeat(12), options), false);
  const document = new Document("auth.html");const calls: any[] = [];
  const client = startAuth({ document, location: { pathname: "/setup", replace() {} }, fetch: async (url: string, init: any) => { calls.push({ url, init });return response({ csrfToken: "session-fixture", expiresAt: now + 1000 }); }, now: () => now }, { workspaceName: "UULab", passwordMinimum: 12, ownerEmail: "admin@admin.com" });
  assert.equal(document.getElementById("email").value, "admin@admin.com");assert.equal(document.getElementById("auth-workspace-name").textContent, "UULab");assert.ok(document.getElementById("password-note").textContent.includes("12–128"));
  document.getElementById("password").value = "a".repeat(12);document.getElementById("confirmation").value = "a".repeat(12);document.getElementById("token").value = randomBytes(32).toString("base64url");await client.submit();assert.equal(calls.length, 1);client.close();assert.equal(document.getElementById("password").value, "");
});

test("registering another app clears prior Runner credentials and private operation panels", async () => {
  const app = await controller(registryState("app_a") as any, async url => url === "/api/apps/app_a/operations" ? response(automatedOps()) : url === "/api/apps/app_a/automation" ? response({ jobs: [], runners: [runner] }) : url === "/api/runners" ? response({ runner, token: "machine_fixture_secret" }) : url === "/api/apps" ? response(registryApp("app_b"), 201) : url.includes("appId=app_b") ? response(registryState("app_b")) : undefined);
  await app.client.loadAutomation();await app.client.enrollRunner();app.document.getElementById("operations-editor").open = true;app.document.getElementById("automation-editor").open = true;app.document.getElementById("runner-editor").open = true;
  app.document.getElementById("application-name").value = "App b";app.document.getElementById("application-repository").value = "repo_b";app.document.getElementById("application-root").value = ".";await app.client.registerApplication();
  for (const id of ["operations-editor", "automation-editor", "runner-editor"]) assert.equal(app.document.getElementById(id).open, false);
  for (const id of ["runner-token", "automation-history", "framework-detection", "github-connection"]) assert.equal(app.document.getElementById(id).textContent, "");assert.equal(app.document.getElementById("application-select").value, "app_b");app.client.close();
});

test("auth options failure cannot lower default policy and late metadata cannot refill a departed page", async () => {
  const { bootstrapAuth } = await loadAuth();const document = new Document("auth.html");const events = new Map<string, () => void>();const gate = deferred<any>();
  const pending = bootstrapAuth({ document, location: { pathname: "/setup", replace() {} }, addEventListener: (event: string, callback: () => void) => events.set(event, callback), fetch: async () => gate.promise });
  document.getElementById("password").value = "private-fixture";events.get("pagehide")!();gate.resolve(response({ workspaceName: "UULab", passwordMinimum: 12, ownerEmail: "admin@admin.com" }));await pending;
  assert.equal(document.getElementById("email").value, "");assert.equal(document.getElementById("password").value, "");
  const fresh = new Document("auth.html");const client = await bootstrapAuth({ document: fresh, location: { pathname: "/setup", replace() {} }, fetch: async () => response({}, 503) });
  assert.ok(fresh.getElementById("password-note").textContent.includes("15–128"));client.close();
});

test("visible active automation polls once without overlap and stops after a terminal result", async () => {
  let terminal = false; let reads = 0; const gate = deferred<any>(); let delay = false;
  const app = await controller(registryState("app_a") as any, async url => {
    if (url === "/api/apps/app_a/operations") return response(automatedOps());
    if (url === "/api/apps/app_a/automation") { reads++; if (delay) return gate.promise; return response({ jobs: [{ id: "job_a", appId: "app_a", state: terminal ? "succeeded" : "queued", attemptCount: 0 }], runners: [runner] }); }
  });
  await app.client.navigate("runners", "app_a");
  const poll = [...app.timers.values()].find(item => item.delay === 5000); assert.ok(poll);
  delay = true; poll.callback(); await new Promise(resolve => setImmediate(resolve));
  await app.client.loadAutomation(); assert.equal(reads, 2);
  terminal = true; gate.resolve(response({ jobs: [{ id: "job_a", appId: "app_a", state: "succeeded", attemptCount: 1 }], runners: [runner] })); await new Promise(resolve => setImmediate(resolve));
  assert.ok(![...app.timers.values()].some(item => item.delay === 5000)); app.client.close();
});

test("job details fence app changes and safe setup template contains no enrollment secret", async () => {
  const gate = deferred<any>(); const app = await controller(registryState("app_a") as any, async url => {
    if (url === "/api/apps/app_a/operations") return response(automatedOps());
    if (url === "/api/apps/app_a/automation") return response({ jobs: [{ id: "job_a", appId: "app_a", state: "failed", code: "EXPORT_FAILED", attemptCount: 1 }], runners: [runner] });
    if (url === "/api/apps/app_a/automation/jobs/job_a") return gate.promise;
    if (url.includes("appId=app_b")) return response(registryState("app_b"));
  });
  await app.client.loadAutomation(); assert.ok(app.document.getElementById("automation-checklist").textContent.includes("기기 적용 미검증"));
  const template = app.document.getElementById("runner-config-template").textContent; assert.ok(template.includes("REPLACE_WITH_ONE_TIME")); assert.ok(!template.includes("machine_fixture_secret"));
  const pending = app.client.loadAutomationJob("job_a"); await app.client.chooseApplication("app_b");
  gate.resolve(response({ job: { id: "job_a", appId: "app_a" }, attempts: [], events: [] })); await pending;
  assert.equal(app.document.getElementById("automation-history").textContent, ""); app.client.close();
});

test("automation details show bounded structured failure help and session loss fences pending responses", async () => {
  let expired = false; const gate = deferred<any>(); let delayed = false;
  const app = await controller(registryState("app_a") as any, async url => {
    if (url === "/api/apps/app_a/operations") return response(automatedOps());
    if (url === "/api/apps/app_a/automation") return expired ? response({}, 401) : response({ jobs: [{ id: "job_a", appId: "app_a", state: "failed", attemptCount: 1 }], runners: [runner] });
    if (url === "/api/apps/app_a/automation/jobs/job_a") return delayed ? gate.promise : response({ job: { id: "job_a", appId: "app_a", code: "EXPORT_FAILED" }, attempts: [{ jobId: "job_a", id: "attempt_a", claimedAt: now, outcome: "failed", code: "EXPORT_FAILED", secret: "hidden-secret" }], events: [{ jobId: "job_a", createdAt: now, kind: "failed", code: "EXPORT_FAILED", safeLog: "hidden-secret" }] });
  });
  await app.client.loadAutomation(); await app.client.loadAutomationJob("job_a");
  const text = app.document.getElementById("automation-job-job_a").textContent; assert.ok(text.includes("오프라인 의존성 캐시")); assert.ok(text.includes("attempt_a")); assert.ok(!text.includes("hidden-secret"));
  delayed = true; const pending = app.client.loadAutomationJob("job_a"); expired = true; await app.client.loadAutomation();
  gate.resolve(response({ job: { id: "job_a", appId: "app_a" }, attempts: [], events: [] })); await pending;
  assert.equal(app.document.getElementById("runner-config-template").textContent, ""); assert.equal(app.document.getElementById("automation-history").textContent, ""); app.client.close();
});

test("workspace branding uses authenticated metadata as text and preserves default without it", async () => {
  const app = await controller(state(), async url => url === "/api/auth/session" ? response({ csrfToken: "session-fixture", expiresAt: now + 3600000, workspaceName: "UULab <script>" }) : undefined);
  assert.equal(app.document.getElementById("workspace-name").textContent, "UULab <script>"); app.client.close();
});

test("registered project cards search actual apps and clear their private titles on logout", async () => {
  const initial = registryState("app_a");
  const { client, document } = await controller(initial as never);
  const list = document.getElementById("project-list");
  assert.equal(list.children.length, 2);
  assert.equal(list.children[0]!.getAttribute("data-select-application"), initial.applications[0]!.id);
  assert.equal(list.children[0]!.children[0]!.getAttribute("aria-pressed"), "true");
  assert.equal(list.children[1]!.children[0]!.getAttribute("aria-pressed"), "false");
  assert.ok(list.textContent.includes(initial.selectedApplication.repositoryId));
  assert.ok(list.textContent.includes(registryApp("app_b").repositoryId));
  document.getElementById("project-search").value = initial.applications[1]!.id;
  for (const handler of document.getElementById("project-search").listeners.get("input") ?? []) handler({ target: document.getElementById("project-search") });
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0]!.getAttribute("data-select-application"), initial.applications[1]!.id);
  client.close();
  assert.equal(list.textContent, "");
  assert.equal(document.getElementById("selected-project-title").textContent, "");
  assert.equal(document.getElementById("project-search").value, "");
});

test("hosted registration clears an active project filter so the new selected card remains visible", async () => {
  const app = await controller(registryState("app_a") as never, async url => url === "/api/apps" ? response(registryApp("app_b")) : url === "/api/state?appId=app_b" ? response(registryState("app_b")) : undefined);
  app.document.getElementById("project-search").value = "only-old-project";
  app.document.getElementById("application-name").value = "B";
  app.document.getElementById("application-repository").value = "repo_b";
  app.document.getElementById("application-root").value = ".";
  await app.client.registerApplication();
  assert.equal(app.document.getElementById("project-search").value, "");
  assert.equal(app.document.getElementById("project-list").children.length, 2);
  assert.equal(app.document.getElementById("project-card-app_b").children[0]!.getAttribute("aria-pressed"), "true");
  app.client.close();
});

const githubReady = { configured: true, source: "managed", appId: "123", appSlug: "flora-uulab", installationUrl: "https://github.com/apps/flora-uulab/installations/new" };
function githubTransport(url: string) {
  if (url === "/api/github/connection") return response(githubReady);
  if (url === "/api/github/installations") return response({ items: [{ id: 77, account: "uulab", repositorySelection: "selected", suspended: false }], truncated: false });
  if (url.startsWith("/api/github/repositories?")) return response({ installationId: 77, items: [{ id: 9, owner: "uulab", repository: "isso", private: true, defaultBranch: "release" }], nextCursor: null });
}
test("managed GitHub repository choice registers source identity and connects only its selected app", async () => {
  const initial = registryState("app_a"); const target = registryState("app_b"); target.selectedApplication.repositoryId = "uulab/isso";
  const writes: { url: string; body: any }[] = [];
  const app = await controller(initial as any, async (url, init) => {
    const git = githubTransport(url); if (git) return git;
    if (url === "/api/apps") { writes.push({ url, body: JSON.parse(init.body as string) }); return response(target.selectedApplication); }
    if (url === "/api/state?appId=app_b") return response(target);
    if (url === "/api/apps/app_b/operations") return response({ appId: "app_b", connection: { appId: "app_b", installationId: 77, owner: "uulab", repository: "isso", ref: "main", version: 4 }, detections: [], assets: [], deployments: [] });
    if (url === "/api/apps/app_b/github") { writes.push({ url, body: JSON.parse(init.body as string) }); return response({}); }
  });
  await app.client.loadGitHubConnection(); app.client.useGitHubRepository();
  assert.equal(app.document.getElementById("application-repository").value, "uulab/isso");
  app.document.getElementById("application-root").value = "apps/mobile";
  await app.client.registerApplication();
  assert.deepEqual(writes, [{ url: "/api/apps", body: { name: "isso", repositoryId: "uulab/isso", rootDirectory: "apps/mobile" } }, { url: "/api/apps/app_b/github", body: { expectedVersion: 4, installationId: 77, owner: "uulab", repository: "isso", ref: "release" } }]);
  assert.ok(app.calls.filter(call => call.init.method === "POST").every(call => (call.init.headers as any)["X-Flora-CSRF"] === app.csrf)); app.client.close();
});
test("managed GitHub pending response cannot refill a closed session", async () => {
  const gate = deferred<any>(); const app = await controller(state(), async url => url === "/api/github/connection" ? gate.promise : undefined);
  const work = app.client.loadGitHubConnection(); app.client.close(); gate.resolve(response(githubReady)); await work;
  assert.equal(app.document.getElementById("github-managed-status").textContent, "");
  assert.equal(app.document.getElementById("github-install-link").hidden, true);
  assert.ok(!app.calls.some(call => call.url === "/api/github/installations"));
});
test("GitHub callback is removed before session fetch and completed with session CSRF", async () => {
  let erased = false; const stateValue = "s".repeat(32); const code = "one_use_code";
  const app = await controller(state(), async (url, init) => {
    assert.equal(erased, true);
    if (url === "/api/github/manifest/complete") { assert.deepEqual(JSON.parse(init.body as string), { state: stateValue, code }); return response(githubReady); }
    return githubTransport(url);
  }, { location: { hash: "#github-app-code=" + code + "&github-app-state=" + stateValue }, history: { replaceState(_value: unknown, _title: string, path: string) { assert.equal(path, "/"); erased = true; } } });
  const completion = app.calls.find(call => call.url === "/api/github/manifest/complete")!;
  assert.equal((completion.init.headers as any)["X-Flora-CSRF"], app.csrf); assert.equal(app.document.getElementById("application-registration").open, true); app.client.close();
});
test("malformed GitHub callback is cleared without completion request", async () => {
  let erased = false;
  const app = await controller(state(), undefined, { location: { hash: "#github-app-code=bad&github-app-state=x" }, history: { replaceState() { erased = true; } } });
  assert.equal(erased, true); assert.ok(!app.calls.some(call => call.url === "/api/github/manifest/complete")); assert.ok(app.document.getElementById("github-managed-status").textContent.includes("다시 시작")); app.client.close();
});
test("GitHub setup rejects an external manifest action without submitting credentials", async () => {
  const app = await controller(state(), async url => url === "/api/github/manifest/start" ? response({ action: "https://attacker.invalid/settings/apps/new?state=abc", manifest: {} }) : undefined);
  await app.client.startGitHubManifest(); assert.ok(app.document.getElementById("github-managed-status").textContent.includes("확인하지 못했습니다")); app.client.close();
});
test("app-specific OTA public certificate is cleared on app change and late responses are fenced", async () => {
  const gate = deferred<any>(); const app = await controller(registryState("app_a") as any, async url => url === "/api/apps/app_a/signing-key" ? gate.promise : url === "/api/state?appId=app_b" ? response(registryState("app_b")) : undefined);
  const preparing = app.client.prepareSigningKey(); await app.client.chooseApplication("app_b"); gate.resolve(response({ appId: "app_a", keyId: "ota-key-1", certificate: "-----BEGIN CERTIFICATE-----\nPUBLIC\n-----END CERTIFICATE-----" })); await preparing;
  assert.equal(app.document.getElementById("signing-certificate-download").hidden, true); assert.equal(app.document.getElementById("signing-key-status").textContent, ""); app.client.close();
});
test("managed manifest posts only supplied public manifest to the exact GitHub organization endpoint", async () => {
  const manifest = { name: "Flora", url: "https://flora.example.test", public: false };
  const app = await controller(state(), async (url, init) => {
    if (url !== "/api/github/manifest/start") return;
    assert.deepEqual(JSON.parse(init.body as string), { organization: "uulab" });
    return response({ action: "https://github.com/organizations/uulab/settings/apps/new?state=" + "s".repeat(32), manifest, expiresAt: now + 600000 });
  });
  app.document.getElementById("github-organization").value = "uulab"; await app.client.startGitHubManifest();
  const form = app.document.body.children[0] as any;
  assert.equal(form.method, "POST"); assert.equal(form.action, "https://github.com/organizations/uulab/settings/apps/new?state=" + "s".repeat(32)); assert.equal(form.submitted, true);
  assert.equal(form.children[0].name, "manifest"); assert.deepEqual(JSON.parse(form.children[0].value), manifest); app.client.close();
});

const ciSha = "32fdba841d0c613754138521a8bad13f88c80f5a";
function ciBinding(id = "app_a", version = 1) { return { appId:id,version,enabled:true,connectionVersion:1,runnerId:"runner_"+id,updatedAt:now,repository:"synthetic/expo-app",repositoryId:id === "app_a" ? "123" : "456",repositoryOwnerId:"789",ref:"refs/heads/main",jobWorkflowRef:"uulab-official/flora/.github/workflows/flora-ota-runner.yml@"+ciSha,jobWorkflowSha:ciSha }; }
function ciIdentity(id = "app_a") { const b=ciBinding(id);return {appId:id,connectionVersion:1,repository:b.repository,repositoryId:b.repositoryId,repositoryOwnerId:b.repositoryOwnerId,ref:b.ref}; }
test("managed CI hydrates two app scopes without writes and retains same-version draft", async () => {
  const app=await controller(registryState("app_a") as any,async url => {
    if(url.endsWith("/operations"))return response(ops(url.includes("/app_b/")?"app_b":"app_a"));
    if(url.endsWith("/automation/ci"))return response({binding:ciBinding(url.includes("/app_b/")?"app_b":"app_a")});
    if(url.includes("appId=app_b"))return response(registryState("app_b"));
  });
  await app.client.loadCI();assert.equal(app.document.getElementById("ci-repository-id").value,"123");
  app.document.getElementById("ci-workflow").value="draft";await app.client.loadCI();assert.equal(app.document.getElementById("ci-workflow").value,"draft");
  await app.client.chooseApplication("app_b");assert.equal(app.document.getElementById("ci-workflow-yaml").textContent,"");await app.client.loadCI();assert.equal(app.document.getElementById("ci-repository-id").value,"456");assert.ok(app.document.getElementById("ci-workflow-yaml").textContent.includes('app-id: "app_b"'));assert.ok(!app.calls.some(c=>c.init.method === "POST"));app.client.close();
});
test("managed CI ignores late other-app response and clears output on expiry",async()=>{
  const gate=deferred<any>();const app=await controller(registryState("app_a") as any,async url=>url.endsWith("/operations")?response(ops(url.includes("/app_b/")?"app_b":"app_a")):url==="/api/apps/app_a/automation/ci"?gate.promise:url.includes("appId=app_b")?response(registryState("app_b")):undefined);
  const loading=app.client.loadCI();await new Promise(r=>setImmediate(r));await app.client.chooseApplication("app_b");gate.resolve(response({binding:ciBinding("app_a")}));await loading;assert.equal(app.document.getElementById("ci-workflow-yaml").textContent,"");assert.equal(app.document.getElementById("ci-repository-id").value,"");app.setTime(now+3_600_001);app.events.get("focus")!();assert.equal(app.document.getElementById("ci-download").hidden,true);app.client.close();
});
test("managed CI resolved identity saves exact CAS scope and conflicts preserve draft until explicit refresh",async()=>{
  let binding:any=null;let conflict=true;const app=await controller(registryState("app_a") as any,async(url,init)=>{
    if(url.endsWith("/operations"))return response(ops());
    if(url.endsWith("?resolve=1"))return response({binding,identity:ciIdentity()});
    if(url.endsWith("/automation/ci")){if(init.method==="POST"){const body=JSON.parse(init.body as string);assert.equal(body.expectedVersion,0);assert.equal(body.repositoryId,"123");assert.equal(body.ref,"refs/heads/main");if(conflict)return response({},409);binding=ciBinding();return response({binding});}return response({binding});}
  },{location:{origin:"https://flora.uulab.co.kr"}});
  await app.client.resolveCI();await app.client.saveCI();assert.ok(app.document.getElementById("ci-status").textContent.includes("입력은 보존"));assert.equal(app.document.getElementById("ci-workflow").value,ciBinding().jobWorkflowRef);const count=app.calls.length;await app.client.saveCI();assert.equal(app.calls.length,count);conflict=false;await app.document.getElementById("ci-refresh").dispatch("click");await new Promise(r=>setImmediate(r));await app.client.resolveCI();await app.client.saveCI();assert.ok(app.document.getElementById("ci-workflow-yaml").textContent.includes(ciSha));assert.ok(!app.document.getElementById("ci-workflow-yaml").textContent.includes("secrets:"));app.client.close();
});
for(const bad of [{appId:"app_b"},{repository:"unsafe\nrepo"},{ref:"refs/heads/main\npermissions: write-all"},{jobWorkflowSha:"f".repeat(40)},{repositoryId:"123\n"}])test("managed CI rejects unsafe returned trust "+Object.keys(bad)[0],async()=>{
  const app=await controller(registryState("app_a") as any,async url=>url.endsWith("/operations")?response(ops()):url.endsWith("/automation/ci")?response({binding:{...ciBinding(),...bad}}):undefined);await app.client.loadCI();assert.equal(app.document.getElementById("ci-workflow-yaml").textContent,"");assert.equal(app.document.getElementById("ci-download").hidden,true);assert.equal(app.document.getElementById("ci-save").disabled,true);app.client.close();
});
test("OTA navigation uses its own view and keeps account settings separate",async()=>{
  const app=await controller(registryState("app_a") as any);await app.document.getElementById("nav-updates").dispatch("click");assert.equal(app.document.getElementById("view-title").textContent,"OTA 배포");assert.equal(app.document.getElementById("view-updates").hidden,false);assert.equal(app.document.getElementById("view-account").hidden,true);assert.equal(app.document.getElementById("nav-updates").getAttribute("aria-current"),"page");app.client.close();
});

test("managed CI disable uses saved trust without draft and removes caller after revocation",async()=>{
  let binding=ciBinding();const app=await controller(registryState("app_a") as any,async(url,init)=>{
    if(url.endsWith("/operations"))return response(ops());
    if(url.endsWith("/automation/ci")){if(init.method === "POST"){const b=JSON.parse(init.body as string);assert.deepEqual(b,{expectedVersion:1,enabled:false,repositoryId:"123",repositoryOwnerId:"789",ref:binding.ref,jobWorkflowRef:binding.jobWorkflowRef,jobWorkflowSha:ciSha});binding={...binding,version:2,enabled:false};}return response({binding});}
  });await app.client.loadCI();app.document.getElementById("ci-workflow").value="unrelated draft";await app.client.disableCI();assert.equal(app.document.getElementById("ci-workflow-yaml").textContent,"");assert.equal(app.document.getElementById("ci-download").hidden,true);assert.ok(app.document.getElementById("ci-status").textContent.includes("껐습니다"));app.client.close();
});
test("stale CI connection and failed CI reads never expose actionable workflow or erase automation history",async()=>{
  let fail=false;const app=await controller(registryState("app_a") as any,async url=>{
    if(url.endsWith("/operations"))return response({...ops(),connection:{...ops().connection,version:2}});
    if(url.endsWith("/automation/ci"))return fail?response({},503):response({binding:ciBinding()});
    if(url.endsWith("/automation"))return response({jobs:[{id:"job_a",appId:"app_a",state:"succeeded",deploymentId:"deployment_a",attemptCount:1}],runners:[runner]});
  });await app.client.loadAutomation();await app.client.loadCI();assert.equal(app.document.getElementById("ci-workflow-yaml").textContent,"");fail=true;await app.client.loadCI();assert.equal(app.document.getElementById("ci-save").disabled,true);assert.equal(app.document.getElementById("ci-copy").disabled,true);assert.ok(app.document.getElementById("automation-history").textContent.includes("deployment_a"));const writes=app.calls.filter(c=>c.init.method==="POST").length;await app.client.saveCI();assert.equal(app.calls.filter(c=>c.init.method==="POST").length,writes);app.client.close();
});
test("late CI save cannot replace another app's settings or workflow",async()=>{
  const gate=deferred<any>();const app=await controller(registryState("app_a") as any,async(url,init)=>{
    if(url.endsWith("/operations"))return response(ops(url.includes("/app_b/")?"app_b":"app_a"));
    if(url.endsWith("/automation/ci"))return init.method === "POST"?gate.promise:response({binding:ciBinding(url.includes("/app_b/")?"app_b":"app_a")});
    if(url.includes("appId=app_b"))return response(registryState("app_b"));
  });await app.client.loadCI();const saving=app.client.saveCI();await app.client.chooseApplication("app_b");await app.client.loadCI();gate.resolve(response({binding:ciBinding("app_a",2)}));await saving;assert.equal(app.document.getElementById("ci-repository-id").value,"456");assert.ok(app.document.getElementById("ci-workflow-yaml").textContent.includes('app-id: "app_b"'));app.client.close();
});
test("new CI admission refreshes Runner state so push policy is available before workflow push",async()=>{
  let configured=false;const app=await controller(registryState("app_a") as any,async(url,init)=>{
    if(url.endsWith("/operations"))return response(automatedOps());
    if(url.endsWith("?resolve=1"))return response({binding:null,identity:ciIdentity()});
    if(url.endsWith("/automation/ci")) { if(init.method === "POST") configured=true;return response({binding:configured?ciBinding():null}); }
    if(url.endsWith("/automation"))return response({jobs:[],runners:configured?[runner]:[],policy:null});
  },{location:{origin:"https://flora.uulab.co.kr"}});await app.client.loadAutomation();await app.client.resolveCI();await app.client.saveCI();assert.equal(app.document.getElementById("automation-policy-save").disabled,false);assert.ok(app.document.getElementById("ci-status").textContent.includes("push 정책을 먼저"));assert.ok(app.document.getElementById("ci-workflow-yaml").textContent.includes(ciSha));app.client.close();
});
test("refreshing changed same-app GitHub connection removes old workflow actions while preserving draft and revocation",async()=>{
  let changed=false;const app=await controller(registryState("app_a") as any,async url=>url.endsWith("/operations")?response({...ops(),connection:{...ops().connection,version:changed?2:1,ref:changed?"next":"main"}}):url.endsWith("/automation/ci")?response({binding:ciBinding()}):undefined);
  await app.client.loadCI();assert.equal(app.document.getElementById("ci-download").hidden,false);app.document.getElementById("ci-workflow").value="draft-controller";changed=true;await app.client.loadOperations();assert.equal(app.document.getElementById("ci-workflow-yaml").textContent,"");assert.equal(app.document.getElementById("ci-download").hidden,true);assert.equal(app.document.getElementById("ci-copy").disabled,true);assert.equal(app.document.getElementById("ci-save").disabled,true);assert.equal(app.document.getElementById("ci-disable").disabled,false);assert.equal(app.document.getElementById("ci-workflow").value,"draft-controller");app.client.close();
});
for (const resolving of [false,true]) test(`cached validated CI permits exact CAS revoke after ${resolving?"identity resolve":"binding GET"} outage`,async()=>{
  let outage=false;let revoked=false;const original=ciBinding();const app=await controller(registryState("app_a") as any,async(url,init)=>{
    if(url.endsWith("/operations"))return response(ops());
    if(url.includes("/automation/ci")){
      if(init.method === "POST") {assert.deepEqual(JSON.parse(init.body as string),{expectedVersion:original.version,enabled:false,repositoryId:original.repositoryId,repositoryOwnerId:original.repositoryOwnerId,ref:original.ref,jobWorkflowRef:original.jobWorkflowRef,jobWorkflowSha:original.jobWorkflowSha});revoked=true;return response({binding:{...original,enabled:false,version:2}});}
      return outage?response({},503):response({binding:original});
    }
  });await app.client.loadCI();outage=true;if(resolving)await app.client.resolveCI();else await app.client.loadCI();assert.equal(app.document.getElementById("ci-save").disabled,true);assert.equal(app.document.getElementById("ci-copy").disabled,true);assert.equal(app.document.getElementById("ci-download").hidden,true);assert.equal(app.document.getElementById("ci-disable").disabled,false);app.document.getElementById("ci-workflow").value="irrelevant draft";await app.client.disableCI();assert.equal(revoked,true);assert.equal(app.document.getElementById("ci-disable").disabled,true);app.client.close();
});
test("a malformed cross-app CI response clears cached revocation authority",async()=>{
  let malformed=false;const app=await controller(registryState("app_a") as any,async url=>url.endsWith("/operations")?response(ops()):url.endsWith("/automation/ci")?response({binding:ciBinding(malformed?"app_b":"app_a")}):undefined);await app.client.loadCI();malformed=true;await app.client.loadCI();assert.equal(app.document.getElementById("ci-disable").disabled,true);const posts=app.calls.filter(c=>c.init.method === "POST").length;await app.client.disableCI();assert.equal(app.calls.filter(c=>c.init.method === "POST").length,posts);app.client.close();
});


test("push policy supports both platforms while manual jobs keep one platform and sibling failures remain visible", async () => {
  let saved: any;
  const jobs = [{id:"ios_job",appId:"app_a",state:"succeeded",platform:"ios",channel:"preview",commitSha:"a".repeat(40),runtimeVersion:"1.0.0",attemptCount:1,deploymentId:"ios_release"},{id:"android_job",appId:"app_a",state:"failed",platform:"android",channel:"preview",commitSha:"a".repeat(40),runtimeVersion:"1.0.0",attemptCount:1,code:"EXPORT_FAILED"}];
  const app = await controller(registryState("app_a") as any, async (url, init) => {
    if(url === "/api/apps/app_a/operations") return response(automatedOps());
    if(url === "/api/apps/app_a/automation") return response({jobs,runners:[runner],policy:{appId:"app_a",version:2,enabled:true,channel:"preview",platforms:["ios","android"]}});
    if(url.endsWith("/policy")){saved=JSON.parse(init.body as string);return response({appId:"app_a",version:3,...saved});}
  });
  await app.client.loadAutomation();
  assert.equal(app.document.getElementById("automation-policy-platforms").value,"both");
  assert.ok(app.document.getElementById("automation-policy-status").textContent.includes("iOS + Android"));
  assert.ok(app.document.getElementById("automation-history").textContent.includes("ios_release"));
  assert.ok(app.document.getElementById("automation-history").textContent.includes("EXPORT_FAILED"));
  app.document.getElementById("automation-platform").value="android";
  await app.client.saveAutomationPolicy();assert.deepEqual(saved.platforms,["ios","android"]);assert.equal(saved.platform,undefined);
  app.document.getElementById("automation-policy-platforms").value="ios";
  await app.client.loadAutomation();assert.equal(app.document.getElementById("automation-policy-platforms").value,"ios");
  app.client.close();
});

test("policy platform selection loads legacy single platform and resets across apps without writes", async () => {
  const app=await controller(registryState("app_a") as any,async url=>{
    if(url.endsWith("/operations"))return response(automatedOps(url.includes("/app_b/")?"app_b":"app_a"));
    if(url==="/api/apps/app_a/automation")return response({jobs:[],runners:[runner],policy:{appId:"app_a",version:1,enabled:true,channel:"preview",platform:"android"}});
    if(url==="/api/apps/app_b/automation")return response({jobs:[],runners:[{...runner,appIds:["app_b"]}],policy:{appId:"app_b",version:4,enabled:true,channel:"preview",platforms:["ios","android"]}});
    if(url.includes("appId=app_b"))return response(registryState("app_b"));
  });
  await app.client.loadAutomation();assert.equal(app.document.getElementById("automation-policy-platforms").value,"android");
  await app.client.chooseApplication("app_b");await app.client.loadAutomation();assert.equal(app.document.getElementById("automation-policy-platforms").value,"both");
  assert.ok(!app.calls.some(c=>c.url.endsWith("/policy")));app.client.close();
});

test("policy refuses unsupported or empty platforms without a write", async () => {
  const ops=automatedOps();ops.detections[0].automationConfig.platforms=["ios"];
  const app=await controller(registryState("app_a") as any,async url=>url.endsWith("/operations")?response(ops):url.endsWith("/automation")?response({jobs:[],runners:[runner],policy:null}):undefined);
  await app.client.loadAutomation();assert.equal(app.document.getElementById("automation-policy-platforms").value,"ios");
  app.document.getElementById("automation-policy-enabled").checked=true;
  for(const value of ["both","android",""]){app.document.getElementById("automation-policy-platforms").value=value;await app.client.saveAutomationPolicy();}
  assert.ok(!app.calls.some(c=>c.url.endsWith("/policy")));assert.ok(app.document.getElementById("automation-status").textContent.includes("플랫폼"));app.client.close();
});


test("late other-app multi-platform policy response cannot overwrite the current selection", async () => {
  const gate=deferred<any>();let reads=0;
  const app=await controller(registryState("app_a") as any,async url=>{
    if(url.endsWith("/operations"))return response(automatedOps(url.includes("/app_b/")?"app_b":"app_a"));
    if(url==="/api/apps/app_a/automation")return ++reads===1?response({jobs:[],runners:[runner],policy:{appId:"app_a",version:1,enabled:true,channel:"a-preview",platforms:["ios","android"]}}):gate.promise;
    if(url==="/api/apps/app_b/automation")return response({jobs:[],runners:[{...runner,appIds:["app_b"]}],policy:{appId:"app_b",version:1,enabled:true,channel:"b-preview",platform:"android"}});
    if(url.includes("appId=app_b"))return response(registryState("app_b"));
  });
  await app.client.loadAutomation();const pending=app.client.loadAutomation();
  await app.client.chooseApplication("app_b");await app.client.loadAutomation();
  gate.resolve(response({jobs:[],runners:[runner],policy:{appId:"app_a",version:2,enabled:true,channel:"late-a",platforms:["ios","android"]}}));await pending;
  assert.equal(app.document.getElementById("automation-policy-platforms").value,"android");assert.equal(app.document.getElementById("automation-channel").value,"b-preview");assert.ok(!app.document.text.includes("late-a"));assert.ok(!app.calls.some(c=>c.url.endsWith("/policy")));app.client.close();
});

test("PC Runner presence distinguishes online offline unseen and revoked and refreshes while idle", async () => {
  let offline = false;
  const app = await controller(registryState("app_a") as any, async url => {
    if (url === "/api/apps/app_a/operations") return response(automatedOps());
    if (url === "/api/apps/app_a/automation") return response({ jobs: [], runners: [
      { ...runner, name: "PC active", presence: { status: offline ? "offline" : "online", lastSeenAt: now } },
      { ...runner, id: "runner_offline", name: "PC stopped", presence: { status: "offline", lastSeenAt: now - 130000 } },
      { ...runner, id: "runner_legacy", name: "PC legacy" },
      { ...runner, id: "runner_never", name: "PC new", presence: { status: "never_seen", lastSeenAt: null } },
      { ...runner, id: "runner_revoked", name: "PC revoked", revokedAt: now, presence: { status: "online", lastSeenAt: now } },
    ] });
  });
  await app.client.navigate("runners", "app_a");
  const rows = app.document.getElementById("automation-runners").children;
  assert.ok(rows[0]); assert.ok(rows[1]); assert.ok(rows[2]); assert.ok(rows[3]); assert.ok(rows[4]);
  assert.ok(rows[0].textContent.includes("온라인")); assert.ok(rows[1].textContent.includes("오프라인"));
  assert.ok(rows[2].textContent.includes("연결 기록 없음")); assert.ok(rows[3].textContent.includes("연결 기록 없음"));
  assert.ok(rows[4].textContent.includes("폐기됨")); assert.ok(!rows[4].textContent.includes("온라인"));
  assert.ok([...app.timers.values()].some(item => item.delay === 30000));
  offline = true; await app.client.loadAutomation();
  const refreshed = app.document.getElementById("automation-runners").children[0]; assert.ok(refreshed);
  assert.ok(refreshed.textContent.includes("오프라인"));
  app.document.getElementById("automation-editor").open = false; await app.client.loadAutomation();
  assert.ok(![...app.timers.values()].some(item => item.delay === 30000)); app.client.close();
});

test("selected app deployment logs separate platforms and expose only structured events", async () => {
  const job = (appId: string, platform: string) => ({ id: `job_${appId}_${platform}`, appId, platform, channel: "verification", commitSha: (appId === "app_a" ? "a" : "b").repeat(40), runtimeVersion: "1", state: "succeeded", deploymentId: `deployment_${appId}_${platform}`, attemptCount: 1, createdAt: now, updatedAt: now });
  const app = await controller(registryState("app_a") as any, async url => {
    const appId = url.includes("/apps/app_b/") ? "app_b" : "app_a";
    if (url.endsWith("/operations")) return response(automatedOps(appId));
    if (url.endsWith("/automation")) return response({ jobs: [job(appId, "ios"), job(appId, "android")], runners: [{...runner,appIds:[appId]}] });
    if (url.endsWith("/jobs/job_app_a_ios")) return response({ job: job("app_a", "ios"), attempts: [], events: ["queued", "claimed", "heartbeat", "succeeded"].map(kind => ({jobId:"job_app_a_ios",createdAt:now,kind,secret:"never-display"})) });
    if (url.includes("appId=app_b")) return response(registryState("app_b"));
  });
  await app.client.loadAutomation(); await app.client.loadAutomationJob("job_app_a_ios");
  const logs = app.document.getElementById("automation-history").textContent;
  for (const value of ["ios", "android", "작업 등록", "KST", "작업 대기", "Runner 작업 시작", "OTA 게시 완료"]) assert.ok(logs.includes(value), value);
  assert.ok(!logs.includes("never-display"));
  await app.client.chooseApplication("app_b"); await app.client.loadAutomation();
  const second = app.document.getElementById("automation-history").textContent;
  assert.ok(second.includes("deployment_app_b_ios")); assert.ok(second.includes("deployment_app_b_android")); assert.ok(!second.includes("deployment_app_a_"));
  app.client.close();
});

test("PC Runner is primary and GitHub Actions setup is an optional collapsed section", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.ok(html.includes("PC Runner · 자동 export / OTA"));assert.ok(html.includes("GitHub Actions는 필요하지 않습니다"));
  assert.match(html, /<details class="ci-connection"><summary>고급 · 선택형 GitHub Actions 연결<\/summary>/);
  assert.ok(!html.includes("최초 빌드 서명은 GitHub CI"));
});

test("OTA signing setup guides the initial native build on PC without requiring GitHub CI", async () => {
  const app = await controller(registryState("app_a") as any, async url => url === "/api/apps/app_a/signing-key" ? response({ appId: "app_a", keyId: "ota-key-1", certificate: "-----BEGIN CERTIFICATE-----\nPUBLIC\n-----END CERTIFICATE-----" }) : undefined);
  await app.client.prepareSigningKey();
  assert.equal(app.document.getElementById("signing-certificate-download").hidden, false);
  const guidance = app.document.getElementById("signing-key-status").textContent;
  assert.ok(guidance.includes("공개 인증서를 포함한 최초 앱 빌드를 PC 또는 자체 Runner"));
  assert.ok(!guidance.includes("GitHub CI")); app.client.close();
});

test("GitHub picker searches all fetched permitted pages and refresh includes a newly granted repository", async () => {
  let granted = false; const app = await controller(registryState("app_a") as any, async url => {
    if (url === "/api/github/connection") return response(githubReady);
    if (url === "/api/github/installations") return response({items:[{id:77,account:"uulab-official",accountType:"Organization",repositorySelection:"selected",suspended:false}],truncated:false});
    if (url.includes("installationId=77")) return response({installationId:77,items:url.includes("cursor=2") ? [{id:10,owner:"uulab-official",repository:"Promise",defaultBranch:"main"},...(granted?[{id:11,owner:"uulab-official",repository:"reward",defaultBranch:"main"}]:[])] : [{id:9,owner:"uulab-official",repository:"Isso",defaultBranch:"main"}],nextCursor:url.includes("cursor=2")?null:"2"});
  });
  await app.client.loadGitHubConnection();
  assert.equal(app.document.getElementById("github-access-settings").getAttribute("href"),"https://github.com/organizations/uulab-official/settings/installations/77");
  assert.ok(app.document.getElementById("github-repository-scope").textContent.includes("선택한 저장소만"));
  assert.ok(app.document.getElementById("github-repository-count").textContent.includes("2개 불러옴"));
  const search = app.document.getElementById("github-repository-search");search.value="pRoMiSe";await search.dispatch("input");
  assert.equal(app.document.getElementById("github-repository-select").textContent,"uulab-official/Promise");
  search.value="reward";await search.dispatch("input");assert.equal(app.document.getElementById("github-repository-use").disabled,true);
  assert.ok(app.document.getElementById("github-managed-status").textContent.includes("검색 결과가 없습니다"));
  app.client.useGitHubRepository();assert.equal(app.document.getElementById("application-repository").value,"");
  granted=true;await app.client.loadGitHubConnection();assert.ok(app.document.getElementById("github-repository-count").textContent.includes("3개 불러옴"));
  assert.equal(app.document.getElementById("github-repository-select").textContent,"uulab-official/reward");
  app.client.useGitHubRepository();assert.equal(app.document.getElementById("application-repository").value,"uulab-official/reward");
  assert.ok(app.calls.every(call=>call.init.method!=="POST"));app.client.close();
});

test("GitHub picker settings links require verified safe identity and account type", async () => {
  for (const installation of [
    {id:77,account:"bonjin-app",accountType:"User",repositorySelection:"all",suspended:false},
    {id:77,account:"uulab",accountType:null,repositorySelection:"selected",suspended:false},
    {id:77,account:"evil/../../attacker",accountType:"Organization",repositorySelection:"selected",suspended:false},
    {id:"77/attacker",account:"uulab",accountType:"Organization",repositorySelection:"selected",suspended:false},
  ]) {
    const app = await controller(registryState("app_a") as any, async url => url==="/api/github/connection" ? response(githubReady) : url==="/api/github/installations" ? response({items:[installation],truncated:false}) : url.startsWith("/api/github/repositories?") ? response({installationId:77,items:[],nextCursor:null}) : undefined);
    await app.client.loadGitHubConnection();const link=app.document.getElementById("github-access-settings");
    if(installation.accountType==="User") {assert.equal(link.hidden,false);assert.equal(link.getAttribute("href"),"https://github.com/settings/installations/77");assert.ok(app.document.getElementById("github-repository-scope").textContent.includes("전체 저장소"));}
    else {assert.equal(link.hidden,true);assert.equal(link.getAttribute("href"),null);}
    app.client.close();
  }
});

test("GitHub repository responses after app switch are discarded and unsafe cursors never become requests", async () => {
  const gate=deferred<any>();let delayed=false;const app=await controller(registryState("app_a") as any,async url=>{
    if(url==="/api/github/connection")return response(githubReady);
    if(url==="/api/github/installations")return response({items:[{id:77,account:"uulab",accountType:"Organization",repositorySelection:"selected",suspended:false}],truncated:false});
    if(url.startsWith("/api/github/repositories?"))return delayed?gate.promise:response({installationId:77,items:[],nextCursor:"https://attacker.invalid"});
    if(url.includes("appId=app_b"))return response(registryState("app_b"));
  });
  await app.client.loadGitHubConnection();assert.equal(app.calls.filter(call=>call.url.startsWith("/api/github/repositories?")).length,1);
  delayed=true;const pending=app.client.loadGitHubRepositories();await app.client.chooseApplication("app_b");
  gate.resolve(response({installationId:77,items:[{id:9,owner:"uulab",repository:"old-reward"}],nextCursor:null}));await pending;
  assert.equal(app.document.getElementById("github-repository-select").textContent,"");assert.equal(app.document.getElementById("github-access-settings").hidden,true);
  assert.ok(!app.document.text.includes("old-reward"));app.client.close();
});

test("GitHub repository pagination is bounded and never replaces earlier permitted pages", async () => {
  let pages=0;const app=await controller(registryState("app_a") as any,async url=>{
    if(url==="/api/github/connection")return response(githubReady);
    if(url==="/api/github/installations")return response({items:[{id:77,account:"uulab",accountType:"Organization",repositorySelection:"all",suspended:false}],truncated:false});
    if(url.startsWith("/api/github/repositories?")){const page=Number(new URL(url,"https://flora.example.test").searchParams.get("cursor")??1);pages++;return response({installationId:77,items:[{id:page,owner:"uulab",repository:"app-"+page}],nextCursor:String(page+1)});}
  });
  await app.client.loadGitHubConnection();assert.equal(pages,10);
  assert.ok(app.document.getElementById("github-repository-select").textContent.includes("uulab/app-1"));assert.ok(app.document.getElementById("github-repository-select").textContent.includes("uulab/app-10"));
  assert.ok(app.document.getElementById("github-managed-status").textContent.includes("조회 한도"));assert.ok(app.document.getElementById("github-repository-count").textContent.includes("아직 불러오지 않은"));
  await app.client.loadGitHubRepositories(true);assert.equal(pages,10);app.client.close();
});

test("saved connection with stale detection never enables OTA or automatic readiness", async () => {
  const current = automatedOps(); current.connection = {...current.connection, version: 2, repository: "reward"};
  const app = await controller(registryState("app_a") as any, async url => url.endsWith("/operations") ? response(current) : url.endsWith("/automation") ? response({jobs:[],runners:[runner],policy:null}) : undefined);
  await app.client.loadAutomation();
  assert.match(app.document.getElementById("github-connection").textContent, /소스 읽기 미검증/);
  assert.ok(!app.document.getElementById("framework-detection").textContent.includes("a".repeat(40)));
  assert.equal(app.document.getElementById("automation-queue").disabled, true);
  assert.match(app.document.getElementById("project-readiness").textContent, /소스 읽기 미검증/);
  app.client.close();
});
test("PC template selects checked manager and includes isolated resource and recovery configuration", async () => {
  const app = await controller(registryState("app_a") as any, async url => url.endsWith("/operations") ? response(automatedOps()) : url.endsWith("/automation") ? response({jobs:[],runners:[],policy:null}) : undefined);
  await app.client.loadAutomation(); const template = JSON.parse(app.document.getElementById("runner-config-template").textContent);
  assert.equal(template.dockerNetwork, "none"); assert.equal(template.resourceProfile, "github-hosted"); assert.equal(template.dependencyPreparation, "pnpm-registry");
  assert.ok(template.recoveryDirectory && template.recoveryDirectory !== template.workDirectory); assert.equal(template.claimPlatform, undefined);
  app.client.close();
});

test("automatic log filters stay app scoped and reset on project switch", async () => {
  const job = (appId: string, platform: string, state: string) => ({id:`${appId}_${platform}`,appId,platform,state,channel:"preview",runtimeVersion:"1.0.0",commitSha:"a".repeat(40),attemptCount:1});
  const app = await controller(registryState("app_a") as any, async url => url.includes("appId=app_b") ? response(registryState("app_b")) : url === "/api/apps/app_a/operations" ? response(automatedOps("app_a")) : url === "/api/apps/app_b/operations" ? response(automatedOps("app_b")) : url === "/api/apps/app_a/automation" ? response({jobs:[job("app_a","ios","succeeded"),job("app_a","android","failed")],runners:[]}) : url === "/api/apps/app_b/automation" ? response({jobs:[job("app_b","ios","queued")],runners:[]}) : undefined);
  await app.client.loadAutomation();app.document.getElementById("automation-history-platform").value="android";await app.document.getElementById("automation-history-platform").dispatch("change");
  assert.match(app.document.getElementById("automation-history").textContent,/a_android/);assert.ok(!app.document.getElementById("automation-history").textContent.includes("a_ios"));
  app.document.getElementById("automation-history-result").value="succeeded";await app.document.getElementById("automation-history-result").dispatch("change");assert.match(app.document.getElementById("automation-history").textContent,/필터에 맞는 작업 없음/);
  await app.client.chooseApplication("app_b");await app.client.loadAutomation();assert.equal(app.document.getElementById("automation-history-platform").value,"all");assert.match(app.document.getElementById("automation-history").textContent,/b_ios/);assert.ok(!app.document.getElementById("automation-history").textContent.includes("a_android"));app.client.close();
});
test("wrong app root cannot reuse a matching GitHub detection", async () => {
  const current = automatedOps(); current.detections[0].rootDirectory="other/app";
  const app = await controller(registryState("app_a") as any, async url => url.endsWith("/operations") ? response(current) : undefined);
  await app.client.loadOperations();assert.match(app.document.getElementById("github-connection").textContent,/소스 읽기 미검증/);assert.equal(app.document.getElementById("ota-deploy").disabled,true);app.client.close();
});

test("source read failure reloads saved identity without claiming repository permission or publication", async () => {
  let saved=false;
  const app=await controller(registryState("app_a") as any,async(url,init)=>{
    if(url==="/api/apps/app_a/operations") {const result=automatedOps();return response(saved?{...result,connection:{...result.connection,version:2,repository:"reward"}}:result);}
    if(url==="/api/apps/app_a/github") {saved=true;return response({error:"GITHUB_REPOSITORY_UNAVAILABLE"},503);}
  });
  await app.client.loadOperations();await app.client.connectGitHub();
  assert.match(app.document.getElementById("operations-status").textContent,/저장소 존재 여부와 GitHub App 허용 범위/);assert.match(app.document.getElementById("github-connection").textContent,/synthetic\/reward/);assert.match(app.document.getElementById("project-readiness").textContent,/소스 읽기 미검증/);assert.equal(app.document.getElementById("github-access-recover").hidden,false);app.client.close();
});
test("same SHA from an old detection cannot become current publication readiness", async()=>{
 const current=automatedOps();const policy={appId:"app_a",version:1,enabled:true,channel:"preview",platforms:["ios","android"]};
 const job={id:"old_ios",appId:"app_a",state:"succeeded",platform:"ios",channel:"preview",runtimeVersion:"1.0.0",commitSha:current.detections[0].commitSha,detectionId:"old_detection",deploymentId:"old_publish",attemptCount:1};
 const app=await controller(registryState("app_a") as any,async url=>url.endsWith("/operations")?response(current):url.endsWith("/automation")?response({jobs:[job],runners:[],policy}):undefined);
 await app.client.loadAutomation();assert.ok(!app.document.getElementById("project-readiness").textContent.includes("old_publish"));assert.match(app.document.getElementById("automation-history").textContent,/old_publish/);app.client.close();
});

test("unsupported source reports app root configuration instead of GitHub App server configuration", async () => {
  const app = await controller(registryState("app_a") as any, async url => url.endsWith("/operations") ? response(automatedOps()) : url.endsWith("/github/sync") ? response({error:"GITHUB_APP_UNSUPPORTED"},422) : undefined);
  await app.client.loadOperations(); await app.client.syncGitHub();
  assert.match(app.document.getElementById("operations-status").textContent,/앱 루트에서 React Native 또는 Expo 앱을 인식하지 못했습니다/);
  assert.match(app.document.getElementById("operations-status").textContent,/package.json/);
  assert.ok(!app.document.getElementById("operations-status").textContent.includes("서버의 GitHub App")); app.client.close();
});
test("failed candidate connection preserves verified old source alongside failure guidance", async () => {
  const previous = automatedOps();
  const app = await controller(registryState("app_a") as any, async url => url.endsWith("/operations") ? response(previous) : url.endsWith("/github") ? response({error:"GITHUB_REPOSITORY_UNAVAILABLE"},503) : undefined);
  await app.client.loadOperations(); app.document.getElementById("github-repository").value="unreadable-candidate"; await app.client.connectGitHub();
  assert.match(app.document.getElementById("operations-status").textContent,/저장소 존재 여부와 GitHub App 허용 범위/);
  assert.match(app.document.getElementById("github-connection").textContent,/synthetic\/expo-app/);
  assert.match(app.document.getElementById("github-connection").textContent,/소스 읽기 확인/);
  assert.ok(!app.document.getElementById("project-readiness").textContent.includes("소스 읽기 미검증"));
  assert.equal(app.document.getElementById("github-access-recover").hidden,true);
  assert.equal(app.document.getElementById("ota-deploy").disabled,false);
  app.client.close();
});

test("initial registered project overview remains neutral until operations are fetched", async () => {
  const initial = {...registryState("app_a"),selected:null,snapshots:{items:[],nextCursor:null},history:{items:[],nextCursor:null}};
  const app = await controller(initial as any,async url=>url.endsWith("/operations")?response(automatedOps()):undefined);
  assert.match(app.document.getElementById("empty").textContent,/프로젝트의 연결과 배포 상태를 확인하세요/);
  assert.ok(!app.document.getElementById("empty").textContent.includes("GitHub 소스를 연결해 주세요"));
  app.document.getElementById("empty").className="application-empty";
  await app.client.loadOperations();assert.match(app.document.getElementById("github-connection").textContent,/소스 읽기 확인/);
  assert.match(app.document.getElementById("empty").textContent,/연결한 GitHub 소스/);app.client.close();
});
test("project cards show operational metadata instead of raw app identifiers",async()=>{
 const app=await controller(registryState("app_a") as any);
 assert.ok(!app.document.getElementById("project-card-app_a").children.some(node=>node.className.includes("project-card-meta")&&node.textContent==="app_a"));
 assert.match(app.document.getElementById("project-card-app_a").textContent,/synthetic\/repo_app_a/);
 assert.match(app.document.getElementById("project-card-app_b").textContent,/synthetic\/repo_app_b/);app.client.close();
});

test("project attention filters combine with search without issuing any additional requests",async()=>{
 const app=await controller(registryState('app_a') as any);const count=app.calls.length;
 const filter=app.document.getElementById('project-status-filter');filter.value='attention';await filter.dispatch('change');assert.equal(app.calls.length,count);assert.match(app.document.getElementById('project-filter-status').textContent,/0/);
 filter.value='all';await filter.dispatch('change');app.document.getElementById('project-search').value='repo_app_b';await app.document.getElementById('project-search').dispatch('input');assert.equal(app.calls.length,count);assert.equal(app.document.getElementById('project-list').children.length,1);assert.equal(app.document.getElementById('project-list').children[0]!.id,'project-card-app_b');
 app.client.close();assert.equal(filter.value,'all');
});
for (const issueFilter of ['issues', 'unresolved', 'resolved']) test("project " + issueFilter + " shortcuts preserve modified clicks and navigate to the selected app deployment without loading per-app operations",async()=>{
 const deployment='b877e6bc-902e-487b-985d-82f179f9ad64',destination='/apps/app_b/ota/'+deployment+'/'+issueFilter;
 const app=await controller(registryState('app_a') as any,async url=>url==='/api/state?appId=app_b'?response(registryState('app_b')):url==='/api/apps/app_b/ota/deployments/'+deployment+'/telemetry?filter='+issueFilter?response({appId:'app_b',deploymentId:deployment,source:'sdk-self-report',observedAt:now,pageSize:20,nextCursor:null,filter:issueFilter,deployment:{id:deployment,platform:'android',channel:'qa',runtimeVersion:'v1',createdAt:now,commitSha:null},summary:null,installations:[]}):undefined);
 app.document.getElementById('project-status-filter').value='attention';app.document.getElementById('project-search').value='repo_app_b';
 const link=app.document.createElement('a');link.setAttribute('href',destination);link.setAttribute('data-project-path',destination);const count=app.calls.length;let prevented=false;
 const click=async(event:any)=>{for(const handler of app.document.getElementById('project-list').listeners.get('click')??[])await handler(event);};
 await click({target:link,ctrlKey:true,preventDefault(){prevented=true;}});assert.equal(app.calls.length,count);assert.equal(prevented,false);
 await click({target:link,preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.ok(app.calls.some(c=>c.url==='/api/apps/app_b/ota/deployments/'+deployment+'/telemetry?filter='+issueFilter));assert.ok(!app.calls.some(c=>c.url.endsWith('/operations')));assert.ok(!app.calls.some(c=>(c.init.method??'GET')!=='GET'));assert.equal(app.document.getElementById('project-status-filter').value,'attention');assert.equal(app.document.getElementById('project-search').value,'repo_app_b');app.client.close();assert.equal(app.document.getElementById('project-status-filter').value,'all');assert.equal(app.document.getElementById('project-search').value,'');
});
test("foreign project shortcut paths cannot trigger navigation or fetches",async()=>{
 const app=await controller(registryState('app_a') as any),count=app.calls.length;const link=app.document.createElement('a');link.setAttribute('data-project-path','/apps/foreign_app/ota/b877e6bc-902e-487b-985d-82f179f9ad64/issues');
 for(const handler of app.document.getElementById('project-list').listeners.get('click')??[])await handler({target:link,preventDefault(){}});assert.equal(app.calls.length,count);app.client.close();
});

test("unqueried automatic policy remains unknown while loaded empty OTA history is explicit",async()=>{
 const app=await controller(registryState("app_a") as any,async url=>url.endsWith("/operations")?response(automatedOps()):undefined);
 await app.client.loadOperations();const summary=app.document.getElementById("project-readiness").textContent;
 assert.match(summary,/자동 배포 정책정책 미확인/);assert.match(summary,/iOS 최근 OTA 게시게시 이력 없음/);assert.ok(!summary.includes("현재 소스와 일치"));app.client.close();
});
test("disabled automatic policy retains matching current source publication evidence",async()=>{
 const detection=automatedOps(); const job={id:"posted_ios",appId:"app_a",state:"succeeded",platform:"ios",channel:"preview",runtimeVersion:"1.0.0",commitSha:detection.detections[0].commitSha,detectionId:detection.detections[0].id,deploymentId:"posted_ota",attemptCount:1};
 const app=await controller(registryState("app_a") as any,async url=>url.endsWith("/operations")?response(detection):url.endsWith("/automation")?response({jobs:[job],runners:[],policy:{appId:"app_a",version:2,enabled:false,channel:"preview",platforms:["ios","android"]}}):undefined);
 await app.client.loadAutomation();assert.match(app.document.getElementById("project-readiness").textContent,/posted_ota/);assert.match(app.document.getElementById("project-readiness").textContent,/자동 배포 정책꺼짐/);app.client.close();
});
test("management overview reuses one summary cache without opening or fetching private Runner history",async()=>{
 const summary={...registrySummary("app_a","Isso"),runner:{status:"online",registeredCount:1,activeCount:1,onlineCount:1,lastSeenAt:now},automation:{enabled:true,channel:"preview",platforms:["ios","android"],updatedAt:now}};
 const app=await controller(registryState("app_a") as any,async url=>url==="/api/projects"?response({projects:[summary],observedAt:now}):undefined);
 await app.client.navigate("overview", "app_a");
 assert.match(app.document.getElementById("project-readiness").textContent,/PC Runner온라인/);assert.match(app.document.getElementById("project-readiness").textContent,/iOS \+ Android/);
 assert.equal(app.document.getElementById("automation-editor").open,false);assert.equal(app.calls.filter(call=>call.url.endsWith("/automation")||call.url.endsWith("/operations")).length,0);assert.equal(app.calls.filter(call=>call.url==="/api/projects").length,1);app.client.close();
});

test("manifest_lost_reply_is_not_replayed_and_current_connection_is_read_back",async()=>{
 let completion=0;
 const app=await controller(state(),async url=>{if(url==="/api/github/manifest/complete"){completion++;throw Error("network lost");}return githubTransport(url);});
 await app.client.completeGitHubManifest({code:"one_use_code",state:"s".repeat(32)});
 assert.equal(completion,1);assert.ok(app.calls.some(c=>c.url==="/api/github/connection"));
 assert.ok(!app.calls.some(c=>c.url==="/api/github/manifest/start"));app.client.close();
});
test("callback_hint_is_fixed_secret_free_and_returns_to_onboarding",async()=>{
 const values=new Map<string,string>([["flora:onboarding-origin","onboarding"]]);
 const app=await controller(state(),async url=>url==="/api/github/manifest/complete"?response(githubReady):githubTransport(url),{sessionStorage:{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)}});
 await app.client.completeGitHubManifest({code:"one_use_code",state:"s".repeat(32)});
 assert.equal(app.client.route().page,"onboarding");assert.equal(values.has("flora:onboarding-origin"),false);app.client.close();
});
test("runner_lost_reply_reads_scoped_list_without_reenrollment",async()=>{
 let posts=0;
 const app=await controller(registryState("app_a") as any,async (url,init)=>{
  if(url==="/api/runners"){posts++;throw Error("lost registration reply");}
  if(url==="/api/apps/app_a/operations")return response(automatedOps());
  if(url==="/api/apps/app_a/automation")return response({jobs:[],runners:[runner],policy:null});
 });
 await app.client.loadAutomation();app.document.getElementById("runner-name").value="QA Runner";
 const before=app.calls.filter(c=>c.url==="/api/apps/app_a/automation").length;
 await app.client.enrollRunner();await app.client.enrollRunner();assert.equal(posts,1);
 assert.ok(app.calls.filter(c=>c.url==="/api/apps/app_a/automation").length>before);
 assert.equal(app.document.getElementById("runner-enroll").disabled,true);
 assert.ok(app.document.getElementById("automation-status").textContent.includes("확인 필요"));app.client.close();
});
