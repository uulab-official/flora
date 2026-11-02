import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDurableBuildLedger } from './durable-build-ledger.mjs';
const moduleUrl = new URL('./durable-build-ledger.mjs', import.meta.url).href;
const job = { appId: 'process-app', jobId: 'job-one', repository: 'owner/app', sourceSha: 'a'.repeat(40), platform: 'android', runnerId: 'runner-one' };
async function setup(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'flora-process-')), directory = join(root, 'state');
  const ledger = await openDurableBuildLedger({ directory, create: true }); ledger.create(job); ledger.close();
  t.after(() => rm(root, { recursive: true, force: true })); return directory;
}
function child(t, script) {
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  process.stderr.on('data', () => {}); // Node's SQLite experimental notice, not application output.
  const closed = once(process, 'close');
  t.after(async () => { if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); await closed; });
  return { process, ready: once(process, 'message'), closed };
}
test('competing separate processes commit one version exactly once', { timeout: 15000 }, async t => {
  const directory = await setup(t);
  const children = ['a', 'b'].map(key => child(t, `
    import { openDurableBuildLedger } from ${JSON.stringify(moduleUrl)};
    const ledger = await openDurableBuildLedger({ directory: ${JSON.stringify(directory)} });
    process.once('message', async () => {
      try { const result = await ledger.transition({ scope: ${JSON.stringify(job)}, expectedVersion: 0,
        event: { status: 'authorized', idempotencyKey: '${key}'.repeat(32) } }); process.send({ ok: true, version: result.version }); }
      catch (error) { process.send({ ok: false, code: error.message }); }
      finally { ledger.close(); process.disconnect(); }
    });
    process.send({ ready: true });
  `));
  await Promise.all(children.map(c => c.ready));
  const replies = children.map(c => once(c.process, 'message')); children.forEach(c => c.process.send('go'));
  const results = (await Promise.all(replies)).map(([value]) => value);
  await Promise.all(children.map(c => c.closed));
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(results.find(r => !r.ok).code, 'BUILD_VERSION_CONFLICT');
  const reopened = await openDurableBuildLedger({ directory });
  try { assert.equal(reopened.get(job).version, 1); assert.equal(reopened.history(job).length, 2); }
  finally { reopened.close(); }
});
test('SIGKILL before SQLite COMMIT restores the last committed job and audit', { timeout: 15000 }, async t => {
  const directory = await setup(t);
  const worker = child(t, `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(${JSON.stringify(join(directory, 'builds.sqlite'))});
    db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    db.prepare('UPDATE jobs SET version=99,state=? WHERE app_id=? AND job_id=?')
      .run(JSON.stringify({ appId:'process-app',jobId:'job-one',version:99,status:'succeeded' }), 'process-app', 'job-one');
    process.send({ dirtyTransaction: true }); setInterval(() => {}, 1000);
  `);
  const [message] = await worker.ready; assert.equal(message.dirtyTransaction, true);
  worker.process.kill('SIGKILL'); await worker.closed;
  const reopened = await openDurableBuildLedger({ directory });
  try {
    assert.equal(reopened.get(job).status, 'unconfigured'); assert.equal(reopened.get(job).version, 0);
    assert.equal(reopened.history(job).length, 1); assert.equal(reopened.diagnostics().databaseIntegrity, true);
  } finally { reopened.close(); }
});
