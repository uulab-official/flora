import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { privateDirectory, privateFile, syncDirectory } from './private-paths.mjs';

// All input is a private operator-owned regular file, never a user-supplied HTTP path.
export async function checkBackupFile(path, { maxBytes, expected, target, collect = false } = {}) {
  await privateDirectory(dirname(path)); await privateFile(path);
  const before = await lstat(path, { bigint: true });
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || before.size < 1n || before.size > BigInt(maxBytes)) throw new Error('BUILD_BACKUP_LIMIT');
  const same = info => info.isFile() && info.nlink === 1n && ['dev','ino','size','mtimeNs','ctimeNs','mode','uid'].every(k => info[k] === before[k]);
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output, created = false;
  try {
    if (!same(await input.stat({ bigint: true }))) throw new Error('BUILD_BACKUP_FILE_CHANGED');
    if (target) { await privateDirectory(dirname(target)); output = await open(target, 'wx', 0o600); created = true; }
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(256*1024), chunks = []; let position = 0;
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, position); if (!bytesRead) break;
      if (BigInt(position + bytesRead) > before.size) throw new Error('BUILD_BACKUP_FILE_CHANGED');
      const chunk = buffer.subarray(0,bytesRead); hash.update(chunk); if (collect) chunks.push(Buffer.from(chunk));
      if (output) { let written = 0; while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead-written, position+written);
        if (!result.bytesWritten) throw new Error('BUILD_BACKUP_WRITE_FAILED'); written += result.bytesWritten;
      } }
      position += bytesRead;
    }
    if (BigInt(position) !== before.size || !same(await input.stat({ bigint: true }))) throw new Error('BUILD_BACKUP_FILE_CHANGED');
    const result = { byteCount: position, sha256: hash.digest('hex') };
    if (expected && (expected.byteCount !== result.byteCount || expected.sha256 !== result.sha256)) throw new Error('BUILD_BACKUP_HASH_MISMATCH');
    if (output) { await output.sync(); await output.close(); output = null; await syncDirectory(dirname(target)); }
    return { ...result, ...(collect ? { bytes: Buffer.concat(chunks) } : {}) };
  } catch (error) {
    await output?.close().catch(()=>{}); output = null;
    if (created) await unlink(target).catch(()=>{});
    throw error;
  } finally { await input.close(); await output?.close(); }
}
export async function writePrivateBackupFile(path, value) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(dirname(path));
}
