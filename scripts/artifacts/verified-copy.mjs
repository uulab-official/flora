import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open, link, unlink, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { localPath, privateDirectory, syncDirectory } from './private-paths.mjs';
import { withVerifiedNativeArtifact } from './native-artifact-file.mjs';

// New-file-only export. The destination parent must be owned and private.
// Never streams unverified content to an HTTP client or executes a binary.
export async function copyVerifiedNativeArtifact({ sourcePath, targetPath, manifest, expected }) {
  targetPath = localPath(targetPath, 'ARTIFACT_PATH_INVALID');
  const parent = await privateDirectory(dirname(targetPath));
  const temporary = join(parent, '.' + randomBytes(16).toString('hex') + '.partial');
  let output, linked = false;
  try {
    const receipt = await withVerifiedNativeArtifact({ filePath: sourcePath, manifest, expected }, async (input, verified) => {
      output = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      const buffer = Buffer.allocUnsafe(256 * 1024), hash = createHash('sha256'); let position = 0;
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        if (position + bytesRead > verified.byteCount) throw new Error('ARTIFACT_SOURCE_CHANGED');
        hash.update(buffer.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const { bytesWritten } = await output.write(buffer, written, bytesRead - written, position + written);
          if (bytesWritten === 0) throw new Error('ARTIFACT_WRITE_FAILED'); written += bytesWritten;
        }
        position += bytesRead;
      }
      if (position !== verified.byteCount || !timingSafeEqual(hash.digest(), Buffer.from(verified.sha256, 'hex')))
        throw new Error('ARTIFACT_COPY_HASH_MISMATCH');
      await output.sync(); await output.close(); output = undefined;
      return verified;
    });
    // link() is an atomic no-replace operation on the same filesystem.
    // Until the temp name is removed a crash may leave nlink=2; readers reject it.
    try { await link(temporary, targetPath); linked = true; }
    catch (error) { if (error.code === 'EEXIST') throw new Error('ARTIFACT_DESTINATION_EXISTS'); throw error; }
    await unlink(temporary); await syncDirectory(parent);
    return receipt;
  } catch (error) {
    await output?.close().catch(() => {}); output = undefined;
    await rm(temporary, { force: true });
    if (linked) { await rm(targetPath, { force: true }); await syncDirectory(parent); }
    throw error;
  } finally { await output?.close(); }
}
