import test from "node:test";
import assert from "node:assert/strict";
import { createNativeClient } from "../dist/native-client.js";

const config = { origin: "https://flora.example.test", token: "native_runner_fixture." + "a".repeat(43), appId: "app_fixture", platform: "android" as const };
function originalLease() {
  return { jobId: "job_fixture", appId: config.appId, platform: config.platform, runnerId: "native_runner_fixture", attemptId: "attempt_fixture", credentialEpoch: 1, fence: 1, expiresAt: Date.now() + 60_000 };
}

test("claim retains legacy bounded job IDs while enforcing wrong-app lease and redirect refusal", async () => {
  let redirect: RequestRedirect | undefined, calls = 0;
  const client = createNativeClient({ ...config, fetch: async (_input, init) => {
    calls++; redirect = init?.redirect;
    assert.deepEqual(JSON.parse(String(init?.body)), { jobId: "job_fixture" });
    return Response.json({ lease: { ...originalLease(), appId: "app_other" }, job: {} });
  } });
  await assert.rejects(client.claim("job_fixture"), /^Error: NATIVE_RESPONSE_INVALID$/);
  assert.equal(calls, 1);
  assert.equal(redirect, "error");
});

test("a correctly scoped legacy claim remains accepted without broadening pending response IDs", async () => {
  const l = originalLease();
  const job = { id: l.jobId, appId: l.appId, platform: l.platform, state: "leased", commitSha: "b".repeat(40), appIdentifier: "kr.co.uulab.fixture", configDigest: "c".repeat(64), credentials: [], source: { owner: "example", repository: "app", ref: "main", rootDirectory: "." } };
  const client = createNativeClient({ ...config, fetch: async (url) => String(url).endsWith("/claim")
    ? Response.json({ job, lease: l }) : Response.json({ jobId: "job_fixture" }) });
  assert.deepEqual(await client.claim("job_fixture"), { job, lease: l });
  await assert.rejects(client.pending(), /^Error: NATIVE_RESPONSE_INVALID$/);
});
