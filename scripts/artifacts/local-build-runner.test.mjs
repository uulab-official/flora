import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openLocalBuildService } from './local-build-service.mjs';
const runner = await import('./local-build-runner.mjs').catch(() => ({}));
async function fixture(t, script = "require('node:fs').writeFileSync('result.apk','synthetic build output')") {
  assert.equal(typeof runner.runLocalBuild, 'function', 'trusted runner API must exist');
  const root = await mkdtemp(join(await realpath(tmpdir()), 'flora-runner-')); t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo'); const { mkdir } = await import('node:fs/promises'); await mkdir(cwd, { mode: 0o700 });
  const git = (...args) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await writeFile(join(cwd, 'build.cjs'), script); git('add', 'build.cjs'); git('commit', '-qm', 'fixture');
  const job = { appId: 'app-a', jobId: 'job-one', repository: 'owner/private', sourceSha: git('rev-parse', 'HEAD'), platform: 'android', runnerId: 'runner-one' };
  const directory = join(root, 'state'), service = await openLocalBuildService({ directory, create: true }); t.after(() => service.close()); service.create(job);
  for (const [i, status] of ['authorized', 'queued'].entries()) await service.transition({ scope: job, expectedVersion: i, event: { status, idempotencyKey: String(i + 1).repeat(32) } });
  const recipe = { appId: job.appId, repository: job.repository, runnerId: job.runnerId, platform: job.platform, cwd,
    executable: process.execPath, args: ['build.cjs'], artifactPath: join(cwd, 'result.apk'), format: 'apk', timeoutMs: 5000 };
  return { root, cwd, directory, service, job, recipe, git };
}
test('explicit trusted command executes and persists verified output; service exports identical bytes', async t => {
  const f = await fixture(t);
  await assert.rejects(runner.runLocalBuild({ directory: f.directory, scope: f.job, recipe: f.recipe }), /BUILD_EXECUTE_REQUIRED/);
  assert.equal(f.service.show(f.job).job.status, 'queued');
  const result = await runner.runLocalBuild({ directory: f.directory, scope: f.job, recipe: f.recipe, execute: true });
  assert.equal(result.status, 'succeeded'); assert.equal(result.signatureVerified, false); assert.equal(result.installVerified, false);
  assert.equal(f.service.show(f.job).artifacts.length, 1);
  const targetPath = join(f.root, 'export.apk'); await f.service.export({ scope: f.job, artifactId: result.artifact.artifactId, targetPath });
  assert.equal(await readFile(targetPath, 'utf8'), 'synthetic build output');
  assert.equal((await readdir(f.directory)).some(n => n.startsWith('.runner-lock-')), false);
});
test('wrong recipe binding, source SHA or tracked dirty source never starts a build', async t => {
  const f = await fixture(t);
  for (const recipe of [{ ...f.recipe, runnerId: 'wrong' }, { ...f.recipe, platform: 'ios' }, { ...f.recipe, repository: 'other/repo' }])
    await assert.rejects(runner.runLocalBuild({ directory: f.directory, scope: f.job, recipe, execute: true }), /BUILD_RECIPE_SCOPE_MISMATCH/);
  await writeFile(join(f.cwd, 'build.cjs'), 'process.exit(0)');
  await assert.rejects(runner.runLocalBuild({ directory: f.directory, scope: f.job, recipe: f.recipe, execute: true }), /BUILD_SOURCE_DIRTY/);
  f.git('add', 'build.cjs'); f.git('commit', '-qm', 'changed');
  await assert.rejects(runner.runLocalBuild({ directory: f.directory, scope: f.job, recipe: f.recipe, execute: true }), /BUILD_SOURCE_SHA_MISMATCH/);
  assert.equal(f.service.show(f.job).job.status, 'queued');
});
test('nonzero exit is failed, output is not registered, raw logs are not leaked', async t => {
  const f = await fixture(t, "console.error('secret-test-token');process.exit(3)");
  const result = await runner.runLocalBuild({ directory: f.directory, scope: f.job, recipe: f.recipe, execute: true });
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'BUILD_PROCESS_FAILED');
  assert.equal(JSON.stringify(result).includes('secret-test-token'), false); assert.equal(f.service.show(f.job).artifacts.length, 0);
});
test('timeout terminates the child process and records failure', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000)');
  const result = await runner.runLocalBuild({ directory: f.directory, scope: f.job, recipe: { ...f.recipe, timeoutMs: 120 }, execute: true });
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'BUILD_PROCESS_TIMEOUT');
});
test('explicit abort is cancelled only after the process has stopped', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000)'), controller = new AbortController();
  const run = runner.runLocalBuild({ directory: f.directory, scope: f.job, recipe: f.recipe, execute: true, signal: controller.signal });
  const timer = setInterval(() => { if (f.service.show(f.job).job.status === 'running') controller.abort(); }, 10);
  try { const result = await run; assert.equal(result.status, 'cancelled'); } finally { clearInterval(timer); }
});
test('pre-existing output is not silently reused and browser-like unknown recipe fields are rejected', async t => {
  const f = await fixture(t); await writeFile(f.recipe.artifactPath, 'old');
  await assert.rejects(runner.runLocalBuild({ directory: f.directory, scope: f.job, recipe: f.recipe, execute: true }), /BUILD_OUTPUT_EXISTS/);
  await assert.rejects(runner.runLocalBuild({ directory: f.directory, scope: f.job, recipe: { ...f.recipe, shell: true }, execute: true }), /BUILD_RECIPE_INVALID/);
});
test('concurrent runners sharing a checkout cannot both execute', async t => {
  const f = await fixture(t, "setTimeout(()=>require('node:fs').writeFileSync('result.apk','output'),100)");
  const outcomes = await Promise.allSettled([1, 2].map(() => runner.runLocalBuild({ directory: f.directory, scope: f.job, recipe: f.recipe, execute: true })));
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  assert.match(outcomes.find(o => o.status === 'rejected').reason.message, /BUILD_RUNNER_LOCKED|BUILD_VERSION_CONFLICT|BUILD_NOT_QUEUED/);
  assert.equal(f.service.show(f.job).artifacts.length, 1);
});
test('excessive output and missing output are failures, not successful builds', async t => {
  const f = await fixture(t, "process.stdout.write('x'.repeat(300000));setInterval(()=>{},1000)");
  const result = await runner.runLocalBuild({ directory: f.directory, scope: f.job, recipe: f.recipe, execute: true });
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'BUILD_PROCESS_OUTPUT_LIMIT');
});
test('zero exit without an artifact is unknown and requires reconciliation, not success', async t => {
  const f = await fixture(t, 'process.exit(0)');
  const result = await runner.runLocalBuild({ directory: f.directory, scope: f.job, recipe: f.recipe, execute: true });
  assert.equal(result.status, 'unknown'); assert.equal(result.reason, 'BUILD_RESULT_RECONCILIATION_REQUIRED');
  assert.equal(f.service.show(f.job).artifacts.length, 0);
});
test('an untracked source file blocks execution before claiming queued work', async t => {
  const f = await fixture(t); await writeFile(join(f.cwd, 'unexpected.cjs'), 'secret');
  await assert.rejects(runner.runLocalBuild({ directory: f.directory, scope: f.job, recipe: f.recipe, execute: true }), /BUILD_SOURCE_DIRTY/);
  assert.equal(f.service.show(f.job).job.status, 'queued');
});
test('web queue -> actual process -> durable success -> single-use HTTP download', async t => {
  const f = await fixture(t);
  const { startBuildConsole } = await import('./build-console-server.mjs');
  const console = await startBuildConsole({ directory: f.directory, appIds: [f.job.appId], approvalCode: 'a'.repeat(48) }); t.after(() => console.close());
  const response = await fetch(console.origin + '/api/session', { method: 'POST', headers: { origin: console.origin, 'content-type': 'application/json' }, body: JSON.stringify({ code: 'a'.repeat(48) }) });
  const auth = await response.json(), headers = { origin: console.origin, cookie: response.headers.get('set-cookie').split(';')[0], 'x-flora-csrf': auth.csrf, 'content-type': 'application/json' };
  const queuedJob = { ...f.job, jobId: 'web-queued-001' };
  const created = await fetch(console.origin + '/api/jobs', { method: 'POST', headers, body: JSON.stringify(queuedJob) }); assert.equal(created.status, 201);
  for (const [version, status] of ['authorized', 'queued'].entries()) {
    const changed = await fetch(console.origin + `/api/jobs/${queuedJob.appId}/${queuedJob.jobId}/transition`, { method: 'POST', headers,
      body: JSON.stringify({ expectedVersion: version, status, idempotencyKey: String(version + 1).repeat(32) }) }); assert.equal(changed.status, 200);
  }
  const run = await runner.runLocalBuild({ directory: f.directory, scope: queuedJob, recipe: f.recipe, execute: true });
  const shown = await (await fetch(console.origin + `/api/jobs/${queuedJob.appId}/${queuedJob.jobId}`, { headers })).json(); assert.equal(shown.job.status, 'succeeded');
  const ticket = await (await fetch(console.origin + `/api/jobs/${queuedJob.appId}/${queuedJob.jobId}/downloads`, { method: 'POST', headers, body: JSON.stringify({ artifactId: run.artifact.artifactId }) })).json();
  const file = await fetch(console.origin + '/api/download', { method: 'POST', headers, body: JSON.stringify({ ticket: ticket.ticket }) }); assert.equal(file.status, 200);
  assert.equal(await file.text(), 'synthetic build output'); assert.equal(file.headers.get('x-flora-sha256'), run.artifact.sha256);
});
