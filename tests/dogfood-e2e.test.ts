import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { performance } from "node:perf_hooks";
import { runCli } from "@app-ops/cli";
import * as dbapi from "@app-ops/db";
import * as dashboard from "@app-ops/dashboard";
import { createDogfoodService } from "@app-ops/dashboard/service";
import { bundleBytes, syntheticSourceBundle, syntheticBaseline, syntheticVerificationProvider, syntheticProviderResult, confirmedSyntheticCleanup } from "./dogfood-fixtures.ts";
import type { RunInput, ProviderResult, CleanupReport } from "@app-ops/runner-protocol";
import type { DashboardState } from "@app-ops/dashboard/service";

async function fixture(t: TestContext, run: (root: string) => Promise<void>) {
  const mask = process.umask(), root = await fs.mkdtemp(join(await fs.realpath(os.tmpdir()), "flora-e2e-"));
  t.mock.method(os, "homedir", () => root);
  try { await run(root); }
  finally { process.umask(mask); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
async function cli(args: string[]) {
  let stdout = "", stderr = "";
  const code = await runCli(["dogfood", ...args], { stdout: value => { stdout += value; }, stderr: value => { stderr += value; }, readFile: async () => { throw new Error("legacy reader"); } });
  assert.equal(code, 0, stderr); return JSON.parse(stdout);
}
async function seed(root: string) {
  const file = join(root, "source.json"); await fs.writeFile(file, bundleBytes(syntheticSourceBundle()));
  const source = await cli(["import-source", "--file", file]);
  const path = join(root, ".flora", "dogfood", "state.db"), db = dbapi.openDatabase(path);
  const snapshot = dbapi.getInventory(db, source.snapshotId)!; db.close();
  const baseline = join(root, "baseline.json"); await fs.writeFile(baseline, bundleBytes(syntheticBaseline(snapshot)));
  const result = await cli(["import-baseline", "--snapshot", snapshot.id, "--file", baseline]);
  return { path, snapshot, verificationId: result.verificationId as string, file };
}

// Inject only a synthetic os.homedir() in a child; preserve HOME and all transport settings.
const entry = resolve("packages/cli/dist/main.js");
const childCode = `(async () => {
  const os = require('node:os'); const { pathToFileURL } = require('node:url');
  const [profile, entry, ...args] = process.argv.slice(1); os.homedir = () => profile;
  process.argv = [process.execPath, entry, ...args];
  if (process.send) process.on('message', message => { if (message === 'graceful-stop') process.emit('SIGTERM'); });
  try { await import(pathToFileURL(entry).href); } finally { if (process.connected) process.disconnect(); }
})();`;
function childArgs(root: string, args: string[]) { return ["-e", childCode, root, entry, "dogfood", ...args]; }
async function startChild(root: string, demo = false) {
  const args = demo ? ["-e", childCode, root, resolve("scripts/dogfood-demo.mjs"), "--serve"] : childArgs(root, ["serve", "--port", "0"]);
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const exited = once(child, "exit");
  let stdout = "", stderr = "";
  child.stderr!.setEncoding("utf8"); child.stderr!.on("data", chunk => { stderr += chunk; });
  const bootstrapUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Server did not start within 10 seconds")); }, 10_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Server exited before bootstrap: " + stderr)); });
    child.stdout!.setEncoding("utf8"); child.stdout!.on("data", chunk => {
      stdout += chunk;
      const line = stdout.split("\n")[0];
      if (line && stdout.includes("\n")) { clearTimeout(timer); resolve(line); }
    });
  });
  assert.ok(/^http:\/\/127\.0\.0\.1:\d+\/#\S+$/.test(bootstrapUrl), "CLI prints one loopback bootstrap URL");
  return { child, bootstrapUrl, origin: new URL(bootstrapUrl).origin, exited, output: () => ({ stdout, stderr }) };
}
async function stopChild(app: Awaited<ReturnType<typeof startChild>>, abrupt = false) {
  if (app.child.exitCode !== null || app.child.signalCode !== null) return;
  if (abrupt) app.child.kill("SIGKILL");
  else if (process.platform === "win32") app.child.send("graceful-stop");
  else app.child.kill("SIGTERM");
  await app.exited;
}
function http(origin: string, path: string, method = "GET", headers: Record<string, string> = {}, body?: unknown) {
  return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; text: string; value: any }>((resolve, reject) => {
    const req = request(origin + path, { method, headers, agent: false }, res => {
      let text = ""; res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; });
      res.on("error", reject);
      res.on("end", () => {
        try { resolve({ status: res.statusCode!, headers: res.headers, text, value: text ? JSON.parse(text) : null }); }
        catch { reject(new Error("API did not return JSON")); }
      });
    });
    req.setTimeout(12_000, () => req.destroy(new Error("Synthetic request timeout"))); req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function login(app: { origin: string; bootstrapUrl: string }) {
  const res = await http(app.origin, "/api/session", "POST", { Origin: app.origin, "Content-Type": "application/json" }, { bootstrap: new URL(app.bootstrapUrl).hash.slice(1) });
  assert.equal(res.status, 200);
  const Cookie = res.headers["set-cookie"]![0]!.split(";")[0]!;
  return { Cookie, Origin: app.origin, "Content-Type": "application/json", "X-Flora-CSRF": res.value.csrfToken as string };
}
async function state(app: { origin: string }, headers: Record<string, string>, id: string): Promise<DashboardState> {
  const response = await http(app.origin, "/api/state?snapshotId=" + encodeURIComponent(id), "GET", headers);
  assert.equal(response.status, 200); return response.value;
}
async function eventually(run: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  do { if (await run()) return; await new Promise(resolve => setTimeout(resolve, 20)); } while (Date.now() < deadline);
  assert.fail("Expected synthetic state transition within five seconds");
}

test("documented demo import, status and serve commands share a separate private demo database", { timeout: 30_000 }, async t => {
  await fixture(t, async root => {
    const script = resolve("scripts/dogfood-demo.mjs");
    const imported = spawnSync(process.execPath, ["-e", childCode, root, script], { encoding: "utf8", timeout: 10_000, shell: false });
    assert.equal(imported.status, 0, imported.stderr);
    const receipt = JSON.parse(imported.stdout); assert.equal(receipt.mode, "synthetic-dogfood-demo");
    assert.equal(receipt.tests, 4); assert.equal(receipt.isolatedExecution, "not_run");
    const status = spawnSync(process.execPath, ["-e", childCode, root, script, "--status"], { encoding: "utf8", timeout: 10_000, shell: false });
    assert.equal(status.status, 0, status.stderr); assert.equal(JSON.parse(status.stdout).selectedSnapshotId, receipt.snapshotId);
    const app = await startChild(root, true);
    try {
      const current = await state(app, await login(app), receipt.snapshotId);
      assert.equal(current.history[0]!.assessment!.tests, 4);
      await assert.rejects(fs.lstat(join(root, ".flora", "dogfood", "state.db")), { code: "ENOENT" });
    } finally { await stopChild(app); }
    assert.equal(app.child.exitCode, 0);
  });
});

test("synthetic CLI and HTTP workflow retains imported evidence, blocked runs, freshness and history across reopen", { timeout: 30_000 }, async t => {
  await fixture(t, async root => {
    const seeded = await seed(root);
    let app = await startChild(root);
    try {
      const headers = await login(app), original = await state(app, headers, seeded.snapshot.id);
      assert.equal(original.history[0]!.id, seeded.verificationId);
      assert.equal(original.history[0]!.evidenceOrigin, "operator-import");
      assert.equal(original.history[0]!.assessment!.files, 2); assert.equal(original.history[0]!.assessment!.tests, 4);
      assert.equal(original.freshness, "freshness_unknown");
      const request = await http(app.origin, "/api/runs", "POST", headers, { snapshotId: seeded.snapshot.id, requestKey: "synthetic-click" });
      assert.equal(request.status, 202); assert.equal(request.value.state, "queued");
      await eventually(async () => (await state(app, headers, seeded.snapshot.id)).history.some(row => row.id === request.value.id && row.state === "blocked"));
      const repeated = await http(app.origin, "/api/runs", "POST", headers, { snapshotId: seeded.snapshot.id, requestKey: "synthetic-click" });
      assert.equal(repeated.status, 200); assert.equal(repeated.value.id, request.value.id);
      assert.equal(repeated.value.evidenceKind, "isolated-runner-result"); assert.equal(repeated.value.code, "PROVIDER_UNSUPPORTED");
      const nextBundle = { ...syntheticSourceBundle(), commitSha: "b".repeat(40) };
      await fs.writeFile(seeded.file, bundleBytes(nextBundle));
      const next = await cli(["import-source", "--file", seeded.file]);
      assert.notEqual(next.snapshotId, seeded.snapshot.id);
      assert.equal((await state(app, headers, seeded.snapshot.id)).history.length, 2);
      assert.equal((await state(app, headers, next.snapshotId)).history.length, 0);
      assert.equal((await state(app, headers, seeded.snapshot.id)).freshness, "freshness_unknown");
      const observation = { repositoryId: seeded.snapshot.repository.id, rootDirectory: seeded.snapshot.rootDirectory,
        headCommitSha: nextBundle.commitSha, observedAt: "2026-01-03T00:00:00.000Z", evidenceOrigin: "operator-import" };
      assert.equal((await http(app.origin, "/api/head", "POST", headers, observation)).status, 204);
      assert.equal((await state(app, headers, seeded.snapshot.id)).freshness, "stale");
      const reload = await http(app.origin, "/api/session", "GET", { Cookie: headers.Cookie });
      assert.equal(reload.status, 200); assert.ok(reload.value.csrfToken === headers["X-Flora-CSRF"], "reload restores the same CSRF token");
      assert.equal(app.output().stdout.trim().split("\n").length, 1);
      await stopChild(app); assert.equal(app.child.exitCode, 0);
      app = await startChild(root);
      assert.equal((await http(app.origin, "/api/state", "GET", { Cookie: headers.Cookie })).status, 401);
      const reopened = await state(app, await login(app), seeded.snapshot.id);
      assert.equal(reopened.snapshots.length, 2); assert.equal(reopened.history.length, 2); assert.equal(reopened.freshness, "stale");
    } finally { await stopChild(app); }
  });
});

test("second CLI server cannot recover a live owner, and only a dead PID permits fenced recovery", { timeout: 30_000 }, async t => {
  await fixture(t, async root => {
    const seeded = await seed(root), app = await startChild(root), db = dbapi.openDatabase(seeded.path);
    let replacement: Awaited<ReturnType<typeof startChild>> | null = null;
    try {
      const now = Date.now(), record = dbapi.createVerification(db, { snapshotId: seeded.snapshot.id, requestKey: "synthetic-live", now }).record;
      const fence = dbapi.beginVerification(db, { recordId: record.id, attemptId: "synthetic-attempt", runnerId: "synthetic-runner", now, leaseMs: 30_000 });
      const before = dbapi.getVerification(db, record.id), owner = db.prepare("SELECT * FROM dashboard_server_owner").get()!;
      const second = spawnSync(process.execPath, childArgs(root, ["serve"]), { encoding: "utf8", timeout: 10_000, shell: false });
      assert.equal(second.status, 1); assert.ok(second.stdout === "", "a second server emits no bootstrap URL");
      assert.equal(second.stderr, '{"error":"STORE_IN_USE"}\n');
      await cli(["status", "--json"]); await cli(["import-source", "--file", seeded.file]);
      assert.deepEqual(dbapi.getVerification(db, record.id), before);
      assert.deepEqual(db.prepare("SELECT * FROM dashboard_server_owner").get(), owner);
      await stopChild(app, true);
      assert.throws(() => process.kill(Number(owner.pid), 0), { code: "ESRCH" });
      replacement = await startChild(root);
      const recovered = dbapi.getVerification(db, record.id)!;
      assert.equal(recovered.state, "interrupted"); assert.equal(recovered.fence, fence.fence + 1);
      assert.equal(recovered.cleanupCode, "CLEANUP_UNCONFIRMED");
      const nextOwner = db.prepare("SELECT * FROM dashboard_server_owner").get()!;
      assert.notEqual(nextOwner.nonce, owner.nonce);
      dbapi.releaseDashboardOwner(db, String(owner.nonce));
      assert.deepEqual(db.prepare("SELECT * FROM dashboard_server_owner").get(), nextOwner);
      await stopChild(replacement);
      assert.equal(db.prepare("SELECT * FROM dashboard_server_owner").get(), undefined);
    } finally { await stopChild(app); if (replacement) await stopChild(replacement); db.close(); }
  });
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
test("real HTTP queued and cancelling receipts return within one second while synthetic execution and cleanup wait", { timeout: 15_000 }, async () => {
  assert.equal(typeof dashboard.startDashboard, "function");
  const db = dbapi.openDatabase(":memory:"); dbapi.migrate(db);
  const started = deferred<RunInput>(), result = deferred<ProviderResult>(), cleanup = deferred<CleanupReport>();
  const service = await createDogfoodService(dbapi.createSqliteDogfoodStore(db), [syntheticVerificationProvider({
    run: async input => { started.resolve(input); return result.promise; }, cancel: async () => cleanup.promise,
  })], Date.now);
  const app = await dashboard.startDashboard({ service });
  try {
    const snapshot = await service.importSource(bundleBytes(syntheticSourceBundle())), headers = await login(app);
    const start = performance.now();
    const receipt = await http(app.origin, "/api/runs", "POST", headers, { snapshotId: snapshot.id, requestKey: "slow-synthetic" });
    assert.equal(receipt.status, 202); assert.equal(receipt.value.state, "queued"); assert.ok(performance.now() - start < 1000);
    const input = await started.promise;
    const cancelStart = performance.now();
    const cancel = await http(app.origin, "/api/runs/" + encodeURIComponent(receipt.value.id) + "/cancel", "POST", headers, {});
    assert.equal(cancel.status, 202); assert.equal(cancel.value.state, "cancelling"); assert.ok(performance.now() - cancelStart < 1000);
    result.resolve(await syntheticProviderResult(input));
    assert.equal((await service.getState(snapshot.id)).history[0]!.state, "cancelling");
    cleanup.resolve(confirmedSyntheticCleanup());
    await eventually(async () => (await service.getState(snapshot.id)).history[0]!.state === "cancelled");
  } finally {
    cleanup.resolve(confirmedSyntheticCleanup());
    await service.close(); await app.close(); db.close();
  }
});
