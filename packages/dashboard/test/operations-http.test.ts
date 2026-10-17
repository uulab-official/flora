import test from "node:test";
import assert from "node:assert/strict";
import { startDashboard } from "@app-ops/dashboard";
import type { DogfoodService } from "@app-ops/dashboard/service";
import { DomainError } from "@app-ops/core";

test("GitHub and OTA management routes retain session and CSRF boundaries and binary bytes", async () => {
  const calls: unknown[] = [];
  const state = { connection: null, detections: [], assets: [], deployments: [] };
  const operations = {
    getState: async (appId: string) => { calls.push(["state", appId]); return state; },
    connect: async (appId: string, input: unknown) => { calls.push(["connect", appId, input]); return { id: "detection_test" }; },
    detect: async (appId: string) => { calls.push(["sync", appId]); return { id: "detection_sync" }; },
    uploadAsset: async (appId: string, input: unknown, bytes: Uint8Array) => { calls.push(["asset", appId, input, Array.from(bytes)]); return { id: "asset_test" }; },
    publish: async (appId: string, input: unknown) => { calls.push(["publish", appId, input]); return { id: "release_test" }; },
  };
  const app = await startDashboard({ service: { operations } as unknown as DogfoodService });
  try {
    const path = "/api/apps/application_test";
    assert.equal((await fetch(app.origin + path + "/operations")).status, 401);
    assert.equal(calls.length, 0);
    const enrolled = await fetch(app.origin + "/api/session", { method: "POST", headers: { Origin: app.origin, "Content-Type": "application/json" }, body: JSON.stringify({ bootstrap: new URL(app.bootstrapUrl).hash.slice(1) }) });
    const csrf = (await enrolled.json()).csrfToken;
    const cookie = enrolled.headers.get("set-cookie")!.split(";")[0]!;
    const headers = { Cookie: cookie, Origin: app.origin, "X-Flora-CSRF": csrf, "Content-Type": "application/json" };
    assert.equal((await fetch(app.origin + path + "/github", { method: "POST", headers: { ...headers, "X-Flora-CSRF": "" }, body: "{}" })).status, 403);
    assert.equal(calls.length, 0);
    const result = await fetch(app.origin + path + "/operations", { headers: { Cookie: cookie } });
    assert.equal(result.status, 200); assert.deepEqual(await result.json(), state);
    const input = { expectedVersion: 0, installationId: 42, owner: "example", repository: "expo-app", ref: "main" };
    assert.equal((await fetch(app.origin + path + "/github", { method: "POST", headers, body: JSON.stringify(input) })).status, 201);
    assert.equal((await fetch(app.origin + path + "/github/sync", { method: "POST", headers, body: "{}" })).status, 201);
    const uploaded = await fetch(app.origin + path + "/ota/assets?key=bundle&contentType=application%2Fjavascript&fileExtension=.js", { method: "POST", headers: { ...headers, "Content-Type": "application/octet-stream" }, body: new Uint8Array([0, 255, 1, 2]) });
    assert.equal(uploaded.status, 201);
    assert.deepEqual(calls.find(value => Array.isArray(value) && value[0] === "asset"), ["asset", "application_test", { key: "bundle", contentType: "application/javascript", fileExtension: ".js" }, [0, 255, 1, 2]]);
    assert.deepEqual(calls.find(value => Array.isArray(value) && value[0] === "connect"), ["connect", "application_test", input]);
    assert.equal((await fetch(app.origin + path + "/operations?appId=application_other", { headers: { Cookie: cookie } })).status, 400);
    assert.equal((await fetch(app.origin + path + "/ota/assets?key=bundle&contentType=text%2Fhtml&fileExtension=.html", { method: "POST", headers, body: "{}" })).status, 415);
  } finally { await app.close(); }
});
test("local GitHub management returns the same safe source failure statuses as hosted management", async () => {
  const cases = [["GITHUB_ACCESS_DENIED", 403], ["GITHUB_REPOSITORY_UNAVAILABLE", 404], ["GITHUB_REF_NOT_FOUND", 404], ["GITHUB_APP_UNSUPPORTED", 422], ["CONFIG_CONFLICT", 409], ["PROVIDER_UNSUPPORTED", 503]] as const;
  let next: (typeof cases)[number][0] = "GITHUB_ACCESS_DENIED";
  const app = await startDashboard({ service: { operations: { async connect() { throw new DomainError(next); } } } as unknown as DogfoodService });
  try {
    const enrolled = await fetch(app.origin + "/api/session", { method: "POST", headers: { Origin: app.origin, "Content-Type": "application/json" }, body: JSON.stringify({ bootstrap: new URL(app.bootstrapUrl).hash.slice(1) }) });
    const csrf = (await enrolled.json()).csrfToken, cookie = enrolled.headers.get("set-cookie")!.split(";")[0]!;
    for (const [code, status] of cases) {
      next = code;
      const response = await fetch(app.origin + "/api/apps/application_test/github", { method: "POST", headers: { Cookie: cookie, Origin: app.origin, "X-Flora-CSRF": csrf, "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: 0, installationId: 42, owner: "example", repository: "app", ref: "main" }) });
      assert.equal(response.status, status, code); assert.deepEqual(await response.json(), { error: code });
    }
  } finally { await app.close(); }
});
