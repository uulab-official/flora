import test from "node:test";
import assert from "node:assert/strict";
import { parseGitHubConnectionUpdate, parseOTAAssetUpload, parseOTAPublishInput, parseOTARollbackInput, createOperationsService, createRSAManifestSigner } from "@app-ops/dogfood";
import type { OperationsContext, GitHubConnection, GitHubDetection, OTAAsset, OTADeployment } from "@app-ops/dogfood";
import { DomainError } from "@app-ops/core";
import { canonicalJson } from "@app-ops/config";
import { generateKeyPairSync, verify } from "node:crypto";

test("operations inputs reject credential material and unsafe source/asset fields", () => {
  assert.deepEqual(parseGitHubConnectionUpdate({ expectedVersion: 0, installationId: 12, owner: "uulab-official", repository: "sample", ref: "main" }), { expectedVersion: 0, installationId: 12, owner: "uulab-official", repository: "sample", ref: "main" });
  assert.throws(() => parseGitHubConnectionUpdate({ expectedVersion: 0, installationId: 12, owner: "a", repository: "b", ref: "main", token: "secret" }));
  assert.throws(() => parseGitHubConnectionUpdate({ expectedVersion: 0, installationId: 12, owner: "../a", repository: "b", ref: "main" }));
  assert.deepEqual(parseOTAAssetUpload({ key: "export_key", contentType: "application/javascript", fileExtension: ".js" }), { key: "export_key", contentType: "application/javascript", fileExtension: ".js" });
  assert.throws(() => parseOTAAssetUpload({ key: "../x", contentType: "text/html", fileExtension: ".html" }));
  const publish = { requestKey: "request_001", detectionId: "github_001", commitSha: "a".repeat(40), channel: "preview", runtimeVersion: "1.0", platform: "ios", launchAssetId: "asset_" + "a".repeat(64), assetIds: [] };
  assert.deepEqual(parseOTAPublishInput(publish), publish);
  assert.throws(() => parseOTAPublishInput({ ...publish, assetIds: [publish.launchAssetId] }));
  assert.throws(() => parseOTAPublishInput({ ...publish, platform: "web" }));
});

function memory() {
  let connection: GitHubConnection | null = null;
  const detections: GitHubDetection[] = [], assets = new Map<string, { asset: OTAAsset; bytes: Uint8Array }>(), deployments: OTADeployment[] = [];
  const ctx: OperationsContext = {
    applications: { async getApplication(appId) { return appId === "app_test" ? { id: appId, name: "Test", repositoryId: "opaque", rootDirectory: ".", createdAt: 1, settings: { version: 0, values: {}, updatedAt: 1 } } : null; }, async listApplications() { return []; }, async registerApplication() { throw new Error("unused"); }, async getApplicationForSnapshot() { return null; }, async updateApplicationSettings() { throw new Error("unused"); } },
    operations: {
      async getGitHubConnection() { return connection; }, async saveGitHubConnection(appId, input, now) { if ((connection?.version ?? 0) !== input.expectedVersion) throw new DomainError("CONFIG_CONFLICT"); connection = { appId, version: input.expectedVersion + 1, installationId: input.installationId, owner: input.owner, repository: input.repository, ref: input.ref, connectedAt: now }; return connection; },
      async saveGitHubDetection(value) { detections.unshift(value); return value; }, async listGitHubDetections() { return detections; }, async getGitHubDetection(appId, detectionId) { return detections.find(value => value.appId === appId && value.id === detectionId) ?? null; },
      async saveOTAAsset(asset, bytes) { const old = assets.get(asset.id); if (old) return old.asset; assets.set(asset.id, { asset, bytes: bytes.slice() }); return asset; }, async listOTAAssets() { return [...assets.values()].map(value => value.asset); }, async getOTAAsset(appId, assetId) { const value = assets.get(assetId); return value?.asset.appId === appId ? value : null; }, async getPublishedOTAAsset(appId, assetId) { return deployments.some(value => value.appId === appId && (value.launchAssetId === assetId || value.assetIds.includes(assetId))) ? assets.get(assetId)! : null; },
      async saveOTADeployment(value) { const old = deployments.find(item => item.appId === value.appId && item.requestKey === value.requestKey); if (old) { const identity = (item: OTADeployment) => { const { id, createdAt, ...content } = item; return canonicalJson(content); }; if (identity(old) !== identity(value)) throw new DomainError("IDEMPOTENCY_CONFLICT"); return old; } deployments.unshift(value); return value; }, async listOTADeployments() { return deployments; }, async getOTADeploymentForRequest(appId, requestKey) { return deployments.find(value => value.appId === appId && value.requestKey === requestKey) ?? null; }, async getLatestOTADeployment(appId, selection) { return deployments.find(value => value.appId === appId && value.channel === selection.channel && value.runtimeVersion === selection.runtimeVersion && value.platform === selection.platform) ?? null; },
      async getOTADeployment(appId, deploymentId) { return deployments.find(value => value.appId === appId && value.id === deploymentId) ?? null; },
      async saveOTARollback(value) { const current = deployments.find(item => item.appId === value.appId && item.channel === value.channel && item.platform === value.platform && item.runtimeVersion === value.runtimeVersion); if (current?.id !== value.rollback!.fromDeploymentId) throw new DomainError("CONFIG_CONFLICT"); deployments.unshift(value); return value; },
    },
  };
  return { ctx, deployments };
}
test("rollback input is bounded and cannot include credentials, platform overrides or self targets", () => {
  const input = { requestKey: "rollback_request", fromDeploymentId: "11111111-1111-4111-8111-111111111111", targetDeploymentId: "22222222-2222-4222-8222-222222222222", reason: "  Restore stable version  " };
  assert.deepEqual(parseOTARollbackInput(input), { ...input, reason: "Restore stable version" });
  for (const invalid of [{ ...input, reason: " " }, { ...input, reason: "x".repeat(501) }, { ...input, reason: "unsafe\nreason" }, { ...input, token: "secret" }, { ...input, platform: "android" }, { ...input, targetDeploymentId: input.fromDeploymentId }]) assert.throws(() => parseOTARollbackInput(invalid));
});

test("rollback reasons reject bidirectional controls that cannot be displayed safely in deployment details", () => {
  const input = { requestKey: "rollback_bidi", fromDeploymentId: "11111111-1111-4111-8111-111111111111", targetDeploymentId: "22222222-2222-4222-8222-222222222222", reason: "Restore stable version" };
  for (const control of ["\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069"]) {
    assert.throws(() => parseOTARollbackInput({ ...input, reason: "Restore" + control + "stable" }), { code: "INVALID_INPUT" });
  }
});

test("operator rollback creates a newer publication of the prior artifact and uses immutable idempotency", async () => {
  const { ctx, deployments } = memory();
  const old = { id: "11111111-1111-4111-8111-111111111111", appId: "app_test", createdAt: 5, requestKey: "old", detectionId: "detect_old", commitSha: "a".repeat(40), channel: "preview", runtimeVersion: "native-1", platform: "ios" as const, launchAssetId: "asset_" + "a".repeat(64), assetIds: [], launchAsset: {} as OTAAsset, assets: [] };
  const current = { ...old, id: "22222222-2222-4222-8222-222222222222", requestKey: "current", createdAt: 10 };
  deployments.push(current, old);
  const detection = { updatesUrl: "https://updates.example.test/updates/app_test" } as GitHubDetection;
  ctx.operations.getGitHubDetection = async () => detection;
  ctx.operations.getGitHubConnection = async () => { assert.fail("rollback must not require the old GitHub connection"); };
  const service = createOperationsService(ctx, undefined, () => 8, { publicOrigin: "https://updates.example.test" });
  const input = { requestKey: "restore", fromDeploymentId: current.id, targetDeploymentId: old.id, reason: "Restore stable version" };
  const restored = await service.rollback("app_test", input);
  assert.equal(restored.createdAt, 11); assert.equal(restored.launchAssetId, old.launchAssetId);
  assert.notEqual(restored.id, old.id); assert.equal(restored.rollback!.requestedAt, 8);
  assert.deepEqual(await service.rollback("app_test", input), restored);
  await assert.rejects(service.rollback("app_test", { ...input, reason: "Changed" }), { code: "IDEMPOTENCY_CONFLICT" });
  await assert.rejects(service.rollback("app_test", { ...input, requestKey: "new_request" }), { code: "CONFIG_CONFLICT" });
  await assert.rejects(service.publish("app_test", { requestKey: restored.requestKey, detectionId: restored.detectionId, commitSha: restored.commitSha, channel: restored.channel, runtimeVersion: restored.runtimeVersion, platform: restored.platform, launchAssetId: restored.launchAssetId, assetIds: restored.assetIds }), { code: "IDEMPOTENCY_CONFLICT" });
  assert.equal(deployments.length, 3);
});
test("publication uses uploaded assets, verified SHA/capability and immutable app-scoped idempotency", async () => {
  const { ctx, deployments } = memory();
  const service = createOperationsService(ctx, { async detect() { return { commitSha: "a".repeat(40), framework: "expo", expoVersion: "56", reactNativeVersion: "0.85", configSource: "app.json", runtimeVersion: "native-1", platforms: ["ios"], updatesEnabled: true, updatesUrl: "https://updates.example.test/updates/app_test", reasons: [] }; } }, () => 1_800_000_000_000, { publicOrigin: "https://updates.example.test" });
  const state = await service.connect("app_test", { expectedVersion: 0, installationId: 12, owner: "owner", repository: "app", ref: "main" });
  const detection = state.detections[0]!;
  const asset = await service.uploadAsset("app_test", { key: "bundle", contentType: "application/javascript", fileExtension: ".js" }, new TextEncoder().encode("launch"));
  assert.equal(await service.getPublishedAsset("app_test", asset.id), null);
  const input = { requestKey: "publish_001", detectionId: detection.id, commitSha: detection.commitSha, channel: "production", runtimeVersion: "native-1", platform: "ios" as const, launchAssetId: asset.id, assetIds: [] };
  const published = await service.publish("app_test", input); assert.match(published.id, /^[a-f0-9]{8}-/);
  assert.deepEqual(await service.publish("app_test", input), published); assert.equal(deployments.length, 1);
  assert.deepEqual((await service.getPublishedAsset("app_test", asset.id))!.bytes, new TextEncoder().encode("launch"));
  await assert.rejects(service.publish("app_test", { ...input, commitSha: "b".repeat(40) }));
  await assert.rejects(service.publish("app_missing", input));
  await assert.rejects(service.publish("app_test", { ...input, requestKey: "publish_002", platform: "android" }));
  const response = await service.getUpdate("app_test", { channel: "production", runtimeVersion: "native-1", platform: "ios" }, "https://updates.example.test");
  assert.equal(response.status, 200); const manifest = await response.json() as { id: string; launchAsset: { url: string; key: string; hash: string } };
  assert.equal(manifest.id, published.id); assert.equal(manifest.launchAsset.key, "bundle"); assert.equal(manifest.launchAsset.hash, asset.hash);
  assert.equal(manifest.launchAsset.url, "https://updates.example.test/updates/app_test/assets/" + asset.digest);
});
test("unconfigured Github fails explicitly without persisting credentials or fabricated detection", async () => {
  const { ctx } = memory(); const service = createOperationsService(ctx, undefined, () => 1);
  await assert.rejects(service.connect("app_test", { expectedVersion: 0, installationId: 12, owner: "owner", repository: "app", ref: "main" }), { code: "PROVIDER_UNCONFIGURED" });
  assert.deepEqual((await service.getState("app_test")).detections, []);
});
test("failed initial GitHub source validation leaves the app disconnected", async () => {
  const { ctx } = memory();
  const service = createOperationsService(ctx, { async detect() { throw new DomainError("PROVIDER_UNSUPPORTED"); } }, () => 2);
  const before = await service.getState("app_test");
  await assert.rejects(service.connect("app_test", { expectedVersion: 0, installationId: 12, owner: "owner", repository: "unavailable", ref: "main" }), { code: "PROVIDER_UNSUPPORTED" });
  assert.deepEqual(await service.getState("app_test"), before);
});
test("failed reconnect source validation preserves the existing connection and OTA history", async () => {
  const { ctx } = memory();
  const good = createOperationsService(ctx, { async detect() { return { commitSha: "a".repeat(40), framework: "expo", expoVersion: "56", reactNativeVersion: "0.85", configSource: "app.json", runtimeVersion: "native-1", platforms: ["ios"], updatesEnabled: true, updatesUrl: "https://updates.example.test/updates/app_test", reasons: [] }; } }, () => 2, { publicOrigin: "https://updates.example.test" });
  const state = await good.connect("app_test", { expectedVersion: 0, installationId: 12, owner: "owner", repository: "app", ref: "main" });
  const asset = await good.uploadAsset("app_test", { key: "bundle", contentType: "application/javascript", fileExtension: ".js" }, new TextEncoder().encode("retained"));
  await good.publish("app_test", { requestKey: "publish_retained", detectionId: state.detections[0]!.id, commitSha: "a".repeat(40), channel: "production", runtimeVersion: "native-1", platform: "ios", launchAssetId: asset.id, assetIds: [] });
  const before = structuredClone(await good.getState("app_test")), application = structuredClone(await ctx.applications.getApplication("app_test"));
  const bad = createOperationsService(ctx, { async detect() { throw new DomainError("PROVIDER_UNSUPPORTED"); } }, () => 3);
  await assert.rejects(bad.connect("app_test", { expectedVersion: 1, installationId: 12, owner: "owner", repository: "unavailable", ref: "main" }), { code: "PROVIDER_UNSUPPORTED" });
  assert.deepEqual(await good.getState("app_test"), before);
  assert.deepEqual(await ctx.applications.getApplication("app_test"), application);
  assert.equal(new TextDecoder().decode((await good.getPublishedAsset("app_test", asset.id))!.bytes), "retained");
});
test("malformed source detection is rejected before a candidate connection is stored", async () => {
  const { ctx } = memory();
  const service = createOperationsService(ctx, { async detect() { return { commitSha: "invalid", framework: "unsupported", expoVersion: null, reactNativeVersion: null, configSource: "none", runtimeVersion: null, platforms: [], updatesEnabled: false, updatesUrl: null, reasons: [] }; } }, () => 2);
  await assert.rejects(service.connect("app_test", { expectedVersion: 0, installationId: 12, owner: "owner", repository: "app", ref: "main" }), { code: "INVALID_INPUT" });
  assert.equal((await service.getState("app_test")).connection, null);
});
test("unsupported app detection does not register a GitHub connection", async () => {
  const { ctx } = memory();
  const service = createOperationsService(ctx, { async detect() { return { commitSha: "a".repeat(40), framework: "unsupported", expoVersion: null, reactNativeVersion: null, configSource: "none", runtimeVersion: null, platforms: ["ios", "android"], updatesEnabled: false, updatesUrl: null, reasons: ["NOT_EXPO_OR_REACT_NATIVE"] }; } }, () => 2);
  await assert.rejects(service.connect("app_test", { expectedVersion: 0, installationId: 12, owner: "owner", repository: "web-only", ref: "main" }), { code: "GITHUB_APP_UNSUPPORTED" });
  assert.deepEqual(await service.getState("app_test"), { connection: null, detections: [], assets: [], deployments: [] });
});
test("stale connection input is rejected before any external provider reads", async () => {
  const { ctx } = memory();
  await ctx.operations.saveGitHubConnection("app_test", { expectedVersion: 0, installationId: 12, owner: "owner", repository: "app", ref: "main" }, 1);
  const service = createOperationsService(ctx, { async detect() { assert.fail("Stale input must not access GitHub"); } }, () => 2);
  await assert.rejects(service.connect("app_test", { expectedVersion: 0, installationId: 12, owner: "owner", repository: "old", ref: "main" }), { code: "CONFIG_CONFLICT" });
  assert.equal((await service.getState("app_test")).connection!.version, 1);
});
test("held GitHub source validation cannot replace a newer connection version", async () => {
  const { ctx } = memory(); let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), began = new Promise<void>(resolve => { started = resolve; });
  const service = createOperationsService(ctx, { async detect() { started(); await held; return { commitSha: "a".repeat(40), framework: "expo", expoVersion: "56", reactNativeVersion: "0.85", configSource: "app.json", runtimeVersion: "native-1", platforms: ["ios"], updatesEnabled: true, updatesUrl: "https://updates.example.test/updates/app_test", reasons: [] }; } }, () => 2);
  const pending = service.connect("app_test", { expectedVersion: 0, installationId: 12, owner: "owner", repository: "old", ref: "main" }); await began;
  assert.equal(await ctx.operations.getGitHubConnection("app_test"), null, "Provider reads must precede connection persistence");
  const newer = await ctx.operations.saveGitHubConnection("app_test", { expectedVersion: 0, installationId: 12, owner: "owner", repository: "newer", ref: "next" }, 3);
  release(); await assert.rejects(pending, { code: "CONFIG_CONFLICT" });
  assert.deepEqual(await ctx.operations.getGitHubConnection("app_test"), newer);
  assert.deepEqual(await ctx.operations.listGitHubDetections("app_test"), []);
});
async function published(signer?: import("@app-ops/dogfood").ExpoManifestSigner) {
  const { ctx } = memory();
  const service = createOperationsService(ctx, { async detect() { return { commitSha: "a".repeat(40), framework: "expo", expoVersion: "56", reactNativeVersion: "0.85", configSource: "app.json", runtimeVersion: "native-1", platforms: ["ios"], updatesEnabled: true, updatesUrl: "https://updates.example.test/updates/app_test", reasons: [] }; } }, () => 1_800_000_000_000, { publicOrigin: "https://updates.example.test", ...(signer ? { signer } : {}) });
  const state = await service.connect("app_test", { expectedVersion: 0, installationId: 12, owner: "owner", repository: "app", ref: "main" });
  const asset = await service.uploadAsset("app_test", { key: "bundle", contentType: "application/javascript", fileExtension: ".js" }, new TextEncoder().encode("launch"));
  await service.publish("app_test", { requestKey: "publish_001", detectionId: state.detections[0]!.id, commitSha: "a".repeat(40), channel: "production", runtimeVersion: "native-1", platform: "ios", launchAssetId: asset.id, assetIds: [] });
  return service;
}
test("Expo protocol negotiates manifests, excludes q=0 formats and returns empty compatible misses", async () => {
  const service = await published(), selection = { channel: "production", runtimeVersion: "native-1", platform: "ios" as const };
  const no = await service.getUpdate("app_test", { ...selection, runtimeVersion: "other" }, "https://updates.example.test"); assert.equal(no.status, 204); assert.equal(no.headers.get("Content-Type"), null);
  assert.equal(no.headers.get("expo-protocol-version"), "1"); assert.equal(no.headers.get("expo-sfv-version"), "0"); assert.equal(no.headers.get("expo-manifest-filters"), 'channel="production", appid="app_test"');
  assert.equal((await service.getUpdate("app_test", selection, "https://updates.example.test", new Headers({ "expo-protocol-version": "2" }))).status, 406);
  assert.equal((await service.getUpdate("app_test", selection, "https://updates.example.test", new Headers({ Accept: "text/html" }))).status, 406);
  const json = await service.getUpdate("app_test", selection, "https://updates.example.test", new Headers({ Accept: "application/expo+json;q=0, */*;q=1" })); assert.equal(json.headers.get("Content-Type"), "application/json");
  assert.equal(json.headers.get("expo-manifest-filters"), 'channel="production", appid="app_test"');
  assert.deepEqual((await json.json() as { metadata: unknown }).metadata, { channel: "production", appid: "app_test" });
  const multipart = await service.getUpdate("app_test", selection, "https://updates.example.test", new Headers({ Accept: "multipart/mixed" })); assert.match(multipart.headers.get("Content-Type")!, /^multipart\/mixed; boundary=/); assert.match(await multipart.text(), /name="manifest"/);
});
test("signing requests fail closed or receive a verifiable signature for exact manifest bytes", async () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const signer = createRSAManifestSigner({ keyId: "root", privateKey: pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString() });
  const selection = { channel: "production", runtimeVersion: "native-1", platform: "ios" as const }, headers = new Headers({ "expo-expect-signature": 'sig, keyid="root", alg="rsa-v1_5-sha256"' });
  const unsigned = await published(); await assert.rejects(unsigned.getUpdate("app_test", selection, "https://updates.example.test", headers), { code: "PROVIDER_UNCONFIGURED" });
  const signed = await published(signer); const response = await signed.getUpdate("app_test", selection, "https://updates.example.test", headers), body = await response.text();
  const signature = /^sig="([A-Za-z0-9+/=]+)"/.exec(response.headers.get("expo-signature")!)![1]!;
  assert.equal(verify("RSA-SHA256", Buffer.from(body), pair.publicKey, Buffer.from(signature, "base64")), true);
  assert.equal(JSON.parse(body).extra.flora.platform, "ios");
  assert.equal(verify("RSA-SHA256", Buffer.from(body.replace('"platform":"ios"', '"platform":"android"')), pair.publicKey, Buffer.from(signature, "base64")), false, "Native platform is part of the signed compatibility boundary");
  await assert.rejects(signed.getUpdate("app_test", selection, "https://updates.example.test", new Headers({ "expo-expect-signature": 'sig, keyid="different"' })), { code: "PROVIDER_UNSUPPORTED" });
});
test("publication receipt replays after reconnect but changed input never reuses its request key", async () => {
  const service = await published();
  const old = (await service.getState("app_test")).deployments[0]!;
  const input = { requestKey: old.requestKey, detectionId: old.detectionId, commitSha: old.commitSha, channel: old.channel, runtimeVersion: old.runtimeVersion, platform: old.platform, launchAssetId: old.launchAssetId, assetIds: old.assetIds };
  await service.connect("app_test", { expectedVersion: 1, installationId: 12, owner: "owner", repository: "app", ref: "next" });
  assert.deepEqual(await service.publish("app_test", input), old);
  await assert.rejects(service.publish("app_test", { ...input, channel: "preview" }), { code: "IDEMPOTENCY_CONFLICT" });
  await assert.rejects(service.publish("app_test", { ...input, requestKey: "publish_new" }), { code: "CONFIG_CONFLICT" });
});
