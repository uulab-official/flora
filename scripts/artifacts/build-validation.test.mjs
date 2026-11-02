import test from 'node:test';
import assert from 'node:assert/strict';
import { BuildJobLedger } from './build-job-ledger.mjs';
import { nextBuildState } from './build-lifecycle.mjs';
import { verifyNativeArtifactFile } from './native-artifact-file.mjs';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const scope = { appId: 'app-one', jobId: 'job-one' };
const event = { status: 'authorized', idempotencyKey: 'a'.repeat(32) };
for (const value of [123, { toString() { return 'app-one'; } }, ['app-one']]) {
  test(`reject coerced ID ${JSON.stringify(value)}`, () => {
    assert.throws(() => new BuildJobLedger().create({ ...scope, appId: value, version: 0, status: 'unconfigured' }), /BUILD_INITIAL_STATE_INVALID/);
  });
}
test('a transition cannot overflow a safe version', () => {
  assert.throws(() => nextBuildState({ ...scope, status: 'unconfigured', version: Number.MAX_SAFE_INTEGER }, event, scope), /BUILD_STATE_INVALID/);
});
test('queued requests snapshot their event before the first await', async () => {
  const ledger = new BuildJobLedger(); ledger.create({ ...scope, status: 'unconfigured', version: 0 });
  const mutable = { ...event };
  const result = ledger.transition({ scope, expectedVersion: 0, event: mutable });
  mutable.status = 'queued'; mutable.idempotencyKey = 'b'.repeat(32);
  assert.equal((await result).status, 'authorized');
});
test('idempotency keys bind the original expected version', async () => {
  const ledger = new BuildJobLedger(); ledger.create({ ...scope, status: 'unconfigured', version: 0 });
  await ledger.transition({ scope, expectedVersion: 0, event });
  await assert.rejects(ledger.transition({ scope, expectedVersion: 1, event }), /BUILD_IDEMPOTENCY_CONFLICT/);
});
test('file verification snapshots caller metadata before IO', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'flora-snapshot-'));
  try {
    const bytes = Buffer.from('fixture'), filePath = join(dir, 'preview.apk');
    await writeFile(filePath, bytes);
    const expected = { ...scope, repository: 'owner/app', sourceSha: 'a'.repeat(40), platform: 'android' };
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const manifest = { ...expected, byteCount: bytes.length, sha256 };
    const verification = verifyNativeArtifactFile({ filePath, manifest, expected });
    manifest.sha256 = '0'.repeat(64); expected.appId = 'mutated';
    assert.equal((await verification).sha256, sha256);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('diagnostic codes are bounded, only failure states carry them, and recovery clears them', () => {
  const current = { ...scope, status: 'running', version: 2 };
  const failed = nextBuildState(current, { ...event, status: 'failed', failureCode: 'BUILD_PROCESS_TIMEOUT' }, scope);
  assert.equal(failed.failureCode, 'BUILD_PROCESS_TIMEOUT');
  assert.throws(() => nextBuildState(current, { ...event, status: 'failed', failureCode: 'secret token raw log' }, scope), /BUILD_EVIDENCE_INVALID/);
  const unknown = nextBuildState(current, { ...event, status: 'unknown', failureCode: 'BUILD_RESULT_RECONCILIATION_REQUIRED' }, scope);
  const recovered = nextBuildState(unknown, { ...event, status: 'running' }, scope); assert.equal(recovered.failureCode, null);
});
