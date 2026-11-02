import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { controlFixture, requestKey, until } from './control-fixture.mjs';
import { runLocalBuild, snapshotLocalRecipe } from './local-build-runner.mjs';
import { openLocalBuildService } from './local-build-service.mjs';
import { createBuildController } from './build-controller.mjs';
const run = (f, extra = {}) => runLocalBuild({ directory: f.directory, scope: f.job, recipe: f.recipe, expectedVersion: 2, execute: true, ...extra });
test('runner emits ordered numeric activity and stores bounded stages without raw output', async t => {
  const f = await controlFixture(t, "process.stdout.write('SECRET_STDOUT');process.stderr.write('SECRET_STDERR');require('node:fs').writeFileSync('result.apk','fixture');");
  const events = []; const result = await run(f, { onProgress: e => events.push(e) });
  assert.equal(result.status, 'succeeded'); assert.ok(events.length > 3);
  assert.ok(events.every(Object.isFrozen)); assert.equal(events.at(-1).stage, 'finished');
  assert.equal(events.at(-1).stdoutBytes, 13); assert.equal(events.at(-1).stderrBytes, 13);
  for (let i = 1; i < events.length; i++) assert.ok(events[i].elapsedMs >= events[i - 1].elapsedMs);
  assert.equal(JSON.stringify(events).includes('SECRET'), false); assert.equal(JSON.stringify(events).includes(f.root), false);
  const types = f.service.history(f.job).filter(e => e.eventType.startsWith('runner-')).map(e => e.eventType);
  assert.deepEqual(types, ['runner-process-starting', 'runner-process-exited', 'runner-artifact-verifying', 'runner-artifact-publishing']);
  const reopened = await openLocalBuildService({ directory: f.directory, readOnly: true });
  try { assert.deepEqual(reopened.history(f.job).filter(e => e.eventType.startsWith('runner-')).map(e => e.eventType), types); }
  finally { reopened.close(); }
});
test('progress observer exceptions and rejected promises cannot change a successful build', async t => {
  const f = await controlFixture(t); let n = 0;
  const result = await run(f, { onProgress() { n++; if (n % 2) throw new Error('observer private error'); return Promise.reject(new Error('observer async error')); } });
  assert.ok(n > 0); assert.equal(result.status, 'succeeded');
});
test('operator configured bounded output limit permits a verbose build without storing its output', async t => {
  const f = await controlFixture(t, "process.stdout.write('x'.repeat(300000),()=>require('node:fs').writeFileSync('result.apk','fixture'))");
  const events = [];
  const result = await run(f, { recipe: { ...f.recipe, outputLimitBytes: 512 * 1024 }, onProgress: e => events.push(e) });
  assert.equal(result.status, 'succeeded'); assert.equal(events.at(-1).stdoutBytes, 300000);
  assert.equal(events.at(-1).outputLimitBytes, 512 * 1024);
  assert.ok(JSON.stringify(events).length < 50000);
});
test('default output limit is preserved and invalid/unbounded limits are rejected', async t => {
  const f = await controlFixture(t);
  assert.equal(snapshotLocalRecipe(f.recipe).outputLimitBytes, 256 * 1024);
  for (const outputLimitBytes of [0, -1, Infinity, '1024', 64 * 1024 * 1024 + 1])
    assert.throws(() => snapshotLocalRecipe({ ...f.recipe, outputLimitBytes }), /BUILD_RECIPE_INVALID/);
});
test('progress remains stoppable and counters are visible during a running process', async t => {
  const f = await controlFixture(t, "process.stdout.write('pulse');setInterval(()=>{},1000)"), c = createBuildController({ directory: f.directory, service: f.service, presets: f.presets, appIds: ['app-a'] });
  f.closers.push(() => c.close()); c.start({ scope: f.job, presetId: f.presets[0].id, expectedVersion: 2, idempotencyKey: requestKey(90) });
  const live = await until(() => c.state(f.job)?.activity?.stdoutBytes === 5 && c.state(f.job));
  assert.equal(live.activity.stage, 'executing'); assert.equal(live.activity.live, true); assert.equal(live.canStop, true);
  c.stop({ scope: f.job, expectedVersion: 3 });
  const result = await until(() => c.state(f.job)?.phase === 'finished' && c.state(f.job));
  assert.equal(result.status, 'cancelled'); assert.equal(result.activity.live, false);
  assert.equal(result.activity.stage, 'finished'); assert.equal(result.reason, 'BUILD_PROCESS_ABORTED');
});
test('durable progress rejects arbitrary data, wrong runner, stale version and out of order stages', async t => {
  const f = await controlFixture(t); assert.equal(typeof f.service.recordProgress, 'function');
  const request = { scope: f.job, expectedVersion: 3, runnerId: f.job.runnerId, stage: 'runner-process-starting' };
  await f.service.transition({ scope: f.job, expectedVersion: 2, event: { status: 'running', idempotencyKey: requestKey(91) } });
  for (const bad of [{ stage: 'SECRET' }, { runnerId: 'other' }, { expectedVersion: 2 }, { stage: 'runner-artifact-publishing' }, { raw: 'SECRET' }])
    assert.throws(() => f.service.recordProgress({ ...request, ...bad }), /BUILD_(PROGRESS_INVALID|EXECUTION_MISMATCH|VERSION_CONFLICT|PROGRESS_ORDER)/);
  assert.equal(f.service.recordProgress(request).recorded, true); assert.equal(f.service.recordProgress(request).recorded, false);
  assert.equal(f.service.show(f.job).job.version, 3); assert.equal(f.service.history(f.job).filter(e => e.eventType.startsWith('runner-')).length, 1);
  const readOnly = await openLocalBuildService({ directory: f.directory, readOnly: true });
  try { assert.throws(() => readOnly.recordProgress({ ...request, stage: 'runner-process-exited' }), /BUILD_LEDGER_READ_ONLY/); }
  finally { readOnly.close(); }
  await f.service.transition({ scope: f.job, expectedVersion: 3, event: { status: 'failed', idempotencyKey: requestKey(92) } });
  assert.throws(() => f.service.recordProgress({ ...request, expectedVersion: 4 }), /BUILD_PROGRESS_NOT_RUNNING/);
});
test('quiet running builds emit elapsed heartbeat without claiming new output', async t => {
  const f = await controlFixture(t, "process.stdout.write('one');setInterval(()=>{},1000)"), events = [], abort = new AbortController();
  const task = run(f, { signal: abort.signal, onProgress: event => events.push(event) });
  await until(() => events.some(e => e.stage === 'executing' && e.stdoutBytes === 3));
  try {
    await until(() => { const active = events.filter(e => e.stage === 'executing' && e.stdoutBytes === 3); return active.length >= 2 && active.at(-1).elapsedMs - active[0].elapsedMs >= 750; });
    const live = events.filter(e => e.stage === 'executing' && e.stdoutBytes === 3);
    assert.ok(live.length >= 2); assert.equal(live.at(-1).lastOutputAt, live[0].lastOutputAt);
  } finally { abort.abort(); await task; }
});
test('explicit abort during verification cannot silently publish a successful artifact', async t => {
  const f = await controlFixture(t), abort = new AbortController();
  const result = await run(f, { signal: abort.signal, onProgress: event => { if (event.stage === 'verifying') abort.abort(); } });
  assert.equal(result.status, 'cancelled'); assert.equal(f.service.show(f.job).artifacts.length, 0);
});
test('stage audit survives validated backup and fresh-target restore without a schema migration', async t => {
  const f = await controlFixture(t); await run(f);
  const { backupLocalBuildState, restoreLocalBuildState } = await import('./local-build-backup.mjs');
  const backup = join(f.root, 'backup'), target = join(f.root, 'restored');
  await backupLocalBuildState({ directory: f.directory, target: backup });
  await restoreLocalBuildState({ directory: backup, target });
  const restored = await openLocalBuildService({ directory: target, readOnly: true });
  try {
    assert.equal(restored.show(f.job).job.status, 'succeeded');
    assert.equal(restored.history(f.job).filter(e => e.eventType.startsWith('runner-')).length, 4);
    assert.equal((await restored.doctor({ appId: f.job.appId })).ready, true);
  } finally { restored.close(); }
});
