import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { connect } from "node:net";
import { openDatabase, migrate, createSqliteDogfoodStore } from "@app-ops/db";
import * as dashboard from "@app-ops/dashboard";
import type { DogfoodService } from "@app-ops/dashboard/service";
import { bundleBytes, syntheticSourceBundle, syntheticBaseline } from "../../../tests/dogfood-fixtures.ts";

async function setup() {
  assert.equal(typeof dashboard.startDashboard, "function");
  const db = openDatabase(":memory:"); migrate(db);
  const service = await dashboard.createDogfoodService(createSqliteDogfoodStore(db), [dashboard.createBlockedProvider()], Date.now);
  const app = await dashboard.startDashboard({ service });
  return { ...app, service, async dispose() { await app.close(); await service.close(); db.close(); } };
}
function http(origin: string, path = "/", method = "GET", headers: Record<string, string> = {}, body = "") {
  return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request(origin + path, { method, headers, agent: false }, res => {
      let body = ""; res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    }); req.on("error", reject); req.end(body);
  });
}
async function login(app: { origin: string; bootstrapUrl: string }) {
  const bootstrap = new URL(app.bootstrapUrl).hash.slice(1);
  assert.match(bootstrap, /^[a-f0-9]{64}$/);
  assert.equal(new URL(app.bootstrapUrl).search, "");
  const res = await http(app.origin, "/api/session", "POST", { Origin: app.origin, "Content-Type": "application/json" }, JSON.stringify({ bootstrap }));
  assert.equal(res.status, 200);
  assert.match(res.headers["set-cookie"]![0]!, /HttpOnly; SameSite=Strict; Path=\//);
  return { Cookie: res.headers["set-cookie"]![0]!.split(";")[0]!, Origin: app.origin, "X-Flora-CSRF": JSON.parse(res.body).csrfToken as string, "Content-Type": "application/json" };
}
function raw(origin: string, headers: string, path = "/api/state") {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(Number(new URL(origin).port), "127.0.0.1"); let out = "";
    socket.on("connect", () => socket.end(`GET ${path} HTTP/1.1\r\n${headers}\r\nConnection: close\r\n\r\n`));
    socket.on("data", chunk => { out += String(chunk); }); socket.on("end", () => resolve(out)); socket.on("error", reject);
  });
}

test("loopback assets are fixed, private APIs require a session, and every response is hardened", async () => {
  const app = await setup();
  try {
    assert.match(app.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    for (const path of ["/", "/app.js", "/app.css", "/api/state", "/missing"]) {
      const res = await http(app.origin, path);
      assert.equal(res.status, path === "/api/state" ? 401 : path === "/missing" ? 404 : 200);
      assert.equal(res.headers["cache-control"], "no-store"); assert.equal(res.headers["x-content-type-options"], "nosniff");
      assert.equal(res.headers["referrer-policy"], "no-referrer");
      assert.equal(res.headers["access-control-allow-origin"], undefined);
      assert.match(String(res.headers["content-security-policy"]), /default-src 'none'.*script-src 'self'.*style-src 'self'.*connect-src 'self'.*frame-ancestors 'none'.*base-uri 'none'.*form-action 'self'/);
    }
    for (const path of ["/../package.json", "/%2e%2e/package.json", "/public/index.html", "/app.d.ts", "/?bootstrap=secret"]) assert.equal((await http(app.origin, path)).status, 404);
  } finally { await app.dispose(); }
});

test("rejects cross-site and hostile display input before service access", async () => {
  const app = await setup();
  try {
    const headers = await login(app); const host = new URL(app.origin).host;
    for (const override of [{ Host: "evil.test" }, { Origin: "https://evil.test" }, { Origin: "null" }, { "Sec-Fetch-Site": "cross-site" }, { "X-Forwarded-Host": host }, { "X-Forwarded-For": "127.0.0.1" }, { Forwarded: "host=" + host }]) {
      assert.equal((await http(app.origin, "/api/state", "GET", { ...headers, ...override })).status, 403);
    }
    assert.match(await raw(app.origin, `Host: ${host}\r\nHost: ${host}`), /^HTTP\/1.1 403/);
    assert.match(await raw(app.origin, `Host: ${host}\r\nOrigin: ${app.origin}\r\nOrigin: ${app.origin}`), /^HTTP\/1.1 403/);
    for (const override of [{ "X-Flora-CSRF": "" }, { "X-Flora-CSRF": "wrong" }, { Origin: "" }, { Cookie: "" }]) {
      const res = await http(app.origin, "/api/runs", "POST", { ...headers, ...override }, JSON.stringify({ snapshotId: "inventory_test", requestKey: "test" }));
      assert.ok([401, 403].includes(res.status));
    }
    const replay = await http(app.origin, "/api/session", "POST", headers, JSON.stringify({ bootstrap: new URL(app.bootstrapUrl).hash.slice(1) })); assert.equal(replay.status, 401);
    const session = await http(app.origin, "/api/session", "GET", { Cookie: headers.Cookie }); assert.equal(JSON.parse(session.body).csrfToken, headers["X-Flora-CSRF"]);
    assert.deepEqual((await app.service.getState()).snapshots, []);
  } finally { await app.dispose(); }
});

test("imports snapshots and baselines, retains opaque ids, queues and cancels without waiting", async () => {
  const app = await setup();
  try {
    const headers = await login(app);
    const imported = await http(app.origin, "/api/sources", "POST", headers, JSON.stringify(syntheticSourceBundle())); assert.equal(imported.status, 201);
    const snapshot = JSON.parse(imported.body); assert.match(snapshot.id, /^inventory_/);
    const before = await app.service.getState();
    const state = await http(app.origin, "/api/state?snapshotId=" + snapshot.id, "GET", headers); assert.equal(state.status, 200);
    assert.deepEqual(await app.service.getState(), before, "GET cannot modify data");
    const baseline = await http(app.origin, "/api/baselines?snapshotId=" + snapshot.id, "POST", headers, JSON.stringify(syntheticBaseline(snapshot))); assert.equal(baseline.status, 201);
    assert.equal(JSON.parse(baseline.body).evidenceKind, "development-baseline");
    const observation = { repositoryId: snapshot.repository.id, rootDirectory: snapshot.rootDirectory, headCommitSha: snapshot.commitSha, observedAt: "2026-01-03T03:04:05Z", evidenceOrigin: "operator-import" };
    assert.equal((await http(app.origin, "/api/head", "POST", headers, JSON.stringify(observation))).status, 204);
    const run = await http(app.origin, "/api/runs", "POST", headers, JSON.stringify({ snapshotId: snapshot.id, requestKey: "repeat" })); assert.equal(run.status, 202); assert.equal(JSON.parse(run.body).state, "queued");
    const repeat = await http(app.origin, "/api/runs", "POST", headers, JSON.stringify({ snapshotId: snapshot.id, requestKey: "repeat" })); assert.equal(repeat.status, 200); assert.equal(JSON.parse(repeat.body).state, "blocked");
    assert.equal((await http(app.origin, "/api/state?snapshotId=" + snapshot.id, "GET", headers)).status, 200);
    assert.equal((await http(app.origin, "/api/runs/" + JSON.parse(run.body).id + "/cancel", "POST", headers, "{}")).status, 409);
  } finally { await app.dispose(); }
});

test("rejects unknown fields, methods, routes, malformed bodies, excessive streaming bodies and headers with safe errors", async () => {
  const app = await setup();
  try {
    const headers = await login(app);
    const cases: [string, string, string, number][] = [
      ["/api/state", "POST", "{}", 405], ["/unknown", "POST", "{}", 404], ["/api/state?extra=x", "GET", "", 400],
      ["/api/state?snapshotId=x&snapshotId=y", "GET", "", 400], ["/api/runs", "POST", '{"snapshotId":"inventory_test","requestKey":"a","command":"whoami"}', 400],
      ["/api/runs", "POST", '{"__proto__":{}}', 400], ["/api/runs", "POST", "{", 400],
      ["/api/sources", "POST", JSON.stringify({ ...syntheticSourceBundle(), trusted: true }), 400],
      ["/api/head", "POST", '{"trusted":true}', 400], ["/api/runs", "POST", '"' + "x".repeat(2 * 1024 * 1024) + '"', 413],
    ];
    for (const [path, method, body, expected] of cases) {
      const res = await http(app.origin, path, method, headers, body); assert.equal(res.status, expected, path);
      assert.ok(!/stack|\/workspace|node_modules|bootstrap|csrfToken/.test(res.body));
    }
    assert.equal((await http(app.origin, "/api/runs", "POST", { ...headers, "Content-Type": "text/plain" }, "{}")).status, 415);
    assert.match(await raw(app.origin, `Host: ${new URL(app.origin).host}\r\nX-Large: ${"x".repeat(8192)}`), /^HTTP\/1.1 431/);
  } finally { await app.dispose(); }
});

test("sessions die with server restart and bootstrap expires at five minutes", async t => {
  const app = await setup(); const headers = await login(app); await app.dispose();
  const next = await setup();
  try {
    assert.equal((await http(next.origin, "/api/state", "GET", { Cookie: headers.Cookie })).status, 401);
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() }); t.mock.timers.tick(300_000);
    const res = await http(next.origin, "/api/session", "POST", { Origin: next.origin, "Content-Type": "application/json" }, JSON.stringify({ bootstrap: new URL(next.bootstrapUrl).hash.slice(1) })); assert.equal(res.status, 401);
  } finally { await next.dispose(); }
});

test("unexpected service errors never expose local diagnostics", async () => {
  const service = { getState: async () => { throw new Error("/workspace/private/secret-token"); } } as unknown as DogfoodService;
  const app = await dashboard.startDashboard({ service });
  try { const headers = await login(app); const res = await http(app.origin, "/api/state", "GET", headers); assert.equal(res.status, 500); assert.deepEqual(JSON.parse(res.body), { error: "INTERNAL_ERROR" }); }
  finally { await app.close(); }
});

test("bootstrap is consumed atomically and invalid requests cannot preempt the owner", async () => {
  const app = await setup();
  try {
    const headers = { Origin: app.origin, "Content-Type": "application/json" }; const bootstrap = new URL(app.bootstrapUrl).hash.slice(1);
    assert.equal((await http(app.origin, "/api/session", "POST", headers, JSON.stringify({ bootstrap, trusted: true }))).status, 400);
    assert.equal((await http(app.origin, "/api/session", "POST", headers, JSON.stringify({ bootstrap: "0".repeat(64) }))).status, 401);
    assert.equal((await http(app.origin, "/api/session", "POST", { ...headers, Origin: "null" }, JSON.stringify({ bootstrap }))).status, 403);
    const results = await Promise.all([1, 2].map(() => http(app.origin, "/api/session", "POST", headers, JSON.stringify({ bootstrap }))));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 401]);
    const cookie = results.find(result => result.status === 200)!.headers["set-cookie"]![0]!.split(";")[0]!;
    assert.equal((await http(app.origin, "/api/state", "GET", { Cookie: `${cookie}; ${cookie}` })).status, 401);
    assert.equal((await http(app.origin, "/api/state", "GET", { Cookie: cookie.slice(0, -1) + (cookie.endsWith("0") ? "1" : "0") })).status, 401);
  } finally { await app.dispose(); }
});

test("cancel acknowledges the sealed cancelling receipt at an opaque record route", async () => {
  let received = ""; const record = { id: "verification_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", state: "cancelling" };
  const service = { cancelRun: async (id: string) => { received = id; return record; } } as unknown as DogfoodService;
  const app = await dashboard.startDashboard({ service });
  try {
    const headers = await login(app); const response = await http(app.origin, "/api/runs/" + record.id + "/cancel", "POST", headers, "{}");
    assert.equal(response.status, 202); assert.deepEqual(JSON.parse(response.body), record); assert.equal(received, record.id);
    assert.equal((await http(app.origin, "/api/runs/" + record.id + "/cancel", "POST", headers, '{"force":true}')).status, 400);
  } finally { await app.close(); }
});

test("unfinished uploads are bounded by the ten-second request deadline without service writes", { timeout: 15_000 }, async () => {
  const app = await setup();
  try {
    const headers = await login(app); const started = Date.now();
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(new URL(app.origin).port), "127.0.0.1"); let output = "";
      socket.on("connect", () => socket.write(`POST /api/sources HTTP/1.1\r\nHost: ${new URL(app.origin).host}\r\nOrigin: ${app.origin}\r\nCookie: ${headers.Cookie}\r\nX-Flora-CSRF: ${headers["X-Flora-CSRF"]}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n{\r\n`));
      socket.on("data", chunk => { output += String(chunk); }); socket.on("end", () => resolve(output)); socket.on("error", reject);
    });
    assert.ok(Date.now() - started < 12_000); assert.match(response, /^HTTP\/1.1 408/);
    assert.deepEqual((await app.service.getState()).snapshots, []);
  } finally { await app.dispose(); }
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test("close drains started HTTP work even after its connection has disappeared", async () => {
  const entered = deferred<void>(); const release = deferred<void>(); let accessedAfterWait = false;
  const service = { getState: async () => { entered.resolve(); await release.promise; accessedAfterWait = true; return {}; } } as unknown as DogfoodService;
  const app = await dashboard.startDashboard({ service });
  const headers = await login(app);
  const pending = http(app.origin, "/api/state", "GET", headers).catch(() => null);
  await entered.promise;
  let closed = false; const closing = app.close().then(() => { closed = true; });
  try {
    await pending; // Socket closure is confirmed while its handler remains gated.
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(closed, false, "caller must retain DB ownership until the handler settles");
    assert.equal(accessedAfterWait, false);
    await assert.rejects(http(app.origin, "/api/state", "GET", headers));
    release.resolve(); await closing; assert.equal(accessedAfterWait, true);
    assert.equal(await app.close(), undefined);
  } finally { release.resolve(); await closing; }
});
