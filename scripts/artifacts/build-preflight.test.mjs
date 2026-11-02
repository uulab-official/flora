import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir, chmod, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { controlFixture, requestKey } from './control-fixture.mjs';
const module = await import('./local-build-preflight.mjs').catch(() => ({}));
function inspect(f, extra = {}) {
  assert.equal(typeof module.inspectLocalBuild, 'function', 'read-only preflight API required');
  return module.inspectLocalBuild({ directory: f.directory, scope: f.job, recipe: f.recipe, expectedVersion: 2, ...extra });
}
const failed = result => result.checks.filter(c => c.status === 'failed').map(c => c.code);
test('preflight inspects the real checkout without building, claiming, locking or changing database', async t => {
  const f = await controlFixture(t), before = await readFile(join(f.directory, 'builds.sqlite')), files = await readdir(f.directory);
  const report = await inspect(f);
  assert.equal(report.ready, true); assert.equal(report.jobVersion, 2); assert.equal(report.sourceSha, f.job.sourceSha);
  assert.ok(report.checks.length >= 6); assert.ok(report.checks.every(c => c.status === 'passed'));
  assert.equal(report.buildExecuted, false); assert.equal(report.signatureVerified, false);
  assert.equal(JSON.stringify(report).includes(f.root), false); assert.equal(JSON.stringify(report).includes('build.cjs'), false);
  assert.deepEqual(await readFile(join(f.directory, 'builds.sqlite')), before); assert.deepEqual(await readdir(f.directory), files);
  assert.equal(f.service.show(f.job).job.status, 'queued'); assert.equal(f.service.history(f.job).length, 3);
});
test('preflight reports stale version or wrong recipe binding before filesystem checks', async t => {
  const f = await controlFixture(t);
  const stale = await inspect(f, { expectedVersion: 1 }); assert.equal(stale.ready, false); assert.ok(failed(stale).includes('BUILD_VERSION_CONFLICT'));
  assert.ok(stale.checks.some(c => c.status === 'not_checked'));
  const wrong = await inspect(f, { recipe: { ...f.recipe, runnerId: 'other' } }); assert.ok(failed(wrong).includes('BUILD_RECIPE_SCOPE_MISMATCH'));
});
test('preflight returns clean errors for tracked and untracked source changes', async t => {
  const f = await controlFixture(t); await writeFile(join(f.cwd, 'untracked-secret.txt'), 'TOKEN_DO_NOT_EXPOSE');
  const result = await inspect(f); assert.ok(failed(result).includes('BUILD_SOURCE_DIRTY')); assert.equal(JSON.stringify(result).includes('TOKEN'), false);
});
test('preflight rejects an unavailable or nonexecutable tool without claiming a job', async t => {
  const f = await controlFixture(t);
  const missing = await inspect(f, { recipe: { ...f.recipe, executable: join(f.root, 'missing') } });
  assert.ok(failed(missing).includes('BUILD_EXECUTABLE_UNAVAILABLE'));
  const path = join(f.root, 'not-executable'); await writeFile(path, 'do not run', { mode: 0o600 });
  const nonExecutable = await inspect(f, { recipe: { ...f.recipe, executable: path } });
  assert.ok(failed(nonExecutable).includes('BUILD_EXECUTABLE_UNAVAILABLE'));
  assert.equal(f.service.show(f.job).job.status, 'queued');
});
test('preflight never removes an existing output or runner lock', async t => {
  const f = await controlFixture(t); await writeFile(f.recipe.artifactPath, 'keep output');
  const name = '.runner-lock-' + createHash('sha256').update(f.cwd).digest('hex') + '.lock';
  const path = join(f.directory, name); await writeFile(path, 'private lock');
  const result = await inspect(f); assert.ok(failed(result).includes('BUILD_OUTPUT_EXISTS')); assert.ok(failed(result).includes('BUILD_RUNNER_LOCKED'));
  assert.equal(await readFile(f.recipe.artifactPath, 'utf8'), 'keep output'); assert.equal(await readFile(path, 'utf8'), 'private lock');
});
test('preflight reports checkout permissions and skips dependent source checks', async t => {
  const f = await controlFixture(t); await chmod(f.cwd, 0o777);
  const result = await inspect(f); assert.ok(failed(result).includes('BUILD_CHECKOUT_UNSAFE'));
  assert.equal(result.checks.find(c => c.id === 'source').status, 'not_checked');
});
test('preflight accepts an absent nested output parent without creating it', async t => {
  const f = await controlFixture(t); const recipe = { ...f.recipe, artifactPath: join(f.cwd, 'build', 'outputs', 'app.apk') };
  assert.equal((await inspect(f, { recipe })).ready, true);
  assert.equal((await readdir(f.cwd)).includes('build'), false);
});
test('preflight snapshots caller arguments before asynchronous IO', async t => {
  const f = await controlFixture(t), recipe = { ...f.recipe, args: [...f.recipe.args] }, scope = { ...f.job };
  const pending = inspect(f, { recipe, scope }); recipe.executable = '/missing'; scope.appId = 'other';
  assert.equal((await pending).ready, true);
});
test('preflight rejects malformed inputs and cannot initialize missing state', async t => {
  const f = await controlFixture(t);
  await assert.rejects(inspect(f, { directory: join(f.root, 'not-created') }), /BUILD_LEDGER_NOT_INITIALIZED/);
  await assert.rejects(inspect(f, { expectedVersion: -1 }), /BUILD_VERSION_INVALID/);
  await assert.rejects(inspect(f, { recipe: { ...f.recipe, arbitrary: true } }), /BUILD_RECIPE_INVALID/);
});
test('output parent symlinks are rejected even when the final output does not exist', async t => {
  const f = await controlFixture(t), outside = join(f.root, 'outside'); await mkdir(outside, { mode: 0o700 });
  const { symlink } = await import('node:fs/promises'); await symlink(outside, join(f.cwd, 'linked'));
  f.git('add', 'linked'); f.git('commit', '-qm', 'link fixture');
  const recipe = { ...f.recipe, artifactPath: join(f.cwd, 'linked', 'nested', 'result.apk') };
  const report = await inspect(f, { recipe }); assert.ok(failed(report).includes('BUILD_OUTPUT_PATH_UNSAFE'));
  assert.deepEqual(await readdir(outside), []);
});
