import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, link, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { verifyNativeArtifactFile } from "./native-artifact-file.mjs";

const scope = { appId: "app-a", jobId: "build-1", repository: "owner/private-app", sourceSha: "c".repeat(40), platform: "android" };
test("artifact file: verifies bytes, scope and does not claim signing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flora-artifact-"));
  try {
    const filePath = join(dir, "preview.apk"), bytes = Buffer.from("synthetic unsigned APK fixture");
    await writeFile(filePath, bytes);
    const manifest = { ...scope, byteCount: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    const result = await verifyNativeArtifactFile({ filePath, manifest, expected: scope });
    assert.equal(result.integrityVerified, true); assert.equal(result.signatureVerified, false);
    assert.equal(result.installVerified, false);
    await assert.rejects(verifyNativeArtifactFile({ filePath, manifest, expected: { ...scope, appId: "other" } }), /ARTIFACT_SCOPE_MISMATCH/);
    await writeFile(filePath, Buffer.from("tampered content same byte count"));
    await assert.rejects(verifyNativeArtifactFile({ filePath, manifest, expected: scope }), /ARTIFACT_SIZE_MISMATCH|ARTIFACT_HASH_MISMATCH/);
    const shortcut = join(dir, "link.apk"); await symlink(filePath, shortcut);
    await assert.rejects(verifyNativeArtifactFile({ filePath: shortcut, manifest, expected: scope }), /ARTIFACT_NOT_REGULAR_FILE/);
    const hard = join(dir, "hard.apk"); await link(filePath, hard);
    await assert.rejects(verifyNativeArtifactFile({ filePath: hard, manifest, expected: scope }), /ARTIFACT_NOT_REGULAR_FILE/);
    const linkedDir = join(dir, "linked"); await symlink(dir, linkedDir);
    await assert.rejects(verifyNativeArtifactFile({ filePath: join(linkedDir, "preview.apk"), manifest, expected: scope }), /ARTIFACT_PARENT_SYMLINK/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
