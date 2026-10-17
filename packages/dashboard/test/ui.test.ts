import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertContrast, contrastStyles } from "../../../tests/css-contrast.ts";
import { parseSourceBundle, CONFIG_RUNTIME_SMOKE_V1 } from "@app-ops/dogfood";
import type { DashboardState } from "@app-ops/dashboard/service";
import { bundleBytes, syntheticSourceBundle } from "../../../tests/dogfood-fixtures.ts";
import { renderDashboard, renderStatus, startClient } from "../public/app.js";

class Element {
  children: Element[] = []; attributes: Record<string, string> = {}; value = ""; disabled = false; hidden = false; text = ""; className = ""; id = ""; type = ""; files: { size: number; text(): Promise<string> }[] = [];
  tagName: string;
  constructor(tagName = "div") { this.tagName = tagName; }
  set textContent(value: string) { this.text = value; this.children = []; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  set innerHTML(_value: string) { assert.fail("Untrusted content reached innerHTML"); }
  open = false; checked = false;
  get firstElementChild(): Element | null { return this.children[0] ?? null; }
  focused = false;
  focus() { this.focused = true; }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  setAttribute(name: string, value: string) { assert.ok(!/^on|href|src/.test(name)); this.attributes[name] = value; }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.text = ""; this.children = nodes; }
  addEventListener() {}
}
class Document {
  nodes = new Map<string, Element>();
  activeElement: Element | null = null;
  createElement(tag: string) { return new Element(tag); }
  getElementById(id: string) {
    const search = (node: Element): Element | undefined => node.id === id ? node : node.children.map(search).find(Boolean);
    for (const node of this.nodes.values()) { const found = search(node); if (found) return found; }
    let node = this.nodes.get(id); if (!node) { node = new Element(); this.nodes.set(id, node); } return node; }
  addEventListener() {}
  get text() { return [...this.nodes.values()].map(node => node.textContent).join("\n"); }
}
async function state(): Promise<DashboardState> {
  const snapshot = structuredClone(await parseSourceBundle(bundleBytes(syntheticSourceBundle()), Date.now()));
  return { snapshots: [snapshot], selectedSnapshotId: snapshot.id, freshness: "freshness_unknown", headObservation: null, history: [], profile: CONFIG_RUNTIME_SMOKE_V1, providers: [{ providerId: "unconfigured-isolated-runner", os: null, capabilities: [], checks: { toolchain: "unknown", filesystem: "unknown", network: "unknown", cpu: "unknown", resources: "unknown", processTreeCancel: "unknown", outputBoundary: "unknown", cleanup: "unknown" }, reasons: ["No verified isolated execution environment is configured"] }] };
}

test("renders Korean hierarchy and distinct imported, unknown, blocked and unevaluated evidence", async () => {
  const document = new Document(); const data = await state(); renderDashboard(document, data);
  for (const text of [data.snapshots[0]!.repository.fullName, data.snapshots[0]!.commitSha.slice(0, 12), "최신 여부 알 수 없음", "일회성", "미평가", "4개", "11개", "미실행"]) assert.ok(document.text.includes(text), text);
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.ok(html.includes("개발 baseline") && html.includes("실행 결과") && html.includes("관람"));
  assert.equal(document.getElementById("run-button").disabled, false, "unsupported requests can record a blocked reason");
  const empty = { ...data, snapshots: [], selectedSnapshotId: null }; renderDashboard(document, empty);
  assert.ok(document.text.includes("소스 JSON")); assert.equal(document.getElementById("run-button").disabled, true);
});

test("rejects cross-site and hostile display input through text-only rendering and bounded logs", async () => {
  const document = new Document(); const data = await state();
  data.snapshots[0]!.repository.fullName = '<img src=x onerror="alert(1)"></script>\x1b]8;;https://evil.test\x07click\x1b]8;;\x07';
  data.history = [{ id: "verification_test", evidenceKind: "isolated-runner-result", state: "failed", code: "CLEANUP_UNCONFIRMED", cleanupCode: "CLEANUP_UNCONFIRMED", createdAt: 0, evidence: { safeLog: "x".repeat(70_000) + "END", logTruncated: false } } as never];
  renderDashboard(document, data);
  assert.ok(document.text.includes("<img")); assert.ok(!document.text.includes("\x1b")); assert.ok(!document.text.includes("https://evil.test"));
  assert.ok(document.text.includes("CLEANUP_UNCONFIRMED")); assert.ok(document.text.includes("정리 확인 안 됨")); assert.ok(document.text.includes("제한")); assert.ok(!document.text.includes("END"));
  assert.ok(document.text.length < 70_000);
});

test("loading, session and error messages offer a practical next step and no cached private content", async () => {
  const document = new Document(); renderDashboard(document, await state());
  renderStatus(document, "loading"); assert.ok(document.text.includes("불러오는 중"));
  renderStatus(document, "session"); assert.ok(document.text.includes("세션")); assert.ok(document.text.includes("서버")); assert.ok(!document.text.includes("synthetic/app"));
  renderStatus(document, "error", "INVALID_INPUT"); assert.ok(document.text.includes("JSON"));
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage|serviceWorker/.test(source));
  assert.ok(!/https?:\/\//.test(source.replace("https://flora.example.com", "")), "no external runtime resources or untrusted links");
});

test("bootstrap fragment is erased before exchange; reload restores cookie session without new bootstrap", async () => {
  for (const bootstrap of ["b".repeat(64), ""]) {
    const document = new Document(); const calls: { url: string; init?: RequestInit }[] = []; let erased = false;
    const client = await startClient({ document, location: { hash: bootstrap ? "#" + bootstrap : "", pathname: "/", search: "" }, history: { replaceState() { erased = true; } },
      fetch: async (url: string, init?: RequestInit) => {
        if (bootstrap) assert.equal(erased, true); calls.push({ url, ...(init ? { init } : {}) });
        return { ok: true, status: 200, json: async () => url === "/api/session" ? { csrfToken: "c".repeat(64) } : await state() };
      }, setTimeout: () => 1, clearTimeout() {}, crypto: { randomUUID: () => "test-request" } });
    assert.equal(calls[0]!.url, "/api/session"); assert.equal(calls[0]!.init?.method ?? "GET", bootstrap ? "POST" : "GET");
    assert.equal(calls[1]!.url, "/api/state"); assert.equal(calls[1]!.init?.cache, "no-store"); client.close();
  }
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function controller(initial: DashboardState, intercept: (url: string, init?: RequestInit) => Promise<unknown> = async () => undefined) {
  const document = new Document(); const calls: { url: string; init?: RequestInit }[] = []; const timers = new Map<number, () => void>(); let nextTimer = 0; let current = initial;
  const client = await startClient({ document, location: { hash: "", pathname: "/", search: "" }, history: { replaceState() {} }, crypto: { randomUUID: () => "synthetic-key" },
    fetch: async (url, init) => {
      calls.push({ url, ...(init ? { init } : {}) }); const override = await intercept(url, init);
      return { ok: true, status: 200, json: async () => override ?? (url === "/api/session" ? { csrfToken: "c".repeat(64) } : current) };
    }, setTimeout(callback, delay) { assert.ok([1000, 5000, 10000, 30000].includes(delay)); const id = ++nextTimer; timers.set(id, callback); return id; }, clearTimeout(handle) { timers.delete(handle as number); } });
  return { client, document, calls, timers, setState(value: DashboardState) { current = value; } };
}

test("duplicate clicks share one request and uncertain retries retain the same idempotency key", async () => {
  const data = await state(); const gate = deferred<void>(); let attempts = 0;
  const app = await controller(data, async url => { if (url === "/api/runs") { attempts++; if (attempts === 1) { await gate.promise; throw new Error("network"); } } });
  try {
    const first = app.client.run(); await app.client.run(); assert.equal(attempts, 1); gate.resolve(); await first;
    assert.ok(app.document.text.includes("요청을 완료하지 못했습니다"));
    await app.client.run(); assert.equal(attempts, 2);
    const requests = app.calls.filter(call => call.url === "/api/runs").map(call => JSON.parse(String(call.init!.body)));
    assert.equal(requests[0].requestKey, requests[1].requestKey); assert.equal(requests[0].snapshotId, data.selectedSnapshotId);
  } finally { app.client.close(); }
});

test("only active records poll and cancel; terminal records stop scheduling", async () => {
  const data = await state(); const active = { id: "verification_active", snapshotId: data.selectedSnapshotId, state: "running", requestKind: "run-request", requestKey: "active-key", evidenceKind: "isolated-runner-result", createdAt: 0 } as never;
  data.history = [active]; const app = await controller(data);
  try {
    assert.equal(app.timers.size, 1); assert.equal(app.document.getElementById("run-button").disabled, true);
    await app.client.cancel("missing"); assert.equal(app.calls.filter(call => call.url.endsWith("/cancel")).length, 0);
    await app.client.cancel("verification_active"); assert.equal(app.calls.filter(call => call.url.endsWith("/cancel")).length, 1);
    assert.deepEqual(JSON.parse(String(app.calls.find(call => call.url.endsWith("/cancel"))!.init!.body)), {});
    app.setState({ ...data, history: [{ ...data.history[0]!, state: "blocked" }] }); await app.client.refresh();
    assert.equal(app.timers.size, 0); assert.equal(app.document.getElementById("run-button").disabled, false);
    await app.client.cancel("verification_active"); assert.equal(app.calls.filter(call => call.url.endsWith("/cancel")).length, 1);
  } finally { app.client.close(); }
});

test("empty invalid and oversized file inputs do not reach an import endpoint", async () => {
  const app = await controller(await state());
  try {
    await app.client.importFile("source");
    await app.client.importFile("source", { size: 1, text: async () => "{" });
    await app.client.importFile("source", { size: 2 * 1024 * 1024 + 1, text: async () => assert.fail("Oversized file was read") });
    assert.equal(app.calls.filter(call => call.url === "/api/sources").length, 0);
    assert.ok(app.document.text.includes("BODY_TOO_LARGE"));
  } finally { app.client.close(); }
});

test("a newer revision selection fences delayed state responses", async () => {
  const initial = await state(); const old = deferred<DashboardState>(); const newer = { ...initial, selectedSnapshotId: "inventory_new", snapshots: [{ ...initial.snapshots[0]!, id: "inventory_new", repository: { ...initial.snapshots[0]!.repository, fullName: "synthetic/new" } }] };
  const app = await controller(initial, async url => { if (url.includes("snapshotId=inventory_old")) return old.promise; if (url.includes("snapshotId=inventory_new")) return newer; });
  try {
    const oldRequest = app.client.chooseSnapshot("inventory_old"); await app.client.chooseSnapshot("inventory_new"); old.resolve(initial); await oldRequest;
    assert.equal(app.document.getElementById("app-name").textContent, "synthetic/new");
  } finally { app.client.close(); }
});

test("authorization loss clears private evidence and halts polling", async () => {
  const document = new Document(); const data = await state(); let calls = 0; let denied = false;
  const client = await startClient({ document, location: { hash: "", pathname: "/", search: "" }, history: { replaceState() {} }, crypto: { randomUUID: () => "key" }, setTimeout: () => 1, clearTimeout() {},
    fetch: async (url: string) => { calls++; return { ok: !denied, status: denied ? 401 : 200, json: async () => url === "/api/session" ? { csrfToken: "c".repeat(64) } : data }; } });
  denied = true; await client.run(); assert.ok(document.text.includes("세션이 없거나 만료")); assert.equal(document.getElementById("app-name").textContent, "");
  const before = calls; await client.run(); assert.equal(calls, before); client.close();
});

test("log display bounds apply to UTF-8 bytes, not only character count", async () => {
  const document = new Document(); const data = await state();
  data.history = [{ id: "verification_unicode", evidenceKind: "isolated-runner-result", state: "failed", createdAt: 0, evidence: { safeLog: "🙂".repeat(30_000), logTruncated: false } } as never];
  renderDashboard(document, data);
  const logNodes: Element[] = [];
  function visit(node: Element): void { if (node.tagName === "pre") logNodes.push(node); node.children.forEach(visit); }
  visit(document.getElementById("run-history"));
  assert.equal(logNodes.length, 1); assert.ok(Buffer.byteLength(logNodes[0]!.textContent, "utf8") <= 65_536); assert.ok(logNodes[0]!.textContent.includes("제한"));
});

test("recoverable errors expose a retry action while loading and session expiry do not", () => {
  const document = new Document(); renderStatus(document, "error", "REQUEST_FAILED"); assert.equal(document.getElementById("retry-button").hidden, false);
  renderStatus(document, "loading"); assert.equal(document.getElementById("retry-button").hidden, true);
  renderStatus(document, "session"); assert.equal(document.getElementById("retry-button").hidden, true);
});

test("active polling preserves keyboard focus on the cancel action", async () => {
  const document = new Document(); const data = await state();
  data.history = [{ id: "verification_focus", state: "running", evidenceKind: "isolated-runner-result", createdAt: 0 } as never];
  renderDashboard(document, data);
  const findCancel = (node: Element): Element | undefined => node.attributes["data-cancel"] ? node : node.children.map(findCancel).find(Boolean);
  const before = findCancel(document.getElementById("run-history"))!; document.activeElement = before;
  renderDashboard(document, data);
  const after = findCancel(document.getElementById("run-history"))!;
  assert.equal(after.focused, true); assert.notEqual(after, before);
});

test("skip-link and ordinary anchor reloads restore the cookie session without consuming a bootstrap", async () => {
  for (const hash of ["#workspace", "#source-details", "#not-a-token"]) {
    const document = new Document(); const calls: { url: string; method: string; body?: string }[] = []; let replaced = false;
    const client = await startClient({ document, location: { hash, pathname: "/", search: "" }, history: { replaceState() { replaced = true; } }, crypto: { randomUUID: () => "key" }, setTimeout: () => 1, clearTimeout() {},
      fetch: async (url, init) => { calls.push({ url, method: init?.method ?? "GET", ...(init?.body ? { body: String(init.body) } : {}) }); return { ok: true, status: 200, json: async () => url === "/api/session" ? { csrfToken: "c".repeat(64) } : await state() }; } });
    assert.equal(calls[0]!.method, "GET"); assert.equal(calls[0]!.body, undefined); assert.equal(replaced, false, "ordinary navigation anchors remain in history");
    assert.equal(document.getElementById("notice").hidden, true); assert.ok(document.getElementById("app-name").textContent); client.close();
  }
});

test("canonical expired or replayed bootstrap is erased then rejected without cookie fallback", async () => {
  for (const reason of ["expired", "replayed"]) {
    const document = new Document(); const calls: string[] = []; let erased = false;
    const client = await startClient({ document, location: { hash: "#" + "a".repeat(64), pathname: "/", search: "" }, history: { replaceState() { erased = true; } }, crypto: { randomUUID: () => "key" }, setTimeout: () => 1, clearTimeout() {},
      fetch: async (url, init) => { assert.equal(erased, true); assert.equal(init?.method, "POST", reason); calls.push(url); return { ok: false, status: 401, json: async () => ({ error: "SESSION_REQUIRED" }) }; } });
    assert.deepEqual(calls, ["/api/session"]); assert.ok(document.getElementById("notice").textContent.includes("세션이 없거나 만료")); client.close();
  }
});

for (const kind of ["baseline-history", "provider"] as const) test(`${kind} disclosure keeps its open state and summary keyboard focus across active polls`, async () => {
  const document = new Document(); const data = await state();
  data.history = [
    { id: "verification_baseline", state: "passed", evidenceKind: "development-baseline", createdAt: 0, evidence: { safeLog: "synthetic log" } } as never,
    { id: "verification_active", state: "running", evidenceKind: "isolated-runner-result", createdAt: 0 } as never,
  ];
  const find = (node: Element, tag: string): Element | undefined => node.tagName === tag ? node : node.children.map(child => find(child, tag)).find(Boolean);
  renderDashboard(document, data);
  const before = find(document.getElementById(kind), "details")!; before.open = true;
  const summary = find(before, "summary")!; const content = before.children[1]; document.activeElement = summary;
  renderDashboard(document, structuredClone(data));
  const after = find(document.getElementById(kind), "details")!;
  assert.equal(after.open, true); assert.equal(after, before, "reuse the stable disclosure node");
  const nextSummary = find(after, "summary")!; assert.equal(nextSummary, summary); assert.equal(nextSummary.focused, true); assert.equal(after.children[1], content, "unchanged content nodes retain scroll position");
  after.open = false; document.activeElement = null; renderDashboard(document, structuredClone(data));
  assert.equal(find(document.getElementById(kind), "details")!.open, false, "closed remains closed too");
});

test("a stale failed selection cannot replace newer ready content or feedback", async () => {
  for (const status of [500, 401]) {
    const initial = await state(); let reject!: (error: Error & { status: number }) => void;
    const old = new Promise<DashboardState>((_resolve, fail) => { reject = fail; });
    const newer = { ...initial, selectedSnapshotId: "inventory_new", snapshots: [{ ...initial.snapshots[0]!, id: "inventory_new", repository: { ...initial.snapshots[0]!.repository, fullName: "synthetic/new" } }] };
    const app = await controller(initial, async url => { if (url.includes("snapshotId=inventory_old")) return old; if (url.includes("snapshotId=inventory_new")) return newer; });
    try {
      const oldRequest = app.client.chooseSnapshot("inventory_old"); await app.client.chooseSnapshot("inventory_new");
      reject(Object.assign(new Error("obsolete failure"), { status })); await oldRequest;
      assert.equal(app.document.getElementById("app-name").textContent, "synthetic/new");
      assert.equal(app.document.getElementById("notice").hidden, true); assert.equal(app.document.getElementById("retry-button").hidden, true);
    } finally { app.client.close(); }
  }
});

test("all declared small text colors meet 4.5:1 on their current CSS backgrounds and text stays readable", () => {
  const css = readFileSync(new URL("../public/app.css", import.meta.url), "utf8");
  const styles = contrastStyles(css);
  // These selectors identify the surfaces each text role can actually appear on.
  const backgrounds: Record<string, string[]> = {
    ":root": [":root"], ".brand-mark": [".topbar"], ".brand-caption": [".topbar"], ".local-pill": [".topbar"], ".eyebrow": [":root", ".card"],
    ".lede": [":root"], ".import-action p": [":root"], ".primary": [".primary", ".primary:hover"], ".secondary": [".secondary", ".secondary:hover"],
    ".warning": [".warning"], ".neutral": [".neutral"], ".success": [".success"], ".progress": [".progress"], ".field label,.field-label": [".card"],
    "select": ["select"], ".fact-label": [".card"], ".trust-note": [".trust-note"], ".source-details": [".card"], "summary": [".card"], ".count": [".count"],
    ".source-pointer": [".card"], ".quiet-note": [".card"], ".profile-id": [".card"], ".subtle": [".card", ":root"], ".warning-text": [".card"],
    ".check": [".check"], ".reason": [".card"], ".empty-history": [".card"], ".timestamp": [".card"], ".record-id": [".card"], ".record-code": [".card"],
    ".record-note": [".card"], ".log": [".log"], ".notice": [".notice"], ".notice-error": [".notice-error"], ".empty-card>p": [".empty-card"], "footer": [":root"],
  };
  const checked = new Set<string>();
  for (const { selector, declarations } of styles.rules) {
    if (/(?:^|;)color:/.test(declarations)) {
      assert.ok(backgrounds[selector], `Explicitly audit the background for ${selector}`); checked.add(selector);
      for (const background of backgrounds[selector]!) assertContrast(styles.color(selector), styles.color(background, "background"), 4.5, selector);
    }
    const size = declarations.match(/(?:^|;)font-size:(\d+)px/)?.[1];
    if (size && selector !== ".local-pill span") assert.ok(Number(size) >= 12, `${selector}: ${size}px text is below the 12px screen minimum`);
  }
  assert.deepEqual(checked, new Set(Object.keys(backgrounds)));
  const focus = "button:focus-visible,a:focus-visible,summary:focus-visible,select:focus-visible,.file-input:focus-visible";
  for (const surface of [":root", ".topbar", ".card", ".trust-note", ".notice"]) assertContrast(styles.color(focus, "outline"), styles.color(surface, "background"), 3, "focus on " + surface);
});

function registered(id: string) { return { id, name: "등록 앱 " + id, repositoryId: "repo_" + id, rootDirectory: ".", createdAt: 0, settings: { version: 0, values: { PUBLIC_NAME: id }, updatedAt: 0 } }; }
async function registeredState(id: string): Promise<DashboardState> { return { ...await state(), applications: [registered("a"), registered("b")].map(({ id, name, createdAt }) => ({ id, name, createdAt })), selectedApplication: registered(id) } as DashboardState; }

test("local application selector and settings remain available without a source snapshot", async () => {
  const data = { ...await registeredState("a"), snapshots: [], selectedSnapshotId: null };
  const app = await controller(data);
  assert.equal(app.document.getElementById("application-panel").hidden, false);
  assert.equal(app.document.getElementById("application-settings").hidden, false);
  assert.equal(app.document.getElementById("application-count").textContent, "2개");
  assert.equal(app.document.getElementById("settings-editor").open, false);
  assert.ok(!app.document.getElementById("application-select").textContent.includes("undefined"));
  assert.equal(app.document.getElementById("run-button").disabled, true);
  app.client.close();
  assert.equal(app.document.getElementById("settings-json").value, "");
});

test("local app switch clears private content before loading and ignores older responses", async () => {
  const gate = deferred<DashboardState>(); let delayed = false;
  const app = await controller(await registeredState("a"), async url => {
    if (delayed && url.includes("appId=a")) return gate.promise;
    if (url.includes("appId=b")) return registeredState("b");
  });
  delayed = true; const old = app.client.refresh(); const switching = app.client.chooseApplication("b");
  assert.equal(app.document.getElementById("settings-json").value, "");
  assert.equal(app.document.getElementById("baseline-file").disabled, true);
  await app.client.run(); assert.ok(!app.calls.some(call => call.url.startsWith("/api/runs")));
  await switching; gate.resolve(await registeredState("a")); await old;
  assert.equal(app.document.getElementById("application-select").value, "b");
  assert.equal(JSON.parse(app.document.getElementById("settings-json").value).PUBLIC_NAME, "b");
  app.client.close();
});

test("local settings and registration post bounded JSON with version and identity", async () => {
  const app = await controller(await registeredState("a"), async (url, init) => {
    if (url === "/api/apps/a/settings") { assert.deepEqual(JSON.parse(init!.body as string), { expectedVersion: 0, values: { PUBLIC_NAME: "updated" } }); return { ...registered("a"), settings: { version: 1, values: { PUBLIC_NAME: "updated" }, updatedAt: 1 } }; }
    if (url === "/api/apps") { assert.deepEqual(JSON.parse(init!.body as string), { name: "New", repositoryId: "repo_new", rootDirectory: "apps/new" }); return registered("b"); }
  });
  app.document.getElementById("settings-json").value = '{"PUBLIC_NAME":"updated"}'; await app.client.saveSettings();
  app.document.getElementById("application-name").value = "New"; app.document.getElementById("application-repository").value = "repo_new"; app.document.getElementById("application-root").value = "apps/new";
  app.document.getElementById("application-registration").open = true;
  await app.client.registerApplication(); assert.equal(app.document.getElementById("application-registration").open, false); assert.ok(app.calls.some(call => call.url === "/api/state?appId=b"));
  app.client.close();
});

function localOps() { const connection = { appId: "a", version: 1, installationId: 123, owner: "synthetic", repository: "expo-app", ref: "main", connectedAt: 0 }; return { connection, detections: [{ id: "detection_a", appId: "a", connection, rootDirectory: ".", detectedAt: 0, commitSha: "a".repeat(40), framework: "expo", expoVersion: "57", reactNativeVersion: "0.86", configSource: "app.json", runtimeVersion: "1.0.0", platforms: ["ios"], updatesEnabled: true, updatesUrl: "/updates/a", reasons: [] }], assets: [], deployments: [] }; }

test("local GitHub operations use selected app, real export uploads and pinned publication fields", async () => {
  let count = 0; let publication: any;
  const app = await controller(await registeredState("a"), async (url, init) => {
    if (url === "/api/apps/a/operations") return localOps();
    if (url.startsWith("/api/apps/a/ota/assets?")) { assert.ok(init?.body instanceof File); return { id: "asset_" + ++count, appId: "a" }; }
    if (url === "/api/apps/a/ota/deployments") { publication = JSON.parse(init!.body as string); return { id: "deployment_1", appId: "a" }; }
  });
  await app.client.loadOperations();
  assert.ok(app.document.getElementById("framework-detection").textContent.includes("1.0.0"));
  app.document.getElementById("ota-platform").value = "ios"; app.document.getElementById("ota-channel").value = "preview";
  app.document.getElementById("ota-launch").files = [new File(["real export"], "ios.js")];
  await app.client.deployOTA();
  assert.equal(publication.commitSha, "a".repeat(40)); assert.equal(publication.runtimeVersion, "1.0.0"); assert.equal(publication.launchAssetId, "asset_1");
  app.client.close(); assert.equal(app.document.getElementById("github-owner").value, "");
});

test("session clearing also erases the connected GitHub summary for apps without legacy snapshots", async () => {
  const app = await controller({ ...await registeredState("a"), snapshots: [], selectedSnapshotId: null }, async url => url === "/api/apps/a/operations" ? localOps() : undefined);
  await app.client.loadOperations(); assert.ok(app.document.getElementById("empty").textContent.includes("synthetic/expo-app"));
  app.client.close(); assert.equal(app.document.getElementById("empty").textContent, ""); assert.ok(!app.document.text.includes("synthetic/expo-app"));
});

test("local visible automation polls active jobs and clears timers and nonsecret template on close", async () => {
  let terminal = false; const app = await controller(await registeredState("a"), async url => {
    if (url === "/api/apps/a/operations") return localOps();
    if (url === "/api/apps/a/automation") return { jobs: [{ id: "job_a", appId: "a", state: terminal ? "failed" : "queued", attemptCount: 0 }], runners: [] };
  });
  app.document.getElementById("automation-editor").open = true; await app.client.loadAutomation(); assert.equal(app.timers.size, 1);
  terminal = true; [...app.timers.values()][0]!(); await new Promise(resolve => setImmediate(resolve)); assert.equal(app.timers.size, 0);
  assert.ok(app.document.getElementById("runner-config-template").textContent.includes("REPLACE_WITH_ONE_TIME")); app.client.close();
  assert.equal(app.document.getElementById("runner-config-template").textContent, "");
});

test("project cards show real registry entries, search safely and keep repository details scoped to selection", async () => {
  const document = new Document();
  const data = await registeredState("a");
  data.applications![1]!.name = '<img src=x onerror="bad()">';
  renderDashboard(document, data);
  const list = document.getElementById("project-list");
  assert.equal(list.children.length, 2);
  assert.equal(list.children[0]!.getAttribute("data-select-application"), data.applications![0]!.id);
  assert.equal(list.children[0]!.getAttribute("aria-pressed"), "true");
  assert.equal(list.children[1]!.getAttribute("aria-pressed"), "false");
  assert.ok(list.textContent.includes('<img src=x'));
  assert.ok(list.textContent.includes(data.selectedApplication!.repositoryId));
  assert.ok(!list.textContent.includes(registered("b").repositoryId));
  assert.equal(document.getElementById("project-total").textContent, "2개 프로젝트");
  document.getElementById("project-search").value = "does-not-exist";
  renderDashboard(document, data);
  assert.equal(list.textContent, "검색한 프로젝트가 없습니다.");
  document.getElementById("project-search").value = data.applications![1]!.id;
  renderDashboard(document, data);
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0]!.getAttribute("data-select-application"), data.applications![1]!.id);
  assert.equal(list.children[0]!.getAttribute("aria-pressed"), "false");
});

test("local OTA links use public content digests and invalid metadata cannot create a download link", async () => {
  const result: any = localOps();
  result.deployments = [{ id: "deployment_a", appId: "a", channel: "preview", runtimeVersion: "1.0.0", platform: "ios", commitSha: "a".repeat(40), createdAt: 1, launchAsset: { id: "asset_" + "e".repeat(64), digest: "e".repeat(64) }, assets: [] }];
  const app = await controller(await registeredState("a"), async url => url === "/api/apps/a/operations" ? result : undefined);
  await app.client.loadOperations();
  const history = app.document.getElementById("ota-history");
  const link = history.children[0]!.children.find(child => child.tagName === "a")!;
  assert.equal((link as any).href, "/updates/a/assets/" + "e".repeat(64));
  result.deployments[0].launchAsset.digest = "../private";
  await app.client.loadOperations();
  assert.ok(history.textContent.includes("다운로드 주소 확인 필요"));
  assert.ok(!history.children[0]!.children.some(child => child.tagName === "a"));
  app.client.close();
});

test("registered projects without a selected snapshot use project guidance instead of legacy flavor import", async () => {
  const document = new Document();
  const data = await registeredState("a");
  renderDashboard(document, { ...data, snapshots: [], selectedSnapshotId: null, selectedApplication: null });
  assert.ok(document.getElementById("empty").textContent.includes("프로젝트를 선택해 주세요"));
  assert.ok(!document.getElementById("empty").textContent.includes("11개 flavor"));
});

test("successful registration clears the old project filter and focuses the new selected card", async () => {
  const next = await registeredState("b");
  const app = await controller(await registeredState("a"), async url => url === "/api/apps" ? registered("b") : url === "/api/state?appId=b" ? next : undefined);
  app.document.getElementById("project-search").value = "only-old-project";
  app.document.getElementById("application-name").value = "B";
  app.document.getElementById("application-repository").value = "repo_b";
  app.document.getElementById("application-root").value = ".";
  await app.client.registerApplication();
  assert.equal(app.document.getElementById("project-search").value, "");
  assert.equal(app.document.getElementById("project-list").children.length, 2);
  const card = app.document.getElementById("project-card-b");
  assert.equal(card.getAttribute("aria-pressed"), "true");
  assert.equal(card.focused, true);
  app.client.close();
});

function localAutomatedOps(id = "a", platforms = ["ios", "android"]) {
  const result:any = localOps();result.connection.appId=id;const detection=result.detections[0];detection.appId=id;detection.configSource="flora.config.json";detection.automationConfig={bundler:"metro",entryFile:"index.js",runtimeVersion:"1.0.0",platforms,toolchain:{nodeVersion:"24.19.0",packageManager:{name:"npm",version:"10.9.8"}}};return result;
}
const localRunner={id:"runner_a",name:"Runner",appIds:["a"],revokedAt:null};
test("local push policy saves both platforms separately from manual jobs and retains sibling failures", async()=>{
  assert.ok(readFileSync(new URL("../public/index.html", import.meta.url), "utf8").includes('id="automation-policy-platforms"'));
  let saved:any;let queued:any;const jobs=[{id:"ios_job",appId:"a",state:"succeeded",platform:"ios",channel:"preview",commitSha:"a".repeat(40),runtimeVersion:"1.0.0",attemptCount:1,deploymentId:"ios_deploy"},{id:"android_job",appId:"a",state:"failed",platform:"android",channel:"preview",commitSha:"a".repeat(40),runtimeVersion:"1.0.0",attemptCount:1,code:"EXPORT_FAILED"}];
  const app=await controller(await registeredState("a"),async(url,init)=>{
    if(url.endsWith("/operations"))return localAutomatedOps();
    if(url.endsWith("/automation"))return {jobs,runners:[localRunner],policy:{appId:"a",version:2,enabled:true,channel:"preview",platforms:["ios","android"]}};
    if(url.endsWith("/policy")){saved=JSON.parse(init!.body as string);return {appId:"a",version:3,...saved};}
    if(url.endsWith("/jobs")){queued=JSON.parse(init!.body as string);return {appId:"a",id:"manual_job",state:"queued"};}
  });
  await app.client.loadAutomation();assert.equal(app.document.getElementById("automation-policy-platforms").value,"both");assert.ok(app.document.getElementById("automation-policy-status").textContent.includes("iOS + Android"));assert.ok(app.document.getElementById("automation-history").textContent.includes("ios_deploy"));assert.ok(app.document.getElementById("automation-history").textContent.includes("EXPORT_FAILED"));
  app.document.getElementById("automation-platform").value="android";await app.client.queueAutomation();assert.equal(queued.platform,"android");assert.equal(queued.platforms,undefined);
  await app.client.saveAutomationPolicy();assert.deepEqual(saved,{expectedVersion:2,enabled:true,channel:"preview",platforms:["ios","android"]});
  app.document.getElementById("automation-policy-platforms").value="ios";await app.client.loadAutomation();assert.equal(app.document.getElementById("automation-policy-platforms").value,"ios");app.client.close();
});
test("local policy supports legacy singleton and fences late response during two-app switch", async()=>{
  const gate=deferred<any>();let reads=0;const app=await controller(await registeredState("a"),async url=>{
    if(url.endsWith("/operations"))return localAutomatedOps(url.includes("/b/")?"b":"a");
    if(url==="/api/apps/a/automation")return ++reads===1?{jobs:[],runners:[localRunner],policy:{appId:"a",version:1,enabled:true,channel:"a-preview",platforms:["ios","android"]}}:gate.promise;
    if(url==="/api/apps/b/automation")return {jobs:[],runners:[{...localRunner,appIds:["b"]}],policy:{appId:"b",version:1,enabled:true,channel:"b-preview",platform:"android"}};
    if(url.includes("appId=b"))return registeredState("b");
  });
  await app.client.loadAutomation();const pending=app.client.loadAutomation();await app.client.chooseApplication("b");await app.client.loadAutomation();gate.resolve({jobs:[],runners:[localRunner],policy:{appId:"a",version:2,enabled:true,channel:"late-a",platforms:["ios","android"]}});await pending;
  assert.equal(app.document.getElementById("automation-policy-platforms").value,"android");assert.equal(app.document.getElementById("automation-channel").value,"b-preview");assert.ok(!app.document.text.includes("late-a"));assert.ok(!app.calls.some(c=>c.url.endsWith("/policy")));app.client.close();
});
test("local policy defaults to supported platforms and refuses unsupported or empty selections",async()=>{
  const app=await controller(await registeredState("a"),async url=>url.endsWith("/operations")?localAutomatedOps("a",["ios"]):url.endsWith("/automation")?{jobs:[],runners:[localRunner],policy:null}:undefined);
  await app.client.loadAutomation();assert.equal(app.document.getElementById("automation-policy-platforms").value,"ios");app.document.getElementById("automation-policy-enabled").checked=true;
  for(const value of ["both","android",""]){app.document.getElementById("automation-policy-platforms").value=value;await app.client.saveAutomationPolicy();}
  assert.ok(!app.calls.some(c=>c.url.endsWith("/policy")));assert.ok(app.document.getElementById("automation-status").textContent.includes("플랫폼"));app.client.close();
});

test("local PC Runner presence preserves unseen legacy rows and refreshes idle scoped status", async () => {
  const app = await controller(await registeredState("a"), async url => {
    if (url.endsWith("/operations")) return localAutomatedOps();
    if (url.endsWith("/automation")) return { jobs: [], runners: [
      {...localRunner, presence:{status:"online",lastSeenAt:1}},
      {...localRunner,id:"offline",presence:{status:"offline",lastSeenAt:1}},
      {...localRunner,id:"old"},
      {...localRunner,id:"revoked",revokedAt:1,presence:{status:"online",lastSeenAt:1}},
    ] };
  });
  app.document.getElementById("automation-editor").open = true;await app.client.loadAutomation();
  const rows = app.document.getElementById("automation-runners").children;
  assert.ok(rows[0]);assert.ok(rows[1]);assert.ok(rows[2]);assert.ok(rows[3]);
  assert.ok(rows[0].textContent.includes("온라인"));assert.ok(rows[1].textContent.includes("오프라인"));
  assert.ok(rows[2].textContent.includes("연결 기록 없음"));assert.ok(rows[3].textContent.includes("폐기됨"));assert.ok(!rows[3].textContent.includes("온라인"));
  assert.equal(app.timers.size,1);app.client.close();assert.equal(app.timers.size,0);
});
