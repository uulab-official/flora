import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { publishLocalArtifact, resolveLocalArtifact } from "./local-artifact-store.mjs";

const job = { appId: "app-one", jobId: "build-1", repository: "owner/private", sourceSha: "b".repeat(40), platform: "android" };
test("isolated local artifact publish and subsequent download verification", async () => {
 const dir = await mkdtemp(join(tmpdir(),"flora-local-store-"));
 try {
  const sourcePath=join(dir,"preview.apk"), root=join(dir,"private-store"), bytes=Buffer.from("synthetic APK for integrity only");
  await writeFile(sourcePath,bytes);
  const manifest={...job,byteCount:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};
  const receipt=await publishLocalArtifact({root,sourcePath,manifest,authorizedJob:job});
  assert.equal(receipt.storage,"local-only");
  assert.deepEqual(await readFile(receipt.filePath),bytes);
  const resolved=await resolveLocalArtifact({root,receipt,authorizedJob:job});
  assert.equal(resolved.integrityVerified,true);
  assert.equal(resolved.signatureVerified,false);
  await assert.rejects(resolveLocalArtifact({root,receipt,authorizedJob:{...job,appId:"another-app"}}),/ARTIFACT_SCOPE_MISMATCH/);
  await writeFile(receipt.filePath, Buffer.from("tampered local stored binary"));
  await assert.rejects(resolveLocalArtifact({root,receipt,authorizedJob:job}),/ARTIFACT_SIZE_MISMATCH|ARTIFACT_HASH_MISMATCH/);
 } finally { await rm(dir,{recursive:true,force:true}); }
});
