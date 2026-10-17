import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openDatabase, migrate, createSqliteDogfoodStore } from "@app-ops/db";
import { createDogfoodService, createBlockedProvider, startDashboard } from "@app-ops/dashboard";
import { createGitHubResolver } from "@app-ops/dogfood";
import { githubOTAFixture } from "../../../tests/github-ota-fixtures.ts";

test("two GitHub repositories detect Expo and RN, publish isolated OTA history and deliver every emitted asset URL", async () => {
  const db = openDatabase(":memory:"); migrate(db);
  let origin = "";
  const appIds = new Map<string, string>();
  const fixture = githubOTAFixture(() => origin, appIds);
  const service = await createDogfoodService(createSqliteDogfoodStore(db), [createBlockedProvider()], Date.now, { github: createGitHubResolver({ credentials: fixture.credentials, fetch: fixture.fetch }), publicOrigin: () => origin });
  const server = await startDashboard({ service }); origin = server.origin;
  try {
    const enrolled = await fetch(origin + "/api/session", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ bootstrap: new URL(server.bootstrapUrl).hash.slice(1) }) });
    const headers = { Cookie: enrolled.headers.get("set-cookie")!.split(";")[0]!, Origin: origin, "X-Flora-CSRF": (await enrolled.json()).csrfToken, "Content-Type": "application/json" };
    const post = (path: string, body: unknown) => fetch(origin + path, { method: "POST", headers, body: JSON.stringify(body) });
    const states: { appId: string; detectionId: string; sha: string; launchId: string; imageId: string; deploymentId: string }[] = [];
    for (const [index, repository] of ["expo-one", "rn-two"].entries()) {
      const registered = await post("/api/apps", { name: repository, repositoryId: "synthetic/" + repository, rootDirectory: "." }); assert.equal(registered.status, 201);
      const appId = (await registered.json()).id; appIds.set(repository, appId);
      const connected = await post(`/api/apps/${appId}/github`, { expectedVersion: 0, installationId: 42, owner: "synthetic", repository, ref: "main" });
      assert.equal(connected.status, 201); const detected = (await connected.json()).detections[0];
      assert.equal(detected.framework, index === 0 ? "expo" : "react-native"); assert.equal(detected.updatesEnabled, true);
      const upload = async (key: string, contentType: string, extension: string, bytes: Uint8Array) => {
        const params = new URLSearchParams({ key, contentType, fileExtension: extension });
        const result = await fetch(origin + `/api/apps/${appId}/ota/assets?${params}`, { method: "POST", headers: { ...headers, "Content-Type": "application/octet-stream" }, body: new Uint8Array(bytes).buffer });
        assert.equal(result.status, 201); return result.json();
      };
      const launch = await upload("launch", "application/javascript", ".js", Buffer.from(`globalThis.floraSyntheticApp=${index};`));
      const image = await upload("image_key", "image/png", ".png", new Uint8Array([137, 80, 78, 71, index]));
      assert.equal((await fetch(origin + `/updates/${appId}/assets/${launch.digest}`)).status, 404, "staged assets stay private");
      const publish = { requestKey: "release_same", detectionId: detected.id, commitSha: detected.commitSha, channel: "preview", runtimeVersion: "runtime-1", platform: "android", launchAssetId: launch.id, assetIds: [image.id] };
      const published = await post(`/api/apps/${appId}/ota/deployments`, publish); assert.equal(published.status, 201);
      const deployment = await published.json();
      const repeated = await post(`/api/apps/${appId}/ota/deployments`, publish); assert.equal(repeated.status, 201); assert.equal((await repeated.json()).id, deployment.id);
      states.push({ appId, detectionId: detected.id, sha: detected.commitSha, launchId: launch.id, imageId: image.id, deploymentId: deployment.id });
    }
    for (const [index, state] of states.entries()) {
      const response = await fetch(origin + `/api/apps/${state.appId}/operations`, { headers: { Cookie: headers.Cookie } }); assert.equal(response.status, 200);
      const operations = await response.json(); assert.equal(operations.deployments.length, 1); assert.equal(operations.deployments[0].id, state.deploymentId);
      assert.equal(operations.connection.repository, index === 0 ? "expo-one" : "rn-two");
      const publicHeaders = { "expo-platform": "android", "expo-runtime-version": "runtime-1", "expo-protocol-version": "1", Accept: "application/expo+json" };
      const update = await fetch(origin + `/updates/${state.appId}?channel=preview`, { headers: publicHeaders }); assert.equal(update.status, 200);
      const manifest = await update.json(); assert.equal(manifest.id, state.deploymentId); assert.equal(manifest.extra.flora.appId, state.appId); assert.equal(manifest.extra.flora.platform, "android");
      for (const asset of [manifest.launchAsset, ...manifest.assets]) {
        const downloaded = await fetch(asset.url); assert.equal(downloaded.status, 200, asset.url);
        assert.match(downloaded.headers.get("cache-control")!, /immutable/);
        const hash = createHash("sha256").update(Buffer.from(await downloaded.arrayBuffer())).digest("base64url"); assert.equal(hash, asset.hash);
      }
      assert.equal((await fetch(origin + `/updates/${state.appId}?channel=preview`, { headers: { ...publicHeaders, "expo-runtime-version": "other-runtime" } })).status, 204);
      const other = states[1 - index]!;
      const cross = await post(`/api/apps/${state.appId}/ota/deployments`, { requestKey: "cross_release", detectionId: state.detectionId, commitSha: state.sha, channel: "preview", runtimeVersion: "runtime-1", platform: "android", launchAssetId: other.launchId, assetIds: [] }); assert.equal(cross.status, 404);
      assert.equal((await fetch(origin + `/updates/${state.appId}/assets/${other.launchId}`)).status, 404);
    }
    assert.ok(fixture.requests() >= 10);
  } finally { await server.close(); await service.close(); db.close(); }
});

test("service closure drains an in-flight GitHub operation and rejects new management work", async () => {
  const db = openDatabase(":memory:"); migrate(db);
  const store = createSqliteDogfoodStore(db);
  const app = await store.applications!.registerApplication({ name: "Lifecycle", repositoryId: "lifecycle", rootDirectory: "." }, Date.now());
  let release!: () => void, enter!: () => void;
  const started = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const service = await createDogfoodService(store, [], Date.now, { github: { detect: async () => {
    enter(); await gate;
    return { commitSha: "a".repeat(40), framework: "react-native", expoVersion: null, reactNativeVersion: "0.86.3", configSource: "none", runtimeVersion: null, platforms: [], updatesEnabled: false, updatesUrl: null, reasons: ["EXPO_CONFIG_MISSING"] };
  } } });
  const connecting = service.operations!.connect(app.id, { expectedVersion: 0, installationId: 42, owner: "synthetic", repository: "example", ref: "main" });
  await started;
  let finished = false;
  const closing = service.close().then(() => { finished = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(finished, false);
    await assert.rejects(service.operations!.getState(app.id), /INVALID_TRANSITION/);
    release(); await connecting; await closing;
    assert.equal((await store.operations!.listGitHubDetections(app.id)).length, 1);
  } finally { release(); await connecting; await closing; db.close(); }
});
