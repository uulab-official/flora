import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createTestRuntime } from './runtime.ts';
import { githubOTAFixture } from '../../../tests/github-ota-fixtures.ts';
const origin = 'https://flora.example.test';
async function harness(t: TestContext) {
  const appMap = new Map<string, string>(), github = githubOTAFixture(() => origin, appMap), token = randomBytes(32), password = randomBytes(24).toString('base64url'), now = Date.now();
  const runtime = await createTestRuntime({ entrypoint: new URL('./fixtures/native-http-entry.ts', import.meta.url), durableObjects: { FLORA_AUTH: 'NativeHttpFixture' }, outboundService: github.respond,
    bindings: { FLORA_ORIGIN: origin, FLORA_OWNER_ID: 'synthetic-owner', FLORA_OWNER_EMAIL: 'owner@example.test', FLORA_DB_IDENTITY: 'synthetic-db',
      FLORA_GITHUB_APP_ID: github.credentials.appId, FLORA_GITHUB_PRIVATE_KEY: github.credentials.privateKey,
      FLORA_VAULT_KEYS: JSON.stringify({ active: 'v1', keys: { v1: randomBytes(32).toString('base64url') } }),
      FLORA_SETUP: { digest: createHash('sha256').update(token).digest('hex'), issuedAt: now, expiresAt: now + 600000, generation: 1, purpose: 'enroll' } } });
  t.after(() => runtime.dispose());
  for (const name of ['0001_private_imports.sql', '0002_multi_app.sql', '0003_github_ota.sql', '0004_automation.sql']) {
    const sql = await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8');
    await runtime.d1.exec(sql.replace(/^--.*$/gm, '').split(/;\s*(?=CREATE|INSERT|DROP|PRAGMA|$)/).filter(s => s.trim()).map(s => s.replace(/\s*\n\s*/g, ' ').trim() + ';').join('\n'));
  }
  await runtime.d1.prepare('INSERT INTO flora_deployment(singleton,owner_id,origin,db_identity) VALUES(1,?,?,?)').bind('synthetic-owner', origin, 'synthetic-db').run();
  const enrolled = await runtime.fetch(origin + '/api/auth/enroll', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.test', password, confirmation: password, token: token.toString('base64url') }) }); assert.equal(enrolled.status, 200);
  const cookie = enrolled.headers.getSetCookie().map(c => c.split(';', 1)[0]).join('; '), csrf = (await enrolled.json() as any).csrfToken;
  const call = (path: string, input?: unknown, headers: Record<string, string> = {}) => runtime.fetch(origin + path, { method: input === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, ...(input === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json', 'X-Flora-CSRF': csrf }), ...headers }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  const machine = (token: string, action: string, input: unknown) => runtime.fetch(origin + '/api/native-runner/' + action, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const apps: string[] = [];
  for (const repository of ['expo-one', 'rn-two']) {
    const r = await call('/api/apps', { name: repository, repositoryId: 'github:synthetic/' + repository, rootDirectory: '.' }); assert.equal(r.status, 201); const appId = (await r.json() as any).id; apps.push(appId); appMap.set(repository, appId);
    const linked = await call(`/api/apps/${appId}/github`, { expectedVersion: 0, installationId: 42, owner: 'synthetic', repository, ref: 'main' }); assert.equal(linked.status, 201, await linked.clone().text()); await linked.json();
    const imported = await call(`/api/apps/${appId}/credentials`, { kind: 'android_keystore', label: 'Synthetic keystore', expectedVersion: 0, metadata: { appIdentifier: 'app.synthetic' }, payload: { fileBase64: Buffer.from('synthetic-keystore-' + repository).toString('base64'), password: 'sensitive-QA-password', keyAlias: 'qa' } }); assert.equal(imported.status, 201); await imported.json();
  }
  const queue = (appId: string, commitSha = 'a'.repeat(40)) => call(`/api/apps/${appId}/native/jobs`, { requestKey: 'request_qa', platform: 'android', commitSha, appIdentifier: 'app.synthetic', credentials: [{ kind: 'android_keystore', version: 1 }] });
  return { runtime, call, machine, apps, queue };
}
test('native HTTP flow binds GitHub commit, leaves OTA history untouched and requires separate native capability', async t => {
  const h = await harness(t), [a, b] = h.apps;
  const before = await (await h.call(`/api/apps/${a}/operations`)).json();
  const rejected = await h.queue(a!, 'c'.repeat(40)); assert.equal(rejected.status, 409); await rejected.json();
  const en = await h.call(`/api/apps/${a}/native/runners`, { name: 'PC native runner', platform: 'android' }); assert.equal(en.status, 201); const enrollment = await en.json() as any;
  const q = await h.queue(a!); assert.equal(q.status, 201, await q.clone().text()); const job = await q.json() as any;
  const claim = await h.machine(enrollment.token, 'claim', { jobId: job.id }); assert.equal(claim.status, 201); const leased = await claim.json() as any;
  const grantResponse = await h.machine(enrollment.token, 'credentials', { lease: leased.lease }); assert.equal(grantResponse.status, 200); const grant = await grantResponse.json() as any;
  assert.equal(grant.appId, a); assert.equal(grant.credentials[0].kind, 'android_keystore');
  assert.equal((await h.call(`/api/apps/${b}/native`)).status, 200);
  const bState = await (await h.call(`/api/apps/${b}/native`)).json() as any; assert.equal(bState.jobs.length, 0); assert.equal(bState.credentialUses.length, 0);
  const done = await h.machine(enrollment.token, 'complete', { lease: leased.lease, artifact: { fileName: job.id + '.apk', sha256: 'c'.repeat(64), byteLength: 4321, appIdentifier: 'app.synthetic', platform: 'android', signerFingerprint: 'd'.repeat(64) } }); assert.equal(done.status, 200); assert.equal((await done.json() as any).artifactVerification, 'runner_reported');
  assert.deepEqual(await (await h.call(`/api/apps/${a}/operations`)).json(), before);
  const ota = await h.runtime.fetch(origin + '/api/runner/presence', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + enrollment.token }, body: '{}' }); assert.equal(ota.status, 403); await ota.json();
  const publicState = await (await h.call(`/api/apps/${a}/native`)).json(); assert.doesNotMatch(JSON.stringify(publicState), /tokenHash|fileBase64|sensitive-QA-password|synthetic-keystore/);
});
test('native management requires session and CSRF and token authentication precedes unread body admission', async t => {
  const h = await harness(t), appId = h.apps[0]!;
  assert.equal((await h.call(`/api/apps/${appId}/native`, undefined, { Cookie: '' })).status, 401);
  assert.equal((await h.call(`/api/apps/${appId}/native/runners`, { name: 'QA', platform: 'android' }, { 'X-Flora-CSRF': '' })).status, 403);
  assert.deepEqual(await (await h.call('/__test/native-unread')).json(), { status: 401, reads: 0 });
  const ota = await h.call('/api/runners', { name: 'Existing OTA runner', appIds: [appId] }); assert.equal(ota.status, 201); const enrollment = await ota.json() as any;
  const denied = await h.machine(enrollment.token, 'credentials', { lease: {} }); assert.equal(denied.status, 401); assert.doesNotMatch(await denied.text(), /fileBase64|PRIVATE KEY/);
});
test('native runner revocation during body read prevents delayed presence and future credential requests', async t => {
  const h = await harness(t), appId = h.apps[0]!;
  const enrolled = await (await h.call(`/api/apps/${appId}/native/runners`, { name: 'QA', platform: 'android' })).json() as any;
  assert.deepEqual(await (await h.call('/__test/native-held', { token: enrolled.token })).json(), { held: true });
  const revoked = await h.call(`/api/apps/${appId}/native/runners/${enrolled.runner.id}/revoke`, {}); assert.equal(revoked.status, 200); await revoked.json();
  const released = await (await h.call('/__test/native-held', { release: true })).json() as any; assert.equal(released.status, 403);
  assert.equal((await h.machine(enrolled.token, 'presence', {})).status, 403);
});
test('native machine bodies have bounded backpressure while owner revocation remains available', async t => {
  const h = await harness(t), appId = h.apps[0]!, enrolled = await (await h.call(`/api/apps/${appId}/native/runners`, { name: 'QA', platform: 'android' })).json() as any;
  for (let i = 0; i < 4; i++) assert.deepEqual(await (await h.call('/__test/native-held', { token: enrolled.token, slot: String(i) })).json(), { held: true });
  const rejected = await (await h.call('/__test/native-held', { token: enrolled.token, slot: 'overflow' })).json() as any; assert.equal(rejected.status, 409); assert.equal(rejected.body.error, 'BUSY');
  assert.equal((await h.call(`/api/apps/${appId}/native/runners/${enrolled.runner.id}/revoke`, {})).status, 200);
  for (let i = 0; i < 4; i++) assert.equal((await (await h.call('/__test/native-held', { release: true, slot: String(i) })).json() as any).status, 403);
  const fresh = await (await h.call(`/api/apps/${appId}/native/runners`, { name: 'Replacement QA', platform: 'android' })).json() as any;
  assert.equal((await h.machine(fresh.token, 'presence', {})).status, 200);
});
test('native pending HTTP returns only own app and platform queue IDs and rejects selectors or old OTA tokens', async t => {
  const h = await harness(t), [a, b] = h.apps;
  const enroll = async (appId: string, platform: string) => { const r = await h.call(`/api/apps/${appId}/native/runners`, { name: 'Pending QA', platform }); assert.equal(r.status, 201); return await r.json() as any; };
  const ar = await enroll(a!, 'android'), br = await enroll(b!, 'android'), ai = await enroll(a!, 'ios');
  const jobAResponse = await h.queue(a!), jobBResponse = await h.queue(b!, 'b'.repeat(40)); assert.equal(jobAResponse.status, 201); assert.equal(jobBResponse.status, 201);
  const ja = await jobAResponse.json() as any, jb = await jobBResponse.json() as any;
  for (const [runner, jobId] of [[ar, ja.id], [br, jb.id], [ai, null]] as const) {
    const response = await h.machine(runner.token, 'pending', {}); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { jobId });
  }
  assert.equal((await h.machine(ar.token, 'pending', { appId: b })).status, 400);
  assert.equal((await h.machine(ar.token, 'pending', { platform: 'ios' })).status, 400);
  const ota = await (await h.call('/api/runners', { name: 'OTA QA', appIds: [a] })).json() as any;
  const denied = await h.machine(ota.token, 'pending', {}); assert.equal(denied.status, 401); assert.doesNotMatch(await denied.text(), /jobId|fileBase64/);
  await (await h.call(`/api/apps/${a}/native/runners/${ar.runner.id}/revoke`, {})).json();
  assert.equal((await h.machine(ar.token, 'pending', {})).status, 403);
});
test('native HTTP pending advances past rotated key jobs while retaining original pins and separate app histories', async t => {
  const h = await harness(t), [a, b] = h.apps;
  const ar = await (await h.call(`/api/apps/${a}/native/runners`, { name: 'Rotation QA', platform: 'android' })).json() as any;
  const oldResponse = await h.queue(a!); assert.equal(oldResponse.status, 201); const old = await oldResponse.json() as any;
  const beforeB = await (await h.call(`/api/apps/${b}/native`)).json();
  const rotated = await h.call(`/api/apps/${a}/credentials`, { kind: 'android_keystore', label: 'Replacement QA', expectedVersion: 1,
    metadata: { appIdentifier: 'app.synthetic' }, payload: { fileBase64: Buffer.from('replacement-signing-QA').toString('base64'), password: 'replacement-secret-QA', keyAlias: 'qa' } }); assert.equal(rotated.status, 201); await rotated.json();
  const nextResponse = await h.call(`/api/apps/${a}/native/jobs`, { requestKey: 'request_after_rotation', platform: 'android', commitSha: 'a'.repeat(40), appIdentifier: 'app.synthetic', credentials: [{ kind: 'android_keystore', version: 2 }] });
  assert.equal(nextResponse.status, 201); const next = await nextResponse.json() as any;
  const pending = await h.machine(ar.token, 'pending', {}); assert.equal(pending.status, 200); assert.deepEqual(await pending.json(), { jobId: next.id });
  const state = await (await h.call(`/api/apps/${a}/native`)).json() as any, retired = state.jobs.find((job: any) => job.id === old.id);
  assert.equal(retired.state, 'failed'); assert.equal(retired.code, 'CREDENTIAL_CHANGED'); assert.deepEqual(retired.credentials, old.credentials); assert.equal(retired.configDigest, old.configDigest); assert.equal(state.credentialUses.length, 0);
  const claim = await h.machine(ar.token, 'claim', { jobId: next.id }); assert.equal(claim.status, 201); const claimed = await claim.json() as any; assert.equal(claimed.job.id, next.id);
  const granted = await h.machine(ar.token, 'credentials', { lease: claimed.lease }); assert.equal(granted.status, 200); assert.equal((await granted.json() as any).credentials[0].version, 2);
  assert.deepEqual(await (await h.call(`/api/apps/${b}/native`)).json(), beforeB);
});
