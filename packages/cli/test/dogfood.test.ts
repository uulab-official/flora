import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runCli } from "@app-ops/cli";
import * as dbapi from "@app-ops/db";
import { bundleBytes, replaceSourceFile, syntheticSourceBundle, syntheticBaseline } from "../../../tests/dogfood-fixtures.ts";

async function fixture(t: TestContext, run: (root: string) => Promise<void>) {
  const mask = process.umask(), root = await fs.mkdtemp(join(await fs.realpath(os.tmpdir()), "flora-cli-"));
  t.mock.method(os, "homedir", () => root);
  try { await run(root); }
  finally { process.umask(mask); await fs.rm(root, { recursive: true, force: true }); }
}
async function cli(args: string[]) {
  let stdout = "", stderr = "";
  const code = await runCli(["dogfood", ...args], {
    stdout: value => { stdout += value; }, stderr: value => { stderr += value; },
    readFile: async () => { throw new Error("Dogfood must not use the legacy reader"); },
  });
  return { code, stdout, stderr };
}
async function source(root: string) {
  const file = join(root, "source.json"); await fs.writeFile(file, bundleBytes(syntheticSourceBundle()));
  const result = await cli(["import-source", "--file", file]); assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout) as { snapshotId: string; digest: string };
}
function dbPath(root: string) { return join(root, ".flora", "dogfood", "state.db"); }

test("dogfood help lists the supported workflow without opening storage", async t => {
  await fixture(t, async root => {
    for (const args of [[], ["--help"]]) {
      const result = await cli(args); assert.equal(result.code, 0); assert.equal(result.stderr, "");
      for (const command of ["serve", "import-source", "import-baseline", "status"]) assert.ok(result.stdout.includes(command));
    }
    assert.deepEqual(await fs.readdir(root), []);
  });
});

test("dogfood rejects malformed flags and bare UUID snapshot identifiers before I/O", async t => {
  await fixture(t, async root => {
    for (const args of [
      ["status"], ["status", "--json", "--unknown"], ["status", "--json", "--json"],
      ["import-source"], ["import-source", "--file", "a", "--file", "b"], ["import-source", "--file", "a", "--db", ""],
      ["import-baseline", "--snapshot", randomUUID(), "--file", "a"],
      ["serve", "--port", "-1"], ["serve", "--port", "65536"], ["serve", "--port", "1.5"], ["serve", "--host", "0.0.0.0"],
    ]) {
      const result = await cli(args); assert.equal(result.code, 2, JSON.stringify(args));
      assert.match(result.stderr, /^USAGE_ERROR\n/); assert.equal(result.stdout, "");
    }
    assert.deepEqual(await fs.readdir(root), []);
  });
});

test("dogfood CLI imports a valid source larger than one MiB using its dedicated reader", async t => {
  await fixture(t, async root => {
    const file = join(root, "synthetic source 경로.json");
    const bytes = bundleBytes(replaceSourceFile(syntheticSourceBundle(), "src/core/config/runtime.ts", "//" + "x".repeat(900_000) + "\n"));
    assert.ok(bytes.length > 1024 * 1024 && bytes.length < 2 * 1024 * 1024);
    await fs.writeFile(file, bytes);
    const imported = await cli(["import-source", "--file", file]); assert.equal(imported.code, 0, imported.stderr);
    const receipt = JSON.parse(imported.stdout);
    assert.match(receipt.snapshotId, /^inventory_[0-9a-f-]{36}$/); assert.match(receipt.digest, /^[0-9a-f]{64}$/);
    assert.equal(receipt.evidenceOrigin, "operator-import");
    assert.equal(receipt.connection, "one-shot-source-snapshot");
    assert.deepEqual(await fs.readFile(file), Buffer.from(bytes));
    const db = dbapi.openDatabase(dbPath(root));
    try { assert.equal(dbapi.listInventory(db).length, 1); }
    finally { db.close(); }
  });
});

test("oversize and malformed source input fail before creating private storage", async t => {
  await fixture(t, async root => {
    const file = join(root, "synthetic-private-input.json");
    await fs.writeFile(file, Buffer.alloc(2 * 1024 * 1024 + 1));
    for (const args of [["import-source", "--file", file], ["import-baseline", "--file", file, "--snapshot", "inventory_" + randomUUID()]]) {
      const result = await cli(args); assert.equal(result.code, 1);
      assert.equal(result.stderr, '{"error":"INPUT_TOO_LARGE"}\n'); assert.equal(result.stdout, "");
      await assert.rejects(fs.lstat(join(root, ".flora")), { code: "ENOENT" });
    }
    for (const value of ['{"private-synthetic-content":true}', '{"broken-private-synthetic-content"']) {
      await fs.writeFile(file, value); const result = await cli(["import-source", "--file", file]);
      assert.equal(result.code, 1); assert.ok(!result.stderr.includes("private-synthetic-content"));
      await assert.rejects(fs.lstat(join(root, ".flora")), { code: "ENOENT" });
    }
  });
});

test("oversize imports leave an existing SQLite database byte-identical", async t => {
  await fixture(t, async root => {
    const receipt = await source(root), before = await fs.readFile(dbPath(root)), file = join(root, "large.json");
    await fs.writeFile(file, Buffer.alloc(2 * 1024 * 1024 + 1));
    for (const args of [["import-source", "--file", file], ["import-baseline", "--snapshot", receipt.snapshotId, "--file", file]]) {
      assert.equal((await cli(args)).stderr, '{"error":"INPUT_TOO_LARGE"}\n');
      assert.deepEqual(await fs.readFile(dbPath(root)), before);
    }
  });
});

test("CLI source and baseline imports preserve opaque IDs and imported evidence through reopen", async t => {
  await fixture(t, async root => {
    const receipt = await source(root), db = dbapi.openDatabase(dbPath(root));
    const snapshot = dbapi.getInventory(db, receipt.snapshotId)!; db.close();
    const file = join(root, "baseline.json"); await fs.writeFile(file, bundleBytes(syntheticBaseline(snapshot)));
    const imported = await cli(["import-baseline", "--snapshot", receipt.snapshotId, "--file", file]);
    assert.equal(imported.code, 0, imported.stderr);
    const verification = JSON.parse(imported.stdout);
    assert.match(verification.verificationId, /^verification_[0-9a-f-]{36}$/);
    assert.equal(verification.state, "passed"); assert.equal(verification.evidenceKind, "development-baseline");
    assert.equal(verification.evidenceOrigin, "operator-import");
    assert.equal(verification.assessment.files, 2); assert.equal(verification.assessment.tests, 4);
    const status = await cli(["status", "--json"]); assert.equal(status.code, 0, status.stderr);
    const state = JSON.parse(status.stdout);
    assert.equal(state.selectedSnapshotId, receipt.snapshotId); assert.equal(state.freshness, "freshness_unknown");
    assert.equal(state.history[0].id, verification.verificationId); assert.equal(state.history[0].evidenceOrigin, "operator-import");
    assert.equal(state.providers.length, 1); assert.equal(state.providers[0].providerId, "unconfigured-isolated-runner");
    assert.ok(Object.values(state.providers[0].checks).every(value => value === "unknown"));
    assert.ok(!status.stdout.includes("bootstrapUrl"));
  });
});

test("CLI imports and status never acquire ownership or recover a live running attempt", async t => {
  await fixture(t, async root => {
    const receipt = await source(root), db = dbapi.openDatabase(dbPath(root)), now = Date.now();
    const record = dbapi.createVerification(db, { snapshotId: receipt.snapshotId, requestKey: "live", now }).record;
    dbapi.beginVerification(db, { recordId: record.id, attemptId: "live", runnerId: "synthetic", now, leaseMs: 30_000 });
    const before = dbapi.getVerification(db, record.id), owner = { nonce: randomUUID(), pid: process.pid, host: os.hostname() };
    dbapi.acquireDashboardOwner(db, owner);
    const ownerBefore = db.prepare("SELECT * FROM dashboard_server_owner").get();
    const file = join(root, "baseline.json"); await fs.writeFile(file, bundleBytes(syntheticBaseline(dbapi.getInventory(db, receipt.snapshotId)!)));
    try {
      for (const args of [["status", "--json"], ["import-source", "--file", join(root, "source.json")], ["import-baseline", "--snapshot", receipt.snapshotId, "--file", file]]) {
        const result = await cli(args); assert.equal(result.code, 0, result.stderr);
        assert.ok(!result.stdout.includes(owner.nonce));
        assert.deepEqual(dbapi.getVerification(db, record.id), before);
        assert.deepEqual(db.prepare("SELECT * FROM dashboard_server_owner").get(), ownerBefore);
      }
    } finally { db.close(); }
  });
});

test("unsafe store errors contain the code only", { skip: process.platform === "win32" }, async t => {
  await fixture(t, async root => {
    const unsafe = join(root, "unsafe-store"); await fs.mkdir(unsafe, { mode: 0o755 }); await fs.chmod(unsafe, 0o755);
    const result = await cli(["status", "--db", join(unsafe, "state.db"), "--json"]);
    assert.equal(result.code, 1); assert.equal(result.stderr, '{"error":"PRIVATE_STORE_UNSAFE"}\n');
    assert.equal(result.stdout, ""); assert.deepEqual(await fs.readdir(unsafe), []);
  });
});

test("the copyable first-use script imports only clearly synthetic examples", async t => {
  await fixture(t, async root => {
    const source = JSON.parse(await fs.readFile(new URL("../../../examples/dogfood-source.synthetic.json", import.meta.url), "utf8"));
    assert.equal(source.repository.fullName, "example/synthetic-app");
    const { runDogfoodDemo } = await import("../../../scripts/dogfood-demo.mjs");
    const result = await runDogfoodDemo();
    assert.equal(result.mode, "synthetic-dogfood-demo");
    assert.equal(result.baselineState, "passed");
    assert.equal(result.files, 2); assert.equal(result.tests, 4);
    assert.equal(result.evidenceOrigin, "operator-import");
    assert.equal(result.isolatedExecution, "not_run");
    await assert.rejects(fs.lstat(dbPath(root)), { code: "ENOENT" });
    const db = dbapi.openDatabase(join(root, ".flora", "dogfood", "demo.db"));
    try { assert.equal(dbapi.listInventory(db).length, 1); }
    finally { db.close(); }
    const realFile = join(root, "separate-synthetic-app.json");
    const second = { ...syntheticSourceBundle(), repository: { id: "another_synthetic_repo", fullName: "example/another-app", visibility: "private" } };
    await fs.writeFile(realFile, bundleBytes(second));
    const imported = await cli(["import-source", "--file", realFile]);
    assert.equal(imported.code, 0, imported.stderr);
    const realStore = dbapi.openDatabase(dbPath(root));
    try { assert.equal(dbapi.listInventory(realStore)[0]!.repository.id, "another_synthetic_repo"); }
    finally { realStore.close(); }
  });
});

test("CLI registers apps, scopes imports/status and updates settings optimistically", async t => {
  await fixture(t, async root => {
    const registration = join(root,"registration.json"), settings = join(root,"settings.json"), sourceFile = join(root,"source.json");
    const registered = [];
    for (const [name,repositoryId] of [["First","repo_synthetic"],["Second","repo_two"]]) {
      await fs.writeFile(registration,JSON.stringify({ name,repositoryId,rootDirectory:"apps/sample" }));
      const receipt = await cli(["register-app","--file",registration]); assert.equal(receipt.code,0,receipt.stderr);
      const app = JSON.parse(receipt.stdout); assert.match(app.id,/^app_/); registered.push(app);
    }
    const [first,second] = registered;
    await fs.writeFile(settings,JSON.stringify({ expectedVersion:0,values:{ API_BASE:"https://one.example" } }));
    const updated = await cli(["settings","--app",first.id,"--file",settings]); assert.equal(updated.code,0,updated.stderr);
    assert.equal(JSON.parse(updated.stdout).settings.version,1);
    assert.equal((await cli(["settings","--app",first.id,"--file",settings])).stderr,'{"error":"CONFLICT"}\n');
    await fs.writeFile(sourceFile,bundleBytes(syntheticSourceBundle()));
    const wrong = await cli(["import-source","--app",second.id,"--file",sourceFile]); assert.equal(wrong.code,1);
    const imported = await cli(["import-source","--app",first.id,"--file",sourceFile]); assert.equal(imported.code,0,imported.stderr);
    assert.equal(JSON.parse(imported.stdout).appId,first.id);
    const firstState = await cli(["status","--app",first.id,"--json"]), secondState = await cli(["status","--app",second.id,"--json"]);
    assert.equal(firstState.code,0,firstState.stderr); assert.equal(secondState.code,0,secondState.stderr);
    assert.equal(JSON.parse(firstState.stdout).snapshots.length,1); assert.equal(JSON.parse(secondState.stdout).snapshots.length,0);
    assert.deepEqual(JSON.parse(secondState.stdout).selectedApplication.settings.values,{});
    const db = dbapi.openDatabase(dbPath(root)); const snapshot = dbapi.getInventory(db,JSON.parse(imported.stdout).snapshotId)!; db.close();
    const baseline = join(root,"baseline.json"); await fs.writeFile(baseline,bundleBytes(syntheticBaseline(snapshot)));
    assert.equal((await cli(["import-baseline","--app",second.id,"--snapshot",snapshot.id,"--file",baseline])).code,1);
    const baselineReceipt = await cli(["import-baseline","--app",first.id,"--snapshot",snapshot.id,"--file",baseline]);
    assert.equal(baselineReceipt.code,0,baselineReceipt.stderr); assert.equal(JSON.parse(baselineReceipt.stdout).appId,first.id);
    await fs.writeFile(registration,JSON.stringify({ name:"Renamed",repositoryId:"repo_synthetic",rootDirectory:"apps/sample" }));
    assert.equal((await cli(["register-app","--file",registration])).stderr,'{"error":"CONFLICT"}\n');
  });
});

test("CLI registration/settings validate bounded input before creating private storage", async t => {
  await fixture(t,async root => {
    const file = join(root,"input.json");
    for (const [name,input] of [["register-app",'{"name":"bad","repositoryId":"repo","rootDirectory":"../escape"}'],["register-app","{"],["settings",'{"expectedVersion":0,"values":{"secret":"private-value"}}'],["settings",'{"values":{}}']]) {
      await fs.writeFile(file,input!);
      const result = await cli([name!,"--file",file,...(name === "settings" ? ["--app","app_example"] : [])]);
      assert.equal(result.code,1,result.stderr); assert.equal(result.stderr,'{"error":"INVALID_INPUT"}\n');
      await assert.rejects(fs.lstat(join(root,".flora")),{code:"ENOENT"});
    }
    await fs.writeFile(file,Buffer.alloc(2*1024*1024+1));
    assert.equal((await cli(["register-app","--file",file])).stderr,'{"error":"INPUT_TOO_LARGE"}\n');
    for (const args of [["settings","--file",file],["register-app"],["status","--app","INVALID","--json"]]) {
      assert.equal((await cli(args)).code,2);
      await assert.rejects(fs.lstat(join(root,".flora")),{code:"ENOENT"});
    }
  });
});

test("CLI operations upload and publish app-scoped immutable OTA content",async t => {
  await fixture(t,async root => {
    await source(root); const db = dbapi.openDatabase(dbPath(root)), store = dbapi.createSqliteDogfoodStore(db), app = (await store.applications!.getApplicationForSnapshot(dbapi.listInventory(db)[0]!.id))!;
    const connection = await store.operations!.saveGitHubConnection(app.id,{ expectedVersion:0,installationId:1,owner:"example",repository:"one",ref:"main" },Date.now());
    const detection = await store.operations!.saveGitHubDetection({ id:"github_cli",appId:app.id,connection,rootDirectory:app.rootDirectory,commitSha:"a".repeat(40),framework:"expo",expoVersion:"57",reactNativeVersion:null,configSource:"app.json",runtimeVersion:"1",platforms:["ios"],updatesEnabled:true,updatesUrl:"https://updates.example/updates/"+app.id,reasons:[],detectedAt:Date.now() }); db.close();
    const file = join(root,"bundle.js"); await fs.writeFile(file,"//"+"x".repeat(2*1024*1024+1));
    const upload = await cli(["ota-upload","--app",app.id,"--file",file,"--key","expo_bundle_key","--content-type","application/javascript","--file-extension",".js"]);
    assert.equal(upload.code,0,upload.stderr); const asset = JSON.parse(upload.stdout); assert.equal(asset.key,"expo_bundle_key");
    const operations = await cli(["operations","--app",app.id,"--json"]); assert.equal(operations.code,0,operations.stderr);
    assert.equal(JSON.parse(operations.stdout).assets.length,1); assert.equal(JSON.parse(operations.stdout).deployments.length,0);
    const publication = join(root,"publication.json"); await fs.writeFile(publication,JSON.stringify({ requestKey:"cli_publication",detectionId:detection.id,commitSha:detection.commitSha,channel:"preview",runtimeVersion:"1",platform:"ios",launchAssetId:asset.id,assetIds:[] }));
    const previousOrigin = process.env.FLORA_OTA_ORIGIN; process.env.FLORA_OTA_ORIGIN="https://updates.example";
    try {
      const result = await cli(["ota-publish","--app",app.id,"--file",publication]); assert.equal(result.code,0,result.stderr);
      const published = JSON.parse(result.stdout); assert.equal(published.appId,app.id);
      const retry = await cli(["ota-publish","--app",app.id,"--file",publication]); assert.equal(retry.code,0,retry.stderr); assert.equal(JSON.parse(retry.stdout).id,published.id);
    } finally { if (previousOrigin === undefined) delete process.env.FLORA_OTA_ORIGIN; else process.env.FLORA_OTA_ORIGIN=previousOrigin; }
  });
});

test("CLI operations reject invalid metadata, oversized binaries and missing provider configuration before storage",async t => {
  await fixture(t,async root => {
    const file = join(root,"input.json"); await fs.writeFile(file,"{}");
    for (const args of [
      ["github-connect","--app","app_example","--file",file],
      ["ota-publish","--app","app_example","--file",file],
      ["ota-upload","--app","app_example","--file",file,"--key","unsafe.key","--file-extension",".js","--content-type","application/javascript"],
    ]) {
      const result = await cli(args); assert.equal(result.code,1,result.stderr); assert.equal(result.stderr,'{"error":"INVALID_INPUT"}\n');
      await assert.rejects(fs.lstat(join(root,".flora")),{code:"ENOENT"});
    }
    const binary = join(root,"too-large.js"); await fs.writeFile(binary,Buffer.alloc(16*1024*1024+1));
    const oversized = await cli(["ota-upload","--app","app_example","--file",binary,"--key","bundle","--file-extension",".js","--content-type","application/javascript"]);
    assert.equal(oversized.stderr,'{"error":"INPUT_TOO_LARGE"}\n');
    if (process.platform !== "win32") {
      const symlink = join(root,"linked.js"); await fs.symlink(file,symlink);
      const linked = await cli(["ota-upload","--app","app_example","--file",symlink,"--key","bundle","--file-extension",".js","--content-type","application/javascript"]);
      assert.equal(linked.stderr,'{"error":"INVALID_INPUT"}\n');
    }
    await fs.writeFile(file,JSON.stringify({expectedVersion:0,installationId:1,owner:"example",repository:"one",ref:"main"}));
    const before = { appId:process.env.FLORA_GITHUB_APP_ID,privateKey:process.env.FLORA_GITHUB_PRIVATE_KEY };
    delete process.env.FLORA_GITHUB_APP_ID; delete process.env.FLORA_GITHUB_PRIVATE_KEY;
    try {
      const unconfigured = await cli(["github-connect","--app","app_example","--file",file]);
      assert.equal(unconfigured.stderr,'{"error":"PROVIDER_UNCONFIGURED"}\n');
      await assert.rejects(fs.lstat(join(root,".flora")),{code:"ENOENT"});
    } finally {
      if (before.appId !== undefined) process.env.FLORA_GITHUB_APP_ID=before.appId;
      if (before.privateKey !== undefined) process.env.FLORA_GITHUB_PRIVATE_KEY=before.privateKey;
    }
  });
});

test("CLI automation enrolls scoped machines, queues immutable configs and manages policy/cancellation",async t=>{
  await fixture(t,async root=>{
    await source(root); const db=dbapi.openDatabase(dbPath(root)), store=dbapi.createSqliteDogfoodStore(db), app=(await store.applications!.getApplicationForSnapshot(dbapi.listInventory(db)[0]!.id))!;
    const connection=await store.operations!.saveGitHubConnection(app.id,{expectedVersion:0,installationId:1,owner:"example",repository:"automation",ref:"main"},Date.now());
    const config={schemaVersion:1,bundler:"expo",entryFile:"src/index.js",toolchain:{nodeVersion:"24.19.0",packageManager:{name:"pnpm",version:"11.19.0"}},runtimeVersion:"1",platforms:["ios"],updatesUrl:`https://updates.example/updates/${app.id}`};
    const detection=await store.operations!.saveGitHubDetection({id:"github_cli_automation",appId:app.id,connection,rootDirectory:app.rootDirectory,commitSha:"a".repeat(40),framework:"expo",expoVersion:"57",reactNativeVersion:null,configSource:"resolved-export",runtimeVersion:"1",platforms:["ios"],updatesEnabled:true,updatesUrl:config.updatesUrl,reasons:[],detectedAt:Date.now(),automationConfig:config as import("@app-ops/dogfood").AutomationConfigSnapshot}); db.close();
    const enrollment=join(root,"runner.json"), queue=join(root,"job.json"), policy=join(root,"policy.json");
    await fs.writeFile(enrollment,JSON.stringify({name:"CLI machine",appIds:[app.id]}));
    const input={requestKey:"cli_automation",detectionId:detection.id,channel:"preview",runtimeVersion:"1",platform:"ios",config};
    await fs.writeFile(queue,JSON.stringify(input)); await fs.writeFile(policy,JSON.stringify({expectedVersion:0,enabled:true,channel:"preview",platform:"ios"}));
    const previous=process.env.FLORA_OTA_ORIGIN; process.env.FLORA_OTA_ORIGIN="https://updates.example";
    try {
      const enrolled=await cli(["runner-enroll","--file",enrollment]); assert.equal(enrolled.code,0,enrolled.stderr); const machine=JSON.parse(enrolled.stdout);
      assert.match(machine.token,/^runner_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/);
      assert.ok(!(await fs.readFile(dbPath(root))).includes(Buffer.from(machine.token)));
      const queued=await cli(["automation-queue","--app",app.id,"--file",queue]); assert.equal(queued.code,0,queued.stderr); const job=JSON.parse(queued.stdout);
      const duplicate=await cli(["automation-queue","--app",app.id,"--file",queue]); assert.equal(duplicate.code,0,duplicate.stderr); assert.equal(JSON.parse(duplicate.stdout).id,job.id);
      await fs.writeFile(queue,JSON.stringify({...input,requestKey:"changed_config",config:{...config,entryFile:"src/other.js"}}));
      assert.equal((await cli(["automation-queue","--app",app.id,"--file",queue])).stderr,'{"error":"CONFIG_CONFLICT"}\n');
      const updated=await cli(["automation-policy","--app",app.id,"--file",policy]); assert.equal(updated.code,0,updated.stderr); assert.equal(JSON.parse(updated.stdout).version,1);
      assert.equal((await cli(["automation-policy","--app",app.id,"--file",policy])).stderr,'{"error":"CONFLICT"}\n');
      const state=await cli(["automation","--app",app.id,"--json"]); assert.equal(state.code,0,state.stderr); assert.equal(JSON.parse(state.stdout).jobs.length,1); assert.equal(JSON.parse(state.stdout).runners.length,1); assert.ok(!state.stdout.includes(machine.token));
      const cancelled=await cli(["automation-cancel","--app",app.id,"--job",job.id]); assert.equal(cancelled.code,0,cancelled.stderr); assert.equal(JSON.parse(cancelled.stdout).state,"cancelled");
      const revoked=await cli(["runner-revoke","--runner",machine.runner.id]); assert.equal(revoked.code,0,revoked.stderr); assert.ok(JSON.parse(revoked.stdout).revokedAt!==null);
    } finally {if(previous===undefined) delete process.env.FLORA_OTA_ORIGIN; else process.env.FLORA_OTA_ORIGIN=previous;}
  });
});

test("CLI automation validates parsers and explicit origin before private storage",async t=>{
  await fixture(t,async root=>{
    const file=join(root,"invalid.json"); await fs.writeFile(file,"{}");
    for(const name of ["runner-enroll","automation-queue","automation-policy"]) {
      const result=await cli([name,"--file",file,...(name==="runner-enroll"?[]:["--app","app_example"])]);
      assert.equal(result.stderr,'{"error":"INVALID_INPUT"}\n'); await assert.rejects(fs.lstat(join(root,".flora")),{code:"ENOENT"});
    }
    for(const args of [["runner-revoke","--runner","invalid/runner"],["automation-cancel","--app","app_example","--job","invalid/job"],["automation"],["runner-enroll"]]) assert.equal((await cli(args)).code,2);
    const previous=process.env.FLORA_OTA_ORIGIN; delete process.env.FLORA_OTA_ORIGIN;
    try {
      const result=await cli(["automation","--app","app_example","--json"]); assert.equal(result.stderr,'{"error":"PROVIDER_UNCONFIGURED"}\n'); await assert.rejects(fs.lstat(join(root,".flora")),{code:"ENOENT"});
    } finally {if(previous!==undefined) process.env.FLORA_OTA_ORIGIN=previous;}
  });
});
