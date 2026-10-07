import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { bridgeRequest, SYNTHETIC_ORIGIN } from "../scripts/hosted-qa/transport.mjs";
import { createResponseGate } from "../scripts/hosted-qa/response-gate.mjs";
import { measureMobileAppDensity } from "../scripts/hosted-qa/mobile-density.mjs";
import { clickScaledPointer, scaledPointerPoint } from "../scripts/hosted-qa/scaled-pointer.mjs";

const scaledGeometry = () => ({ box: { x: 16, y: 390.094, width: 262.875, height: 67 },
  visual: { offsetLeft: 16, offsetTop: 390, width: 195, height: 422, scale: 2 } });

test("scaled pointer maps the observed visible CSS intersection back to DOM hit coordinates", () => {
  const point = scaledPointerPoint(scaledGeometry());
  assert.equal(point.x, 97.5); assert.ok(Math.abs(point.y - 33.594) < 0.001);
  assert.equal(point.clientX, 113.5); assert.ok(Math.abs(point.clientY - 423.594) < 0.001);
  assert.equal(point.scale, 2);
});

test("scaled pointer rejects invalid scale, coordinates, dimensions and fully clipped targets", () => {
  for (const changed of [null, {}, { ...scaledGeometry(), visual: { ...scaledGeometry().visual, scale: 1 } },
    ...[NaN, Infinity, -Infinity, 1_000_001, "16"].map(x => ({ ...scaledGeometry(), box: { ...scaledGeometry().box, x } })),
    ...[0, -1].map(width => ({ ...scaledGeometry(), box: { ...scaledGeometry().box, width } })),
    { ...scaledGeometry(), box: { ...scaledGeometry().box, x: 500 } }]) {
    assert.throws(() => scaledPointerPoint(changed), /INVALID_SCALED_POINTER_GEOMETRY|SCALED_POINTER_OUTSIDE_VIEWPORT/);
  }
});

function scaledPointerHarness(options: { obstructed?: boolean; trusted?: boolean; displaced?: boolean; moved?: boolean; disabled?: boolean } = {}) {
  const geometry = scaledGeometry(), calls: string[] = [], clicks: number[][] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  let reads = 0;
  const target = { isConnected: true, contains: (value: unknown) => value === target,
    matches: () => Boolean(options.disabled), closest: () => null,
    getBoundingClientRect: () => ({ ...geometry.box, x: geometry.box.x + (options.moved && reads++ > 0 ? 5 : 0) }) };
  const window = { visualViewport: geometry.visual, addEventListener: (name: string, fn: (event: unknown) => void) => listeners.set(name, fn),
    removeEventListener: (name: string) => listeners.delete(name) };
  const document = { elementFromPoint: (x: number, y: number) => !options.obstructed && x >= 16 && x < 278.875 && y >= 390.094 && y < 457.094 ? target : {} };
  const evaluate = (fn: unknown, argument?: unknown) => runInNewContext("(" + String(fn) + ")(target, argument)", { window, document, target, argument });
  const element = { waitForElementState: async (state: string) => { calls.push(state); }, evaluate,
    evaluateHandle: async (fn: unknown, argument: unknown) => {
      const value = evaluate(fn, argument);
      return { evaluate: async (fn: (value: unknown) => unknown) => fn(value), dispose: async () => {} };
    }, dispose: async () => {} };
  const control = { waitFor: async () => { calls.push("visible-locator"); }, scrollIntoViewIfNeeded: async () => { calls.push("scroll"); },
    elementHandle: async () => element };
  const page = { locator: () => control, mouse: { click: async (x: number, y: number) => {
    clicks.push([x, y]);
    for (const type of ["pointerdown", "pointerup", "click"]) listeners.get(type)?.({ type, isTrusted: options.trusted !== false,
      target, clientX: x + geometry.visual.offsetLeft + (options.displaced ? 5 : 0), clientY: y + geometry.visual.offsetTop });
  } } };
  return { page, element, calls, clicks, listeners };
}

test("scaled pointer preserves scrolling and actionability then verifies trusted event targeting", async () => {
  const harness = scaledPointerHarness();
  const result = await clickScaledPointer(harness.page, "#flavor-row-sample-4");
  assert.deepEqual(harness.calls, ["visible-locator", "scroll", "visible", "enabled", "stable"]);
  assert.equal(harness.clicks.length, 1); assert.equal(result.trustedClick, true);
  assert.equal(harness.listeners.size, 0);
});

test("scaled pointer rejects obstruction, movement and disabled targets before dispatch", async () => {
  for (const options of [{ obstructed: true }, { moved: true }, { disabled: true }]) {
    const harness = scaledPointerHarness(options);
    await assert.rejects(clickScaledPointer(harness.page, "#detail-close"), /SCALED_POINTER_(?:HIT_REQUIRED|MOVED|DISABLED)/);
    assert.equal(harness.clicks.length, 0); assert.equal(harness.listeners.size, 0);
  }
});

test("scaled pointer refuses untrusted or incorrectly mapped actual pointer events", async () => {
  for (const options of [{ trusted: false }, { displaced: true }]) {
    const harness = scaledPointerHarness(options);
    await assert.rejects(clickScaledPointer(harness.page, "#detail-close"), /SCALED_POINTER_TRUSTED_EVENTS_REQUIRED/);
    assert.equal(harness.listeners.size, 0);
  }
});

test("scaled pointer has one 15 second action deadline and cannot click after a stalled scroll completes late", async () => {
  const harness = scaledPointerHarness(); let releaseScroll = () => {};
  const control = harness.page.locator();
  control.scrollIntoViewIfNeeded = () => new Promise<void>(resolve => { releaseScroll = resolve; });
  const delays: number[] = [];
  const click = runInNewContext("(" + String(clickScaledPointer) + ")", { assert, scaledPointerPoint, Date, clearTimeout,
    setTimeout: (callback: () => void, delay: number) => { delays.push(delay); return setTimeout(callback, 10); } }) as typeof clickScaledPointer;
  await assert.rejects(click({ ...harness.page, locator: () => control }, "#detail-close"), { name: "TimeoutError" });
  assert.deepEqual(delays, [15_000]);
  releaseScroll(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.clicks.length, 0); assert.equal(harness.listeners.size, 0);
});

test("scaled pointer cleanup cannot mask an earlier obstruction failure", async () => {
  const harness = scaledPointerHarness({ obstructed: true });
  harness.element.dispose = () => new Promise<void>(() => {});
  const click = runInNewContext("(" + String(clickScaledPointer) + ")", { assert, scaledPointerPoint, Date, clearTimeout,
    setTimeout: (callback: () => void) => setTimeout(callback, 10) }) as typeof clickScaledPointer;
  await assert.rejects(click(harness.page, "#detail-close"), /SCALED_POINTER_HIT_REQUIRED/);
  assert.equal(harness.clicks.length, 0);
});

// These are viewport-relative CSS-pixel boxes, as returned by Playwright.
const mobileDensity = (firstRowY = 418) => ({
  viewport: { width: 390, height: 844 }, scale: 1, scrollY: 0,
  navigation: { x: 0, y: 779, width: 390, height: 65 },
  rows: Array.from({ length: 10 }, (_, index) => ({ x: 16, y: firstRowY + index * 68, width: 358, height: 68 })),
});

test("mobile density counts only complete rows above the fixed navigation", () => {
  assert.deepEqual(measureMobileAppDensity(mobileDensity(418)), {
    viewport: { width: 390, height: 844 }, scale: 1, scrollY: 0,
    firstRowY: 418, navigationTop: 779, visibleBottom: 779, completeVisibleRows: 5, minimumCompleteRows: 4,
  });
  assert.equal(measureMobileAppDensity(mobileDensity(507)).completeVisibleRows, 4);
  assert.throws(() => measureMobileAppDensity(mobileDensity(508)), /MOBILE_APP_DENSITY_REQUIRED: 3 complete rows/);
  // The reviewed defect: two full rows at y616, with row three under the nav.
  assert.throws(() => measureMobileAppDensity(mobileDensity(616)), /MOBILE_APP_DENSITY_REQUIRED: 2 complete rows/);
});

test("mobile density excludes viewport clipping and hidden or zero-size rows", () => {
  const evidence = mobileDensity(418);
  evidence.rows[0]!.x = -1; evidence.rows[1]!.width = 375;
  evidence.rows[2]!.y = -1; evidence.rows[3]!.height = 0;
  assert.throws(() => measureMobileAppDensity(evidence), /MOBILE_APP_DENSITY_REQUIRED: 1 complete rows/);
  const outside = mobileDensity(508); outside.navigation.y = 830; outside.navigation.height = 14;
  assert.equal(measureMobileAppDensity(outside).completeVisibleRows, 4);
});

test("mobile density rejects invalid geometry and noncanonical viewports or scroll", () => {
  for (const invalid of [NaN, Infinity, -Infinity, 1_000_001]) {
    const evidence = mobileDensity(); evidence.rows[0]!.y = invalid;
    assert.throws(() => measureMobileAppDensity(evidence), /INVALID_MOBILE_DENSITY_EVIDENCE/);
  }
  for (const changed of [
    { viewport: { width: 391, height: 844 } }, { scale: 2 }, { scrollY: 1 },
    { navigation: null }, { navigation: { x: 0, y: 779, width: 0, height: 65 } },
    { rows: [] }, { rows: Array(101).fill({ x: 0, y: 0, width: 1, height: 1 }) },
    { rows: [null] }, { rows: [{ x: 0, y: 0, width: -1, height: 1 }] },
  ]) assert.throws(() => measureMobileAppDensity({ ...mobileDensity(), ...changed }), /INVALID_MOBILE_DENSITY_EVIDENCE/);
});

test("only exact generic brand and icon assets are public", async () => {
  const { routeRequest, HttpFailure } = await import("../packages/cloudflare/dist/http.js");
  for (const path of ["/brand.png", "/icons.svg"]) {
    assert.deepEqual(routeRequest(new Request(SYNTHETIC_ORIGIN + path)), { kind: "public-asset", path, limit: 0 });
    for (const [suffix, status] of [["?v=1", 400], ["/", 404]] as const) {
      assert.throws(() => routeRequest(new Request(SYNTHETIC_ORIGIN + path + suffix)), error => error instanceof HttpFailure && error.status === status);
    }
    assert.throws(() => routeRequest(new Request(SYNTHETIC_ORIGIN + path, { method: "POST" })), error => error instanceof HttpFailure && error.status === 405);
  }
  for (const path of ["/", "/app.js", "/app.css"]) assert.equal(routeRequest(new Request(SYNTHETIC_ORIGIN + path)).kind, "private-asset");
  for (const path of ["/public/brand.png", "/%62rand.png", "/icons.svg.json"]) assert.throws(() => routeRequest(new Request(SYNTHETIC_ORIGIN + path)), error => error instanceof HttpFailure && error.status === 404);
});

test("hosted response gate proves arrival, blocks delivery until release and has a deadline", async () => {
  const gate = createResponseGate(1000); let delivered = false;
  const work = (async () => { await gate.hold(); delivered = true; gate.finish(); })();
  await gate.entered; assert.equal(delivered, false);
  gate.release(); await gate.finished; await work; assert.equal(delivered, true);
  const expired = createResponseGate(10); const blocked = expired.hold(); await expired.entered;
  await assert.rejects(blocked, /RESPONSE_GATE_TIMEOUT/);
  await assert.rejects(expired.finished, /RESPONSE_GATE_TIMEOUT/);
});

// A bridge that rewrites request bytes or combines cookies with commas fails
// these tests; authentication and persistence are exercised in workerd below.
test("hosted bridge preserves request bytes, security headers, status and distinct cookies", async () => {
  const body = Buffer.from(' { "original" : "bytes" }\n');
  const cookies = [
    "__Host-flora_session=synthetic; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600",
    "__Host-flora_csrf=synthetic-csrf; Secure; HttpOnly; SameSite=Strict; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  const requestHeaders = { origin: SYNTHETIC_ORIGIN, cookie: "synthetic-cookies", "x-flora-csrf": "synthetic-header", "content-type": "application/json" };
  const responseHeaders = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'" });
  for (const cookie of cookies) responseHeaders.append("Set-Cookie", cookie);
  const result = await bridgeRequest({
    url: () => SYNTHETIC_ORIGIN + "/api/sources", method: () => "POST",
    allHeaders: async () => requestHeaders, postDataBuffer: () => body,
  }, async (url, init) => {
    assert.equal(url, SYNTHETIC_ORIGIN + "/api/sources");
    assert.equal(init.method, "POST"); assert.deepEqual(init.headers, requestHeaders);
    assert.strictEqual(init.body, body); assert.equal(init.redirect, "manual");
    return new Response('{"error":"FORBIDDEN"}', { status: 403, headers: responseHeaders });
  });
  assert.equal(result.status, 403); assert.equal(result.body.toString(), '{"error":"FORBIDDEN"}');
  assert.equal(result.headers["set-cookie"], cookies.join("\n"));
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.headers["content-security-policy"], "default-src 'none'");
});

test("hosted bridge blocks every non-synthetic HTTPS origin before dispatch", async () => {
  let calls = 0;
  for (const url of ["http://flora.example.test/", "https://other.example.test/", "https://flora.example.test.evil.test/", "https://user@flora.example.test/", "https://flora.example.test:444/", "file:///tmp/fixture", SYNTHETIC_ORIGIN + "/#fragment"]) {
    await assert.rejects(bridgeRequest({ url: () => url, method: () => "GET", allHeaders: async () => ({}), postDataBuffer: () => null }, async () => { calls++; return new Response(); }), /SYNTHETIC_ORIGIN_REQUIRED/);
  }
  assert.equal(calls, 0);
});

test("hosted bridge preserves a redirect and never follows it outside the router", async () => {
  let calls = 0;
  const result = await bridgeRequest({ url: () => SYNTHETIC_ORIGIN + "/", method: () => "GET", allHeaders: async () => ({}), postDataBuffer: () => null }, async (_url, init) => {
    calls++; assert.equal(init.body, undefined); assert.equal(init.redirect, "manual");
    return new Response(null, { status: 303, headers: { Location: "/login", "Cache-Control": "no-store" } });
  });
  assert.equal(calls, 1); assert.equal(result.status, 303); assert.equal(result.headers.location, "/login"); assert.equal(result.body.length, 0);
});

test("hosted render workflow stays public standard Linux, read-only, pinned and bounded", async () => {
  const workflow = await readFile(new URL("../.github/workflows/hosted-rendered.yml", import.meta.url), "utf8");
  assert.match(workflow, /runs-on: ubuntu-22\.04/); assert.match(workflow, /timeout-minutes: 10/);
  assert.match(workflow, /github.event.repository.private == false/); assert.match(workflow, /github.event.repository.visibility == 'public'/);
  assert.match(workflow, /verify\/flora-hosted-\*/); assert.match(workflow, /contents: read/); assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/);
  assert.match(workflow, /actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38/);
  assert.match(workflow, /playwright@1\.58\.2/); assert.match(workflow, /--frozen-lockfile --ignore-scripts/);
  const pushPaths = workflow.split("  workflow_dispatch:")[0]!;
  for (const path of ["docs/development/password-hosting.ko.md", "docs/release/password-hosting-evidence.md", "README.md", "README.en.md"]) {
    assert.ok(pushPaths.includes("      - '" + path + "'"), "Hosted release guidance must trigger exact-commit render evidence: " + path);
  }
  assert.ok(!/upload-artifact|runs-on:.*self-hosted|secrets\.|sudo|sysctl|apparmor|pull_request_target|wrangler deploy/.test(workflow));
});

test("hosted capture requires sandbox and actual cookie/font proof without security bypasses", async () => {
  const capture = await readFile(new URL("../scripts/hosted-qa/capture.mjs", import.meta.url), "utf8");
  assert.match(capture, /chromiumSandbox: true/); assert.match(capture, /channel: "chrome"/);
  assert.match(capture, /Browser\.getBrowserCommandLine/); assert.match(capture, /CSS\.getPlatformFontsForNode/);
  assert.match(capture, /cookie\.secure/); assert.match(capture, /cookie\.httpOnly/); assert.match(capture, /cookie\.sameSite, "Strict"/);
  assert.match(capture, /bridgeRequest\(request, harness\.httpFetch\)/);
  assert.ok(!/harness\.(?:fetch|dispatchFetch)\(/.test(capture));
  assert.match(capture, /encodeEvidence\(files, process\.env\.GITHUB_SHA\)/);
  assert.ok(!/ignoreHTTPSErrors|bypassCSP|addCookies\(|console\.(?:log|error)\(error\)|args:\s*\[/.test(capture));
});

test("hosted mobile QA requires measured disclosures, pagination and observed page scale", async () => {
  const capture = await readFile(new URL("../scripts/hosted-qa/capture.mjs", import.meta.url), "utf8");
  for (const selector of ["#view-sources summary", "#view-history summary", "#snapshot-next", "#snapshot-previous", "#history-next", "#history-previous"]) {
    assert.ok(capture.includes('"' + selector + '"'), "Measured mobile coverage must include " + selector);
  }
  assert.match(capture, /async function mobileTargets/);
  assert.match(capture, /boundingBox\(\)/); assert.match(capture, /click\(\{ trial: true \}\)/);
  assert.match(capture, /Emulation\.setPageScaleFactor/); assert.match(capture, /pageScaleFactor: 2/);
  assert.match(capture, /Page\.getLayoutMetrics/); assert.match(capture, /cssVisualViewport\.scale/);
  assert.match(capture, /visualViewport\?\.scale/); assert.match(capture, /pageScaleFactor: 1/);
  assert.ok(!/\.style\.(?:zoom|transform)|setAttribute\(["']style["']|mobile-touch-targets-and-system-zoom/.test(capture));
});

// Run only the real scale helper, without importing the CI-only browser runner.
// Browser calls are replaced here to inject failures; these tests prove safe
// diagnostics and cleanup, not Chromium scaling or pointer actionability.
async function scaleDiagnosticHarness(failAt?: string, failCleanup = false, stallSample?: "cdp" | "dom" | "pointer-cdp" | "pointer-dom") {
  const capture = await readFile(new URL("../scripts/hosted-qa/capture.mjs", import.meta.url), "utf8");
  const start = capture.indexOf("  async function twofoldPageScale(");
  const end = capture.indexOf("  async function authenticate(", start);
  assert.ok(start >= 0 && end > start);
  const lines: string[] = [], calls: string[] = [];
  const failure = Object.assign(new Error("synthetic-private-error-must-not-appear"), { name: "TimeoutError" });
  const cleanupFailure = new Error("synthetic-private-cleanup-must-not-appear");
  const scope = { assert, setTimeout, clearTimeout, clickScaledPointer: async () => operation(),
    phase: "mobile-twofold-page-scale", pageScaleEvidence: undefined,
    checks: [] as string[], console: { log: (line: string) => lines.push(line) } };
  let scale = 1, filtered = false, failed = false, releaseSample = () => {};
  const stalled = () => new Promise<void>(resolve => { releaseSample = resolve; });
  const operation = () => {
    calls.push(scope.phase);
    if (!failed && scope.phase === "mobile-twofold-page-scale-" + failAt) { failed = true; throw failure; }
    if (failCleanup && scope.phase === "mobile-twofold-page-scale-restore-request") throw cleanupFailure;
  };
  const session = {
    send: async (method: string, args?: { pageScaleFactor: number }) => {
      operation();
      if (failed && stallSample === "cdp" && method === "Page.getLayoutMetrics") await stalled();
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 2 };
      if (method === "DOM.getContentQuads") {
        if (failed && stallSample === "pointer-cdp") await stalled();
        return { quads: [[0, 20, 500, 20, 500, 154, 0, 154]], private: "private-quad" };
      }
      if (method === "Emulation.setPageScaleFactor") scale = args!.pageScaleFactor;
      return { cssLayoutViewport: { clientWidth: 390, clientHeight: 844, secret: "private-layout" },
        cssVisualViewport: { scale, clientWidth: 390 / scale, clientHeight: 844 / scale,
          offsetX: NaN, offsetY: Infinity, pageX: "private-page", pageY: 1_000_001, secret: "private-visual" },
        secret: "private-root" };
    },
    detach: async () => { calls.push("detach-called"); operation(); },
  };
  const control = {
    scrollIntoViewIfNeeded: async () => operation(), click: async () => operation(),
    fill: async (value: string) => { operation(); filtered = Boolean(value); },
    waitFor: async () => operation(), isHidden: async () => { operation(); return true; },
  };
  const page = { context: () => ({ newCDPSession: async () => { operation(); return session; } }),
    waitForFunction: async () => operation(), evaluate: async (fn: unknown, argument?: unknown) => {
      operation(); if (failed && stallSample === "dom") await stalled();
      if (Array.isArray(argument)) {
        if (failed && stallSample === "pointer-dom") await stalled();
        const target = { getBoundingClientRect: () => ({ x: 16, y: 400, left: 16, top: 400, right: 266, bottom: 467, width: 250, height: 67 }),
          contains: (hit: unknown) => hit === target };
        const nav = { getBoundingClientRect: () => ({ x: 0, y: 779, width: 390, height: 65 }), contains: () => false };
        const document = { getElementById: () => target, querySelector: () => nav,
          elementFromPoint: (x: number, y: number) => x >= 16 && x <= 266 && y >= 400 && y <= 467 ? target : {} };
        return runInNewContext("(" + String(fn) + ")(quad)", { document, quad: argument,
          window: { innerWidth: 390, innerHeight: 844, visualViewport: { scale: 2, offsetLeft: 16, offsetTop: 390, width: 195, height: 422 } } });
      }
      return scale;
    },
    locator: () => control };
  const appButtons = { count: async () => { operation(); return filtered ? 1 : 10; } };
  const run = runInNewContext(capture.slice(start, end) + "\ntwofoldPageScale", scope) as
    (page: unknown, buttons: unknown) => Promise<void>;
  return { run: () => run(page, appButtons), lines, calls, scope, failure, releaseSample: () => releaseSample() };
}

test("page-scale diagnostics emit static subphases and only bounded numeric viewport fields", async () => {
  const harness = await scaleDiagnosticHarness(); await harness.run();
  for (const step of ["attach", "request-twofold", "observe-twofold", "read-layout", "validate-layout", "scroll-search",
    "trial-search", "fill-search", "count-filtered", "probe-open-detail", "open-detail", "wait-detail", "close-detail", "check-detail-hidden",
    "clear-search", "count-restored", "observe-retained", "restore-request", "restore-observe", "detach", "read-restored"]) {
    assert.ok(harness.lines.includes("FLORA_HOSTED_QA_SCALE_STEP mobile-twofold-page-scale-" + step), step);
  }
  const records = harness.lines.filter(line => line.startsWith("FLORA_HOSTED_QA_SCALE_METRICS "));
  assert.ok(records.length >= 2 && records.length <= 4);
  for (const line of records) {
    const record = JSON.parse(line.slice("FLORA_HOSTED_QA_SCALE_METRICS ".length));
    assert.deepEqual(Object.keys(record).sort(), ["phase", "requestedScale", "domScale", "observedScale", "layoutWidth", "layoutHeight",
      "visualWidth", "visualHeight", "visualOffsetX", "visualOffsetY", "visualPageX", "visualPageY"].sort());
    assert.match(record.phase, /^mobile-twofold-page-scale-[a-z-]+$/);
    for (const [key, value] of Object.entries(record)) if (key !== "phase") {
      assert.ok(value === null || (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000));
    }
    for (const key of ["visualOffsetX", "visualOffsetY", "visualPageX", "visualPageY"]) assert.equal(record[key], null);
  }
  assert.ok(!harness.lines.join("\n").includes("private"));
  assert.deepEqual(harness.scope.checks, ["observed-cdp-twofold-page-scale-with-usable-controls"]);
});

test("page-scale diagnostics retain the failed interaction phase through reset and detach", async () => {
  for (const step of ["observe-twofold", "trial-search", "open-detail", "close-detail", "restore-observe", "detach", "read-restored"]) {
    const harness = await scaleDiagnosticHarness(step);
    await assert.rejects(harness.run(), error => error === harness.failure);
    assert.equal(harness.scope.phase, "mobile-twofold-page-scale-" + step);
    assert.ok(harness.calls.includes("mobile-twofold-page-scale-restore-request"));
    assert.ok(harness.calls.includes("detach-called"));
    assert.equal(harness.scope.checks.length, 0);
    assert.ok(!harness.lines.join("\n").includes("private"));
  }
  const doubleFailure = await scaleDiagnosticHarness("trial-search", true);
  await assert.rejects(doubleFailure.run(), error => error === doubleFailure.failure);
  assert.equal(doubleFailure.scope.phase, "mobile-twofold-page-scale-trial-search");
  assert.ok(doubleFailure.calls.includes("detach-called"));
});

test("pointer diagnostics compare protocol and DOM coordinates using only numeric geometry and hit categories", async () => {
  const harness = await scaleDiagnosticHarness("open-detail");
  await assert.rejects(harness.run(), error => error === harness.failure);
  const records = harness.lines.filter(line => line.startsWith("FLORA_HOSTED_QA_SCALE_POINTER "));
  assert.equal(records.length, 2, "Sample before the pointer action and after its failure");
  for (const line of records) {
    const record = JSON.parse(line.slice("FLORA_HOSTED_QA_SCALE_POINTER ".length));
    assert.deepEqual(Object.keys(record).sort(), ["phase", "domX", "domY", "domWidth", "domHeight", "quadLeft", "quadTop", "quadWidth", "quadHeight",
      "quadX", "quadY", "quadHit", "offsetQuadHit", "scaledQuadHit", "domHit", "visibleWidth", "visibleHeight", "visibleHit",
      "navX", "navY", "navWidth", "navHeight"].sort());
    assert.ok(["mobile-twofold-page-scale-probe-open-detail", "mobile-twofold-page-scale-open-detail"].includes(record.phase));
    assert.equal(record.domX, 16); assert.equal(record.domY, 400);
    assert.equal(record.quadX, 195); assert.equal(record.quadY, 87);
    assert.equal(record.quadHit, 3); assert.equal(record.scaledQuadHit, 1);
    assert.equal(record.domHit, 1); assert.equal(record.visibleHit, 1);
    assert.equal(record.visibleWidth, 195); assert.equal(record.visibleHeight, 67);
    for (const [key, value] of Object.entries(record)) if (key !== "phase") {
      assert.ok(value === null || (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000));
    }
  }
  assert.ok(!harness.lines.join("\n").includes("private"));
});

for (const source of ["cdp", "dom", "pointer-cdp", "pointer-dom"] as const) test("stalled " + source + " diagnostic sampling cannot block scale cleanup", async () => {
  const failedStep = source.startsWith("pointer-") ? "open-detail" : "trial-search";
  const harness = await scaleDiagnosticHarness(failedStep, false, source);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const bounded = Promise.race([harness.run(), new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error("DIAGNOSTIC_BLOCKED_CLEANUP")), 1500);
    })]);
    await assert.rejects(bounded, error => error === harness.failure);
    assert.equal(harness.scope.phase, "mobile-twofold-page-scale-" + failedStep);
    assert.ok(harness.calls.includes("mobile-twofold-page-scale-restore-request"));
    assert.ok(harness.calls.includes("detach-called"));
    assert.ok(harness.lines.includes("FLORA_HOSTED_QA_SCALE_METRICS_UNAVAILABLE mobile-twofold-page-scale-" + failedStep));
    assert.equal(harness.scope.checks.length, 0);
    const lines = [...harness.lines], calls = [...harness.calls];
    harness.releaseSample();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(harness.lines, lines, "Expired sampling must not emit late measurements");
    assert.deepEqual(harness.calls, calls, "Expired CDP sampling must not start a late DOM read");
  } finally { clearTimeout(deadline); harness.releaseSample(); }
});

const compositionTransport = process.env.FLORA_HOSTED_QA_TRANSPORT ?? "http";
test("hosted " + compositionTransport + " composition requires real enrollment, preserves original import receipts and revokes sessions", async t => {
  const { createHostedQaHarness } = await import("../scripts/hosted-qa/runtime.mjs");
  const harness = await createHostedQaHarness();
  try {
    assert.equal(typeof harness.httpFetch, "function", "Ordinary local HTTP must be separate from dispatchFetch characterization");
    assert.ok(["http", "dispatch"].includes(compositionTransport), "Choose http acceptance or dispatch characterization explicitly");
    const send = compositionTransport === "dispatch" ? harness.dispatchFetch : harness.httpFetch;
    const { createHash } = await import("node:crypto");
    const { uploadResetEvidence } = await import("../scripts/hosted-qa/upload-outcome.mjs");
    assert.ok(harness.sourceEvidence, "The runtime must identify the exact rendered Worker and asset bytes");
    assert.match(harness.sourceEvidence.workerSha256, /^[a-f0-9]{64}$/);
    for (const [name, digest] of Object.entries(harness.sourceEvidence.assetSha256)) assert.equal(digest, createHash("sha256").update(await readFile(new URL("../packages/cloudflare/public/" + name, import.meta.url))).digest("hex"));
    // A status-only assertion leaves the emulator response stream unread. Keep
    // this lifecycle gate local, and consume every body before the next request.
    let previous: { label: string; response: Awaited<ReturnType<typeof harness.dispatchFetch>> } | undefined;
    const assertConsumed = () => {
      if (previous) assert.ok(previous.response.body === null || previous.response.bodyUsed,
        "Consume the previous Miniflare response before dispatch: " + previous.label);
    };
    const call = async (path: string, body?: Uint8Array | string, headers: Record<string, string> = {}) => {
      assertConsumed();
      const method = body === undefined ? "GET" : "POST";
      const label = method + " " + path.split("?", 1)[0];
      try {
        const response = await send(SYNTHETIC_ORIGIN + path, {
          method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: SYNTHETIC_ORIGIN }), ...headers },
          ...(body === undefined ? {} : { body }),
        });
        previous = { label: label + " -> " + response.status, response };
        return response;
      } catch (cause) {
        throw new Error("Hosted composition transport failed (" + compositionTransport + "): " + label + "; request bytes="
          + (body === undefined ? 0 : typeof body === "string" ? Buffer.byteLength(body) : body.byteLength)
          + "; previous=" + (previous?.label ?? "none"), { cause });
      }
    };
    const expectJson = async (response: Awaited<ReturnType<typeof call>>, status: number, body: unknown) => {
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), body);
    };
    for (const url of ["http://flora.example.test/", "https://other.example.test/", "https://flora.example.test.evil.test/", "https://user@flora.example.test/", "https://flora.example.test:444/", "file:///tmp/fixture", SYNTHETIC_ORIGIN + "/#fragment"]) {
      await assert.rejects(harness.httpFetch(url), /SYNTHETIC_ORIGIN_REQUIRED/);
    }
    await expectJson(await call("//other.example.test/"), 404, { error: "NOT_FOUND" });
    await expectJson(await call("/api/state", undefined, { "MF-Original-URL": "https://other.example.test/" }), 401, { error: "UNAUTHENTICATED" });
    await expectJson(await call("/api/state"), 401, { error: "UNAUTHENTICATED" });
    for (const path of ["/app.js", "/app.css"]) await expectJson(await call(path), 401, { error: "UNAUTHENTICATED" });
    for (const [path, mime] of [["/brand.png", "image/png"], ["/icons.svg", "image/svg+xml; charset=utf-8"]]) {
      const asset = await call(path!); assert.equal(asset.status, 200);
      const headers = new Headers([...asset.headers]);
      assert.equal(headers.get("Content-Type"), mime);
      assert.equal(headers.get("Cache-Control"), "no-store");
      assert.equal(headers.get("Content-Security-Policy"), "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
      assert.deepEqual(Buffer.from(await asset.arrayBuffer()), await readFile(new URL("../packages/cloudflare/public" + path, import.meta.url)));
      await expectJson(await call(path + "?cache=1"), 400, { error: "INVALID_INPUT" });
      await expectJson(await call(path + "/"), 404, { error: "NOT_FOUND" });
    }
    const setup = JSON.stringify({ email: harness.email, password: harness.password, confirmation: harness.password, token: harness.token });
    const first = await call("/api/auth/enroll", setup); assert.equal(first.status, 200);
    const cookies = first.headers.getSetCookie(); assert.equal(cookies.length, 2);
    for (const value of cookies) {
      assert.match(value, /^__Host-flora_(?:session|csrf)=/);
      for (const attribute of ["Secure", "HttpOnly", "SameSite=Strict", "Path=/"]) assert.ok(value.includes(attribute));
      assert.ok(!/Domain=/i.test(value));
    }
    const session = await first.json() as { csrfToken: string; expiresAt: number };
    const auth = { Cookie: cookies.map(value => value.split(";", 1)[0]).join("; "), "X-Flora-CSRF": session.csrfToken };
    assert.equal(await (await call("/app.css", undefined, auth)).text(), await readFile(new URL("../packages/cloudflare/public/app.css", import.meta.url), "utf8"));
    await expectJson(await call("/api/auth/enroll", setup), 403, { error: "SETUP_UNAVAILABLE" });
    const empty = await (await call("/api/state", undefined, auth)).json() as { selected: unknown; snapshots: { items: unknown[] } };
    assert.equal(empty.selected, null); assert.equal(empty.snapshots.items.length, 0);
    const sourceBytes = harness.source();
    await expectJson(await call("/api/sources", sourceBytes, { Cookie: auth.Cookie }), 403, { error: "FORBIDDEN" });
    // Keep this immediate full-byte POST boundary intact. Only normal HTTP
    // acceptance may evaluate one explicit user recovery after its known reset;
    // dispatch characterization must still fail on the original transport error.
    let source: Awaited<ReturnType<typeof call>>;
    let afterUnknownSource: import("../packages/cloudflare/src/contracts.ts").HostedState | undefined;
    let initialReset: ReturnType<typeof uploadResetEvidence> = null;
    try { source = await call("/api/sources", sourceBytes, auth); }
    catch (error) {
      initialReset = uploadResetEvidence(error);
      if (compositionTransport !== "http" || !initialReset) throw error;
      t.diagnostic(JSON.stringify({ boundary: "full-source-after-consumed-missing-CSRF-403", transport: compositionTransport,
        requestBytes: sourceBytes.length, initialOutcome: "requestfailed", commitStatus: "unknown", reset: initialReset }));
      // This is the user's prescribed history reload, never a hidden POST retry.
      const reloaded = await call("/api/state", undefined, auth); assert.equal(reloaded.status, 200);
      afterUnknownSource = await reloaded.json() as typeof afterUnknownSource;
      assert.ok(afterUnknownSource); assert.ok(afterUnknownSource.snapshots.items.length <= 1);
      assert.equal(Boolean(afterUnknownSource.selected), afterUnknownSource.snapshots.items.length === 1);
      assert.equal(afterUnknownSource.history.items.length, 0);
      source = await call("/api/sources", sourceBytes, auth); // one identical-file resubmission; any failure fails the gate
    }
    assert.equal(source.status, 201);
    const selected = await source.json() as import("@app-ops/dogfood").InventorySnapshot;
    const sourceState = await (await call("/api/state", undefined, auth)).json() as import("../packages/cloudflare/src/contracts.ts").HostedState;
    assert.equal(sourceState.snapshots.items.length, 1); assert.deepEqual(sourceState.selected, selected);
    if (afterUnknownSource?.selected) assert.deepEqual(sourceState, afterUnknownSource, "A reset after commit must retain the first receipt, timestamps and provenance");
    t.diagnostic(JSON.stringify({ boundary: "full-source-after-consumed-missing-CSRF-403", transport: compositionTransport,
      requestBytes: sourceBytes.length, initialOutcome: initialReset ? "requestfailed" : "201",
      naturalResetObserved: Boolean(initialReset), explicitRecovery: initialReset ? "one-reload-one-identical-resubmit-passed" : "not-exercised", runtimeFixClaimed: false }));
    const sourceDuplicate = await call("/api/sources", sourceBytes, auth); assert.equal(sourceDuplicate.status, 201);
    assert.deepEqual(await sourceDuplicate.json(), selected);
    assert.deepEqual(await (await call("/api/state", undefined, auth)).json(), sourceState);
    const baselineBytes = await harness.baseline();
    const baseline = await call("/api/baselines?snapshotId=" + selected.id, baselineBytes, auth); assert.equal(baseline.status, 201);
    const receipt = await baseline.json() as { id: string; evidence: { evidenceDigest: string } };
    const duplicate = await call("/api/baselines?snapshotId=" + selected.id, baselineBytes, auth);
    assert.equal(duplicate.status, 201); assert.deepEqual(await duplicate.json(), receipt);
    let state = await (await call("/api/state", undefined, auth)).json() as { selected: { id: string }; history: { items: { id: string; evidenceDigest: string }[] } };
    assert.equal(state.selected.id, selected.id); assert.equal(state.history.items.length, 1);
    assert.equal(state.history.items[0]!.evidenceDigest, createHash("sha256").update(baselineBytes).digest("hex"));
    // Lose only delivery after a real HTTP write and response. This is a
    // controlled transport failure, not a claim that workerd's reset is fixed.
    const lostBytes = await harness.baseline(0, 2); let lostReceipt: typeof receipt | undefined;
    await assert.rejects(async () => {
      const committed = await call("/api/baselines?snapshotId=" + selected.id, lostBytes, auth);
      assert.equal(committed.status, 201);
      lostReceipt = await committed.json() as typeof receipt;
      throw new Error("SYNTHETIC_RESPONSE_LOST_AFTER_COMMIT");
    }, /SYNTHETIC_RESPONSE_LOST_AFTER_COMMIT/);
    const afterLoss = await (await call("/api/state", undefined, auth)).json() as typeof state;
    assert.equal(afterLoss.selected.id, selected.id); assert.equal(afterLoss.history.items.length, 2);
    assert.deepEqual(afterLoss.history.items.find(item => item.id === receipt.id), state.history.items[0]);
    assert.equal(afterLoss.history.items.find(item => item.id === lostReceipt?.id)?.evidenceDigest, createHash("sha256").update(lostBytes).digest("hex"));
    // An explicit same-envelope user retry must return the committed receipt.
    const retried = await call("/api/baselines?snapshotId=" + selected.id, lostBytes, auth);
    assert.equal(retried.status, 201); assert.deepEqual(await retried.json(), lostReceipt);
    state = await (await call("/api/state", undefined, auth)).json() as typeof state;
    assert.deepEqual(state, afterLoss);
    // A real new source commit also survives lost delivery. The original source
    // and its baseline history remain unchanged, including all first provenance.
    const nextSourceBytes = harness.source(1); let lostSource: typeof selected | undefined;
    await assert.rejects(async () => {
      const committed = await call("/api/sources", nextSourceBytes, auth); assert.equal(committed.status, 201);
      lostSource = await committed.json() as typeof selected;
      throw new Error("SYNTHETIC_SOURCE_RESPONSE_LOST_AFTER_COMMIT");
    }, /SYNTHETIC_SOURCE_RESPONSE_LOST_AFTER_COMMIT/);
    const sourceAfterLoss = await (await call("/api/state", undefined, auth)).json() as typeof sourceState;
    assert.equal(sourceAfterLoss.snapshots.items.length, 2); assert.deepEqual(sourceAfterLoss.selected, lostSource);
    const oldSource = await (await call("/api/state?snapshotId=" + selected.id, undefined, auth)).json() as typeof sourceState;
    assert.deepEqual(oldSource.selected, selected); assert.deepEqual(oldSource.history, afterLoss.history);
    const recoveredSource = await call("/api/sources", nextSourceBytes, auth); assert.equal(recoveredSource.status, 201);
    assert.deepEqual(await recoveredSource.json(), lostSource);
    assert.deepEqual(await (await call("/api/state", undefined, auth)).json(), sourceAfterLoss);
    state = sourceAfterLoss as typeof state;
    const second = await call("/api/auth/login", JSON.stringify({ email: harness.email, password: harness.password })); assert.equal(second.status, 200);
    const secondCookie = second.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
    assert.notEqual(secondCookie, auth.Cookie);
    const secondSession = await second.json() as { csrfToken: string; expiresAt: number };
    assert.notEqual(secondSession.csrfToken, session.csrfToken);
    assert.ok(secondSession.expiresAt > Date.now());
    assert.equal((await (await call("/api/state", undefined, { Cookie: secondCookie })).json() as { selected: { id: string } }).selected.id, state.selected.id);
    await expectJson(await call("/api/auth/logout", "{}", auth), 200, { ok: true });
    await expectJson(await call("/api/state", undefined, auth), 401, { error: "UNAUTHENTICATED" });
    for (const path of ["/", "/app.js", "/app.css"]) await expectJson(await call(path, undefined, auth), 401, { error: "UNAUTHENTICATED" });
    for (const path of ["/brand.png", "/icons.svg"]) {
      const asset = await call(path); assert.equal(asset.status, 200);
      assert.deepEqual(Buffer.from(await asset.arrayBuffer()), await readFile(new URL("../packages/cloudflare/public" + path, import.meta.url)));
    }
    const retained = await call("/api/state", undefined, { Cookie: secondCookie }); assert.equal(retained.status, 200);
    assert.deepEqual(await retained.json(), state);
    assertConsumed();
    assert.equal(harness.outboundRequests(), 0);
  } finally { await harness.close(); }
});
