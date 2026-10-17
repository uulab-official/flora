import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { automationArtifactPayload, automationDigest } from "@app-ops/dogfood";
import type { AutomationClaim, AutomationExportReceipt, AutomationJob, OTAAsset } from "@app-ops/dogfood";
import type { RunnerCheckpoint } from "../dist/managed-ci.js";
import { createTestRuntime } from "./runtime.ts";
import { githubOTAFixture } from "../../../tests/github-ota-fixtures.ts";

const origin = "https://flora.example.test", start = 1_800_000_000_000, workflowSha = "e".repeat(40);
const workflowRef = "synthetic/flora/.github/workflows/ota.yml@" + workflowSha;
async function harness(t: TestContext) {
  const appIds = new Map<string, string>(), heads = new Map<string, string>(), repoIds = new Map<string, string>();
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 }), jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "ci-synthetic-key", alg: "RS256", use: "sig" };
  const fixture = githubOTAFixture(() => origin, new Map()), secret = randomBytes(32).toString("hex");
  let heldHead: { repo: string; began: () => void; gate: Promise<void> } | null = null;
  let heldIdentity: { repo: string; began: () => void; gate: Promise<void> } | null = null;
  let clock = start, sequence = 0, githubRequests = 0;
  const outbound = async (request: Request) => {
    const url = new URL(request.url);
    if (url.origin === "https://token.actions.githubusercontent.com") { assert.equal(url.pathname, "/.well-known/jwks"); return Response.json({ keys: [jwk] }); }
    githubRequests++; assert.equal(url.origin, "https://api.github.com"); assert.ok(request.headers.get("Authorization")?.startsWith("Bearer "));
    if (url.pathname === "/app/installations/42/access_tokens") return Response.json({ token: "synthetic_scoped_source_token", expires_at: new Date(clock + 3_600_000).toISOString() }, { status: 201 });
    const metadata = /^\/repos\/synthetic\/([^/]+)$/.exec(url.pathname);
    if (metadata) {
      if (heldIdentity && heldIdentity.repo === metadata[1]) { const hold = heldIdentity; heldIdentity = null; hold.began(); await hold.gate; }
      return Response.json({ id: Number(repoIds.get(metadata[1]!)), full_name: "synthetic/" + metadata[1], owner: { id: 999, login: "synthetic" } });
    }
    const match = /^\/repos\/synthetic\/([^/]+)\/(commits|contents)(?:\/(.*))?$/.exec(url.pathname); assert.ok(match);
    const repo = match[1]!, sha = heads.get(repo)!;
    if (match[2] === "commits") {
      const resolved = /^[a-f0-9]{40}$/.test(match[3] ?? "") ? match[3] : sha;
      if (match[3] === "main" && heldHead?.repo === repo) { const hold = heldHead; heldHead = null; hold.began(); await hold.gate; }
      return Response.json({ sha: resolved });
    }
    assert.match(url.searchParams.get("ref")!, /^[a-f0-9]{40}$/);
    if (!match[3]) return Response.json(["package.json", "flora.config.json"].map(name => ({ name, type: "file" })));
    const data = match[3] === "package.json" ? { dependencies: { "@flora/ota": "workspace:*", "react-native": "0.86.3", metro: "0.84.0" } }
      : { schemaVersion: 1, ota: { runtimeVersion: "flora-native-1", platforms: ["ios", "android"], url: origin + "/updates/" + appIds.get(repo) }, export: { bundler: "metro", entryFile: "index.js", nodeVersion: "24.19.0", packageManager: { name: "npm", version: "11.9.0" } } };
    const bytes = Buffer.from(JSON.stringify(data)); return Response.json({ type: "file", encoding: "base64", size: bytes.length, content: bytes.toString("base64") });
  };
  const setup = randomBytes(32), password = randomBytes(24).toString("base64url");
  const runtime = await createTestRuntime({ entrypoint: new URL("./fixtures/hosted-entry.ts", import.meta.url), durableObjects: { FLORA_AUTH: "HostedFixtureAuth" }, outboundService: outbound, bindings: {
    FLORA_ORIGIN: origin, FLORA_OWNER_ID: "synthetic-owner", FLORA_OWNER_EMAIL: "owner@example.test", FLORA_DB_IDENTITY: "synthetic-db",
    FLORA_GITHUB_APP_ID: fixture.credentials.appId, FLORA_GITHUB_PRIVATE_KEY: fixture.credentials.privateKey, FLORA_GITHUB_WEBHOOK_SECRET: secret,
    FLORA_SETUP: { digest: createHash("sha256").update(setup).digest("hex"), issuedAt: start, expiresAt: start + 600_000, generation: 1, purpose: "enroll" },
  } }); t.after(() => runtime.dispose());
  for (const name of ["0001_private_imports.sql", "0002_multi_app.sql", "0003_github_ota.sql", "0004_automation.sql"]) {
    const sql = await readFile(new URL("../migrations/" + name, import.meta.url), "utf8");
    await runtime.d1.exec(sql.replace(/^--.*$/gm, "").split(/;\s*(?=CREATE|INSERT|DROP|PRAGMA|$)/).filter(s => s.trim()).map(s => s.replace(/\s*\n\s*/g, " ").trim() + ";").join("\n"));
  }
  await runtime.d1.prepare("INSERT INTO flora_deployment(singleton,owner_id,origin,db_identity) VALUES(1,?,?,?)").bind("synthetic-owner", origin, "synthetic-db").run();
  const enrolled = await runtime.fetch(origin + "/api/auth/enroll", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@example.test", password, confirmation: password, token: setup.toString("base64url") }) }); assert.equal(enrolled.status, 200);
  const headers = { Cookie: enrolled.headers.getSetCookie().map(value => value.split(";")[0]).join("; "), Origin: origin, "Content-Type": "application/json", "X-Flora-CSRF": (await enrolled.json() as { csrfToken: string }).csrfToken };
  const post = (path: string, body: unknown) => runtime.fetch(origin + path, { method: "POST", headers, body: JSON.stringify(body) });
  const get = (path: string) => runtime.fetch(origin + path, { headers });
  const machine = (token: string, action: string, body: unknown) => runtime.fetch(origin + "/api/runner/" + action, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const control = async (data: Record<string, unknown>) => { if (typeof data.now === "number") clock = data.now; return post("/__test/control", data); };
  async function app(repo: string, sha = "a".repeat(40)) {
    repoIds.set(repo, String(101 + repoIds.size)); heads.set(repo, sha);
    const created = await post("/api/apps", { name: repo, repositoryId: "github:synthetic/" + repo, rootDirectory: "." }); assert.equal(created.status, 201);
    const appId = (await created.json() as { id: string }).id; appIds.set(repo, appId);
    const connected = await post(`/api/apps/${appId}/github`, { expectedVersion: 0, installationId: 42, owner: "synthetic", repository: repo, ref: "main" }); assert.equal(connected.status, 201, await connected.clone().text());
    await connected.json();
    const input = { expectedVersion: 0, enabled: true, repositoryId: repoIds.get(repo)!, repositoryOwnerId: "999", ref: "refs/heads/main", jobWorkflowRef: workflowRef, jobWorkflowSha: workflowSha };
    return { appId, repo, input };
  }
  function jwt(repo: string, overrides: Record<string, unknown> = {}) {
    const sec = clock / 1000, claims = { iss: "https://token.actions.githubusercontent.com", aud: origin, sub: "repo:synthetic/" + repo + ":ref:refs/heads/main", exp: sec + 300, iat: sec, nbf: sec,
      repository: "synthetic/" + repo, repository_id: repoIds.get(repo), repository_owner: "synthetic", repository_owner_id: "999", ref: "refs/heads/main", ref_type: "branch",
      event_name: "push", runner_environment: "github-hosted", sha: heads.get(repo), job_workflow_ref: workflowRef, job_workflow_sha: workflowSha, run_id: "123456", run_attempt: "1", jti: "synthetic-jti-" + ++sequence, ...overrides };
    const input = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid })).toString("base64url") + "." + Buffer.from(JSON.stringify(claims)).toString("base64url");
    return input + "." + sign("RSA-SHA256", Buffer.from(input), pair.privateKey).toString("base64url");
  }
  const exchange = (appId: string, jwt: string) => runtime.fetch(origin + "/api/runner/github/oidc", { method: "POST", headers: { Authorization: "Bearer " + jwt, "Content-Type": "application/json" }, body: JSON.stringify({ appId }) });
  async function token(appId: string, repo: string, overrides: Record<string, unknown> = {}) { const response = await exchange(appId, jwt(repo, overrides)); assert.equal(response.status, 201, await response.clone().text()); return response.json() as Promise<{ runner: { id: string }; token: string; expiresAt: number; appId: string; commitSha: string }>; }
  async function push(repo: string) {
    const body = JSON.stringify({ ref: "refs/heads/main", after: heads.get(repo), deleted: false, installation: { id: 42 }, repository: { name: repo, owner: { login: "synthetic" } } });
    const response = await runtime.fetch(origin + "/api/github/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-GitHub-Event": "push", "X-GitHub-Delivery": "delivery_" + ++sequence, "X-Hub-Signature-256": "sha256=" + createHmac("sha256", secret).update(body).digest("hex") }, body });
    assert.equal(response.status, 202, await response.clone().text()); return (await response.json() as { jobs: AutomationJob[] }).jobs[0]!;
  }
  async function upload(token: string, claim: AutomationClaim): Promise<{ asset: OTAAsset; receipt: AutomationExportReceipt; journal: RunnerCheckpoint }> {
    const response = await runtime.fetch(origin + "/api/runner/assets?key=launch&contentType=application%2Fjavascript&fileExtension=.js", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/octet-stream", "X-Flora-Runner-Lease": Buffer.from(JSON.stringify(claim.lease)).toString("base64url") }, body: new TextEncoder().encode("synthetic launch " + claim.job.appId) });
    assert.equal(response.status, 201, await response.clone().text()); const asset = await response.json() as OTAAsset;
    const core = { jobId: claim.job.id, attemptId: claim.lease.attemptId, commitSha: claim.job.commitSha, configDigest: claim.job.configDigest, toolchainDigest: claim.job.toolchainDigest, sourceArchiveDigest: "c".repeat(64), launchAssetId: asset.id, assetIds: [] };
    const receipt = { ...core, artifactDigest: await automationDigest(automationArtifactPayload(core, [asset])) };
    return { asset, receipt, journal: { schemaVersion: 1, origin, lease: claim.lease, receipt } };
  }
  function holdHead(repo: string) {
    let began!: () => void, release!: () => void; const started = new Promise<void>(resolve => { began = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    heldHead = { repo, began, gate }; return { started, release };
  }
  function holdIdentity(repo: string) {
    let began!: () => void, release!: () => void; const started = new Promise<void>(resolve => { began = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    heldIdentity = { repo, began, gate }; return { started, release };
  }
  return { runtime, app, post, get, machine, control, jwt, token, exchange, push, upload, heads, holdHead, holdIdentity, githubRequests: () => githubRequests };
}

test("CI admission snapshots legacy policy platforms and refuses an unadmitted platform before claiming", async t => {
  const h = await harness(t), app = await h.app("platform-legacy");
  assert.equal((await h.post(`/api/apps/${app.appId}/automation/ci`, app.input)).status, 200);
  assert.equal((await h.post(`/api/apps/${app.appId}/automation/policy`, { expectedVersion: 0, enabled: true, channel: "preview", platform: "ios" })).status, 200);
  const job = await h.push(app.repo), admitted = await h.exchange(app.appId, h.jwt(app.repo));
  assert.equal(admitted.status, 201);
  const session = await admitted.json() as { token: string; platforms: string[]; expiresAt: number };
  assert.deepEqual(session.platforms, ["ios"]);
  assert.equal(session.expiresAt, start + 1_800_000);
  assert.equal((await h.post(`/api/apps/${app.appId}/automation/policy`, { expectedVersion: 1, enabled: true, channel: "preview", platforms: ["ios", "android"] })).status, 200);
  assert.equal((await h.machine(session.token, "claim", { platform: "android" })).status, 403);
  assert.equal((await h.machine(session.token, "claim", { platform: "web" })).status, 400);
  const claim = await h.machine(session.token, "claim", { platform: "ios" });
  assert.equal(claim.status, 201, await claim.clone().text());
  assert.equal((await claim.json() as AutomationClaim).job.id, job.id);
});

test("one CI admission independently scopes both platform jobs while preserving another app and failed sibling", async t => {
  const h = await harness(t), one = await h.app("dual-one"), two = await h.app("dual-two", "b".repeat(40));
  for (const app of [one, two]) {
    assert.equal((await h.post(`/api/apps/${app.appId}/automation/ci`, app.input)).status, 200);
    assert.equal((await h.post(`/api/apps/${app.appId}/automation/policy`, { expectedVersion: 0, enabled: true, channel: "preview", platforms: ["ios", "android"] })).status, 200);
    await h.push(app.repo);
  }
  const beforeTwo = await (await h.get(`/api/apps/${two.appId}/automation`)).json();
  const response = await h.exchange(one.appId, h.jwt(one.repo));
  assert.equal(response.status, 201);
  const session = await response.json() as { token: string; platforms: string[]; expiresAt: number };
  assert.deepEqual(session.platforms, ["ios", "android"]);
  assert.equal(session.expiresAt, start + 3_600_000, "Two sequential bounded exports receive a complete execution budget");
  assert.equal((await h.machine(session.token, "presence", {})).status, 403, "Short-lived CI sessions cannot impersonate a persistent PC Runner presence");
  assert.equal((await h.machine(session.token, "claim", {})).status, 403, "Both-platform admission requires an explicit target");
  assert.equal((await h.machine(session.token, "claim", { platform: "android", appId: two.appId })).status, 400);
  const androidResponse = await h.machine(session.token, "claim", { platform: "android" });
  assert.equal(androidResponse.status, 201, await androidResponse.clone().text());
  const android = await androidResponse.json() as AutomationClaim;
  assert.equal(android.job.appId, one.appId); assert.equal(android.job.platform, "android");
  assert.equal((await h.machine(session.token, "fail", { lease: android.lease, code: "EXPORT_FAILED" })).status, 200);
  const iosResponse = await h.machine(session.token, "claim", { platform: "ios" });
  assert.equal(iosResponse.status, 201, await iosResponse.clone().text());
  const ios = await iosResponse.json() as AutomationClaim;
  assert.equal(ios.job.appId, one.appId); assert.equal(ios.job.platform, "ios"); assert.notEqual(ios.job.id, android.job.id);
  const uploaded = await h.upload(session.token, ios);
  assert.equal((await h.machine(session.token, "checkpoint-save", uploaded.journal)).status, 200);
  const done = await h.machine(session.token, "finalize", { lease: ios.lease, receipt: uploaded.receipt });
  assert.equal(done.status, 200, await done.clone().text());
  assert.equal((await h.machine(session.token, "claim", { platform: "ios" })).status, 204);
  assert.equal((await h.machine(session.token, "claim", { platform: "android" })).status, 204);
  const state = await (await h.get(`/api/apps/${one.appId}/automation`)).json() as { jobs: AutomationJob[] };
  assert.equal(state.jobs.find(job => job.id === android.job.id)!.state, "failed");
  assert.equal(state.jobs.find(job => job.id === ios.job.id)!.state, "succeeded");
  assert.deepEqual(await (await h.get(`/api/apps/${two.appId}/automation`)).json(), beforeTwo);
  assert.equal((await h.runtime.fetch(origin + `/updates/${two.appId}/assets/${uploaded.asset.digest}`)).status, 404);
});

test("owner explicitly resolves app scoped GitHub identity without enrolling or changing bindings", async t => {
  const h = await harness(t), one = await h.app("one"), two = await h.app("two");
  for (const app of [one, two]) {
    const path = `/api/apps/${app.appId}/automation/ci`;
    const before = h.githubRequests();
    assert.deepEqual(await (await h.get(path)).json(), { binding: null });
    assert.equal(h.githubRequests(), before, "ordinary status read never requests GitHub");
    const resolved = await h.get(path + "?resolve=1");
    assert.equal(resolved.status, 200, await resolved.clone().text());
    assert.deepEqual(await resolved.json(), { binding: null, identity: { appId: app.appId, connectionVersion: 1, repository: "synthetic/" + app.repo, repositoryId: app.input.repositoryId, repositoryOwnerId: "999", ref: "refs/heads/main" } });
    assert.deepEqual(await (await h.get(path)).json(), { binding: null });
    const state = await (await h.get(`/api/apps/${app.appId}/automation`)).json() as { runners: unknown[]; jobs: unknown[] };
    assert.equal(state.runners.length, 0); assert.equal(state.jobs.length, 0);
    assert.equal((await h.get(path + "?resolve=0")).status, 400);
    assert.equal((await h.post(path + "?resolve=1", app.input)).status, 400);
    assert.equal((await h.runtime.fetch(origin + path + "?resolve=1")).status, 401);
  }
});

test("identity resolution rejects a concurrently changed application connection", async t => {
  const h = await harness(t), app = await h.app("one"), held = h.holdIdentity(app.repo);
  const pending = h.get(`/api/apps/${app.appId}/automation/ci?resolve=1`);
  await held.started;
  try {
    const changed = await h.post(`/api/apps/${app.appId}/github`, { expectedVersion: 1, installationId: 42, owner: "synthetic", repository: app.repo, ref: "next" });
    assert.equal(changed.status, 201, await changed.clone().text());
  } finally { held.release(); }
  const resolved = await pending; assert.equal(resolved.status, 409); assert.deepEqual(await resolved.json(), { error: "CONFIG_CONFLICT" });
});

test("owner verified CI IDs, OIDC replay gate and commit-filtered claims preserve two-app history", async t => {
  const h = await harness(t), one = await h.app("one"), two = await h.app("two", "b".repeat(40));
  const ciPath = (appId: string) => `/api/apps/${appId}/automation/ci`;
  assert.equal((await h.post(ciPath(one.appId), { ...one.input, repositoryOwnerId: "123" })).status, 403);
  assert.deepEqual(await (await h.get(ciPath(one.appId))).json(), { binding: null });
  for (const app of [one, two]) {
    const bound = await h.post(ciPath(app.appId), app.input); assert.equal(bound.status, 200, await bound.clone().text()); const raw = await bound.json(); assert.doesNotMatch(JSON.stringify(raw), /tokenHash|runner_token|Bearer/);
    assert.equal((await h.post(ciPath(app.appId), app.input)).status, 409);
    assert.equal((await h.post(`/api/apps/${app.appId}/automation/policy`, { expectedVersion: 0, enabled: true, channel: "preview", platform: "ios" })).status, 200);
  }
  const oldJob = await h.push(one.repo); h.heads.set(one.repo, "d".repeat(40)); const newJob = await h.push(one.repo); const secondJob = await h.push(two.repo);
  const oidc = h.jwt(one.repo), admitted = await h.exchange(one.appId, oidc); assert.equal(admitted.status, 201, await admitted.clone().text());
  const first = await admitted.json() as { token: string; runner: { id: string } };
  assert.equal((await h.exchange(one.appId, oidc)).status, 403);
  assert.equal((await h.exchange(two.appId, h.jwt(one.repo))).status, 403);
  assert.equal((await h.exchange(one.appId, h.jwt(one.repo, { job_workflow_sha: "f".repeat(40) }))).status, 403);
  const claimed = await h.machine(first.token, "claim", {}); assert.equal(claimed.status, 201, await claimed.clone().text()); const claim = await claimed.json() as AutomationClaim;
  assert.equal(claim.job.id, newJob.id); assert.equal(claim.lease.runnerId, first.runner.id);
  const old = await (await h.get(`/api/apps/${one.appId}/automation/jobs/${oldJob.id}`)).json() as { job: AutomationJob }; assert.equal(old.job.state, "queued", "Other commit is untouched before claim");
  const second = await h.token(two.appId, two.repo), claimTwo = await (await h.machine(second.token, "claim", {})).json() as AutomationClaim; assert.equal(claimTwo.job.id, secondJob.id);
  assert.equal((await h.machine(first.token, "source", { lease: claimTwo.lease })).status, 403);
  const uploaded = await h.upload(first.token, claim);
  assert.equal((await h.machine(first.token, "finalize", { lease: claim.lease, receipt: uploaded.receipt })).status, 403, "CI publication must have durable checkpoint");
  assert.equal((await h.machine(first.token, "checkpoint-save", uploaded.journal)).status, 200);
  const done = await h.machine(first.token, "finalize", { lease: claim.lease, receipt: uploaded.receipt }); assert.equal(done.status, 200, await done.clone().text()); const completed = await done.json() as { job: AutomationJob; deployment: { id: string } };
  assert.equal(completed.job.state, "succeeded");
  assert.equal((await h.runtime.fetch(origin + `/updates/${two.appId}/assets/${uploaded.asset.digest}`)).status, 404);
  const foreign = await h.machine(second.token, "checkpoint-list", {}); assert.deepEqual(await foreign.json(), { checkpoints: [] });
  await h.control({ restart: true });
  h.heads.set(one.repo, "f".repeat(40)); await h.push(one.repo); const fresh = await h.token(one.appId, one.repo); assert.equal(fresh.runner.id, first.runner.id);
  const superseded = await h.machine(first.token, "claim", {}); assert.equal(superseded.status, 403); assert.deepEqual(await superseded.json(), { error: "CI_COMMIT_SUPERSEDED" });
  const retained = await h.machine(fresh.token, "checkpoint-list", {}); assert.deepEqual(await retained.json(), { checkpoints: [uploaded.journal] });
  const retry = await h.machine(fresh.token, "finalize", { lease: claim.lease, receipt: uploaded.receipt }); assert.equal(retry.status, 200, await retry.clone().text()); assert.equal((await retry.json() as { deployment: { id: string } }).deployment.id, completed.deployment.id);
  assert.equal((await h.machine(fresh.token, "finalize", { lease: claim.lease, receipt: { ...uploaded.receipt, artifactDigest: "f".repeat(64) } })).status, 403);
  assert.equal((await h.machine(fresh.token, "checkpoint-clear", { jobId: claim.job.id, attemptId: claim.lease.attemptId, expectedDisposition: "stale" })).status, 409, "Stale recovery cannot erase committed proof");
  const clear = await h.machine(fresh.token, "checkpoint-clear", { jobId: claim.job.id, attemptId: claim.lease.attemptId }); assert.deepEqual(await clear.json(), { cleared: true, disposition: "committed", appId: one.appId, jobId: claim.job.id, attemptId: claim.lease.attemptId, receiptDigest: await automationDigest(uploaded.receipt) });
  assert.equal((await h.machine(fresh.token, "finalize", { lease: claim.lease, receipt: uploaded.receipt })).status, 403, "Old-commit reconciliation requires retained proof");
  const stateOne = await (await h.get(`/api/apps/${one.appId}/operations`)).json() as { deployments: { id: string }[] }, stateTwo = await (await h.get(`/api/apps/${two.appId}/operations`)).json() as { deployments: unknown[] };
  assert.deepEqual(stateOne.deployments.map(item => item.id), [completed.deployment.id]); assert.deepEqual(stateTwo.deployments, []);
});

test("uncommitted checkpoints retire only after authoritative expiry; disable works during D1 outage", async t => {
  const h = await harness(t), app = await h.app("recover"); const path = `/api/apps/${app.appId}/automation/ci`;
  assert.equal((await h.post(path, app.input)).status, 200); assert.equal((await h.post(`/api/apps/${app.appId}/automation/policy`, { expectedVersion: 0, enabled: true, channel: "preview", platform: "ios" })).status, 200);
  await h.push(app.repo); const first = await h.token(app.appId, app.repo), claim = await (await h.machine(first.token, "claim", {})).json() as AutomationClaim, exported = await h.upload(first.token, claim);
  assert.equal((await h.machine(first.token, "checkpoint-save", exported.journal)).status, 200);
  assert.equal((await h.machine(first.token, "checkpoint-clear", { jobId: claim.job.id, attemptId: claim.lease.attemptId })).status, 409, "Active publication remains recoverable");
  await h.control({ restart: true, now: claim.lease.expiresAt }); h.heads.set(app.repo, "d".repeat(40)); await h.push(app.repo); const second = await h.token(app.appId, app.repo);
  assert.equal((await h.machine(second.token, "finalize", { lease: claim.lease, receipt: exported.receipt })).status, 409, "Next run cannot publish previous uncommitted SHA");
  const cleared = await h.machine(second.token, "checkpoint-clear", { jobId: claim.job.id, attemptId: claim.lease.attemptId, expectedDisposition: "stale" }); assert.deepEqual(await cleared.json(), { cleared: true, disposition: "stale", appId: app.appId, jobId: claim.job.id, attemptId: claim.lease.attemptId, receiptDigest: await automationDigest(exported.receipt) });
  const absent = await h.machine(second.token, "checkpoint-clear", { jobId: claim.job.id, attemptId: claim.lease.attemptId }); assert.equal((await absent.json() as { disposition: string }).disposition, "absent");
  const state = await (await h.get(`/api/apps/${app.appId}/automation/jobs/${claim.job.id}`)).json() as { attempts: { outcome: string }[] }; assert.equal(state.attempts[0]!.outcome, "expired");
  const requests = h.githubRequests(); await h.control({ failD1: true });
  const disabled = await h.post(path, { ...app.input, expectedVersion: 1, enabled: false }); assert.equal(disabled.status, 200, await disabled.clone().text()); assert.equal(h.githubRequests(), requests, "Revocation requires no upstream request");
  assert.equal((await h.machine(second.token, "claim", {})).status, 403, "Disable immediately invalidates existing CI grants even during dependency outage");
});

test("CI sessions expire independently of JWT and never leak credentials into owner responses or logs", async t => {
  const h = await harness(t), app = await h.app("expiry"), path = `/api/apps/${app.appId}/automation/ci`;
  await h.post(path, app.input); const ci = await h.token(app.appId, app.repo);
  assert.match(ci.token, new RegExp("^" + ci.runner.id + "\\.[A-Za-z0-9_-]{43}$"));
  await h.control({ now: ci.expiresAt, restart: true }); assert.equal((await h.machine(ci.token, "claim", {})).status, 403);
  const owner = await (await h.get(path)).json(); assert.doesNotMatch(JSON.stringify(owner), /tokenHash|runner_token|synthetic_scoped_source_token/);
  const console = await (await h.control({ captureConsole: true })).json(); assert.doesNotMatch(JSON.stringify(console), new RegExp(ci.token.replaceAll(".", "\\.")));
});

test("late old HEAD response cannot supersede a newer admitted SHA, and old JWT cannot invalidate it", async t => {
  const h = await harness(t), app = await h.app("race"), path = `/api/apps/${app.appId}/automation/ci`; await h.post(path, app.input);
  const oldJwt = h.jwt(app.repo), hold = h.holdHead(app.repo), pending = h.exchange(app.appId, oldJwt); await hold.started;
  h.heads.set(app.repo, "d".repeat(40)); const newer = await h.token(app.appId, app.repo); hold.release();
  const old = await pending; assert.equal(old.status, 403); assert.deepEqual(await old.json(), { error: "CI_COMMIT_SUPERSEDED" });
  assert.equal((await h.exchange(app.appId, oldJwt)).status, 403, "An old signed JWT fails actual configured HEAD");
  assert.equal((await h.machine(newer.token, "checkpoint-list", {})).status, 200, "Rejected old JWT does not invalidate newer admission");
  await h.control({ restart: true }); assert.equal((await h.machine(newer.token, "checkpoint-list", {})).status, 200, "Admitted commit fence persists across restart");
});

test("A to B to A admissions never reactivate an earlier unexpired A token", async t => {
  const h = await harness(t), app = await h.app("repeat-sha"), path = `/api/apps/${app.appId}/automation/ci`; await h.post(path, app.input);
  const originalA = await h.token(app.appId, app.repo); assert.equal((await h.machine(originalA.token, "checkpoint-list", {})).status, 200);
  h.heads.set(app.repo, "b".repeat(40)); const secondB = await h.token(app.appId, app.repo);
  assert.equal((await h.machine(originalA.token, "checkpoint-list", {})).status, 403);
  h.heads.set(app.repo, "a".repeat(40)); const latestA = await h.token(app.appId, app.repo);
  const previous = await h.machine(originalA.token, "checkpoint-list", {}); assert.equal(previous.status, 403, "Matching SHA cannot revive an earlier admission");
  assert.deepEqual(await previous.json(), { error: "CI_COMMIT_SUPERSEDED" });
  assert.equal((await h.machine(secondB.token, "checkpoint-list", {})).status, 403);
  assert.equal((await h.machine(latestA.token, "checkpoint-list", {})).status, 200);
  await h.control({ restart: true });
  assert.equal((await h.machine(originalA.token, "checkpoint-list", {})).status, 403, "Admission fence survives DO restart");
  assert.equal((await h.machine(latestA.token, "checkpoint-list", {})).status, 200);
});

test("same SHA new admission retires the old token while exact checkpoint reconciliation remains available", async t => {
  const h = await harness(t), app = await h.app("same-sha"), path = `/api/apps/${app.appId}/automation/ci`; await h.post(path, app.input);
  await h.post(`/api/apps/${app.appId}/automation/policy`, { expectedVersion: 0, enabled: true, channel: "preview", platform: "ios" });
  await h.push(app.repo); const first = await h.token(app.appId, app.repo), claim = await (await h.machine(first.token, "claim", {})).json() as AutomationClaim, exported = await h.upload(first.token, claim);
  assert.equal((await h.machine(first.token, "checkpoint-save", exported.journal)).status, 200);
  const original = await h.machine(first.token, "finalize", { lease: claim.lease, receipt: exported.receipt }); assert.equal(original.status, 200);
  const deployment = (await original.json() as { deployment: { id: string } }).deployment;
  const latest = await h.token(app.appId, app.repo, { run_id: "123457" }); assert.equal(latest.runner.id, first.runner.id); assert.equal(latest.commitSha, first.commitSha);
  const previous = await h.machine(first.token, "checkpoint-list", {}); assert.equal(previous.status, 403); assert.deepEqual(await previous.json(), { error: "CI_COMMIT_SUPERSEDED" });
  assert.deepEqual(await (await h.machine(latest.token, "checkpoint-list", {})).json(), { checkpoints: [exported.journal] });
  const reconciled = await h.machine(latest.token, "finalize", { lease: claim.lease, receipt: exported.receipt }); assert.equal(reconciled.status, 200);
  assert.equal((await reconciled.json() as { deployment: { id: string } }).deployment.id, deployment.id, "Latest admission reads exact committed result without publishing again");
});

test("legacy CI session JSON without admission sequence fails closed and can be replaced safely", async t => {
  const h = await harness(t), app = await h.app("legacy-session"), path = `/api/apps/${app.appId}/automation/ci`; await h.post(path, app.input);
  const legacy = await h.token(app.appId, app.repo);
  await h.control({ sql: "UPDATE flora_ci_sessions SET data=json_remove(data,'$.admissionSequence')" });
  const rejected = await h.machine(legacy.token, "checkpoint-list", {}); assert.equal(rejected.status, 403); assert.deepEqual(await rejected.json(), { error: "CI_SESSION_REJECTED" });
  const current = await h.token(app.appId, app.repo); assert.equal((await h.machine(current.token, "checkpoint-list", {})).status, 200);
});
