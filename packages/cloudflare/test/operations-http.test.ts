import test from "node:test";
import assert from "node:assert/strict";
import { routeRequest, readBody } from "../dist/http.js";
import { hostedFailure } from "../dist/hosted-api.js";
import { DomainError } from "@app-ops/core";

test("management OTA uploads admit bounded binary only and distribution admits GET only", async () => {
  const origin = "https://flora.example.test";
  const app = "application_example";
  const upload = new Request(origin + `/api/apps/${app}/ota/assets?key=entry&contentType=application%2Fjavascript&fileExtension=.js`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array([0, 255, 2]) });
  const admitted = routeRequest(upload);
  assert.equal(admitted.kind, "hosted"); assert.equal(admitted.limit, 16 * 1024 * 1024);
  assert.deepEqual(Array.from(await readBody(upload, admitted.limit, true)), [0, 255, 2]);
  assert.equal(routeRequest(new Request(origin + `/updates/${app}?channel=preview`)).kind, "updates");
  assert.equal(routeRequest(new Request(origin + `/updates/${app}/assets/asset_${"a".repeat(64)}`)).kind, "updates");
  assert.throws(() => routeRequest(new Request(origin + `/updates/${app}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })), /METHOD_NOT_ALLOWED/);
  assert.throws(() => routeRequest(new Request(origin + `/updates/${app}?channel=preview&channel=other`)), /INVALID_INPUT/);
  assert.throws(() => routeRequest(new Request(origin + `/api/apps/${app}/ota/assets?key=entry&contentType=application%2Fjavascript&fileExtension=.js`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })), /JSON_REQUIRED/);
  assert.throws(() => routeRequest(new Request(origin + "/api/sources", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array([1]) })), /JSON_REQUIRED/);
});
test("hosted GitHub source failures expose only the typed code and matching status", async () => {
  const cases = [["GITHUB_ACCESS_DENIED", 403], ["GITHUB_REPOSITORY_UNAVAILABLE", 404], ["GITHUB_REF_NOT_FOUND", 404], ["GITHUB_APP_UNSUPPORTED", 422], ["CONFIG_CONFLICT", 409], ["PROVIDER_UNSUPPORTED", 503]] as const;
  for (const [code, status] of cases) {
    const failure = hostedFailure(new DomainError(code));
    assert.equal(failure.status, status, code);
    assert.deepEqual(await failure.json(), { error: code });
  }
});
