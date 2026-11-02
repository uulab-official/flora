import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, chmod, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { startBuildConsole } from './build-console-server.mjs';
import { runBuildConsole } from './build-console.mjs';
import { controlFixture, until, requestKey } from './control-fixture.mjs';
async function consoleFixture(t, script, enabled = true) {
  const f = await controlFixture(t, script);
  const console = await startBuildConsole({ directory: f.directory, appIds: ['app-a'], approvalCode: 'a'.repeat(48),
    ...(enabled ? { presets: f.presets, enableExecution: true } : {}) }); f.closers.push(() => console.close());
  const authResponse = await fetch(console.origin + '/api/session', { method: 'POST', headers: { origin: console.origin, 'content-type': 'application/json' }, body: JSON.stringify({ code: 'a'.repeat(48) }) });
  const auth = await authResponse.json(), headers = { origin: console.origin, cookie: authResponse.headers.get('set-cookie').split(';')[0], 'x-flora-csrf': auth.csrf, 'content-type': 'application/json' };
  const call = (path, body) => fetch(console.origin + path, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { ...f, console, headers, call, path: '/api/jobs/app-a/job-one' };
}
const start = () => ({ presetId: 'android-preview', expectedVersion: 2, idempotencyKey: requestKey(10) });
test('HTTP preset run executes actual process, persists success and downloads identical bytes', async t => {
  const f = await consoleFixture(t);
  const catalog = await f.call('/api/presets?app=app-a'); assert.equal(catalog.status, 200);
  const text = await catalog.text(); assert.equal(text.includes(f.cwd), false); assert.equal(text.includes('executable'), false);
  const result = await f.call(f.path + '/execute', start()); assert.equal(result.status, 202);
  const accepted = await result.json(); assert.equal((await (await f.call(f.path + '/execute', start())).json()).id, accepted.id);
  await until(() => f.service.show(f.job).job.status === 'succeeded');
  const { artifactId } = f.service.show(f.job).artifacts[0];
  const { ticket } = await (await f.call(f.path + '/downloads', { artifactId })).json();
  const bytes = await f.call('/api/download', { ticket }); assert.equal(bytes.status, 200);
  assert.equal(Buffer.from(await bytes.arrayBuffer()).toString(), 'synthetic control build');
  const overview = await (await f.call('/api/overview?app=app-a')).json();
  assert.equal(overview.states.succeeded, 1); assert.equal(overview.artifacts, 1); assert.ok(overview.byteCount > 0);
});
test('HTTP execution remains disabled without operator opt-in', async t => {
  const f = await consoleFixture(t, undefined, false);
  const catalog = await f.call('/api/presets?app=app-a'); assert.equal(catalog.status, 200); assert.equal((await catalog.json()).enabled, false);
  assert.equal((await f.call(f.path + '/execute', start())).status, 409); assert.equal(f.service.show(f.job).job.status, 'queued');
});
test('HTTP new operations enforce CSRF, app scope, no commands and version guards', async t => {
  const f = await consoleFixture(t);
  assert.equal((await f.call(f.path + '/execute', { ...start(), args: ['evil'] })).status, 400);
  assert.equal((await f.call(f.path + '/execute', { ...start(), expectedVersion: 1 })).status, 409);
  for (const path of ['/api/presets?app=other', '/api/overview?app=other', '/api/jobs/other/job-one/execution']) assert.equal((await f.call(path)).status, 403);
  const headers = { ...f.headers }; delete headers['x-flora-csrf'];
  assert.equal((await fetch(f.console.origin + f.path + '/execute', { method: 'POST', headers, body: JSON.stringify(start()) })).status, 403);
  assert.equal(f.service.show(f.job).job.status, 'queued');
});
test('HTTP stop is not a fake cancellation and retry resets approval while preserving lineage', async t => {
  const f = await consoleFixture(t, 'setInterval(()=>{},1000)');
  assert.equal((await f.call(f.path + '/execute', start())).status, 202);
  await until(() => f.service.show(f.job).job.status === 'running');
  const stopping = await f.call(f.path + '/stop', { expectedVersion: 3 }); assert.equal(stopping.status, 202); assert.equal((await stopping.json()).phase, 'stopping');
  await until(() => f.service.show(f.job).job.status === 'cancelled');
  const retry = { newJobId: 'retry-two', expectedVersion: 4, idempotencyKey: requestKey(40) };
  const response = await f.call(f.path + '/retry', retry); assert.equal(response.status, 201);
  const child = await response.json(); assert.equal(child.parentJobId, 'job-one'); assert.equal(child.status, 'unconfigured');
  assert.equal((await (await f.call(f.path + '/retry', retry)).json()).replayed, true);
  assert.equal(f.service.show(f.job).job.status, 'cancelled');
});
test('closing HTTP console stops managed command and drains before returning', async t => {
  const f = await consoleFixture(t, 'setInterval(()=>{},1000)'); assert.equal((await f.call(f.path + '/execute', start())).status, 202);
  await until(() => f.service.show(f.job).job.status === 'running'); await f.console.close();
  assert.equal(f.service.show(f.job).job.status, 'cancelled'); assert.equal((await readdir(f.directory)).some(n => n.startsWith('.runner-lock-')), false);
});
test('CLI requires explicit private preset enablement and validates before issuing approval', async t => {
  const f = await controlFixture(t), path = join(f.root, 'presets.json');
  await writeFile(path, JSON.stringify({ presets: f.presets }), { mode: 0o600 });
  const base = ['--state-dir', f.directory, '--apps', 'app-a'];
  await assert.rejects(runBuildConsole([...base, '--presets', path]), /BUILD_EXECUTE_REQUIRED/);
  await assert.rejects(runBuildConsole([...base, '--enable-execution']), /BUILD_EXECUTE_REQUIRED/);
  await chmod(path, 0o644);
  await assert.rejects(runBuildConsole([...base, '--presets', path, '--enable-execution']), /BUILD_INPUT_UNSAFE/);
  assert.equal((await readdir(f.directory)).some(n => n.startsWith('.console-approval-')), false);
  await chmod(path, 0o600);
  const console = await runBuildConsole([...base, '--presets', path, '--enable-execution']); f.closers.push(() => console.close());
  assert.equal(console.executionEnabled, true); assert.equal((await readFile(console.approvalFile, 'utf8')).trim().length, 48);
});
test('HTTP job filters search the entire app and reject invalid status', async t => {
  const f = await consoleFixture(t, undefined, false);
  for (let i = 0; i < 30; i++) f.service.create({ ...f.job, jobId: `row-${String(i).padStart(2, '0')}` });
  const response = await f.call('/api/jobs?app=app-a&search=row-29&status=unconfigured&limit=1'); assert.equal(response.status, 200);
  assert.equal((await response.json()).jobs[0].jobId, 'row-29');
  assert.equal((await f.call('/api/jobs?app=app-a&status=forged')).status, 400);
});
