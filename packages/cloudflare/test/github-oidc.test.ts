import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { GITHUB_OIDC_JWKS, verifyGitHubCIJWT } from "../dist/github-oidc.js";
import { parseCIBindingUpdate } from "../dist/managed-ci.js";
const now = 1_800_000_000_000, sec = now / 1000, sha = "a".repeat(40), workflowSha = "b".repeat(40);
const trust = { repository: "example/app", repositoryId: "123", repositoryOwnerId: "456", ref: "refs/heads/main", jobWorkflowRef: "example/flora/.github/workflows/ota.yml@" + workflowSha, jobWorkflowSha: workflowSha };
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 }), jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "synthetic-key", alg: "RS256", use: "sig" };
const claims = { iss: "https://token.actions.githubusercontent.com", aud: "https://flora.example.test", sub: "repo:example/app:ref:refs/heads/main", exp: sec + 300, iat: sec, nbf: sec,
  repository: trust.repository, repository_id: trust.repositoryId, repository_owner: "example", repository_owner_id: trust.repositoryOwnerId, ref: trust.ref, ref_type: "branch",
  event_name: "push", runner_environment: "github-hosted", sha, job_workflow_ref: trust.jobWorkflowRef, job_workflow_sha: trust.jobWorkflowSha, run_id: "123456", run_attempt: "1", jti: "synthetic-jwt-id" };
function jwt(overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const input = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid, ...header })).toString("base64url") + "." + Buffer.from(JSON.stringify({ ...claims, ...overrides })).toString("base64url");
  return input + "." + sign("RSA-SHA256", Buffer.from(input), pair.privateKey).toString("base64url");
}
function fetcher(data: unknown = { keys: [jwk] }, status = 200): typeof fetch {
  return (async (input, init) => { assert.equal(String(input), GITHUB_OIDC_JWKS); assert.equal(init?.redirect, "manual"); assert.ok(init?.signal); return Response.json(data, { status }); }) as typeof fetch;
}
test("GitHub OIDC checks actual RSA signatures and explicit reusable-workflow identities", async () => {
  assert.deepEqual(await verifyGitHubCIJWT(jwt(), trust, claims.aud, now, fetcher()), { commitSha: sha, runId: "123456", runAttempt: "1", expiresAt: (sec + 300) * 1000 });
  assert.equal((await verifyGitHubCIJWT(jwt({ sub: "repo:example@456/app@123:ref:refs/heads/main" }), trust, claims.aud, now, fetcher())).commitSha, sha);
  const forged = jwt().split("."); forged[2] = Buffer.alloc(256).toString("base64url");
  await assert.rejects(verifyGitHubCIJWT(forged.join("."), trust, claims.aud, now, fetcher()), /CI_IDENTITY_REJECTED/);
});
test("OIDC rejects foreign app/ref/workflow/event and unsafe JOSE before outbound work", async () => {
  let reads = 0; const noRead = (async () => { reads++; throw new Error("must reject before fetch"); }) as typeof fetch;
  for (const overrides of [{ iss: "https://evil.example.test" }, { aud: "https://other.example.test" }, { aud: [claims.aud] }, { repository_id: "789" }, { repository_owner_id: "789" }, { repository: "example/foreign" },
    { ref: "refs/heads/other" }, { sub: "repo:example/app:environment:prod" }, { event_name: "pull_request" }, { runner_environment: "self-hosted" },
    { job_workflow_ref: trust.jobWorkflowRef.replace(workflowSha, "c".repeat(40)) }, { job_workflow_sha: "c".repeat(40) }, { sha: "HEAD" }, { exp: sec }, { exp: sec + 601 }, { nbf: sec + 31 }, { iat: sec + 31 }]) {
    await assert.rejects(verifyGitHubCIJWT(jwt(overrides), trust, claims.aud, now, noRead), /CI_IDENTITY_REJECTED/);
  }
  for (const header of [{ alg: "none" }, { alg: "HS256" }, { jku: "https://evil.example.test/key" }, { jwk }, { crit: ["any"] }]) await assert.rejects(verifyGitHubCIJWT(jwt({}, header), trust, claims.aud, now, noRead), /CI_IDENTITY_REJECTED/);
  assert.equal(reads, 0);
});
test("JWKS is bounded and fails closed on redirects, duplicate keys and private keys", async () => {
  for (const data of [{ keys: [] }, { keys: [jwk, jwk] }, { keys: [{ ...jwk, d: "private" }] }, { keys: [{ ...jwk, alg: "HS256" }] }]) await assert.rejects(verifyGitHubCIJWT(jwt(), trust, claims.aud, now, fetcher(data)));
  await assert.rejects(verifyGitHubCIJWT(jwt(), trust, claims.aud, now, fetcher({}, 302)), /CI_IDENTITY_UNAVAILABLE/);
  await assert.rejects(verifyGitHubCIJWT(jwt(), trust, claims.aud, now, fetcher({ keys: [jwk], fill: "x".repeat(65_536) })), /CI_IDENTITY_UNAVAILABLE/);
});
test("owner CI bindings require immutable workflow SHA and branch-scoped trust", () => {
  const input = { expectedVersion: 0, enabled: true, repositoryId: trust.repositoryId, repositoryOwnerId: trust.repositoryOwnerId, ref: trust.ref, jobWorkflowRef: trust.jobWorkflowRef, jobWorkflowSha: trust.jobWorkflowSha };
  assert.deepEqual(parseCIBindingUpdate(input), input);
  for (const override of [{ jobWorkflowRef: "example/flora/.github/workflows/ota.yml@main" }, { jobWorkflowSha: "c".repeat(40) }, { ref: "refs/tags/v1" }, { ref: "refs/heads/../main" }, { repositoryId: 123 }, { token: "forbidden" }]) assert.throws(() => parseCIBindingUpdate({ ...input, ...override }));
});
