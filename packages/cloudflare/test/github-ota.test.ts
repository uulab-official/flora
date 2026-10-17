import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createTestRuntime } from "./runtime.ts";
import { githubOTAFixture } from "../../../tests/github-ota-fixtures.ts";

test("actual Worker Auth DO and D1 isolate two GitHub apps and native OTA distribution", async t => {
  const origin = "https://flora.example.test", now = 1_800_000_000_000;
  const appIds = new Map<string, string>();
  const github = githubOTAFixture(() => origin, appIds);
  const token = randomBytes(32), password = randomBytes(24).toString("base64url"), email = "owner@example.test";
  const runtime = await createTestRuntime({ entrypoint: new URL("./fixtures/hosted-entry.ts", import.meta.url), durableObjects: { FLORA_AUTH: "HostedFixtureAuth" }, outboundService: github.respond, bindings: {
    FLORA_ORIGIN: origin, FLORA_OWNER_ID: "synthetic-owner", FLORA_OWNER_EMAIL: email, FLORA_DB_IDENTITY: "synthetic-db",
    FLORA_GITHUB_APP_ID: github.credentials.appId, FLORA_GITHUB_PRIVATE_KEY: github.credentials.privateKey,
    FLORA_SETUP: { digest: createHash("sha256").update(token).digest("hex"), issuedAt: now, expiresAt: now + 600000, generation: 1, purpose: "enroll" },
  } });
  t.after(() => runtime.dispose());
  const files = ["0001_private_imports.sql", "0002_multi_app.sql", "0003_github_ota.sql", "0004_automation.sql", "0010_manual_ota_rollback.sql"];
  const sql = (await Promise.all(files.map(name => readFile(new URL("../migrations/" + name, import.meta.url), "utf8")))).join("\n");
  await runtime.d1.exec(sql.replace(/^--.*$/gm, "").split(/;\s*(?=CREATE|INSERT|DROP|PRAGMA|$)/).filter(s => s.trim()).map(s => s.replace(/\s*\n\s*/g, " ").trim() + ";").join("\n"));
  await runtime.d1.prepare("INSERT INTO flora_deployment(singleton,owner_id,origin,db_identity) VALUES(1,?,?,?)").bind("synthetic-owner", origin, "synthetic-db").run();
  const enrollment = await runtime.fetch(origin + "/api/auth/enroll", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ email, password, confirmation: password, token: token.toString("base64url") }) });
  assert.equal(enrollment.status, 200);
  const headers = { Cookie: enrollment.headers.getSetCookie().map(value => value.split(";")[0]).join("; "), Origin: origin, "X-Flora-CSRF": (await enrollment.json() as { csrfToken: string }).csrfToken, "Content-Type": "application/json" };
  const post = (path: string, data: unknown) => runtime.fetch(origin + path, { method: "POST", headers, body: JSON.stringify(data) });
  const values: { appId: string; detection: { id: string; commitSha: string }; launch: { id: string; digest: string }; deploymentId: string }[] = [];
  for (const [index, repository] of ["expo-one", "rn-two"].entries()) {
    const created = await post("/api/apps", { name: repository, repositoryId: "synthetic/" + repository, rootDirectory: "." }); assert.equal(created.status, 201);
    const appId = (await created.json() as { id: string }).id; appIds.set(repository, appId);
    const connected = await post(`/api/apps/${appId}/github`, { expectedVersion: 0, installationId: 42, owner: "synthetic", repository, ref: "main" }); assert.equal(connected.status, 201, `safe result=${await connected.clone().text()}; synthetic request count=${github.requests()}`);
    const operations = await connected.json() as { detections: { id: string; commitSha: string; framework: string; updatesEnabled: boolean }[] };
    const detection = operations.detections[0]!; assert.equal(detection.framework, index === 0 ? "expo" : "react-native"); assert.equal(detection.updatesEnabled, true);
    const uploaded = await runtime.fetch(origin + `/api/apps/${appId}/ota/assets?key=launch&contentType=application%2Fjavascript&fileExtension=.js`, { method: "POST", headers: { ...headers, "Content-Type": "application/octet-stream" }, body: new TextEncoder().encode(`globalThis.floraSyntheticApp=${index};`) });
    assert.equal(uploaded.status, 201); const launch = await uploaded.json() as { id: string; digest: string };
    assert.equal((await runtime.fetch(origin + `/updates/${appId}/assets/${launch.digest}`)).status, 404);
    const input = { requestKey: "release_same", detectionId: detection.id, commitSha: detection.commitSha, channel: "preview", runtimeVersion: "runtime-1", platform: "android", launchAssetId: launch.id, assetIds: [] };
    const published = await post(`/api/apps/${appId}/ota/deployments`, input); assert.equal(published.status, 201);
    const deploymentId = (await published.json() as { id: string }).id;
    const retry = await post(`/api/apps/${appId}/ota/deployments`, input); assert.equal(retry.status, 201); assert.equal((await retry.json() as { id: string }).id, deploymentId);
    values.push({ appId, detection, launch, deploymentId });
  }
  for (const [index, value] of values.entries()) {
    const state = await runtime.fetch(origin + `/api/apps/${value.appId}/operations`, { headers }); assert.equal(state.status, 200);
    const body = await state.json() as { deployments: { id: string }[] }; assert.deepEqual(body.deployments.map(row => row.id), [value.deploymentId]);
    const updateHeaders = { "expo-platform": "android", "expo-runtime-version": "runtime-1", "expo-protocol-version": "1", Accept: "multipart/mixed,application/expo+json;q=0.9" };
    const multipart = await runtime.fetch(origin + `/updates/${value.appId}?channel=preview`, { headers: updateHeaders }); assert.equal(multipart.status, 200); assert.match(multipart.headers.get("content-type")!, /multipart\/mixed/); await multipart.text();
    const response = await runtime.fetch(origin + `/updates/${value.appId}?channel=preview`, { headers: { ...updateHeaders, Accept: "application/expo+json" } }); assert.equal(response.status, 200);
    const manifest = await response.json() as { id: string; launchAsset: { url: string; hash: string } }; assert.equal(manifest.id, value.deploymentId);
    const asset = await runtime.fetch(manifest.launchAsset.url); assert.equal(asset.status, 200); assert.match(asset.headers.get("cache-control")!, /immutable/);
    assert.equal(createHash("sha256").update(Buffer.from(await asset.arrayBuffer())).digest("base64url"), manifest.launchAsset.hash);
    assert.equal((await runtime.fetch(origin + `/updates/${value.appId}?channel=preview`, { headers: { ...updateHeaders, "expo-runtime-version": "wrong" } })).status, 204);
    const other = values[1 - index]!;
    const cross = await post(`/api/apps/${value.appId}/ota/deployments`, { requestKey: "cross_release", detectionId: value.detection.id, commitSha: value.detection.commitSha, channel: "preview", runtimeVersion: "runtime-1", platform: "android", launchAssetId: other.launch.id, assetIds: [] }); assert.equal(cross.status, 404);
    assert.equal((await runtime.fetch(origin + `/updates/${value.appId}/assets/${other.launch.digest}`)).status, 404);
  }
  // Exercise the real owner route, CSRF guard and immutable D1 rollback batch.
  const originalRows = (await runtime.d1.prepare("SELECT * FROM ota_deployments ORDER BY app_id,id").all()).results;
  const assetRows = (await runtime.d1.prepare("SELECT * FROM ota_assets ORDER BY app_id,hash").all()).results;
  for (const [index, value] of values.entries()) {
    const input = { requestKey: "candidate", detectionId: value.detection.id, commitSha: value.detection.commitSha, channel: "preview", runtimeVersion: "runtime-1", platform: "android", launchAssetId: value.launch.id, assetIds: [] };
    const candidateResponse = await post(`/api/apps/${value.appId}/ota/deployments`, input);
    assert.equal(candidateResponse.status, 201); const candidate = await candidateResponse.json() as { id: string };
    const rollbackPath = `/api/apps/${value.appId}/ota/rollbacks`;
    const rollbackInput = { requestKey: "manual-rollback", fromDeploymentId: candidate.id, targetDeploymentId: value.deploymentId, reason: "Restore verified artifact" };
    const unauthenticated = await runtime.fetch(origin + rollbackPath, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(rollbackInput) });
    assert.equal(unauthenticated.status, 401);
    const noCsrf = await runtime.fetch(origin + rollbackPath, { method: "POST", headers: { ...headers, "X-Flora-CSRF": "" }, body: JSON.stringify(rollbackInput) });
    assert.equal(noCsrf.status, 403);
    const foreign = await post(rollbackPath, { ...rollbackInput, targetDeploymentId: values[1-index]!.deploymentId });
    assert.equal(foreign.status, 404);
    const restoredResponse = await post(rollbackPath, rollbackInput); assert.equal(restoredResponse.status, 201, await restoredResponse.clone().text());
    const restored = await restoredResponse.json() as { id: string; rollback: { targetDeploymentId: string } };
    assert.notEqual(restored.id, value.deploymentId); assert.notEqual(restored.id, candidate.id);
    assert.equal(restored.rollback.targetDeploymentId, value.deploymentId);
    const retried = await post(rollbackPath, rollbackInput); assert.equal(retried.status, 201); assert.deepEqual(await retried.json(), restored);
    assert.equal((await post(rollbackPath, { ...rollbackInput, reason: "different" })).status, 409);
    assert.equal((await post(rollbackPath, { ...rollbackInput, requestKey: "stale" })).status, 409);
    const manifestResponse = await runtime.fetch(origin + `/updates/${value.appId}?channel=preview`, { headers: { "expo-platform": "android", "expo-runtime-version": "runtime-1" } });
    assert.equal(manifestResponse.status, 200);
    const manifest = await manifestResponse.json() as { id: string; launchAsset: { hash: string } };
    assert.equal(manifest.id, restored.id);
    const current = await runtime.d1.prepare("SELECT data FROM ota_deployments WHERE app_id=? AND id=?").bind(value.appId, restored.id).first<{ data: string }>();
    assert.deepEqual(JSON.parse(current!.data), restored);
  }
  for (const original of originalRows) assert.deepEqual(await runtime.d1.prepare("SELECT * FROM ota_deployments WHERE app_id=? AND id=?").bind(original.app_id, original.id).first(), original);
  assert.deepEqual((await runtime.d1.prepare("SELECT * FROM ota_assets ORDER BY app_id,hash").all()).results, assetRows);
  const unauthed = await runtime.fetch(origin + `/api/apps/${values[0]!.appId}/operations`); assert.equal(unauthed.status, 401);
  const noCSRF = await runtime.fetch(origin + `/api/apps/${values[0]!.appId}/github/sync`, { method: "POST", headers: { ...headers, "X-Flora-CSRF": "" }, body: "{}" }); assert.equal(noCSRF.status, 403);
  assert.ok(github.requests() >= 10);
});
