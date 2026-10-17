import test from "node:test";
import assert from "node:assert/strict";
import { parseAutomationConfigSnapshot, parseFloraConfig, parseAutomationQueueInput, parseRunnerCredential, parseAutomationLease, createAutomationService, automationDigest, automationArtifactPayload, verifyGitHubWebhook, parseGitHubWebhook, parseAutoPolicyUpdate, parseAutomationClaimScope } from "@app-ops/dogfood";
import type { AutomationContext, AutomationJob, RunnerCredential, GitHubDetection, OTAAsset, OTADeployment, AutomationLease } from "@app-ops/dogfood";
import { canonicalJson } from "@app-ops/config";
import { createHmac } from "node:crypto";
import { DomainError } from "@app-ops/core";

const config = { schemaVersion: 1 as const, bundler: "metro" as const, entryFile: "index.js", toolchain: { nodeVersion: "24.19.0", packageManager: { name: "npm" as const, version: "11.9.0" } }, runtimeVersion: "native-1", platforms: ["android" as const], updatesUrl: "https://updates.example.test/updates/app_test" };
test("automatic policy accepts an exclusive platform list while preserving legacy singleton writes", () => {
  const legacy = { expectedVersion: 1, enabled: true, channel: "preview", platform: "ios" };
  const dual = { expectedVersion: 1, enabled: true, channel: "preview", platforms: ["ios", "android"] };
  assert.deepEqual(parseAutoPolicyUpdate(legacy), legacy);
  assert.deepEqual(parseAutoPolicyUpdate(dual), dual);
  for (const invalid of [[], ["ios", "ios"], ["ios", "web"], ["ios", "android", "ios"], "ios", null]) {
    assert.throws(() => parseAutoPolicyUpdate({ ...dual, platforms: invalid }));
  }
  assert.throws(() => parseAutoPolicyUpdate({ ...dual, platform: "ios" }));
  assert.throws(() => parseAutoPolicyUpdate({ expectedVersion: 1, enabled: true, channel: "preview" }));
});
test("CI claim scope accepts only an optional exact native platform", () => {
  const scope = { appId: "app_test", commitSha: "a".repeat(40) };
  assert.deepEqual(parseAutomationClaimScope(scope), scope);
  assert.deepEqual(parseAutomationClaimScope({ ...scope, platform: "android" }), { ...scope, platform: "android" });
  assert.throws(() => parseAutomationClaimScope({ ...scope, platform: "web" }));
  assert.throws(() => parseAutomationClaimScope({ ...scope, platform: "ios", extra: true }));
});
test("automation accepts only immutable command-free toolchain and native target snapshots", () => {
  assert.deepEqual(parseAutomationConfigSnapshot(config), config);
  assert.deepEqual(parseFloraConfig({ schemaVersion: 1, ota: { runtimeVersion: config.runtimeVersion, platforms: config.platforms, url: config.updatesUrl }, export: { bundler: config.bundler, entryFile: config.entryFile, nodeVersion: config.toolchain.nodeVersion, packageManager: config.toolchain.packageManager } }), config);
  const input = { requestKey: "auto_001", detectionId: "github_001", channel: "preview", runtimeVersion: "native-1", platform: "android", config };
  assert.deepEqual(parseAutomationQueueInput(input), input);
  for (const bad of [{ ...config, command: "curl private" }, { ...config, entryFile: "../private.js" }, { ...config, toolchain: { ...config.toolchain, nodeVersion: "latest" } }, { ...config, toolchain: { ...config.toolchain, packageManager: { name: "npm", version: "^11" } } }]) assert.throws(() => parseAutomationConfigSnapshot(bad));
  assert.throws(() => parseAutomationQueueInput({ ...input, runtimeVersion: "other" }));
});
test("machine enrollment and finalize use hashed scoped authority and one atomic publication port", async () => {
  let runner: RunnerCredential | null = null, job: AutomationJob | null = null, finalized = 0;
  const uploaded = new Map<string, OTAAsset>();
  const connection = { appId: "app_test", version: 1, installationId: 1, owner: "example", repository: "app", ref: "main", connectedAt: 1 };
  const detection: GitHubDetection = { id: "github_001", appId: "app_test", connection, rootDirectory: ".", detectedAt: 1, commitSha: "a".repeat(40), framework: "flora", expoVersion: null, reactNativeVersion: null, configSource: "flora.config.json", runtimeVersion: config.runtimeVersion, platforms: config.platforms, updatesUrl: config.updatesUrl, updatesEnabled: true, reasons: [], automationConfig: config };
  const ctx = {
    applications: { async getApplication(appId: string) { return appId === "app_test" ? { id: appId, rootDirectory: "." } : null; }, async listApplications() { return [{ id: "app_test", name: "Test", createdAt: 1 }]; } },
    operations: { async getGitHubDetection() { return detection; }, async getGitHubConnection() { return connection; }, async listOTAAssets() { return [...uploaded.values()]; }, async saveOTADeployment() { throw new Error("Split publication is forbidden"); } },
    automation: {
      async registerRunner(value: RunnerCredential) { runner = value; const { tokenHash, ...summary } = value; return summary; }, async getRunnerCredential() { return runner; }, async getAutomationJobForRequest() { return null; }, async getAutomationJob() { return job; }, async enqueueAutomationJob(value: AutomationJob) { job = value; return value; }, async requireAutomationLease() { return job; },
      async claimAutomationJob(authority: { runnerId: string; credentialEpoch: number }, now: number, leaseMs: number) { const lease = { appId: "app_test", jobId: job!.id, attemptId: "attempt_001", runnerId: authority.runnerId, credentialEpoch: authority.credentialEpoch, fence: 1, expiresAt: now + leaseMs }; job = { ...job!, state: "leased", lease, attemptCount: 1 }; return { job, lease }; },
      async saveAutomationAsset(_authority: unknown, _lease: AutomationLease, asset: OTAAsset) { uploaded.set(asset.id, asset); return asset; },
      async finalizeAutomationJob(_authority: unknown, _lease: AutomationLease, publication: { deployment: OTADeployment; receipt: import("@app-ops/dogfood").AutomationExportReceipt }) { finalized++; job = { ...job!, state: "succeeded", lease: null, deploymentId: publication.deployment.id, receipt: publication.receipt }; return { job, deployment: publication.deployment }; },
    },
  } as unknown as AutomationContext;
  const service = createAutomationService(ctx, { now: () => 1000, publicOrigin: "https://updates.example.test" });
  const enrollment = await service.enrollRunner({ name: "Machine", appIds: ["app_test"] });
  assert.ok(enrollment.token.includes(enrollment.runner.id)); assert.doesNotMatch(canonicalJson(enrollment.runner), /tokenHash/); assert.ok(runner!.tokenHash !== enrollment.token);
  const queued = await service.queue("app_test", { requestKey: "queue_001", detectionId: detection.id, channel: "preview", runtimeVersion: config.runtimeVersion, platform: "android", config });
  assert.equal(queued.commitSha, detection.commitSha); assert.equal(queued.configDigest, await automationDigest(config));
  await assert.rejects(service.claim(enrollment.token + "wrong"));
  const claim = (await service.claim(enrollment.token))!;
  const asset = await service.uploadAsset(enrollment.token, claim.lease, { key: "launch", contentType: "application/javascript", fileExtension: ".js" }, new TextEncoder().encode("launch"));
  const receipt = { jobId: queued.id, attemptId: claim.lease.attemptId, commitSha: queued.commitSha, configDigest: queued.configDigest, toolchainDigest: queued.toolchainDigest, sourceArchiveDigest: "b".repeat(64), launchAssetId: asset.id, assetIds: [] };
  const artifactDigest = await automationDigest(automationArtifactPayload(receipt, [asset]));
  await assert.rejects(service.finalize(enrollment.token, claim.lease, { ...receipt, configDigest: "c".repeat(64), artifactDigest }));
  const completed = await service.finalize(enrollment.token, claim.lease, { ...receipt, artifactDigest });
  assert.equal(completed.job.state, "succeeded"); assert.equal(finalized, 1); assert.equal(completed.deployment.requestKey, queued.id);
});
test("runner storage accepts only hashed credentials and bounded distinct app scopes", () => {
  const credential = { id: "runner_001", name: "Local runner", appIds: ["app_test"], createdAt: 1, credentialEpoch: 1, revokedAt: null, tokenHash: "a".repeat(64) };
  assert.deepEqual(parseRunnerCredential(credential), credential);
  assert.throws(() => parseRunnerCredential({ ...credential, token: "raw-private-secret" }));
  assert.throws(() => parseRunnerCredential({ ...credential, appIds: ["app_test", "app_test"] }));
  const lease = { jobId: "automation_001", appId: "app_test", attemptId: "attempt_001", runnerId: "runner_001", credentialEpoch: 1, fence: 1, expiresAt: 60_001 };
  assert.deepEqual(parseAutomationLease(lease), lease);
  assert.throws(() => parseAutomationLease({ ...lease, fence: 0 }));
});
test("GitHub webhook verifies exact bytes and ignores non-push/deleted events", async () => {
  const secret = "synthetic-webhook-secret", body = new TextEncoder().encode(JSON.stringify({ after: "a".repeat(40), ref: "refs/heads/main", deleted: false, installation: { id: 42 }, repository: { name: "app", owner: { login: "example" } } }));
  const signature = "sha256=" + createHmac("sha256", secret).update(body).digest("hex"), headers = new Headers({ "X-GitHub-Event": "push", "X-GitHub-Delivery": "delivery_001" });
  await verifyGitHubWebhook(body, signature, secret);
  assert.deepEqual(parseGitHubWebhook(body, headers), { deliveryId: "delivery_001", installationId: 42, owner: "example", repository: "app", ref: "main", commitSha: "a".repeat(40) });
  await assert.rejects(verifyGitHubWebhook(new Uint8Array([...body, 32]), signature, secret));
  await assert.rejects(verifyGitHubWebhook(body, "sha1=incorrect", secret));
  headers.set("X-GitHub-Event", "ping"); assert.equal(parseGitHubWebhook(body, headers), null);
});
test("automatic queue rejects policy changes and repository reconnects during detection and passes policy CAS", async () => {
  for (const change of ["disabled", "channel", "repository", "none", "cas"] as const) {
    let policy = { appId: "app_test", version: 1, enabled: true, channel: "preview", platform: "android" as const, updatedAt: 1 };
    let connection = { appId: "app_test", version: 1, installationId: 1, owner: "Example", repository: "app", ref: "main", connectedAt: 1 };
    let queued = 0, expectedVersion: number | undefined;
    let release!: () => void, started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), began = new Promise<void>(resolve => { started = resolve; });
    let detection: GitHubDetection;
    const ctx = {
      applications: { async getApplication() { return { id: "app_test", rootDirectory: "." }; } },
      operations: { async getGitHubDetection() { return detection; }, async getGitHubConnection() { return connection; } },
      automation: {
        async findAutomationTargets() { return [{ appId: "app_test", policy: { ...policy } }]; },
        async getAutomationPolicy() { return policy; }, async getAutomationJobForRequest() { return null; },
        async enqueueAutomationJob(value: AutomationJob, version?: number) { expectedVersion = version; if (change === "cas") { assert.equal(version, 1); throw new DomainError("CONFIG_CONFLICT"); } queued++; return value; },
      },
    } as unknown as AutomationContext;
    const service = createAutomationService(ctx, { now: () => 1000, publicOrigin: "https://updates.example.test", async detectPushCommit() {
      started(); await held;
      detection = { id: "github_001", appId: "app_test", connection, rootDirectory: ".", detectedAt: 1, commitSha: "a".repeat(40), framework: "flora", expoVersion: null, reactNativeVersion: null, configSource: "flora.config.json", runtimeVersion: config.runtimeVersion, platforms: config.platforms, updatesUrl: config.updatesUrl, updatesEnabled: true, reasons: [], automationConfig: config };
      return detection;
    } });
    const pending = service.handleGitHubPush({ deliveryId: "delivery_race", installationId: 1, owner: "example", repository: "app", ref: "main", commitSha: "a".repeat(40) });
    await began;
    if (change === "disabled") policy = { ...policy, version: 2, enabled: false };
    if (change === "channel") policy = { ...policy, version: 2, channel: "production" };
    if (change === "repository") connection = { ...connection, version: 2, repository: "fork" };
    release();
    const result = await pending; assert.equal(result.jobs.length, change === "none" ? 1 : 0, change); assert.equal(result.ignored, change === "none" ? 0 : 1, change);
    assert.equal(queued, change === "none" ? 1 : 0, change);
    if (change === "none") assert.equal(expectedVersion, 1);
  }
});
