import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as api from "@app-ops/db";
import type { GitHubDetection, OTAAsset, OTADeployment, OperationsStore } from "@app-ops/dogfood";
const now = 1000;
async function setup() {
  const db = api.openDatabase(":memory:"); api.migrate(db);
  const store = api.createSqliteDogfoodStore(db), operations = (store as typeof store & { operations: OperationsStore }).operations;
  const first = await store.applications!.registerApplication({ name:"First", repositoryId:"github:one", rootDirectory:"apps/one" },now);
  const second = await store.applications!.registerApplication({ name:"Second", repositoryId:"github:two", rootDirectory:"apps/two" },now);
  return { db,store,operations,first,second };
}
async function detected(ops: OperationsStore, appId: string, rootDirectory: string, suffix: string): Promise<GitHubDetection> {
  const connection = await ops.saveGitHubConnection(appId,{ expectedVersion:0,installationId:123,owner:"example",repository:suffix,ref:"main" },now);
  return ops.saveGitHubDetection({ id:`detection_${suffix}`,appId,connection,rootDirectory,commitSha:"a".repeat(40),framework:"expo",expoVersion:"57.0.0",reactNativeVersion:"0.86.0",configSource:"app.json",runtimeVersion:"1.0.0",platforms:["ios","android"],updatesEnabled:true,updatesUrl:"https://updates.example/manifest",reasons:[],detectedAt:now });
}
function asset(appId: string, bytes: Uint8Array): OTAAsset {
  const hash = createHash("sha256").update(bytes); const digest = hash.digest("hex");
  return { id:"asset_"+digest,appId,digest,hash:Buffer.from(digest,"hex").toString("base64url"),key:digest,contentType:"application/javascript",fileExtension:".js",size:bytes.length,createdAt:now } as OTAAsset;
}
function deployment(appId:string,detection:GitHubDetection,launchAsset:OTAAsset): OTADeployment {
  return { id:"11111111-1111-4111-8111-111111111111",appId,createdAt:now,requestKey:"same-request",detectionId:detection.id,commitSha:detection.commitSha,channel:"preview",runtimeVersion:"1.0.0",platform:"ios",launchAssetId:launchAsset.id,assetIds:[],launchAsset,assets:[] };
}

test("manual rollback reuses immutable assets, advances publication and preserves app history after reconnect", async () => {
  const { db, operations: ops, first, second } = await setup();
  try {
    const detection = await detected(ops, first.id, first.rootDirectory, "rollback");
    const bytes = new TextEncoder().encode("old working bundle");
    const original = await ops.saveOTADeployment(deployment(first.id, detection, await ops.saveOTAAsset(asset(first.id, bytes), bytes)));
    const current = await ops.saveOTADeployment({ ...original, id: crypto.randomUUID(), requestKey: "broken-current" });
    await ops.saveGitHubConnection(first.id, { expectedVersion: 1, installationId: 123, owner: "example", repository: "different", ref: "new" }, now + 1);
    const assetRows = db.prepare("SELECT * FROM ota_assets").all();
    const restored = await ops.saveOTARollback({ ...original, id: crypto.randomUUID(), requestKey: "rollback-one", createdAt: now,
      rollback: { fromDeploymentId: current.id, targetDeploymentId: original.id, reason: "Restore working version", requestedAt: now } });
    assert.ok(restored.createdAt > current.createdAt);
    assert.notEqual(restored.id, original.id);
    assert.deepEqual(restored.launchAsset, original.launchAsset);
    assert.deepEqual(await ops.getOTADeployment(first.id, original.id), original);
    assert.equal(await ops.getOTADeployment(second.id, original.id), null);
    assert.equal((await ops.getLatestOTADeployment(first.id, { channel: restored.channel, runtimeVersion: restored.runtimeVersion, platform: restored.platform }))!.id, restored.id);
    assert.deepEqual(db.prepare("SELECT * FROM ota_assets").all(), assetRows);
    assert.equal((await ops.listOTADeployments(first.id)).length, 3);
    // A repeat request retains its first receipt even after a newer head exists.
    const next = await ops.saveOTARollback({ ...current, id: crypto.randomUUID(), requestKey: "rollback-next", createdAt: now,
      rollback: { fromDeploymentId: restored.id, targetDeploymentId: current.id, reason: "Second request", requestedAt: now } });
    assert.deepEqual(await ops.saveOTARollback({ ...restored, id: crypto.randomUUID(), createdAt: now + 99 }), restored);
    assert.equal((await ops.getLatestOTADeployment(first.id, { channel: next.channel, runtimeVersion: next.runtimeVersion, platform: next.platform }))!.id, next.id);
    await assert.rejects(ops.saveOTADeployment({ ...restored, id: crypto.randomUUID(), requestKey: "injected-normal" }));
    await assert.rejects(ops.saveOTARollback({ ...restored, requestKey: "stale-head" }), { code: "CONFIG_CONFLICT" });
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});

test("manual rollback rejects edited artifacts, foreign references and invalid selection without writing", async () => {
  const { db, operations: ops, first, second } = await setup();
  try {
    const detection = await detected(ops, first.id, first.rootDirectory, "rollback-invalid");
    const otherDetection = await detected(ops, second.id, second.rootDirectory, "rollback-other");
    const bytes = new TextEncoder().encode("bundle");
    const original = await ops.saveOTADeployment(deployment(first.id, detection, await ops.saveOTAAsset(asset(first.id, bytes), bytes)));
    const foreign = await ops.saveOTADeployment({ ...deployment(second.id, otherDetection, await ops.saveOTAAsset(asset(second.id, bytes), bytes)), id: crypto.randomUUID() });
    const current = await ops.saveOTADeployment({ ...original, id: crypto.randomUUID(), requestKey: "current" });
    const base = { ...original, id: crypto.randomUUID(), requestKey: "rollback-invalid", rollback: { fromDeploymentId: current.id, targetDeploymentId: original.id, reason: "Restore", requestedAt: now } };
    const before = db.prepare("SELECT * FROM ota_deployments").all();
    for (const [index, invalid] of [
      { ...base, rollback: { ...base.rollback, targetDeploymentId: foreign.id } },
      { ...base, rollback: { ...base.rollback, targetDeploymentId: current.id } },
      { ...base, platform: "android" as const },
      { ...base, commitSha: "b".repeat(40) },
      { ...base, rollback: { ...base.rollback, reason: "  " } },
      { ...base, rollback: { ...base.rollback, requestedAt: Number.NaN } },
    ].entries()) await assert.rejects(ops.saveOTARollback(invalid), "invalid rollback input " + index);
    assert.deepEqual(db.prepare("SELECT * FROM ota_deployments").all(), before);
  } finally { db.close(); }
});

test("operations isolate connections, detections, assets and publication across apps",async () => {
  const {db,store,operations:ops,first,second} = await setup();
  try {
    const one = await detected(ops,first.id,first.rootDirectory,"one"), two = await detected(ops,second.id,second.rootDirectory,"two");
    await store.applications!.updateApplicationSettings(first.id,{ expectedVersion:0,values:{ PUBLIC_URL:"https://one.example" } },now+1);
    assert.deepEqual((await store.applications!.getApplication(second.id))!.settings.values,{});
    const bytes = new TextEncoder().encode("globalThis.test=1;");
    const a = await ops.saveOTAAsset(asset(first.id,bytes),bytes), b = await ops.saveOTAAsset(asset(second.id,bytes),bytes);
    assert.equal(await ops.getPublishedOTAAsset(first.id,a.id),null);
    const published = await ops.saveOTADeployment(deployment(first.id,one,a));
    assert.deepEqual(await ops.saveOTADeployment({...published,id:"22222222-2222-4222-8222-222222222222",createdAt:now+1}),published);
    assert.equal((await ops.getPublishedOTAAsset(first.id,a.id))!.asset.appId,first.id);
    assert.equal(await ops.getPublishedOTAAsset(second.id,a.id),null);
    assert.equal(await ops.getLatestOTADeployment(second.id,{ channel:"preview",runtimeVersion:"1.0.0",platform:"ios" }),null);
    await ops.saveOTADeployment(deployment(second.id,two,b));
    assert.equal((await ops.getLatestOTADeployment(second.id,{ channel:"preview",runtimeVersion:"1.0.0",platform:"ios" }))!.appId,second.id);
    assert.equal(await ops.getLatestOTADeployment(first.id,{ channel:"production",runtimeVersion:"1.0.0",platform:"ios" }),null);
    assert.equal(await ops.getLatestOTADeployment(first.id,{ channel:"preview",runtimeVersion:"different",platform:"ios" }),null);
    assert.equal(await ops.getLatestOTADeployment(first.id,{ channel:"preview",runtimeVersion:"1.0.0",platform:"android" }),null);
    await assert.rejects(ops.saveOTADeployment({...published,channel:"production"}),{code:"IDEMPOTENCY_CONFLICT"});
    const extraBytes = new TextEncoder().encode("unpublished-extra");
    const extra = await ops.saveOTAAsset(asset(first.id,extraBytes),extraBytes);
    assert.throws(()=>db.prepare("INSERT INTO ota_deployment_assets VALUES(?,?,?,'asset')").run(first.id,published.id,extra.id));
    assert.equal(await ops.getPublishedOTAAsset(first.id,extra.id),null);
    assert.equal(await ops.getGitHubDetection(second.id,one.id),null);
    assert.deepEqual((await ops.listGitHubDetections(first.id)).map(d=>d.id),[one.id]);
    assert.throws(()=>db.exec("DELETE FROM ota_deployments")); assert.throws(()=>db.exec("UPDATE ota_assets SET data='{}'"));
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
  } finally { db.close(); }
});

test("operations reject stale connections, hash mismatch and cross-app refs without publication",async () => {
  const {db,operations:ops,first,second} = await setup();
  try {
    const one = await detected(ops,first.id,first.rootDirectory,"one"), two = await detected(ops,second.id,second.rootDirectory,"two");
    await assert.rejects(ops.saveGitHubConnection(first.id,{ expectedVersion:0,installationId:123,owner:"example",repository:"one",ref:"main" },now+1),{code:"CONFLICT"});
    await ops.saveGitHubConnection(first.id,{ expectedVersion:1,installationId:123,owner:"example",repository:"one",ref:"release" },now+1);
    await assert.rejects(ops.saveGitHubDetection({...one,id:"detection_stale"}),{code:"CONFLICT"});
    await assert.rejects(ops.saveGitHubDetection({...two,id:"detection_wrongroot",rootDirectory:first.rootDirectory}));
    const bytes = new TextEncoder().encode("bundle");
    await assert.rejects(ops.saveOTAAsset({...asset(first.id,bytes),hash:"incorrect"},bytes));
    const a = await ops.saveOTAAsset(asset(first.id,bytes),bytes);
    await assert.rejects(ops.saveOTADeployment({...deployment(first.id,one,a),detectionId:two.id}));
    await assert.rejects(ops.saveOTADeployment({...deployment(second.id,two,a),launchAsset:a,launchAssetId:a.id}));
    await assert.rejects(ops.saveOTADeployment({...deployment(first.id,one,a),commitSha:"b".repeat(40)}));
    assert.equal((await ops.listOTADeployments(first.id)).length,0);
    assert.equal(await ops.getPublishedOTAAsset(first.id,a.id),null);
    assert.equal(db.prepare("SELECT count(*) n FROM github_connection_history WHERE app_id=?").get(first.id)!.n,2);
    assert.throws(()=>db.exec("DELETE FROM github_connection_history"));
  } finally { db.close(); }
});

test("failed publication rolls back deployment refs and receipt while staged assets remain private",async () => {
  const {db,operations:ops,first} = await setup();
  try {
    const detection = await detected(ops,first.id,first.rootDirectory,"one"), bytes = new TextEncoder().encode("bundle");
    const a = await ops.saveOTAAsset(asset(first.id,bytes),bytes);
    db.exec("CREATE TRIGGER reject_publication BEFORE INSERT ON ota_deployment_assets BEGIN SELECT RAISE(ABORT,'injected publication failure'); END");
    await assert.rejects(ops.saveOTADeployment(deployment(first.id,detection,a)),{code:"CONFLICT"});
    assert.equal((await ops.listOTADeployments(first.id)).length,0);
    assert.equal(db.prepare("SELECT count(*) n FROM ota_deployment_assets").get()!.n,0);
    assert.equal(await ops.getPublishedOTAAsset(first.id,a.id),null);
    assert.equal((await ops.listOTAAssets(first.id)).length,1);
    db.exec("DROP TRIGGER reject_publication");
    assert.equal((await ops.saveOTADeployment(deployment(first.id,detection,a))).requestKey,"same-request");
  } finally { db.close(); }
});

test("assets copy binary content, preserve immutable metadata and enforce per-app quotas",async () => {
  const {db,operations:ops,first,second} = await setup();
  try {
    const bytes = new TextEncoder().encode("immutable bundle"), metadata = asset(first.id,bytes);
    const saved = await ops.saveOTAAsset(metadata,bytes);
    assert.deepEqual(await ops.saveOTAAsset({...metadata,createdAt:now+1},bytes),saved);
    await assert.rejects(ops.saveOTAAsset({...metadata,key:"another_key"},bytes),{code:"IDEMPOTENCY_CONFLICT"});
    bytes.fill(0); const read = (await ops.getOTAAsset(first.id,saved.id))!;
    assert.equal(new TextDecoder().decode(read.bytes),"immutable bundle"); read.bytes.fill(0);
    assert.equal(new TextDecoder().decode((await ops.getOTAAsset(first.id,saved.id))!.bytes),"immutable bundle");
    assert.equal(await ops.getOTAAsset(second.id,saved.id),null);
    for (let i=1;i<128;i++) {
      const content = new TextEncoder().encode(`asset-${i}`);
      await ops.saveOTAAsset(asset(first.id,content),content);
    }
    const overflow = new TextEncoder().encode("overflow");
    await assert.rejects(ops.saveOTAAsset(asset(first.id,overflow),overflow),{code:"INPUT_TOO_LARGE"});
    assert.equal((await ops.listOTAAssets(first.id)).length,128);
    await ops.saveOTAAsset(asset(second.id,overflow),overflow);
    const tooBig = new Uint8Array(16*1024*1024+1);
    await assert.rejects(ops.saveOTAAsset(asset(second.id,tooBig),tooBig),{code:"INVALID_INPUT"});
    assert.throws(()=>db.exec("INSERT OR REPLACE INTO ota_assets SELECT * FROM ota_assets"));
  } finally { db.close(); }
});

test("asset byte quota allows exact sixteen MiB assets but rejects overflow at sixty-four MiB",async () => {
  const {db,operations:ops,first} = await setup();
  try {
    const bytes = new Uint8Array(16*1024*1024);
    for (let i=0;i<4;i++) { bytes.fill(i); await ops.saveOTAAsset(asset(first.id,bytes),bytes); }
    const extra = new Uint8Array([5]);
    await assert.rejects(ops.saveOTAAsset(asset(first.id,extra),extra),{code:"INPUT_TOO_LARGE"});
    assert.equal((await ops.listOTAAssets(first.id)).length,4);
    assert.equal(db.prepare("SELECT sum(size) n FROM ota_assets").get()!.n,64*1024*1024);
    assert.equal(await ops.getPublishedOTAAsset(first.id,asset(first.id,bytes).id),null);
  } finally { db.close(); }
});

test("operations histories return newest first, breaking equal timestamps by insertion order",async () => {
  const {db,operations:ops,first} = await setup();
  try {
    const original = await detected(ops,first.id,first.rootDirectory,"one");
    await ops.saveGitHubDetection({...original,id:"github_newest",configSource:"resolved-export"});
    assert.deepEqual((await ops.listGitHubDetections(first.id)).map(d=>d.id),["github_newest",original.id]);
    const bytes = new TextEncoder().encode("bundle"), a = await ops.saveOTAAsset(asset(first.id,bytes),bytes);
    const firstDeployment = await ops.saveOTADeployment(deployment(first.id,original,a));
    const newest = await ops.saveOTADeployment({...firstDeployment,id:"00000000-0000-4000-8000-000000000000",requestKey:"newest_publication"});
    assert.deepEqual((await ops.listOTADeployments(first.id)).map(d=>d.id),[newest.id,firstDeployment.id]);
    assert.equal((await ops.getLatestOTADeployment(first.id,{channel:"preview",runtimeVersion:"1.0.0",platform:"ios"}))!.id,newest.id);
    for (let i=1;i<=100;i++) {
      await ops.saveGitHubDetection({...original,id:`github_order_${i}`});
      await ops.saveOTADeployment({...firstDeployment,id:i.toString(16).padStart(8,"0")+"-0000-4000-8000-000000000000",requestKey:`publication_order_${i}`});
    }
    const detections = await ops.listGitHubDetections(first.id), deployments = await ops.listOTADeployments(first.id);
    assert.equal(detections.length,100); assert.equal(detections[0]!.id,"github_order_100"); assert.equal(detections.at(-1)!.id,"github_order_1");
    assert.equal(deployments.length,100); assert.equal(deployments[0]!.requestKey,"publication_order_100"); assert.equal(deployments.at(-1)!.requestKey,"publication_order_1");
    assert.deepEqual(deployments.slice(0,20).map(d=>d.requestKey),Array.from({length:20},(_,i)=>`publication_order_${100-i}`));
  } finally { db.close(); }
});

test("publication receipt lookup remains app scoped after reconnect and beyond history limits",async () => {
  const {db,operations:ops,first,second} = await setup();
  try {
    const detection = await detected(ops,first.id,first.rootDirectory,"one"), bytes = new TextEncoder().encode("receipt-bundle"), a = await ops.saveOTAAsset(asset(first.id,bytes),bytes);
    const original = await ops.saveOTADeployment(deployment(first.id,detection,a));
    for (let i=1;i<=101;i++) await ops.saveOTADeployment({...original,id:i.toString(16).padStart(8,"0")+"-0000-4000-8000-000000000000",requestKey:`receipt_order_${i}`});
    await ops.saveGitHubConnection(first.id,{ expectedVersion:1,installationId:123,owner:"example",repository:"one",ref:"release" },now+1);
    assert.ok(!(await ops.listOTADeployments(first.id)).some(d=>d.id===original.id));
    assert.deepEqual(await ops.getOTADeploymentForRequest(first.id,original.requestKey),original);
    assert.equal(await ops.getOTADeploymentForRequest(second.id,original.requestKey),null);
    assert.equal(await ops.getOTADeploymentForRequest(first.id,"unknown_request"),null);
  } finally { db.close(); }
});

test("publication timestamps increase per update selection when the input clock repeats",async () => {
  const {db,operations:ops,first} = await setup();
  try {
    const detection = await detected(ops,first.id,first.rootDirectory,"one"), bytes = new TextEncoder().encode("monotonic-bundle"), a = await ops.saveOTAAsset(asset(first.id,bytes),bytes);
    const firstPublication = await ops.saveOTADeployment(deployment(first.id,detection,a));
    const secondPublication = await ops.saveOTADeployment({...firstPublication,id:"22222222-2222-4222-8222-222222222222",requestKey:"monotonic_second",createdAt:firstPublication.createdAt});
    assert.equal(secondPublication.createdAt,firstPublication.createdAt+1);
    assert.equal((await ops.getLatestOTADeployment(first.id,{channel:"preview",runtimeVersion:"1.0.0",platform:"ios"}))!.id,secondPublication.id);
    assert.deepEqual(await ops.saveOTADeployment({...firstPublication,createdAt:firstPublication.createdAt+100}),firstPublication);
    const otherChannel = await ops.saveOTADeployment({...firstPublication,id:"33333333-3333-4333-8333-333333333333",requestKey:"other_channel",channel:"production"});
    assert.equal(otherChannel.createdAt,firstPublication.createdAt);
    const third = await ops.saveOTADeployment({...firstPublication,id:"44444444-4444-4444-8444-444444444444",requestKey:"backwards_clock",createdAt:firstPublication.createdAt});
    assert.equal(third.createdAt,secondPublication.createdAt+1);
    const maximum = await ops.saveOTADeployment({...firstPublication,id:"55555555-5555-4555-8555-555555555555",requestKey:"maximum_timestamp",channel:"maximum",createdAt:Number.MAX_SAFE_INTEGER});
    await assert.rejects(ops.saveOTADeployment({...firstPublication,id:"66666666-6666-4666-8666-666666666666",requestKey:"timestamp_overflow",channel:"maximum"}),{code:"INVALID_INPUT"});
    assert.equal((await ops.getLatestOTADeployment(first.id,{channel:"maximum",runtimeVersion:"1.0.0",platform:"ios"}))!.id,maximum.id);
    assert.equal(await ops.getOTADeploymentForRequest(first.id,"timestamp_overflow"),null);
  } finally { db.close(); }
});
