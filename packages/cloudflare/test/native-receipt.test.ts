import test from "node:test";
import assert from "node:assert/strict";
import { createNativePublicReceipt } from "../public/native-artifact-receipt.js";
const appId="sample_app";
const build={
  appId, id:"native_job_sample", commitSha:"a".repeat(40), state:"succeeded",
  platform:"android", artifactVerification:"runner_reported" as const,
  artifact:{
    fileName:"sample-release.aab", sha256:"b".repeat(64),
    byteLength:123456,appIdentifier:"co.example.sample",
    platform:"android" as const,signerFingerprint:"c".repeat(64),
  },
};
test("authenticated native success receipt exports only fixed allowlisted public metadata",()=>{
  const receipt=createNativePublicReceipt(appId, {...build,
    bearerToken:"private", privateKey:"secret", lease:{ runnerId:"secret" },
  });
  assert.ok(receipt);
  const result=JSON.parse(receipt);
  assert.deepEqual(Object.keys(result).sort(),[
    "appId","artifact","artifactVerification","commitSha","jobId","schemaVersion","source","state"].sort());
  assert.deepEqual(Object.keys(result.artifact).sort(),[
    "fileName","sha256","byteLength","appIdentifier","platform","signerFingerprint"].sort());
  assert.equal(result.artifactVerification,"runner_reported");
  assert.equal(result.source,"flora-native-runner-report");
  assert.equal(result.state,"succeeded");
  assert.doesNotMatch(receipt,/private|bearer|token|credentials|certificate|password|secret/i);
});
test("any foreign app, incomplete receipt or unsafe platform filename fails closed",()=>{
  assert.equal(createNativePublicReceipt("another_app",build),null);
  assert.equal(createNativePublicReceipt(appId,{...build,appId:"another_app"}),null);
  assert.equal(createNativePublicReceipt(appId,{...build,state:"queued"}),null);
  assert.equal(createNativePublicReceipt(appId,{...build,artifactVerification:null}),null);
  assert.equal(createNativePublicReceipt(appId,{...build,commitSha:"bad"}),null);
  assert.equal(createNativePublicReceipt(appId,{...build,artifact:{...build.artifact,fileName:"../secret.aab"}}),null);
  assert.equal(createNativePublicReceipt(appId,{...build,artifact:{...build.artifact,platform:"ios" as const}}),null);
  assert.equal(createNativePublicReceipt(appId,{...build,artifact:{...build.artifact,byteLength:0}}),null);
  assert.equal(createNativePublicReceipt(appId,{...build,artifact:{...build.artifact,sha256:"bad"}}),null);
});
test("iOS reports optional public Team ID but never accepts it for Android",()=>{
  const ios={...build,platform:"ios",artifact:{...build.artifact,platform:"ios" as const,fileName:"sample.ipa",teamId:"ABCDE12345"}};
  const receipt=createNativePublicReceipt(appId,ios);
  assert.ok(receipt);
  assert.equal(JSON.parse(receipt).artifact.teamId,"ABCDE12345");
  assert.equal(createNativePublicReceipt(appId,{...build,artifact:{...build.artifact,teamId:"ABCDE12345"}}),null);
});
