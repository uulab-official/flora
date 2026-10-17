import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, X509Certificate, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createTestRuntime } from "./runtime.ts";
import { githubOTAFixture } from "../../../tests/github-ota-fixtures.ts";
import type { PublicSigningKey } from "../src/managed-signing.ts";

const origin = "https://flora.example.test", now = 1_800_000_000_000, email = "owner@example.test";
const manifestCode = "synthetic_manifest_code_12345678901234567890";
async function harness(t: TestContext) {
  const apps = new Map<string, string>(), fixture = githubOTAFixture(() => origin, apps);
  const token = randomBytes(32), password = randomBytes(24).toString("base64url"), webhookSecret = randomBytes(32).toString("hex");
  let conversions = 0, failure = false, conversionEntered: (() => void) | undefined, conversionGate: Promise<void> | undefined;
  let installationToken = "synthetic_installation_token", repositoryReads = 0; let accountType: unknown = "Organization";
  const outboundService = async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/app-manifests/")) {
      conversions++; conversionEntered?.(); await conversionGate;
      if (failure) return Response.json({ message: fixture.credentials.privateKey + webhookSecret }, { status: 502 });
      return Response.json({ id: Number(fixture.credentials.appId), slug: "flora-synthetic", pem: fixture.credentials.privateKey,
        webhook_secret: webhookSecret, client_secret: "SYNTHETIC_CLIENT_SECRET_UNUSED" }, { status: 201 });
    }
    if (url.pathname === "/app/installations") return Response.json([{ id: 42, account: { login: "synthetic", type: accountType }, repository_selection: "selected", suspended_at: null }]);
    if (url.pathname === "/app/installations/42/access_tokens") return Response.json({ token: installationToken, expires_at: new Date(now + 3_600_000).toISOString() }, { status: 201 });
    if (url.pathname === "/installation/repositories") { repositoryReads++; return Response.json({ repositories: [
      { id: 100, owner: { login: "synthetic" }, name: "expo-one", private: true, default_branch: "main" },
      { id: 101, owner: { login: "synthetic" }, name: "rn-two", private: true, default_branch: "develop" },
    ] }); }
    return fixture.respond(request);
  };
  const runtime = await createTestRuntime({ entrypoint: new URL("./fixtures/hosted-entry.ts", import.meta.url), durableObjects: { FLORA_AUTH: "HostedFixtureAuth" }, outboundService,
    bindings: { FLORA_ORIGIN: origin, FLORA_OWNER_ID: "synthetic-owner", FLORA_OWNER_EMAIL: email, FLORA_DB_IDENTITY: "synthetic-db",
      FLORA_SETUP: { digest: createHash("sha256").update(token).digest("hex"), issuedAt: now, expiresAt: now + 600_000, generation: 1, purpose: "enroll" } } });
  t.after(() => runtime.dispose());
  const names = ["0001_private_imports.sql", "0002_multi_app.sql", "0003_github_ota.sql", "0004_automation.sql"];
  const migrations = (await Promise.all(names.map(name => readFile(new URL("../migrations/" + name, import.meta.url), "utf8")))).join("\n");
  await runtime.d1.exec(migrations.replace(/^--.*$/gm, "").split(/;\s*(?=CREATE|INSERT|PRAGMA|$)/).filter(s => s.trim()).map(s => s.replace(/\s*\n\s*/g, " ").trim() + ";").join("\n"));
  await runtime.d1.prepare("INSERT INTO flora_deployment VALUES(1,?,?,?)").bind("synthetic-owner", origin, "synthetic-db").run();
  const result = await runtime.fetch(origin + "/api/auth/enroll", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ email, password, confirmation: password, token: token.toString("base64url") }) });
  assert.equal(result.status, 200);
  const headers = { Cookie: result.headers.getSetCookie().map(value => value.split(";")[0]).join("; "), Origin: origin, "X-Flora-CSRF": (await result.json() as { csrfToken: string }).csrfToken, "Content-Type": "application/json" };
  const call = (path: string, data?: unknown, overrides: Record<string, string> = {}) => runtime.fetch(origin + path, { method: data === undefined ? "GET" : "POST", headers: { ...headers, ...overrides }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const start = async () => {
    const response = await call("/api/github/manifest/start", {}); assert.equal(response.status, 200);
    const value = await response.json() as { action: string; expiresAt: number; manifest: Record<string, unknown> };
    return { ...value, state: new URL(value.action).searchParams.get("state")! };
  };
  return { runtime, apps, call, start, headers, password, webhookSecret, fixture, conversions: () => conversions,
    useAccountType(value: unknown) { accountType = value; }, useToken(value: string) { installationToken = value; }, repositoryReads: () => repositoryReads,
    fail() { failure = true; }, hold() { let enter!: () => void, release!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; }); conversionGate = new Promise<void>(resolve => { release = resolve; }); conversionEntered = enter; return { entered, release }; } };
}

test("managed GitHub manifest stores credentials privately and reuses them for repository detection", async t => {
  const h = await harness(t), start = await h.start();
  assert.equal(start.expiresAt, now + 600_000);
  assert.deepEqual(start.manifest.default_permissions, { contents: "read", metadata: "read" });
  assert.deepEqual(start.manifest.default_events, ["push"]);
  assert.deepEqual(start.manifest.hook_attributes, { url: origin + "/api/github/webhook", active: true });
  assert.equal(start.manifest.redirect_url, origin + "/github/app/callback");
  assert.equal(start.manifest.public, false);
  const callback = await h.call(`/github/app/callback?code=${manifestCode}&state=${start.state}`, undefined, { Cookie: "" });
  assert.equal(callback.status, 200); const html = await callback.text();
  assert.match(html, /href="\/#github-app-code=/); assert.doesNotMatch(html, /<script|PRIVATE KEY|SYNTHETIC_CLIENT_SECRET/);
  assert.match(html, /<body class="github-callback-page">/);
  assert.match(html, /<main class="auth-shell">/);
  assert.match(html, /class="auth-card github-callback-card" aria-labelledby="auth-title"/);
  assert.match(html, /GitHub 연결을 거의 마쳤어요/);
  assert.match(html, /GitHub 등록 완료/); assert.match(html, /Flora 연결 대기/);
  assert.match(html, /src="\/brand\.png"/); assert.match(html, /href="\/icons\.svg#icon-source"/);
  const link = /<a class="github-callback-cta" href="([^"]+)">Flora에서 연결 완료/.exec(html);
  assert.equal(link?.[1], "/#github-app-code=" + manifestCode + "&amp;github-app-state=" + start.state);
  const visibleText = html.replace(/<[^>]*>/g, "");
  assert.ok(!visibleText.includes(manifestCode)); assert.ok(!visibleText.includes(start.state));
  assert.equal(h.conversions(), 0, "public callback cannot exchange credentials or write private state");
  const completed = await h.call("/api/github/manifest/complete", { code: manifestCode, state: start.state });
  assert.equal(completed.status, 200); const status = await completed.json();
  assert.deepEqual(status, { configured: true, source: "managed", appId: "12345", appSlug: "flora-synthetic", installationUrl: "https://github.com/apps/flora-synthetic/installations/new" });
  assert.equal((await h.call("/api/github/manifest/complete", { code: manifestCode, state: start.state })).status, 403);
  assert.equal(h.conversions(), 1);
  assert.equal((await h.call("/api/github/manifest/start", {})).status, 409, "connected app must never be overwritten");
  const ping = JSON.stringify({ zen: "synthetic managed hook" });
  const hook = (signature: string) => h.runtime.fetch(origin + "/api/github/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-GitHub-Event": "ping", "X-GitHub-Delivery": "9d7d3f49-1454-47b4-9c42-9bc9ac2738db", "X-Hub-Signature-256": signature }, body: ping });
  assert.equal((await hook("sha256=" + createHmac("sha256", h.webhookSecret).update(ping).digest("hex"))).status, 202);
  assert.equal((await hook("sha256=" + "0".repeat(64))).status, 403);
  assert.deepEqual(await (await h.call("/api/github/installations")).json(), { items: [{ id: 42, account: "synthetic", accountType: "Organization", repositorySelection: "selected", suspended: false }], truncated: false });
  for (const type of ["User", "unknown", "https://attacker.invalid", undefined]) {
    h.useAccountType(type);
    const installations = await (await h.call("/api/github/installations")).json() as {items: {accountType: string | null}[]};
    assert.equal(installations.items[0]?.accountType, type === "User" ? "User" : null);
  }
  assert.deepEqual(await (await h.call("/api/github/repositories?installationId=42")).json(), { installationId: 42, items: [
    { id: 100, owner: "synthetic", repository: "expo-one", private: true, defaultBranch: "main" },
    { id: 101, owner: "synthetic", repository: "rn-two", private: true, defaultBranch: "develop" },
  ], nextCursor: null });
  const created = await h.call("/api/apps", { name: "managed-rn", repositoryId: "synthetic/rn-two", rootDirectory: "." });
  const appId = (await created.json() as { id: string }).id; h.apps.set("rn-two", appId);
  const connected = await h.call(`/api/apps/${appId}/github`, { expectedVersion: 0, installationId: 42, owner: "synthetic", repository: "rn-two", ref: "main" });
  assert.equal(connected.status, 201); const operations = await connected.json() as { detections: { framework: string }[] }; assert.equal(operations.detections[0]!.framework, "react-native");
  await h.call("/__test/control", { restart: true });
  assert.deepEqual(await (await h.call("/api/github/connection")).json(), status);
  for (const path of ["/api/github/connection", "/api/github/installations", "/api/github/repositories?installationId=42", `/api/state?appId=${appId}`]) {
    const response = await h.call(path); assert.equal(response.status, 200);
    const text = await response.text(); assert.doesNotMatch(text, /PRIVATE KEY|webhook_secret|private_key|client_secret|SYNTHETIC_CLIENT_SECRET/); assert.ok(!text.includes(h.webhookSecret));
  }
  const tables = (await h.runtime.d1.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{ name: string }>()).results;
  assert.ok(tables.every(row => !/managed_github|managed_signing|manifest_state/.test(row.name)), "credential tables cannot enter D1 application storage");
});

test("managed repository discovery accepts stateless JWT tokens without exposing or weakening token admission", async t => {
  const h = await harness(t), start = await h.start();
  assert.equal((await h.call("/api/github/manifest/complete", { code: manifestCode, state: start.state })).status, 200);
  const stateless = "ghs_5283312_eyJhbGciOiJSUzI1NiJ9." + "syntheticpayload".repeat(60) + "." + "syntheticsignature".repeat(20);
  assert.ok(stateless.length > 512 && stateless.length < 4096);
  for (const token of ["ghs_legacy1234567890", stateless, "a".repeat(4096)]) {
    h.useToken(token); const response = await h.call("/api/github/repositories?installationId=42"); assert.equal(response.status, 200);
    const body = await response.text(); assert.equal(JSON.parse(body).items.length, 2); assert.ok(!body.includes(token));
  }
  const reads = h.repositoryReads();
  for (const token of ["", "ghs unsafe", "ghs\r\nX-Injected: yes", "ghs\tunsafe", "a".repeat(4097)]) {
    h.useToken(token); const response = await h.call("/api/github/repositories?installationId=42"); assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "GITHUB_UNAVAILABLE" }); assert.equal(h.repositoryReads(), reads, "invalid tokens cannot reach a downstream bearer request");
  }
});

test("manifest authorization requires session CSRF state ownership expiry and one-time exchange", async t => {
  const h = await harness(t);
  for (const path of ["/api/github/connection", "/api/github/installations", "/api/github/repositories?installationId=42"]) assert.equal((await h.call(path, undefined, { Cookie: "" })).status, 401);
  assert.equal((await h.call("/api/github/manifest/start", {}, { "X-Flora-CSRF": "" })).status, 403);
  assert.equal((await h.call("/api/github/manifest/start", { organization: "../other" })).status, 400);
  const first = await h.start(), second = await h.start();
  assert.notEqual(first.state, second.state);
  assert.equal((await h.call("/api/github/manifest/complete", { code: manifestCode, state: first.state })).status, 403, "new start cancels older state for same session");
  const login = await h.call("/api/auth/login", { email, password: h.password }); assert.equal(login.status, 200);
  const other = { Cookie: login.headers.getSetCookie().map(value => value.split(";")[0]).join("; "), "X-Flora-CSRF": (await login.json() as { csrfToken: string }).csrfToken };
  assert.equal((await h.call("/api/github/manifest/complete", { code: manifestCode, state: second.state }, other)).status, 403);
  assert.equal(h.conversions(), 0);
  await h.call("/__test/control", { now: now + 600_000 });
  assert.equal((await h.call("/api/github/manifest/complete", { code: manifestCode, state: second.state })).status, 403);
  assert.equal(h.conversions(), 0);
  for (const path of ["/github/app/callback?code=x&state=x", `/github/app/callback?code=${manifestCode}&state=${second.state}&state=x`, "/api/github/repositories?installationId=0", "/api/github/repositories?installationId=42&cursor=1001"]) assert.equal((await h.call(path)).status, 400);
});

test("logout while GitHub conversion is pending prevents credential commit", async t => {
  const h = await harness(t), start = await h.start(), gate = h.hold();
  const pending = h.call("/api/github/manifest/complete", { code: manifestCode, state: start.state });
  await gate.entered;
  assert.equal((await h.call("/api/auth/logout", {})).status, 200);
  gate.release(); assert.equal((await pending).status, 401);
  const record = await (await h.call("/__test/control", { sql: "SELECT app_id FROM flora_managed_github" })).json();
  assert.deepEqual(record, []);
  assert.equal(h.conversions(), 1);
});

test("conversion errors consume state without disclosing provider secrets", async t => {
  const h = await harness(t), start = await h.start(); h.fail();
  const response = await h.call("/api/github/manifest/complete", { code: manifestCode, state: start.state });
  assert.equal(response.status, 502); assert.deepEqual(await response.json(), { error: "GITHUB_UNAVAILABLE" });
  assert.equal((await h.call("/api/github/manifest/complete", { code: manifestCode, state: start.state })).status, 403);
  assert.equal(h.conversions(), 1);
  assert.equal((await h.call("/api/github/connection")).status, 200);
  assert.equal((await (await h.call("/api/github/connection")).json() as { configured: boolean }).configured, false);
});

test("server-generated app-specific X509 keys preserve settings and sign isolated OTA manifests", async t => {
  const h = await harness(t), start = await h.start();
  assert.equal((await h.call("/api/github/manifest/complete", { code: manifestCode, state: start.state })).status, 200);
  const values: { appId: string; trust: PublicSigningKey; deploymentId: string; assetDigest: string }[] = [];
  assert.equal((await h.call("/api/apps/app_missing/signing-key", {})).status, 404);
  for (const [index, repository] of ["expo-one", "rn-two"].entries()) {
    const created = await h.call("/api/apps", { name: repository, repositoryId: "synthetic/" + repository, rootDirectory: "." });
    const appId = (await created.json() as { id: string }).id; h.apps.set(repository, appId);
    const settings = { expectedVersion: 0, values: { PRESERVE_MARKER: "old-data-" + index } };
    assert.equal((await h.call(`/api/apps/${appId}/settings`, settings)).status, 200);
    assert.equal((await h.call(`/api/apps/${appId}/signing-key`, {}, { "X-Flora-CSRF": "" })).status, 403);
    const key = await h.call(`/api/apps/${appId}/signing-key`, {}); assert.equal(key.status, 201);
    const trust = await key.json() as PublicSigningKey; assert.deepEqual(Object.keys(trust).sort(), ["appId", "certificate", "createdAt", "keyId"]);
    assert.equal(trust.appId, appId); assert.equal(trust.createdAt, now); assert.doesNotMatch(JSON.stringify(trust), /PRIVATE KEY|privateKey/);
    const certificate = new X509Certificate(trust.certificate);
    assert.equal(certificate.publicKey.asymmetricKeyType, "rsa"); assert.equal(certificate.publicKey.asymmetricKeyDetails?.modulusLength, 2048);
    assert.equal(certificate.ca, false); assert.equal(certificate.subject, "CN=Flora OTA " + appId);
    assert.ok(certificate.verify(certificate.publicKey), "DER certificate must carry a valid self-signature");
    assert.ok(Date.parse(certificate.validFrom) <= now && Date.parse(certificate.validTo) > now);
    const repeated = await h.call(`/api/apps/${appId}/signing-key`, {}); assert.equal(repeated.status, 200); assert.deepEqual(await repeated.json(), trust);
    const connected = await h.call(`/api/apps/${appId}/github`, { expectedVersion: 0, installationId: 42, owner: "synthetic", repository, ref: "main" }); assert.equal(connected.status, 201);
    const detection = (await connected.json() as { detections: { id: string; commitSha: string }[] }).detections[0]!;
    const bytes = new TextEncoder().encode("globalThis.floraManaged=" + index + ";");
    const upload = await h.runtime.fetch(origin + `/api/apps/${appId}/ota/assets?key=launch&contentType=application%2Fjavascript&fileExtension=.js`, { method: "POST", headers: { ...h.headers, "Content-Type": "application/octet-stream" }, body: bytes }); assert.equal(upload.status, 201);
    const launch = await upload.json() as { id: string; digest: string };
    const deployed = await h.call(`/api/apps/${appId}/ota/deployments`, { requestKey: "managed_same_key", detectionId: detection.id, commitSha: detection.commitSha, channel: "preview", runtimeVersion: "runtime-1", platform: "android", launchAssetId: launch.id, assetIds: [] }); assert.equal(deployed.status, 201);
    values.push({ appId, trust, deploymentId: (await deployed.json() as { id: string }).id, assetDigest: launch.digest });
  }
  assert.notEqual(values[0]!.trust.keyId, values[1]!.trust.keyId); assert.notEqual(values[0]!.trust.certificate, values[1]!.trust.certificate);
  await h.call("/__test/control", { restart: true });
  for (const [index, value] of values.entries()) {
    assert.deepEqual(await (await h.call(`/api/apps/${value.appId}/signing-key`, {})).json(), value.trust);
    const state = await (await h.call(`/api/state?appId=${value.appId}`)).json() as { selectedApplication: { settings: { values: Record<string, string> } } };
    assert.deepEqual(state.selectedApplication.settings.values, { PRESERVE_MARKER: "old-data-" + index });
    const history = await (await h.call(`/api/apps/${value.appId}/operations`)).json() as { deployments: { id: string }[] };
    assert.deepEqual(history.deployments.map(item => item.id), [value.deploymentId]);
    const headers = { "expo-platform": "android", "expo-runtime-version": "runtime-1", Accept: "application/expo+json", "expo-expect-signature": `sig, keyid="${value.trust.keyId}", alg="rsa-v1_5-sha256"` };
    const update = await h.runtime.fetch(origin + `/updates/${value.appId}?channel=preview`, { headers }); assert.equal(update.status, 200);
    const body = await update.text(), signature = Buffer.from(/sig="([A-Za-z0-9+/=]+)"/.exec(update.headers.get("expo-signature")!)![1]!, "base64");
    assert.equal(JSON.parse(body).id, value.deploymentId);
    assert.ok(verify("sha256", Buffer.from(body), new X509Certificate(value.trust.certificate).publicKey, signature));
    assert.equal(verify("sha256", Buffer.from(body), new X509Certificate(values[1 - index]!.trust.certificate).publicKey, signature), false, "another app cannot authenticate this manifest");
    assert.equal((await h.runtime.fetch(origin + `/updates/${value.appId}/assets/${values[1 - index]!.assetDigest}`)).status, 404);
    const mismatch = await h.runtime.fetch(origin + `/updates/${value.appId}?channel=preview`, { headers: { ...headers, "expo-expect-signature": `sig, keyid="${values[1 - index]!.trust.keyId}"` } }); assert.equal(mismatch.status, 503);
  }
});
