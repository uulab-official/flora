import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, chmod, mkdir, symlink, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDurableBuildLedger } from './durable-build-ledger.mjs';
const job = { appId: 'app-a', jobId: 'job-1', repository: 'owner/private', sourceSha: 'a'.repeat(40), platform: 'android', runnerId: 'runner-one' };
const key = digit => digit.repeat(32);
async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'flora-db-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory: join(root, 'state') };
}
const authorize = ledger => ledger.transition({ scope: job, expectedVersion: 0, event: { status: 'authorized', idempotencyKey: key('a') } });
test('missing state is not silently initialized by reads', async t => {
  const { directory } = await fixture(t);
  await assert.rejects(openDurableBuildLedger({ directory }), /BUILD_LEDGER_NOT_INITIALIZED/);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});
test('state, original replay and audit survive close and reopen', async t => {
  const { directory } = await fixture(t);
  let ledger = await openDurableBuildLedger({ directory, create: true });
  ledger.create({ ...job, token: 'DO_NOT_PERSIST' }); await authorize(ledger); ledger.close();
  ledger = await openDurableBuildLedger({ directory });
  try {
    assert.equal(ledger.get(job).status, 'authorized');
    assert.equal((await authorize(ledger)).replayed, true);
    assert.equal(ledger.history(job).length, 2);
    assert.equal(ledger.list({ appId: job.appId }).length, 1);
    assert.equal(ledger.list({ appId: 'another-app' }).length, 0);
    assert.equal(ledger.get(job).repository, job.repository);
    assert.equal((await readFile(join(directory, 'builds.sqlite'))).includes(Buffer.from('DO_NOT_PERSIST')), false);
  } finally { ledger.close(); }
});
test('CAS is enforced across independent connections', async t => {
  const { directory } = await fixture(t);
  const a = await openDurableBuildLedger({ directory, create: true }); a.create(job);
  const b = await openDurableBuildLedger({ directory });
  try {
    const results = await Promise.allSettled([authorize(a), b.transition({ scope: job, expectedVersion: 0,
      event: { status: 'authorized', idempotencyKey: key('b') } })]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.match(results.find(r => r.status === 'rejected').reason.message, /BUILD_VERSION_CONFLICT/);
    assert.equal(b.get(job).version, 1);
    assert.equal(b.history(job).length, 2);
  } finally { a.close(); b.close(); }
});
test('changed replay payload and version are rejected without extra audit rows', async t => {
  const { directory } = await fixture(t);
  const ledger = await openDurableBuildLedger({ directory, create: true });
  try {
    ledger.create(job); await authorize(ledger);
    for (const change of [{ expectedVersion: 1 }, { event: { status: 'queued', idempotencyKey: key('a') } },
      { event: { status: 'authorized', idempotencyKey: key('a'), executionVerified: true } }]) {
      await assert.rejects(ledger.transition({ scope: job, expectedVersion: 0,
        event: { status: 'authorized', idempotencyKey: key('a') }, ...change }), /BUILD_IDEMPOTENCY_CONFLICT/);
    }
    assert.equal(ledger.history(job).length, 2);
  } finally { ledger.close(); }
});
test('jobs are scoped and immutable; malformed IDs and source context are rejected', async t => {
  const { directory } = await fixture(t); const ledger = await openDurableBuildLedger({ directory, create: true });
  try {
    for (const change of [{ appId: 12 }, { sourceSha: 'main' }, { repository: '../app' }, { platform: 'web' }, { runnerId: '' }])
      assert.throws(() => ledger.create({ ...job, ...change }), /BUILD_JOB_CONTEXT_INVALID|BUILD_SCOPE_MISMATCH/);
    ledger.create(job); ledger.create({ ...job, appId: 'app-b' }); await authorize(ledger);
    assert.throws(() => ledger.create({ ...job, sourceSha: 'b'.repeat(40) }), /BUILD_JOB_ALREADY_EXISTS/);
    assert.equal(ledger.get({ ...job, appId: 'app-b' }).version, 0);
    assert.throws(() => ledger.get({ ...job, jobId: 'missing' }), /BUILD_JOB_NOT_FOUND/);
    assert.throws(() => { ledger.get(job).repository = 'attacker/repo'; }, TypeError);
  } finally { ledger.close(); }
});
test('a success boolean alone cannot complete a durable job', async t => {
  const { directory } = await fixture(t); const ledger = await openDurableBuildLedger({ directory, create: true });
  try {
    ledger.create(job); await authorize(ledger);
    await assert.rejects(ledger.transition({ scope: job, expectedVersion: 1,
      event: { status: 'succeeded', idempotencyKey: key('c'), artifactIntegrityVerified: true, executionVerified: true } }), /BUILD_COMPLETION_REQUIRED/);
    assert.equal(ledger.get(job).version, 1);
  } finally { ledger.close(); }
});
test('cancelled and unknown states persist and are not auto-retried', async t => {
  const { directory } = await fixture(t); let ledger = await openDurableBuildLedger({ directory, create: true });
  ledger.create(job); await authorize(ledger);
  await ledger.transition({ scope: job, expectedVersion: 1, event: { status: 'queued', idempotencyKey: key('b') } });
  await ledger.transition({ scope: job, expectedVersion: 2, event: { status: 'unknown', idempotencyKey: key('c') } }); ledger.close();
  ledger = await openDurableBuildLedger({ directory });
  try {
    assert.equal(ledger.diagnostics().states.unknown, 1);
    assert.equal(ledger.get(job).status, 'unknown');
    await ledger.transition({ scope: job, expectedVersion: 3, event: { status: 'cancelled', idempotencyKey: key('d') } });
    await assert.rejects(ledger.transition({ scope: job, expectedVersion: 4, event: { status: 'running', idempotencyKey: key('e') } }), /BUILD_TRANSITION_DENIED/);
  } finally { ledger.close(); }
});
test('private owner-only state, database and symlink checks fail closed', async t => {
  const { root, directory } = await fixture(t); const ledger = await openDurableBuildLedger({ directory, create: true }); ledger.close();
  assert.equal((await stat(directory)).mode & 0o077, 0);
  assert.equal((await stat(join(directory, 'builds.sqlite'))).mode & 0o077, 0);
  await chmod(directory, 0o755);
  await assert.rejects(openDurableBuildLedger({ directory }), /BUILD_DIRECTORY_UNSAFE/);
  await chmod(directory, 0o700);
  const alias = join(root, 'alias'); await symlink(directory, alias);
  await assert.rejects(openDurableBuildLedger({ directory: alias }), /BUILD_DIRECTORY_UNSAFE/);
  await chmod(join(directory, 'builds.sqlite'), 0o644);
  await assert.rejects(openDurableBuildLedger({ directory }), /BUILD_DATABASE_UNSAFE/);
});
test('unknown future schema is rejected without changing database bytes', async t => {
  const { directory } = await fixture(t); const ledger = await openDurableBuildLedger({ directory, create: true }); ledger.close();
  const dbPath = join(directory, 'builds.sqlite'), db = new DatabaseSync(dbPath);
  db.exec('PRAGMA user_version=99'); db.close();
  const before = await readFile(dbPath);
  await assert.rejects(openDurableBuildLedger({ directory }), /BUILD_SCHEMA_UNSUPPORTED/);
  assert.deepEqual(await readFile(dbPath), before);
});
test('foreign SQLite database is never initialized as Flora', async t => {
  const { directory } = await fixture(t); await mkdir(directory, { mode: 0o700 });
  const dbPath = join(directory, 'builds.sqlite'), db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE precious(value TEXT); INSERT INTO precious VALUES (\'keep\')'); db.close(); await chmod(dbPath, 0o600);
  const before = await readFile(dbPath);
  await assert.rejects(openDurableBuildLedger({ directory, create: true }), /BUILD_SCHEMA_UNSUPPORTED/);
  assert.deepEqual(await readFile(dbPath), before);
});
test('query limits and use after close are rejected', async t => {
  const { directory } = await fixture(t); const ledger = await openDurableBuildLedger({ directory, create: true }); ledger.create(job);
  assert.throws(() => ledger.list({ appId: job.appId, limit: 0 }), /BUILD_QUERY_INVALID/);
  assert.throws(() => ledger.history(job, { limit: 1001 }), /BUILD_QUERY_INVALID/);
  ledger.close(); ledger.close();
  assert.throws(() => ledger.get(job), /BUILD_LEDGER_CLOSED/);
});
