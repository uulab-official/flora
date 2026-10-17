import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createTestRuntime } from './runtime.ts';
const origin = 'https://native.example.test';
const input = (platform = 'android', requestKey = 'request_first', sha = 'a'.repeat(40)) => ({ requestKey, commitSha: sha, platform, appIdentifier: 'app.synthetic',
  ...(platform === 'ios' ? { teamId: 'TEAM123456' } : {}), credentials: platform === 'ios' ? [{ kind: 'ios_distribution', version: 1 }, { kind: 'ios_provisioning', version: 1 }] : [{ kind: 'android_keystore', version: 1 }] });
const artifact = (platform = 'android', jobId = 'native_job_fixture') => ({ fileName: jobId + (platform === 'ios' ? '.ipa' : '.apk'), sha256: 'c'.repeat(64), byteLength: 1234,
  appIdentifier: 'app.synthetic', platform, signerFingerprint: 'd'.repeat(64), ...(platform === 'ios' ? { teamId: 'TEAM123456' } : {}) });
async function harness(t: TestContext) {
  const runtime = await createTestRuntime({ entrypoint: new URL('./fixtures/native-build-entry.ts', import.meta.url), durableObjects: { TEST_NATIVE: 'NativeBuildFixture' },
    bindings: { FLORA_VAULT_KEYS: JSON.stringify({ active: 'v1', keys: { v1: randomBytes(32).toString('base64url') } }) } }); t.after(() => runtime.dispose());
  const call = (body: Record<string, unknown>) => runtime.fetch(origin, { method: 'POST', body: JSON.stringify(body) });
  const ok = async (body: Record<string, unknown>) => { const r = await call(body); assert.equal(r.status, 200, await r.clone().text()); return await r.json() as any; };
  const setup = async (appId = 'app_first', platform = 'android', requestKey = 'request_first') => {
    for (const kind of platform === 'ios' ? ['ios_distribution', 'ios_provisioning'] : ['android_keystore']) await ok({ action: 'import', appId,
      input: { kind, label: 'QA ' + appId, expectedVersion: 0, metadata: { appIdentifier: 'app.synthetic', ...(platform === 'ios' ? { teamId: 'TEAM123456' } : {}) }, payload: { fileBase64: Buffer.from('synthetic-native-secret-' + appId).toString('base64'), ...(kind === 'ios_provisioning' ? {} : { password: 'QA-sensitive-password', ...(kind === 'android_keystore' ? { keyAlias: 'qa' } : {}) }) } } });
    const enrolled = await ok({ action: 'enroll', appId, input: { name: 'Native QA Runner', platform } });
    const job = await ok({ action: 'enqueue', appId, input: input(platform, requestKey) }); return { appId, token: enrolled.token, runner: enrolled.runner, job };
  };
  return { runtime, call, ok, setup };
}
test('two applications use isolated native signing jobs, grants and histories while legacy data is retained', async t => {
  const h = await harness(t); await h.ok({ action: 'sql', sql: 'CREATE TABLE legacy_ota (data TEXT)' }); await h.ok({ action: 'sql', sql: 'INSERT INTO legacy_ota VALUES(?)', args: ['existing-data'] });
  const a = await h.setup(), b = await h.setup('app_second', 'ios');
  for (const target of [a, b]) {
    const claim = await h.ok({ action: 'claim', token: target.token, jobId: target.job.id });
    const grant = await h.ok({ action: 'credentials', token: target.token, lease: claim.lease });
    assert.equal(grant.appId, target.appId); assert.deepEqual(grant.credentials.map((x: any) => x.kind).sort(), target.job.credentials.map((x: any) => x.kind).sort());
    for (const item of grant.credentials) assert.equal(Buffer.from(item.payload.fileBase64, 'base64').toString(), 'synthetic-native-secret-' + target.appId);
    const receipt = artifact(target.job.platform, target.job.id), completed = await h.ok({ action: 'complete', token: target.token, lease: claim.lease, artifact: receipt }); assert.equal(completed.state, 'succeeded');
    assert.equal(completed.artifactVerification, 'runner_reported');
    assert.deepEqual(await h.ok({ action: 'complete', token: target.token, lease: claim.lease, artifact: receipt }), completed);
  }
  const av = await h.ok({ action: 'list', appId: a.appId }), bv = await h.ok({ action: 'list', appId: b.appId });
  assert.equal(av.jobs.length, 1); assert.equal(av.credentialUses.length, 1); assert.equal(bv.jobs.length, 1); assert.equal(bv.credentialUses.length, 1);
  assert.notEqual(av.jobs[0].source.repository, bv.jobs[0].source.repository);
  assert.doesNotMatch(JSON.stringify([av, bv]), /tokenHash|fileBase64|QA-sensitive-password|synthetic-native-secret/);
  assert.deepEqual(await h.ok({ action: 'sql', sql: 'SELECT * FROM legacy_ota' }), [{ data: 'existing-data' }]);
});
test('OTA tokens, wrong application and platform cannot claim or read a native credential', async t => {
  const h = await harness(t), a = await h.setup(), b = await h.setup('app_second');
  assert.equal((await h.call({ action: 'claim', token: 'runner_synthetic.' + randomBytes(32).toString('base64url'), jobId: a.job.id })).status, 401);
  assert.equal((await h.call({ action: 'claim', token: b.token, jobId: a.job.id })).status, 403);
  const claim = await h.ok({ action: 'claim', token: a.token, jobId: a.job.id });
  for (const lease of [{ ...claim.lease, appId: b.appId }, { ...claim.lease, platform: 'ios' }, { ...claim.lease, attemptId: 'native_attempt_wrong' }, { ...claim.lease, fence: 2 }]) {
    assert.equal((await h.call({ action: 'credentials', token: a.token, lease })).status, 409);
  }
  assert.equal((await h.call({ action: 'credentials', token: b.token, lease: claim.lease })).status, 409);
  assert.equal((await h.ok({ action: 'list', appId: a.appId })).credentialUses.length, 0);
});
test('jobs pin reviewed SHA, source connection and credential revisions with idempotency conflicts', async t => {
  const h = await harness(t), a = await h.setup();
  assert.deepEqual(await h.ok({ action: 'enqueue', appId: a.appId, input: input() }), a.job);
  assert.equal((await h.call({ action: 'enqueue', appId: a.appId, input: input('android', 'request_first', 'b'.repeat(40)) })).status, 409);
  assert.equal((await h.call({ action: 'enqueue', appId: a.appId, input: { ...input(), appIdentifier: 'app.other' } })).status, 409);
  assert.equal((await h.call({ action: 'enqueue', appId: a.appId, input: { ...input(), credentials: [{ kind: 'fcm', version: 1 }] } })).status, 400);
  await h.ok({ action: 'disable', appId: a.appId, kind: 'android_keystore', version: 1 });
  assert.equal((await h.call({ action: 'claim', token: a.token, jobId: a.job.id })).status, 409);
  assert.equal((await h.ok({ action: 'list', appId: a.appId })).jobs[0].state, 'queued');
});
test('revocation, cancellation and binding changes during every grant await prevent secret release and audit', async t => {
  for (const mutation of ['cancel', 'revoke', 'disable']) for (const mutateAt of [2, 3, 4, 5, 6, 7]) {
    const h = await harness(t), a = await h.setup(), claim = await h.ok({ action: 'claim', token: a.token, jobId: a.job.id });
    const r = await h.call({ action: 'credentials', token: a.token, lease: claim.lease, appId: a.appId, mutation, mutateAt });
    assert.ok(r.status === 403 || r.status === 409, mutation + ' fence ' + mutateAt + ': ' + r.status); assert.doesNotMatch(await r.text(), /fileBase64|QA-sensitive-password/);
    assert.equal((await h.ok({ action: 'list', appId: a.appId })).credentialUses.length, 0);
  }
});
test('expired or cancelled leases, runner revocation and owner epoch changes stop access and completion', async t => {
  const h = await harness(t), a = await h.setup(), claim = await h.ok({ action: 'claim', token: a.token, jobId: a.job.id });
  assert.equal((await h.call({ action: 'credentials', token: a.token, lease: claim.lease, ownerEpoch: 2 })).status, 403);
  await h.ok({ action: 'cancel', appId: a.appId, jobId: a.job.id });
  assert.equal((await h.call({ action: 'credentials', token: a.token, lease: claim.lease })).status, 409);
  assert.equal((await h.call({ action: 'complete', token: a.token, lease: claim.lease, artifact: artifact('android', a.job.id) })).status, 409);
  const failed = await h.ok({ action: 'fail', token: a.token, lease: claim.lease, code: 'CANCELLED' }); assert.equal(failed.state, 'cancelled');
  const revoked = await h.ok({ action: 'revoke', appId: a.appId, runnerId: a.runner.id }); assert.equal(revoked.credentialEpoch, 2);
  assert.equal((await h.call({ action: 'presence', token: a.token })).status, 403);
});
test('tampered authenticated envelopes never grant payload or append use audit', async t => {
  const h = await harness(t), a = await h.setup(), claim = await h.ok({ action: 'claim', token: a.token, jobId: a.job.id });
  const rows = await h.ok({ action: 'sql', sql: 'SELECT * FROM flora_credential_versions' }), envelope = JSON.parse(rows[0].envelope);
  envelope.iv = 'AAAAAAAAAAAAAAAA';
  await h.ok({ action: 'sql', sql: 'UPDATE flora_credential_versions SET envelope=?', args: [JSON.stringify(envelope)] });
  const r = await h.call({ action: 'credentials', token: a.token, lease: claim.lease }); assert.equal(r.status, 503);
  assert.equal((await h.ok({ action: 'list', appId: a.appId })).credentialUses.length, 0);
});
test('native result only accepts the job identity, real signing receipt fields and an audited credential grant', async t => {
  const h = await harness(t), a = await h.setup(), claim = await h.ok({ action: 'claim', token: a.token, jobId: a.job.id });
  assert.equal((await h.call({ action: 'complete', token: a.token, lease: claim.lease, artifact: artifact('android', a.job.id) })).status, 409);
  await h.ok({ action: 'credentials', token: a.token, lease: claim.lease });
  for (const invalid of [{ ...artifact(), appIdentifier: 'app.other' }, { ...artifact(), fileName: '../secret.apk' }, { ...artifact(), platform: 'ios' }, { ...artifact(), secret: 'private-material' }]) {
    assert.equal((await h.call({ action: 'complete', token: a.token, lease: claim.lease, artifact: invalid })).status, 400);
  }
  const done = await h.ok({ action: 'complete', token: a.token, lease: claim.lease, artifact: artifact('android', a.job.id) }); assert.equal(done.state, 'succeeded');
  assert.equal((await h.call({ action: 'credentials', token: a.token, lease: claim.lease })).status, 409);
});
test('credential grant count is bounded and rejected transaction cannot leave a partial audit', async t => {
  const h = await harness(t), a = await h.setup(), claim = await h.ok({ action: 'claim', token: a.token, jobId: a.job.id });
  for (let i = 0; i < 3; i++) await h.ok({ action: 'credentials', token: a.token, lease: claim.lease });
  assert.equal((await h.call({ action: 'credentials', token: a.token, lease: claim.lease })).status, 409);
  assert.equal((await h.ok({ action: 'list', appId: a.appId })).credentialUses.length, 3);
});
test('authoritative expiry rejects forged future lease and retains legacy histories', async t => {
  const h = await harness(t), a = await h.setup(), claim = await h.ok({ action: 'claim', token: a.token, jobId: a.job.id });
  const job = { ...claim.job, lease: { ...claim.lease, expiresAt: Date.now() - 1 } };
  await h.ok({ action: 'sql', sql: 'UPDATE flora_native_jobs SET data=? WHERE id=?', args: [JSON.stringify(job), job.id] });
  for (const action of ['credentials', 'heartbeat']) assert.equal((await h.call({ action, token: a.token, lease: { ...claim.lease, expiresAt: Date.now() + 3600000 } })).status, 409);
  assert.equal((await h.ok({ action: 'list', appId: a.appId })).credentialUses.length, 0);
});
test('failed use-audit transaction releases no secret and terminal receipt retries reject changed artifacts', async t => {
  const h = await harness(t), a = await h.setup(), claim = await h.ok({ action: 'claim', token: a.token, jobId: a.job.id });
  await h.ok({ action: 'sql', sql: "CREATE TRIGGER reject_use BEFORE INSERT ON flora_native_credential_uses BEGIN SELECT RAISE(ABORT,'synthetic rejection'); END" });
  const denied = await h.call({ action: 'credentials', token: a.token, lease: claim.lease }); assert.equal(denied.status, 503); assert.doesNotMatch(await denied.text(), /fileBase64|QA-sensitive-password/);
  assert.equal((await h.ok({ action: 'list', appId: a.appId })).credentialUses.length, 0);
  await h.ok({ action: 'sql', sql: 'DROP TRIGGER reject_use' }); await h.ok({ action: 'credentials', token: a.token, lease: claim.lease });
  const receipt = artifact('android', a.job.id); await h.ok({ action: 'complete', token: a.token, lease: claim.lease, artifact: receipt });
  assert.equal((await h.call({ action: 'complete', token: a.token, lease: claim.lease, artifact: { ...receipt, sha256: 'e'.repeat(64) } })).status, 409);
  assert.equal((await h.ok({ action: 'list', appId: a.appId })).events.filter((event: any) => event.action === 'succeeded').length, 1);
});
test('native pending exposes one own app and platform job ID, with no source or credential data', async t => {
  const h = await harness(t), a = await h.setup(), b = await h.setup('app_second', 'ios');
  const ios = await h.ok({ action: 'enroll', appId: a.appId, input: { name: 'A iOS Runner', platform: 'ios' } });
  assert.deepEqual(await h.ok({ action: 'pending', token: ios.token }), { jobId: null });
  assert.deepEqual(await h.ok({ action: 'pending', token: a.token }), { jobId: a.job.id });
  assert.deepEqual(await h.ok({ action: 'pending', token: b.token }), { jobId: b.job.id });
  const second = await h.ok({ action: 'enqueue', appId: a.appId, input: input('android', 'request_second') });
  for (const [job, createdAt] of [[a.job, 1], [second, 2]] as const) await h.ok({ action: 'sql', sql: 'UPDATE flora_native_jobs SET data=? WHERE id=?', args: [JSON.stringify({ ...job, createdAt }), job.id] });
  const before = await h.ok({ action: 'list', appId: a.appId });
  assert.deepEqual(await h.ok({ action: 'pending', token: a.token }), { jobId: a.job.id });
  assert.deepEqual(await h.ok({ action: 'list', appId: a.appId }), before, 'Polling cannot mutate queued jobs or key-use history');
  const claim = await h.ok({ action: 'claim', token: a.token, jobId: a.job.id });
  assert.deepEqual(await h.ok({ action: 'pending', token: a.token }), { jobId: null }, 'An active Runner does not start another signing job');
  await h.ok({ action: 'fail', token: a.token, lease: claim.lease, code: 'NATIVE_BUILD_FAILED' });
  assert.deepEqual(await h.ok({ action: 'pending', token: a.token }), { jobId: second.id });
});
test('pending retains native token purpose, revocation and owner epoch fences', async t => {
  const h = await harness(t), a = await h.setup();
  assert.equal((await h.call({ action: 'pending', token: 'runner_synthetic.' + randomBytes(32).toString('base64url') })).status, 401);
  assert.equal((await h.call({ action: 'pending', token: a.token, ownerEpoch: 2 })).status, 403);
  assert.equal((await h.call({ action: 'pending', token: a.token, revokeAt: 2 })).status, 401);
  await h.ok({ action: 'revoke', appId: a.appId, runnerId: a.runner.id });
  assert.equal((await h.call({ action: 'pending', token: a.token })).status, 403);
});
test('pending retires rotated credential pins without starving a newer valid approved job or another app', async t => {
  const h = await harness(t), a = await h.setup(), b = await h.setup('app_second');
  const beforeB = await h.ok({ action: 'list', appId: b.appId });
  await h.ok({ action: 'import', appId: a.appId, input: { kind: 'android_keystore', label: 'Replacement QA key', expectedVersion: 1, metadata: { appIdentifier: 'app.synthetic' },
    payload: { fileBase64: Buffer.from('replacement-native-key').toString('base64'), password: 'replacement-QA-secret', keyAlias: 'qa' } } });
  const newer = await h.ok({ action: 'enqueue', appId: a.appId, input: { ...input('android', 'request_newer'), credentials: [{ kind: 'android_keystore', version: 2 }] } });
  const result = await h.ok({ action: 'pending', token: a.token }); assert.deepEqual(result, { jobId: newer.id });
  const after = await h.ok({ action: 'list', appId: a.appId }), old = after.jobs.find((job: any) => job.id === a.job.id);
  assert.equal(old.state, 'failed'); assert.equal(old.code, 'CREDENTIAL_CHANGED');
  for (const key of ['source', 'commitSha', 'credentials', 'configDigest', 'createdAt']) assert.deepEqual(old[key], a.job[key]);
  assert.equal(after.events.filter((event: any) => event.jobId === a.job.id && event.code === 'CREDENTIAL_CHANGED').length, 1);
  assert.equal(after.credentialUses.length, 0);
  assert.deepEqual(await h.ok({ action: 'pending', token: a.token }), result); assert.deepEqual(await h.ok({ action: 'list', appId: b.appId }), beforeB);
  const claim = await h.ok({ action: 'claim', token: a.token, jobId: result.jobId }); assert.equal(claim.job.id, newer.id);
});
test('pending invalid-key retirement rolls back on lost authority, unavailable vault or failed audit', async t => {
  const h = await harness(t), a = await h.setup();
  await h.ok({ action: 'disable', appId: a.appId, kind: 'android_keystore', version: 1 });
  const before = await h.ok({ action: 'list', appId: a.appId });
  for (const extra of [{ revokeAt: 3 }, { revokeAt: 4 }, { revokeAt: 5 }, { ownerEpoch: 2 }, { withoutKeys: true }]) {
    const response = await h.call({ action: 'pending', token: a.token, ...extra }); assert.ok([401, 403, 503].includes(response.status)); await response.json();
    assert.deepEqual(await h.ok({ action: 'list', appId: a.appId }), before);
  }
  await h.ok({ action: 'sql', sql: "CREATE TRIGGER reject_native_retirement BEFORE INSERT ON flora_native_events WHEN json_extract(NEW.data,'$.code')='CREDENTIAL_CHANGED' BEGIN SELECT RAISE(ABORT,'synthetic audit rejected'); END" });
  assert.equal((await h.call({ action: 'pending', token: a.token })).status, 503); assert.deepEqual(await h.ok({ action: 'list', appId: a.appId }), before);
  await h.ok({ action: 'sql', sql: 'DROP TRIGGER reject_native_retirement' });
  assert.deepEqual(await h.ok({ action: 'pending', token: a.token }), { jobId: null });
  const after = await h.ok({ action: 'list', appId: a.appId }); assert.equal(after.jobs[0].code, 'CREDENTIAL_CHANGED'); assert.equal(after.events.filter((event: any) => event.code === 'CREDENTIAL_CHANGED').length, 1);
});
