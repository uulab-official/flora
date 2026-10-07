import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  open = false;
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
  assert.ok(!/https?:\/\//.test(source), "no external runtime resources or untrusted links");
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
    }, setTimeout(callback, delay) { assert.equal(delay, 1000); const id = ++nextTimer; timers.set(id, callback); return id; }, clearTimeout(handle) { timers.delete(handle as number); } });
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

test("all declared small text colors meet 4.5:1 on their screen backgrounds and text stays readable", () => {
  const css = readFileSync(new URL("../public/app.css", import.meta.url), "utf8");
  const root = css.match(/:root\{([^}]+)\}/)![1]!;
  const variables = Object.fromEntries([...root.matchAll(/(--[\w-]+):([^;}]+)/g)].map(match => [match[1]!, match[2]!]));
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const backgrounds: Record<string, string[]> = {
    ":root": ["#f5f6f4"], ".brand-mark": ["#fcfdfb"], ".brand-caption": ["#fcfdfb"], ".local-pill": ["#fcfdfb"], ".eyebrow": ["#f5f6f4", "#ffffff"],
    ".lede": ["#f5f6f4"], ".import-action p": ["#f5f6f4"], ".primary": ["#145d4d", "#114f42"], ".secondary": ["#ffffff", "#f5f8f4"],
    ".warning": ["#fbf2df"], ".neutral": ["#edf1ed"], ".success": ["#e3f3e8"], ".progress": ["#e6eff7"], ".field label,.field-label": ["#ffffff"],
    "select": ["#fbfcfa"], ".fact-label": ["#ffffff"], ".trust-note": ["#f4f7f3"], ".source-details": ["#ffffff"], "summary": ["#ffffff"], ".count": ["#edf2ec"],
    ".source-pointer": ["#ffffff"], ".quiet-note": ["#ffffff"], ".profile-id": ["#ffffff"], ".subtle": ["#ffffff", "#f5f6f4"], ".warning-text": ["#ffffff"],
    ".check": ["#f6f7f3"], ".reason": ["#ffffff"], ".empty-history": ["#ffffff"], ".timestamp": ["#ffffff"], ".record-id": ["#ffffff"], ".record-code": ["#ffffff"],
    ".record-note": ["#ffffff"], ".log": ["#f6f7f4"], ".notice": ["#edf5ed"], ".notice-error": ["#fff2e9"], ".empty-card>p": ["#ffffff"], "footer": ["#f5f6f4"],
  };
  function luminance(hex: string): number { const full = hex.length === 4 ? "#" + [...hex.slice(1)].map(char => char + char).join("") : hex; return [0.2126, 0.7152, 0.0722].reduce((sum, weight, index) => { const channel = parseInt(full.slice(1 + index * 2, 3 + index * 2), 16) / 255; return sum + weight * (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4); }, 0); }
  const checked = new Set<string>(); const failures: string[] = [];
  for (const rule of rules) {
    const selector = rule[1]!.trim(); const declarations = rule[2]!;
    const color = declarations.match(/(?:^|;)color:([^;]+)/)?.[1];
    if (color) {
      assert.ok(backgrounds[selector], `Explicitly audit the background for ${selector}`); checked.add(selector);
      const foreground = color.startsWith("var(") ? variables[color.slice(4, -1)]! : color;
      for (const background of backgrounds[selector]!) { const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a); const ratio = (values[0]! + 0.05) / (values[1]! + 0.05); if (ratio < 4.5) failures.push(`${selector}: ${foreground} on ${background} = ${ratio.toFixed(2)}:1`); }
    }
    const size = declarations.match(/(?:^|;)font-size:(\d+)px/)?.[1];
    if (size && selector !== ".local-pill span") assert.ok(Number(size) >= 12, `${selector}: ${size}px text is below the 12px screen minimum`);
  }
  assert.deepEqual(checked, new Set(Object.keys(backgrounds))); assert.deepEqual(failures, []);
});
