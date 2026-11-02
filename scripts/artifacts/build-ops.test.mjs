import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const cli = fileURLToPath(new URL('./build-ops.mjs', import.meta.url));
const job = { appId: 'cli-app', jobId: 'job-1', repository: 'owner/private', sourceSha: 'a'.repeat(40), platform: 'android', runnerId: 'local-runner' };
function invoke(args) {
  const run = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15000 });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr, json: run.stdout?.startsWith('{') ? JSON.parse(run.stdout) : null };
}
async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'flora-cli-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'state'); let sequence = 0;
  async function input(value) { const path = join(root, `input-${sequence++}.json`); await writeFile(path, JSON.stringify(value)); return path; }
  return { root, directory, input, run: (command, ...args) => invoke([command, '--state-dir', directory, ...args]) };
}
test('CLI completes the local operations lifecycle across fresh processes', async t => {
  const f = await fixture(t); assert.equal(f.run('init').code, 0);
  assert.equal(f.run('create', '--input', await f.input(job)).code, 0);
  for (const [index, status] of ['authorized', 'queued', 'running'].entries()) {
    const run = f.run('transition', '--input', await f.input({ scope: job, expectedVersion: index,
      event: { status, idempotencyKey: String(index + 1).repeat(32) } }));
    assert.equal(run.code, 0, run.stdout + run.stderr);
  }
  const bytes = Buffer.from('synthetic CLI artifact'), sourcePath = join(f.root, 'preview.apk'); await writeFile(sourcePath, bytes);
  const manifest = { ...job, byteCount: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const request = await f.input({ scope: job, expectedVersion: 3, idempotencyKey: '4'.repeat(32), format: 'apk',
    manifest, execution: { ...job, exitCode: 0 }, sourcePath });
  const complete = f.run('complete', '--input', request); assert.equal(complete.code, 0, complete.stdout + complete.stderr);
  assert.equal(complete.json.result.status, 'succeeded'); assert.equal(complete.stdout.includes(f.root), false);
  assert.equal(f.run('complete', '--input', request).json.result.replayed, true);
  assert.equal(f.run('list', '--app', job.appId).json.result.length, 1);
  assert.equal(f.run('show', '--app', job.appId, '--job', job.jobId).json.result.artifacts.length, 1);
  assert.equal(f.run('history', '--app', job.appId, '--job', job.jobId).json.result.length, 5);
  const targetPath = join(f.root, 'out.apk');
  const result = f.run('export', '--app', job.appId, '--job', job.jobId, '--artifact', complete.json.result.artifact.artifactId, '--output', targetPath);
  assert.equal(result.code, 0, result.stdout + result.stderr); assert.deepEqual(await readFile(targetPath), bytes);
  assert.equal(f.run('doctor').json.result.ready, true);
});
test('read commands never initialize a mistyped directory', async t => {
  const f = await fixture(t), result = f.run('list', '--app', job.appId);
  assert.equal(result.code, 1); assert.equal(result.json.error, 'BUILD_LEDGER_NOT_INITIALIZED');
  await assert.rejects(stat(f.directory), { code: 'ENOENT' });
});
test('malformed and oversized JSON is rejected without revealing its contents', async t => {
  const f = await fixture(t); assert.equal(f.run('init').code, 0);
  const path = join(f.root, 'secret-input.json');
  for (const content of ['{"secret":"SUPER_PRIVATE_VALUE",', 'x'.repeat(65537)]) {
    await writeFile(path, content); const result = f.run('create', '--input', path);
    assert.equal(result.code, 1); assert.match(result.json.error, /BUILD_INPUT_INVALID|BUILD_INPUT_TOO_LARGE/);
    assert.equal((result.stdout + result.stderr).includes('SUPER_PRIVATE_VALUE'), false);
    assert.equal(result.stdout.includes(f.root), false);
  }
});
test('symlinked JSON input is rejected', async t => {
  const f = await fixture(t); f.run('init');
  const original = await f.input(job), alias = join(f.root, 'alias.json'); await symlink(original, alias);
  assert.equal(f.run('create', '--input', alias).json.error, 'BUILD_INPUT_UNSAFE');
});
test('unknown and duplicate options fail before opening state', async t => {
  const f = await fixture(t);
  for (const args of [['init', '--state-dir', f.directory, '--force', 'yes'],
    ['init', '--state-dir', f.directory, '--state-dir', f.directory], ['unknown', '--state-dir', f.directory]]) {
    const result = invoke(args); assert.equal(result.code, 1); assert.equal(result.json.error, 'BUILD_ARGUMENT_INVALID');
  }
  await assert.rejects(stat(f.directory), { code: 'ENOENT' });
});
test('doctor uses a nonzero exit code for an incomplete or unsafe state', async t => {
  const f = await fixture(t); f.run('init'); f.run('create', '--input', await f.input(job));
  for (const [index, status] of ['authorized', 'queued', 'unknown'].entries())
    f.run('transition', '--input', await f.input({ scope: job, expectedVersion: index, event: { status, idempotencyKey: String(index + 1).repeat(32) } }));
  const result = f.run('doctor'); assert.equal(result.code, 1);
  assert.equal(result.json.result.ready, false); assert.equal(result.json.result.states.unknown, 1);
});
