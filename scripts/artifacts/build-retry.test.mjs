import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalBuildService } from './local-build-service.mjs';
const job = { appId: 'app-a', jobId: 'original', repository: 'owner/private', sourceSha: 'a'.repeat(40), platform: 'android', runnerId: 'pc-one' };
const key = n => n.toString(16).padStart(32, '0');
async function fixture(t, status = 'failed') {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'flora-retry-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'state'); const service = await openLocalBuildService({ directory, create: true }); t.after(() => service.close());
  service.create(job);
  for (const [i, s] of ['authorized', 'queued', ...(status === 'queued' ? [] : [status])].entries())
    await service.transition({ scope: job, expectedVersion: i, event: { status: s, idempotencyKey: key(i + 1) } });
  return { directory, service };
}
test('retry preserves failed history, resets approval, persists immutable lineage and replays after restart', async t => {
  const { directory, service } = await fixture(t); assert.equal(typeof service.retry, 'function');
  const original = service.show(job), history = service.history(job);
  const request = { scope: job, newJobId: 'retry-one', expectedVersion: 3, idempotencyKey: key(10) };
  const result = await service.retry(request); assert.equal(result.status, 'unconfigured'); assert.equal(result.version, 0);
  assert.equal(result.parentJobId, job.jobId); assert.equal(result.sourceSha, job.sourceSha); assert.equal(result.runnerId, job.runnerId);
  assert.deepEqual(service.show(job), original); assert.deepEqual(service.history(job), history);
  assert.equal(service.history(result)[0].eventType, 'retry-created'); service.close();
  const reopened = await openLocalBuildService({ directory }); t.after(() => reopened.close());
  assert.equal(reopened.show(result).job.parentJobId, job.jobId);
  assert.equal((await reopened.retry(request)).replayed, true);
  assert.equal(reopened.list({ appId: job.appId }).length, 2);
  await assert.rejects(reopened.retry({ ...request, newJobId: 'different' }), /BUILD_IDEMPOTENCY_CONFLICT/);
});
test('retry rejects ambiguous outcomes, stale versions, invalid target IDs and cross-app source', async t => {
  for (const status of ['queued', 'running', 'unknown']) {
    const { service } = await fixture(t, status); assert.equal(typeof service.retry, 'function');
    await assert.rejects(service.retry({ scope: job, newJobId: 'again', expectedVersion: service.show(job).job.version, idempotencyKey: key(20) }), /BUILD_RETRY_DENIED/);
  }
  const { service } = await fixture(t, 'cancelled');
  const request = { scope: job, newJobId: 'again', expectedVersion: 3, idempotencyKey: key(21) };
  await assert.rejects(service.retry({ ...request, expectedVersion: 2 }), /BUILD_VERSION_CONFLICT/);
  await assert.rejects(service.retry({ ...request, newJobId: '../bad' }), /BUILD_SCOPE_MISMATCH/);
  await assert.rejects(service.retry({ ...request, scope: { ...job, appId: 'other' } }), /BUILD_JOB_NOT_FOUND/);
  assert.equal((await service.retry(request)).status, 'unconfigured');
});
test('concurrent retry requests create exactly one child and conflicting IDs roll back atomically', async t => {
  const { service, directory } = await fixture(t); assert.equal(typeof service.retry, 'function');
  const other = await openLocalBuildService({ directory }); t.after(() => other.close());
  const request = { scope: job, newJobId: 'again', expectedVersion: 3, idempotencyKey: key(30) };
  const results = await Promise.all([service.retry(request), other.retry(request)]);
  assert.equal(results.filter(r => r.replayed).length, 1);
  await assert.rejects(other.retry({ ...request, idempotencyKey: key(31) }), /BUILD_JOB_ALREADY_EXISTS/);
  assert.equal(service.history({ ...job, jobId: 'again' }).length, 1);
});
test('overview covers every page and is isolated by app', async t => {
  const { service } = await fixture(t); assert.equal(typeof service.overview, 'function');
  for (let i = 0; i < 35; i++) service.create({ ...job, jobId: 'job-' + i });
  service.create({ ...job, appId: 'other' });
  const overview = service.overview({ appId: job.appId });
  assert.equal(overview.total, 36); assert.equal(overview.states.failed, 1); assert.equal(overview.states.unconfigured, 35);
  assert.equal(overview.artifacts, 0); assert.equal(overview.byteCount, 0);
  assert.equal(service.overview({ appId: 'other' }).total, 1);
  assert.equal(service.overview({ appId: 'empty' }).total, 0);
  assert.throws(() => service.overview({ appId: '../bad' }), /BUILD_QUERY_INVALID/);
});
test('search and status filtering include jobs beyond the first page and retain cursor boundaries', async t => {
  const { service } = await fixture(t);
  for (let i = 0; i < 35; i++) service.create({ ...job, jobId: `item-${String(i).padStart(2, '0')}` });
  assert.equal(service.list({ appId: job.appId, limit: 1, search: 'ITEM-34' })[0]?.jobId, 'item-34');
  assert.deepEqual(service.list({ appId: job.appId, status: 'failed' }).map(j => j.jobId), ['original']);
  assert.equal(service.list({ appId: job.appId, search: 'item', afterJobId: 'item-33', status: 'unconfigured' }).length, 1);
  assert.equal(service.list({ appId: job.appId, search: '%' }).length, 0);
  assert.throws(() => service.list({ appId: job.appId, status: 'forged' }), /BUILD_QUERY_INVALID/);
  assert.throws(() => service.list({ appId: job.appId, search: '\n' }), /BUILD_QUERY_INVALID/);
});
