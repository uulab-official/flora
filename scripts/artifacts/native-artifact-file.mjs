import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { validateArtifactMetadata } from "./native-artifact-integrity.mjs";

const MAX_BYTES = 2 * 1024 * 1024 * 1024;

// Verify a user-owned, isolated artifact directory before attempting upload.
// Does not authorize access, produce a download URL, or validate code signing.
export async function verifyNativeArtifactFile({ filePath, manifest, expected }) {
  if (typeof filePath !== "string" || !isAbsolute(filePath) || filePath.includes("\0"))
    throw new Error("ARTIFACT_PATH_INVALID");
  const path = resolve(filePath);
  const parent = dirname(path);
  if (await realpath(parent) !== parent) throw new Error("ARTIFACT_PARENT_SYMLINK");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error("ARTIFACT_NOT_REGULAR_FILE");
  if (stat.size <= 0 || stat.size > MAX_BYTES) throw new Error("ARTIFACT_SIZE_INVALID");
  validateArtifactMetadata({ manifest, expected, byteCount: stat.size });
  // O_NOFOLLOW stops a final-component symlink swap between lstat and open.
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.nlink !== 1 || before.ino !== stat.ino
      || before.dev !== stat.dev || before.size !== stat.size
      || before.mtimeNs !== stat.mtimeNs || before.ctimeNs !== stat.ctimeNs)
      throw new Error("ARTIFACT_CHANGED_DURING_CHECK");
    const hash = createHash("sha256");
    let total = 0;
    for await (const chunk of fd.createReadStream({ autoClose: false })) {
      total += chunk.length;
      if (total > MAX_BYTES) throw new Error("ARTIFACT_SIZE_INVALID");
      hash.update(chunk);
    }
    const after = await fd.stat();
    if (total !== stat.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || after.ino !== before.ino || after.dev !== before.dev
      || after.nlink !== 1)
      throw new Error("ARTIFACT_CHANGED_DURING_CHECK");
    if (!timingSafeEqual(hash.digest(), Buffer.from(manifest.sha256, "hex")))
      throw new Error("ARTIFACT_HASH_MISMATCH");
    return Object.freeze({ appId: manifest.appId, jobId: manifest.jobId,
      repository: manifest.repository, sourceSha: manifest.sourceSha, platform: manifest.platform,
      byteCount: total, sha256: manifest.sha256, integrityVerified: true,
      signatureVerified: false, installVerified: false, fileName: basename(path) });
  } finally { await fd.close(); }
}
