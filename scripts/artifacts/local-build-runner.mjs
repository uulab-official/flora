#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openLocalBuildService } from './local-build-service.mjs';
import { isRecord, snapshotBuildScope } from './build-lifecycle.mjs';
import { privateDirectory } from './private-paths.mjs';
import { readBuildInput } from './build-ops.mjs';
const exec = promisify(execFile), key = () => randomBytes(24).toString('hex');
export function snapshotLocalRecipe(value) {
  const keys = ['appId', 'repository', 'runnerId', 'platform', 'cwd', 'executable', 'args', 'artifactPath', 'format', 'timeoutMs', 'gitExecutable'];
  if (!isRecord(value) || Object.keys(value).some(k => !keys.includes(k)) || !Array.isArray(value.args) || value.args.length > 64
      || value.args.some(a => typeof a !== 'string' || a.length > 4096 || a.includes('\0'))) throw new Error('BUILD_RECIPE_INVALID');
  const recipe = { ...value, args: [...value.args], timeoutMs: value.timeoutMs ?? 600000, gitExecutable: value.gitExecutable ?? '/usr/bin/git' };
  for (const name of ['cwd', 'executable', 'artifactPath', 'gitExecutable'])
    if (typeof recipe[name] !== 'string' || !isAbsolute(recipe[name]) || recipe[name].includes('\0')) throw new Error('BUILD_RECIPE_INVALID');
  const child = relative(resolve(recipe.cwd), resolve(recipe.artifactPath));
  if (!child || child === '..' || child.startsWith('../') || isAbsolute(child) || !['apk', 'aab', 'ipa'].includes(recipe.format)
      || !recipe.artifactPath.endsWith('.' + recipe.format) || !Number.isSafeInteger(recipe.timeoutMs) || recipe.timeoutMs < 100 || recipe.timeoutMs > 3600000)
    throw new Error('BUILD_RECIPE_INVALID');
  recipe.args = Object.freeze(recipe.args);
  return Object.freeze(recipe);
}
function cleanEnvironment() {
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', LANG: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'GRADLE_USER_HOME', 'DEVELOPER_DIR']) if (process.env[key]) env[key] = process.env[key];
  return env;
}
async function checkSource(recipe, job, before = false) {
  const args = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', recipe.cwd];
  try {
    const head = await exec(recipe.gitExecutable, [...args, 'rev-parse', 'HEAD'], { env: cleanEnvironment(), timeout: 5000, maxBuffer: 65536 });
    if (head.stdout.trim() !== job.sourceSha) throw new Error('BUILD_SOURCE_SHA_MISMATCH');
    const dirty = await exec(recipe.gitExecutable, [...args, 'status', '--porcelain', before ? '--untracked-files=all' : '--untracked-files=no'], { env: cleanEnvironment(), timeout: 5000, maxBuffer: 65536 });
    if (dirty.stdout.trim()) throw new Error('BUILD_SOURCE_DIRTY');
  } catch (error) { if (/^BUILD_SOURCE_/.test(error.message)) throw error; throw new Error('BUILD_SOURCE_CHECK_FAILED'); }
}
async function execute(recipe, signal) {
  return new Promise(resolve => {
    let reason, total = 0, grace, settled = false;
    const child = spawn(recipe.executable, recipe.args, { cwd: recipe.cwd, env: cleanEnvironment(), shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = why => {
      if (settled || reason) return; reason = why;
      if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
      grace = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } }, 1000);
    };
    const aborted = () => stop('BUILD_PROCESS_ABORTED'), timeout = setTimeout(() => stop('BUILD_PROCESS_TIMEOUT'), recipe.timeoutMs);
    signal?.addEventListener('abort', aborted, { once: true }); if (signal?.aborted) aborted();
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { total += chunk.length; if (total > 256 * 1024) stop('BUILD_PROCESS_OUTPUT_LIMIT'); });
    child.on('error', () => { reason ??= 'BUILD_PROCESS_START_FAILED'; });
    // Stop remaining children in this process group when the leader exits.
    // Trusted builds may not escape into a new session; this is not a sandbox.
    child.on('exit', () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } });
    child.on('close', (exitCode, exitSignal) => {
      settled = true; clearTimeout(timeout); clearTimeout(grace); signal?.removeEventListener('abort', aborted);
      resolve({ exitCode, reason: reason ?? (exitCode === 0 && !exitSignal ? null : 'BUILD_PROCESS_FAILED') });
    });
  });
}
async function manifestFor(path, job) {
  if (await realpath(dirname(path)) !== dirname(path)) throw new Error('ARTIFACT_PARENT_SYMLINK');
  const initial = await lstat(path, { bigint: true });
  if (!initial.isFile() || initial.nlink !== 1n || initial.size <= 0n || initial.size > 2147483648n) throw new Error('ARTIFACT_SIZE_INVALID');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const same = info => info.isFile() && info.nlink === 1n && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(k => info[k] === initial[k]);
    if (!same(await handle.stat({ bigint: true }))) throw new Error('ARTIFACT_SOURCE_CHANGED');
    const buffer = Buffer.allocUnsafe(256 * 1024), hash = createHash('sha256'); let size = 0;
    for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, size); if (!bytesRead) break; size += bytesRead;
      if (BigInt(size) > initial.size) throw new Error('ARTIFACT_SOURCE_CHANGED'); hash.update(buffer.subarray(0, bytesRead)); }
    if (BigInt(size) !== initial.size || !same(await handle.stat({ bigint: true }))) throw new Error('ARTIFACT_SOURCE_CHANGED');
    return { ...job, byteCount: size, sha256: hash.digest('hex') };
  } finally { await handle.close(); }
}
// Explicit one-shot local runner for trusted checkouts, NOT a sandbox for untrusted repositories.
export async function runLocalBuild({ directory, scope, recipe, execute: approved = false, signal, expectedVersion }) {
  if (approved !== true) throw new Error('BUILD_EXECUTE_REQUIRED');
  scope = snapshotBuildScope(scope); recipe = snapshotLocalRecipe(recipe); directory = await privateDirectory(directory);
  if (signal?.aborted) throw new Error('BUILD_PROCESS_ABORTED');
  const service = await openLocalBuildService({ directory }); let lock, lockPath;
  try {
    const job = service.show(scope).job;
    if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion !== job.version)) throw new Error('BUILD_VERSION_CONFLICT');
    if (job.status !== 'queued') throw new Error('BUILD_NOT_QUEUED');
    if (['appId', 'repository', 'runnerId', 'platform'].some(k => job[k] !== recipe[k])
        || (job.platform === 'ios' ? recipe.format !== 'ipa' : recipe.format === 'ipa')) throw new Error('BUILD_RECIPE_SCOPE_MISMATCH');
    const cwdInfo = await lstat(recipe.cwd);
    if (!cwdInfo.isDirectory() || cwdInfo.uid !== process.geteuid() || (cwdInfo.mode & 0o022) !== 0 || await realpath(recipe.cwd) !== recipe.cwd) throw new Error('BUILD_CHECKOUT_UNSAFE');
    lockPath = join(directory, '.runner-lock-' + createHash('sha256').update(recipe.cwd).digest('hex') + '.lock');
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('BUILD_RUNNER_LOCKED'); throw error; }
    await lock.writeFile(JSON.stringify({ ...scope, pid: process.pid })); await lock.sync();
    try { await lstat(recipe.artifactPath); throw new Error('BUILD_OUTPUT_EXISTS'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await checkSource(recipe, job, true);
    if (signal?.aborted) throw new Error('BUILD_PROCESS_ABORTED');
    const running = await service.transition({ scope, expectedVersion: job.version, event: { status: 'running', idempotencyKey: key() } });
    const processResult = await execute(recipe, signal);
    if (processResult.reason) {
      const status = processResult.reason === 'BUILD_PROCESS_ABORTED' ? 'cancelled' : 'failed';
      const state = await service.transition({ scope, expectedVersion: running.version, event: { status, idempotencyKey: key(), failureCode: processResult.reason } });
      return { ...state, reason: processResult.reason, exitCode: processResult.exitCode };
    }
    try {
      await checkSource(recipe, job);
      const manifest = await manifestFor(recipe.artifactPath, job);
      return await service.complete({ scope, expectedVersion: running.version, idempotencyKey: key(), manifest,
        execution: { ...job, exitCode: 0 }, sourcePath: recipe.artifactPath, format: recipe.format });
    } catch (error) {
      const current = service.show(scope).job;
      if (current.status === 'running') {
        const state = await service.transition({ scope, expectedVersion: current.version, event: { status: 'unknown', idempotencyKey: key(), failureCode: 'BUILD_RESULT_RECONCILIATION_REQUIRED' } });
        return { ...state, reason: 'BUILD_RESULT_RECONCILIATION_REQUIRED' };
      }
      throw error;
    }
  } finally {
    service.close();
    // A killed runner leaves its lock for manual diagnosis. Never remove another process's lock.
    if (lock) { await lock.close(); await unlink(lockPath); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let controller;
  try {
    const args = process.argv.slice(2);
    if (!args.includes('--execute')) throw new Error('BUILD_EXECUTE_REQUIRED');
    args.splice(args.indexOf('--execute'), 1); const values = {};
    if (args.length !== 8) throw new Error('BUILD_ARGUMENT_INVALID');
    for (let i = 0; i < args.length; i += 2) {
      if (!['--state-dir', '--app', '--job', '--recipe'].includes(args[i]) || Object.hasOwn(values, args[i])) throw new Error('BUILD_ARGUMENT_INVALID');
      values[args[i]] = args[i + 1];
    }
    const recipe = await readBuildInput(values['--recipe']); controller = new AbortController();
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
    const result = await runLocalBuild({ directory: values['--state-dir'], scope: { appId: values['--app'], jobId: values['--job'] }, recipe, execute: true, signal: controller.signal });
    process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = result.status === 'succeeded' ? 0 : 1;
  } catch (error) { process.stderr.write((/^(BUILD|ARTIFACT)_[A-Z_]+$/.test(error.message) ? error.message : 'BUILD_RUNNER_FAILED') + '\n'); process.exitCode = 1; }
}
