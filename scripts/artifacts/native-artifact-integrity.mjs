import { createHash, timingSafeEqual } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PLATFORMS = new Set(["android", "ios"]);
const MAX_BYTES = 2 * 1024 * 1024 * 1024;

export function validateArtifactMetadata({ manifest, expected, byteCount }) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
    || !expected || typeof expected !== "object" || Array.isArray(expected))
    throw new Error("ARTIFACT_CONTEXT_INVALID");
  for (const key of ["appId", "jobId", "repository", "sourceSha", "platform"]) {
    if (typeof manifest[key] !== "string" || manifest[key] !== expected[key])
      throw new Error("ARTIFACT_SCOPE_MISMATCH");
  }
  if (!ID.test(manifest.appId) || !ID.test(manifest.jobId)
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(manifest.repository)
    || !SHA.test(manifest.sourceSha) || !PLATFORMS.has(manifest.platform))
    throw new Error("ARTIFACT_IDENTITY_INVALID");
  if (!Number.isSafeInteger(byteCount) || byteCount <= 0 || byteCount > MAX_BYTES)
    throw new Error("ARTIFACT_SIZE_INVALID");
  if (!Number.isSafeInteger(manifest.byteCount) || manifest.byteCount !== byteCount)
    throw new Error("ARTIFACT_SIZE_MISMATCH");
  if (typeof manifest.sha256 !== "string" || !SHA256.test(manifest.sha256))
    throw new Error("ARTIFACT_DIGEST_INVALID");
}

// Digest alone proves byte integrity, not signature or installation.
export function verifyNativeArtifact({ bytes, manifest, expected }) {
  if (!Buffer.isBuffer(bytes)) throw new Error("ARTIFACT_SIZE_INVALID");
  validateArtifactMetadata({ manifest, expected, byteCount: bytes.length });
  if (!timingSafeEqual(createHash("sha256").update(bytes).digest(), Buffer.from(manifest.sha256, "hex")))
    throw new Error("ARTIFACT_HASH_MISMATCH");
  return Object.freeze({
    appId: manifest.appId, jobId: manifest.jobId,
    repository: manifest.repository, sourceSha: manifest.sourceSha,
    platform: manifest.platform, byteCount: bytes.length,
    sha256: manifest.sha256, integrityVerified: true,
    signatureVerified: false, installVerified: false,
  });
}
