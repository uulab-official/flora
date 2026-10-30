import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyNativeArtifact } from "./native-artifact-integrity.mjs";

const bytes = Buffer.from("synthetic unsigned binary fixture");
const expected = { appId: "app-a", jobId: "job-a", repository: "owner/private-app", sourceSha: "a".repeat(40), platform: "android" };
const manifest = { ...expected, byteCount: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
const check = (override = {}, expectedOverride = expected, input = bytes) =>
  verifyNativeArtifact({ bytes: input, manifest: { ...manifest, ...override }, expected: expectedOverride });

test("valid bytes preserve scope, but do not attest signature or install", () => {
  const result = check();
  assert.equal(result.integrityVerified, true);
  assert.equal(result.signatureVerified, false);
  assert.equal(result.installVerified, false);
});
test("cross-app and cross-job manifests fail closed", () => {
  for (const key of ["appId", "jobId", "repository", "sourceSha", "platform"])
    assert.throws(() => check({ [key]: key === "platform" ? "ios" : "other" }), /ARTIFACT_SCOPE_MISMATCH/);
});
test("wrong job expectation fails even with same bytes and hash", () => {
  assert.throws(() => check({}, { ...expected, appId: "app-b" }), /ARTIFACT_SCOPE_MISMATCH/);
});
test("corruption, forged byte count, and malformed digest rejected", () => {
  assert.throws(() => check({}, expected, Buffer.from("changed")), /ARTIFACT_SIZE_MISMATCH/);
  assert.throws(() => check({ byteCount: bytes.length + 1 }), /ARTIFACT_SIZE_MISMATCH/);
  assert.throws(() => check({ sha256: "x".repeat(64) }), /ARTIFACT_DIGEST_INVALID/);
  assert.throws(() => check({ sha256: "0".repeat(64) }), /ARTIFACT_HASH_MISMATCH/);
});
test("empty artifact and unsupported platform rejected", () => {
  assert.throws(() => check({}, expected, Buffer.alloc(0)), /ARTIFACT_SIZE_INVALID/);
  assert.throws(() => check({ platform: "web" }, { ...expected, platform: "web" }), /ARTIFACT_IDENTITY_INVALID/);
});
