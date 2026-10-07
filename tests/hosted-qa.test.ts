import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { bridgeRequest, SYNTHETIC_ORIGIN } from "../scripts/hosted-qa/transport.mjs";
import { createResponseGate } from "../scripts/hosted-qa/response-gate.mjs";
import { measureMobileAppDensity } from "../scripts/hosted-qa/mobile-density.mjs";

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
async function scaleDiagnosticHarness(failAt?: string, failCleanup = false, stallSample?: "cdp" | "dom") {
  const capture = await readFile(new URL("../scripts/hosted-qa/capture.mjs", import.meta.url), "utf8");
  const start = capture.indexOf("  async function twofoldPageScale(");
  const end = capture.indexOf("  async function authenticate(", start);
  assert.ok(start >= 0 && end > start);
  const lines: string[] = [], calls: string[] = [];
  const failure = Object.assign(new Error("synthetic-private-error-must-not-appear"), { name: "TimeoutError" });
  const cleanupFailure = new Error("synthetic-private-cleanup-must-not-appear");
  const scope = { assert, setTimeout, clearTimeout, phase: "mobile-twofold-page-scale", pageScaleEvidence: undefined,
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
    waitForFunction: async () => operation(), evaluate: async () => {
      operation(); if (failed && stallSample === "dom") await stalled(); return scale;
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
    "trial-search", "fill-search", "count-filtered", "open-detail", "wait-detail", "close-detail", "check-detail-hidden",
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

for (const source of ["cdp", "dom"] as const) test("stalled " + source + " diagnostic sampling cannot block scale cleanup", async () => {
  const harness = await scaleDiagnosticHarness("trial-search", false, source);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const bounded = Promise.race([harness.run(), new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error("DIAGNOSTIC_BLOCKED_CLEANUP")), 1500);
    })]);
    await assert.rejects(bounded, error => error === harness.failure);
    assert.equal(harness.scope.phase, "mobile-twofold-page-scale-trial-search");
    assert.ok(harness.calls.includes("mobile-twofold-page-scale-restore-request"));
    assert.ok(harness.calls.includes("detach-called"));
    assert.ok(harness.lines.includes("FLORA_HOSTED_QA_SCALE_METRICS_UNAVAILABLE mobile-twofold-page-scale-trial-search"));
    assert.equal(harness.scope.checks.length, 0);
    const lines = [...harness.lines], calls = [...harness.calls];
    harness.releaseSample();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(harness.lines, lines, "Expired sampling must not emit late measurements");
    assert.deepEqual(harness.calls, calls, "Expired CDP sampling must not start a late DOM read");
  } finally { clearTimeout(deadline); harness.releaseSample(); }
});

const compositionTransport = process.env.FLORA_HOSTED_QA_TRANSPORT ?? "http";
test("hosted " + compositionTransport + " composition requires real enrollment, preserves original import receipts and revokes sessions", async () => {
  const { createHostedQaHarness } = await import("../scripts/hosted-qa/runtime.mjs");
  const harness = await createHostedQaHarness();
  try {
    assert.equal(typeof harness.httpFetch, "function", "Ordinary local HTTP must be separate from dispatchFetch characterization");
    assert.ok(["http", "dispatch"].includes(compositionTransport), "Choose http acceptance or dispatch characterization explicitly");
    const send = compositionTransport === "dispatch" ? harness.dispatchFetch : harness.httpFetch;
    const { createHash } = await import("node:crypto");
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
    await expectJson(await call("/api/sources", harness.source(), { Cookie: auth.Cookie }), 403, { error: "FORBIDDEN" });
    const source = await call("/api/sources", harness.source(), auth); assert.equal(source.status, 201);
    const selected = await source.json() as import("@app-ops/dogfood").InventorySnapshot;
    const baselineBytes = await harness.baseline();
    const baseline = await call("/api/baselines?snapshotId=" + selected.id, baselineBytes, auth); assert.equal(baseline.status, 201);
    const receipt = await baseline.json() as { id: string; evidence: { evidenceDigest: string } };
    const duplicate = await call("/api/baselines?snapshotId=" + selected.id, baselineBytes, auth);
    assert.equal(duplicate.status, 201); assert.equal((await duplicate.json() as { id: string }).id, receipt.id);
    let state = await (await call("/api/state", undefined, auth)).json() as { selected: { id: string }; history: { items: { id: string; evidenceDigest: string }[] } };
    assert.equal(state.selected.id, selected.id); assert.equal(state.history.items.length, 1);
    assert.equal(state.history.items[0]!.evidenceDigest, createHash("sha256").update(baselineBytes).digest("hex"));
    // Lose only delivery after a real HTTP write and response. This is a
    // controlled transport failure, not a claim that workerd's reset is fixed.
    const lostBytes = await harness.baseline(0, 2); let lostReceipt: string | undefined;
    await assert.rejects(async () => {
      const committed = await call("/api/baselines?snapshotId=" + selected.id, lostBytes, auth);
      assert.equal(committed.status, 201);
      lostReceipt = (await committed.json() as { id: string }).id;
      throw new Error("SYNTHETIC_RESPONSE_LOST_AFTER_COMMIT");
    }, /SYNTHETIC_RESPONSE_LOST_AFTER_COMMIT/);
    const afterLoss = await (await call("/api/state", undefined, auth)).json() as typeof state;
    assert.equal(afterLoss.selected.id, selected.id); assert.equal(afterLoss.history.items.length, 2);
    assert.deepEqual(afterLoss.history.items.find(item => item.id === receipt.id), state.history.items[0]);
    assert.equal(afterLoss.history.items.find(item => item.id === lostReceipt)?.evidenceDigest, createHash("sha256").update(lostBytes).digest("hex"));
    // An explicit same-envelope user retry must return the committed receipt.
    const retried = await call("/api/baselines?snapshotId=" + selected.id, lostBytes, auth);
    assert.equal(retried.status, 201); assert.equal((await retried.json() as { id: string }).id, lostReceipt);
    state = await (await call("/api/state", undefined, auth)).json() as typeof state;
    assert.deepEqual(state, afterLoss);
    const second = await call("/api/auth/login", JSON.stringify({ email: harness.email, password: harness.password })); assert.equal(second.status, 200);
    const secondCookie = second.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
    assert.notEqual(secondCookie, auth.Cookie);
    const secondSession = await second.json() as { csrfToken: string; expiresAt: number };
    assert.notEqual(secondSession.csrfToken, session.csrfToken);
    assert.ok(secondSession.expiresAt > Date.now());
    assert.equal((await (await call("/api/state", undefined, { Cookie: secondCookie })).json() as { selected: { id: string } }).selected.id, selected.id);
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
