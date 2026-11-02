import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startBuildConsole } from './build-console-server.mjs';
import { controlFixture, until, requestKey } from './control-fixture.mjs';
const exec = promisify(execFile), base = '/api/jobs/app-a/job-one';
const input = () => ({ presetId: 'android-preview', expectedVersion: 2 });
async function setup(t, { enabled = true, script } = {}) {
  const f = await controlFixture(t, script); let clock = Date.now();
  const server = await startBuildConsole({ directory: f.directory, appIds: ['app-a'], approvalCode: 'a'.repeat(48), now: () => clock,
    ...(enabled ? { enableExecution: true, presets: f.presets } : {}) }); f.closers.push(() => server.close());
  const login = await fetch(server.origin + '/api/session', { method: 'POST', headers: { origin: server.origin, 'content-type': 'application/json' }, body: JSON.stringify({ code: 'a'.repeat(48) }) });
  const auth = await login.json();
  const headers = { origin: server.origin, 'content-type': 'application/json', cookie: login.headers.get('set-cookie').split(';')[0], 'x-flora-csrf': auth.csrf };
  const call = (path, data, overrides = {}) => fetch(server.origin + path, { method: data ? 'POST' : 'GET', headers: { ...headers, ...overrides }, ...(data ? { body: JSON.stringify(data) } : {}) });
  return { ...f, server, call, headers, advance: n => { clock += n; } };
}
test('authenticated preflight is read-only, then actual execution exposes numeric activity and a verified download', async t => {
  const f = await setup(t), db = await readFile(join(f.directory, 'builds.sqlite'));
  const response = await f.call(base + '/preflight', input()); assert.equal(response.status, 200);
  const report = await response.json(); assert.equal(report.ready, true); assert.equal(report.presetId, 'android-preview');
  assert.equal(JSON.stringify(report).includes(f.root), false); assert.deepEqual(await readFile(join(f.directory, 'builds.sqlite')), db);
  assert.equal((await f.call(base + '/execute', { ...input(), idempotencyKey: requestKey(98) })).status, 202);
  await until(() => f.service.show(f.job).job.status === 'succeeded');
  const control = await (await f.call(base + '/execution')).json(); assert.equal(control.execution.activity.stage, 'finished');
  const { artifactId } = f.service.show(f.job).artifacts[0];
  const { ticket } = await (await f.call(base + '/downloads', { artifactId })).json();
  const download = await f.call('/api/download', { ticket }); assert.equal(download.status, 200); assert.equal(await download.text(), 'synthetic control build');
});
test('preflight enforces authentication, CSRF, app boundary, registered presets and narrow fields', async t => {
  const f = await setup(t);
  assert.equal((await f.call(base + '/preflight', input(), { cookie: '' })).status, 401);
  assert.equal((await f.call(base + '/preflight', input(), { 'x-flora-csrf': '' })).status, 403);
  assert.equal((await f.call('/api/jobs/other/job-one/preflight', input())).status, 403);
  assert.equal((await f.call(base + '/preflight', { ...input(), executable: '/bin/sh' })).status, 400);
  assert.equal((await f.call(base + '/preflight', { ...input(), presetId: 'missing' })).status, 404);
  f.advance(3000);
  const stale = await (await f.call(base + '/preflight', { ...input(), expectedVersion: 1 })).json();
  assert.equal(stale.ready, false); assert.ok(stale.checks.some(c => c.code === 'BUILD_VERSION_CONFLICT'));
  assert.equal(f.service.show(f.job).job.status, 'queued');
});
test('preflight is bounded against concurrent and immediate repeat scans', async t => {
  const f = await setup(t);
  const results = await Promise.all([f.call(base + '/preflight', input()), f.call(base + '/preflight', input())]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 429]);
  assert.equal((await f.call(base + '/preflight', input())).status, 429);
  f.advance(3000); assert.equal((await f.call(base + '/preflight', input())).status, 200);
});
test('preflight remains unavailable without explicit operator execution configuration', async t => {
  const f = await setup(t, { enabled: false }); assert.equal((await f.call(base + '/preflight', input())).status, 409);
});
test('CLI preflight runs from another process, returns meaningful exit codes and preserves the ledger', async t => {
  const f = await controlFixture(t), recipe = join(f.root, 'private-recipe.json');
  await writeFile(recipe, JSON.stringify(f.recipe), { mode: 0o600 });
  const args = ['scripts/artifacts/build-ops.mjs', 'preflight', '--state-dir', f.directory, '--app', f.job.appId, '--job', f.job.jobId, '--recipe', recipe, '--expected-version', '2'];
  const first = await exec(process.execPath, args); assert.equal(JSON.parse(first.stdout).result.ready, true);
  await writeFile(f.recipe.artifactPath, 'keep');
  await assert.rejects(exec(process.execPath, args), error => { assert.equal(error.code, 1); const r = JSON.parse(error.stdout); assert.equal(r.ok, false); assert.equal(r.result.ready, false); return true; });
  assert.equal(f.service.show(f.job).job.status, 'queued');
});
test('console supplies a guarded preflight dialog and raw-log-free activity panel', async () => {
  const html = await readFile(new URL('./console/index.html', import.meta.url), 'utf8'), js = await readFile(new URL('./console/console.mjs', import.meta.url), 'utf8');
  for (const id of ['run-preflight', 'run-preflight-status', 'run-preflight-checks', 'run-confirm', 'build-activity']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(js.includes('/preflight')); assert.ok(js.includes('intent !== state.intent')); assert.ok(js.includes('stdoutBytes'));
});
