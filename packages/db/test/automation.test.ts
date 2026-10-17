import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { canonicalJson } from "@app-ops/config";
import * as api from "@app-ops/db";
import { prepareOTAAsset, createAutomationService, runnerTokenHash } from "@app-ops/dogfood";
import type { AutomationJob, AutomationStore, RunnerAuthority, RunnerCredential } from "@app-ops/dogfood";
const now = 1000;
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
async function setup(path = ":memory:") {
  const db = api.openDatabase(path); api.migrate(db);
  const store = api.createSqliteDogfoodStore(db), automation = (store as typeof store & {automation:AutomationStore}).automation;
  const apps = [];
  for (const name of ["one","two"]) {
    const app = await store.applications!.registerApplication({name,repositoryId:`github:${name}`,rootDirectory:`apps/${name}`},now);
    const connection = await store.operations!.saveGitHubConnection(app.id,{expectedVersion:0,installationId:1,owner:"example",repository:name,ref:"main"},now);
    const config = {schemaVersion:1 as const,bundler:"expo" as const,entryFile:"src/index.js",toolchain:{nodeVersion:"24.19.0",packageManager:{name:"pnpm" as const,version:"11.19.0"}},runtimeVersion:"1",platforms:["ios" as const,"android" as const],updatesUrl:`https://updates.example/updates/${app.id}`};
    const detection = await store.operations!.saveGitHubDetection({id:`github_${name}`,appId:app.id,connection,rootDirectory:app.rootDirectory,commitSha:"a".repeat(40),framework:"expo",expoVersion:"57",reactNativeVersion:null,configSource:"resolved-export",runtimeVersion:"1",platforms:["ios","android"],updatesEnabled:true,updatesUrl:`https://updates.example/updates/${app.id}`,reasons:[],detectedAt:now,automationConfig:config});

    const job: AutomationJob = {id:`automation_${name}`,appId:app.id,requestKey:"same_request",detectionId:detection.id,channel:"preview",runtimeVersion:"1",platform:"ios",config,detection,commitSha:detection.commitSha,rootDirectory:app.rootDirectory,connection,configDigest:hash(config),toolchainDigest:hash(config.toolchain),createdAt:now,updatedAt:now,state:"queued",attemptCount:0,lease:null,code:null,deploymentId:null,receipt:null};
    apps.push({app,job});
  }
  return {db,store,automation,first:apps[0]!,second:apps[1]!};
}
async function runner(automation: AutomationStore, appIds:string[],suffix="one") {
  const credential: RunnerCredential = {id:`runner_${suffix}`,name:suffix,appIds,createdAt:now,credentialEpoch:1,revokedAt:null,tokenHash:createHash("sha256").update(suffix).digest("hex")};
  const summary = await automation.registerRunner(credential);
  const authority: RunnerAuthority = {runnerId:credential.id,credentialEpoch:1,tokenHash:credential.tokenHash};
  return {credential,summary,authority};
}

test("dual automatic policy preserves legacy rows and independent app histories without a migration", async () => {
  const { db, automation: jobs, store, first, second } = await setup();
  try {
    const legacy = await jobs.updateAutomationPolicy(first.app.id, { expectedVersion: 0, enabled: true, channel: "preview", platform: "ios" }, now);
    const oldRows = db.prepare("SELECT * FROM automation_policy_history ORDER BY app_id,version").all();
    const schema = db.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const dual = await jobs.updateAutomationPolicy(first.app.id, { expectedVersion: 1, enabled: true, channel: "preview", platforms: ["ios", "android"] }, now + 1);
    assert.deepEqual(dual, { appId: first.app.id, version: 2, enabled: true, channel: "preview", platforms: ["ios", "android"], updatedAt: now + 1 });
    assert.deepEqual(db.prepare("SELECT * FROM automation_policy_history WHERE version=1 ORDER BY app_id,version").all(), oldRows);
    assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(), schema);
    assert.deepEqual(JSON.parse(String(oldRows[0]!.data)), legacy);
    assert.equal((await jobs.getAutomationPolicy(second.app.id)).version, 0);
    for (const platform of ["ios", "android"] as const) {
      const saved = await jobs.enqueueAutomationJob({ ...first.job, id: "automation_dual_" + platform, requestKey: "dual_" + platform, platform }, dual.version);
      assert.equal(saved.platform, platform);
    }
    assert.deepEqual(await store.operations!.listOTADeployments(first.app.id), []);
    assert.deepEqual(await jobs.listAutomationJobs(second.app.id), []);
    await jobs.updateAutomationPolicy(first.app.id, { expectedVersion: 2, enabled: true, channel: "preview", platforms: ["ios"] }, now + 2);
    await assert.rejects(jobs.enqueueAutomationJob({ ...first.job, id: "automation_removed_android", requestKey: "removed_android", platform: "android" }, 3), { code: "CONFIG_CONFLICT" });
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});

test("two repository pushes each fan out once per platform and duplicate delivery does not redetect or duplicate", async () => {
  const { db, automation: jobs, store, first, second } = await setup();
  try {
    for (const item of [first, second]) await jobs.updateAutomationPolicy(item.app.id, { expectedVersion: 0, enabled: true, channel: "preview", platforms: ["ios", "android"] }, now);
    let detections = 0;
    const service = createAutomationService({ applications: store.applications!, operations: store.operations!, automation: jobs }, {
      now: () => now, publicOrigin: "https://updates.example", async detectPushCommit(appId, commitSha) {
        detections++; const existing = [first, second].find(item => item.app.id === appId)!.job.detection;
        assert.equal(existing.commitSha, commitSha); return existing;
      },
    });
    const event = (repository: string) => ({ deliveryId: "same_delivery", installationId: 1, owner: "example", repository, ref: "main", commitSha: "a".repeat(40) });
    const a = await service.handleGitHubPush(event("one"));
    assert.deepEqual(a.jobs.map(job => job.platform), ["ios", "android"]); assert.equal(a.ignored, 0);
    assert.deepEqual(await jobs.listAutomationJobs(second.app.id), []);
    assert.equal(new Set(a.jobs.map(job => job.requestKey)).size, 2);
    assert.ok(a.jobs.every(job => job.requestKey.endsWith("_" + job.platform)));
    assert.deepEqual(await service.handleGitHubPush(event("one")), a); assert.equal(detections, 1);
    const b = await service.handleGitHubPush(event("two"));
    assert.equal(b.jobs.length, 2); assert.equal(detections, 2);
    assert.ok(b.jobs.every(job => job.appId === second.app.id));
    assert.deepEqual(new Set(b.jobs.map(job => job.requestKey)), new Set(a.jobs.map(job => job.requestKey)));
    assert.deepEqual(await service.handleGitHubPush(event("two")), b); assert.equal(detections, 2);
    await assert.rejects(service.handleGitHubPush({ ...event("one"), commitSha: "b".repeat(40) }), { code: "IDEMPOTENCY_CONFLICT" });
  } finally { db.close(); }
});

test("unchanged dual policies deploy both platforms for two future commits in each repository and retain every older job", async () => {
  const { db, automation: jobs, store, first, second } = await setup();
  try {
    const apps = [first, second];
    for (const item of apps) await jobs.updateAutomationPolicy(item.app.id, { expectedVersion: 0, enabled: true, channel: "preview", platforms: ["ios", "android"] }, now);
    const policiesBefore = db.prepare("SELECT * FROM automation_policy_history ORDER BY app_id,version").all();
    const appsBefore = await Promise.all(apps.map(item => store.applications!.getApplication(item.app.id)));
    const connectionsBefore = await Promise.all(apps.map(item => store.operations!.getGitHubConnection(item.app.id)));
    let clock = now + 1, detections = 0;
    const service = createAutomationService({ applications: store.applications!, operations: store.operations!, automation: jobs }, {
      now: () => clock, publicOrigin: "https://updates.example", async detectPushCommit(appId, commitSha) {
        detections++;
        const previous = apps.find(item => item.app.id === appId)!.job.detection;
        return store.operations!.saveGitHubDetection({ ...previous, id: previous.id + "_" + commitSha[0], detectedAt: clock, commitSha });
      },
    });
    const history: { event: { deliveryId: string; installationId: number; owner: string; repository: string; ref: string; commitSha: string }; jobs: AutomationJob[] }[] = [];
    let olderRows = db.prepare("SELECT * FROM automation_jobs ORDER BY app_id,id").all();
    for (const prefix of ["b", "c"]) {
      clock++;
      for (const item of apps) {
        const event = { deliveryId: "future_" + item.job.connection.repository + "_" + prefix, installationId: 1, owner: "example", repository: item.job.connection.repository, ref: "main", commitSha: prefix.repeat(40) };
        const result = await service.handleGitHubPush(event);
        assert.equal(result.ignored, 0); assert.deepEqual(result.jobs.map(job => job.platform), ["ios", "android"]);
        assert.ok(result.jobs.every(job => job.appId === item.app.id && job.commitSha === event.commitSha && job.connection.repository === event.repository));
        assert.equal(new Set(result.jobs.map(job => job.detectionId)).size, 1, "Each commit is detected once and shared by its two platform jobs");
        history.push({ event, jobs: result.jobs });
      }
      assert.deepEqual(db.prepare("SELECT * FROM automation_policy_history ORDER BY app_id,version").all(), policiesBefore);
      for (const item of apps) assert.equal((await jobs.getAutomationPolicy(item.app.id)).version, 1);
      if (prefix === "b") olderRows = db.prepare("SELECT * FROM automation_jobs ORDER BY app_id,id").all();
    }
    assert.equal(detections, 4); assert.equal(olderRows.length, 4);
    const allRows = db.prepare("SELECT * FROM automation_jobs ORDER BY app_id,id").all();
    const olderIds = new Set(olderRows.map(row => row.id));
    assert.equal(allRows.length, 8); assert.deepEqual(allRows.filter(row => olderIds.has(row.id)), olderRows);
    for (const { event, jobs: expected } of history) {
      assert.deepEqual(await service.handleGitHubPush(event), { jobs: expected, ignored: 0 });
      for (const job of expected) {
        assert.deepEqual(await jobs.getAutomationJob(job.appId, job.id), job);
        const siblingApp = job.appId === first.app.id ? second.app.id : first.app.id;
        assert.equal(await jobs.getAutomationJob(siblingApp, job.id), null);
      }
    }
    assert.equal(detections, 4, "Replaying older and current deliveries performs no new detection");
    assert.deepEqual(db.prepare("SELECT * FROM automation_jobs ORDER BY app_id,id").all(), allRows);
    assert.deepEqual(db.prepare("SELECT * FROM automation_policy_history ORDER BY app_id,version").all(), policiesBefore);
    assert.deepEqual(await Promise.all(apps.map(item => store.applications!.getApplication(item.app.id))), appsBefore);
    assert.deepEqual(await Promise.all(apps.map(item => store.operations!.getGitHubConnection(item.app.id))), connectionsBefore);
    for (const item of apps) {
      const retained = await jobs.listAutomationJobs(item.app.id);
      assert.equal(retained.length, 4); assert.deepEqual(new Set(retained.map(job => job.commitSha)), new Set(["b".repeat(40), "c".repeat(40)]));
    }
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});

test("legacy webhook key replays only its platform when the policy grows to both", async () => {
  const { db, automation: jobs, store, first } = await setup();
  try {
    const deliveryId = "legacy_delivery", legacy = await jobs.enqueueAutomationJob({ ...first.job, requestKey: "hook_" + await runnerTokenHash(deliveryId) });
    await jobs.updateAutomationPolicy(first.app.id, { expectedVersion: 0, enabled: true, channel: "preview", platforms: ["ios", "android"] }, now);
    let detections = 0;
    const service = createAutomationService({ applications: store.applications!, operations: store.operations!, automation: jobs }, {
      now: () => now, publicOrigin: "https://updates.example", async detectPushCommit() { detections++; return first.job.detection; },
    });
    const event = { deliveryId, installationId: 1, owner: "example", repository: "one", ref: "main", commitSha: "a".repeat(40) };
    const result = await service.handleGitHubPush(event);
    assert.deepEqual(result.jobs.map(job => job.platform), ["ios", "android"]);
    assert.deepEqual(result.jobs[0], legacy); assert.equal(result.jobs[1]!.requestKey, legacy.requestKey + "_android");
    assert.deepEqual(await service.handleGitHubPush(event), result); assert.equal(detections, 1);
    assert.equal((await jobs.listAutomationJobs(first.app.id)).length, 2);
  } finally { db.close(); }
});

test("unsupported platform is skipped while its supported sibling is admitted", async () => {
  const { db, automation: jobs, store, first } = await setup();
  try {
    await jobs.updateAutomationPolicy(first.app.id, { expectedVersion: 0, enabled: true, channel: "preview", platforms: ["ios", "android"] }, now);
    const recipe = { ...first.job.config, platforms: ["ios" as const] };
    const detection = await store.operations!.saveGitHubDetection({ ...first.job.detection, id: "github_ios_only", platforms: ["ios"], automationConfig: recipe });
    const service = createAutomationService({ applications: store.applications!, operations: store.operations!, automation: jobs }, {
      now: () => now, publicOrigin: "https://updates.example", async detectPushCommit() { return detection; },
    });
    const result = await service.handleGitHubPush({ deliveryId: "unsupported_android", installationId: 1, owner: "example", repository: "one", ref: "main", commitSha: "a".repeat(40) });
    assert.deepEqual(result.jobs.map(job => job.platform), ["ios"]); assert.equal(result.ignored, 1);
    assert.equal((await jobs.listAutomationJobs(first.app.id)).length, 1);
  } finally { db.close(); }
});

test("policy CAS during fanout rejects the remaining platform and preserves the already admitted sibling", async () => {
  const { db, automation: jobs, store, first } = await setup();
  try {
    await jobs.updateAutomationPolicy(first.app.id, { expectedVersion: 0, enabled: true, channel: "preview", platforms: ["ios", "android"] }, now);
    let changed = false;
    const racing = { ...jobs, async enqueueAutomationJob(job: AutomationJob, version?: number) {
      const saved = await jobs.enqueueAutomationJob(job, version);
      if (!changed) { changed = true; await jobs.updateAutomationPolicy(first.app.id, { expectedVersion: 1, enabled: true, channel: "preview", platforms: ["ios"] }, now + 1); }
      return saved;
    } };
    const service = createAutomationService({ applications: store.applications!, operations: store.operations!, automation: racing }, {
      now: () => now, publicOrigin: "https://updates.example", async detectPushCommit() { return first.job.detection; },
    });
    const result = await service.handleGitHubPush({ deliveryId: "fanout_policy_race", installationId: 1, owner: "example", repository: "one", ref: "main", commitSha: "a".repeat(40) });
    assert.deepEqual(result.jobs.map(job => job.platform), ["ios"]); assert.equal(result.ignored, 1);
    assert.deepEqual(await jobs.listAutomationJobs(first.app.id), result.jobs);
    assert.equal((await jobs.getAutomationPolicy(first.app.id)).version, 2);
  } finally { db.close(); }
});

test("platform claims remain scoped and one export failure retains the successful sibling publication", async () => {
  const { db, automation: jobs, store, first, second } = await setup();
  try {
    const ios = await jobs.enqueueAutomationJob({ ...first.job, requestKey: "ios_job" });
    const android = await jobs.enqueueAutomationJob({ ...first.job, id: "automation_android", requestKey: "android_job", platform: "android" });
    await jobs.enqueueAutomationJob(second.job);
    const machine = await runner(jobs, [first.app.id, second.app.id]);
    const androidClaim = (await jobs.claimAutomationJob(machine.authority, now, 5000, { appId: first.app.id, commitSha: first.job.commitSha, platform: "android" }))!;
    assert.equal(androidClaim.job.id, android.id); assert.equal((await jobs.getAutomationJob(first.app.id, ios.id))!.state, "queued");
    assert.equal(await jobs.claimAutomationJob(machine.authority, now, 5000, { appId: first.app.id, commitSha: "b".repeat(40), platform: "ios" }), null);
    const bytes = new TextEncoder().encode("android-bundle"), asset = await prepareOTAAsset(first.app.id, { key: "android-launch", contentType: "application/javascript", fileExtension: ".js" }, bytes, now);
    await jobs.saveAutomationAsset(machine.authority, androidClaim.lease, asset, bytes, now);
    const completed = await jobs.finalizeAutomationJob(machine.authority, androidClaim.lease, await publication(android, androidClaim.lease, asset), now);
    const iosClaim = (await jobs.claimAutomationJob(machine.authority, now, 5000, { appId: first.app.id, commitSha: first.job.commitSha, platform: "ios" }))!;
    await jobs.failAutomationJob(machine.authority, iosClaim.lease, "EXPORT_FAILED", now);
    assert.deepEqual(await jobs.getAutomationJob(first.app.id, android.id), completed.job);
    assert.equal((await store.operations!.listOTADeployments(first.app.id))[0]!.platform, "android");
    assert.deepEqual(await store.operations!.listOTADeployments(second.app.id), []);
    assert.equal((await jobs.getAutomationJob(second.app.id, second.job.id))!.state, "queued");
  } finally { db.close(); }
});

test("automation keys, machine scopes and immutable audit histories remain app scoped",async()=>{
  const {db,automation:jobs,first,second} = await setup();
  try {
    assert.deepEqual(await jobs.enqueueAutomationJob(first.job),first.job);
    assert.deepEqual(await jobs.enqueueAutomationJob({...first.job,id:"automation_retry",createdAt:now+1,updatedAt:now+1}),first.job);
    await jobs.enqueueAutomationJob(second.job);
    await assert.rejects(jobs.enqueueAutomationJob({...first.job,channel:"production"}),{code:"IDEMPOTENCY_CONFLICT"});
    const one = await runner(jobs,[first.app.id]), two = await runner(jobs,[second.app.id],"two");
    assert.ok(!JSON.stringify(one.summary).includes(one.credential.tokenHash));
    const claim = (await jobs.claimAutomationJob(one.authority,now,5000))!;
    assert.equal(claim.job.appId,first.app.id);
    const secondClaim = (await jobs.claimAutomationJob(two.authority,now,5000))!;
    assert.equal(secondClaim.job.appId,second.app.id);
    await assert.rejects(jobs.requireAutomationLease(one.authority,secondClaim.lease,now));
    await assert.rejects(jobs.claimAutomationJob({...one.authority,tokenHash:"f".repeat(64)},now,5000),{code:"PERMISSION_DENIED"});
    assert.equal((await jobs.listAutomationAttempts(first.app.id,first.job.id)).length,1);
    assert.deepEqual((await jobs.listAutomationEvents(first.app.id,first.job.id)).map(e=>e.kind),["queued","claimed"]);
    assert.equal(await jobs.getAutomationJob(second.app.id,first.job.id),null);
    assert.equal(await jobs.getAutomationJobForRequest(second.app.id,first.job.requestKey).then(j=>j!.id),second.job.id);
    assert.throws(()=>db.exec("DELETE FROM automation_events"));
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
  } finally {db.close();}
});

test("heartbeat trusts current lease, expiry fences retries and revocation stops active machines",async()=>{
  const {db,automation:jobs,first} = await setup();
  try {
    await jobs.enqueueAutomationJob(first.job); const machine = await runner(jobs,[first.app.id]);
    const claim = (await jobs.claimAutomationJob(machine.authority,now,5000))!;
    const extended = await jobs.heartbeatAutomationJob(machine.authority,claim.lease,now+1000,5000);
    assert.equal(extended.expiresAt,now+6000);
    assert.equal((await jobs.requireAutomationLease(machine.authority,{...claim.lease,expiresAt:1},now+5500)).id,first.job.id);
    assert.equal((await jobs.expireAutomationJob(first.app.id,first.job.id,extended.expiresAt)).state,"queued");
    const next = (await jobs.claimAutomationJob(machine.authority,extended.expiresAt,5000))!;
    assert.equal(next.lease.fence,claim.lease.fence+1);
    const bytes = new TextEncoder().encode("bundle"), asset = await prepareOTAAsset(first.app.id,{key:"bundle",contentType:"application/javascript",fileExtension:".js"},bytes,extended.expiresAt);
    await assert.rejects(jobs.saveAutomationAsset(machine.authority,claim.lease,asset,bytes,extended.expiresAt),{code:"LEASE_STALE"});
    await jobs.saveAutomationAsset(machine.authority,next.lease,asset,bytes,extended.expiresAt);
    await jobs.revokeRunner(machine.credential.id,extended.expiresAt+1);
    await assert.rejects(jobs.saveAutomationAsset(machine.authority,next.lease,asset,bytes,extended.expiresAt+1),{code:"PERMISSION_DENIED"});
    const failed = (await jobs.getAutomationJob(first.app.id,first.job.id))!;
    assert.equal(failed.state,"failed"); assert.equal(failed.code,"RUNNER_REVOKED");
    assert.equal((await jobs.listAutomationAttempts(first.app.id,first.job.id))[0]!.outcome,"expired");
    assert.throws(()=>db.exec("DELETE FROM automation_attempts"));
    assert.throws(()=>db.exec("UPDATE automation_jobs SET state='queued'"));
  } finally {db.close();}
});

test("CI claim selection filters app and SHA before expiring or claiming any foreign job",async()=>{
  const {db,automation:jobs,first,second} = await setup();
  try {
    await jobs.enqueueAutomationJob(first.job); await jobs.enqueueAutomationJob(second.job);
    const machine = await runner(jobs,[first.app.id,second.app.id]);
    assert.equal(await jobs.claimAutomationJob(machine.authority,now,5000,{appId:second.app.id,commitSha:"b".repeat(40)}),null);
    assert.equal((await jobs.getAutomationJob(first.app.id,first.job.id))!.state,"queued");
    const selected = (await jobs.claimAutomationJob(machine.authority,now,5000,{appId:second.app.id,commitSha:second.job.commitSha}))!;
    assert.equal(selected.job.id,second.job.id);
    assert.equal((await jobs.getAutomationJob(first.app.id,first.job.id))!.state,"queued");
    assert.equal(await jobs.claimAutomationJob(machine.authority,selected.lease.expiresAt,5000,{appId:first.app.id,commitSha:"b".repeat(40)}),null);
    assert.equal((await jobs.getAutomationJob(second.app.id,second.job.id))!.state,"leased","Wrong scope must not expire another attempt");
    const next = (await jobs.claimAutomationJob(machine.authority,selected.lease.expiresAt,5000,{appId:first.app.id,commitSha:first.job.commitSha}))!;
    assert.equal(next.job.id,first.job.id);
    await assert.rejects(jobs.claimAutomationJob(machine.authority,now,5000,{appId:first.app.id,commitSha:"HEAD"}));
  } finally {db.close();}
});

test("cancellation denies further uploads and three expiry attempts terminally fail",async()=>{
  const {db,automation:jobs,first,second} = await setup();
  try {
    const machine = await runner(jobs,[first.app.id,second.app.id]); await jobs.enqueueAutomationJob(first.job);
    const claim = (await jobs.claimAutomationJob(machine.authority,now,5000))!;
    assert.equal((await jobs.cancelAutomationJob(first.app.id,first.job.id,now+1)).state,"cancel_requested");
    await assert.rejects(jobs.requireAutomationLease(machine.authority,claim.lease,now+1));
    assert.equal((await jobs.failAutomationJob(machine.authority,claim.lease,"CANCELLED",now+1)).state,"cancelled");
    await jobs.enqueueAutomationJob(second.job); let current = now+1;
    for (let i=0;i<3;i++) {
      const retry = (await jobs.claimAutomationJob(machine.authority,current,5000))!;
      current = retry.lease.expiresAt;
      assert.equal((await jobs.expireAutomationJob(second.app.id,second.job.id,current)).state,i===2?"failed":"queued");
    }
    assert.equal(await jobs.claimAutomationJob(machine.authority,current,5000),null);
    assert.equal((await jobs.getAutomationJob(second.app.id,second.job.id))!.code,"LEASE_EXPIRED");
    assert.equal((await jobs.listAutomationAttempts(second.app.id,second.job.id)).length,3);
  } finally {db.close();}
});

test("automatic push policy defaults off and matches only latest connection, installation and exact branch",async()=>{
  const {db,automation:jobs,store,first,second} = await setup();
  try {
    const initial = await jobs.getAutomationPolicy(first.app.id);
    assert.equal(initial.enabled,false); assert.equal(initial.version,0);
    const policy = await jobs.updateAutomationPolicy(first.app.id,{expectedVersion:0,enabled:true,channel:"preview",platform:"ios"},now);
    assert.equal(policy.version,1);
    await assert.rejects(jobs.updateAutomationPolicy(first.app.id,{expectedVersion:0,enabled:false,channel:"preview",platform:"ios"},now+1),{code:"CONFLICT"});
    assert.deepEqual((await jobs.findAutomationTargets({installationId:1,owner:"example",repository:"one",ref:"main"})).map(t=>t.appId),[first.app.id]);
    assert.equal((await jobs.findAutomationTargets({installationId:2,owner:"example",repository:"one",ref:"main"})).length,0);
    assert.equal((await jobs.findAutomationTargets({installationId:1,owner:"example",repository:"one",ref:"release"})).length,0);
    assert.equal((await jobs.getAutomationPolicy(second.app.id)).enabled,false);
    await store.operations!.saveGitHubConnection(first.app.id,{expectedVersion:1,installationId:1,owner:"example",repository:"one",ref:"release"},now+1);
    assert.equal((await jobs.findAutomationTargets({installationId:1,owner:"example",repository:"one",ref:"main"})).length,0);
    assert.equal((await jobs.findAutomationTargets({installationId:1,owner:"example",repository:"one",ref:"release"})).length,1);
    await jobs.updateAutomationPolicy(first.app.id,{expectedVersion:1,enabled:false,channel:"preview",platform:"ios"},now+2);
    assert.equal((await jobs.findAutomationTargets({installationId:1,owner:"example",repository:"one",ref:"release"})).length,0);
    assert.throws(()=>db.exec("DELETE FROM automation_policy_history"));
  } finally {db.close();}
});

async function publication(job: AutomationJob, lease: import("@app-ops/dogfood").AutomationLease, a: import("@app-ops/dogfood").OTAAsset, deploymentId="11111111-1111-4111-8111-111111111111") {
  const receipt = {jobId:job.id,attemptId:lease.attemptId,commitSha:job.commitSha,configDigest:job.configDigest,toolchainDigest:job.toolchainDigest,sourceArchiveDigest:"b".repeat(64),launchAssetId:a.id,assetIds:[],artifactDigest:"c".repeat(64)};
  const {artifactDigest:_digest,...exportReceipt} = receipt;
  receipt.artifactDigest=hash({receipt:exportReceipt,assets:[{id:a.id,digest:a.digest,hash:a.hash,key:a.key,contentType:a.contentType,fileExtension:a.fileExtension,size:a.size}]});
  const deployment = {id:deploymentId,appId:job.appId,createdAt:now,requestKey:job.id,detectionId:job.detectionId,commitSha:job.commitSha,channel:job.channel,runtimeVersion:job.runtimeVersion,platform:job.platform,launchAssetId:a.id,assetIds:[],launchAsset:a,assets:[]};
  return {deployment,receipt};
}

test("automation finalization atomically binds actual export, attempt assets and OTA deployment",async()=>{
  const {db,automation:jobs,store,first,second} = await setup();
  try {
    await jobs.enqueueAutomationJob(first.job); await jobs.enqueueAutomationJob(second.job);
    await jobs.enqueueAutomationJob({...first.job,id:"automation_other_stream",requestKey:"other_stream",channel:"production"});
    const machine = await runner(jobs,[first.app.id]);
    const claim = (await jobs.claimAutomationJob(machine.authority,now,5000))!;
    const bytes = new TextEncoder().encode("real-bundle"), a = await prepareOTAAsset(first.app.id,{key:"actual_expo_key",contentType:"application/javascript",fileExtension:".js"},bytes,now);
    const result = await publication(first.job,claim.lease,a);
    await store.operations!.saveOTAAsset(a,bytes);
    await assert.rejects(jobs.finalizeAutomationJob(machine.authority,claim.lease,result,now),{code:"INVALID_RELATION"});
    assert.equal((await store.operations!.listOTADeployments(first.app.id)).length,0);
    await jobs.saveAutomationAsset(machine.authority,claim.lease,a,bytes,now);
    await assert.rejects(jobs.finalizeAutomationJob(machine.authority,claim.lease,{...result,receipt:{...result.receipt,configDigest:"d".repeat(64)}},now),{code:"INVALID_RELATION"});
    await assert.rejects(jobs.finalizeAutomationJob(machine.authority,claim.lease,{...result,deployment:{...result.deployment,appId:second.app.id}},now),{code:"INVALID_RELATION"});
    await assert.rejects(jobs.finalizeAutomationJob(machine.authority,claim.lease,{...result,receipt:{...result.receipt,artifactDigest:"e".repeat(64)}},now),{code:"INVALID_RELATION"});
    db.exec("CREATE TRIGGER reject_automation_finish BEFORE INSERT ON automation_export_receipts BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END");
    await assert.rejects(jobs.finalizeAutomationJob(machine.authority,claim.lease,result,now),{code:"CONFLICT"});
    assert.equal((await store.operations!.listOTADeployments(first.app.id)).length,0);
    assert.equal((await jobs.getAutomationJob(first.app.id,first.job.id))!.state,"leased");
    assert.equal(await store.operations!.getPublishedOTAAsset(first.app.id,a.id),null);
    db.exec("DROP TRIGGER reject_automation_finish");
    const completed = await jobs.finalizeAutomationJob(machine.authority,claim.lease,result,now);
    assert.equal(completed.job.state,"succeeded"); assert.equal(completed.job.deploymentId,completed.deployment.id);
    assert.deepEqual(completed.job.receipt,result.receipt);
    assert.equal((await jobs.listAutomationAttempts(first.app.id,first.job.id))[0]!.outcome,"succeeded");
    assert.equal((await store.operations!.getPublishedOTAAsset(first.app.id,a.id))!.asset.id,a.id);
    assert.equal(db.prepare("SELECT count(*) n FROM automation_export_receipts").get()!.n,1);
    assert.throws(()=>db.exec("UPDATE automation_export_receipts SET data='{}'"));
    assert.throws(()=>db.exec("INSERT OR REPLACE INTO automation_attempts SELECT * FROM automation_attempts"));
  } finally {db.close();}
});

test("latest queued intent fences an older same-clock export after newer publication",async()=>{
  const {db,automation:jobs,store,first} = await setup();
  try {
    await jobs.enqueueAutomationJob(first.job);
    const newer = await jobs.enqueueAutomationJob({...first.job,id:"automation_newer",requestKey:"newer_intent"});
    const machine = await runner(jobs,[first.app.id]), olderClaim = (await jobs.claimAutomationJob(machine.authority,now,5000))!, newerClaim = (await jobs.claimAutomationJob(machine.authority,now,5000))!;
    assert.equal(olderClaim.job.id,first.job.id); assert.equal(newerClaim.job.id,newer.id);
    const bytes = new TextEncoder().encode("newer-bundle"), a = await prepareOTAAsset(first.app.id,{key:"bundle",contentType:"application/javascript",fileExtension:".js"},bytes,now);
    await jobs.saveAutomationAsset(machine.authority,olderClaim.lease,a,bytes,now); await jobs.saveAutomationAsset(machine.authority,newerClaim.lease,a,bytes,now);
    const latest = await jobs.finalizeAutomationJob(machine.authority,newerClaim.lease,await publication(newer,newerClaim.lease,a),now);
    await assert.rejects(jobs.finalizeAutomationJob(machine.authority,olderClaim.lease,await publication(first.job,olderClaim.lease,a,"22222222-2222-4222-8222-222222222222"),now),{code:"CONFIG_CONFLICT"});
    assert.deepEqual((await store.operations!.listOTADeployments(first.app.id)).map(d=>d.id),[latest.deployment.id]);
    assert.equal((await jobs.failAutomationJob(machine.authority,olderClaim.lease,"CONFIG_CHANGED",now)).code,"CONFIG_CHANGED");
  } finally {db.close();}
});

test("two actual connections claim one pinned automation job only once",{timeout:30000},async()=>{
  const directory = mkdtempSync(join(tmpdir(),"flora-automation-race-")), path = join(directory,"state.db");
  const {db,automation:jobs,first} = await setup(path);
  try {
    await jobs.enqueueAutomationJob(first.job); const machine = await runner(jobs,[first.app.id]), barrier = new SharedArrayBuffer(8), signal = new Int32Array(barrier);
    const code = `(async()=>{const {workerData,parentPort}=require('node:worker_threads');const api=await import(workerData.module);const db=api.openDatabase(workerData.path);const signal=new Int32Array(workerData.barrier);Atomics.add(signal,0,1);Atomics.notify(signal,0);Atomics.wait(signal,1,0,10000);try{const claim=await api.createSqliteDogfoodStore(db).automation.claimAutomationJob(workerData.authority,1000,5000);parentPort.postMessage({claim});}catch(error){parentPort.postMessage({error:error.code||'UNKNOWN'});}finally{db.close();}})();`;
    const workers = [0,1].map(()=>new Worker(code,{eval:true,workerData:{module:new URL("../dist/index.js",import.meta.url).href,path,barrier,authority:machine.authority}}));
    try {
      const results = workers.map(worker=>new Promise<{claim?:unknown;error?:string}>((resolve,reject)=>{worker.once("message",resolve);worker.once("error",reject);}));
      const limit = Date.now()+10000; while (Atomics.load(signal,0)<2 && Date.now()<limit) await new Promise(resolve=>setTimeout(resolve,1));
      assert.equal(Atomics.load(signal,0),2); Atomics.store(signal,1,1); Atomics.notify(signal,1,2);
      const receipts = await Promise.all(results); assert.ok(receipts.every(r=>!r.error)); assert.equal(receipts.filter(r=>r.claim).length,1);
      assert.equal((await jobs.listAutomationAttempts(first.app.id,first.job.id)).length,1);
      assert.deepEqual((await jobs.listAutomationEvents(first.app.id,first.job.id)).map(e=>e.kind),["queued","claimed"]);
    } finally {await Promise.all(workers.map(worker=>worker.terminate()));}
  } finally {db.close();rmSync(directory,{recursive:true,force:true});}
});

test("automation rejects unpinned digests and bounds active app jobs before any audit write",async()=>{
  const {db,automation:jobs,first} = await setup();
  try {
    await assert.rejects(jobs.enqueueAutomationJob({...first.job,configDigest:"f".repeat(64)}),{code:"INVALID_INPUT"});
    assert.equal((await jobs.listAutomationJobs(first.app.id)).length,0);
    const changedConfig = {...first.job.config,entryFile:"src/other.js"};
    await assert.rejects(jobs.enqueueAutomationJob({...first.job,config:changedConfig,configDigest:hash(changedConfig)}),{code:"CONFIG_CONFLICT"});
    for (let i=0;i<10;i++) await jobs.enqueueAutomationJob({...first.job,id:`automation_limit_${i}`,requestKey:`limit_request_${i}`});
    await assert.rejects(jobs.enqueueAutomationJob({...first.job,id:"automation_overflow",requestKey:"overflow_request"}),{code:"INPUT_TOO_LARGE"});
    assert.equal((await jobs.listAutomationJobs(first.app.id)).length,10);
    assert.equal(db.prepare("SELECT count(*) n FROM automation_events").get()!.n,10);
  } finally {db.close();}
});

test("heartbeat cannot prolong an attempt beyond its fixed twenty minute deadline",async()=>{
  const {db,automation:jobs,first} = await setup();
  try {
    await jobs.enqueueAutomationJob(first.job); const machine = await runner(jobs,[first.app.id]), claim = (await jobs.claimAutomationJob(machine.authority,now,120000))!;
    let lease = claim.lease;
    for (let elapsed=100000;elapsed<=1100000;elapsed+=100000) lease = await jobs.heartbeatAutomationJob(machine.authority,lease,now+elapsed,120000);
    lease = await jobs.heartbeatAutomationJob(machine.authority,lease,now+1190000,120000);
    assert.equal(lease.expiresAt,now+1200000);
    await assert.rejects(jobs.requireAutomationLease(machine.authority,{...lease,expiresAt:Number.MAX_SAFE_INTEGER},lease.expiresAt),{code:"LEASE_STALE"});
    assert.equal((await jobs.expireAutomationJob(first.app.id,first.job.id,lease.expiresAt)).state,"queued");
  } finally {db.close();}
});

test("cancelled newer intent still fences old work until an explicit new request supersedes it",async()=>{
  const {db,automation:jobs,store,first} = await setup();
  try {
    await jobs.enqueueAutomationJob(first.job);
    const newer=await jobs.enqueueAutomationJob({...first.job,id:"automation_cancelled_intent",requestKey:"cancelled_intent"});
    await jobs.cancelAutomationJob(first.app.id,newer.id,now);
    const machine=await runner(jobs,[first.app.id]), oldClaim=(await jobs.claimAutomationJob(machine.authority,now,5000))!;
    const bytes=new TextEncoder().encode("explicit-old-commit"), a=await prepareOTAAsset(first.app.id,{key:"bundle",contentType:"application/javascript",fileExtension:".js"},bytes,now);
    await jobs.saveAutomationAsset(machine.authority,oldClaim.lease,a,bytes,now);
    await assert.rejects(jobs.finalizeAutomationJob(machine.authority,oldClaim.lease,await publication(first.job,oldClaim.lease,a),now),{code:"CONFIG_CONFLICT"});
    assert.equal((await store.operations!.listOTADeployments(first.app.id)).length,0);
    await jobs.failAutomationJob(machine.authority,oldClaim.lease,"CONFIG_CHANGED",now);
    const explicit=await jobs.enqueueAutomationJob({...first.job,id:"automation_explicit_retry",requestKey:"explicit_retry"});
    const next=(await jobs.claimAutomationJob(machine.authority,now,5000))!; assert.equal(next.job.id,explicit.id);
    await jobs.saveAutomationAsset(machine.authority,next.lease,a,bytes,now);
    assert.equal((await jobs.finalizeAutomationJob(machine.authority,next.lease,await publication(explicit,next.lease,a),now)).job.state,"succeeded");
  } finally {db.close();}
});

test("automatic enqueue atomically checks the captured enabled policy while manual requests remain available",async()=>{
  const {db,automation:jobs,first} = await setup();
  try {
    const enabled=await jobs.updateAutomationPolicy(first.app.id,{expectedVersion:0,enabled:true,channel:"preview",platform:"ios"},now);
    await jobs.updateAutomationPolicy(first.app.id,{expectedVersion:enabled.version,enabled:false,channel:"preview",platform:"ios"},now+1);
    await assert.rejects(jobs.enqueueAutomationJob(first.job,enabled.version),{code:"CONFIG_CONFLICT"});
    assert.equal((await jobs.listAutomationJobs(first.app.id)).length,0);
    assert.equal(db.prepare("SELECT count(*) n FROM automation_events").get()!.n,0);
    const wrongTarget=await jobs.updateAutomationPolicy(first.app.id,{expectedVersion:2,enabled:true,channel:"preview",platform:"android"},now+2);
    await assert.rejects(jobs.enqueueAutomationJob(first.job,wrongTarget.version),{code:"CONFIG_CONFLICT"});
    const current=await jobs.updateAutomationPolicy(first.app.id,{expectedVersion:wrongTarget.version,enabled:true,channel:"preview",platform:"ios"},now+2);
    await assert.rejects(jobs.enqueueAutomationJob({...first.job,channel:"production"},current.version),{code:"CONFIG_CONFLICT"});
    const queued=await jobs.enqueueAutomationJob(first.job,current.version);
    await jobs.updateAutomationPolicy(first.app.id,{expectedVersion:current.version,enabled:false,channel:"preview",platform:"ios"},now+3);
    assert.deepEqual(await jobs.enqueueAutomationJob({...first.job,id:"automation_hook_retry"},current.version),queued);
    const manual=await jobs.enqueueAutomationJob({...first.job,id:"automation_manual",requestKey:"manual_request"});
    assert.equal(manual.id,"automation_manual");
  } finally {db.close();}
});
