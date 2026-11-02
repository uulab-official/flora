import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createNativeClient, NativeHttpFailure } from "../dist/native-client.js";
import type { NativeLease } from "../dist/native-client.js";

const scheduleKeepAlive = setTimeout, clearKeepAlive = clearTimeout;
let alive: ReturnType<typeof setTimeout>;
test.beforeEach(() => { alive = scheduleKeepAlive(() => {}, 2000); });
test.afterEach(() => clearKeepAlive(alive));

const token = "native_runner_test." + "a".repeat(43);
const base = { origin: "https://native.invalid", appId: "app_test", platform: "android" as const, token };
const lease = (ms = 120000): NativeLease => ({ jobId: "native_job_test", appId: base.appId, platform: "android", runnerId: "native_runner_test", attemptId: "attempt_test", credentialEpoch: 1, fence: 1, expiresAt: Date.now() + ms });
const message = (error: unknown) => error instanceof Error ? error.message : "UNEXPECTED_NON_ERROR";
function awaitingAbort(_url: unknown, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new Error("PRIVATE_TRANSPORT_DETAIL"));
    if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener("abort", abort, { once: true });
  });
}

test("lease timer keeps its cause when wall time is frozen before the deadline", async t => {
  const now = Date.now();
  const original = { ...lease(), expiresAt: now + 25 };
  t.mock.method(Date, "now", () => now);
  const client = createNativeClient({ ...base, fetch: awaitingAbort as typeof fetch });
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(client.heartbeat(original), /^Error: NATIVE_LEASE_EXPIRED$/); }
  finally { clearTimeout(keepAlive); }
});

test("a fetch ignoring abort cannot outlive the original lease or return late success", async () => {
  let resolveFetch!: (response: Response) => void;
  let cancelled = false;
  const client = createNativeClient({ ...base, fetch: () => new Promise(resolve => { resolveFetch = resolve; }) });
  const l = lease(25);
  const result = client.heartbeat(l).then(() => "SUCCESS", message);
  const observed = await Promise.race([result, delay(150).then(() => "HUNG")]);
  resolveFetch(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await delay(10);
  assert.equal(observed, "NATIVE_LEASE_EXPIRED");
  assert.equal(cancelled, true, "late response body must be disposed");
});

test("client identity and transport are captured, not live caller-owned configuration", async () => {
  let seen: RequestInit | undefined;
  const options = { ...base, fetch: (async (_url, init) => { seen = init; return Response.json({ jobId: null }); }) as typeof fetch };
  const client = createNativeClient(options);
  options.token = "native_runner_other." + "b".repeat(43);
  options.appId = "app_other";
  options.fetch = async () => { throw new Error("MUTATED_TRANSPORT"); };
  assert.equal(await client.pending(), null);
  assert.equal(new Headers(seen?.headers).get("authorization"), "Bearer " + token);
});

for (const status of [401, 403, 503]) {
  test(`observed HTTP ${status} survives an absent response body`, async () => {
    const client = createNativeClient({ ...base, fetch: async () => new Response(null, { status }) });
    await assert.rejects(client.heartbeat(lease()), error => error instanceof NativeHttpFailure && error.status === status);
  });
}

test("observed authority rejection survives a stalled body without waiting for lease expiry", async () => {
  let cancelled = false;
  const client = createNativeClient({ ...base, fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 403 }) });
  await assert.rejects(client.heartbeat(lease(30)), error => error instanceof NativeHttpFailure && error.status === 403);
  assert.equal(cancelled, true);
});

test("expired bound input is a lease failure and never calls fetch", async () => {
  let calls = 0;
  const client = createNativeClient({ ...base, fetch: async () => { calls++; throw new Error("PRIVATE"); } });
  await assert.rejects(client.heartbeat({ ...lease(), expiresAt: Date.now() - 1 }), /^Error: NATIVE_LEASE_EXPIRED$/);
  assert.equal(calls, 0);
});

test("null claim response has a fixed error rather than a native property-access exception", async () => {
  const client = createNativeClient({ ...base, fetch: async () => Response.json(null) });
  await assert.rejects(client.claim("native_job_test"), /^Error: NATIVE_RESPONSE_INVALID$/);
});

test("malformed claim ID is rejected before sending a management request", async () => {
  let calls = 0;
  const client = createNativeClient({ ...base, fetch: async () => { calls++; return Response.json(null); } });
  await assert.rejects(client.claim("native_job_test\n"), /^Error: NATIVE_RESPONSE_INVALID$/);
  assert.equal(calls, 0);
});

test("invalid UTF-8 is rejected even in fields otherwise ignored by a projection", async () => {
  const bytes = Buffer.concat([Buffer.from('{"runnerId":"native_runner_test","lastSeenAt":1,"ignored":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  const client = createNativeClient({ ...base, fetch: async () => new Response(bytes) });
  await assert.rejects(client.presence(), /^Error: NATIVE_RESPONSE_INVALID$/);
});

test("a pre-aborted credential grant does not send or release any secret", async () => {
  let calls = 0;
  const client = createNativeClient({ ...base, fetch: async () => { calls++; return Response.json(null); } });
  await assert.rejects(Reflect.apply(client.credentials, client, [lease(), AbortSignal.abort()]), /^Error: NATIVE_CANCELLED$/);
  assert.equal(calls, 0);
});

for (const [field, value] of [["appId", "app_foreign"], ["platform", "ios"], ["runnerId", "native_runner_foreign"], ["attemptId", "attempt_foreign"], ["fence", 2], ["credentialEpoch", 2]] as const) {
  test(`renewal cannot substitute ${field}`, async () => {
    const current = lease();
    const client = createNativeClient({ ...base, fetch: async () => Response.json({ ...current, [field]: value }) });
    await assert.rejects(client.heartbeat(current), /^Error: NATIVE_RESPONSE_INVALID$/);
  });
}

test("a frozen lease snapshot is sent and validated even if the caller mutates the original", async () => {
  const current = lease(), expected = { ...current };
  let release!: () => void, captured: unknown;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const client = createNativeClient({ ...base, fetch: async (_url, init) => {
    captured = JSON.parse(String(init?.body)); await waiting; return Response.json(expected);
  } });
  const result = client.heartbeat(current);
  current.appId = "app_foreign"; current.expiresAt = Date.now() + 10_000_000; current.fence = 100;
  release();
  assert.deepEqual(await result, expected);
  assert.deepEqual(captured, { lease: expected });
});

test("lease accessors cannot be evaluated or used to transform outbound authority", async () => {
  let invoked = false, requests = 0;
  const current = { ...lease() };
  Object.defineProperty(current, "appId", { get() { invoked = true; return base.appId; } });
  const client = createNativeClient({ ...base, fetch: async () => { requests++; return Response.json(null); } });
  await assert.rejects(client.heartbeat(current), /^Error: NATIVE_RESPONSE_INVALID$/);
  assert.equal(invoked, false); assert.equal(requests, 0);
});

test("abort-ignoring fetch still settles promptly on caller cancellation and disposes a late body", async () => {
  let resolveFetch!: (response: Response) => void, cancelled = false;
  const controller = new AbortController();
  const client = createNativeClient({ ...base, fetch: () => new Promise(resolve => { resolveFetch = resolve; }) });
  const result = client.heartbeat(lease(), controller.signal);
  controller.abort(new Error("PRIVATE_CANCEL_REASON"));
  await assert.rejects(result, /^Error: NATIVE_CANCELLED$/);
  resolveFetch(new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } })));
  await delay(5); assert.equal(cancelled, true);
});

test("late rejected fetch is consumed without an unhandled rejection", async () => {
  let rejectFetch!: (error: Error) => void;
  const controller = new AbortController();
  const client = createNativeClient({ ...base, fetch: () => new Promise((_resolve, reject) => { rejectFetch = reject; }) });
  const result = client.heartbeat(lease(), controller.signal);
  controller.abort(); await assert.rejects(result, /^Error: NATIVE_CANCELLED$/);
  rejectFetch(new Error("PRIVATE_LATE_ERROR")); await delay(5);
});

test("a stalled successful body shares the lease deadline and is cancelled", async () => {
  let cancelled = false;
  const client = createNativeClient({ ...base, fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from('{"runnerId":')); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  })) });
  await assert.rejects(client.heartbeat(lease(25)), /^Error: NATIVE_LEASE_EXPIRED$/);
  assert.equal(cancelled, true);
});

test("the fixed 20 second request budget does not falsely expire a longer lease", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"], now: Date.now() });
  const client = createNativeClient({ ...base, fetch: awaitingAbort as typeof fetch });
  const result = client.heartbeat(lease(120000));
  const rejected = assert.rejects(result, /^Error: NATIVE_TRANSPORT_UNAVAILABLE$/);
  t.mock.timers.tick(20_000);
  await rejected;
});

test("body chunks do not reset the original request budget", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"], now: Date.now() });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const client = createNativeClient({ ...base, fetch: async () => new Response(new ReadableStream({ start(value) { controller = value; } })) });
  const result = client.heartbeat(lease(120000));
  await delay(0);
  t.mock.timers.tick(19_999);
  controller.enqueue(Buffer.from('{"appId":'));
  await delay(0);
  const rejected = assert.rejects(result, /^Error: NATIVE_TRANSPORT_UNAVAILABLE$/);
  t.mock.timers.tick(1);
  await rejected;
});

test("a successful response arriving after forward wall-clock lease expiry is rejected", async t => {
  const current = lease(), now = Date.now();
  const client = createNativeClient({ ...base, fetch: async () => {
    t.mock.method(Date, "now", () => current.expiresAt + 1);
    return Response.json({ ...current, expiresAt: now + 1_000_000 });
  } });
  await assert.rejects(client.heartbeat(current), /^Error: NATIVE_LEASE_EXPIRED$/);
});

for (const problem of [{ error: "BUSY" }, { error: "BUSY", secret: "PRIVATE" }, { error: "UNKNOWN" }, null]) {
  test(`409 backpressure is narrow: ${JSON.stringify(problem)}`, async () => {
    let requests = 0;
    const client = createNativeClient({ ...base, fetch: async () => { requests++; return Response.json(problem, { status: 409 }); } });
    await assert.rejects(client.heartbeat(lease()), error => error instanceof NativeHttpFailure && error.status === 409 &&
      error.safeCode === (problem?.error === "BUSY" && Object.keys(problem).length === 1 ? "BUSY" : "NATIVE_REQUEST_REJECTED"));
    assert.equal(requests, 1);
  });
}

test("409 with an oversized or unfinished error body remains a hard conflict", async () => {
  for (const response of [new Response("x".repeat(16 * 1024 + 1), { status: 409 }), new Response(new ReadableStream({}), { status: 409 })]) {
    const client = createNativeClient({ ...base, fetch: async () => response });
    await assert.rejects(client.heartbeat(lease(25)), error => error instanceof NativeHttpFailure && error.status === 409 && error.safeCode === "NATIVE_REQUEST_REJECTED");
  }
});

test("declared oversized success is rejected before its body is read and cancelled", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-length": String(4 * 1024 * 1024 + 1) } });
  const client = createNativeClient({ ...base, fetch: async () => response });
  await assert.rejects(client.pending(), /^Error: NATIVE_RESPONSE_INVALID$/);
  assert.equal(cancelled, true);
});

test("streamed success accepts the byte boundary and rejects one byte beyond it", async () => {
  const json = '{"jobId":null}';
  for (const extra of [0, 1]) {
    const text = json + " ".repeat(4 * 1024 * 1024 - Buffer.byteLength(json) + extra);
    let cursor = 0;
    const response = new Response(new ReadableStream({ pull(controller) {
      if (cursor === text.length) { controller.close(); return; }
      const part = text.slice(cursor, cursor + 65536); cursor += part.length; controller.enqueue(Buffer.from(part));
    } }));
    const client = createNativeClient({ ...base, fetch: async () => response });
    if (extra) await assert.rejects(client.pending(), /^Error: NATIVE_RESPONSE_INVALID$/);
    else assert.equal(await client.pending(), null);
  }
});

test("raw network and body errors cannot escape as diagnostics or authorize retry codes", async () => {
  const fail = (error: Error) => createNativeClient({ ...base, fetch: async () => { throw error; } });
  await assert.rejects(fail(new Error("PRIVATE_TOKEN_VALUE")).pending(), /^Error: NATIVE_TRANSPORT_UNAVAILABLE$/);
  const body = new ReadableStream({ start(controller) { controller.error(new Error("PRIVATE_STREAM_VALUE")); } });
  await assert.rejects(createNativeClient({ ...base, fetch: async () => new Response(body) }).pending(), /^Error: NATIVE_TRANSPORT_UNAVAILABLE$/);
});

for (const action of ["pending", "claim", "credentials", "complete", "fail", "presence"] as const) {
  test(`pre-aborted ${action} sends no request`, async () => {
    let requests = 0;
    const client = createNativeClient({ ...base, fetch: async () => { requests++; return Response.json(null); } });
    const l = lease(), signal = AbortSignal.abort("PRIVATE_REASON"), artifact = { fileName: "test.apk", sha256: "a".repeat(64), byteLength: 1, appIdentifier: "kr.co.uulab.test", platform: "android", signerFingerprint: "b".repeat(64) };
    const args = action === "claim" ? [l.jobId, signal] : action === "credentials" ? [l, signal] : action === "complete" ? [l, artifact, signal] : action === "fail" ? [l, "NATIVE_BUILD_FAILED", signal] : [signal];
    await assert.rejects(Reflect.apply(client[action], client, args), /^Error: NATIVE_CANCELLED$/);
    assert.equal(requests, 0);
  });
}

// Real HTTP tests use only an ephemeral loopback server and synthetic credentials.
async function localServer(t: import("node:test").TestContext, handler: import("node:http").RequestListener): Promise<string> {
  const { createServer } = await import("node:http");
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function body(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const part of req) chunks.push(Buffer.from(part));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

test("real HTTP preserves endpoint, credential, pinned lease and JSON bytes across all native phases", async t => {
  const l = lease();
  const job = { id: l.jobId, appId: l.appId, platform: l.platform, state: "leased", commitSha: "a".repeat(40), appIdentifier: "kr.co.uulab.test", credentials: [], configDigest: "b".repeat(64), source: { owner: "example", repository: "app", ref: "main", rootDirectory: "." } };
  const artifact = { fileName: "test.apk", sha256: "c".repeat(64), byteLength: 12, appIdentifier: job.appIdentifier, platform: "android" as const, signerFingerprint: "d".repeat(64) };
  const seen: string[] = [];
  let handlerError: unknown;
  const origin = await localServer(t, async (req, res) => {
    try {
      const data = await body(req), action = req.url!.split("/").pop()!; seen.push(action);
      assert.equal(req.headers.authorization, "Bearer " + token); assert.equal(req.method, "POST");
      assert.equal(req.headers.origin, origin); assert.equal(req.headers["content-type"], "application/json");
      if (["heartbeat", "credentials", "complete", "fail"].includes(action)) assert.deepEqual(data.lease, l);
      if (action === "complete") assert.deepEqual(data.artifact, artifact);
      const value = action === "pending" ? { jobId: l.jobId } : action === "claim" ? { job, lease: l } : action === "heartbeat" ? l :
        action === "credentials" ? { jobId: l.jobId, appId: l.appId, platform: l.platform, commitSha: job.commitSha, expiresAt: Date.now() + 10000, credentials: [] } :
        action === "complete" ? { ...job, state: "succeeded" } : action === "presence" ? { runnerId: l.runnerId, lastSeenAt: Date.now() } : {};
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value));
    } catch (error) { handlerError = error; res.writeHead(500); res.end(); }
  });
  const client = createNativeClient({ ...base, origin });
  assert.equal(await client.pending(), l.jobId);
  assert.equal((await client.claim(l.jobId)).job.commitSha, job.commitSha);
  assert.deepEqual(await client.heartbeat(l), l);
  assert.equal((await client.credentials(l)).jobId, l.jobId);
  assert.equal((await client.complete(l, artifact)).state, "succeeded");
  await client.fail(l, "NATIVE_BUILD_FAILED"); await client.presence();
  assert.equal(handlerError, undefined);
  assert.deepEqual(seen, ["pending", "claim", "heartbeat", "credentials", "complete", "fail", "presence"]);
});

test("real HTTP stalled headers end at the lease, without resending the heartbeat", async t => {
  let requests = 0;
  const origin = await localServer(t, (_req, _res) => { requests++; });
  const client = createNativeClient({ ...base, origin });
  await assert.rejects(client.heartbeat(lease(200)), /^Error: NATIVE_LEASE_EXPIRED$/);
  assert.equal(requests, 1);
});

test("real HTTP stalled body is bounded by the same lease and never returns partial success", async t => {
  let requests = 0;
  const origin = await localServer(t, (_req, res) => { requests++; res.writeHead(200, { "content-type": "application/json" }); res.write('{"appId":'); });
  const client = createNativeClient({ ...base, origin });
  await assert.rejects(client.heartbeat(lease(200)), /^Error: NATIVE_LEASE_EXPIRED$/);
  assert.equal(requests, 1);
});

test("real HTTP credential cancellation interrupts a held response and never retries", async t => {
  let arrived!: () => void, requests = 0;
  const ready = new Promise<void>(resolve => { arrived = resolve; });
  const origin = await localServer(t, (_req, res) => { requests++; res.writeHead(200); res.flushHeaders(); arrived(); });
  const controller = new AbortController(), client = createNativeClient({ ...base, origin });
  const result = client.credentials(lease(), controller.signal);
  const rejected = assert.rejects(result, /^Error: NATIVE_CANCELLED$/);
  await ready; controller.abort(new Error("PRIVATE_REASON")); await rejected;
  assert.equal(requests, 1);
});

test("real HTTP revoked authority stays authoritative when its body never ends", async t => {
  const origin = await localServer(t, (_req, res) => { res.writeHead(401, { "content-type": "application/json" }); res.flushHeaders(); });
  await assert.rejects(createNativeClient({ ...base, origin }).heartbeat(lease()), error => error instanceof NativeHttpFailure && error.status === 401);
});

test("real HTTP redirects never forward the native credential to another origin", async t => {
  let redirected = 0;
  const target = await localServer(t, (_req, res) => { redirected++; res.end("PRIVATE"); });
  const origin = await localServer(t, (_req, res) => { res.writeHead(307, { location: target + "/capture" }); res.end(); });
  await assert.rejects(createNativeClient({ ...base, origin }).presence(), /^Error: NATIVE_TRANSPORT_UNAVAILABLE$/);
  assert.equal(redirected, 0);
});

test("real HTTP lost completion acknowledgement is not automatically replayed", async t => {
  let submitted = 0;
  const origin = await localServer(t, async (req, res) => { await body(req); submitted++; res.destroy(); });
  const artifact = { fileName: "test.apk", sha256: "c".repeat(64), byteLength: 12, appIdentifier: "kr.co.uulab.test", platform: "android" as const, signerFingerprint: "d".repeat(64) };
  const client = createNativeClient({ ...base, origin });
  await assert.rejects(client.complete(lease(), artifact), /^Error: NATIVE_TRANSPORT_UNAVAILABLE$/);
  await delay(20); assert.equal(submitted, 1);
});

test("request timers and caller listeners are removed after success, rejection and cancellation", async t => {
  const { getEventListeners } = (await import("node:events")).default;
  t.mock.timers.enable({ apis: ["setTimeout"], now: Date.now() });
  const signal = new AbortController();
  let outbound: AbortSignal | undefined | null;
  for (const response of [Response.json(lease()), Response.json({ error: "BUSY" }, { status: 409 })]) {
    const client = createNativeClient({ ...base, fetch: async (_url, init) => { outbound = init?.signal; return response; } });
    try { await client.heartbeat(lease(), signal.signal); } catch (error) { assert.ok(error instanceof NativeHttpFailure); }
    assert.equal(getEventListeners(signal.signal, "abort").length, 0);
    t.mock.timers.tick(200_000);
    assert.equal(outbound?.aborted, false, "settled request must not retain a timer");
  }
  const client = createNativeClient({ ...base, fetch: awaitingAbort as typeof fetch });
  const pending = client.heartbeat(lease(), signal.signal);
  signal.abort(); await assert.rejects(pending, /^Error: NATIVE_CANCELLED$/);
  assert.equal(getEventListeners(signal.signal, "abort").length, 0);
});

test("small streaming fragments and split UTF-8 decode correctly without changing the byte budget", async () => {
  const json = Buffer.from('{"runnerId":"native_runner_test","lastSeenAt":1,"note":"한글🌱"}' + " ".repeat(130000));
  let cursor = 0;
  const response = new Response(new ReadableStream({ pull(controller) {
    if (cursor === json.length) { controller.close(); return; }
    const length = cursor < 100 ? 1 : 7;
    const end = Math.min(cursor + length, json.length);
    controller.enqueue(json.subarray(cursor, end)); cursor = end;
  } }));
  await createNativeClient({ ...base, fetch: async () => response }).presence();
});

test("caller cancellation during body consumption never returns a partially decoded credential grant", async () => {
  const controller = new AbortController();
  let reading!: () => void;
  const started = new Promise<void>(resolve => { reading = resolve; });
  const client = createNativeClient({ ...base, fetch: async () => new Response(new ReadableStream({
    pull(output) { output.enqueue(Buffer.from('{"credentials":')); reading(); },
  })) });
  const result = client.credentials(lease(), controller.signal);
  const rejected = assert.rejects(result, /^Error: NATIVE_CANCELLED$/);
  await started; controller.abort(); await rejected;
});

for (const field of ["jobId", "appId", "runnerId", "attemptId"] as const) {
  test(`trailing newline in lease ${field} never reaches the network`, async () => {
    let calls = 0;
    const current = lease();
    const client = createNativeClient({ ...base, fetch: async () => { calls++; return Response.json(current); } });
    await assert.rejects(client.heartbeat({ ...current, [field]: current[field] + "\n" }), /^Error: NATIVE_RESPONSE_INVALID$/);
    assert.equal(calls, 0);
  });
}
