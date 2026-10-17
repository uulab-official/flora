import test from "node:test";
import assert from "node:assert/strict";
import { managementRoute, dispatchManagement } from "@app-ops/dashboard/operations-http";
import { routeRequest } from "../dist/http.js";
import type { OperationsService } from "@app-ops/dogfood";

test("manual OTA rollback is an app-scoped owner mutation with strict JSON and no query overrides", async () => {
  const origin = "https://flora.example.test", path = "/api/apps/application_isso/ota/rollbacks";
  const input = { requestKey: "rollback_test", fromDeploymentId: "f5c0a0c2-1e92-4e83-9cd9-32af54bbc201", targetDeploymentId: "e5c0a0c2-1e92-4e83-9cd9-32af54bbc201", reason: "Restore verified bundle" };
  const calls: unknown[] = [], receipt = { id: "rollback_receipt" };
  const service = { rollback: async (appId: string, value: unknown) => { calls.push([appId, value]); return receipt; } } as unknown as OperationsService;
  const route = managementRoute(path);
  assert.ok(route, "rollback route must exist");
  assert.equal(route.method, "POST"); assert.equal(route.binary, false);
  const request = new Request(origin + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  assert.equal(routeRequest(request).kind, "hosted");
  assert.deepEqual(await dispatchManagement(route, new URL(request.url), input, service), receipt);
  assert.deepEqual(calls, [["application_isso", input]]);
  assert.throws(() => routeRequest(new Request(origin + path)), /METHOD_NOT_ALLOWED/);
  assert.throws(() => routeRequest(new Request(origin + path + "?appId=application_reward", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })), /INVALID_INPUT/);
  await assert.rejects(dispatchManagement(route, new URL(request.url), { ...input, rollback: { skipChecks: true } }, service));
  assert.equal(calls.length, 1, "invalid bodies must never reach the mutation");
});
