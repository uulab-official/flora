import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, link, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { verifyNativeArtifactFile } from "./native-artifact-file.mjs";

const scope = { appId: "app-a", jobId: "build-1", repository: "owner/private-app", sourceSha: "c".repeat(40), platform: "android" };
test("file integrity: authentic bytes and app/job binding, no signing claim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flora-artifact-"));
  try {
    const filePath = join(dir, "preview.apk"), bytes = Buffer.from("synthetic unsigned APK fixture");
    await writeFile(filePath, bytes);
    const manifest = { ...scope, byteCount: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    const verify = (m = manifest, e = scope, p = filePath) => verifyNativeArtifactFile({ filePath: p, manifest: m, expected: e });
    const result = await verify();
    assert.equal(result.integrityVerified, true);
    assert.equal(result.signatureVerified, false);
    assert.equal(result.installVerified, false);
    for (const key of ["appId", "jobId", "repository", "sourceSha", "platform"])
      await assert.rejects(verify(manifest, { ...scope, [key]: "untrusted" }), /ARTIFACT_SCOPE_MISMATCH/);
    await assert.rejects(verify({ ...manifest, byteCount: bytes.length + 1 }), /ARTIFACT_SIZE_MISMATCH/);
    await assert.rejects(verify({ ...manifest, sha256: "q".repeat(64) }), /ARTIFACT_DIGEST_INVALID/);
    await assert.rejects(verify({ ...manifest, sha256: "0".repeat(64) }), /ARTIFACT_HASH_MISMATCH/);
    const shortcut = join(dir, "link.apk"); await symlink(filePath, shortcut);
    await assert.rejects(verify(manifest, scope, shortcut), /ARTIFACT_NOT_REGULAR_FILE/);
    const hard = join(dir, "hard.apk"); await link(filePath, hard);
    await assert.rejects(verify(manifest, scope, hard), /ARTIFACT_NOT_REGULAR_FILE/);
    const linkedDir = join(dir, "linked"); await symlink(dir, linkedDir);
    await assert.rejects(verify(manifest, scope, join(linkedDir, "preview.apk")), /ARTIFACT_PARENT_SYMLINK/);
    await writeFile(filePath, Buffer.from("tampered content"));
    await assert.rejects(verify(), /ARTIFACT_SIZE_MISMATCH|ARTIFACT_HASH_MISMATCH/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("file integrity: paths and absent context fail closed", async () => {
  await assert.rejects(verifyNativeArtifactFile({ filePath: "../relative.apk", manifest: {}, expected: scope }), /ARTIFACT_PATH_INVALID/);
});
