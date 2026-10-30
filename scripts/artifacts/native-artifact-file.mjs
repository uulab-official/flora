import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { verifyNativeArtifact } from "./native-artifact-integrity.mjs";

const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

// Verify a local build output without copying up to 2 GiB into memory.
// A symlink is never a valid artifact; the file descriptor is checked again
// after hashing to catch replacements or mutation during reading.
export async function verifyNativeArtifactFile({ filePath, manifest, expected }) {
  if (typeof filePath !== "string" || !filePath || !filePath.startsWith("/"))
    throw new Error("ARTIFACT_PATH_INVALID");
  const path = resolve(filePath);
  const parent = await realpath(dirname(path));
  if (parent !== dirname(path)) throw new Error("ARTIFACT_PARENT_SYMLINK");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error("ARTIFACT_NOT_REGULAR_FILE");
  if (stat.size <= 0 || stat.size > MAX_BYTES) throw new Error("ARTIFACT_SIZE_INVALID");
  if (!manifest || typeof manifest !== "object" || !expected || typeof expected !== "object")
    throw new Error("ARTIFACT_CONTEXT_INVALID");
  // Reuse the same immutable scope/format validation, including byteCount,
  // without allocating a potentially giant Buffer.
  if (stat.size !== manifest.byteCount) throw new Error("ARTIFACT_SIZE_MISMATCH");
  if (!SHA256.test(manifest.sha256 ?? "")) throw new Error("ARTIFACT_DIGEST_INVALID");
  const marker = Buffer.from([1]);
  const dummyManifest = { ...manifest, byteCount: 1, sha256: createHash("sha256").update(marker).digest("hex") };
  verifyNativeArtifact({ bytes: marker, manifest: dummyManifest, expected });
  const fd = await open(path, "r");
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.nlink !== 1 || before.ino !== stat.ino || before.dev !== stat.dev || before.size !== stat.size)
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
      || after.ino !== before.ino || after.dev !== before.dev)
      throw new Error("ARTIFACT_CHANGED_DURING_CHECK");
    if (!timingSafeEqual(hash.digest(), Buffer.from(manifest.sha256, "hex")))
      throw new Error("ARTIFACT_HASH_MISMATCH");
    return Object.freeze({ appId: manifest.appId, jobId: manifest.jobId,
      repository: manifest.repository, sourceSha: manifest.sourceSha, platform: manifest.platform,
      byteCount: total, sha256: manifest.sha256, integrityVerified: true,
      signatureVerified: false, installVerified: false, fileName: basename(path) });
  } finally { await fd.close(); }
}
