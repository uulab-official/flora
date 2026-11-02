import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, stat, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalBuildService } from './local-build-service.mjs';
import { runBuildConsole } from './build-console.mjs';
test('console startup stores one-use approval privately, exposes no credential in URL, cleans up on close', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'flora-console-cli-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'state'), service = await openLocalBuildService({ directory, create: true }); service.close();
  const console = await runBuildConsole(['--state-dir', directory, '--apps', 'app-a']); t.after(() => console.close());
  const code = (await readFile(console.approvalFile, 'utf8')).trim(); assert.match(code, /^[a-f0-9]{48}$/);
  assert.equal((await stat(console.approvalFile)).mode & 0o777, 0o600);
  assert.equal(console.origin.includes(code), false);
  const login = await fetch(console.origin + '/api/session', { method: 'POST', headers: { origin: console.origin, 'content-type': 'application/json' }, body: JSON.stringify({ code }) }); assert.equal(login.status, 200);
  await console.close(); assert.equal((await readdir(directory)).some(n => n.startsWith('.console-approval-')), false);
});
test('invalid console arguments do not create a state directory or leave approval files', async () => {
  await assert.rejects(runBuildConsole(['--host', '0.0.0.0']), /BUILD_ARGUMENT_INVALID/);
  assert.match((await runBuildConsole(['--help'])).help, /--apps/);
});
