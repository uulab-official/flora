import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

// Synthetic DOM/transport contract tests, not browser or backend integration tests.
class Element {
  children: Element[] = []; attributes: Record<string, string> = {}; value = ""; disabled = false; hidden = false; text = ""; className = ""; id = ""; type = ""; open = false; required = false;
  files: File[] = []; listeners = new Map<string, ((event: any) => unknown)[]>();
  tagName: string;
  constructor(tagName = "div") { this.tagName = tagName; }
  set textContent(value: string) { this.text = value; this.children = []; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  set innerHTML(_value: string) { assert.fail("Untrusted content reached innerHTML"); }
  set outerHTML(_value: string) { assert.fail("Untrusted content reached outerHTML"); }
  get firstElementChild(): Element | null { return this.children[0] ?? null; }
  focus() {}
  setAttribute(name: string, value: string) { assert.ok(!/^on/.test(name)); this.attributes[name] = value; }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.text = ""; this.children = nodes; }
  addEventListener(type: string, handler: (event: any) => unknown) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]); }
  async dispatch(type: string) { for (const handler of this.listeners.get(type) ?? []) await handler({ target: this, preventDefault() {} }); }
}
class Document {
  nodes = new Map<string, Element>(); activeElement: Element | null = null; visibilityState = "visible";
  listeners = new Map<string, ((event: any) => unknown)[]>();
  constructor(file: string) {
    for (const match of readFileSync(new URL("../public/" + file, import.meta.url), "utf8").matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
      const node = new Element(match[1]); node.id = match[2]!; node.hidden = /\bhidden\b/.test(match[0]); node.disabled = /\bdisabled\b/.test(match[0]); this.nodes.set(node.id, node);
    }
  }
  createElement(tag: string) { return new Element(tag); }
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
async function controller(initial = state(), intercept: (url: string, init: RequestInit) => Promise<any> = async () => undefined) {
  const { startClient } = await loadApp(); const document = new Document("index.html"); const calls: { url: string; init: RequestInit }[] = []; const timers = new Map<number, { callback: () => void; delay: number }>(); const events = new Map<string, () => void>(); let nextTimer = 0; let current = initial; const csrf = randomBytes(32).toString("base64url"); let time = now;
  const env = { document, now: () => time, location: { replace() {} }, addEventListener: (type: string, handler: () => void) => events.set(type, handler),
    fetch: async (url: string, init: RequestInit) => { calls.push({ url, init }); return await intercept(url, init) ?? response(url === "/api/auth/session" ? { csrfToken: csrf, expiresAt: now + 3_600_000 } : current); },
    setTimeout(callback: () => void, delay: number) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; }, clearTimeout(id: number) { timers.delete(id); } };
  const client = await startClient(env);
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
    assert.equal(app.calls[0]!.url, "/api/auth/session"); assert.equal(app.calls[1]!.url, "/api/state"); assert.ok(app.document.text.includes(data.selected.repository.fullName)); assert.ok(app.document.text.includes("사용자 반입")); assert.ok(app.document.text.includes("최신 여부 알 수 없음")); assert.ok(app.document.text.includes("호스팅에서는 실행할 수 없음")); app.client.close();
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
  const app = await controller(); assert.equal(app.timers.size, 1); const expiry = [...app.timers.values()][0]!; assert.equal(expiry.delay, 3_600_000);
  const calls = app.calls.length; app.setTime(now + 3_600_000); expiry.callback();
  assert.ok(!app.document.text.includes("synthetic/app")); assert.equal(app.document.getElementById("source-file").disabled, true); assert.equal(app.document.getElementById("login-link").hidden, false);
  await app.client.refresh(); assert.equal(app.calls.length, calls); app.client.close();
});
test("hosted_ui_never_calls_run_cancel_or_polls", async () => {
  const app = await controller(); await app.client.refresh();
  assert.ok(app.calls.every(call => !/runs|cancel|providers/.test(call.url))); assert.equal(app.timers.size, 1);
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8"); assert.ok(!/setInterval|\/api\/runs|\/cancel|localStorage|sessionStorage|console\./.test(source)); app.client.close();
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
test("quota_network_and_database_failure_never_become_empty_history", async () => {
  const app = await controller(state(), async url => url === "/api/state" ? response({ error: "UNAVAILABLE" }, 503) : undefined);
  assert.equal(app.document.getElementById("empty").hidden, true); assert.equal(app.document.getElementById("dashboard-content").hidden, true); assert.ok(app.document.getElementById("notice").textContent.includes("불러오지 못"));
  app.client.close();
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
    const sent = JSON.parse(String(app.calls[0]!.init.body)); assert.equal(sent.password, password); assert.deepEqual(app.navigations, ["/"]); assert.equal(app.document.getElementById("password").value, "");
    if (pathname === "/setup") { assert.equal(sent.confirmation, password); assert.equal(app.calls[0]!.url, "/api/auth/enroll"); assert.equal(app.document.getElementById("token").value, ""); }
    app.client.close();
  }
  for (const name of ["auth.js", "app.js"]) assert.ok(!/localStorage|sessionStorage|console\.|document\.cookie|history\.(?:pushState|replaceState)/.test(readFileSync(new URL("../public/" + name, import.meta.url), "utf8")));
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
    assert.ok(app.document.getElementById("notice").textContent.includes("확인하지 못")); assert.ok(!app.document.getElementById("notice").textContent.includes("저장된 이력에서 확인했습니다")); app.client.close();
  }
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
  function luminance(hex: string) { const value = hex.length === 4 ? "#" + [...hex.slice(1)].map(c => c + c).join("") : hex; return [0.2126, 0.7152, 0.0722].reduce((sum, weight, index) => { const c = parseInt(value.slice(1 + index * 2, 3 + index * 2), 16) / 255; return sum + weight * (c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4); }, 0); }
  for (const [color, background] of [["#1e2c2b", "#f5f6f4"], ["#145d4d", "#fff"], ["#52665a", "#fff"], ["#52665a", "#f5f6f4"], ["#536b5c", "#fff"], ["#244537", "#fbfcfa"], ["#fff", "#145d4d"], ["#fff", "#114f42"], ["#8a5225", "#fff2e9"]]) {
    const values = [luminance(color!), luminance(background!)].sort((a, b) => b - a); assert.ok((values[0]! + .05) / (values[1]! + .05) >= 4.5, color + " on " + background);
  }
});
