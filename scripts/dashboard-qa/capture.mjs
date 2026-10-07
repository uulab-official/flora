import { verifySurfaceDepth } from "./surface-depth.mjs";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createQaHarness } from "./server.mjs";
import { encodeEvidence, LIMITS } from "./evidence.mjs";
import { navigateBootstrapDocument } from "./navigation.mjs";
import { verifyKoreanFontUsage } from "./fonts.mjs";

// Deliberately CI-only. A failed sandbox launch is a failed render gate; no retry
// with weaker settings, OS changes, alternate provider, or public binding exists.
let phase = "preflight"; let harness; let browser; let temporary;
const timeout = setTimeout(() => { console.error("FLORA_QA_FAILURE deadline"); process.exit(1); }, 240_000);
try {
  assert.equal(process.env.GITHUB_ACTIONS, "true"); assert.equal(process.platform, "linux"); assert.notEqual(process.getuid(), 0);
  assert.ok(process.env.GITHUB_REF === "refs/heads/main" || process.env.GITHUB_REF?.startsWith("refs/heads/verify/flora-dogfood-"));
  assert.match(process.env.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/);
  assert.ok(process.env.FLORA_QA_PLAYWRIGHT_MODULE);
  assert.ok(process.env.FLORA_QA_FONTCONFIG);
  const fontConfig = resolve(process.env.FLORA_QA_FONTCONFIG); await access(fontConfig);
  const { chromium } = await import(pathToFileURL(resolve(process.env.FLORA_QA_PLAYWRIGHT_MODULE)).href);
  temporary = await mkdtemp(join(tmpdir(), "flora-render-"));
  const config = join(temporary, "config"); const cache = join(temporary, "cache");
  await mkdir(config); await mkdir(cache);
  harness = await createQaHarness(); assert.equal(new URL(harness.origin).hostname, "127.0.0.1");
  phase = "sandboxed-chrome-launch";
  browser = await chromium.launch({ channel: "chrome", headless: true, chromiumSandbox: true, timeout: 20_000,
    env: { ...process.env, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache, FONTCONFIG_FILE: fontConfig, DEBUG: "", PWDEBUG: "0" } });
  const cdp = await browser.newBrowserCDPSession(); const commandLine = await cdp.send("Browser.getBrowserCommandLine");
  assert.ok(!commandLine.arguments.some(value => /^--(?:no-sandbox|disable-setuid-sandbox|disable-web-security|single-process)(?:=|$)/.test(value))); await cdp.detach();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1, serviceWorkers: "block" });
  let externalRequests = 0; let pageErrors = 0;
  await context.route("**/*", async route => { if (new URL(route.request().url()).origin !== harness.origin) { externalRequests++; await route.abort(); } else await route.continue(); });
  const page = await context.newPage(); page.setDefaultTimeout(10_000); page.on("pageerror", () => { pageErrors++; });
  const fontCdp = await context.newCDPSession(page); await fontCdp.send("DOM.enable"); await fontCdp.send("CSS.enable");
  const files = []; const captures = []; const checks = [];
  async function capture(name, fullPage = false) {
    assert.ok(!new URL(page.url()).hash || new URL(page.url()).hash === "#workspace");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, "horizontal overflow");
    await page.evaluate(() => document.fonts.ready);
    const root = await fontCdp.send("DOM.getDocument");
    const heading = await fontCdp.send("DOM.querySelector", { nodeId: root.root.nodeId, selector: "h1" });
    const actualFonts = await fontCdp.send("CSS.getPlatformFontsForNode", { nodeId: heading.nodeId });
    const koreanFont = verifyKoreanFontUsage(actualFonts.fonts, await page.locator("h1").innerText());
    const surfaceDepth = await verifySurfaceDepth(page);
    const bytes = await page.screenshot({ type: "png", fullPage, animations: "disabled" });
    assert.ok(bytes.length <= LIMITS.fileBytes, "SCREENSHOT_BYTE_LIMIT"); files.push({ name: `synthetic-${name}.png`, bytes });
    assert.ok(files.reduce((sum, file) => sum + file.bytes.length, 0) <= LIMITS.totalBytes, "EVIDENCE_TOTAL_BYTE_LIMIT");
    captures.push({ name, viewport: page.viewportSize(), fullPage, horizontalOverflow: false, surfaceDepth, koreanFont });
  }
  async function both(name, fullPage = false) {
    await page.setViewportSize({ width: 1440, height: 1050 }); await capture("desktop-" + name, fullPage);
    await page.setViewportSize({ width: 390, height: 844 }); await capture("mobile-" + name, fullPage);
  }
  async function upload(label, name, value) { await page.getByLabel(label, { exact: true }).setInputFiles({ name, mimeType: "application/json", buffer: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)) }); }
  async function nextPoll() {
    // Arm after focus, then wait for a completed DOM render rather than headers.
    await page.evaluate(() => new Promise((resolve, reject) => {
      const root = document.getElementById("run-history");
      const observer = new MutationObserver(() => { observer.disconnect(); clearTimeout(timer); resolve(); });
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error("POLL_RENDER_TIMEOUT")); }, 10_000);
      observer.observe(root, { childList: true });
    }));
  }
  phase = "unauthorized-session";
  await page.goto(harness.origin); await page.getByRole("alert").filter({ hasText: "세션" }).waitFor(); await both("session"); checks.push("unauthorized-private-content-hidden");
  phase = "bootstrap-loading";
  let release; const gate = new Promise(resolve => { release = resolve; });
  const delayedSession = async route => { await gate; await route.continue(); };
  await page.route("**/api/session", delayedSession);
  await navigateBootstrapDocument(page, harness.bootstrapUrl);
  await page.getByRole("status").filter({ hasText: "불러오는 중" }).waitFor(); assert.equal(new URL(page.url()).hash, ""); await both("loading");
  release(); await page.getByText("첫 소스 snapshot을 가져오세요").waitFor(); await page.unroute("**/api/session", delayedSession); checks.push("bootstrap-erased-before-exchange");
  phase = "empty-and-input-error";
  await both("empty"); await upload("소스 JSON 가져오기", "synthetic-invalid.json", "{");
  await page.getByRole("alert").filter({ hasText: "INVALID_INPUT" }).waitFor(); await both("input-error");
  phase = "imports-and-blocked-request";
  await upload("소스 JSON 가져오기", "synthetic-source.json", harness.source());
  await page.locator("#app-name").filter({ hasText: "synthetic" }).waitFor(); assert.equal(await page.locator("#flavor-select option").count(), 11);
  await page.locator("#flavor-select").selectOption({ index: 3 });
  await upload("개발 baseline 가져오기", "synthetic-baseline.json", await harness.baseline()); await page.locator("#baseline-history").getByText("통과", { exact: true }).waitFor();
  await page.getByRole("button", { name: "실행 가능 여부 확인", exact: true }).click(); await page.locator("#run-history").getByText("실행 차단", { exact: true }).waitFor();
  await both("populated-blocked", true); checks.push("source-baseline-file-import", "eleven-flavors", "blocked-is-not-execution");
  phase = "anchor-cookie-reload";
  await page.locator(".skip").focus(); await page.keyboard.press("Enter"); assert.equal(new URL(page.url()).hash, "#workspace");
  await page.reload(); await page.locator("#run-history").getByText("실행 차단", { exact: true }).waitFor(); assert.equal(new URL(page.url()).hash, "#workspace"); checks.push("skip-link-cookie-reload-history");
  phase = "active-poll-disclosures-and-focus";
  const queued = await harness.seedQueued(); await page.reload();
  const cancel = page.locator('[data-cancel="' + queued.id + '"]'); await cancel.waitFor();
  for (const [width, height, name] of [[1440, 1050, "desktop"], [390, 844, "mobile"]]) {
    await page.setViewportSize({ width, height });
    for (const selector of ["#baseline-history details", "#provider details"]) {
      const details = page.locator(selector); const summary = details.locator("summary");
      if (!await details.evaluate(node => node.open)) await summary.click();
      await summary.focus(); await nextPoll(); await nextPoll();
      assert.equal(await details.evaluate(node => node.open), true); assert.equal(await summary.evaluate(node => document.activeElement === node), true);
    }
    await cancel.focus(); await nextPoll(); assert.equal(await cancel.evaluate(node => document.activeElement === node), true);
    await capture(name + "-active-focus", true);
  }
  await cancel.click(); await page.locator("#run-history").getByText("취소됨", { exact: true }).waitFor();
  checks.push("log-and-provider-disclosure-open-state", "summary-and-cancel-keyboard-focus", "active-poll-render-and-cancel");
  phase = "past-revision-navigation";
  await upload("소스 JSON 가져오기", "synthetic-second-source.json", harness.source(true));
  await page.waitForFunction(() => document.getElementById("snapshot-select").selectedOptions[0]?.textContent.includes("bbbbbbbbbbbb"));
  assert.equal(await page.locator("#run-history .record").count(), 0);
  await page.locator("#snapshot-select").selectOption({ index: 1 }); await page.locator("#baseline-history").getByText("통과", { exact: true }).waitFor();
  await page.locator("#run-history").getByText("실행 차단", { exact: true }).waitFor(); await capture("mobile-past-revision", true); checks.push("past-revision-history-restoration");
  phase = "session-loss";
  assert.ok((await page.locator("#app-name").textContent()).includes("synthetic"));
  await context.clearCookies(); await page.getByRole("button", { name: "실행 가능 여부 확인", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "세션" }).waitFor();
  assert.equal(await page.locator("#app-name").textContent(), ""); assert.equal(await page.locator("#source-file").isDisabled(), true); await capture("mobile-session-expired"); checks.push("session-loss-clears-private-content");
  assert.equal(externalRequests, 0); assert.equal(pageErrors, 0);
  files.push({ name: "synthetic-evidence.json", bytes: Buffer.from(JSON.stringify({ syntheticOnly: true, commit: process.env.GITHUB_SHA, browser: await browser.version(), browserSandboxRequested: true, unsafeSandboxFlagsAbsent: true, externalRequests, pageErrors, captures, checks }, null, 2)) });
  phase = "evidence-encoding";
  for (const line of encodeEvidence(files, process.env.GITHUB_SHA)) console.log(line);
  console.log("FLORA_QA_SUMMARY: synthetic rendering checks passed; inspect decoded screenshots before visual approval");
  await context.close();
} catch (error) {
  // Classify known diagnostics; never dump URLs, cookies, tokens, or raw errors.
  const message = typeof error?.message === "string" ? error.message : "";
  const reason = /No usable sandbox|sandbox.*not supported/i.test(message) ? "BROWSER_SANDBOX_UNAVAILABLE"
    : /Operation not permitted/.test(message) ? "OS_OPERATION_DENIED"
    : /[Ee]xecutable.*(?:doesn't exist|not found)/.test(message) ? "CHROME_UNAVAILABLE"
    : /KOREAN_FONT_NOT_RENDERED|KOREAN_SAMPLE_REQUIRED/.test(message) ? "KOREAN_FONT_NOT_RENDERED"
    : /SCREENSHOT_BYTE_LIMIT|EVIDENCE_TOTAL_BYTE_LIMIT|INVALID_RENDER_EVIDENCE/.test(message) ? "EVIDENCE_LIMIT_OR_FORMAT"
    : error?.name === "TimeoutError" ? "BROWSER_TIMEOUT" : error?.name === "AssertionError" ? "ASSERTION_FAILED" : "CHECK_FAILED";
  console.error("FLORA_QA_FAILURE " + phase + " " + reason); process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  await browser?.close().catch(() => {});
  await harness?.close().catch(() => {});
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
