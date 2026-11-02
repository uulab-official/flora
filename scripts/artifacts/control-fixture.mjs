import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openLocalBuildService } from './local-build-service.mjs';
export const requestKey = n => n.toString(16).padStart(32, '0');
export async function until(predicate) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('fixture deadline');
}
export async function controlFixture(t, script = "require('node:fs').writeFileSync('result.apk','synthetic control build')") {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'flora-control-')), cwd = join(root, 'repo');
  await mkdir(cwd, { mode: 0o700 });
  const git = (...args) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await writeFile(join(cwd, 'build.cjs'), script); git('add', 'build.cjs'); git('commit', '-qm', 'control fixture');
  const job = { appId: 'app-a', jobId: 'job-one', repository: 'owner/private', sourceSha: git('rev-parse', 'HEAD'), platform: 'android', runnerId: 'runner-one' };
  const directory = join(root, 'state'), service = await openLocalBuildService({ directory, create: true });
  service.create(job);
  for (const [i, status] of ['authorized', 'queued'].entries()) await service.transition({ scope: job, expectedVersion: i, event: { status, idempotencyKey: requestKey(i + 1) } });
  const recipe = { appId: job.appId, repository: job.repository, runnerId: job.runnerId, platform: job.platform, cwd,
    executable: process.execPath, args: ['build.cjs'], artifactPath: join(cwd, 'result.apk'), format: 'apk', timeoutMs: 5000 };
  const f = { root, cwd, directory, service, job, recipe, git, closers: [], presets: [{ id: 'android-preview', label: 'Android preview', recipe }] };
  t.after(async () => { for (const close of f.closers.reverse()) await close(); service.close(); await rm(root, { recursive: true, force: true }); });
  return f;
}
