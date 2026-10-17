import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createTestRuntime } from "./runtime.ts";

const origin = "https://verification.example.test", now = 1_800_000_000_000;
const appA = "application_first", appB = "application_second", deploymentA = "ba0ded11-d92f-4d64-b8e0-a98bc5693fee", deploymentB = "7e83448c-5391-4a65-87c9-05b9817e103e";
const proof = (deploymentId = deploymentA, platform = "android") => ({ deploymentId, platform, channel: "verification", runtimeVersion: "native-v1", commitSha: "a".repeat(40),
  environment: platform === "ios" ? "ios-simulator" : "android-emulator", observedAt: now, applied: true, restarted: true, signatureVerified: true, assetsVerified: true, receiptDigest: "c".repeat(64) });

test("operator verification requires owner session and CSRF, isolates two app receipts and preserves published history", async t => {
  const token = randomBytes(32), password = randomBytes(24).toString("base64url");
  const runtime = await createTestRuntime({ entrypoint: new URL("./fixtures/hosted-entry.ts", import.meta.url), durableObjects: { FLORA_AUTH: "HostedFixtureAuth" }, bindings: {
    FLORA_ORIGIN: origin, FLORA_OWNER_ID: "owner_a", FLORA_OWNER_EMAIL: "owner@example.test", FLORA_DB_IDENTITY: "db_a",
    FLORA_SETUP: { digest: createHash("sha256").update(token).digest("hex"), issuedAt: now, expiresAt: now + 600000, generation: 1, purpose: "enroll" },
  }}); t.after(() => runtime.dispose());
  await runtime.d1.exec(`CREATE TABLE flora_deployment(singleton INTEGER,owner_id TEXT,origin TEXT,db_identity TEXT);
CREATE TABLE applications(owner_id TEXT,id TEXT,name TEXT,repository_id TEXT,root_directory TEXT,created_at INTEGER,PRIMARY KEY(owner_id,id));
CREATE TABLE ota_deployments(owner_id TEXT,app_id TEXT,id TEXT,platform TEXT,channel TEXT,runtime_version TEXT,created_at INTEGER,data TEXT,PRIMARY KEY(owner_id,app_id,id));
CREATE TABLE github_connections(owner_id TEXT,app_id TEXT,version INTEGER,data TEXT);
CREATE TABLE automation_policies(owner_id TEXT,app_id TEXT,version INTEGER,data TEXT);
CREATE TABLE automation_runners(owner_id TEXT,id TEXT,version INTEGER,data TEXT);`);
  await runtime.d1.prepare("INSERT INTO flora_deployment VALUES(1,?,?,?)").bind("owner_a",origin,"db_a").run();
  for (const [appId, deploymentId, platform] of [[appA,deploymentA,"android"],[appB,deploymentB,"ios"]]) {
    await runtime.d1.prepare("INSERT INTO applications VALUES(?,?,?,?,?,?)").bind("owner_a",appId,appId,"synthetic/"+appId,".",now-10).run();
    await runtime.d1.prepare("INSERT INTO ota_deployments VALUES(?,?,?,?,?,?,?,?)").bind("owner_a",appId,deploymentId,platform,"verification","native-v1",now-1,JSON.stringify({commitSha:"a".repeat(40),secret:"OLD_SOURCE_MUST_REMAIN"})).run();
  }
  const history = () => runtime.d1.prepare("SELECT * FROM ota_deployments ORDER BY app_id,id").all();
  const before = (await history()).results;
  const call = (path: string, body?: unknown, cookie = "", csrf = "") => runtime.fetch(origin + path, { headers: { Cookie: cookie, ...(body === undefined ? {} : { Origin: origin, "Content-Type": "application/json", "X-Flora-CSRF": csrf }) }, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  const path = (app: string) => "/api/apps/" + app + "/ota/verification";
  assert.equal((await call(path(appA),proof())).status,401);
  const enrolled = await call("/api/auth/enroll",{email:"owner@example.test",password,confirmation:password,token:token.toString("base64url")}); assert.equal(enrolled.status,200);
  const cookie = enrolled.headers.getSetCookie().map(v=>v.split(";",1)[0]).join("; "), csrf = (await enrolled.json() as {csrfToken:string}).csrfToken;
  assert.equal((await call(path(appA),proof(),cookie)).status,403);
  assert.equal((await call(path(appB),proof(),cookie,csrf)).status,404);
  for (const input of [{...proof(),runtimeVersion:"wrong"},{...proof(),channel:"wrong"},{...proof(),commitSha:"b".repeat(40)},{...proof(),platform:"ios",environment:"ios-simulator"}]) {
    assert.equal((await call(path(appA),input,cookie,csrf)).status,409);
  }
  for (const input of [{...proof(),applied:false},{...proof(),restarted:false},{...proof(),signatureVerified:false},{...proof(),assetsVerified:false},{...proof(),observedAt:now+1},{...proof(),observedAt:now-2},{...proof(),environment:"unknown"},{...proof(),receiptDigest:"bad"},{...proof(),clientId:"must-not-store"}]) {
    assert.equal((await call(path(appA),input,cookie,csrf)).status,400);
  }
  const saved = await call(path(appA),proof(),cookie,csrf); assert.equal(saved.status,201); const receipt = await saved.json() as any;
  assert.equal(receipt.verification.source,"operator-verification"); assert.equal(receipt.verification.environment,"android-emulator");
  const retry = await call(path(appA),proof(),cookie,csrf); assert.equal(retry.status,200); assert.deepEqual(await retry.json(),receipt);
  assert.equal((await call(path(appA),{...proof(),environment:"physical-device"},cookie,csrf)).status,409);
  const second = await call(path(appB),proof(deploymentB,"ios"),cookie,csrf); assert.equal(second.status,201);
  const list = await call("/api/projects",undefined,cookie); assert.equal(list.status,200); const projects = (await list.json() as any).projects;
  assert.equal(projects.find((p:any)=>p.id===appA).ota.android.verification.environment,"android-emulator");
  assert.equal(projects.find((p:any)=>p.id===appB).ota.ios.verification.environment,"ios-simulator");
  assert.equal(projects.find((p:any)=>p.id===appA).ota.ios,null); assert.equal(projects.find((p:any)=>p.id===appB).ota.android,null);
  assert.doesNotMatch(JSON.stringify(projects),/OLD_SOURCE_MUST_REMAIN|clientId|fleet|installCount/);
  assert.deepEqual((await history()).results,before);
  const control = (input:unknown)=>call("/__test/control",input,cookie,csrf);
  const count = await control({sql:"SELECT count(*) AS total FROM flora_ota_verifications"}); assert.equal((await count.json() as any)[0].total,2);
  await control({restart:true}); assert.equal((await call(path(appA),proof(),cookie,csrf)).status,200);
  await control({revokeBeforeD1Read:true}); assert.equal((await call(path(appA),{...proof(),receiptDigest:"d".repeat(64)},cookie,csrf)).status,401);
  const retained = await control({sql:"SELECT count(*) AS total FROM flora_ota_verifications"}); assert.equal((await retained.json() as any)[0].total,2);
});
