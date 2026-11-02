import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { controlFixture, until, requestKey } from './control-fixture.mjs';
import { runLocalBuild } from './local-build-runner.mjs';
const module = await import('./build-controller.mjs').catch(() => ({}));
function controller(f, extra = {}) {
  assert.equal(typeof module.createBuildController, 'function', 'controller API is required');
  const c = module.createBuildController({ directory: f.directory, service: f.service, presets: f.presets, appIds: ['app-a'], ...extra });
  f.closers.push(() => c.close()); return c;
}
const request = f => ({ scope: f.job, presetId: 'android-preview', expectedVersion: 2, idempotencyKey: requestKey(10) });
test('reviewed preset starts real build once, exposes no paths, and settles to durable success', async t => {
  const f = await controlFixture(t), c = controller(f);
  assert.equal(c.list('app-a')[0].id, 'android-preview'); assert.equal(JSON.stringify(c.list('app-a')).includes(f.cwd), false);
  const first = c.start(request(f)), again = c.start(request(f)); assert.equal(first.id, again.id); assert.equal(again.replayed, true);
  const result = await until(() => c.state(f.job)?.phase === 'finished' && c.state(f.job));
  assert.equal(result.status, 'succeeded'); assert.equal(result.canStop, false); assert.equal(f.service.show(f.job).artifacts.length, 1);
  assert.equal(await readFile(f.recipe.artifactPath, 'utf8'), 'synthetic control build');
  assert.equal(c.start(request(f)).id, first.id);
});
test('controller rejects stale versions, changed replay, wrong app, recipe mismatch and arbitrary fields', async t => {
  const f = await controlFixture(t), c = controller(f);
  assert.throws(() => c.start({ ...request(f), expectedVersion: 1 }), /BUILD_VERSION_CONFLICT/);
  assert.throws(() => c.start({ ...request(f), command: 'evil' }), /BUILD_REQUEST_INVALID/);
  assert.throws(() => c.start({ ...request(f), presetId: 'missing' }), /BUILD_PRESET_NOT_FOUND/);
  assert.throws(() => c.start({ ...request(f), scope: { ...f.job, appId: 'other' } }), /BUILD_APP_FORBIDDEN/);
  c.start(request(f)); assert.throws(() => c.start({ ...request(f), expectedVersion: 1 }), /BUILD_IDEMPOTENCY_CONFLICT/);
});
test('managed stop waits for process close, persists cancellation and releases checkout lock', async t => {
  const f = await controlFixture(t, 'setInterval(()=>{},1000)'), c = controller(f); c.start(request(f));
  await until(() => f.service.show(f.job).job.status === 'running');
  const stopped = c.stop({ scope: f.job, expectedVersion: 3 }); assert.equal(stopped.phase, 'stopping');
  assert.notEqual(stopped.status, 'cancelled');
  await until(() => c.state(f.job)?.phase === 'finished');
  assert.equal(f.service.show(f.job).job.status, 'cancelled');
  assert.equal((await readdir(f.directory)).some(n => n.startsWith('.runner-lock-')), false);
});
test('shutdown aborts in-flight commands before resolving, and restart never resumes them', async t => {
  const f = await controlFixture(t, 'setInterval(()=>{},1000)'), c = controller(f); c.start(request(f));
  await until(() => f.service.show(f.job).job.status === 'running'); await c.close();
  assert.equal(f.service.show(f.job).job.status, 'cancelled'); assert.throws(() => c.start(request(f)), /BUILD_CONSOLE_CLOSING/);
  const reopened = controller(f); assert.equal(reopened.state(f.job), null);
  assert.throws(() => reopened.start({ ...request(f), expectedVersion: 4 }), /BUILD_NOT_QUEUED/);
});
test('preflight failure is visible without pretending the queued job executed', async t => {
  const f = await controlFixture(t), c = controller(f); await writeFile(join(f.cwd, 'build.cjs'), 'process.exit(0)');
  c.start(request(f)); const record = await until(() => c.state(f.job)?.phase === 'blocked' && c.state(f.job));
  assert.equal(record.reason, 'BUILD_SOURCE_DIRTY'); assert.equal(f.service.show(f.job).job.status, 'queued');
  assert.equal(JSON.stringify(record).includes(f.cwd), false);
});
test('controller snapshots preset configuration and rejects invalid or cross-app settings', async t => {
  const f = await controlFixture(t);
  assert.equal(typeof module.createBuildController, 'function');
  for (const presets of [[...f.presets, ...f.presets], [{ ...f.presets[0], recipe: { ...f.recipe, appId: 'other' } }], [{ ...f.presets[0], label: '\nunsafe' }]])
    assert.throws(() => controller(f, { presets }), /BUILD_PRESET_CONFIG_INVALID/);
  const c = controller(f); f.recipe.args[0] = 'missing.cjs'; c.start(request(f));
  await until(() => c.state(f.job)?.phase === 'finished'); assert.equal(f.service.show(f.job).job.status, 'succeeded');
});
test('concurrency bound and ownership prevent duplicate or unmanaged cancellation', async t => {
  const f = await controlFixture(t, 'setInterval(()=>{},1000)'), c = controller(f);
  const second = { ...f.job, jobId: 'job-two' }; f.service.create(second);
  for (const [i, status] of ['authorized', 'queued'].entries()) await f.service.transition({ scope: second, expectedVersion: i, event: { status, idempotencyKey: requestKey(i + 30) } });
  c.start(request(f));
  assert.throws(() => c.start({ ...request(f), idempotencyKey: requestKey(11) }), /BUILD_EXECUTION_ACTIVE/);
  assert.throws(() => c.start({ ...request(f), scope: second }), /BUILD_EXECUTION_LIMIT/);
  assert.throws(() => c.stop({ scope: second, expectedVersion: 2 }), /BUILD_RUNNER_NOT_MANAGED/);
});
test('runner rejects a pinned stale version before any build side effects', async t => {
  const f = await controlFixture(t);
  await assert.rejects(runLocalBuild({ directory: f.directory, scope: f.job, recipe: f.recipe, execute: true, expectedVersion: 1 }), /BUILD_VERSION_CONFLICT/);
  assert.equal(f.service.show(f.job).job.status, 'queued');
});
test('losing admission to another runner never rewrites that runners live state', async t => {
  const f = await controlFixture(t), c = controller(f); c.start(request(f));
  await f.service.transition({ scope: f.job, expectedVersion: 2, event: { status: 'running', idempotencyKey: requestKey(60) } });
  await until(() => ['blocked', 'finished'].includes(c.state(f.job)?.phase));
  assert.equal(f.service.show(f.job).job.status, 'running');
});
test('stop before the runner claims prevents spawning and records an honest cancellation', async t => {
  const f = await controlFixture(t), c = controller(f); c.start(request(f)); c.stop({ scope: f.job, expectedVersion: 2 });
  await until(() => c.state(f.job)?.phase === 'finished');
  assert.equal(f.service.show(f.job).job.status, 'cancelled');
  assert.equal(f.service.show(f.job).artifacts.length, 0);
});
