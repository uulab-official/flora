import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { openLocalBuildService } from './local-build-service.mjs';
import { snapshotBuildScope } from './build-lifecycle.mjs';
import { snapshotLocalRecipe } from './build-recipe.mjs';
import { checkCheckout, checkExecutable, checkSource, checkOutputPath } from './build-source.mjs';

const checkIds = Object.freeze(['job', 'binding', 'checkout', 'executable', 'git', 'output', 'lock', 'source', 'freshness']);
const safeCode = error => /^(BUILD|ARTIFACT)_[A-Z_]{1,80}$/.test(error?.message ?? '') ? error.message : 'BUILD_PREFLIGHT_CHECK_FAILED';
async function absent(path, code) {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error(code);
}
// This is advisory: it does not reserve/authorize execution or attest toolchain/signing readiness.
// It runs only the operator-selected Git inspection tool, never the build executable.
export async function inspectLocalBuild({ directory, scope, recipe, expectedVersion }) {
  scope = snapshotBuildScope(scope); recipe = snapshotLocalRecipe(recipe);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion >= Number.MAX_SAFE_INTEGER)
    throw new Error('BUILD_VERSION_INVALID');
  const service = await openLocalBuildService({ directory, readOnly: true });
  const ids = [...checkIds]; if (recipe.signaturePolicy) ids.splice(4, 0, 'signature-tool');
  const checks = ids.map(id => ({ id, status: 'not_checked', code: null }));
  const record = async (id, fn) => {
    const entry = checks.find(c => c.id === id);
    try { await fn(); entry.status = 'passed'; return true; }
    catch (error) { entry.status = 'failed'; entry.code = safeCode(error); return false; }
  };
  try {
    const job = service.show(scope).job;
    const valid = await record('job', () => {
      if (job.version !== expectedVersion) throw new Error('BUILD_VERSION_CONFLICT');
      if (job.status !== 'queued') throw new Error('BUILD_NOT_QUEUED');
    });
    const bound = valid && await record('binding', () => {
      if (['appId', 'repository', 'runnerId', 'platform'].some(k => job[k] !== recipe[k])
          || (job.platform === 'ios' ? recipe.format !== 'ipa' : recipe.format === 'ipa')) throw new Error('BUILD_RECIPE_SCOPE_MISMATCH');
    });
    if (bound) {
      const checkout = await record('checkout', () => checkCheckout(recipe.cwd));
      await record('executable', () => checkExecutable(recipe.executable));
      if (recipe.signaturePolicy) await record('signature-tool', () => checkExecutable(recipe.signaturePolicy.javaExecutable));
      const git = await record('git', () => checkExecutable(recipe.gitExecutable));
      if (checkout) {
        await record('output', async () => { await checkOutputPath(recipe.artifactPath); await absent(recipe.artifactPath, 'BUILD_OUTPUT_EXISTS'); });
        await record('lock', () => absent(join(directory, '.runner-lock-' + createHash('sha256').update(recipe.cwd).digest('hex') + '.lock'), 'BUILD_RUNNER_LOCKED'));
      }
      if (checkout && git) await record('source', () => checkSource(recipe, job, true));
      await record('freshness', () => {
        const current = service.show(scope).job;
        if (current.version !== job.version || current.status !== job.status) throw new Error('BUILD_PREFLIGHT_STATE_CHANGED');
      });
    }
    return Object.freeze({ ...scope, jobVersion: job.version, sourceSha: job.sourceSha,
      checkedAt: new Date().toISOString(), ready: checks.every(c => c.status === 'passed'),
      checks: Object.freeze(checks.map(Object.freeze)), buildExecuted: false,
      signatureVerified: false, installVerified: false, reservesExecution: false,
      ...(recipe.signaturePolicy ? { signaturePolicy: { scheme: recipe.signaturePolicy.scheme, expectedSignerSha256: recipe.signaturePolicy.expectedSignerSha256 } } : {}),
      limits: Object.freeze({ timeoutMs: recipe.timeoutMs, outputLimitBytes: recipe.outputLimitBytes }) });
  } finally { service.close(); }
}
