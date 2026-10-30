import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createNativePublicReceipt } from "../../cloudflare/public/native-artifact-receipt.js";
import { parseNativeVerifyOptions, verifyLocalNativeArtifact } from "../dist/native-artifact-verifier.js";

const appId="mobile_app", commitSha="b".repeat(40);
const digest=(input:Buffer)=>createHash("sha256").update(input).digest("hex");
function fixture(t:test.TestContext,platform:"android"|"ios"="android") {
  const directory=mkdtempSync(join(tmpdir(),"flora-native-proof-"));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const fileName=platform==="ios"?"mobile.ipa":"mobile.apk";
  const body=Buffer.from("synthetic native binary bytes: no private source or tokens");
  writeFileSync(join(directory,fileName),body);
  const job={
    id:"native_job_one",appId,commitSha,state:"succeeded",platform,
    artifactVerification:"runner_reported",
    artifact:{
      fileName,sha256:digest(body),byteLength:body.byteLength,
      appIdentifier:"co.uulab.mobile",platform,signerFingerprint:"a".repeat(64),
      ...(platform==="ios"?{teamId:"ABCDE12345"}:{}),
    },
  };
  const receiptPath=join(directory,"flora-native-build-receipt.json");
  const save=()=>{
    const receipt=createNativePublicReceipt(appId,job);
    assert.equal(typeof receipt,"string");
    writeFileSync(receiptPath,receipt!);
  };
  save();
  const options={directory,appId,commitSha};
  return {directory,fileName,receiptPath,body,job,save,options};
}
test("self-hosted Native Runner receipt is byte-bound and never claims platform signature verification",async t=>{
  const f=fixture(t);
  const report=await verifyLocalNativeArtifact(f.options);
  assert.equal(report.status,"bytes_match_runner_report");
  assert.equal(report.appId,appId);
  assert.equal(report.commitSha,commitSha);
  assert.equal(report.fileName,"mobile.apk");
  assert.equal(report.sha256,digest(f.body));
  assert.equal(report.byteLength,f.body.byteLength);
  assert.equal(report.runnerReported,true);
  assert.equal(report.provenanceAttested,false);
  assert.equal(report.signatureVerified,false);
  const raw=readFileSync(f.receiptPath,"utf8");
  assert.ok(!/tokenHash|password|keyMaterial|privateKey|lease|token/.test(raw));
  assert.equal(Object.keys(JSON.parse(raw).artifact).length,6);
});
test("iOS IPA receipts include only public Team ID and verify under platform constraints",async t=>{
  const f=fixture(t,"ios");
  assert.equal((await verifyLocalNativeArtifact(f.options)).platform,"ios");
  const receipt=JSON.parse(readFileSync(f.receiptPath,"utf8"));
  assert.equal(receipt.artifact.teamId,"ABCDE12345");
  receipt.artifact.platform="android";
  writeFileSync(f.receiptPath,JSON.stringify(receipt));
  await assert.rejects(verifyLocalNativeArtifact(f.options),/NATIVE_RECEIPT_INVALID/);
});
test("invalid or foreign native job never exports a receipt, including unsanitized private fields",async t=>{
  const f=fixture(t);
  const job=f.job;
  assert.equal(createNativePublicReceipt("another_app",job),null);
  assert.equal(createNativePublicReceipt(appId,{...job,appId:"another_app"}),null);
  assert.equal(createNativePublicReceipt(appId,{...job,state:"failed"}),null);
  assert.equal(createNativePublicReceipt(appId,{...job,artifactVerification:null}),null);
  assert.equal(createNativePublicReceipt(appId,{...job,artifact:{...job.artifact,fileName:"../secret.apk"}}),null);
  assert.equal(createNativePublicReceipt(appId,{...job,artifact:{...job.artifact,platform:"ios"}}),null);
  const publicBody=JSON.parse(createNativePublicReceipt(appId,{...job,token:"private-token",credentials:[{privateKey:"never-send"}]})!);
  assert.equal("token" in publicBody,false);assert.equal("credentials" in publicBody,false);
  assert.equal("token" in publicBody.artifact,false);
});
test("tampered bytes, source commit, app id, missing/extra artifact, and forged signing claims fail closed",async t=>{
  const f=fixture(t);
  writeFileSync(join(f.directory,f.fileName),Buffer.from("some altered bytes but equally untrusted"));
  await assert.rejects(verifyLocalNativeArtifact(f.options),/NATIVE_ARTIFACT_INVALID|NATIVE_ARTIFACT_HASH_MISMATCH/);
  writeFileSync(join(f.directory,f.fileName),f.body);
  await assert.rejects(verifyLocalNativeArtifact({...f.options,appId:"another_app"}),/NATIVE_RECEIPT_INVALID/);
  await assert.rejects(verifyLocalNativeArtifact({...f.options,commitSha:"a".repeat(40)}),/NATIVE_RECEIPT_INVALID/);
  writeFileSync(join(f.directory,"extra.txt"),"junk");
  await assert.rejects(verifyLocalNativeArtifact(f.options),/NATIVE_ARTIFACT_SET_INVALID/);
  rmSync(join(f.directory,"extra.txt"));
  const data=JSON.parse(readFileSync(f.receiptPath,"utf8"));
  data.signatureVerified=true;
  writeFileSync(f.receiptPath,JSON.stringify(data));
  await assert.rejects(verifyLocalNativeArtifact(f.options),/NATIVE_RECEIPT_INVALID/);
  f.save();
  data.artifact.fileName="../other.apk";
  writeFileSync(f.receiptPath,JSON.stringify(data));
  await assert.rejects(verifyLocalNativeArtifact(f.options),/NATIVE_RECEIPT_INVALID/);
});
test("symlinks and hardlinks cannot pass private native artifact verification",async t=>{
  if (process.platform==="win32") return;
  const f=fixture(t);
  const file=join(f.directory,f.fileName);
  rmSync(file);
  const outside=join(tmpdir(),"flora-native-outside-"+process.pid+".apk");
  writeFileSync(outside,f.body);
  try{
    symlinkSync(outside,file);
    await assert.rejects(verifyLocalNativeArtifact(f.options),/NATIVE_ARTIFACT_INVALID/);
    rmSync(file);
    linkSync(outside,file);
    await assert.rejects(verifyLocalNativeArtifact(f.options),/NATIVE_ARTIFACT_INVALID/);
  }finally{rmSync(outside,{force:true});}
});
test("CLI native verification is local-only and validates exact absolute-directory flags",async t=>{
  const f=fixture(t),valid=["verify-native","--dir",f.directory,"--app-id",appId,"--commit",commitSha];
  assert.deepEqual(parseNativeVerifyOptions(valid),f.options);
  for(const invalid of [
    ["verify-native","--dir","relative","--app-id",appId,"--commit",commitSha],
    [...valid,"--dir",f.directory],["verify-native","--dir",f.directory,"--app-id","../fake","--commit",commitSha],
    ["verify-native","--dir",f.directory,"--app-id",appId,"--commit","invalid"],
    ["verify-native","--dir",f.directory,"--app-id",appId,"--commit"],
  ])assert.throws(()=>parseNativeVerifyOptions(invalid),/BUILD_VERIFY_USAGE/);
  const cmd=fileURLToPath(new URL("../dist/main.js",import.meta.url));
  const res=spawnSync(process.execPath,[cmd,"builds",...valid],{encoding:"utf8",timeout:12000});
  assert.equal(res.status,0,res.stderr);
  const report=JSON.parse(res.stdout);
  assert.equal(report.status,"bytes_match_runner_report");
  assert.equal(report.signatureVerified,false);
  assert.equal(res.stdout.includes(f.directory),false);
  const rejected=spawnSync(process.execPath,[cmd,"builds","verify-native","--dir",f.directory,
    "--app-id","../bad","--commit",commitSha],{encoding:"utf8",timeout:12000});
  assert.equal(rejected.status,2);
  assert.equal(JSON.parse(rejected.stderr).error,"BUILD_VERIFY_USAGE");
});
