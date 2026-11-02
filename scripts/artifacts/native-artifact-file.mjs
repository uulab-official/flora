import { createHash, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { validateArtifactMetadata } from './native-artifact-integrity.mjs';

const MAX_BYTES = 2 * 1024 * 1024 * 1024;
function unchanged(a, b) {
  return b.isFile() && b.nlink === 1n && ['ino', 'dev', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
}
// Trusted internal callback only: the descriptor is closed on every exit path.
// This is an integrity check, not authorization, signing verification or a sandbox.
export async function withVerifiedNativeArtifact({ filePath, manifest, expected }, consume) {
  if (typeof filePath !== 'string' || !isAbsolute(filePath) || filePath.includes('\0')) throw new Error('ARTIFACT_PATH_INVALID');
  const byteCount = manifest?.byteCount;
  validateArtifactMetadata({ manifest, expected, byteCount });
  // Snapshot before any asynchronous IO; later caller mutations cannot alter the contract.
  const metadata = Object.freeze(Object.fromEntries(['appId', 'jobId', 'repository', 'sourceSha', 'platform', 'byteCount', 'sha256']
    .map(key => [key, manifest[key]])));
  const path = resolve(filePath), parent = dirname(path);
  if (await realpath(parent) !== parent) throw new Error('ARTIFACT_PARENT_SYMLINK');
  const initial = await lstat(path, { bigint: true });
  if (!initial.isFile() || initial.nlink !== 1n) throw new Error('ARTIFACT_NOT_REGULAR_FILE');
  if (initial.size <= 0n || initial.size > BigInt(MAX_BYTES)) throw new Error('ARTIFACT_SIZE_INVALID');
  if (initial.size !== BigInt(metadata.byteCount)) throw new Error('ARTIFACT_SIZE_MISMATCH');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!unchanged(initial, before)) throw new Error('ARTIFACT_CHANGED_DURING_CHECK');
    const buffer = Buffer.allocUnsafe(256 * 1024), hash = createHash('sha256'); let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      if (position > metadata.byteCount) throw new Error('ARTIFACT_CHANGED_DURING_CHECK');
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (position !== metadata.byteCount || !unchanged(before, await handle.stat({ bigint: true })))
      throw new Error('ARTIFACT_CHANGED_DURING_CHECK');
    if (!timingSafeEqual(hash.digest(), Buffer.from(metadata.sha256, 'hex'))) throw new Error('ARTIFACT_HASH_MISMATCH');
    const receipt = Object.freeze({ ...metadata, integrityVerified: true, signatureVerified: false,
      installVerified: false, fileName: basename(path) });
    const result = await consume(handle, receipt);
    if (!unchanged(before, await handle.stat({ bigint: true })) || !unchanged(before, await lstat(path, { bigint: true })))
      throw new Error('ARTIFACT_CHANGED_DURING_CHECK');
    return result;
  } finally { await handle.close(); }
}
export async function verifyNativeArtifactFile(options) {
  return withVerifiedNativeArtifact(options, async (_handle, receipt) => receipt);
}
