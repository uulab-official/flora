import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

export function localPath(value, code = 'BUILD_PATH_INVALID') {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw new Error(code);
  return resolve(value);
}
export function requirePosix() {
  if (!['linux', 'darwin'].includes(process.platform) || typeof process.geteuid !== 'function')
    throw new Error('BUILD_FILESYSTEM_UNSUPPORTED');
}
export async function privateDirectory(value, { create = false } = {}) {
  requirePosix(); const path = localPath(value);
  if (create) {
    const parent = dirname(path), info = await lstat(parent);
    if (!info.isDirectory() || await realpath(parent) !== parent || (info.mode & 0o022) !== 0
        || info.uid !== process.geteuid()) throw new Error('BUILD_DIRECTORY_UNSAFE');
    try { await mkdir(path, { mode: 0o700 }); await syncDirectory(parent); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path
      || (info.mode & 0o077) !== 0 || info.uid !== process.geteuid()) throw new Error('BUILD_DIRECTORY_UNSAFE');
  return path;
}
export async function privateFile(path, { optional = false } = {}) {
  let info;
  try { info = await lstat(path); }
  catch (error) { if (optional && error.code === 'ENOENT') return false; throw error; }
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.uid !== process.geteuid())
    throw new Error('BUILD_DATABASE_UNSAFE');
  return true;
}
export async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
