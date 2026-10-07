import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { bridgeRequest, SYNTHETIC_ORIGIN } from "../scripts/hosted-qa/transport.mjs";
import { createResponseGate } from "../scripts/hosted-qa/response-gate.mjs";

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
  assert.ok(!/upload-artifact|runs-on:.*self-hosted|secrets\.|sudo|sysctl|apparmor|pull_request_target|wrangler deploy/.test(workflow));
});

test("hosted capture requires sandbox and actual cookie/font proof without security bypasses", async () => {
  const capture = await readFile(new URL("../scripts/hosted-qa/capture.mjs", import.meta.url), "utf8");
  assert.match(capture, /chromiumSandbox: true/); assert.match(capture, /channel: "chrome"/);
  assert.match(capture, /Browser\.getBrowserCommandLine/); assert.match(capture, /CSS\.getPlatformFontsForNode/);
  assert.match(capture, /cookie\.secure/); assert.match(capture, /cookie\.httpOnly/); assert.match(capture, /cookie\.sameSite, "Strict"/);
  assert.match(capture, /bridgeRequest\(request, harness\.fetch\)/);
  assert.match(capture, /encodeEvidence\(files, process\.env\.GITHUB_SHA\)/);
  assert.ok(!/ignoreHTTPSErrors|bypassCSP|addCookies\(|console\.(?:log|error)\(error\)|args:\s*\[/.test(capture));
});

test("hosted composition requires real enrollment, preserves original import receipts and revokes sessions", async () => {
  const { createHostedQaHarness } = await import("../scripts/hosted-qa/runtime.mjs");
  const harness = await createHostedQaHarness();
  try {
    const call = (path: string, body?: Uint8Array | string, headers: Record<string, string> = {}) => harness.fetch(SYNTHETIC_ORIGIN + path, {
      method: body === undefined ? "GET" : "POST", headers: { ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: SYNTHETIC_ORIGIN }), ...headers },
      ...(body === undefined ? {} : { body }),
    });
    assert.equal((await call("/api/state")).status, 401);
    for (const path of ["/app.js", "/app.css"]) assert.equal((await call(path)).status, 401);
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
    assert.equal((await call("/api/auth/enroll", setup)).status, 403);
    const empty = await (await call("/api/state", undefined, auth)).json() as { selected: unknown; snapshots: { items: unknown[] } };
    assert.equal(empty.selected, null); assert.equal(empty.snapshots.items.length, 0);
    assert.equal((await call("/api/sources", harness.source(), { Cookie: auth.Cookie })).status, 403);
    const source = await call("/api/sources", harness.source(), auth); assert.equal(source.status, 201);
    const selected = await source.json() as import("@app-ops/dogfood").InventorySnapshot;
    const baselineBytes = await harness.baseline();
    const baseline = await call("/api/baselines?snapshotId=" + selected.id, baselineBytes, auth); assert.equal(baseline.status, 201);
    const receipt = await baseline.json() as { id: string; evidence: { evidenceDigest: string } };
    const duplicate = await call("/api/baselines?snapshotId=" + selected.id, baselineBytes, auth);
    assert.equal(duplicate.status, 201); assert.equal((await duplicate.json() as { id: string }).id, receipt.id);
    const state = await (await call("/api/state", undefined, auth)).json() as { selected: { id: string }; history: { items: { id: string; evidenceDigest: string }[] } };
    const { createHash } = await import("node:crypto");
    assert.equal(state.selected.id, selected.id); assert.equal(state.history.items.length, 1);
    assert.equal(state.history.items[0]!.evidenceDigest, createHash("sha256").update(baselineBytes).digest("hex"));
    const second = await call("/api/auth/login", JSON.stringify({ email: harness.email, password: harness.password })); assert.equal(second.status, 200);
    const secondCookie = second.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
    assert.notEqual(secondCookie, auth.Cookie);
    assert.equal((await (await call("/api/state", undefined, { Cookie: secondCookie })).json() as { selected: { id: string } }).selected.id, selected.id);
    assert.equal((await call("/api/auth/logout", "{}", auth)).status, 200);
    assert.equal((await call("/api/state", undefined, auth)).status, 401);
    assert.equal((await call("/api/state", undefined, { Cookie: secondCookie })).status, 200);
    assert.equal(harness.outboundRequests(), 0);
  } finally { await harness.close(); }
});
