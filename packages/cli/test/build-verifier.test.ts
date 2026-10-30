import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  parseBuildVerifyOptions, verifyDownloadedBuild,
} from "../dist/build-verifier.js";

const repo = "uulab-official/private-application";
const sha = "a".repeat(40);
function sha256(data: Buffer) { return createHash("sha256").update(data).digest("hex"); }
function fixture(t: test.TestContext, platform: "android"|"ios" = "android") {
  const directory=mkdtempSync(join(tmpdir(),"flora-build-proof-"));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const artifact=platform === "ios" ? "app.ipa" : "app.apk";
  const payload=Buffer.from("synthetic-native-binary-no-private-data");
  writeFileSync(join(directory,artifact),payload);
  const receipt={
    schemaVersion:1,source:"github-actions-caller",
    repository:repo,commitSha:sha,runId:"123456",runAttempt:"1",
    platform,profile:"preview",signingVerified:false,
    files:[{name:artifact,sha256:sha256(payload)}],
  };
  const path=join(directory,"flora-build-receipt.json");
  const save=()=>writeFileSync(path,JSON.stringify(receipt));
  save();
  return {directory,artifact,payload,receipt,save,path};
}
const options=(dir:string)=>({directory:dir,repository:repo,commitSha:sha,runId:"123456"});

test("offline verifier accepts a matching Android APK receipt, but does not assert provenance or signing",async t=>{
  const f=fixture(t);
  const result=await verifyDownloadedBuild(options(f.directory));
  assert.equal(result.status,"integrity_verified");
  assert.equal(result.repository,repo);
  assert.equal(result.commitSha,sha);
  assert.equal(result.artifactCount,1);
  assert.equal(result.byteLength,f.payload.length);
  assert.equal(result.provenanceAttested,false);
  assert.equal(result.signatureVerified,false);
  assert.deepEqual(result.files,[{name:f.artifact,sha256:sha256(f.payload)}]);
});

test("ios IPA and Android AAB are allowed only for their own platform",async t=>{
  const ios=fixture(t,"ios");
  assert.equal((await verifyDownloadedBuild(options(ios.directory))).platform,"ios");
  ios.receipt.platform="android";
  ios.save();
  await assert.rejects(verifyDownloadedBuild(options(ios.directory)),/BUILD_RECEIPT_INVALID/);
  const android=fixture(t);
  rmSync(join(android.directory,android.artifact));
  android.artifact="release.aab";
  writeFileSync(join(android.directory,android.artifact),android.payload);
  android.receipt.files=[{name:android.artifact,sha256:sha256(android.payload)}];
  android.save();
  assert.equal((await verifyDownloadedBuild(options(android.directory))).platform,"android");
});

test("caller repository, commit and optional run ID are mandatory source bindings",async t=>{
  const f=fixture(t);
  for(const mismatch of [
    {...options(f.directory),repository:"uulab-official/other-app"},
    {...options(f.directory),commitSha:"b".repeat(40)},
    {...options(f.directory),runId:"999"},
  ]) await assert.rejects(verifyDownloadedBuild(mismatch),/BUILD_RECEIPT_INVALID/);
  await assert.rejects(verifyDownloadedBuild({...options(f.directory),repository:"../owner"}),/BUILD_VERIFY_USAGE/);
});

test("tamper, extra file, missing native binary and fake signing claims fail closed",async t=>{
  const f=fixture(t);
  writeFileSync(join(f.directory,f.artifact),Buffer.from("modified-untrusted-file"));
  await assert.rejects(verifyDownloadedBuild(options(f.directory)),/BUILD_ARTIFACT_HASH_MISMATCH/);
  writeFileSync(join(f.directory,f.artifact),f.payload);
  writeFileSync(join(f.directory,"something.txt"),"ignored file");
  await assert.rejects(verifyDownloadedBuild(options(f.directory)),/BUILD_ARTIFACT_SET_INVALID/);
  rmSync(join(f.directory,"something.txt"));
  f.receipt.signingVerified=true;
  f.save();
  await assert.rejects(verifyDownloadedBuild(options(f.directory)),/BUILD_RECEIPT_INVALID/);
  f.receipt.signingVerified=false;
  f.save();
  rmSync(join(f.directory,f.artifact));
  await assert.rejects(verifyDownloadedBuild(options(f.directory)),/BUILD_ARTIFACT_SET_INVALID/);
});

test("rejects malformed metadata, duplicate names, directory traversal and receipt size limit",async t=>{
  const f=fixture(t);
  f.receipt.files[0]!.name="../private.apk";
  f.save();
  await assert.rejects(verifyDownloadedBuild(options(f.directory)),/BUILD_RECEIPT_INVALID/);
  f.receipt.files[0]!.name=f.artifact;
  f.receipt.files.push({...f.receipt.files[0]!});
  f.save();
  await assert.rejects(verifyDownloadedBuild(options(f.directory)),/BUILD_RECEIPT_INVALID/);
  f.receipt.files.pop();
  const broken={...f.receipt,accessToken:"never-log"};
  writeFileSync(f.path,JSON.stringify(broken));
  await assert.rejects(verifyDownloadedBuild(options(f.directory)),/BUILD_RECEIPT_INVALID/);
  writeFileSync(f.path," ".repeat(65537));
  await assert.rejects(verifyDownloadedBuild(options(f.directory)),/BUILD_RECEIPT_INVALID/);
  writeFileSync(f.path,"{BAD JSON");
  await assert.rejects(verifyDownloadedBuild(options(f.directory)),/BUILD_RECEIPT_INVALID/);
});

test("local symlinks, hardlinks and unexpected file types cannot count as trusted artifacts",async t=>{
  if(process.platform === "win32") return;
  const f=fixture(t);
  const original=join(f.directory,f.artifact);
  const alternate=join(f.directory,"alternate.apk");
  rmSync(original);
  writeFileSync(alternate,f.payload);
  symlinkSync(alternate,original);
  await assert.rejects(verifyDownloadedBuild(options(f.directory)),/BUILD_ARTIFACT_SET_INVALID/);
  rmSync(original);rmSync(alternate);
  writeFileSync(original,f.payload);
  const another=join(tmpdir(),"flora-verified-binary-hardlink-"+process.pid);
  try{
    linkSync(original,another);
    await assert.rejects(verifyDownloadedBuild(options(f.directory)),/BUILD_ARTIFACT_INVALID/);
  }finally{rmSync(another,{force:true});}
});

test("strict flag parser rejects missing or ambiguous input without reading arbitrary paths",()=>{
  const valid=["verify","--dir","/tmp/absolute-artifact","--repository",repo,"--commit",sha];
  assert.equal(parseBuildVerifyOptions(valid).repository,repo);
  assert.deepEqual(parseBuildVerifyOptions([...valid,"--run-id","123"]).runId,"123");
  for(const args of [
    [], ["verify"], [...valid,"--dir","/tmp/other"], [...valid,"--run-id","x"], [...valid,"--run-id"],
    [...valid,"--extra","hi"], ["verify","--dir","relative","--repository",repo,"--commit",sha],
    ["verify","--dir","/tmp/abs","--repository","not a repo","--commit",sha],
    ["verify","--dir","/tmp/abs","--repository",repo,"--commit","not-sha"],
  ]) assert.throws(()=>parseBuildVerifyOptions(args),/BUILD_VERIFY_USAGE/);
});

test("CLI exposes bounded JSON with offline verification only; never prints private input",async t=>{
  const f=fixture(t);
  // The CLI binary is compiled by the workspace build before Node tests run.
  const result=spawnSync(process.execPath,[fileURLToPath(new URL("../dist/main.js",import.meta.url)),
    "builds","verify","--dir",f.directory,"--repository",repo,"--commit",sha,
  ],{encoding:"utf8",timeout:15000});
  assert.equal(result.status,0,result.stderr);
  const json=JSON.parse(result.stdout);
  assert.equal(json.status,"integrity_verified");
  assert.equal(json.signatureVerified,false);
  assert.ok(!result.stdout.includes(f.directory));
  const bad=spawnSync(process.execPath,[new URL("../dist/main.js",import.meta.url).pathname,
    "builds","verify","--dir",f.directory,"--repository","wrongrepo","--commit",sha,
  ],{encoding:"utf8",timeout:15000});
  assert.equal(bad.status,2);
  assert.equal(JSON.parse(bad.stderr).error,"BUILD_VERIFY_USAGE");
});
