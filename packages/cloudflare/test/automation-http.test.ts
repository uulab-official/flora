import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { automationArtifactPayload, automationDigest } from "@app-ops/dogfood";
import type { AutomationClaim, AutomationJob, AutomationExportReceipt, OTAAsset, RunnerEnrollment } from "@app-ops/dogfood";
import { createTestRuntime } from "./runtime.ts";
import { githubOTAFixture } from "../../../tests/github-ota-fixtures.ts";

const origin = "https://flora.example.test", start = 1_800_000_000_000;
async function harness(t: TestContext, incrementalAccounting = false) {
  // Generate a test-only copy so production adapters and shared fixtures stay
  // unchanged. Count actual SQL statements at the native D1 submission boundary.
  const directory = await mkdtemp(join(tmpdir(), "flora-automation-http-")); t.after(() => rm(directory, { recursive: true, force: true }));
  let source = await readFile(new URL("./fixtures/hosted-entry.ts", import.meta.url), "utf8");
  source = source.replace('from "../../dist/worker.js"', "from " + JSON.stringify(fileURLToPath(new URL("../dist/worker.js", import.meta.url))));
  assert.ok(source.includes("private writes = 0;")); source = source.replace("private writes = 0;", "private writes = 0; private queries = 0; private rowsRead = 0; private rowsWritten = 0;");
  source = source.replace("private queries = 0;", "private queries = 0; private runnerHeld: { release: () => void; abort: () => void; response: Promise<Response> } | null = null;");
  source = source.replace("return async (...args: unknown[]) => {\n        if (this.failD1)", "return async (...args: unknown[]) => {\n        if ([\"first\", \"all\", \"raw\", \"run\"].includes(String(key))) this.queries++;\n        if (this.failD1)");
  source = source.replace("this.writes++;", "this.writes++; this.queries += statements.length;");
  source = source.replace("const result = await member.apply(target, args);", `const counted = key === "first" ? await target.all() : await member.apply(target, args);
        this.rowsRead += counted?.meta?.rows_read ?? 0; this.rowsWritten += counted?.meta?.rows_written ?? 0;
        const result = key === "first" ? args[0] === undefined ? counted.results[0] ?? null : counted.results[0]?.[String(args[0])] ?? null : counted;`);
  source = source.replace("const result = await pending;", "const result = await pending; for (const row of result) { this.rowsRead += row.meta.rows_read ?? 0; this.rowsWritten += row.meta.rows_written ?? 0; }");

  source = source.replace("const data = await request.json() as {", "const data = await request.json() as { queryStats?: boolean; resetQueries?: boolean;");
  source = source.replace("if (data.probeConsole)", "if (data.queryStats) return Response.json({ queries: this.queries }); if (data.resetQueries) this.queries = 0;\n      if (data.probeConsole)");
  assert.equal(source.split("return this.authority.fetch(request);").length, 2);
  source = source.replace("return this.authority.fetch(request);", "const queryStart = this.queries, readStart = this.rowsRead, writeStart = this.rowsWritten; const response = await this.authority.fetch(request); response.headers.set('X-Flora-Test-D1-Queries', String(this.queries - queryStart)); response.headers.set('X-Flora-Test-D1-Rows-Read', String(this.rowsRead - readStart)); response.headers.set('X-Flora-Test-D1-Rows-Written', String(this.rowsWritten - writeStart)); return response;");
  const probe = `if (path === "/__test/runner-held") {
    const input = await request.json() as { authorization?: string; lease?: string; presence?: boolean; action: "hold" | "abort" | "release" };
    if (input.action !== "hold") {
      if (!this.runnerHeld) return new Response("missing", { status: 404 });
      const held = this.runnerHeld; this.runnerHeld = null;
      if (input.action === "abort") held.abort(); else held.release();
      const result = await held.response; return Response.json({ status: result.status, body: await result.json() });
    }
    if (this.runnerHeld) return new Response("held", { status: 409 });
    let started!: () => void, release!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({ async pull(c) { started(); await gate; if (!controller.signal.aborted) { c.enqueue(new TextEncoder().encode(input.presence ? "{}" : "held launch")); c.close(); } } }, { highWaterMark: 0 });
    const headers = new Headers({ "Content-Type": input.presence ? "application/json" : "application/octet-stream", "Authorization": input.authorization! });
    if (input.lease) headers.set("X-Flora-Runner-Lease", input.lease);
    const path = input.presence ? "/api/runner/presence" : "/api/runner/assets?key=held_launch&contentType=application%2Fjavascript&fileExtension=.js";
    const response = this.authority.fetch(new Request(this.fixtureEnv.FLORA_ORIGIN + path, { method: "POST", headers, body, signal: controller.signal }));
    this.runnerHeld = { release, abort: () => { controller.abort(); release(); }, response }; this.ctx.waitUntil(response.then(() => {}));
    const rejected = await Promise.race([began.then(() => null), response]);
    if (rejected) { this.runnerHeld = null; return Response.json({ status: rejected.status, body: await rejected.json() }); }
    return Response.json({ held: true });
  }
  if (path === "/__test/runner-unread") {
    const input = await request.json() as { authorization?: string; lease?: string; presence?: boolean };
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { reads++; c.error(new Error("Unexpected unauthenticated upload read")); } }, { highWaterMark: 0 });
    const headers = new Headers({ "Content-Type": input.presence ? "application/json" : "application/octet-stream" });
    if (input.authorization) headers.set("Authorization", input.authorization);
    if (input.lease) headers.set("X-Flora-Runner-Lease", input.lease);
    const path = input.presence ? "/api/runner/presence" : "/api/runner/assets?key=launch&contentType=application%2Fjavascript&fileExtension=.js";
    const result = await this.authority.fetch(new Request(this.fixtureEnv.FLORA_ORIGIN + path, { method: "POST", headers, body }));
    return Response.json({ status: result.status, reads, body: await result.json() });
  }`;
  source = source.replace('const path = new URL(request.url).pathname;', 'const path = new URL(request.url).pathname;\n    ' + probe);
  const entrypoint = join(directory, "entry.ts"); await writeFile(entrypoint, source);
  const appIds = new Map<string, string>(), shas = new Map<string, string>(), knownShas = new Map<string, Set<string>>(), fixture = githubOTAFixture(() => origin, new Map());
  let sourceGate: { repo: string; sha: string; begin: () => void; gate: Promise<void> } | null = null;
  let requests = 0;
  const outbound = async (request: Request) => {
    requests++; const url = new URL(request.url); assert.equal(url.origin, "https://api.github.com");
    assert.ok(request.headers.get("Authorization")?.startsWith("Bearer "));
    if (url.pathname === "/app/installations/42/access_tokens") return Response.json({ token: "synthetic_scoped_source_token", expires_at: new Date(start + 3_600_000).toISOString() }, { status: 201 });
    const match = /^\/repos\/synthetic\/([^/]+)\/(commits|contents)(?:\/(.*))?$/i.exec(url.pathname); assert.ok(match, "Fixed synthetic GitHub REST path");
    const repo = match[1]!, sha = shas.get(repo) ?? "a".repeat(40); if (match[2] === "commits") return Response.json({ sha: /^[a-f0-9]{40}$/.test(match[3] ?? "") ? match[3] : sha });
    assert.ok(knownShas.get(repo)?.has(url.searchParams.get("ref")!), "All content reads use an existing pinned SHA");
    const path = match[3] ?? "", isFile = path.endsWith("package.json") || path.endsWith("flora.config.json"), slash = path.lastIndexOf("/");
    if (path.endsWith("package.json") && sourceGate?.repo === repo && sourceGate.sha === url.searchParams.get("ref")) { const held = sourceGate; sourceGate = null; held.begin(); await held.gate; }
    const root = isFile ? slash < 0 ? "." : path.slice(0, slash) : path || ".";
    if (!isFile) return Response.json(["package.json", "flora.config.json"].map(name => ({ name, type: "file" })));
    const appId = appIds.get(repo + "|" + root); assert.ok(appId);
    const data = path.endsWith("package.json") ? { dependencies: { "@flora/ota": "workspace:*", "react-native": "0.85.0", metro: "0.84.0" } } : { schemaVersion: 1, ota: { runtimeVersion: "flora-native-1", platforms: ["ios", "android"], url: origin + "/updates/" + appId }, export: { bundler: "metro", entryFile: "index.js", nodeVersion: "24.19.0", packageManager: { name: "npm", version: "11.9.0" } } };
    const bytes = Buffer.from(JSON.stringify(data)); return Response.json({ type: "file", encoding: "base64", size: bytes.length, content: bytes.toString("base64") });
  };
  const token = randomBytes(32), password = randomBytes(24).toString("base64url"), secret = randomBytes(32).toString("hex");
  const runtime = await createTestRuntime({ entrypoint, durableObjects: { FLORA_AUTH: "HostedFixtureAuth" }, outboundService: outbound, bindings: {
    FLORA_ORIGIN: origin, FLORA_OWNER_ID: "synthetic-owner", FLORA_OWNER_EMAIL: "owner@example.test", FLORA_DB_IDENTITY: "synthetic-db", FLORA_GITHUB_APP_ID: fixture.credentials.appId, FLORA_GITHUB_PRIVATE_KEY: fixture.credentials.privateKey, FLORA_GITHUB_WEBHOOK_SECRET: secret,
    FLORA_SETUP: { digest: createHash("sha256").update(token).digest("hex"), issuedAt: start, expiresAt: start + 600_000, generation: 1, purpose: "enroll" },
  } }); t.after(() => runtime.dispose());
  for (const name of ["0001_private_imports.sql", "0002_multi_app.sql", "0003_github_ota.sql", "0004_automation.sql"]) {
    const sql = await readFile(new URL("../migrations/" + name, import.meta.url), "utf8");
    await runtime.d1.exec(sql.replace(/^--.*$/gm, "").split(/;\s*(?=CREATE|INSERT|DROP|PRAGMA|$)/).filter(s => s.trim()).map(s => s.replace(/\s*\n\s*/g, " ").trim() + ";").join("\n"));
  }
  if (incrementalAccounting) for (const name of ["0005_workspace_capacity_192mib.sql", "0006_workspace_capacity_256mib.sql", "0007_incremental_capacity_accounting.sql"]) {
    const sql = await readFile(new URL("../migrations/" + name, import.meta.url), "utf8");
    // Trigger bodies contain more than one UPDATE. Preserve each complete
    // CREATE TRIGGER, then install the complete migration as one D1 transaction.
    const statements = Array.from(sql.replace(/^--.*$/gm, "").matchAll(/\s*(CREATE TRIGGER\b[\s\S]*?\bEND\s*;|[^;]+;)/g), match => match[1]!.trim());
    await runtime.d1.batch(statements.map(statement => runtime.d1.prepare(statement)));
  }
  await runtime.d1.prepare("INSERT INTO flora_deployment(singleton,owner_id,origin,db_identity) VALUES(1,?,?,?)").bind("synthetic-owner", origin, "synthetic-db").run();
  const enrolled = await runtime.fetch(origin + "/api/auth/enroll", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@example.test", password, confirmation: password, token: token.toString("base64url") }) }); assert.equal(enrolled.status, 200);
  const ownerHeaders = { Cookie: enrolled.headers.getSetCookie().map(value => value.split(";")[0]).join("; "), Origin: origin, "Content-Type": "application/json", "X-Flora-CSRF": (await enrolled.json() as { csrfToken: string }).csrfToken };
  const post = (path: string, data: unknown) => runtime.fetch(origin + path, { method: "POST", headers: ownerHeaders, body: JSON.stringify(data) });
  const get = (path: string) => runtime.fetch(origin + path, { headers: ownerHeaders });
  const control = (data: unknown) => post("/__test/control", data);
  async function app(repo: string, root = ".") {
    const sha = (repo === "sdk-two" ? "b" : "a").repeat(40); shas.set(repo, sha); knownShas.set(repo, new Set([sha]));
    const response = await post("/api/apps", { name: repo + root, repositoryId: "github:synthetic/" + repo, rootDirectory: root }); assert.equal(response.status, 201);
    const appId = (await response.json() as { id: string }).id; appIds.set(repo + "|" + root, appId);
    const connected = await post(`/api/apps/${appId}/github`, { expectedVersion: 0, installationId: 42, owner: "Synthetic", repository: repo, ref: "main" }); assert.equal(connected.status, 201, await connected.clone().text());
    const state = await connected.json() as { detections: import("@app-ops/dogfood").GitHubDetection[] }; assert.equal(state.detections[0]!.configSource, "flora.config.json"); assert.equal(state.detections[0]!.expoVersion, null); assert.equal(state.detections[0]!.updatesEnabled, true);
    return { appId, repo, detection: state.detections[0]! };
  }
  const hook = (repo: string, deliveryId: string, after = shas.get(repo)) => {
    const body = JSON.stringify({ ref: "refs/heads/main", after, deleted: false, installation: { id: 42 }, repository: { name: repo, owner: { login: "synthetic" } } });
    return runtime.fetch(origin + "/api/github/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-GitHub-Event": "push", "X-GitHub-Delivery": deliveryId, "X-Hub-Signature-256": "sha256=" + createHmac("sha256", secret).update(body).digest("hex") }, body });
  };
  const machine = (credential: string, path: string, data: unknown) => runtime.fetch(origin + "/api/runner/" + path, { method: "POST", headers: { Authorization: "Bearer " + credential, "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const upload = (credential: string, lease: import("@app-ops/dogfood").AutomationLease, bytes: Uint8Array, key = "launch") => runtime.fetch(origin + `/api/runner/assets?key=${key}&contentType=application%2Fjavascript&fileExtension=.js`, { method: "POST", headers: { Authorization: "Bearer " + credential, "Content-Type": "application/octet-stream", "X-Flora-Runner-Lease": Buffer.from(JSON.stringify(lease)).toString("base64url") }, body: bytes });
  const queryCount = async () => (await (await control({ queryStats: true })).json() as { queries: number }).queries;
  function setHead(repo: string, sha: string) { shas.set(repo, sha); knownShas.get(repo)!.add(sha); }
  function holdSource(repo: string, sha: string) { let begin!: () => void, release!: () => void; const began = new Promise<void>(resolve => { begin = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }); sourceGate = { repo, sha, begin, gate }; return { began, release }; }
  return { runtime, post, get, control, app, hook, machine, upload, queryCount, requests: () => requests, setHead, holdSource };
}

test("authenticated PC Runner presence is persistent, coalesced, app scoped and independent of a job lease", async t => {
  const h = await harness(t), one = await h.app("presence-one"), two = await h.app("presence-two");
  const enroll = async (appId: string) => (await h.post("/api/runners", { name: "PC Runner", appIds: [appId] })).json() as Promise<RunnerEnrollment>;
  const first = await enroll(one.appId), second = await enroll(two.appId);
  type State = { jobs: AutomationJob[]; runners: Array<RunnerEnrollment["runner"] & { presence: { lastSeenAt: number | null; status: string } }> };
  const state = async (appId: string) => (await h.get(`/api/apps/${appId}/automation`)).json() as Promise<State>;
  assert.deepEqual((await state(one.appId)).runners[0]!.presence, { lastSeenAt: null, status: "never_seen" });
  const before = await state(one.appId);
  const result = await h.machine(first.token, "presence", {}); assert.equal(result.status, 200, await result.clone().text());
  assert.deepEqual(await result.json(), { runnerId: first.runner.id, lastSeenAt: start });
  assert.deepEqual((await state(one.appId)).runners[0]!.presence, { lastSeenAt: start, status: "online" });
  assert.deepEqual((await state(two.appId)).runners[0]!.presence, { lastSeenAt: null, status: "never_seen" });
  await h.control({ now: start + 59_999, restart: true });
  assert.deepEqual(await (await h.machine(first.token, "presence", {})).json(), { runnerId: first.runner.id, lastSeenAt: start }, "Restart retains the write throttle");
  await h.control({ now: start + 60_000 });
  assert.deepEqual(await (await h.machine(first.token, "presence", {})).json(), { runnerId: first.runner.id, lastSeenAt: start + 60_000 });
  await h.control({ now: start + 180_001, restart: true });
  const after = await state(one.appId); assert.deepEqual(after.runners[0]!.presence, { lastSeenAt: start + 60_000, status: "offline" });
  assert.deepEqual(after.jobs, before.jobs, "Presence cannot append or change deployment history");
  assert.doesNotMatch(JSON.stringify(after), /tokenHash|synthetic_scoped_source_token/); assert.ok(!JSON.stringify(after).includes(first.token));
  assert.equal((await h.machine(second.token, "presence", {})).status, 200);
  assert.deepEqual((await state(two.appId)).runners[0]!.presence, { lastSeenAt: start + 180_001, status: "online" });
});
for (const incrementalAccounting of [false, true]) test("complete Runner endpoints retain authority and bounded idle reads after realistic immutable build history" + (incrementalAccounting ? " with incremental accounting" : ""), async t => {
  const h = await harness(t, incrementalAccounting), apps = [await h.app("budget-builds"), await h.app("budget-other"), await h.app("budget-empty")];
  const credentials: RunnerEnrollment[] = [];
  for (const app of apps) credentials.push(await (await h.post("/api/runners", { name: "Budget PC", appIds: [app.appId] })).json() as RunnerEnrollment);
  const app = apps[0]!, credential = credentials[0]!;
  assert.equal((await h.post(`/api/apps/${app.appId}/automation/policy`, { expectedVersion: 0, enabled: true, channel: "preview", platform: "android" })).status, 200);
  const profile: Record<string, { rowsRead: number; rowsWritten: number; queries: number }> = {};
  const measure = async (label: string, call: () => Promise<Awaited<ReturnType<typeof h.machine>>>, status: number) => {
    const response = await call(); assert.equal(response.status, status, await response.clone().text());
    profile[label] = { rowsRead: Number(response.headers.get("X-Flora-Test-D1-Rows-Read")), rowsWritten: Number(response.headers.get("X-Flora-Test-D1-Rows-Written")), queries: Number(response.headers.get("X-Flora-Test-D1-Queries")) };
    return response;
  };
  let clock = start;
  const queue = async (index: number) => { const response = await h.hook(app.repo, "budget-delivery-" + index); assert.equal(response.status, 202); return (await response.json() as { jobs: AutomationJob[] }).jobs[0]!; };
  // Six completed native-compatible OTA builds retain twelve heartbeat facts
  // each, plus actual chunk, receipt, deployment and publication records.
  for (let index = 0; index < 6; index++) {
    await queue(index); const claimed = await h.machine(credential.token, "claim", {}); assert.equal(claimed.status, 201); const claim = await claimed.json() as AutomationClaim;
    for (let beat = 0; beat < 12; beat++) { await h.control({ now: ++clock }); assert.equal((await h.machine(credential.token, "heartbeat", { lease: claim.lease })).status, 200); }
    const uploaded = await h.upload(credential.token, claim.lease, new Uint8Array(1024 * 1024).fill(index + 1), "launch"); assert.equal(uploaded.status, 201); const asset = await uploaded.json() as OTAAsset;
    const core = { jobId: claim.job.id, attemptId: claim.lease.attemptId, commitSha: claim.job.commitSha, configDigest: claim.job.configDigest, toolchainDigest: claim.job.toolchainDigest, sourceArchiveDigest: "c".repeat(64), launchAssetId: asset.id, assetIds: [] };
    const receipt = { ...core, artifactDigest: await automationDigest(automationArtifactPayload(core, [asset])) };
    assert.equal((await h.machine(credential.token, "finalize", { lease: claim.lease, receipt })).status, 200); await h.control({ now: ++clock });
  }
  const oldCount = await h.runtime.d1.prepare("SELECT count(*) AS n FROM automation_transitions").first<{ n: number }>(); assert.equal(oldCount!.n, 90);
  for (const [index, selected] of credentials.entries()) {
    await measure("idleClaim" + index, () => h.machine(selected.token, "claim", {}), 204);
    await measure("presence" + index, () => h.machine(selected.token, "presence", {}), 200);
  }
  await queue(6); const claimed = await measure("buildClaim", () => h.machine(credential.token, "claim", {}), 201); const claim = await claimed.json() as AutomationClaim;
  await h.control({ now: ++clock }); await measure("heartbeat", () => h.machine(credential.token, "heartbeat", { lease: claim.lease }), 200);
  await measure("oneMiBAsset", () => h.upload(credential.token, claim.lease, new Uint8Array(1024 * 1024).fill(99)), 201);
  if (incrementalAccounting) {
    for (let beat = 0; beat < 64; beat++) { await h.control({ now: ++clock }); assert.equal((await h.machine(credential.token, "heartbeat", { lease: claim.lease })).status, 200); }
    await h.control({ now: ++clock }); await measure("heartbeatAfterHistoryGrowth", () => h.machine(credential.token, "heartbeat", { lease: claim.lease }), 200);
    await measure("oneMiBAssetAfterHistoryGrowth", () => h.upload(credential.token, claim.lease, new Uint8Array(1024 * 1024).fill(100), "second_launch"), 201);
    assert.equal((await h.runtime.d1.prepare("SELECT count(*) AS n FROM automation_transitions").first<{ n: number }>())!.n, 158, "The measured history growth retains every distinct heartbeat fact");
    assert.equal(profile.heartbeatAfterHistoryGrowth!.rowsRead, profile.heartbeat!.rowsRead, "Heartbeat accounting cost must be independent of immutable transition history");
  }
  const before = await h.runtime.d1.prepare("SELECT count(*) AS n FROM automation_publications").first<{ n: number }>(); assert.equal(before!.n, 6);
  const rejected = await h.machine(credentials[1]!.token, "heartbeat", { lease: claim.lease }); assert.equal(rejected.status, 403);
  assert.equal((await h.runtime.d1.prepare("SELECT count(*) AS n FROM automation_publications").first<{ n: number }>())!.n, 6);
  const claims = [profile.idleClaim0!, profile.idleClaim1!, profile.idleClaim2!], presence = [profile.presence0!, profile.presence1!, profile.presence2!];
  const dailyPerAppFiveMinutes = 288 * claims.reduce((sum, value) => sum + value.rowsRead, 0) + 1440 * presence.reduce((sum, value) => sum + value.rowsRead, 0);
  t.diagnostic("Full real Worker/D1 endpoint budget: " + JSON.stringify({ incrementalAccounting, profile, dailyThreeAppPerAppFiveMinutes: dailyPerAppFiveMinutes }));
  if (incrementalAccounting) {
    assert.ok(profile.buildClaim!.rowsRead <= 96, "Full migrated build claim row-read budget exceeded: " + profile.buildClaim!.rowsRead);
    assert.ok(profile.heartbeat!.rowsRead <= 80, "Full migrated heartbeat row-read budget exceeded: " + profile.heartbeat!.rowsRead);
    assert.equal(profile.buildClaim!.rowsWritten, 8, "Charged claim retains its immutable witness and sealed totals");
    for (const name of ["heartbeat", "heartbeatAfterHistoryGrowth"]) assert.equal(profile[name]!.rowsWritten, 8);
    for (const name of ["oneMiBAsset", "oneMiBAssetAfterHistoryGrowth"]) {
      assert.ok(profile[name]!.rowsRead <= 320, "Full migrated 1MiB asset row-read budget exceeded: " + profile[name]!.rowsRead);
      assert.equal(profile[name]!.rowsWritten, 39, "Charged upload retains each immutable witness and sealed totals");
    }
  }
  assert.ok(profile.idleClaim0!.rowsRead <= 48, "Idle full endpoint must select latest jobs instead of scanning 90 immutable transition versions, got " + profile.idleClaim0!.rowsRead);
  assert.ok(claims.every(value => value.rowsWritten === 0)); assert.ok(presence.every(value => value.rowsWritten === 0));
});

test("presence rejects forged scope, absent or revoked authority and leaves no live entry after revocation", async t => {
  const h = await harness(t), one = await h.app("presence-guard-one"), two = await h.app("presence-guard-two");
  const credential = await (await h.post("/api/runners", { name: "Scoped PC", appIds: [one.appId] })).json() as RunnerEnrollment;
  const bad = "runner_11111111-1111-4111-8111-111111111111." + "a".repeat(43);
  for (const input of [{ runnerId: credential.runner.id }, { appIds: [two.appId] }, { state: "online" }, { lastSeenAt: start }]) {
    assert.equal((await h.machine(credential.token, "presence", input)).status, 400);
  }
  assert.equal((await h.machine(bad, "presence", {})).status, 403);
  for (const authorization of [undefined, "Bearer " + bad]) {
    const probe = await (await h.post("/__test/runner-unread", { presence: true, ...(authorization ? { authorization } : {}) })).json() as { status: number; reads: number };
    assert.equal(probe.status, authorization ? 403 : 401); assert.equal(probe.reads, 0, "Invalid authority is rejected before any request body is read");
  }
  const anonymous = await h.runtime.fetch(origin + "/api/runner/presence", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); assert.equal(anonymous.status, 401);
  assert.equal((await h.machine(credential.token, "presence", {})).status, 200);
  const revoked = await h.post(`/api/runners/${credential.runner.id}/revoke`, {}); assert.equal(revoked.status, 200);
  assert.equal((await h.machine(credential.token, "presence", {})).status, 403);
  const snapshot = await (await h.get(`/api/apps/${one.appId}/automation`)).json() as { runners: Array<{ revokedAt: number | null; presence: { lastSeenAt: number | null; status: string } }> };
  assert.equal(snapshot.runners[0]!.revokedAt, start); assert.deepEqual(snapshot.runners[0]!.presence, { lastSeenAt: null, status: "never_seen" });
  const rows = await (await h.control({ sql: "SELECT runner_id,last_seen_at FROM flora_runner_presence" })).json(); assert.deepEqual(rows, []);
});

test("presence expires old entries and never accepts client timestamp or secret material", async t => {
  const h = await harness(t), app = await h.app("presence-ttl");
  const enrollment = await (await h.post("/api/runners", { name: "PC TTL", appIds: [app.appId] })).json() as RunnerEnrollment;
  assert.equal((await h.machine(enrollment.token, "presence", {})).status, 200);
  await h.control({ now: start + 7 * 86_400_000 + 1, restart: true });
  // The owner session has expired; this read uses the actual machine endpoint.
  const result = await h.machine(enrollment.token, "presence", {}); assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { runnerId: enrollment.runner.id, lastSeenAt: start + 7 * 86_400_000 + 1 });
  const rows = await (await h.control({ sql: "SELECT runner_id,last_seen_at FROM flora_runner_presence" })).json() as unknown[];
  assert.equal(rows.length, 1); assert.ok(!JSON.stringify(rows).includes(enrollment.token));
});

test("presence capacity is bounded and stale keys are pruned before admitting the next real Runner", async t => {
  const h = await harness(t), app = await h.app("presence-capacity");
  const enrollment = await (await h.post("/api/runners", { name: "Capacity PC", appIds: [app.appId] })).json() as RunnerEnrollment;
  await h.control({ sql: "INSERT INTO flora_runner_presence VALUES " + Array.from({ length: 100 }, (_, index) => `('fixture_${index}',${start})`).join(",") });
  const full = await h.machine(enrollment.token, "presence", {}); assert.equal(full.status, 409); assert.deepEqual(await full.json(), { error: "PRESENCE_CAPACITY" });
  await h.control({ now: start + 7 * 86_400_000 + 1 });
  assert.equal((await h.machine(enrollment.token, "presence", {})).status, 200);
  const rows = await (await h.control({ sql: "SELECT runner_id,last_seen_at FROM flora_runner_presence" })).json();
  assert.deepEqual(rows, [{ runner_id: enrollment.runner.id, last_seen_at: start + 7 * 86_400_000 + 1 }]);
});

test("Runner revocation during a stalled presence body cannot revive online status", async t => {
  const h = await harness(t), app = await h.app("presence-revocation-race");
  const enrollment = await (await h.post("/api/runners", { name: "Held PC", appIds: [app.appId] })).json() as RunnerEnrollment;
  const held = await h.post("/__test/runner-held", { action: "hold", presence: true, authorization: "Bearer " + enrollment.token }); assert.deepEqual(await held.json(), { held: true });
  assert.equal((await h.post(`/api/runners/${enrollment.runner.id}/revoke`, {})).status, 200);
  const rejected = await h.post("/__test/runner-held", { action: "release" }); assert.deepEqual(await rejected.json(), { status: 403, body: { error: "PERMISSION_DENIED" } });
  const rows = await (await h.control({ sql: "SELECT runner_id,last_seen_at FROM flora_runner_presence" })).json(); assert.deepEqual(rows, []);
});

test("actual Worker signs push admission and isolates scoped Runner exports and OTA history without EAS", async t => {
  const h = await harness(t), one = await h.app("sdk-one"), two = await h.app("sdk-two");
  const disabled = await h.hook(one.repo, "delivery_disabled"); assert.equal(disabled.status, 202); assert.deepEqual(await disabled.json(), { jobs: [], ignored: 0 });
  for (const app of [one, two]) assert.equal((await h.post(`/api/apps/${app.appId}/automation/policy`, { expectedVersion: 0, enabled: true, channel: "preview", platform: "android" })).status, 200);
  assert.equal((await h.post(`/api/apps/${one.appId}/automation/policy`, { expectedVersion: 0, enabled: true, channel: "production", platform: "ios" })).status, 409);
  const jobs: AutomationJob[] = [];
  for (const app of [one, two]) {
    const response = await h.hook(app.repo, "delivery_" + app.repo); assert.equal(response.status, 202, await response.clone().text());
    const job = (await response.json() as { jobs: AutomationJob[] }).jobs[0]!; assert.equal(job.appId, app.appId); assert.equal(job.config.bundler, "metro"); assert.equal(job.commitSha, app.detection.commitSha); jobs.push(job);
    const replay = await h.hook(app.repo, "delivery_" + app.repo); assert.equal(replay.status, 202); assert.equal((await replay.json() as { jobs: AutomationJob[] }).jobs[0]!.id, job.id);
  }
  const enroll = async (appId: string) => { const response = await h.post("/api/runners", { name: "Synthetic scoped runner", appIds: [appId] }); assert.equal(response.status, 201); return response.json() as Promise<RunnerEnrollment>; };
  const credentials = [await enroll(one.appId), await enroll(two.appId)];
  for (const [index, credential] of credentials.entries()) {
    const claimed = await h.machine(credential.token, "claim", {}); assert.equal(claimed.status, 201, await claimed.clone().text()); const claim = await claimed.json() as AutomationClaim; assert.equal(claim.job.id, jobs[index]!.id);
    const source = await h.machine(credential.token, "source", { lease: claim.lease }); assert.equal(source.status, 200); const grant = await source.json() as { token: string; url: string }; assert.ok(grant.url.endsWith(claim.job.commitSha)); assert.equal(grant.token, "synthetic_scoped_source_token");
    const bytes = new TextEncoder().encode("globalThis.syntheticFlora=" + index), uploaded = await h.upload(credential.token, claim.lease, bytes); assert.equal(uploaded.status, 201, await uploaded.clone().text()); const asset = await uploaded.json() as OTAAsset;
    assert.equal((await h.runtime.fetch(origin + `/updates/${claim.job.appId}/assets/${asset.digest}`)).status, 404);
    const core = { jobId: claim.job.id, attemptId: claim.lease.attemptId, commitSha: claim.job.commitSha, configDigest: claim.job.configDigest, toolchainDigest: claim.job.toolchainDigest, sourceArchiveDigest: "c".repeat(64), launchAssetId: asset.id, assetIds: [] };
    const receipt: AutomationExportReceipt = { ...core, artifactDigest: await automationDigest(automationArtifactPayload(core, [asset])) };
    const finalized = await h.machine(credential.token, "finalize", { lease: claim.lease, receipt }); assert.equal(finalized.status, 200, await finalized.clone().text()); const result = await finalized.json() as { job: AutomationJob; deployment: { id: string } }; assert.equal(result.job.state, "succeeded");
    const retry = await h.machine(credential.token, "finalize", { lease: claim.lease, receipt }); assert.equal(retry.status, 200); assert.equal((await retry.json() as { deployment: { id: string } }).deployment.id, result.deployment.id);
    const update = await h.runtime.fetch(origin + `/updates/${claim.job.appId}?channel=preview`, { headers: { "expo-platform": "android", "expo-runtime-version": "flora-native-1", "expo-protocol-version": "1", Accept: "application/expo+json" } }); assert.equal(update.status, 200);
    const manifest = await update.json() as { id: string; launchAsset: { hash: string; url: string } }; assert.equal(manifest.id, result.deployment.id);
    const downloaded = await h.runtime.fetch(manifest.launchAsset.url); assert.equal(downloaded.status, 200); assert.equal(createHash("sha256").update(Buffer.from(await downloaded.arrayBuffer())).digest("base64url"), manifest.launchAsset.hash);
    const state = await h.get(`/api/apps/${claim.job.appId}/automation`); assert.equal(state.status, 200); const snapshot = await state.json() as { jobs: AutomationJob[]; runners: unknown[] }; assert.deepEqual(snapshot.jobs.map(job => job.id), [claim.job.id]); assert.doesNotMatch(JSON.stringify(snapshot), /tokenHash|synthetic_scoped_source_token/);
    const foreign = await h.get(`/api/apps/${jobs[1 - index]!.appId}/automation/jobs/${claim.job.id}`); assert.equal(foreign.status, 404);
    assert.equal((await h.post(`/api/runners/${credential.runner.id}/revoke`, {})).status, 200);
    assert.equal((await h.machine(credential.token, "claim", {})).status, 403);
    const unread = await h.post("/__test/runner-unread", { authorization: "Bearer " + credential.token, lease: Buffer.from(JSON.stringify(claim.lease)).toString("base64url") }); assert.deepEqual(await unread.json(), { status: 403, reads: 0, body: { error: "PERMISSION_DENIED" } });
  }
  const invalid = await h.post("/__test/runner-unread", { authorization: "Bearer invalid" }); assert.deepEqual(await invalid.json(), { status: 403, reads: 0, body: { error: "PERMISSION_DENIED" } });
  h.setHead(one.repo, "d".repeat(40)); const newer = await h.hook(one.repo, "delivery_newest"); assert.equal(newer.status, 202); await newer.json();
  const counts = async () => Promise.all(["github_detections", "automation_jobs"].map(table => h.runtime.d1.prepare(`SELECT count(*) AS n FROM ${table} WHERE app_id=?`).bind(one.appId).first<{ n: number }>()));
  const before = await counts(), requests = h.requests();
  const delayed = await h.hook(one.repo, "delivery_delayed", "a".repeat(40)); assert.equal(delayed.status, 202); assert.deepEqual(await delayed.json(), { jobs: [], ignored: 1 });
  assert.deepEqual(await counts(), before, "Delayed old push must write neither detection nor job"); assert.equal(h.requests() - requests, 2, "Only token and configured HEAD are read for stale delivery");
});

test("hosted push cap rejects fanout before writes and single-target plus maximum upload fit Free D1", async t => {
  const h = await harness(t), apps = [];
  for (const root of ["apps/a", "apps/b", "apps/c", "apps/d"]) {
    const app = await h.app("fanout", root); apps.push(app);
    assert.equal((await h.post(`/api/apps/${app.appId}/automation/policy`, { expectedVersion: 0, enabled: true, channel: "preview", platform: "android" })).status, 200);
  }
  const rows = async () => Promise.all(["github_detections", "automation_jobs"].map(table => h.runtime.d1.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>()));
  const before = await rows(); const over = await h.hook("fanout", "delivery_fanout"); assert.equal(over.status, 413, await over.clone().text()); await over.json(); assert.deepEqual(await rows(), before, "Over-cap push must not partially write apps");
  for (const app of apps.slice(1)) assert.equal((await h.post(`/api/apps/${app.appId}/automation/policy`, { expectedVersion: 1, enabled: false, channel: "preview", platform: "android" })).status, 200);
  const response = await h.hook("fanout", "delivery_single"); assert.equal(response.status, 202, await response.clone().text()); const queued = await response.json() as { jobs: AutomationJob[] }; assert.equal(queued.jobs.length, 1);
  const webhookQueries = Number(response.headers.get("X-Flora-Test-D1-Queries")); t.diagnostic("Single-target webhook SQL queries: " + webhookQueries); assert.ok(webhookQueries > 0, "Instrumentation must observe real D1 execution");
  const enrollment = await h.post("/api/runners", { name: "Upload boundary", appIds: [apps[0]!.appId] }); const runner = await enrollment.json() as RunnerEnrollment;
  const claim = await (await h.machine(runner.token, "claim", {})).json() as AutomationClaim;
  const uploaded = await h.upload(runner.token, claim.lease, new Uint8Array(16 * 1024 * 1024).fill(65)); assert.equal(uploaded.status, 201, await uploaded.clone().text()); await uploaded.json();
  const uploadQueries = Number(uploaded.headers.get("X-Flora-Test-D1-Queries")); t.diagnostic("16MiB leased upload SQL queries: " + uploadQueries); assert.ok(uploadQueries > 0 && uploadQueries <= 50, "Free D1 asset upload query ceiling with positive instrumentation");
  assert.ok(webhookQueries <= 50, "Free D1 webhook query ceiling");
});

test("late pinned GitHub content cannot supersede a newer signed push in the actual authority", async t => {
  const h = await harness(t), app = await h.app("held-source");
  assert.equal((await h.post(`/api/apps/${app.appId}/automation/policy`, { expectedVersion: 0, enabled: true, channel: "preview", platform: "android" })).status, 200);
  const held = h.holdSource(app.repo, app.detection.commitSha), older = h.hook(app.repo, "delivery_old_inflight");
  await held.began; h.setHead(app.repo, "b".repeat(40));
  const newer = await h.hook(app.repo, "delivery_new_inflight"); assert.equal(newer.status, 202, await newer.clone().text()); const newJob = (await newer.json() as { jobs: AutomationJob[] }).jobs[0]!;
  const counts = async () => Promise.all(["github_detections", "automation_jobs"].map(table => h.runtime.d1.prepare(`SELECT count(*) AS n FROM ${table} WHERE app_id=?`).bind(app.appId).first<{ n: number }>()));
  const beforeRelease = await counts(); held.release(); const late = await older;
  assert.equal(late.status, 202, await late.clone().text()); assert.deepEqual(await late.json(), { jobs: [], ignored: 1 });
  assert.deepEqual(await counts(), beforeRelease, "Old pinned provider completion writes neither detection nor job");
  const state = await (await h.get(`/api/apps/${app.appId}/automation`)).json() as { jobs: AutomationJob[] }; assert.deepEqual(state.jobs.map(job => [job.id, job.commitSha]), [[newJob.id, "b".repeat(40)]]);
  h.setHead(app.repo, "c".repeat(40));
  const currentHeld = h.holdSource(app.repo, "c".repeat(40)), current = h.hook(app.repo, "delivery_current_held");
  await currentHeld.began;
  const stale = await h.hook(app.repo, "delivery_stale_during_current", "a".repeat(40)); assert.equal(stale.status, 202); assert.deepEqual(await stale.json(), { jobs: [], ignored: 1 });
  currentHeld.release(); const currentResult = await current;
  assert.equal(currentResult.status, 202, await currentResult.clone().text());
  const currentJobs = (await currentResult.json() as { jobs: AutomationJob[] }).jobs;
  assert.equal(currentJobs.length, 1, "A stale signed push cannot invalidate an in-flight validated current ref"); assert.equal(currentJobs[0]!.commitSha, "c".repeat(40));
});

test("leased held upload rejects another body unread while heartbeat and owner cancellation remain available", async t => {
  const h = await harness(t), app = await h.app("held-upload");
  assert.equal((await h.post(`/api/apps/${app.appId}/automation/policy`, { expectedVersion: 0, enabled: true, channel: "preview", platform: "android" })).status, 200);
  await (await h.hook(app.repo, "delivery_held_upload")).json();
  const runner = await (await h.post("/api/runners", { name: "Held uploader", appIds: [app.appId] })).json() as RunnerEnrollment;
  const claim = await (await h.machine(runner.token, "claim", {})).json() as AutomationClaim;
  const lease = Buffer.from(JSON.stringify(claim.lease)).toString("base64url"), authorization = "Bearer " + runner.token;
  const held = await h.post("/__test/runner-held", { action: "hold", authorization, lease }); assert.deepEqual(await held.json(), { held: true });
  const busy = await h.post("/__test/runner-unread", { authorization, lease }); assert.deepEqual(await busy.json(), { status: 409, reads: 0, body: { error: "BUSY" } });
  assert.equal((await h.machine(runner.token, "heartbeat", { lease: claim.lease })).status, 200);
  const cancel = await h.post(`/api/apps/${app.appId}/automation/jobs/${claim.job.id}/cancel`, {}); assert.equal(cancel.status, 200, await cancel.clone().text());
  assert.equal((await cancel.json() as AutomationJob).state, "cancel_requested");
  const aborted = await h.post("/__test/runner-held", { action: "abort" }); assert.deepEqual(await aborted.json(), { status: 400, body: { error: "BODY_CANCELLED" } });
  assert.equal((await h.machine(runner.token, "fail", { lease: claim.lease, code: "CANCELLED" })).status, 200);
  await (await h.hook(app.repo, "delivery_after_abort")).json();
  const next = await (await h.machine(runner.token, "claim", {})).json() as AutomationClaim;
  assert.equal((await h.upload(runner.token, next.lease, new TextEncoder().encode("after abort"))).status, 201, "Abort releases heavy and body admission");
  const nextLease = Buffer.from(JSON.stringify(next.lease)).toString("base64url");
  assert.deepEqual(await (await h.post("/__test/runner-held", { action: "hold", authorization, lease: nextLease })).json(), { held: true });
  await h.control({ now: next.lease.expiresAt });
  const expired = await h.post("/__test/runner-held", { action: "release" }); assert.deepEqual(await expired.json(), { status: 409, body: { error: "LEASE_STALE" } });
  await (await h.hook(app.repo, "delivery_after_deadline")).json();
  const fresh = await (await h.machine(runner.token, "claim", {})).json() as AutomationClaim;
  assert.ok(fresh.lease); assert.equal((await h.upload(runner.token, fresh.lease, new TextEncoder().encode("after deadline"))).status, 201, "Expired body releases heavy and body admission");
});
