import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createTestRuntime } from "./runtime.ts";
import type { SetupWindow } from "../src/contracts.ts";

const origin = "https://flora.example.test";
const email = "owner@example.test";
const start = 1_800_000_000_000;
const password = () => randomBytes(24).toString("base64url");
function capability(generation = 1, purpose: SetupWindow["purpose"] = "enroll", now = start) {
  const bytes = randomBytes(32);
  return { token: bytes.toString("base64url"), setup: { digest: createHash("sha256").update(bytes).digest("hex"), issuedAt: now, expiresAt: now + 600_000, generation, purpose } };
}
async function harness(t: TestContext, setup?: SetupWindow, entrypoint: string | URL = new URL("./fixtures/auth-entry.ts", import.meta.url)) {
  const runtime = await createTestRuntime({ entrypoint, durableObjects: { FLORA_AUTH: "FixtureAuth" }, bindings: {
    FLORA_ORIGIN: origin, FLORA_OWNER_ID: "synthetic-owner", FLORA_OWNER_EMAIL: email, FLORA_DB_IDENTITY: "synthetic-db",
    ...(setup ? { FLORA_SETUP: setup } : {}),
  } });
  t.after(() => runtime.dispose());
  const call = (path: string, body?: unknown, headers: Record<string, string> = {}) => runtime.fetch(origin + path, {
    method: body === undefined ? "GET" : "POST", headers: { ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: origin }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body && typeof body === "object" && ["/api/auth/enroll", "/api/auth/recover"].includes(path) ? { confirmation: (body as { password?: unknown }).password, ...body } : body) }),
  });
  const control = (body: unknown) => call("/__test/control", body);
  await control({ now: start });
  return { runtime, call, control, stats: async () => (await control({ sql: "SELECT * FROM flora_auth_budget" })).json() as Promise<{ attempts: number; kdfs: number }[]> };
}
function cookies(response: { headers: { getSetCookie(): string[] } }): string {
  return response.headers.getSetCookie().map(cookie => cookie.split(";", 1)[0]).join("; ");
}
async function enroll(h: Awaited<ReturnType<typeof harness>>, cap: ReturnType<typeof capability>, secret = password()) {
  const response = await h.call("/api/auth/enroll", { email, password: secret, token: cap.token });
  assert.equal(response.status, 200);
  return { secret, cookie: cookies(response), data: await response.json() as { csrfToken: string; expiresAt: number } };
}

test("setup_starts_locked", async t => {
  const h = await harness(t);
  const result = await h.call("/api/auth/enroll", { email, password: password(), token: capability().token });
  assert.equal(result.status, 403);
  assert.equal((await h.call("/api/auth/provision", {})).status, 404);
  assert.equal((await h.call("/api/auth/session")).status, 401);
});

test("first_claim_is_atomic", async t => {
  const cap = capability(), h = await harness(t, cap.setup), secret = password();
  const results = await Promise.all(Array.from({ length: 3 }, () => h.call("/api/auth/enroll", { email, password: secret, token: cap.token })));
  assert.equal(results.filter(response => response.status === 200).length, 1);
  assert.ok(results.filter(response => response.status !== 200).every(response => [403, 409].includes(response.status)));
  assert.equal((await h.stats())[0]!.kdfs, 1);
  const meta = await (await h.control({ sql: "SELECT epoch, setup_closed FROM flora_auth_meta" })).json();
  assert.deepEqual(meta, [{ epoch: 1, setup_closed: 1 }]);
});

test("consumed_or_old_generation_never_reopens", async t => {
  const cap = capability(2), h = await harness(t, cap.setup);
  await enroll(h, cap);
  await h.control({ restart: true });
  assert.equal((await h.call("/api/auth/enroll", { email, password: password(), token: cap.token })).status, 403);
  const old = capability(1, "recover");
  await h.control({ setup: old.setup, restart: true });
  assert.equal((await h.call("/api/auth/recover", { email, password: password(), token: old.token })).status, 403);
  await h.control({ setup: cap.setup, restart: true });
  assert.equal((await h.call("/api/auth/enroll", { email, password: password(), token: cap.token })).status, 403);
});

test("same_generation_cannot_extend_or_change_purpose", async t => {
  const cap = capability(), h = await harness(t, cap.setup);
  await h.call("/api/auth/session");
  await h.control({ setup: { ...cap.setup, issuedAt: start + 1, expiresAt: start + 600_001 }, restart: true });
  assert.equal((await h.call("/api/auth/enroll", { email, password: password(), token: cap.token })).status, 403);
  await h.control({ setup: cap.setup, restart: true });
  assert.equal((await h.call("/api/auth/enroll", { email, password: password(), token: cap.token })).status, 403);
  const next = capability(2, "recover");
  await h.control({ setup: next.setup, restart: true });
  assert.equal((await h.call("/api/auth/recover", { email, password: password(), token: next.token })).status, 403);
});

test("expired_setup_after_kdf_cannot_commit", async t => {
  const cap = capability(), h = await harness(t, cap.setup);
  await h.control({ jumpOnReservation: cap.setup.expiresAt });
  assert.equal((await h.call("/api/auth/enroll", { email, password: password(), token: cap.token })).status, 403);
  assert.equal((await h.stats())[0]!.kdfs, 1);
  assert.deepEqual(await (await h.control({ sql: "SELECT epoch, verifier FROM flora_auth_meta" })).json(), [{ epoch: 0, verifier: null }]);
  await h.control({ now: start, restart: true });
  assert.equal((await h.call("/api/auth/enroll", { email, password: password(), token: cap.token })).status, 403);
});

test("recover_revokes_every_session_atomically", async t => {
  const cap = capability(), h = await harness(t, cap.setup), first = await enroll(h, cap);
  const second = await h.call("/api/auth/login", { email, password: first.secret });
  assert.equal(second.status, 200);
  assert.equal((await h.call("/__test/grant", undefined, { Cookie: first.cookie })).status, 200);
  const recover = capability(2, "recover"), nextSecret = password();
  await h.control({ setup: recover.setup });
  const result = await h.call("/api/auth/recover", { email, password: nextSecret, token: recover.token });
  assert.equal(result.status, 200);
  for (const cookie of [first.cookie, cookies(second)]) assert.equal((await h.call("/api/auth/session", undefined, { Cookie: cookie })).status, 401);
  assert.equal((await h.control({ assertGrant: true })).status, 401);
  assert.equal((await h.call("/api/auth/login", { email, password: first.secret })).status, 401);
  assert.equal((await h.call("/api/auth/login", { email, password: nextSecret })).status, 200);
  assert.equal((await h.call("/api/auth/recover", { email, password: password(), token: recover.token })).status, 403);
});

test("unicode_and_paste_round_trip_exactly", async t => {
  const cap = capability(), h = await harness(t, cap.setup);
  for (const bad of ["🙂".repeat(14), "🙂".repeat(129), password() + "\ud800"]) {
    assert.equal((await h.call("/api/auth/enroll", { email, password: bad, token: cap.token })).status, 400);
  }
  const secret = "  é🙂\n" + password() + "  ", session = await enroll(h, cap, secret);
  assert.equal((await h.call("/api/auth/login", { email, password: secret.normalize("NFD") })).status, 401);
  assert.equal((await h.call("/api/auth/login", { email, password: secret.trim() })).status, 401);
  assert.equal((await h.call("/api/auth/login", { email, password: session.secret })).status, 200);
});

test("fixed_windows_survive_eviction", async t => {
  const cap = capability(), h = await harness(t, cap.setup), first = await enroll(h, cap);
  for (let i = 0; i < 4; i++) assert.equal((await h.call("/api/auth/login", { email, password: password() })).status, 401);
  await h.control({ restart: true });
  const throttled = await h.call("/api/auth/login", { email, password: first.secret });
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get("Retry-After"), "900");
  assert.equal((await h.stats())[0]!.kdfs, 5);
  await h.control({ now: start + 900_000 });
  assert.equal((await h.call("/api/auth/login", { email, password: first.secret })).status, 200);
  assert.equal((await h.stats())[0]!.attempts, 1);
  await h.control({ sql: "UPDATE flora_auth_budget SET attempts=0,kdfs=60" });
  assert.equal((await h.call("/api/auth/login", { email, password: first.secret })).status, 429);
  await h.control({ now: start + 3_600_000, restart: true });
  assert.equal((await h.call("/api/auth/login", { email, password: first.secret })).status, 200);
  assert.equal((await h.stats())[0]!.kdfs, 1);
});

test("busy_never_queues_raw_passwords", async t => {
  const cap = capability(), h = await harness(t, cap.setup);
  await h.control({ heavy: "take" });
  const response = await h.call("/api/auth/enroll", { email, password: password(), token: cap.token });
  assert.equal(response.status, 409);
  assert.equal(response.headers.get("Retry-After"), "1");
  assert.deepEqual(await (await h.call("/__test/unread-body")).json(), { status: 409, reads: 0 });
  assert.equal((await h.stats())[0]!.kdfs, 0);
  await h.control({ heavy: "release" });
  await enroll(h, cap);
});

test("sessions_expire_and_sixth_revokes_oldest", async t => {
  const cap = capability(), h = await harness(t, cap.setup), first = await enroll(h, cap);
  const live = [first.cookie];
  for (let i = 1; i <= 5; i++) {
    await h.control({ now: start + (i === 5 ? 900_000 : i) });
    const response = await h.call("/api/auth/login", { email, password: first.secret });
    assert.equal(response.status, 200);
    live.push(cookies(response));
  }
  assert.equal((await h.call("/api/auth/session", undefined, { Cookie: live[0]! })).status, 401);
  for (const cookie of live.slice(1)) assert.equal((await h.call("/api/auth/session", undefined, { Cookie: cookie })).status, 200);
  await h.control({ now: start + 900_000 + 3_600_000 });
  assert.equal((await h.call("/api/auth/session", undefined, { Cookie: live[5]! })).status, 401);
});

test("csrf_survives_reload_and_concurrent_tabs", async t => {
  const cap = capability(), h = await harness(t, cap.setup), first = await enroll(h, cap);
  await h.control({ restart: true });
  const results = await Promise.all([1, 2].map(() => h.call("/api/auth/session", undefined, { Cookie: first.cookie })));
  for (const response of results) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.getSetCookie().length, 0);
    assert.deepEqual(await response.json(), first.data);
  }
  assert.equal((await h.call("/api/auth/logout", {}, { Cookie: first.cookie })).status, 403);
  assert.equal((await h.call("/api/auth/logout", {}, { Cookie: first.cookie, "X-Flora-CSRF": first.data.csrfToken, Origin: "https://other.example.test" })).status, 403);
  const logout = await h.call("/api/auth/logout", {}, { Cookie: first.cookie, "X-Flora-CSRF": first.data.csrfToken });
  assert.equal(logout.status, 200);
  assert.equal(logout.headers.getSetCookie().length, 2);
  assert.ok(logout.headers.getSetCookie().every(value => value.includes("Max-Age=0")));
  assert.equal((await h.call("/api/auth/session", undefined, { Cookie: first.cookie })).status, 401);
});

test("storage_failure_never_authenticates", async t => {
  const cap = capability(), h = await harness(t, cap.setup), first = await enroll(h, cap);
  const injected = await h.control({ failStorage: true });
  assert.equal(injected.status, 200);
  assert.equal(await injected.text(), "ok");
  const deniedSession = await h.call("/api/auth/session", undefined, { Cookie: first.cookie });
  const deniedLogin = await h.call("/__test/auth-before-body", { email, password: first.secret });
  for (const response of [deniedSession, deniedLogin]) {
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "AUTH_UNAVAILABLE" });
    assert.equal(response.headers.getSetCookie().length, 0);
  }
  assert.equal(deniedLogin.headers.get("X-Flora-Test-Body-Reads"), "0");
  const restored = await h.control({ failStorage: false });
  assert.equal(restored.status, 200);
  assert.equal(await restored.text(), "ok");
  const current = await h.call("/api/auth/session", undefined, { Cookie: first.cookie });
  assert.equal(current.status, 200);
  assert.deepEqual(await current.json(), first.data);
});

test("configured_identity_and_exact_origin_fail_closed", async t => {
  const cap = capability(), h = await harness(t, cap.setup), first = await enroll(h, cap);
  for (const suppliedOrigin of ["", origin + "/", "null", "https://other.example.test"]) {
    assert.equal((await h.call("/api/auth/login", { email, password: first.secret }, { Origin: suppliedOrigin })).status, 403);
  }
  assert.equal((await h.runtime.fetch("https://alias.example.test/api/auth/session", { headers: { Cookie: first.cookie } })).status, 403);
  await h.control({ ownerEmail: "changed-owner@example.test", restart: true });
  assert.equal((await h.call("/api/auth/session", undefined, { Cookie: first.cookie })).status, 503);
  assert.equal((await h.call("/api/auth/enroll", { email: "changed-owner@example.test", password: password(), token: cap.token })).status, 503);
});

test("wrong_owner_and_malformed_capabilities_cannot_spend_kdf_or_provision", async t => {
  const cap = capability(), h = await harness(t, cap.setup);
  for (const token of ["", cap.token + "=", cap.token.slice(1), capability().token, null]) {
    assert.equal((await h.call("/api/auth/enroll", { email, password: password(), token })).status, 403);
  }
  assert.equal((await h.call("/api/auth/enroll", { email: "someone@example.test", password: password(), token: cap.token })).status, 403);
  assert.equal((await h.stats())[0]!.kdfs, 0);
  const first = await enroll(h, cap);
  const unknown = await h.call("/api/auth/login", { email: "someone@example.test", password: first.secret });
  const mismatch = await h.call("/api/auth/login", { email, password: password() });
  assert.equal(unknown.status, 401);
  assert.equal(mismatch.status, 401);
  assert.deepEqual(await unknown.json(), await mismatch.json());
  assert.equal((await h.stats())[0]!.kdfs, 2);
  assert.deepEqual(await (await h.control({ sql: "SELECT COUNT(*) AS n FROM flora_auth_budget" })).json(), [{ n: 1 }]);
});

test("stale_generation_after_kdf_cannot_replace_new_window", async t => {
  const cap = capability(), h = await harness(t, cap.setup), next = capability(2);
  await h.control({ setupOnReservation: next.setup });
  assert.equal((await h.call("/api/auth/enroll", { email, password: password(), token: cap.token })).status, 403);
  assert.deepEqual(await (await h.control({ sql: "SELECT setup_generation,epoch FROM flora_auth_meta" })).json(), [{ setup_generation: 2, epoch: 0 }]);
  await h.control({ setup: cap.setup, restart: true });
  assert.equal((await h.call("/api/auth/enroll", { email, password: password(), token: cap.token })).status, 403);
  await h.control({ setup: next.setup, restart: true });
  await enroll(h, next);
});

test("expired_and_future_setup_windows_are_not_enrollment_rights", async t => {
  const cap = capability(), h = await harness(t, cap.setup);
  await h.control({ now: start - 1 });
  assert.equal((await h.call("/api/auth/enroll", { email, password: password(), token: cap.token })).status, 403);
  await h.control({ now: cap.setup.expiresAt });
  assert.equal((await h.call("/api/auth/enroll", { email, password: password(), token: cap.token })).status, 403);
  await h.control({ now: start, restart: true });
  assert.equal((await h.call("/api/auth/enroll", { email, password: password(), token: cap.token })).status, 403);
  assert.equal((await h.stats())[0]!.kdfs, 0);
});

test("cookie_pair_is_independent_hash_only_and_strict", async t => {
  const cap = capability(), h = await harness(t, cap.setup), secret = password();
  const response = await h.call("/api/auth/enroll", { email, password: secret, token: cap.token });
  assert.equal(response.status, 200);
  const pair = response.headers.getSetCookie();
  assert.equal(pair.length, 2);
  for (const value of pair) {
    assert.match(value, /^__Host-flora_(session|csrf)=[A-Za-z0-9_-]{43}; Secure; HttpOnly; SameSite=Strict; Path=\/; Max-Age=3600$/);
    assert.equal(value.includes("Domain="), false);
  }
  const jar = cookies(response), [rawSession, rawCsrf] = pair.map(value => value.split(";", 1)[0]!.split("=")[1]!);
  assert.notEqual(rawSession, rawCsrf);
  const data = await response.json() as { csrfToken: string; expiresAt: number };
  assert.deepEqual(data, { csrfToken: rawCsrf, expiresAt: start + 3_600_000 });
  const rows = await (await h.control({ sql: "SELECT session_hash,csrf_hash FROM flora_auth_sessions" })).json();
  assert.deepEqual(rows, [{ session_hash: createHash("sha256").update(Buffer.from(rawSession!, "base64url")).digest("hex"), csrf_hash: createHash("sha256").update(Buffer.from(rawCsrf!, "base64url")).digest("hex") }]);
  for (const cookie of [jar.split("; ")[0]!, jar.replace(rawCsrf!, capability().token), jar + "; " + jar.split("; ")[0]!]) {
    assert.equal((await h.call("/api/auth/session", undefined, { Cookie: cookie })).status, 401);
  }
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("grant_fence_is_synchronous_and_revokes_on_logout_and_expiry", async t => {
  const cap = capability(), h = await harness(t, cap.setup), first = await enroll(h, cap);
  assert.equal((await h.call("/__test/grant", undefined, { Cookie: first.cookie })).status, 200);
  assert.equal((await h.control({ assertGrant: true })).status, 200);
  assert.equal((await h.control({ fakeGrant: true })).status, 401);
  assert.equal((await h.call("/__test/grant", {}, { Cookie: first.cookie })).status, 401);
  assert.equal((await h.call("/api/auth/logout", {}, { Cookie: first.cookie, "X-Flora-CSRF": first.data.csrfToken })).status, 200);
  assert.equal((await h.control({ assertGrant: true })).status, 401);
  const next = await h.call("/api/auth/login", { email, password: first.secret });
  assert.equal((await h.call("/__test/grant", undefined, { Cookie: cookies(next) })).status, 200);
  await h.control({ now: start + 3_600_000 });
  assert.equal((await h.control({ assertGrant: true })).status, 401);
});

test("session_write_failure_rolls_back_owner_and_setup_consumption", async t => {
  const cap = capability(), h = await harness(t, cap.setup);
  await h.control({ sql: "CREATE TRIGGER fixture_fail_session BEFORE INSERT ON flora_auth_sessions BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_WRITE_PRIVATE_DETAIL'); END" });
  const failed = await h.call("/api/auth/enroll", { email, password: password(), token: cap.token });
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: "AUTH_UNAVAILABLE" });
  assert.equal(failed.headers.getSetCookie().length, 0);
  assert.deepEqual(await (await h.control({ sql: "SELECT epoch,verifier,setup_closed FROM flora_auth_meta" })).json(), [{ epoch: 0, verifier: null, setup_closed: 0 }]);
  await h.control({ sql: "DROP TRIGGER fixture_fail_session" });
  await enroll(h, cap);
});

test("failed_recovery_preserves_previous_owner_and_sessions", async t => {
  const cap = capability(), h = await harness(t, cap.setup), first = await enroll(h, cap), recover = capability(2, "recover");
  await h.control({ setup: recover.setup, sql: "CREATE TRIGGER fixture_fail_session BEFORE INSERT ON flora_auth_sessions BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_WRITE_PRIVATE_DETAIL'); END" });
  assert.equal((await h.call("/api/auth/recover", { email, password: password(), token: recover.token })).status, 503);
  assert.equal((await h.call("/api/auth/session", undefined, { Cookie: first.cookie })).status, 200);
  await h.control({ sql: "DROP TRIGGER fixture_fail_session" });
  assert.equal((await h.call("/api/auth/login", { email, password: first.secret })).status, 200);
  assert.equal((await h.call("/api/auth/recover", { email, password: password(), token: recover.token })).status, 200);
  assert.equal((await h.call("/api/auth/session", undefined, { Cookie: first.cookie })).status, 401);
});

test("counter_durability_failure_does_not_authenticate", async t => {
  const cap = capability(), h = await harness(t, cap.setup);
  await h.control({ failSync: true });
  const failed = await h.call("/api/auth/enroll", { email, password: password(), token: cap.token });
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: "AUTH_UNAVAILABLE" });
  assert.equal(failed.headers.getSetCookie().length, 0);
  await h.control({ failSync: false });
  assert.deepEqual(await (await h.control({ sql: "SELECT epoch,verifier FROM flora_auth_meta" })).json(), [{ epoch: 0, verifier: null }]);
  await enroll(h, cap);
});

test("crypto_dependency_failure_is_503_and_releases_heavy_guard", async t => {
  const cap = capability(), h = await harness(t, cap.setup), first = await enroll(h, cap);
  for (const failCrypto of ["random", "digest"]) {
    await h.control({ failCrypto });
    const failed = await h.call("/api/auth/login", { email, password: first.secret });
    assert.equal(failed.status, 503, failCrypto);
    assert.deepEqual(await failed.json(), { error: "AUTH_UNAVAILABLE" });
    assert.equal(failed.headers.getSetCookie().length, 0);
    await h.control({ failCrypto: "off" });
  }
  assert.equal((await h.call("/api/auth/login", { email, password: first.secret })).status, 200);
});

test("auth_body_and_utf8_are_bounded_before_kdf", async t => {
  const cap = capability(), h = await harness(t, cap.setup), secret = password();
  const raw = JSON.stringify({ email, password: secret, confirmation: secret, token: cap.token });
  const post = (body: string | Uint8Array) => h.runtime.fetch(origin + "/api/auth/enroll", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body });
  assert.equal((await post(raw.padEnd(8193, " "))).status, 413);
  assert.equal((await post(Uint8Array.from([0xc0, 0xaf]))).status, 400);
  assert.equal((await h.call("/api/auth/enroll", { email, password: secret, token: cap.token }, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await h.stats())[0]!.kdfs, 0);
  assert.equal((await post(raw.padEnd(8192, " "))).status, 200);
});

test("real_object_eviction_preserves_consumed_setup_and_budget", async t => {
  const cap = capability(), h = await harness(t, cap.setup), first = await enroll(h, cap);
  await h.control({ heavy: "take" });
  await h.control({ evict: true });
  assert.equal((await h.call("/api/auth/session", undefined, { Cookie: first.cookie })).status, 200);
  assert.equal((await h.call("/api/auth/enroll", { email, password: password(), token: cap.token })).status, 403);
  assert.equal((await h.call("/api/auth/login", { email, password: first.secret })).status, 200);
  assert.equal((await h.stats())[0]!.kdfs, 2);
});

test("kernel_rejection_maps_to_503_in_the_real_do", async t => {
  // workerd's native named scrypt export cannot be monkeypatched with Node's
  // syncBuiltinESMExports. Substitute only that kernel module boundary in a
  // temporary bundle: the authority code, real enrollment KDF and SQLite stay
  // unchanged. password.test.ts independently proves real native-fault rejection.
  const directory = await mkdtemp(join(tmpdir(), "flora-kdf-fault-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authorityPath = fileURLToPath(new URL("../dist/auth-do.js", import.meta.url));
  const kernelPath = fileURLToPath(new URL("../dist/auth/password.js", import.meta.url));
  const faultKernel = join(directory, "password-fault.mjs");
  await writeFile(faultKernel, `export { createPasswordVerifier } from ${JSON.stringify(kernelPath)}; export async function verifyPassword() { throw new Error("PASSWORD_KDF_FAILED"); }`);
  const source = await readFile(authorityPath, "utf8");
  assert.equal(source.split('from "./auth/password.js"').length, 2);
  const authority = source.replace(/from "(\.[^"]+)"/g, (_, specifier: string) => `from ${JSON.stringify(specifier === "./auth/password.js" ? faultKernel : resolve(dirname(authorityPath), specifier))}`);
  const injectedAuthority = join(directory, "auth-do.mjs");
  await writeFile(injectedAuthority, authority);
  const fixture = await readFile(new URL("./fixtures/auth-entry.ts", import.meta.url), "utf8");
  assert.equal(fixture.split('"../../dist/auth-do.js"').length, 2);
  const entrypoint = join(directory, "auth-entry.ts");
  await writeFile(entrypoint, fixture.replace('"../../dist/auth-do.js"', JSON.stringify(injectedAuthority)));
  const cap = capability(), h = await harness(t, cap.setup, entrypoint), first = await enroll(h, cap);
  const failed = await h.call("/api/auth/login", { email, password: first.secret });
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: "AUTH_UNAVAILABLE" });
  assert.equal(failed.headers.getSetCookie().length, 0);
  assert.equal((await h.call("/api/auth/session", undefined, { Cookie: first.cookie })).status, 200);
  const retry = await h.call("/api/auth/login", { email, password: first.secret });
  assert.equal(retry.status, 503); // Guard was released, so this is not BUSY.
});

test("unicode_codepoint_boundaries_work_through_native_do_kdf", async t => {
  for (const length of [15, 128]) {
    const cap = capability(), h = await harness(t, cap.setup);
    const secret = String.fromCodePoint(0x1f300 + randomBytes(1)[0]!).repeat(length);
    await enroll(h, cap, secret);
    assert.equal((await h.call("/api/auth/login", { email, password: secret })).status, 200);
  }
});

test("body_deadline_releases_heavy_guard_without_kdf", async t => {
  const cap = capability(), h = await harness(t, cap.setup);
  const result = await h.call("/__test/slow-body");
  assert.equal(result.status, 408);
  assert.equal((await h.stats())[0]!.kdfs, 0);
  await enroll(h, cap);
});

test("initial_storage_failure_is_sanitized_and_stays_closed", async t => {
  const cap = capability(), h = await harness(t, cap.setup);
  await h.control({ failStorage: true, restart: true });
  assert.equal((await h.call("/api/auth/enroll", { email, password: password(), token: cap.token })).status, 503);
  await h.control({ failStorage: false });
  assert.equal((await h.call("/api/auth/enroll", { email, password: password(), token: cap.token })).status, 503);
  await h.control({ restart: true });
  await enroll(h, cap);
});


test("enroll_and_recover_require_exact_confirmation_before_kdf", async t => {
  const cap = capability(), h = await harness(t, cap.setup), secret = password();
  const missing = await h.runtime.fetch(origin + "/api/auth/enroll", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ email, password: secret, token: cap.token }) });
  assert.equal(missing.status, 400);
  assert.equal((await h.call("/api/auth/enroll", { email, password: secret, confirmation: secret + " ", token: cap.token })).status, 400);
  assert.equal((await h.stats())[0]!.kdfs, 0);
  await enroll(h, cap, secret);
  const next = capability(2, "recover");
  await h.control({ setup: next.setup });
  const missingRecovery = await h.runtime.fetch(origin + "/api/auth/recover", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ email, password: secret, token: next.token }) });
  assert.equal(missingRecovery.status, 400);
  assert.equal((await h.call("/api/auth/recover", { email, password: secret, confirmation: secret.normalize("NFD") + " ", token: next.token })).status, 400);
  assert.equal((await h.stats())[0]!.kdfs, 1);
});
