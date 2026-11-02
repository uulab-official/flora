#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, realpath, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openLocalBuildService } from './local-build-service.mjs';
import { snapshotBuildScope } from './build-lifecycle.mjs';
import { privateDirectory } from './private-paths.mjs';
import { readBuildInput } from './build-ops.mjs';
import { snapshotLocalRecipe } from './build-recipe.mjs';
import { createBuildProgress } from './build-progress.mjs';
export { snapshotLocalRecipe } from './build-recipe.mjs';
import { cleanEnvironment, checkSource, checkCheckout, checkExecutable, checkOutputPath } from './build-source.mjs';
const key = () => randomBytes(24).toString('hex');
async function execute(recipe, signal, progress) {
  return new Promise(resolve => {
    let reason, total = 0, grace, settled = false;
    const child = spawn(recipe.executable, recipe.args, { cwd: recipe.cwd, env: cleanEnvironment(), shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = why => {
      if (settled || reason) return; reason = why;
      if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
      grace = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } }, 1000);
    };
    const heartbeat = setInterval(() => progress.tick(), 1000);
    const aborted = () => stop('BUILD_PROCESS_ABORTED'), timeout = setTimeout(() => stop('BUILD_PROCESS_TIMEOUT'), recipe.timeoutMs);
    signal?.addEventListener('abort', aborted, { once: true }); if (signal?.aborted) aborted();
    child.once('spawn', () => progress.stage('executing'));
    for (const [kind, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) stream.on('data', chunk => {
      total += chunk.length; progress.output(kind, chunk.length);
      if (total > recipe.outputLimitBytes) stop('BUILD_PROCESS_OUTPUT_LIMIT');
    });
    child.on('error', () => { reason ??= 'BUILD_PROCESS_START_FAILED'; });
    // Stop remaining children in this process group when the leader exits.
    // Trusted builds may not escape into a new session; this is not a sandbox.
    child.on('exit', () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } });
    child.on('close', (exitCode, exitSignal) => {
      settled = true; clearTimeout(timeout); clearTimeout(grace); clearInterval(heartbeat); signal?.removeEventListener('abort', aborted);
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
export async function runLocalBuild({ directory, scope, recipe, execute: approved = false, signal, expectedVersion, onProgress }) {
  if (approved !== true) throw new Error('BUILD_EXECUTE_REQUIRED');
  scope = snapshotBuildScope(scope); recipe = snapshotLocalRecipe(recipe);
  const progress = createBuildProgress({ onProgress, outputLimitBytes: recipe.outputLimitBytes, timeoutMs: recipe.timeoutMs });
  directory = await privateDirectory(directory);
  if (signal?.aborted) throw new Error('BUILD_PROCESS_ABORTED');
  const service = await openLocalBuildService({ directory }); let lock, lockPath;
  try {
    progress.stage('preflight');
    const job = service.show(scope).job;
    if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion !== job.version)) throw new Error('BUILD_VERSION_CONFLICT');
    if (job.status !== 'queued') throw new Error('BUILD_NOT_QUEUED');
    if (['appId', 'repository', 'runnerId', 'platform'].some(k => job[k] !== recipe[k])
        || (job.platform === 'ios' ? recipe.format !== 'ipa' : recipe.format === 'ipa')) throw new Error('BUILD_RECIPE_SCOPE_MISMATCH');
    await checkCheckout(recipe.cwd);
    await checkExecutable(recipe.executable);
    await checkExecutable(recipe.gitExecutable);
    lockPath = join(directory, '.runner-lock-' + createHash('sha256').update(recipe.cwd).digest('hex') + '.lock');
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('BUILD_RUNNER_LOCKED'); throw error; }
    await lock.writeFile(JSON.stringify({ ...scope, pid: process.pid })); await lock.sync();
    await checkOutputPath(recipe.artifactPath);
    try { await lstat(recipe.artifactPath); throw new Error('BUILD_OUTPUT_EXISTS'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    progress.stage('source-check');
    await checkSource(recipe, job, true);
    if (signal?.aborted) throw new Error('BUILD_PROCESS_ABORTED');
    const running = await service.transition({ scope, expectedVersion: job.version, event: { status: 'running', idempotencyKey: key() } });
    try {
      const audit = stage => service.recordProgress({ scope, expectedVersion: running.version, runnerId: job.runnerId, stage });
      audit('runner-process-starting');
      const processResult = await execute(recipe, signal, progress);
      if (processResult.reason) {
        const status = processResult.reason === 'BUILD_PROCESS_ABORTED' ? 'cancelled' : 'failed';
        const state = await service.transition({ scope, expectedVersion: running.version, event: { status, idempotencyKey: key(), failureCode: processResult.reason } });
        return { ...state, reason: processResult.reason, exitCode: processResult.exitCode };
      }
      audit('runner-process-exited');
      progress.stage('verifying');
      if (signal?.aborted) {
        const state = await service.transition({ scope, expectedVersion: running.version, event: { status: 'cancelled', idempotencyKey: key(), failureCode: 'BUILD_PROCESS_ABORTED' } });
        return { ...state, reason: 'BUILD_PROCESS_ABORTED', exitCode: 0 };
      }
      audit('runner-artifact-verifying');
      await checkSource(recipe, job);
      const manifest = await manifestFor(recipe.artifactPath, job);
      progress.stage('publishing');
      if (signal?.aborted) {
        const state = await service.transition({ scope, expectedVersion: running.version, event: { status: 'cancelled', idempotencyKey: key(), failureCode: 'BUILD_PROCESS_ABORTED' } });
        return { ...state, reason: 'BUILD_PROCESS_ABORTED', exitCode: 0 };
      }
      audit('runner-artifact-publishing');
      return await service.complete({ scope, expectedVersion: running.version, idempotencyKey: key(), manifest,
        execution: { ...job, exitCode: 0 }, sourcePath: recipe.artifactPath, format: recipe.format });
    } catch (error) {
      const current = service.show(scope).job;
      if (current.status === 'running' && current.version === running.version) {
        const state = await service.transition({ scope, expectedVersion: current.version, event: { status: 'unknown', idempotencyKey: key(), failureCode: 'BUILD_RESULT_RECONCILIATION_REQUIRED' } });
        return { ...state, reason: 'BUILD_RESULT_RECONCILIATION_REQUIRED' };
      }
      throw error;
    }
  } finally {
    progress.finish();
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
