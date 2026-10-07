import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { observeUpload, uploadResetEvidence } from "../scripts/hosted-qa/upload-outcome.mjs";
import { SYNTHETIC_ORIGIN } from "../scripts/hosted-qa/transport.mjs";

// A missing requestfailed listener, broad error allowlist, or leaked listener
// makes these test-only capture contracts fail. No product fetch is replaced.
const request = (path = "/api/sources", method = "POST", origin: string = SYNTHETIC_ORIGIN) => ({
  url: () => origin + path, method: () => method, failure: () => ({ errorText: "net::ERR_FAILED" }),
});
test("upload observer accepts only the matching POST response and removes all listeners", async () => {
  const page = new EventEmitter(); const pending = observeUpload(page, "/api/sources");
  for (const other of [request("/api/baselines"), request("/api/sources", "GET"), request("/api/sources", "POST", "https://other.example.test")]) {
    page.emit("response", { request: () => other }); page.emit("requestfailed", other);
  }
  assert.equal(page.listenerCount("response"), 1);
  const matching = request(); const response = { request: () => matching };
  page.emit("response", response); assert.deepEqual(await pending.result, { kind: "response", request: matching, response });
  assert.equal(page.listenerCount("response"), 0); assert.equal(page.listenerCount("requestfailed"), 0);
});
test("upload observer returns the original failed request instead of waiting for a response", async () => {
  const page = new EventEmitter(); const pending = observeUpload(page, "/api/sources"); const matching = request();
  page.emit("requestfailed", matching);
  assert.deepEqual(await pending.result, { kind: "requestfailed", request: matching, failure: { errorText: "net::ERR_FAILED" } });
  assert.equal(page.listenerCount("response"), 0); assert.equal(page.listenerCount("requestfailed"), 0);
});
test("upload observer times out or cancels without leaving listeners behind", async () => {
  const page = new EventEmitter();
  await assert.rejects(observeUpload(page, "/api/baselines", 1).result, /UPLOAD_OUTCOME_TIMEOUT/);
  assert.equal(page.listenerCount("response"), 0); assert.equal(page.listenerCount("requestfailed"), 0);
  const pending = observeUpload(page, "/api/sources"); pending.cancel();
  assert.equal(page.listenerCount("response"), 0); assert.equal(page.listenerCount("requestfailed"), 0);
});
test("upload reset evidence retains the actual cause chain and only recognizes characterized codes", () => {
  for (const code of ["ECONNRESET", "UND_ERR_SOCKET"]) {
    const cause = Object.assign(new Error("read ECONNRESET"), { code, syscall: "read", errno: -104, socket: { bytesWritten: 6376, bytesRead: 188 } });
    const error = new Error("fetch failed", { cause });
    assert.deepEqual(uploadResetEvidence(error), { code, causes: [
      { name: "Error", message: "fetch failed" }, { name: "Error", message: "read ECONNRESET", code, syscall: "read", errno: -104, socket: { bytesWritten: 6376, bytesRead: 188 } },
    ] });
    assert.strictEqual(error.cause, cause);
  }
  for (const error of [new Error("ECONNRESET"), Object.assign(new Error("fetch failed"), { code: "EACCES" }),
    Object.assign(new Error("fetch failed"), { code: "UND_ERR_CONNECT_TIMEOUT" }), null, { code: "ECONNRESET" }]) {
    assert.equal(uploadResetEvidence(error), null);
  }
  const circular = new Error("unrelated"); circular.cause = circular;
  assert.equal(uploadResetEvidence(circular), null);
});
