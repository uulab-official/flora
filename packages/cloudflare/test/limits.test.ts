import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { D1Database } from "@cloudflare/workers-types";
import type { InventorySnapshot } from "@app-ops/dogfood";
import type { HostedState, SafeLog } from "../src/contracts.ts";
import { bundleBytes, replaceSourceFile, syntheticBaseline, syntheticSourceBundle } from "../../../tests/dogfood-fixtures.ts";
import { createTestRuntime } from "./runtime.ts";

const origin = "https://flora.example.test", email = "owner@example.test", start = 1_800_000_000_000;
const sourceLimit = 1_048_576, baselineLimit = 131_072, responseLimit = 1_048_576;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function sizedJson(value: unknown, size: number): Uint8Array {
  const bytes = bundleBytes(value);
  assert.ok(bytes.length <= size, "Synthetic JSON must fit its requested envelope");
  const padded = new Uint8Array(size).fill(0x20);
  padded.set(bytes);
  return padded;
}
function sourceBytes(size = 752_158, n = 0): Uint8Array {
  const bundle = { ...syntheticSourceBundle(), commitSha: n.toString(16).padStart(40, "a") };
  const path = "src/core/experience/types.ts";
  const empty = replaceSourceFile(bundle, path, "");
  // Most bytes are verified file content, with at most three trailing JSON spaces.
  const length = Math.floor((size - bundleBytes(empty).length) / 4) * 3;
  assert.ok(length >= 3);
  return sizedJson(replaceSourceFile(empty, path, "// " + "x".repeat(length - 3)), size);
}
function baselineBytes(snapshot: InventorySnapshot, size = 6_122, attempt = "limits-attempt"): Uint8Array {
  const bundle = { ...syntheticBaseline(snapshot), attemptKey: attempt, log: "" };
  return bundleBytes({ ...bundle, log: "l".repeat(size - bundleBytes(bundle).length) });
}
function cookies(response: { headers: { getSetCookie(): string[] } }): string {
  return response.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
}
async function harness(t: test.TestContext) {
  const token = randomBytes(32), secret = randomBytes(24).toString("base64url");
  const runtime = await createTestRuntime({
    entrypoint: new URL("./fixtures/hosted-entry.ts", import.meta.url),
    durableObjects: { FLORA_AUTH: "HostedFixtureAuth" },
    bindings: { FLORA_ORIGIN: origin, FLORA_OWNER_ID: "synthetic-owner", FLORA_OWNER_EMAIL: email,
      FLORA_DB_IDENTITY: "synthetic-db", FLORA_SETUP: { digest: digest(token), issuedAt: start,
        expiresAt: start + 600_000, generation: 1, purpose: "enroll" } },
  });
  t.after(() => runtime.dispose());
  const db = runtime.d1 as unknown as D1Database;
  const migration = await readFile(new URL("../migrations/0001_private_imports.sql", import.meta.url), "utf8");
  await db.exec(migration.replace(/^--.*$/gm, "").split(/;\s*(?=CREATE|INSERT|PRAGMA|$)/)
    .filter(value => value.trim()).map(value => value.replace(/\s*\n\s*/g, " ").trim() + ";").join("\n"));
  await db.prepare("INSERT INTO flora_deployment(singleton,owner_id,origin,db_identity) VALUES(1,?,?,?)")
    .bind("synthetic-owner", origin, "synthetic-db").run();
  let jar = "", csrf = "";
  const call = (path: string, body?: Uint8Array | string, headers: Record<string, string> = {}) => runtime.fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Cookie: jar, ...(body === undefined ? {} : { Origin: origin, "Content-Type": "application/json", "X-Flora-CSRF": csrf }), ...headers },
    ...(body === undefined ? {} : { body }),
  });
  const control = (value: unknown) => call("/__test/control", JSON.stringify(value));
  await control({ now: start });
  const enrollment = await call("/api/auth/enroll", JSON.stringify({ email, password: secret, confirmation: secret, token: token.toString("base64url") }));
  assert.equal(enrollment.status, 200);
  jar = cookies(enrollment);
  csrf = (await enrollment.json() as { csrfToken: string }).csrfToken;
  return { runtime, db, call, control, secret, token: token.toString("base64url"), jar, csrf,
    async snapshot(id: string): Promise<InventorySnapshot> {
      const row = await db.prepare("SELECT data FROM inventory_snapshots WHERE id=?").bind(id).first<{ data: string }>();
      assert.ok(row);
      return JSON.parse(row.data) as InventorySnapshot;
    },
    async capacity() { return db.prepare("SELECT snapshot_count,baseline_count,payload_bytes FROM flora_capacity").first<{ snapshot_count: number; baseline_count: number; payload_bytes: number }>(); },
  };
}
async function responseJson<T>(response: { status: number; headers: Pick<Headers, "get">; arrayBuffer(): Promise<ArrayBuffer> }, status = 201): Promise<T> {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.ok(bytes.length <= responseLimit, "Serialized private response is bounded");
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

// Removing hosted admission or reserializing baseline bytes breaks these assertions.
test("supported_size_synthetic_envelopes_keep_limits", async t => {
  const h = await harness(t);
  for (const [index, size] of [752_158, sourceLimit].entries()) {
    const source = sourceBytes(size, index);
    assert.equal(source.length, size);
    const receipt = await responseJson<{ id: string }>(await h.call("/api/sources", source));
    const snapshot = await h.snapshot(receipt.id);
    const parsedSource = JSON.parse(new TextDecoder().decode(source)) as ReturnType<typeof syntheticSourceBundle>;
    assert.deepEqual(snapshot.files.map(file => file.sha256).sort(), parsedSource.files.map(file => file.sha256).sort());
    assert.notEqual(snapshot.digest, digest(source), "Inventory digest is not the envelope byte hash");
    const retry = await responseJson<{ id: string }>(await h.call("/api/sources", bundleBytes({ ...parsedSource,
      fetchedAt: "2026-02-02T03:04:05.000Z", files: parsedSource.files.reverse() })));
    assert.equal(retry.id, receipt.id);
    assert.deepEqual(await h.snapshot(retry.id), snapshot, "Duplicate import keeps first immutable provenance");
    for (const baselineSize of [6_122, baselineLimit]) {
      const baseline = baselineBytes(snapshot, baselineSize, "size-" + baselineSize);
      assert.equal(baseline.length, baselineSize);
      const record = await responseJson<{ id: string; snapshotId: string }>(await h.call("/api/baselines?snapshotId=" + snapshot.id, baseline));
      assert.equal(record.snapshotId, snapshot.id);
      const row = await h.db.prepare("SELECT evidence_digest,stored_bytes FROM baseline_imports WHERE id=?").bind(record.id).first<{ evidence_digest: string; stored_bytes: number }>();
      assert.equal(row!.evidence_digest, digest(baseline));
      assert.ok(row!.stored_bytes <= 524_288);
    }
  }
  const before = await h.capacity();
  const first = (await h.db.prepare("SELECT id FROM inventory_snapshots ORDER BY id LIMIT 1").first<{ id: string }>())!;
  const observation = { repositoryId: "repo_synthetic", rootDirectory: "apps/sample", headCommitSha: "a".repeat(40), observedAt: "2026-02-02T03:04:05.000Z", evidenceOrigin: "operator-import" };
  assert.equal((await h.call("/api/head", sizedJson(observation, 4_096))).status, 204);
  const afterHead = await h.capacity();
  for (const [path, bytes] of [
    ["/api/sources", sourceBytes(sourceLimit + 1, 2)],
    ["/api/baselines?snapshotId=" + first.id, baselineBytes(await h.snapshot(first.id), baselineLimit + 1, "over")],
    ["/api/head", sizedJson(observation, 4_097)],
  ] as const) {
    assert.equal((await h.call(path, bytes)).status, 413);
  }
  assert.deepEqual(await h.capacity(), afterHead);
  assert.equal(before!.snapshot_count, 2);
  assert.equal(before!.baseline_count, 4);
  const sourceRow = await h.db.prepare("SELECT max(stored_bytes) AS bytes FROM inventory_snapshots").first<{ bytes: number }>();
  const baselineRow = await h.db.prepare("SELECT max(stored_bytes) AS bytes FROM baseline_imports").first<{ bytes: number }>();
  t.diagnostic(JSON.stringify({ syntheticSourceBytes: [752_158, sourceLimit], syntheticBaselineBytes: [6_122, baselineLimit],
    maxSourceStoredBytes: sourceRow!.bytes, maxBaselineStoredBytes: baselineRow!.bytes, payloadBytes: afterHead!.payload_bytes }));
});

// This fails if imports use a different guard from password verification or queue passwords.
test("heavy_import_and_login_do_not_overlap", async t => {
  const h = await harness(t);
  const budget = () => h.control({ sql: "SELECT attempts,kdfs FROM flora_auth_budget" }).then(response => response.json());
  const before = await budget();
  assert.equal((await h.control({ holdImport: JSON.stringify(syntheticSourceBundle()) })).status, 200);
  const login = await h.call("/api/auth/login", JSON.stringify({ email, password: h.secret }));
  assert.equal(login.status, 409);
  assert.equal(login.headers.get("Retry-After"), "1");
  assert.deepEqual(await login.json(), { error: "BUSY" });
  assert.deepEqual(await budget(), before, "Rejected login must not reserve or execute KDF");
  assert.equal((await h.call("/api/sources", bundleBytes(syntheticSourceBundle()))).status, 409);
  const released = await (await h.control({ releaseImport: true })).json() as { status: number; body: unknown };
  assert.equal(released.status, 201);
  assert.equal((await h.capacity())!.snapshot_count, 1);
  assert.equal((await h.call("/api/auth/login", JSON.stringify({ email, password: h.secret }))).status, 200);
});

// Full evidence in page projections would exceed the response ceiling for these rows.
test("maximum_history_page_stays_bounded", async t => {
  const h = await harness(t);
  const ids: string[] = [];
  for (let n = 0; n < 21; n++) {
    const receipt = await responseJson<{ id: string }>(await h.call("/api/sources", bundleBytes({ ...syntheticSourceBundle(), commitSha: n.toString(16).padStart(40, "a") })));
    ids.push(receipt.id);
  }
  const selected = await h.snapshot(ids[0]!);
  const records: string[] = [];
  for (let n = 0; n < 21; n++) {
    const receipt = await responseJson<{ id: string }>(await h.call("/api/baselines?snapshotId=" + selected.id, baselineBytes(selected, baselineLimit, "page-" + n)));
    records.push(receipt.id);
  }
  const first = await responseJson<HostedState>(await h.call("/api/state?snapshotId=" + selected.id), 200);
  assert.equal(first.selected!.id, selected.id);
  assert.equal(first.runner, "unavailable");
  assert.equal(first.snapshots.items.length, 20);
  assert.equal(first.history.items.length, 20);
  assert.ok(first.snapshots.nextCursor);
  assert.ok(first.history.nextCursor);
  for (const summary of first.history.items) {
    assert.equal(summary.logTruncated, true);
    for (const field of ["evidence", "report", "reportBase64", "log", "safeLog"]) assert.equal(Object.hasOwn(summary, field), false);
  }
  const query = new URLSearchParams({ snapshotId: selected.id, snapshotCursor: first.snapshots.nextCursor, historyCursor: first.history.nextCursor });
  const last = await responseJson<HostedState>(await h.call("/api/state?" + query), 200);
  assert.equal(last.selected!.id, selected.id);
  assert.equal(last.snapshots.items.length, 1);
  assert.equal(last.history.items.length, 1);
  assert.equal(last.snapshots.nextCursor, null);
  assert.equal(last.history.nextCursor, null);
  assert.deepEqual([...first.snapshots.items, ...last.snapshots.items].map(value => value.id).sort(), ids.sort());
  assert.deepEqual([...first.history.items, ...last.history.items].map(value => value.id).sort(), records.sort());
  const log = await responseJson<SafeLog>(await h.call("/api/baselines/" + records[0] + "/log"), 200);
  assert.equal(Buffer.byteLength(log.safeLog), 65_536);
  assert.equal(log.logTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(log)) <= 65_536 + 256, "ASCII synthetic log has bounded JSON overhead");
  assert.equal((await h.call("/api/baselines/" + records[0] + "/log", undefined, { Cookie: "" })).status, 401);
  t.diagnostic(JSON.stringify({ firstPageJsonBytes: Buffer.byteLength(JSON.stringify(first)), logJsonBytes: Buffer.byteLength(JSON.stringify(log)),
    historyPages: [first.history.items.length, last.history.items.length], safeLogBytes: Buffer.byteLength(log.safeLog) }));
});

// New-row rejection must not discard immutable duplicate receipts, including response loss.
test("capacity_denies_only_new_rows", async t => {
  const h = await harness(t), firstSource = bundleBytes(syntheticSourceBundle());
  const first = await responseJson<{ id: string }>(await h.call("/api/sources", firstSource));
  const snapshot = await h.snapshot(first.id), original = baselineBytes(snapshot);
  await h.control({ loseResponse: true });
  assert.equal((await h.call("/api/baselines?snapshotId=" + snapshot.id, original)).status, 503);
  const committed = await h.db.prepare("SELECT id,evidence_digest FROM baseline_imports").first<{ id: string; evidence_digest: string }>();
  assert.ok(committed);
  assert.equal(committed.evidence_digest, digest(original));
  for (let n = 0; n < 99; n++) {
    await responseJson(await h.call("/api/sources", bundleBytes({ ...syntheticSourceBundle(), commitSha: n.toString(16).padStart(40, "b") })));
  }
  for (let n = 1; n < 500; n++) {
    await responseJson(await h.call("/api/baselines?snapshotId=" + snapshot.id, baselineBytes(snapshot, 6_122, "capacity-" + n)));
  }
  const before = await h.capacity();
  assert.equal(before!.snapshot_count, 100);
  assert.equal(before!.baseline_count, 500);
  assert.ok(before!.payload_bytes <= 134_217_728);
  const retry = await responseJson<{ id: string; evidence: { evidenceDigest: string } }>(await h.call("/api/baselines?snapshotId=" + snapshot.id, original));
  assert.equal(retry.id, committed.id);
  assert.equal(retry.evidence.evidenceDigest, committed.evidence_digest);
  assert.equal((await responseJson<{ id: string }>(await h.call("/api/sources", firstSource))).id, first.id);
  assert.equal((await h.call("/api/sources", bundleBytes({ ...syntheticSourceBundle(), commitSha: "c".repeat(40) }))).status, 409);
  assert.equal((await h.call("/api/baselines?snapshotId=" + snapshot.id, baselineBytes(snapshot, 6_122, "capacity-over"))).status, 409);
  assert.deepEqual(await h.capacity(), before);
  assert.deepEqual(await h.snapshot(first.id), snapshot);
  assert.equal((await h.call("/api/state?snapshotId=" + snapshot.id)).status, 200);
  t.diagnostic(JSON.stringify({ snapshotsAtCapacity: before!.snapshot_count, baselinesAtCapacity: before!.baseline_count,
    payloadBytes: before!.payload_bytes, lostResponseReceiptRecovered: true }));
});

// Cold authority state must enforce durable budgets and the same five-session limit.
test("cold_warm_sessions_and_rate_windows_remain_bounded", async t => {
  const h = await harness(t), jars = [h.jar];
  for (let n = 1; n < 5; n++) {
    await h.control({ now: start + n });
    const login = await h.call("/api/auth/login", JSON.stringify({ email, password: h.secret }));
    assert.equal(login.status, 200);
    jars.push(cookies(login));
  }
  await h.control({ evict: true });
  for (const jar of jars) assert.equal((await h.call("/api/state", undefined, { Cookie: jar })).status, 200);
  const denied = await h.call("/api/auth/login", JSON.stringify({ email, password: h.secret }));
  assert.equal(denied.status, 429);
  const retryAfter = Number(denied.headers.get("Retry-After"));
  assert.ok(retryAfter >= 1 && retryAfter <= 900);
  await h.control({ now: start + 900_000 });
  const sixth = await h.call("/api/auth/login", JSON.stringify({ email, password: h.secret }));
  assert.equal(sixth.status, 200);
  jars.push(cookies(sixth));
  assert.equal((await h.call("/api/state", undefined, { Cookie: jars[0]! })).status, 401);
  for (const jar of jars.slice(1)) assert.equal((await h.call("/api/state", undefined, { Cookie: jar })).status, 200);
  assert.deepEqual(await (await h.control({ sql: "SELECT count(*) AS n FROM flora_auth_sessions" })).json(), [{ n: 5 }]);
  // Test-only precondition for the otherwise unreachable defense-in-depth hourly cap.
  await h.control({ sql: "UPDATE flora_auth_budget SET attempts=0,kdfs=60" });
  assert.equal((await h.call("/api/auth/login", JSON.stringify({ email, password: h.secret }))).status, 429);
  await h.control({ now: start + 3_600_000, restart: true });
  assert.equal((await h.call("/api/auth/login", JSON.stringify({ email, password: h.secret }))).status, 200);
  assert.deepEqual(await (await h.control({ sql: "SELECT attempts,kdfs FROM flora_auth_budget" })).json(), [{ attempts: 1, kdfs: 1 }]);
});

// A logging regression in auth, upload or dependency failure must reveal a synthetic marker here.
test("no_auth_or_private_values_in_captured_logs", async t => {
  const h = await harness(t);
  await h.control({ probeConsole: true });
  const probe = await (await h.control({ captureConsole: true })).json() as { logs: unknown[] };
  assert.ok(JSON.stringify(probe.logs).includes("SYNTHETIC_CAPTURE_PROBE"), "Console interception must capture a positive control");
  // Retain the captured enrollment output too; clearing here would miss setup-token leakage.
  const source = sourceBytes(752_158), snapshot = await responseJson<InventorySnapshot>(await h.call("/api/sources", source));
  const privateLog = "SYNTHETIC_PRIVATE_LOG_" + randomBytes(16).toString("hex");
  const baseline = bundleBytes({ ...syntheticBaseline(snapshot), log: privateLog });
  const record = await responseJson<{ id: string }>(await h.call("/api/baselines?snapshotId=" + snapshot.id, baseline));
  assert.equal((await h.call("/api/baselines/" + record.id + "/log")).status, 200);
  assert.equal((await h.call("/api/auth/login", JSON.stringify({ email, password: h.secret }))).status, 200);
  const failedSecret = randomBytes(24).toString("base64url");
  assert.equal((await h.call("/api/auth/login", JSON.stringify({ email, password: failedSecret }))).status, 401);
  await h.control({ failD1: true });
  const failed = await h.call("/api/sources", sourceBytes(752_158, 1));
  assert.deepEqual(await responseJson(failed, 503), { error: "DEPENDENCY_UNAVAILABLE" });
  await h.control({ failD1: false, failAuth: true });
  for (const path of ["/api/state", "/app.js"]) {
    const response = await h.call(path);
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /PRIVATE|SYNTHETIC|quota|SQL/);
  }
  await h.control({ failAuth: false });
  const captured = await (await h.control({ captureConsole: true })).json() as { logs: unknown[] };
  assert.ok(Array.isArray(captured.logs));
  const text = JSON.stringify(captured.logs);
  const rawCookies = h.jar.split("; ").map(value => value.slice(value.indexOf("=") + 1));
  for (const value of [h.secret, failedSecret, h.token, h.csrf, h.jar, ...rawCookies, privateLog, snapshot.digest,
    snapshot.repository.fullName, "SYNTHETIC_PRIVATE_D1_QUOTA", "SYNTHETIC_PRIVATE_AUTH_QUOTA", "__Host-flora_session", "X-Flora-CSRF"]) {
    assert.equal(text.includes(value), false, "Captured logs must not contain an authentication/private marker");
  }
  assert.equal((await h.capacity())!.snapshot_count, 1);
  assert.equal((await h.capacity())!.baseline_count, 1);
  assert.equal((await h.call("/api/state")).status, 200);
});

test("import_deadline_releases_guard_without_writing", async t => {
  const h = await harness(t), before = await h.capacity();
  assert.equal((await h.call("/__test/slow-import", undefined, { "X-Flora-CSRF": h.csrf })).status, 408);
  assert.deepEqual(await h.capacity(), before);
  assert.equal((await h.call("/api/auth/login", JSON.stringify({ email, password: h.secret }))).status, 200);
  await responseJson(await h.call("/api/sources", bundleBytes(syntheticSourceBundle())));
});
