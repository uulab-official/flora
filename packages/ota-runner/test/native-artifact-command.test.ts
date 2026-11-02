import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { parseNativeCommand, runNativeCommand, nativeCommandFailure, NATIVE_USAGE } from "../dist/native-command.js";
import { listNativeArtifacts, inspectNativeArtifact, exportNativeArtifact } from "../dist/native-artifact-access.js";

const config = {appId: "app_fixture", platform: "android" as const, origin: "https://must-not-call.invalid", token: "DO_NOT_CREATE_HTTP_CLIENT"};
const unreachable = async (): Promise<never> => {throw new Error("EXECUTION_MUST_NOT_RUN");};
const empty = {state: "native_artifacts" as const, appId: config.appId, platform: config.platform, storePresent: false, records: [], issues: [], scannedEntries: 0, pendingEntries: 0, interruptedDirectories: 0, unrecognizedEntries: 0, truncated: false, snapshotChanged: false, recoveryRequired: false, remoteRechecked: false as const};

test("artifact modes are explicit single-config commands; output is mandatory only for export", () => {
  assert.deepEqual(parseNativeCommand(["--config","/c","--artifacts"]), {mode:"artifacts",paths:["/c"]});
  assert.deepEqual(parseNativeCommand(["--inspect","native_job_one.apk","--config","/c"]), {mode:"inspect",paths:["/c"],fileName:"native_job_one.apk"});
  assert.deepEqual(parseNativeCommand(["--config","/c","--output","/export/result.apk","--export","native_job_one.apk"]), {mode:"export",paths:["/c"],fileName:"native_job_one.apk",output:"/export/result.apk"});
  for (const args of [
    ["--config","/c","--export","native_job_one.apk"],
    ["--config","/c","--artifacts","--output","/out.apk"],
    ["--config","/c","--inspect","../PRIVATE.apk"],
    ["--config","/c","--export","native_job_one.apk","--output","relative.apk"],
    ["--config","/c","--export","native_job_one.apk","--output","/out.apk","--output","/second.apk"],
    ["--config","/c","--export","native_job_one.apk","--output","/out.ipa"],
    ["--config","/c","--artifacts","--daemon"],
    ["--config","/c","--config","/d","--artifacts"],
  ]) assert.throws(() => parseNativeCommand(args), /^Error: INVALID_NATIVE_CONFIG$/);
  assert.match(NATIVE_USAGE, /--artifacts/); assert.match(NATIVE_USAGE, /--inspect/); assert.match(NATIVE_USAGE, /--export/);
});
test("offline catalogue bypasses execution recovery gate and never constructs an HTTP client", async () => {
  let calls = 0;
  const result = await runNativeCommand(["--config","/c","--artifacts"], {readConfig:async()=>config,checkRecovery:unreachable,runJob:unreachable,runDaemon:unreachable,
    artifacts:{list:async()=>{calls++;return empty;},inspect:unreachable,export:unreachable}});
  assert.deepEqual(result, empty); assert.equal(calls, 1);
});
test("artifact command rejects an unavailable adapter instead of running a job", async () => {
  await assert.rejects(runNativeCommand(["--config","/c","--artifacts"], {readConfig:async()=>config,checkRecovery:unreachable,runJob:unreachable,runDaemon:unreachable}), /INVALID_NATIVE_CONFIG/);
});
test("late catalogue results are discarded after shutdown without leaking arbitrary reasons", async () => {
  const stop = new AbortController();
  await assert.rejects(runNativeCommand(["--config","/c","--artifacts"], {readConfig:async()=>config,checkRecovery:unreachable,runJob:unreachable,runDaemon:unreachable,
    artifacts:{list:async(_config,signal)=>{assert.ok(signal);stop.abort("PRIVATE");return empty;},inspect:unreachable,export:unreachable}}, stop.signal), /^Error: NATIVE_CANCELLED$/);
});
test("post-publication export uncertainty is not hidden by simultaneous operator stop", () => {
  const stop = new AbortController(); stop.abort();
  assert.deepEqual(nativeCommandFailure(new Error("NATIVE_EXPORT_UNCONFIRMED"),stop.signal), {state:"attention",code:"NATIVE_EXPORT_UNCONFIRMED",exitCode:1});
  for(const code of ["NATIVE_EXPORT_EXISTS","NATIVE_ARTIFACT_HASH_MISMATCH","NATIVE_ARTIFACT_UNCONFIRMED","NATIVE_ARTIFACT_PLATFORM_UNSUPPORTED"]) assert.equal(nativeCommandFailure(new Error(code)).code,code);
  assert.equal(nativeCommandFailure(new Error("NATIVE_ARTIFACT_PRIVATE_SECRET")).code,"NATIVE_BUILD_FAILED");
});
test("real command catalogue, inspection and export preserve pending files and make zero HTTP requests", {skip: process.platform === "win32", timeout: 10000}, async t => {
  const root=await realpath(await mkdtemp(join(tmpdir(),"flora-artifact-command-")));await chmod(root,0o700);t.after(()=>rm(root,{recursive:true,force:true}));
  let requests=0;const server=createServer((req,res)=>{requests++;req.resume();res.end("{}");});await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  const store=join(root,"artifacts"),out=join(root,"out"),fileName="native_job_one.apk",bytes=Buffer.from("synthetic bytes");await mkdir(store,{mode:0o700});await mkdir(out,{mode:0o700});await mkdir(join(store,".pending"),{mode:0o700});await writeFile(join(store,".pending","private-marker"),"SECRET_UNCONFIRMED");
  const cfg={...config,origin:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,artifactDirectory:store,expectedCertificateSha256:"b".repeat(64)};
  await writeFile(join(store,fileName),bytes,{mode:0o600});await writeFile(join(store,fileName+".receipt.json"),JSON.stringify({appId:cfg.appId,platform:"android",jobId:"native_job_one",fileName,commitSha:"a".repeat(40),sha256:createHash("sha256").update(bytes).digest("hex"),byteLength:bytes.length,signerFingerprint:cfg.expectedCertificateSha256,appIdentifier:"test.app",completionConfirmed:true}),{mode:0o600});
  const deps={readConfig:async()=>cfg,checkRecovery:unreachable,runJob:unreachable,runDaemon:unreachable,artifacts:{list:listNativeArtifacts,inspect:inspectNativeArtifact,export:exportNativeArtifact}};
  const catalogue=await runNativeCommand<typeof cfg>(["--config","/c","--artifacts"],deps);assert.equal(catalogue.state,"native_artifacts");assert.ok("recoveryRequired"in catalogue&&catalogue.recoveryRequired);
  const inspected=await runNativeCommand<typeof cfg>(["--config","/c","--inspect",fileName],deps);assert.equal(inspected.state,"native_artifact_inspected");
  const exported=await runNativeCommand<typeof cfg>(["--config","/c","--export",fileName,"--output",join(out,"result.apk")],deps);assert.equal(exported.state,"native_artifact_exported");
  assert.deepEqual(await readFile(join(out,"result.apk")),bytes);assert.equal(await readFile(join(store,".pending","private-marker"),"utf8"),"SECRET_UNCONFIRMED");assert.equal(requests,0);
});
