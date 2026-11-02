import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile, writeFile, readdir, symlink, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { copyVerifiedNativeArtifact } from './verified-copy.mjs';
import { withVerifiedNativeArtifact } from './native-artifact-file.mjs';
const job = { appId: 'app-a', jobId: 'build-1', repository: 'owner/app', sourceSha: 'a'.repeat(40), platform: 'android' };
async function fixture(t) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'flora-copy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.alloc(900_001, 37), sourcePath = join(dir, 'preview.apk'), targetPath = join(dir, 'export.apk');
  await writeFile(sourcePath, bytes);
  const manifest = { ...job, byteCount: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  return { dir, bytes, sourcePath, targetPath, manifest, expected: job };
}
test('verified copy streams multiple chunks with exact bytes and private mode', async t => {
  const f = await fixture(t), result = await copyVerifiedNativeArtifact(f);
  assert.deepEqual(await readFile(f.targetPath), f.bytes);
  assert.equal(result.sha256, f.manifest.sha256);
  assert.equal(result.signatureVerified, false);
  assert.equal((await stat(f.targetPath)).mode & 0o077, 0);
  assert.equal((await readdir(f.dir)).filter(n => n.endsWith('.partial')).length, 0);
});
test('existing output is never overwritten', async t => {
  const f = await fixture(t); await writeFile(f.targetPath, 'keep');
  await assert.rejects(copyVerifiedNativeArtifact(f), /ARTIFACT_DESTINATION_EXISTS/);
  assert.equal(await readFile(f.targetPath, 'utf8'), 'keep');
});
test('symlinked output is neither followed nor replaced', async t => {
  const f = await fixture(t), sentinel = join(f.dir, 'sentinel'); await writeFile(sentinel, 'keep'); await symlink(sentinel, f.targetPath);
  await assert.rejects(copyVerifiedNativeArtifact(f), /ARTIFACT_DESTINATION_EXISTS/);
  assert.equal(await readFile(sentinel, 'utf8'), 'keep');
});
test('same-size corruption leaves neither output nor partial files', async t => {
  const f = await fixture(t); await writeFile(f.sourcePath, Buffer.alloc(f.bytes.length, 38));
  await assert.rejects(copyVerifiedNativeArtifact(f), /ARTIFACT_HASH_MISMATCH/);
  await assert.rejects(stat(f.targetPath), { code: 'ENOENT' });
  assert.deepEqual(await readdir(f.dir), ['preview.apk']);
});
test('cross-job copy cannot publish a file', async t => {
  const f = await fixture(t);
  await assert.rejects(copyVerifiedNativeArtifact({ ...f, expected: { ...job, jobId: 'other' } }), /ARTIFACT_SCOPE_MISMATCH/);
  await assert.rejects(stat(f.targetPath), { code: 'ENOENT' });
});
test('same-size mutation with restored mtime is detected during descriptor use', async t => {
  const f = await fixture(t), previous = await stat(f.sourcePath);
  await assert.rejects(withVerifiedNativeArtifact({ filePath: f.sourcePath, manifest: f.manifest, expected: job }, async () => {
    await writeFile(f.sourcePath, Buffer.alloc(f.bytes.length, 40));
    await utimes(f.sourcePath, previous.atime, previous.mtime);
  }), /ARTIFACT_CHANGED_DURING_CHECK/);
});
