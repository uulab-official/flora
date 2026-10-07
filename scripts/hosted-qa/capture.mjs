import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHostedQaHarness } from "./runtime.mjs";
import { bridgeRequest, SYNTHETIC_ORIGIN } from "./transport.mjs";
import { createResponseGate } from "./response-gate.mjs";
import { measureMobileAppDensity } from "./mobile-density.mjs";
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
  const files = [], captures = [], checks = [], importDigests = [], targetChecks = [];
  let pageScaleEvidence;
  async function sessionPage(clock = false) {
    const context = await browser.newContext({ viewport: { width: 1487, height: 1058 }, deviceScaleFactor: 1, serviceWorkers: "block" });
    await context.route("**/*", async route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.origin !== SYNTHETIC_ORIGIN || url.username || url.password) { externalRequests++; await route.abort(); return; }
      if (/^\/api\/baselines\/[^/]+\/log$/.test(url.pathname)) logRequests++;
      if (/\/(?:run|runs|cancel|bootstrap)(?:\/|$)/.test(url.pathname)) lifecycleRequests++;
      try {
        const response = await bridgeRequest(request, harness.httpFetch);
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
    assert.equal(await page.evaluate(() => window.visualViewport?.scale), 1, "REFERENCE_SCALE_MUST_BE_ONE");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, "HORIZONTAL_OVERFLOW");
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.scrollTo(0, 0));
    assert.equal(await page.locator("img").evaluateAll(nodes => nodes.filter(node => node.getClientRects().length).every(node => node.complete && node.naturalWidth > 0)), true, "VISIBLE_IMAGE_NOT_LOADED");
    assert.equal(await page.locator("svg use").evaluateAll(nodes => nodes.filter(node => node.getClientRects().length).every(node => { const box = node.getBBox(); return box.width > 0 && box.height > 0; })), true, "VISIBLE_ICON_NOT_LOADED");
    const fontCdp = await page.context().newCDPSession(page); await fontCdp.send("DOM.enable"); await fontCdp.send("CSS.enable");
    const root = await fontCdp.send("DOM.getDocument");
    const heading = await fontCdp.send("DOM.querySelector", { nodeId: root.root.nodeId, selector: "h1" });
    const actualFonts = await fontCdp.send("CSS.getPlatformFontsForNode", { nodeId: heading.nodeId });
    const koreanFont = verifyKoreanFontUsage(actualFonts.fonts, await page.locator("h1").innerText()); await fontCdp.detach();
    let appDensity;
    if (name === "mobile-apps") {
      assert.equal(await page.locator("#app-sort").inputValue(), "name-asc");
      assert.equal(await page.locator("#app-search").inputValue(), "");
      assert.equal(await page.locator("#app-source-filter").inputValue(), "all");
      assert.equal(await page.locator("#app-detail").isHidden(), true);
      assert.match(await page.locator("#app-page-number").innerText(), /^1 \/ /);
      // Read the same unmodified viewport as the canonical screenshot below.
      // No row is scrolled into view to satisfy the density threshold.
      const rows = await page.locator("#app-rows tr").all();
      appDensity = measureMobileAppDensity({
        viewport: page.viewportSize(),
        ...await page.evaluate(() => ({ scale: window.visualViewport?.scale, scrollY: window.scrollY })),
        navigation: await page.locator(".mobile-nav").boundingBox(),
        rows: await Promise.all(rows.map(row => row.boundingBox())),
      });
      checks.push("at-least-four-complete-mobile-app-rows");
    }
    const bytes = await page.screenshot({ type: "png", fullPage, animations: "disabled" });
    assert.ok(bytes.length <= LIMITS.fileBytes, "SCREENSHOT_BYTE_LIMIT"); files.push({ name: `synthetic-hosted-${name}.png`, bytes });
    assert.ok(files.length < LIMITS.files && files.reduce((sum, file) => sum + file.bytes.length, 0) <= LIMITS.totalBytes, "EVIDENCE_TOTAL_BYTE_LIMIT");
    const typography = await page.evaluate(() => ({ bodyPx: parseFloat(getComputedStyle(document.body).fontSize), headingPx: parseFloat(getComputedStyle(document.querySelector("h1")).fontSize) }));
    if (name.endsWith("-apps")) {
      assert.ok(typography.bodyPx >= 13 && typography.bodyPx <= 14, "DENSE_BODY_TYPE_REQUIRED");
      assert.ok(typography.headingPx >= 20 && typography.headingPx <= 22, "DENSE_HEADING_TYPE_REQUIRED");
    }
    captures.push({ name, viewport: page.viewportSize(), fullPage, horizontalOverflow: false, koreanFont, typography, ...(appDensity ? { appDensity } : {}) });
  }
  async function both(page, name, fullPage = false) {
    await page.setViewportSize({ width: 1487, height: 1058 }); await capture(page, "desktop-" + name, fullPage);
    await page.setViewportSize({ width: 390, height: 844 }); await capture(page, "mobile-" + name, fullPage);
  }
  async function ready(page) {
    await page.waitForFunction(() => document.getElementById("workspace")?.getAttribute("aria-busy") === "false" && document.getElementById("source-file")?.disabled === false);
  }
  async function navigate(page, view) {
    const mobile = page.locator("#mobile-" + view);
    await (await mobile.isVisible() ? mobile : page.locator("#nav-" + view)).click();
    await page.locator("#view-" + view).waitFor({ state: "visible" });
    for (const other of ["apps", "sources", "history", "account"].filter(value => value !== view)) assert.equal(await page.locator("#view-" + other).isHidden(), true);
  }
  async function mobileTargets(page, state, selectors) {
    assert.equal(page.viewportSize().width, 390, "MOBILE_VIEWPORT_REQUIRED");
    const targets = [];
    for (const selector of selectors) {
      const matches = page.locator(selector); let checked = 0;
      for (let index = 0; index < await matches.count(); index++) {
        const control = matches.nth(index);
        if (!await control.isVisible() || !await control.isEnabled()) continue;
        await control.scrollIntoViewIfNeeded();
        const box = await control.boundingBox();
        assert.ok(box && box.width >= 44 && box.height >= 44, "MOBILE_TOUCH_TARGET_REQUIRED");
        // Trial clicks check real pointer actionability without toggling a
        // disclosure, changing a page or opening an import file chooser.
        await control.click({ trial: true });
        targets.push({ selector, index, width: box.width, height: box.height }); checked++;
      }
      assert.ok(checked > 0, "VISIBLE_ENABLED_MOBILE_TARGET_REQUIRED");
    }
    targetChecks.push({ state, viewport: page.viewportSize(), minimumCssPx: 44, targets });
  }
  async function twofoldPageScale(page, appButtons) {
    const step = name => {
      phase = "mobile-twofold-page-scale-" + name;
      console.log("FLORA_HOSTED_QA_SCALE_STEP " + phase);
    };
    step("attach");
    const session = await page.context().newCDPSession(page);
    let requestedScale = 2, failure;
    // Only fixed keys and finite, bounded numbers may cross the log boundary.
    // Never print raw CDP responses, browser errors, DOM text or credentials.
    const numeric = value => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000
      ? Math.round(value * 1000) / 1000 : null;
    async function sample() {
      const samplePhase = phase, sampleRequestedScale = requestedScale;
      let timer, expired = false;
      try {
        // Optional diagnostics have their own total budget. A stalled read must
        // not delay cleanup until the runner deadline or emit a late record.
        const observed = await Promise.race([
          (async () => {
            const metrics = await session.send("Page.getLayoutMetrics");
            if (expired) return null;
            const domScale = await page.evaluate(() => window.visualViewport?.scale);
            return { metrics, domScale };
          })(),
          new Promise(resolve => { timer = setTimeout(() => { expired = true; resolve(null); }, 500); }),
        ]);
        if (!observed) { console.log("FLORA_HOSTED_QA_SCALE_METRICS_UNAVAILABLE " + samplePhase); return; }
        const { metrics, domScale } = observed;
        const layout = metrics.cssLayoutViewport, visual = metrics.cssVisualViewport;
        console.log("FLORA_HOSTED_QA_SCALE_METRICS " + JSON.stringify({ phase: samplePhase, requestedScale: sampleRequestedScale, domScale: numeric(domScale),
          observedScale: numeric(visual?.scale), layoutWidth: numeric(layout?.clientWidth), layoutHeight: numeric(layout?.clientHeight),
          visualWidth: numeric(visual?.clientWidth), visualHeight: numeric(visual?.clientHeight),
          visualOffsetX: numeric(visual?.offsetX), visualOffsetY: numeric(visual?.offsetY),
          visualPageX: numeric(visual?.pageX), visualPageY: numeric(visual?.pageY) }));
      } catch { console.log("FLORA_HOSTED_QA_SCALE_METRICS_UNAVAILABLE " + samplePhase); }
      finally { expired = true; clearTimeout(timer); }
    }
    async function retainFailure(error) {
      failure ??= { error, phase };
      console.log("FLORA_HOSTED_QA_SCALE_FAILED_STEP " + phase);
      await sample();
    }
    try {
      // Browser visual page scaling, not a CSS transform or OS text zoom.
      step("request-twofold");
      await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
      await sample();
      step("observe-twofold");
      await page.waitForFunction(() => Math.abs((window.visualViewport?.scale ?? 0) - 2) < 0.01);
      step("read-layout");
      const metrics = await session.send("Page.getLayoutMetrics");
      step("validate-layout");
      assert.ok(Math.abs(metrics.cssVisualViewport.scale - 2) < 0.01, "OBSERVED_TWO_FOLD_SCALE_REQUIRED");
      assert.ok(Math.abs(metrics.cssLayoutViewport.clientWidth / metrics.cssVisualViewport.clientWidth - 2) < 0.05, "VISUAL_VIEWPORT_MUST_SHRINK");
      const search = page.locator("#app-search");
      step("scroll-search");
      await search.scrollIntoViewIfNeeded();
      await sample();
      step("trial-search");
      await search.click({ trial: true });
      step("fill-search");
      await search.fill("Sample App 4");
      step("count-filtered");
      assert.equal(await appButtons.count(), 1);
      step("open-detail");
      await page.locator("#flavor-row-sample-4").click();
      step("wait-detail");
      await page.locator("#app-detail").waitFor({ state: "visible" });
      step("close-detail");
      await page.locator("#detail-close").click();
      step("check-detail-hidden");
      assert.equal(await page.locator("#app-detail").isHidden(), true);
      step("clear-search");
      await search.fill("");
      step("count-restored");
      assert.equal(await appButtons.count(), 10);
      step("observe-retained");
      const observedScale = await page.evaluate(() => window.visualViewport?.scale);
      assert.ok(Math.abs(observedScale - 2) < 0.01, "SCALE_MUST_REMAIN_DURING_INTERACTION");
      pageScaleEvidence = { method: "CDP Emulation.setPageScaleFactor", requestedScale: 2, observedScale,
        layoutWidth: metrics.cssLayoutViewport.clientWidth, visualWidth: metrics.cssVisualViewport.clientWidth,
        usableControls: ["app search", "open app detail", "close app detail", "clear search"] };
    } catch (error) {
      await retainFailure(error);
    } finally {
      try {
        step("restore-request"); requestedScale = 1;
        await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
        step("restore-observe");
        await page.waitForFunction(() => Math.abs((window.visualViewport?.scale ?? 0) - 1) < 0.01);
      } catch (error) {
        await retainFailure(error);
      } finally {
        try { step("detach"); await session.detach(); }
        catch (error) { await retainFailure(error); }
      }
    }
    // Reset/detach must run, but cannot relabel or replace the original failure.
    if (failure) { phase = failure.phase; throw failure.error; }
    step("read-restored");
    pageScaleEvidence.restoredScale = await page.evaluate(() => window.visualViewport?.scale);
    checks.push("observed-cdp-twofold-page-scale-with-usable-controls");
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
    if (kind === "baseline") await navigate(page, "history");
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === "/api/" + (kind === "source" ? "sources" : "baselines") && response.request().method() === "POST");
    await page.locator("#" + kind + "-file").setInputFiles({ name: "synthetic-" + kind + ".json", mimeType: "application/json", buffer: bytes });
    const response = await pending; assert.equal(response.status(), 201);
    const transported = response.request().postDataBuffer(); assert.deepEqual(transported, bytes, "ORIGINAL_IMPORT_BYTES_REQUIRED");
    importDigests.push({ kind, bytes: bytes.length, sha256: createHash("sha256").update(transported).digest("hex") });
    const receipt = await response.json(); await ready(page); return receipt;
  }
  async function cleared(page) {
    assert.equal(await page.locator("#dashboard-content").isHidden(), true);
    for (const id of ["app-name", "source-details", "snapshot-select", "flavor-select", "baseline-history", "provider", "app-rows", "flavor-detail", "detail-title", "recent-history", "history-scope", "app-source-filter", "app-count", "source-count"]) assert.equal(await page.locator("#" + id).textContent(), "");
    assert.equal(await page.locator("#app-detail").isHidden(), true);
    assert.equal(await page.locator("#app-search").inputValue(), "");
    assert.equal(await page.locator("#source-file").isDisabled(), true); assert.equal(await page.locator("#baseline-file").isDisabled(), true);
    const text = await page.locator("body").textContent();
    assert.equal(text.includes("example/synthetic-app") || text.includes("Sample App"), false, "PRIVATE_TEXT_REMAINED_IN_DOM");
  }

  const page = first.page;
  phase = "public-login-and-invalid-setup";
  await page.goto(harness.origin + "/login"); await page.locator("#auth-submit").waitFor(); await capture(page, "desktop-login");
  await page.locator("#setup-link").click();
  assert.equal((await authenticate(page, true, "X".repeat(43))).status(), 403);
  await page.locator("#auth-status[role=alert]").waitFor();
  for (const id of ["password", "confirmation", "token"]) assert.equal(await page.locator("#" + id).inputValue(), "");
  assert.equal((await first.context.cookies()).length, 0); checks.push("invalid-setup-rejected-by-authority");

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
  phase = "apps-search-sort-pagination-and-detail";
  await navigate(page, "apps");
  const appButtons = page.locator('#app-rows button[id^="flavor-row-"]');
  assert.equal(await page.locator("#app-sort").inputValue(), "name-asc");
  assert.equal(await appButtons.first().locator("strong").innerText(), "Sample App 1");
  assert.equal(await appButtons.count(), 10);
  await mobileTargets(page, "apps-first-page", ["#app-next", "#app-search", "#app-source-filter", "#app-sort"]);
  await page.locator("#app-next").click(); assert.equal(await appButtons.count(), 1);
  await mobileTargets(page, "apps-second-page", ["#app-previous"]);
  await page.locator("#app-previous").click(); assert.equal(await appButtons.count(), 10);
  await page.locator("#app-search").fill("Sample App 4"); assert.equal(await appButtons.count(), 1);
  await page.locator("#flavor-row-sample-4").click();
  await page.locator("#app-detail").waitFor({ state: "visible" });
  assert.equal(await page.locator("#flavor-select option").count(), 11);
  assert.equal(await page.locator("#flavor-select").inputValue(), "sample-4");
  assert.ok((await page.locator("#flavor-detail").innerText()).includes("Sample App 4"));
  assert.ok((await page.locator("#app-detail").innerText()).includes("1.2.3"));
  await page.setViewportSize({ width: 1487, height: 1058 }); await capture(page, "desktop-app-detail");
  await page.locator("#detail-close").click(); assert.equal(await page.locator("#app-detail").isHidden(), true);
  await page.locator("#app-search").fill("no-such-synthetic-flavor"); assert.equal(await appButtons.count(), 0);
  await page.locator("#app-search").fill(""); assert.equal(await appButtons.count(), 10);
  await page.locator("#app-sort").selectOption("name-desc"); assert.ok((await appButtons.first().innerText()).includes("Sample App 11"));
  await page.locator("#app-sort").selectOption("source-order");
  const sourceFilter = await page.locator("#app-source-filter option").last().getAttribute("value");
  assert.ok(sourceFilter); await page.locator("#app-source-filter").selectOption(sourceFilter); assert.equal(await appButtons.count(), 10);
  await page.locator("#app-source-filter").selectOption({ index: 0 });
  const rows = await page.locator("#app-rows tr").allTextContents();
  assert.equal(rows.length, 10);
  for (const row of rows) {
    assert.ok(row.includes("1.2.3") && row.includes("example/synthetic-app"));
    assert.equal(row.match(/미연결/g)?.length, 3, "UNKNOWN_DEPLOYMENT_ERROR_REVENUE_REQUIRED");
  }
  await page.locator("#app-sort").selectOption("name-asc");
  checks.push("search-clear-and-empty-results", "source-filter-and-name-sort", "ten-row-flavor-pagination", "app-detail-selection-and-close", "declared-version-and-unknown-operations-metrics");

  phase = "original-baseline-and-console-navigation";
  const baselineBytes = await harness.baseline(), baseline = await upload(page, "baseline", baselineBytes);
  assert.equal(baseline.evidence.evidenceDigest, createHash("sha256").update(baselineBytes).digest("hex"));
  assert.equal(logRequests, 0); await page.locator("#baseline-history summary").click();
  await page.locator("#baseline-history pre").filter({ hasText: "synthetic result" }).waitFor(); assert.equal(logRequests, 1);
  await page.locator("#baseline-history summary").focus();
  assert.equal(await page.locator("#baseline-history summary").evaluate(node => node === document.activeElement), true);
  await page.setViewportSize({ width: 390, height: 844 });
  await mobileTargets(page, "history-disclosures-and-imports", ["#view-history summary", 'label[for="baseline-file"]', 'label[for="source-file"]']);
  await capture(page, "mobile-history");
  await navigate(page, "sources");
  await mobileTargets(page, "source-disclosure-and-controls", ["#view-sources summary", "#snapshot-select", 'label[for="source-file"]']);
  await page.locator(".source-details > summary").click();
  assert.ok((await page.locator("#source-details").innerText()).includes(source.files[0].sha256));
  assert.ok((await page.locator("#runtime").innerText()).includes("1.2.3"));
  await both(page, "sources"); checks.push("source-hash-disclosure-and-declared-runtime");
  await navigate(page, "apps");
  phase = "mobile-twofold-page-scale";
  await twofoldPageScale(page, appButtons);
  phase = "approved-apps-reference-state";
  // Exact approved interaction state, with the requested denser type/table:
  // eleven declared flavors, one source, one source-scoped imported baseline,
  // Sample App 4 selected, no search, ascending app name, and detail closed.
  await page.setViewportSize({ width: 1487, height: 1058 });
  assert.equal(await page.locator("#app-sort").inputValue(), "name-asc");
  assert.equal(await appButtons.first().locator("strong").innerText(), "Sample App 1");
  await page.locator("#flavor-row-sample-4").click(); await page.locator("#detail-close").click();
  assert.equal(await page.locator("#app-search").inputValue(), "");
  assert.equal(await appButtons.count(), 10);
  await page.locator('label[for="source-file"]').first().waitFor({ state: "visible" });
  await page.locator("#app-search").waitFor({ state: "visible" });
  await both(page, "apps");
  await mobileTargets(page, "apps-navigation-and-rows", ["#mobile-apps", "#mobile-sources", "#mobile-history", "#mobile-account", '#app-rows button[id^="flavor-row-"]', "#app-rows .row-arrow"]);
  assert.equal(await page.locator('meta[name="viewport"]').getAttribute("content"), "width=device-width, initial-scale=1");
  checks.push("original-source-baseline-ui-upload", "eleven-flavors-one-source", "exact-baseline-envelope-digest", "lazy-log-fetch-and-keyboard-focus", "desktop-and-mobile-three-view-navigation", "measured-mobile-targets-and-actionability", "viewport-metadata-allows-user-scaling");

  phase = "lost-response-idempotent-recovery";
  await navigate(page, "history");
  const lostBytes = await harness.baseline(0, 2); loseNextBaselineResponse = true;
  await page.locator("#baseline-file").setInputFiles({ name: "synthetic-baseline.json", mimeType: "application/json", buffer: lostBytes });
  await page.locator("#notice[role=alert]").filter({ hasText: "반입 완료 여부" }).waitFor(); assert.ok(lostReceipt);
  await page.locator("#retry-button").click(); await ready(page); assert.equal(await page.locator("#baseline-history .record").count(), 2);
  assert.equal((await upload(page, "baseline", lostBytes)).id, lostReceipt);
  assert.equal(await page.locator("#baseline-history .record").count(), 2); checks.push("lost-real-commit-response-retry-preserves-receipt");

  phase = "history-and-snapshot-pagination";
  for (let attempt = 3; attempt <= 21; attempt++) await upload(page, "baseline", await harness.baseline(0, attempt));
  assert.equal(await page.locator("#baseline-history .record").count(), 20);
  await mobileTargets(page, "history-next-page", ["#history-next"]);
  await page.locator("#history-next").click(); await ready(page); assert.equal(await page.locator("#baseline-history .record").count(), 1);
  await mobileTargets(page, "history-previous-page", ["#history-previous"]);
  await page.locator("#history-previous").click(); await ready(page); assert.equal(await page.locator("#baseline-history .record").count(), 20);
  for (let index = 1; index <= 20; index++) await upload(page, "source", harness.source(index));
  await navigate(page, "sources");
  const newestId = await page.locator("#snapshot-select").inputValue();
  await mobileTargets(page, "source-next-page", ["#snapshot-next"]);
  await page.locator("#snapshot-next").click(); await ready(page); assert.equal(await page.locator("#snapshot-select").inputValue(), newestId);
  await mobileTargets(page, "source-previous-page", ["#snapshot-previous"]);
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
  await navigate(second.page, "sources");
  assert.equal(await second.page.locator("#snapshot-select").inputValue(), newestId);
  await second.page.locator("#snapshot-next").click(); await ready(second.page);
  await second.page.locator("#snapshot-select").selectOption(source.id); await ready(second.page);
  assert.equal(await second.page.locator("#baseline-history .record").count(), 20);
  await navigate(second.page, "history");
  await second.page.locator("#history-next").click(); await ready(second.page);
  assert.ok((await second.page.locator("#baseline-history").innerText()).includes(baseline.id));
  await second.page.locator("#baseline-history summary").click(); await second.page.locator("#baseline-history pre").filter({ hasText: "synthetic result" }).waitFor();
  checks.push("independent-session-revisits-d1-history-and-log");

  phase = "logout-immediate-clearing-and-revocation";
  await navigate(page, "history");
  const oldCookie = (await first.context.cookies()).map(cookie => cookie.name + "=" + cookie.value).join("; ");
  logGate = createResponseGate(); logoutGate = createResponseGate();
  try {
    await page.locator("#baseline-history summary").first().click(); await logGate.entered;
    await navigate(page, "account");
    const logoutResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/logout");
    await page.locator("#logout-button").click(); await logoutGate.entered;
    // The real authority has revoked the session, but neither the logout
    // response nor the earlier private log has been delivered to this page.
    await cleared(page); assert.equal((await first.context.cookies()).length, 2);
    const revoked = await harness.httpFetch(harness.origin + "/api/state", { headers: { Cookie: oldCookie } });
    assert.equal(revoked.status, 401); assert.deepEqual(await revoked.json(), { error: "UNAUTHENTICATED" });
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
  await both(second.page, "expired"); checks.push("browser-clock-absolute-expiry-clears-dom");
  assert.equal(externalRequests, 0); assert.equal(harness.outboundRequests(), 0); assert.equal(pageErrors, 0); assert.equal(bridgeErrors, 0); assert.equal(lifecycleRequests, 0);
  files.push({ name: "synthetic-hosted-evidence.json", bytes: Buffer.from(JSON.stringify({ syntheticOnly: true, commit: process.env.GITHUB_SHA,
    browser: await browser.version(), browserSandboxRequested: true, unsafeSandboxFlagsAbsent: true,
    sourceEvidence: harness.sourceEvidence, importDigests, targetChecks, pageScaleEvidence,
    visualTarget: {
      desktop: { sha256: "87822d71c7531c20e038955642279c79eba9cf9bb8bc1c48b7560cc25086d813", width: 1487, height: 1058 },
      mobile: { sha256: "828923f82f1337aca78ee2eabb79c969c5083d8876362995b2d9430c886f7617", sourceWidth: 853, sourceHeight: 1844, viewportWidth: 390, viewportHeight: 844 },
      state: "apps; 11 declared flavors; 1 source; 1 source-scoped baseline; Sample App 4 selected; detail closed; empty search; ascending app name; first page",
      approvedRefinement: "13–14px body, minimum 12px auxiliary text, 20–22px heading, denser rows and unknown deployment/error/revenue comparisons",
      referenceNormalization: "Mobile reference proportionally normalizes to 390×843; capture is 390×844. Density gate requires at least four complete mobile app rows above the fixed navigation.",
      pixelReview: "required after decoding; interaction assertions alone are not visual approval",
    },
    transport: "synthetic HTTPS interception via ordinary local HTTP into production Worker, SQLite DO and D1; real response cookies",
    unverified: ["workerd#7634 rejected-upload transport risk", "deployed upload rejection/retry recovery", "deployed DNS/TLS", "Cloudflare Free account/resource capacity", "deployed CPU/memory/latency", "wall-clock server expiry during browser run", "native pinch gesture", "OS text zoom", "browser toolbar zoom"],
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
