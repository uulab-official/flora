import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { createTestRuntime } from "./runtime.ts";
import { bundleBytes, syntheticBaseline, syntheticSourceBundle } from "../../../tests/dogfood-fixtures.ts";
import { parseSourceBundle } from "@app-ops/dogfood";
import type { HostedState } from "../src/contracts.ts";

const origin = "https://flora.example.test", email = "owner@example.test", now = 1_800_000_000_000;
async function harness(t: TestContext) {
  assert.ok(await access(new URL("../dist/worker.js", import.meta.url)).then(() => true, () => false), "Hosted Worker routing must be implemented and built");
  const token = randomBytes(32), secret = randomBytes(24).toString("base64url");
  const runtime = await createTestRuntime({ entrypoint: new URL("./fixtures/hosted-entry.ts", import.meta.url), durableObjects: { FLORA_AUTH: "HostedFixtureAuth" }, bindings: {
    FLORA_ORIGIN: origin, FLORA_OWNER_ID: "synthetic-owner", FLORA_OWNER_EMAIL: email, FLORA_DB_IDENTITY: "synthetic-db",
    FLORA_SETUP: { digest: createHash("sha256").update(token).digest("hex"), issuedAt: now, expiresAt: now + 600000, generation: 1, purpose: "enroll" },
  }});
  t.after(() => runtime.dispose());
  const firstMigration = await readFile(new URL("../migrations/0001_private_imports.sql", import.meta.url), "utf8");
  const migration = firstMigration + "\n" + await readFile(new URL("../migrations/0002_multi_app.sql", import.meta.url), "utf8") + "\n" + await readFile(new URL("../migrations/0003_github_ota.sql", import.meta.url), "utf8") + "\n" + await readFile(new URL("../migrations/0004_automation.sql", import.meta.url), "utf8");
  await runtime.d1.exec(migration.replace(/^--.*$/gm, "").split(/;\s*(?=CREATE|INSERT|PRAGMA|$)/).filter(s => s.trim()).map(s => s.replace(/\s*\n\s*/g, " ").trim() + ";").join("\n"));
  await runtime.d1.prepare("INSERT INTO flora_deployment(singleton,owner_id,origin,db_identity) VALUES(1,?,?,?)").bind("synthetic-owner", origin, "synthetic-db").run();
  let cookie = "", csrf = "";
  const call = (path: string, body?: string | Uint8Array, headers: Record<string, string> = {}, method = body === undefined ? "GET" : "POST") => runtime.fetch(origin + path, { method, headers: { Cookie: cookie, ...(body === undefined ? {} : { Origin: origin, "Content-Type": "application/json", "X-Flora-CSRF": csrf }), ...headers }, ...(body === undefined ? {} : { body }) });
  const control = async (body: unknown) => call("/__test/control", JSON.stringify(body));
  const enroll = await call("/api/auth/enroll", JSON.stringify({ email, password: secret, confirmation: secret, token: token.toString("base64url") }));
  assert.equal(enroll.status, 200);
  cookie = enroll.headers.getSetCookie().map(c => c.split(";", 1)[0]).join("; ");
  csrf = (await enroll.json() as { csrfToken: string }).csrfToken;
  return { runtime, call, control, cookie, csrf, secret };
}

// Removing front admission or touching the request stream makes these guards fail.
test("hosted multi-app API registers two repositories and separates settings history and logs", async t => {
  const h = await harness(t);
  const bundles = [syntheticSourceBundle(), { ...syntheticSourceBundle(), repository: { id: "hosted-second", fullName: "synthetic/second", visibility: "private" as const } }];
  const post = (path: string, value: unknown) => h.call(path, JSON.stringify(value));
  const apps: string[] = [], snapshots: string[] = [], records: string[] = [];
  for (const [i, bundle] of bundles.entries()) {
    const registered = await post("/api/apps", { name: `Hosted ${i + 1}`, repositoryId: bundle.repository.id, rootDirectory: bundle.rootDirectory });
    assert.equal(registered.status, 201); const app = await registered.json() as { id: string }; apps.push(app.id);
    const empty = await h.call(`/api/state?appId=${app.id}`); assert.equal(empty.status, 200);
    const initial = await empty.json() as HostedState;
    assert.equal(initial.selectedApplication?.id, app.id); assert.equal(initial.selected, null);
    const imported = await post(`/api/sources?appId=${app.id}`, bundle); assert.equal(imported.status, 201);
    const snapshot = await imported.json() as import("@app-ops/dogfood").InventorySnapshot; snapshots.push(snapshot.id);
    const baseline = await post(`/api/baselines?appId=${app.id}&snapshotId=${snapshot.id}`, { ...syntheticBaseline(snapshot), log: `hosted-app-${i + 1}` });
    assert.equal(baseline.status, 201); records.push((await baseline.json() as { id: string }).id);
    const config = await post(`/api/apps/${app.id}/settings`, { expectedVersion: 0, values: { APP_LABEL: `config-${i + 1}` } });
    assert.equal(config.status, 200); await config.json();
  }
  for (const [i, appId] of apps.entries()) {
    const response = await h.call(`/api/state?appId=${appId}`); assert.equal(response.status, 200);
    const state = await response.json() as HostedState;
    assert.equal(state.applications?.length, 2);
    assert.deepEqual(state.selectedApplication?.settings.values, { APP_LABEL: `config-${i + 1}` });
    assert.deepEqual(state.snapshots.items.map(row => row.id), [snapshots[i]]);
    assert.deepEqual(state.history.items.map(row => row.id), [records[i]]);
    const log = await h.call(`/api/baselines/${records[i]}/log?appId=${appId}`); assert.equal(log.status, 200);
    assert.equal((await log.json() as { safeLog: string }).safeLog, `hosted-app-${i + 1}`);
  }
  for (const path of [`/api/state?appId=${apps[0]}&snapshotId=${snapshots[1]}`, `/api/baselines/${records[1]}/log?appId=${apps[0]}`]) {
    const rejected = await h.call(path); assert.equal(rejected.status, 404); await rejected.json();
  }
  const mismatch = await post(`/api/baselines?appId=${apps[0]}&snapshotId=${snapshots[1]}`, {});
  assert.equal(mismatch.status, 404); await mismatch.json();
  const stale = await post(`/api/apps/${apps[0]}/settings`, { expectedVersion: 0, values: { APP_LABEL: "stale" } });
  assert.equal(stale.status, 409); await stale.json();
  const blocked = await h.call("/api/apps"); assert.equal(blocked.status, 200); assert.equal((await blocked.json() as unknown[]).length, 2);
  const unauthed = await h.call("/api/apps", undefined, { Cookie: "" }); assert.equal(unauthed.status, 401); await unauthed.json();
});

test("a full registry of long valid repository identities keeps app listing and scoped state readable", async t => {
  const h = await harness(t);
  let lastAppId = "", lastRepository = "";
  for (let i = 0; i < 100; i++) {
    lastRepository = "한".repeat(4090) + i.toString().padStart(6, "0");
    const result = await h.call("/api/apps", JSON.stringify({ name: "앱".repeat(250) + i.toString().padStart(6, "0"), repositoryId: lastRepository, rootDirectory: "." }));
    assert.equal(result.status, 201); lastAppId = (await result.json() as { id: string }).id;
  }
  const list = await h.call("/api/apps"); assert.equal(list.status, 200);
  const bytes = await list.text(); assert.ok(Buffer.byteLength(bytes) < 100_000);
  const applications = JSON.parse(bytes); assert.equal(applications.length, 100);
  assert.deepEqual(Object.keys(applications[0]).sort(), ["createdAt", "id", "name"]);
  const state = await h.call(`/api/state?appId=${lastAppId}`); assert.equal(state.status, 200);
  const selected = await state.json() as HostedState;
  assert.equal(selected.applications?.length, 100);
  assert.equal(selected.selectedApplication?.repositoryId, lastRepository);
});

test("front_forwards_original_stream_without_read_or_tee", async t => {
  const h = await harness(t);
  const result = await h.call("/__test/front-probe");
  assert.deepEqual(await result.json(), { status: 207, calls: 1, sameRequest: true, reads: 0, body: "streamed response" });
});

test("private_asset_requires_live_do_verdict", async t => {
  const h = await harness(t);
  const document = await h.call("/"); assert.equal(document.status, 200); assert.match(await document.text(), /PRIVATE_ASSET/);
  for (const path of ["/app.js", "/app.css"]) {
    const live = await h.call(path); assert.equal(live.status, 200); assert.match(await live.text(), /PRIVATE_ASSET/);
    assert.equal((await h.call(path, undefined, { Cookie: "" })).status, 401);
  }
  assert.equal((await h.call("/api/auth/logout", "{}")).status, 200);
  for (const path of ["/app.js", "/app.css"]) assert.equal((await h.call(path)).status, 401);
});

test("unauthenticated_document_entry_redirects_to_login_without_exposing_private_assets", async t => {
  const h = await harness(t);
  const assertLogin = async (cookie = "") => {
    const response = await h.runtime.fetch(origin + "/", { redirect: "manual", headers: { Cookie: cookie } });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("Location"), "/login");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
    assert.equal(response.headers.get("X-Frame-Options"), "DENY");
    assert.doesNotMatch(await response.text(), /PRIVATE_ASSET|synthetic-owner|owner@example/);
  };
  await assertLogin();
  assert.equal((await h.call("/api/auth/logout", "{}")).status, 200);
  await assertLogin(h.cookie);
  for (const path of ["/app.js", "/app.css", "/api/state", "/api/apps"]) {
    const response = await h.call(path);
    assert.equal(response.status, 401, path);
    assert.equal(response.headers.get("Location"), null, path);
    assert.deepEqual(await response.json(), { error: "UNAUTHENTICATED" }, path);
  }
});

test("alternate_origin_alias_and_preview_never_bypass", async t => {
  const h = await harness(t);
  for (const host of ["https://alias.example.test", "https://flora.workers.dev", "https://preview.flora.workers.dev", "http://flora.example.test"]) {
    for (const path of ["/", "/app.js"]) {
      const response = await h.runtime.fetch(host + path, { headers: { Cookie: h.cookie, "X-Forwarded-Host": "flora.example.test", "X-Flora-Owner": "synthetic-owner" } });
      assert.equal(response.status, 403); assert.equal(response.headers.get("Location"), null); assert.doesNotMatch(await response.text(), /PRIVATE_ASSET/);
    }
  }
  for (const path of ["/index.html", "/auth.html", "/app", "/app.js/", "/%61pp.js", "/_internal/session-check", "/api/runs", "/api/cancel"]) assert.equal((await h.call(path)).status, 404, path);
  for (const path of ["/?returnTo=https://external.example", "/login?x=1", "/setup?token=private", "/app.js?v=1", "/api/auth/session?x=1", "/api/state?snapshotId=a&snapshotId=b", "/api/state?other=1", "/api/baselines"]) assert.equal((await h.call(path, path === "/api/baselines" ? "{}" : undefined)).status, 400, path);
  for (const path of ["/login", "/api/state", "/api/auth/login"]) assert.equal((await h.call(path, undefined, {}, "OPTIONS")).status, 405);
  for (const path of ["/login", "/setup", "/auth.js", "/auth.css"]) {
    const response = await h.call(path, undefined, { Cookie: "" }); assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /owner@example|synthetic-owner|PRIVATE_ASSET/);
  }
});

test("csrf_origin_and_content_metadata_rejected_before_body", async t => {
  const h = await harness(t);
  const results = await (await h.call("/__test/admission-probe", undefined, { "X-Flora-CSRF": h.csrf })).json() as { status: number; reads: number }[];
  assert.deepEqual(results.map(r => r.status), [403, 403, 415, 415, 413, 400, 405, 400, 415]);
  assert.ok(results.every(r => r.reads === 0));
});

test("quota_failure_discloses_nothing", async t => {
  const h = await harness(t);
  await h.control({ failD1: true });
  for (const path of ["/api/state", "/api/baselines/verification_missing/log"]) {
    const response = await h.call(path); assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "DEPENDENCY_UNAVAILABLE" });
  }
  await h.control({ failAuth: true });
  for (const path of ["/", "/app.js"]) {
    const response = await h.call(path); assert.equal(response.status, 503);
    assert.equal(response.headers.get("Location"), null);
    assert.doesNotMatch(await response.text(), /PRIVATE|quota|SYNTHETIC/);
  }
});
test("known D1 daily read failure stays authenticated, fixed and private through real Worker and owner DO", async t => {
  const h = await harness(t);
  await h.control({ probeConsole: true, failD1: "daily-read" });
  for (const path of ["/api/state", "/api/projects", "/api/apps/application_fixture/automation"]) {
    const response = await h.call(path); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "D1_DAILY_READ_LIMIT" });
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal((await h.call(path, undefined, { Cookie: "" })).status, 401);
  }
  assert.equal((await h.call("/api/auth/session")).status, 200, "D1 classification must not change independent authority");
  const capture = await (await h.control({ captureConsole: true })).json() as { logs: unknown[] };
  assert.match(JSON.stringify(capture.logs), /SYNTHETIC_CAPTURE_PROBE/);
  assert.doesNotMatch(JSON.stringify(capture.logs), /SYNTHETIC_PRIVATE_D1_TOKEN|PRIVATE_SQL|free tier daily/);
});

test("original_baseline_guard_survives_do_path", async t => {
  const h = await harness(t), source = syntheticSourceBundle(), expected = await parseSourceBundle(bundleBytes(source), now);
  const imported = await h.call("/api/sources", bundleBytes(source)); assert.equal(imported.status, 201);
  const snapshot = await imported.json() as typeof expected;
  assert.equal(snapshot.digest, expected.digest); assert.deepEqual(snapshot.files, expected.files);
  assert.equal(Object.hasOwn(snapshot, "evidenceDigest"), false);
  const duplicate = await h.call("/api/sources", bundleBytes({ ...source, fetchedAt: "2026-03-04T03:04:05.000Z", files: [...source.files].reverse() }));
  assert.equal((await duplicate.json() as typeof expected).id, snapshot.id);
  const bytes = bundleBytes(syntheticBaseline(snapshot));
  const baseline = await h.call("/api/baselines?snapshotId=" + snapshot.id, bytes); assert.equal(baseline.status, 201);
  const receipt = await baseline.json() as { id: string; evidence: { evidenceDigest: string } };
  assert.equal(receipt.evidence.evidenceDigest, createHash("sha256").update(bytes).digest("hex"));
  const state = await (await h.call("/api/state")).json() as HostedState;
  assert.equal(state.history.items[0]?.id, receipt.id); assert.equal(state.history.items[0]?.evidenceDigest, receipt.evidence.evidenceDigest);
  assert.equal(Object.hasOwn(state.history.items[0]!, "evidence"), false); assert.equal(Object.hasOwn(state.history.items[0]!, "safeLog"), false);
  const log = await h.call("/api/baselines/" + receipt.id + "/log"); assert.equal(log.status, 200);
  const unauth = await h.call("/api/baselines/" + receipt.id + "/log", undefined, { Cookie: "" }); assert.equal(unauth.status, 401);
});

test("two_browser_sessions_revisit_same_imports", async t => {
  const h = await harness(t);
  const snapshot = await (await h.call("/api/sources", bundleBytes(syntheticSourceBundle()))).json() as { id: string };
  const second = await h.call("/api/auth/login", JSON.stringify({ email, password: h.secret })); assert.equal(second.status, 200);
  const secondCookie = second.headers.getSetCookie().map(c => c.split(";", 1)[0]).join("; ");
  const secondCsrf = (await second.json() as { csrfToken: string }).csrfToken;
  assert.notEqual(secondCookie, h.cookie);
  const before = await (await h.call("/api/state")).json();
  assert.deepEqual(await (await h.call("/api/state", undefined, { Cookie: secondCookie })).json(), before);
  const selected = (before as HostedState).selected!;
  const baseline = await h.call("/api/baselines?snapshotId=" + snapshot.id, bundleBytes(syntheticBaseline(selected)), { Cookie: secondCookie, "X-Flora-CSRF": secondCsrf }); assert.equal(baseline.status, 201);
  await h.control({ restart: true });
  const firstState = await (await h.call("/api/state")).json() as HostedState;
  assert.equal(firstState.history.items.length, 1);
  assert.deepEqual(await (await h.call("/api/state", undefined, { Cookie: secondCookie })).json(), firstState);
});

test("page_navigation_preserves_selected_snapshot", async t => {
  const h = await harness(t);
  let selected = "";
  for (let i = 0; i < 21; i++) {
    const response = await h.call("/api/sources", bundleBytes({ ...syntheticSourceBundle(), commitSha: i.toString(16).padStart(40, "a") })); assert.equal(response.status, 201);
    if (i === 0) selected = (await response.json() as { id: string }).id;
  }
  const first = await (await h.call("/api/state?snapshotId=" + selected)).json() as HostedState;
  assert.equal(first.snapshots.items.length, 20); assert.ok(first.snapshots.nextCursor);
  const second = await (await h.call("/api/state?snapshotId=" + selected + "&snapshotCursor=" + first.snapshots.nextCursor)).json() as HostedState;
  assert.equal(second.snapshots.items.length, 1); assert.equal(second.selected?.id, selected);
  const unselected = await (await h.call("/api/state?snapshotCursor=" + first.snapshots.nextCursor)).json() as HostedState;
  assert.equal(unselected.selected?.id, first.snapshots.items[0]!.id);
});

test("revoked_during_parse_never_submits_write", async t => {
  const h = await harness(t);
  await h.control({ revokeBeforeD1Read: true });
  const response = await h.call("/api/sources", bundleBytes(syntheticSourceBundle())); assert.equal(response.status, 401);
  assert.equal((await h.runtime.d1.prepare("SELECT COUNT(*) AS n FROM inventory_snapshots").first<{ n: number }>())!.n, 0);
  assert.equal((await (await h.control({ stats: true })).json() as { writes: number }).writes, 0);
});

test("already_submitted_write_can_finish_and_retry", async t => {
  const h = await harness(t);
  await h.control({ revokeAfterSubmission: true, loseResponse: true });
  const bytes = bundleBytes(syntheticSourceBundle());
  assert.equal((await h.call("/api/sources", bytes)).status, 503);
  const committed = await h.runtime.d1.prepare("SELECT id FROM inventory_snapshots").first<{ id: string }>(); assert.ok(committed);
  assert.equal((await h.call("/api/sources", bytes)).status, 401);
  const login = await h.call("/api/auth/login", JSON.stringify({ email, password: h.secret })); assert.equal(login.status, 200);
  const jar = login.headers.getSetCookie().map(c => c.split(";", 1)[0]).join("; "), csrf = (await login.json() as { csrfToken: string }).csrfToken;
  const retry = await h.call("/api/sources", bytes, { Cookie: jar, "X-Flora-CSRF": csrf }); assert.equal(retry.status, 201);
  assert.equal((await retry.json() as { id: string }).id, committed.id);
});

test("body_limits_are_exact", async t => {
  const h = await harness(t);
  const snapshot = await (await h.call("/api/sources", bundleBytes(syntheticSourceBundle()))).json() as { id: string };
  for (const [path, limit] of [["/api/sources", 1048576], ["/api/baselines?snapshotId=" + snapshot.id, 131072], ["/api/head", 4096]] as const) {
    assert.equal((await h.call(path, " ".repeat(limit))).status, 400, path);
    const oversized = await h.call("/__test/stream-size-probe", JSON.stringify({ path, bodyBase64: Buffer.alloc(limit + 1, 0x20).toString("base64") }));
    assert.equal(oversized.status, 200, path);
    const measured = await oversized.json() as { status: number; body: unknown; reads: number; bytesRead: number; contentLength: string | null; writes: number };
    assert.deepEqual({ status: measured.status, body: measured.body }, { status: 413, body: { error: "BODY_TOO_LARGE" } }, path);
    assert.equal(measured.contentLength, null);
    assert.equal(measured.bytesRead, limit + 1);
    assert.ok(measured.reads > 0);
    assert.equal(measured.writes, 0);
    const declared = await h.call("/__test/declared-size-probe", JSON.stringify({ path, length: limit + 1 }));
    assert.equal(declared.status, 200, path);
    assert.deepEqual(await declared.json(), { status: 413, body: { error: "BODY_TOO_LARGE" }, reads: 0, authorityCalls: 0 }, path);
  }
  const response = await h.call("/__test/body-probe", undefined, { "X-Flora-CSRF": h.csrf });
  assert.deepEqual(await response.json(), { missing: 400, lying: 413, mismatched: 400, cancelled: 400, writes: 1 });
});

test("absolute_body_deadline_cancels_and_releases_import_guard", async t => {
  const h = await harness(t);
  const response = await h.call("/__test/slow-import", undefined, { "X-Flora-CSRF": h.csrf }); assert.equal(response.status, 408);
  assert.equal((await h.call("/api/sources", bundleBytes(syntheticSourceBundle()))).status, 201);
});

test("all_responses_have_security_headers_without_cors", async t => {
  const h = await harness(t);
  for (const path of ["/", "/login", "/api/state", "/api/auth/session", "/missing"]) {
    const response = await h.call(path);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.match(response.headers.get("Content-Security-Policy")!, /default-src 'none'/);
    const policy = response.headers.get("Content-Security-Policy")!;
    assert.ok(policy.includes(path === "/" ? "form-action 'self' https://github.com;" : "form-action 'self';"), path);
    if (path !== "/") assert.ok(!policy.includes("https://github.com"), path);
    assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
    assert.equal(response.headers.get("X-Frame-Options"), "DENY");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  }
});
