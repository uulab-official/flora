import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHostedQaHarness } from "./runtime.mjs";
import { bridgeRequest, SYNTHETIC_ORIGIN } from "./transport.mjs";
import { createResponseGate } from "./response-gate.mjs";
import { encodeEvidence, LIMITS } from "../dashboard-qa/evidence.mjs";
import { verifyKoreanFontUsage } from "../dashboard-qa/fonts.mjs";

// CI-only browser verification. Route fulfillment transports real workerd
// responses at a reserved synthetic HTTPS origin; this does not test DNS/TLS.
let phase = "preflight", harness, browser, temporary;
const timeout = setTimeout(() => { console.error("FLORA_HOSTED_QA_FAILURE deadline"); process.exit(1); }, 360_000);
try {
  assert.equal(process.env.GITHUB_ACTIONS, "true"); assert.equal(process.platform, "linux"); assert.notEqual(process.getuid(), 0);
  assert.ok(process.env.GITHUB_REF === "refs/heads/main" || process.env.GITHUB_REF?.startsWith("refs/heads/verify/flora-hosted-"));
  assert.match(process.env.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/);
  assert.ok(process.env.FLORA_QA_PLAYWRIGHT_MODULE); assert.ok(process.env.FLORA_QA_FONTCONFIG);
  const fontConfig = resolve(process.env.FLORA_QA_FONTCONFIG); await access(fontConfig);
  const { chromium } = await import(pathToFileURL(resolve(process.env.FLORA_QA_PLAYWRIGHT_MODULE)).href);
  temporary = await mkdtemp(join(tmpdir(), "flora-hosted-render-"));
  const config = join(temporary, "config"), cache = join(temporary, "cache"); await mkdir(config); await mkdir(cache);
  harness = await createHostedQaHarness(); assert.equal(harness.origin, SYNTHETIC_ORIGIN);
  phase = "sandboxed-chrome-launch";
  browser = await chromium.launch({ channel: "chrome", headless: true, chromiumSandbox: true, timeout: 20_000,
    env: { ...process.env, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache, FONTCONFIG_FILE: fontConfig, DEBUG: "", PWDEBUG: "0" } });
  const cdp = await browser.newBrowserCDPSession(); const commandLine = await cdp.send("Browser.getBrowserCommandLine");
  assert.ok(!commandLine.arguments.some(value => /^--(?:no-sandbox|disable-setuid-sandbox|disable-web-security|single-process|ignore-certificate-errors|allow-insecure-localhost)(?:=|$)/.test(value))); await cdp.detach();
  let externalRequests = 0, pageErrors = 0, bridgeErrors = 0, logRequests = 0, lifecycleRequests = 0;
  let loseNextBaselineResponse = false, lostReceipt, logoutGate, logGate;
  const files = [], captures = [], checks = [];
  async function sessionPage(clock = false) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1, serviceWorkers: "block" });
    await context.route("**/*", async route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.origin !== SYNTHETIC_ORIGIN || url.username || url.password) { externalRequests++; await route.abort(); return; }
      if (/^\/api\/baselines\/[^/]+\/log$/.test(url.pathname)) logRequests++;
      if (/\/(?:run|runs|cancel|bootstrap)(?:\/|$)/.test(url.pathname)) lifecycleRequests++;
      try {
        const response = await bridgeRequest(request, harness.fetch);
        if (loseNextBaselineResponse && url.pathname === "/api/baselines" && request.method() === "POST" && response.status === 201) {
          loseNextBaselineResponse = false; lostReceipt = JSON.parse(response.body.toString()).id;
          await route.abort("failed"); return;
        }
        const gate = url.pathname === "/api/auth/logout" ? logoutGate
          : /^\/api\/baselines\/[^/]+\/log$/.test(url.pathname) ? logGate : undefined;
        if (gate) {
          try { await gate.hold(); await route.fulfill(response); } finally { gate.finish(); }
        } else await route.fulfill(response);
      } catch { bridgeErrors++; await route.abort().catch(() => {}); }
    });
    const page = await context.newPage(); page.setDefaultTimeout(15_000); page.on("pageerror", () => { pageErrors++; });
    if (clock) await page.clock.install({ time: new Date() });
    return { context, page };
  }
  const first = await sessionPage(), second = await sessionPage(true);
  async function capture(page, name, fullPage = false) {
    assert.equal(new URL(page.url()).search, ""); assert.equal(new URL(page.url()).hash, "");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, "HORIZONTAL_OVERFLOW");
    await page.evaluate(() => document.fonts.ready);
    const fontCdp = await page.context().newCDPSession(page); await fontCdp.send("DOM.enable"); await fontCdp.send("CSS.enable");
    const root = await fontCdp.send("DOM.getDocument");
    const heading = await fontCdp.send("DOM.querySelector", { nodeId: root.root.nodeId, selector: "h1" });
    const actualFonts = await fontCdp.send("CSS.getPlatformFontsForNode", { nodeId: heading.nodeId });
    const koreanFont = verifyKoreanFontUsage(actualFonts.fonts, await page.locator("h1").innerText()); await fontCdp.detach();
    const bytes = await page.screenshot({ type: "png", fullPage, animations: "disabled" });
    assert.ok(bytes.length <= LIMITS.fileBytes, "SCREENSHOT_BYTE_LIMIT"); files.push({ name: `synthetic-hosted-${name}.png`, bytes });
    assert.ok(files.length < LIMITS.files && files.reduce((sum, file) => sum + file.bytes.length, 0) <= LIMITS.totalBytes, "EVIDENCE_TOTAL_BYTE_LIMIT");
    captures.push({ name, viewport: page.viewportSize(), fullPage, horizontalOverflow: false, koreanFont });
  }
  async function both(page, name, fullPage = false) {
    await page.setViewportSize({ width: 1440, height: 1050 }); await capture(page, "desktop-" + name, fullPage);
    await page.setViewportSize({ width: 390, height: 844 }); await capture(page, "mobile-" + name, fullPage);
  }
  async function ready(page) {
    await page.waitForFunction(() => document.getElementById("workspace")?.getAttribute("aria-busy") === "false" && document.getElementById("source-file")?.disabled === false);
  }
  async function authenticate(page, setup, token = harness.token) {
    await page.locator("#email").fill(harness.email); await page.locator("#password").fill(harness.password);
    if (setup) { await page.locator("#token").fill(token); await page.locator("#confirmation").fill(harness.password); }
    const response = page.waitForResponse(value => new URL(value.url()).pathname === "/api/auth/" + (setup ? "enroll" : "login"));
    await page.locator("#auth-submit").click(); return response;
  }
  async function cookieProof(context, page) {
    const cookies = await context.cookies(); assert.equal(cookies.length, 2);
    assert.deepEqual(cookies.map(cookie => cookie.name).sort(), ["__Host-flora_csrf", "__Host-flora_session"]);
    for (const cookie of cookies) {
      assert.equal(cookie.secure, true); assert.equal(cookie.httpOnly, true); assert.equal(cookie.sameSite, "Strict");
      assert.equal(cookie.path, "/"); assert.equal(cookie.domain, "flora.example.test"); assert.ok(cookie.expires > Date.now() / 1000);
    }
    assert.equal(await page.evaluate(() => document.cookie), "");
    assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
    return cookies.find(cookie => cookie.name === "__Host-flora_session").value;
  }
  async function upload(page, kind, bytes) {
    await ready(page);
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === "/api/" + (kind === "source" ? "sources" : "baselines") && response.request().method() === "POST");
    await page.locator("#" + kind + "-file").setInputFiles({ name: "synthetic-" + kind + ".json", mimeType: "application/json", buffer: bytes });
    const response = await pending; assert.equal(response.status(), 201); const receipt = await response.json(); await ready(page); return receipt;
  }
  async function cleared(page) {
    assert.equal(await page.locator("#dashboard-content").isHidden(), true);
    for (const id of ["app-name", "source-details", "snapshot-select", "flavor-select", "baseline-history", "provider"]) assert.equal(await page.locator("#" + id).textContent(), "");
    assert.equal(await page.locator("#source-file").isDisabled(), true); assert.equal(await page.locator("#baseline-file").isDisabled(), true);
    assert.equal(await page.locator("body").innerText().then(text => text.includes("example/synthetic-app")), false);
  }

  const page = first.page;
  phase = "public-login-and-invalid-setup";
  await page.goto(harness.origin + "/login"); await page.locator("#auth-submit").waitFor(); await both(page, "login");
  await page.locator("#setup-link").click();
  assert.equal((await authenticate(page, true, "X".repeat(43))).status(), 403);
  await page.locator("#auth-status[role=alert]").waitFor();
  for (const id of ["password", "confirmation", "token"]) assert.equal(await page.locator("#" + id).inputValue(), "");
  assert.equal((await first.context.cookies()).length, 0); await both(page, "invalid-setup"); checks.push("invalid-setup-rejected-by-authority");

  phase = "real-enrollment-and-empty-state";
  assert.equal((await authenticate(page, true)).status(), 200); await page.waitForURL(harness.origin + "/"); await ready(page);
  await page.getByText("첫 소스 snapshot을 가져오세요").waitFor(); await both(page, "empty");
  const firstSession = await cookieProof(first.context, page); checks.push("real-scrypt-enrollment", "secure-httponly-strict-host-cookies", "no-browser-credential-storage");
  assert.equal(await page.evaluate(async () => (await fetch("/api/sources", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status), 403);
  checks.push("csrf-required-on-real-write");

  phase = "invalid-upload-and-recovery";
  const invalidResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/sources");
  await page.locator("#source-file").setInputFiles({ name: "synthetic-invalid.json", mimeType: "application/json", buffer: Buffer.from("{") });
  assert.equal((await invalidResponse).status(), 400); await page.locator("#notice[role=alert]").waitFor(); await both(page, "upload-error");
  const source = await upload(page, "source", harness.source()); assert.equal(await page.locator("#snapshot-select").inputValue(), source.id);
  assert.equal(await page.locator("#flavor-select option").count(), 11); await page.locator("#flavor-select").selectOption("sample-4");
  assert.ok((await page.locator("#flavor-detail").innerText()).includes("Sample App 4"));
  const baselineBytes = await harness.baseline(), baseline = await upload(page, "baseline", baselineBytes);
  assert.equal(baseline.evidence.evidenceDigest, createHash("sha256").update(baselineBytes).digest("hex"));
  assert.equal(logRequests, 0); await page.locator("#baseline-history summary").click();
  await page.locator("#baseline-history pre").filter({ hasText: "synthetic result" }).waitFor(); assert.equal(logRequests, 1);
  await page.locator("#baseline-history summary").focus();
  assert.equal(await page.locator("#baseline-history summary").evaluate(node => node === document.activeElement), true);
  await both(page, "populated", true); checks.push("original-source-baseline-ui-upload", "eleven-flavors", "exact-baseline-envelope-digest", "lazy-log-fetch-and-keyboard-focus");

  phase = "lost-response-idempotent-recovery";
  const lostBytes = await harness.baseline(0, 2); loseNextBaselineResponse = true;
  await page.locator("#baseline-file").setInputFiles({ name: "synthetic-baseline.json", mimeType: "application/json", buffer: lostBytes });
  await page.locator("#notice[role=alert]").filter({ hasText: "반입 완료 여부" }).waitFor(); assert.ok(lostReceipt);
  await page.locator("#retry-button").click(); await ready(page); assert.equal(await page.locator("#baseline-history .record").count(), 2);
  assert.equal((await upload(page, "baseline", lostBytes)).id, lostReceipt);
  assert.equal(await page.locator("#baseline-history .record").count(), 2); checks.push("lost-real-commit-response-retry-preserves-receipt");

  phase = "history-and-snapshot-pagination";
  for (let attempt = 3; attempt <= 21; attempt++) await upload(page, "baseline", await harness.baseline(0, attempt));
  assert.equal(await page.locator("#baseline-history .record").count(), 20);
  await page.locator("#history-next").click(); await ready(page); assert.equal(await page.locator("#baseline-history .record").count(), 1);
  await page.locator("#history-previous").click(); await ready(page); assert.equal(await page.locator("#baseline-history .record").count(), 20);
  for (let index = 1; index <= 20; index++) await upload(page, "source", harness.source(index));
  const newestId = await page.locator("#snapshot-select").inputValue();
  await page.locator("#snapshot-next").click(); await ready(page); assert.equal(await page.locator("#snapshot-select").inputValue(), newestId);
  await page.locator("#snapshot-select").selectOption(source.id); await ready(page); assert.equal(await page.locator("#baseline-history .record").count(), 20);
  await page.locator("#snapshot-previous").click(); await ready(page); assert.equal(await page.locator("#snapshot-select").inputValue(), source.id);
  checks.push("twenty-entry-history-pages", "snapshot-pages-retain-selection", "older-snapshot-history-restored");

  phase = "independent-browser-login-and-revisit";
  await second.page.goto(harness.origin + "/setup");
  assert.equal((await authenticate(second.page, true)).status(), 403); await second.page.locator("#auth-status[role=alert]").waitFor();
  assert.equal((await second.context.cookies()).length, 0); checks.push("consumed-setup-replay-rejected");
  await second.page.locator("#auth-login-link").click(); assert.equal((await authenticate(second.page, false)).status(), 200);
  await second.page.waitForURL(harness.origin + "/"); await ready(second.page);
  const secondSession = await cookieProof(second.context, second.page); assert.notEqual(firstSession, secondSession);
  assert.equal(await second.page.locator("#snapshot-select").inputValue(), newestId);
  await second.page.locator("#snapshot-next").click(); await ready(second.page);
  await second.page.locator("#snapshot-select").selectOption(source.id); await ready(second.page);
  assert.equal(await second.page.locator("#baseline-history .record").count(), 20);
  await second.page.locator("#history-next").click(); await ready(second.page);
  assert.ok((await second.page.locator("#baseline-history").innerText()).includes(baseline.id));
  await second.page.locator("#baseline-history summary").click(); await second.page.locator("#baseline-history pre").filter({ hasText: "synthetic result" }).waitFor();
  await both(second.page, "second-session"); checks.push("independent-session-revisits-d1-history-and-log");

  phase = "logout-immediate-clearing-and-revocation";
  const oldCookie = (await first.context.cookies()).map(cookie => cookie.name + "=" + cookie.value).join("; ");
  logGate = createResponseGate(); logoutGate = createResponseGate();
  try {
    await page.locator("#baseline-history summary").first().click(); await logGate.entered;
    const logoutResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/logout");
    await page.locator("#logout-button").click(); await logoutGate.entered;
    // The real authority has revoked the session, but neither the logout
    // response nor the earlier private log has been delivered to this page.
    await cleared(page); assert.equal((await first.context.cookies()).length, 2);
    assert.equal((await harness.fetch(harness.origin + "/api/state", { headers: { Cookie: oldCookie } })).status, 401);
    logGate.release(); await logGate.finished;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await cleared(page);
    logoutGate.release(); assert.equal((await logoutResponse).status(), 200); await logoutGate.finished;
  } finally {
    logGate.release(); logoutGate.release();
  }
  logGate = undefined; logoutGate = undefined;
  await page.locator("#notice").filter({ hasText: "로그아웃했습니다" }).waitFor(); assert.equal((await first.context.cookies()).length, 0);
  assert.equal(await page.evaluate(async () => (await fetch("/api/state")).status), 401);
  await both(page, "logout");
  assert.equal(await second.page.evaluate(async () => (await fetch("/api/state")).status), 200);
  checks.push("logout-clears-dom-before-response", "late-private-response-cannot-restore-dom", "real-browser-cookie-revoked-only-for-current-session");

  phase = "client-absolute-expiry-clears-private-dom";
  // Browser clock only. This checks the frontend one-shot deadline, while server
  // expiry is covered by authority tests; no claim of one hour of wall time.
  const expiresAt = await second.page.evaluate(async () => (await (await fetch("/api/auth/session")).json()).expiresAt);
  const browserNow = await second.page.evaluate(() => Date.now());
  assert.ok(Number.isSafeInteger(expiresAt) && expiresAt > browserNow);
  await second.page.clock.fastForward(expiresAt - browserNow + 1);
  await second.page.locator("#notice[role=alert]").filter({ hasText: "만료" }).waitFor(); await cleared(second.page);
  await capture(second.page, "mobile-expired"); checks.push("browser-clock-absolute-expiry-clears-dom");
  assert.equal(externalRequests, 0); assert.equal(harness.outboundRequests(), 0); assert.equal(pageErrors, 0); assert.equal(bridgeErrors, 0); assert.equal(lifecycleRequests, 0);
  files.push({ name: "synthetic-hosted-evidence.json", bytes: Buffer.from(JSON.stringify({ syntheticOnly: true, commit: process.env.GITHUB_SHA,
    browser: await browser.version(), browserSandboxRequested: true, unsafeSandboxFlagsAbsent: true,
    transport: "synthetic HTTPS route interception into production Worker, SQLite DO and D1; real response cookies",
    unverified: ["deployed DNS/TLS", "Cloudflare Free account/resource capacity", "deployed CPU/memory/latency", "wall-clock server expiry during browser run"],
    externalRequests, workerOutboundRequests: harness.outboundRequests(), pageErrors, bridgeErrors, lifecycleRequests, captures, checks }, null, 2)) });
  phase = "evidence-encoding";
  for (const line of encodeEvidence(files, process.env.GITHUB_SHA)) console.log(line);
  console.log("FLORA_HOSTED_QA_SUMMARY: synthetic hosted composition passed; inspect decoded pixels before visual approval; deployed DNS/TLS and performance unverified");
  await first.context.close(); await second.context.close();
} catch (error) {
  const message = typeof error?.message === "string" ? error.message : "";
  const reason = /No usable sandbox|sandbox.*not supported/i.test(message) ? "BROWSER_SANDBOX_UNAVAILABLE"
    : /Operation not permitted/.test(message) ? "OS_OPERATION_DENIED"
    : /[Ee]xecutable.*(?:doesn't exist|not found)/.test(message) ? "CHROME_UNAVAILABLE"
    : /KOREAN_FONT_NOT_RENDERED|KOREAN_SAMPLE_REQUIRED/.test(message) ? "KOREAN_FONT_NOT_RENDERED"
    : /SCREENSHOT_BYTE_LIMIT|EVIDENCE_TOTAL_BYTE_LIMIT|INVALID_RENDER_EVIDENCE/.test(message) ? "EVIDENCE_LIMIT_OR_FORMAT"
    : error?.name === "TimeoutError" ? "BROWSER_TIMEOUT" : error?.name === "AssertionError" ? "ASSERTION_FAILED" : "CHECK_FAILED";
  console.error("FLORA_HOSTED_QA_FAILURE " + phase + " " + reason); process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  await browser?.close().catch(() => {}); await harness?.close().catch(() => {});
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
