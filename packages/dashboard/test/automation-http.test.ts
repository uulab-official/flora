import test from "node:test";
import assert from "node:assert/strict";
import { startDashboard } from "@app-ops/dashboard";
import type { DogfoodService } from "@app-ops/dashboard/service";

test("automation operator and machine routes use distinct credentials and validate before asset bodies", async () => {
  const calls: string[] = [];
  const automation = {
    getState: async (appId: string) => ({ jobs: [], runners: [], appId }),
    enrollRunner: async () => ({ runner: { id: "runner_test" }, token: "synthetic_one_time" }),
    authorizeRunner: async (token: string) => { calls.push("authorize"); if (token !== "synthetic_machine") throw Object.assign(new Error("denied"), { status: 403 }); },
    claim: async () => { calls.push("claim"); return null; },
  };
  const app = await startDashboard({ service: { automation } as unknown as DogfoodService });
  try {
    assert.equal((await fetch(app.origin + "/api/apps/application_test/automation")).status, 401);
    assert.equal((await fetch(app.origin + "/api/runner/claim", { method: "POST", headers: { Origin: app.origin, "Content-Type": "application/json" }, body: "{}" })).status, 401);
    const claim = await fetch(app.origin + "/api/runner/claim", { method: "POST", headers: { Origin: app.origin, Authorization: "Bearer synthetic_machine", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(claim.status, 204); assert.deepEqual(calls, ["authorize", "claim"]);
    const enrollment = await fetch(app.origin + "/api/session", { method: "POST", headers: { Origin: app.origin, "Content-Type": "application/json" }, body: JSON.stringify({ bootstrap: new URL(app.bootstrapUrl).hash.slice(1) }) });
    const headers = { Cookie: enrollment.headers.get("set-cookie")!.split(";")[0]!, Origin: app.origin, "X-Flora-CSRF": (await enrollment.json()).csrfToken, "Content-Type": "application/json" };
    const state = await fetch(app.origin + "/api/apps/application_test/automation", { headers }); assert.equal(state.status, 200); assert.equal((await state.json()).appId, "application_test");
    const enroll = await fetch(app.origin + "/api/runners", { method: "POST", headers, body: JSON.stringify({ name: "test", appIds: ["application_test"] }) }); assert.equal(enroll.status, 201);
    assert.equal((await fetch(app.origin + "/api/runners", { method: "POST", headers: { ...headers, "X-Flora-CSRF": "" }, body: "{}" })).status, 403);
    assert.equal((await fetch(app.origin + "/api/runner/claim", { method: "POST", headers, body: "{}" })).status, 401, "browser session is not machine authority");
  } finally { await app.close(); }
});
