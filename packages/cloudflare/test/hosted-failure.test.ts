import test from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "@app-ops/core";
import { hostedFailure } from "../dist/hosted-api.js";
import { HttpFailure } from "../dist/http.js";
import { runInNewContext } from "node:vm";

const known = [
  ["Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.", "D1_DAILY_READ_LIMIT"],
  ["Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.", "D1_DAILY_WRITE_LIMIT"],
  ["Your account has exceeded D1's maximum account storage limit, please contact Cloudflare to raise your limit", "D1_ACCOUNT_STORAGE_LIMIT"],
  ["Exceeded maximum DB size.", "D1_DATABASE_SIZE_LIMIT"],
  ["D1 DB is overloaded. Requests queued for too long.", "D1_OVERLOADED"],
  ["D1 DB is overloaded. Too many requests queued.", "D1_OVERLOADED"],
] as const;

test("known D1 dependency failures expose only fixed 503 codes and retain secure response headers", async t => {
  for (const [message, code] of known) for (const prefix of ["", "D1_ERROR: "]) await t.test(code + (prefix ? " prefixed" : " direct"), async () => {
    const response = hostedFailure(new Error(prefix + message + " PRIVATE_SQL_PRIVATE_TOKEN"));
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: code });
    assert.equal(response.headers.get("Cache-Control"), "no-store"); assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff"); assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  });
});

test("D1 classification follows at most four Error objects including empty wrappers and keeps arbitrary wrapper secrets private", async () => {
  const leaf = new Error("D1_ERROR: " + known[0][0]);
  const nested = new Error("PRIVATE_TOKEN SELECT * FROM private_settings", { cause: new Error("", { cause: new Error("D1_ERROR", { cause: leaf }) }) });
  const response = hostedFailure(nested); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "D1_DAILY_READ_LIMIT" });
  const tooDeep = hostedFailure(new Error("", { cause: nested })); assert.equal(tooDeep.status, 503); assert.deepEqual(await tooDeep.json(), { error: "DEPENDENCY_UNAVAILABLE" });
});
test("observed quota error is classified across native Error realms and own-data exception wrappers", async () => {
  const observed = "D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue. See [URL] for more details.";
  const foreign = runInNewContext("new Error(message)", { message: observed }) as unknown;
  assert.equal(foreign instanceof Error, false, "exercise a real foreign native Error rather than a local Error double");
  for (const error of [foreign, new Error("", { cause: foreign }), { message: observed }, { message: "D1_ERROR", cause: { message: observed } }]) {
    const response = hostedFailure(error); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "D1_DAILY_READ_LIMIT" });
  }
});

test("unknown, SQL-contained, malformed, cyclic and oversized D1 errors remain generic without inspecting accessors", async () => {
  const cyclic = new Error("PRIVATE_SQL"); Object.defineProperty(cyclic, "cause", { value: cyclic });
  const revoked = Proxy.revocable(new Error("PRIVATE_PROXY"), {}); revoked.revoke();
  let reads = 0; const accessor = new Error(), plainAccessor = {};
  for (const key of ["message", "cause"]) Object.defineProperty(accessor, key, { get() { reads++; throw Error("PRIVATE_ACCESSOR"); } });
  for (const key of ["message", "cause"]) Object.defineProperty(plainAccessor, key, { get() { reads++; throw Error("PRIVATE_ACCESSOR"); } });
  const array = Object.assign([], { message: known[0][0] }), callable = Object.assign(() => {}, { message: known[0][0] });
  for (const error of [undefined, null, "PRIVATE_TOKEN", { message: "PRIVATE_SQL" }, Object.create({ message: known[0][0] }), array, callable, new Error("D1_ERROR: SELECT * FROM private_settings; " + known[0][0]),
    new Error("prefix " + known[0][0]), new Error("Your account has exceeded D1's free tier daily row read limitation"),
    new Error("D1_ERROR: D1 DB exceeded its CPU time limit and was reset. PRIVATE_SECRET"), new Error(known[0][0] + "x".repeat(8192)),
    new Error("D1_ERROR", { cause: { message: "PRIVATE_SQL" } }), new Error("", { cause: revoked.proxy }), cyclic, accessor, plainAccessor]) {
    const response = hostedFailure(error); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "DEPENDENCY_UNAVAILABLE" });
  }
  assert.equal(reads, 0);
});

test("existing domain and HTTP authority or capacity decisions take precedence over D1 causes", async () => {
  for (const [error, status, code] of [[new DomainError("CONFLICT"), 409, "CONFLICT"], [new HttpFailure(403, "FORBIDDEN"), 403, "FORBIDDEN"]] as const) {
    Object.defineProperty(error, "cause", { value: new Error("D1_ERROR: " + known[0][0]) });
    const response = hostedFailure(error); assert.equal(response.status, status); assert.deepEqual(await response.json(), { error: code });
  }
});
