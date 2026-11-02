import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, readFile, readdir, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openLocalBuildService } from './local-build-service.mjs';
const job = { appId: 'app-a', jobId: 'job-one', repository: 'owner/private', sourceSha: 'a'.repeat(40), platform: 'android', runnerId: 'runner-one' };
async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'flora-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'state'), sourcePath = join(root, 'fixture.apk'), bytes = Buffer.from('unsigned synthetic payload');
  await writeFile(sourcePath, bytes);
  const service = await openLocalBuildService({ directory, create: true });
  t.after(() => service.close());
  service.create(job);
  for (const [index, status] of ['authorized', 'queued', 'running'].entries())
    await service.transition({ scope: job, expectedVersion: index, event: { status, idempotencyKey: String(index + 1).repeat(32) } });
  const manifest = { ...job, byteCount: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  return { service, root, directory, sourcePath, bytes, input: { scope: job, expectedVersion: 3, idempotencyKey: '4'.repeat(32),
    manifest, execution: { ...job, exitCode: 0 }, format: 'apk', sourcePath } };
}
test('finalization, history and verified export work after a full service restart', async t => {
  const f = await fixture(t), result = await f.service.complete(f.input);
  assert.equal(result.status, 'succeeded'); assert.equal(result.version, 4);
  assert.equal(result.artifact.signatureVerified, false); assert.equal(result.artifact.installVerified, false);
  assert.equal(JSON.stringify(result).includes(f.root), false);
  f.service.close(); const reopened = await openLocalBuildService({ directory: f.directory });
  try {
    assert.equal(reopened.show(job).artifacts.length, 1);
    assert.equal(reopened.history(job).length, 5);
    const targetPath = join(f.root, 'download.apk');
    await reopened.export({ scope: job, artifactId: result.artifact.artifactId, targetPath });
    assert.deepEqual(await readFile(targetPath), f.bytes);
    assert.equal((await reopened.doctor()).ready, true);
  } finally { reopened.close(); }
});
test('replaying a completed report does not need the source or create extra files', async t => {
  const f = await fixture(t), first = await f.service.complete(f.input); await rm(f.sourcePath);
  const retry = await f.service.complete(f.input);
  assert.equal(retry.replayed, true); assert.equal(retry.artifact.artifactId, first.artifact.artifactId);
  assert.equal((await readdir(join(f.directory, 'artifacts', job.appId, job.jobId))).length, 1);
  await assert.rejects(f.service.complete({ ...f.input, format: 'aab' }), /BUILD_IDEMPOTENCY_CONFLICT/);
});
test('parallel identical reports settle on one durable artifact', async t => {
  const f = await fixture(t); const results = await Promise.all([f.service.complete(f.input), f.service.complete(f.input)]);
  assert.equal(results[0].artifact.artifactId, results[1].artifact.artifactId);
  assert.equal(f.service.show(job).artifacts.length, 1);
  assert.equal((await readdir(join(f.directory, 'artifacts', job.appId, job.jobId))).length, 1);
});
test('parallel different completion keys cannot finish one version twice', async t => {
  const f = await fixture(t), results = await Promise.allSettled([f.service.complete(f.input),
    f.service.complete({ ...f.input, idempotencyKey: '5'.repeat(32) })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /BUILD_VERSION_CONFLICT/);
  assert.equal(f.service.show(job).artifacts.length, 1);
  assert.equal((await f.service.doctor()).ready, true);
});
test('failed or wrong-runner execution cannot register success or an artifact', async t => {
  const f = await fixture(t);
  for (const change of [{ exitCode: 1 }, { runnerId: 'another' }, { sourceSha: 'b'.repeat(40) }])
    await assert.rejects(f.service.complete({ ...f.input, execution: { ...f.input.execution, ...change } }), /BUILD_EXECUTION_MISMATCH/);
  assert.equal(f.service.show(job).job.status, 'running'); assert.equal(f.service.show(job).artifacts.length, 0);
});
test('wrong artifact scope and wrong platform format fail before publication', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.complete({ ...f.input, manifest: { ...f.input.manifest, appId: 'other' } }), /ARTIFACT_SCOPE_MISMATCH/);
  await assert.rejects(f.service.complete({ ...f.input, format: 'ipa' }), /BUILD_ARTIFACT_FORMAT_INVALID/);
  assert.equal(f.service.show(job).job.version, 3);
});
test('cross-app export is rejected and existing destination is preserved', async t => {
  const f = await fixture(t), result = await f.service.complete(f.input), targetPath = join(f.root, 'keep.apk');
  await writeFile(targetPath, 'keep');
  await assert.rejects(f.service.export({ scope: { ...job, appId: 'other' }, artifactId: result.artifact.artifactId, targetPath }), /BUILD_JOB_NOT_FOUND|BUILD_ARTIFACT_NOT_FOUND/);
  await assert.rejects(f.service.export({ scope: job, artifactId: result.artifact.artifactId, targetPath }), /ARTIFACT_DESTINATION_EXISTS/);
  assert.equal(await readFile(targetPath, 'utf8'), 'keep');
});
test('tampered persisted bytes are blocked on export and surfaced by doctor', async t => {
  const f = await fixture(t), result = await f.service.complete(f.input);
  const path = join(f.directory, 'artifacts', job.appId, job.jobId, result.artifact.artifactId + '.bin');
  await writeFile(path, Buffer.alloc(f.bytes.length, 99));
  const targetPath = join(f.root, 'bad.apk');
  await assert.rejects(f.service.export({ scope: job, artifactId: result.artifact.artifactId, targetPath }), /ARTIFACT_HASH_MISMATCH/);
  await assert.rejects(stat(targetPath), { code: 'ENOENT' });
  const report = await f.service.doctor(); assert.equal(report.ready, false);
  assert.ok(report.issues.some(issue => issue.code === 'ARTIFACT_HASH_MISMATCH'));
});
test('doctor diagnoses pre-commit leftovers without deleting them', async t => {
  const f = await fixture(t), dir = join(f.directory, 'artifacts', job.appId, job.jobId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const orphan = join(dir, 'a'.repeat(24) + '.bin'); await writeFile(orphan, 'orphan', { mode: 0o600 });
  const partial = join(dir, '.unfinished.partial'); await writeFile(partial, 'partial', { mode: 0o600 });
  const report = await f.service.doctor(); assert.equal(report.ready, false);
  assert.ok(report.issues.some(i => i.code === 'ARTIFACT_UNREFERENCED'));
  assert.ok(report.issues.some(i => i.code === 'ARTIFACT_PARTIAL_REMAINS'));
  assert.equal(await readFile(orphan, 'utf8'), 'orphan'); assert.equal(await readFile(partial, 'utf8'), 'partial');
});
test('doctor reports an incomplete scan when the verification byte budget is reached', async t => {
  const f = await fixture(t); await f.service.complete(f.input);
  const report = await f.service.doctor({ maxBytes: 1 });
  assert.equal(report.complete, false); assert.equal(report.ready, false);
});

test('cancellation during publication wins and does not leak an unreferenced artifact', async t => {
  const f = await fixture(t), pending = f.service.complete(f.input);
  await f.service.transition({ scope: job, expectedVersion: 3, event: { status: 'cancelled', idempotencyKey: '5'.repeat(32) } });
  await assert.rejects(pending, /BUILD_VERSION_CONFLICT/);
  assert.equal(f.service.show(job).job.status, 'cancelled');
  assert.equal(f.service.show(job).artifacts.length, 0);
  assert.equal((await f.service.doctor()).ready, true);
});
test('an unknown outcome only completes with an explicit matching runner report', async t => {
  const f = await fixture(t);
  await f.service.transition({ scope: job, expectedVersion: 3, event: { status: 'unknown', idempotencyKey: '5'.repeat(32) } });
  assert.equal((await f.service.doctor()).ready, false);
  const result = await f.service.complete({ ...f.input, expectedVersion: 4 });
  assert.equal(result.status, 'succeeded'); assert.equal(result.version, 5);
});
