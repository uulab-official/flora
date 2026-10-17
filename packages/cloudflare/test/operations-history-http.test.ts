import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createTestRuntime } from "./runtime.ts";

test("authenticated operations retains bounded SDK history with one cold lineage read and no repeated backfill", async t => {
  const origin = "https://history.example.test", owner = "owner_history", now = 1_800_000_000_000;
  const token = randomBytes(32), password = randomBytes(24).toString("base64url");
  const runtime = await createTestRuntime({ entrypoint: new URL("./fixtures/operations-history-entry.ts", import.meta.url),
    durableObjects: { FLORA_AUTH: "OperationsHistoryFixture" }, bindings: { FLORA_ORIGIN: origin, FLORA_OWNER_ID: owner,
      FLORA_OWNER_EMAIL: "owner@example.test", FLORA_DB_IDENTITY: "db_history", FLORA_SETUP: {
        digest: createHash("sha256").update(token).digest("hex"), issuedAt: now, expiresAt: now + 600000, generation: 1, purpose: "enroll" } } });
  t.after(() => runtime.dispose());
  await runtime.d1.exec(`CREATE TABLE flora_deployment(singleton INTEGER,owner_id TEXT,origin TEXT,db_identity TEXT);
CREATE TABLE applications(owner_id TEXT,id TEXT,name TEXT,repository_id TEXT,root_directory TEXT,created_at INTEGER,PRIMARY KEY(owner_id,id));
CREATE TABLE application_settings(owner_id TEXT,app_id TEXT,version INTEGER,values_json TEXT,updated_at INTEGER);
CREATE TABLE ota_deployments(owner_id TEXT,app_id TEXT,id TEXT,platform TEXT,channel TEXT,runtime_version TEXT,created_at INTEGER,data TEXT,PRIMARY KEY(owner_id,app_id,id));
CREATE TABLE github_connections(owner_id TEXT,app_id TEXT,version INTEGER,data TEXT);
CREATE TABLE github_detections(owner_id TEXT,app_id TEXT,created_at INTEGER,data TEXT);
CREATE TABLE ota_assets(owner_id TEXT,app_id TEXT,hash TEXT,data TEXT);`);
  await runtime.d1.prepare("INSERT INTO flora_deployment VALUES(1,?,?,?)").bind(owner, origin, "db_history").run();
  const enrollment = await runtime.fetch(origin + "/api/auth/enroll", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@example.test", password, confirmation: password, token: token.toString("base64url") }) });
  assert.equal(enrollment.status, 200);
  const cookie = enrollment.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
  const get = (path: string, auth = true) => runtime.fetch(origin + path, { headers: auth ? { Cookie: cookie } : {} });
  const control = async (sql: string) => { const response = await runtime.fetch(origin + "/__test/control", { method: "POST", body: JSON.stringify({ sql }) }); assert.equal(response.status, 200); return response.json(); };
  const stats = async () => await (await get("/__test/history-stats")).json() as any;
  const appId = "application_first", foreignApp = "application_second", older = randomUUID(), latest = randomUUID();
  for (const app of [appId, foreignApp]) await runtime.d1.prepare("INSERT INTO applications VALUES(?,?,?,?,?,?)").bind(owner, app, app, "synthetic/" + app, ".", now - 100).run();
  for (const app of [appId, foreignApp]) await runtime.d1.prepare("INSERT INTO application_settings VALUES(?,?,1,'{}',?)").bind(owner, app, now - 100).run();
  const records = Array.from({ length: 22 }, (_, index) => ({ id: index === 0 ? latest : index === 1 ? older : randomUUID(), appId,
    platform: index % 2 ? "ios" : "android", channel: "verification", runtimeVersion: "native-v1", createdAt: now - index - 1, commitSha: "a".repeat(40), preserved: "original-history-" + index }));
  for (const record of records) await runtime.d1.prepare("INSERT INTO ota_deployments VALUES(?,?,?,?,?,?,?,?)").bind(owner, appId, record.id, record.platform, record.channel, record.runtimeVersion, record.createdAt, JSON.stringify(record)).run();
  const before = (await runtime.d1.prepare("SELECT * FROM ota_deployments ORDER BY created_at DESC").all()).results;
  const counters = { observedInstallations: 1, downloadedInstallations: 1, appliedInstallations: 1, restartedInstallations: 1, failedInstallations: 1, rolledBackInstallations: 0, recoveredInstallations: 1,
    lastReportedAt: now, environments: { physicalDevice: 0, androidEmulator: 0, iosSimulator: 1, unknown: 0 } };
  // Synthetic DO fixture only: production SDK identity/ticket paths have separate integration coverage.
  for (const [scopeOwner, scopeApp, count] of [[owner, appId, 1], [owner, foreignApp, 99], ["other_owner", appId, 77]] as const) {
    await control(`INSERT INTO flora_sdk_telemetry_aggregates VALUES('${scopeOwner}','${scopeApp}','${older}','${JSON.stringify({ ...counters, observedInstallations: count })}')`);
    await control(`INSERT INTO flora_sdk_telemetry_failures VALUES('${scopeOwner}','${scopeApp}','${older}','download','NETWORK_UNAVAILABLE',${count},${now})`);
  }
  const proof = { deploymentId: older, platform: "ios", channel: "verification", runtimeVersion: "native-v1", commitSha: "a".repeat(40), environment: "ios-simulator", observedAt: now,
    applied: true, restarted: true, signatureVerified: true, assetsVerified: true, receiptDigest: "b".repeat(64) };
  await control(`INSERT INTO flora_ota_verifications(owner_id,app_id,deployment_id,receipt_digest,observed_at,recorded_at,data) VALUES('${owner}','${appId}','${older}','${proof.receiptDigest}',${now},${now},'${JSON.stringify(proof)}')`);
  await stats();
  const unauthenticated = await get(`/api/apps/${appId}/operations`, false); assert.equal(unauthenticated.status, 401);
  assert.equal((await stats()).targets.length, 0);
  const response = await get(`/api/apps/${appId}/operations`); assert.equal(response.status, 200, await response.clone().text());
  const state = await response.json() as any, measured = await stats();
  assert.equal(state.deployments.length, 20);
  for (const [index, record] of records.slice(0, 20).entries()) {
    const { telemetry, verification, ...retained } = state.deployments[index]; assert.deepEqual(retained, record);
    if (record.id === older) {
      assert.equal(telemetry.source, "sdk-self-report"); assert.equal(telemetry.applicationRate, 100);
      assert.equal(telemetry.failedInstallations, 1); assert.equal(telemetry.recoveredInstallations, 1);
      assert.deepEqual(telemetry.failures, [{ stage: "download", code: "NETWORK_UNAVAILABLE", installations: 1, lastReportedAt: now }]);
      assert.equal(verification.source, "operator-verification"); assert.equal(verification.environment, "ios-simulator");
    } else { assert.equal(telemetry, undefined); assert.equal(verification, undefined); }
  }
  assert.equal(measured.targets.length, 3); // One operator query and two telemetry joins.
  for (const targets of measured.targets) assert.deepEqual(targets, records.slice(0, 20).map(record => ({ appId, deploymentId: record.id })));
  const lineageReads = (queries: string[]) => queries.filter(query => query.includes("AS rollback_lineage FROM ota_deployments d") && query.includes("LIMIT 2001"));
  assert.equal(measured.queries.length, 11); // Five fenced reads and one bounded immutable lineage backfill.
  assert.equal(measured.queries.filter((query: string) => /SELECT/.test(query)).length, 11);
  assert.equal(lineageReads(measured.queries).length, 1);
  const warmResponse = await get(`/api/apps/${appId}/operations`);
  assert.equal(warmResponse.status, 200);
  assert.equal((await warmResponse.json() as any).deployments.length, 20);
  const warmMeasured = await stats();
  assert.equal(warmMeasured.queries.length, 10, "unchanged history keeps the existing fenced read budget");
  assert.equal(lineageReads(warmMeasured.queries).length, 0, "unchanged history never repeats lineage backfill");
  assert.equal(warmMeasured.targets.length, 3);
  for (const targets of warmMeasured.targets) assert.deepEqual(targets, records.slice(0, 20).map(record => ({ appId, deploymentId: record.id })));
  const other = await get(`/api/apps/${foreignApp}/operations`); assert.equal(other.status, 200); assert.deepEqual((await other.json() as any).deployments, []);
  assert.equal((await stats()).targets.length, 0);
  assert.deepEqual((await runtime.d1.prepare("SELECT * FROM ota_deployments ORDER BY created_at DESC").all()).results, before);
  // A malformed stored row cannot use an app's authenticated response to query another app's DO state.
  await runtime.d1.prepare("UPDATE ota_deployments SET data=? WHERE id=?").bind(JSON.stringify({ ...records[0], appId: foreignApp }), latest).run();
  assert.equal((await get(`/api/apps/${appId}/operations`)).status, 409);
  assert.equal((await stats()).targets.length, 0);
  await runtime.fetch(origin + "/__test/control", { method: "POST", body: JSON.stringify({ revokeBeforeD1Read: true }) });
  assert.equal((await get(`/api/apps/${appId}/operations`)).status, 401);
  assert.equal((await stats()).targets.length, 0); // Revoked authority never reaches history enrichment.
});
