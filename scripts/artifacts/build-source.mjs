import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
const exec = promisify(execFile);
export function cleanEnvironment() {
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', LANG: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'GRADLE_USER_HOME', 'DEVELOPER_DIR']) if (process.env[key]) env[key] = process.env[key];
  return env;
}
export async function checkSource(recipe, job, before = false) {
  const args = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', recipe.cwd];
  try {
    const head = await exec(recipe.gitExecutable, [...args, 'rev-parse', 'HEAD'], { env: cleanEnvironment(), timeout: 5000, maxBuffer: 65536 });
    if (head.stdout.trim() !== job.sourceSha) throw new Error('BUILD_SOURCE_SHA_MISMATCH');
    const dirty = await exec(recipe.gitExecutable, [...args, 'status', '--porcelain', before ? '--untracked-files=all' : '--untracked-files=no'], { env: cleanEnvironment(), timeout: 5000, maxBuffer: 65536 });
    if (dirty.stdout.trim()) throw new Error('BUILD_SOURCE_DIRTY');
  } catch (error) { if (/^BUILD_SOURCE_/.test(error.message)) throw error; throw new Error('BUILD_SOURCE_CHECK_FAILED'); }
}

export async function checkCheckout(cwd) {
  const info = await lstat(cwd);
  if (!info.isDirectory() || info.uid !== process.geteuid() || (info.mode & 0o022) !== 0 || await realpath(cwd) !== cwd)
    throw new Error('BUILD_CHECKOUT_UNSAFE');
}
// Operator-selected executables are trusted; this is not a tool ownership attestation.
// Readiness observation only. Spawn/open errors still require handling after this check.
export async function checkExecutable(path) {
  try {
    const info = await stat(path);
    if (!info.isFile() || !(info.mode & 0o111)) throw new Error();
    await access(path, constants.X_OK);
  } catch { throw new Error('BUILD_EXECUTABLE_UNAVAILABLE'); }
}

export async function checkOutputPath(path) {
  let parent = dirname(resolve(path));
  for (;;) {
    try {
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(parent) !== parent)
        throw new Error('BUILD_OUTPUT_PATH_UNSAFE');
      return;
    } catch (error) {
      if (error.code !== 'ENOENT' || dirname(parent) === parent) {
        if (error.message === 'BUILD_OUTPUT_PATH_UNSAFE') throw error;
        throw new Error('BUILD_OUTPUT_PATH_UNSAFE');
      }
      parent = dirname(parent);
    }
  }
}
