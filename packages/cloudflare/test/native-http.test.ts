import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createTestRuntime } from './runtime.ts';
import { githubOTAFixture } from '../../../tests/github-ota-fixtures.ts';
const origin = 'https://flora.example.test';
type SqlCost = { queries: number; rowsRead: number; rowsWritten: number; jobRows: number; authRows: number; indexRows: number; indexWrites: number };
async function harness(t: TestContext, profileSql = false) {
  const appMap = new Map<string, string>(), github = githubOTAFixture(() => origin, appMap), token = randomBytes(32), password = randomBytes(24).toString('base64url'), now = Date.now();
  const runtime = await createTestRuntime({ entrypoint: new URL(profileSql ? './fixtures/native-read-cost-entry.ts' : './fixtures/native-http-entry.ts', import.meta.url), durableObjects: { FLORA_AUTH: 'NativeHttpFixture' }, outboundService: github.respond,
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
  // These endpoints return bounded JSON. Drain each Miniflare response before
  // issuing another request; retain independent bodies for caller assertions.
  const complete = async (pending: ReturnType<typeof runtime.fetch>) => { const response = await pending; return new Response(await response.arrayBuffer(), { status: response.status, statusText: response.statusText, headers: [...response.headers.entries()] }); };
  const call = (path: string, input?: unknown, headers: Record<string, string> = {}) => complete(runtime.fetch(origin + path, { method: input === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, ...(input === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json', 'X-Flora-CSRF': csrf }), ...headers }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }));
  const machine = (token: string, action: string, input: unknown) => complete(runtime.fetch(origin + '/api/native-runner/' + action, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(profileSql ? { 'X-Flora-Test-Measure-Sql': '1' } : {}) }, body: JSON.stringify(input) }));
  const apps: string[] = [];
  for (const repository of ['expo-one', 'rn-two']) {
    const r = await call('/api/apps', { name: repository, repositoryId: 'github:synthetic/' + repository, rootDirectory: '.' }); assert.equal(r.status, 201); const appId = (await r.json() as any).id; apps.push(appId); appMap.set(repository, appId);
    const linked = await call(`/api/apps/${appId}/github`, { expectedVersion: 0, installationId: 42, owner: 'synthetic', repository, ref: 'main' }); assert.equal(linked.status, 201, await linked.clone().text()); await linked.json();
    const imported = await call(`/api/apps/${appId}/credentials`, { kind: 'android_keystore', label: 'Synthetic keystore', expectedVersion: 0, metadata: { appIdentifier: 'app.synthetic' }, payload: { fileBase64: Buffer.from('synthetic-keystore-' + repository).toString('base64'), password: 'sensitive-QA-password', keyAlias: 'qa' } }); assert.equal(imported.status, 201); await imported.json();
  }
  const queue = (appId: string, commitSha = 'a'.repeat(40)) => call(`/api/apps/${appId}/native/jobs`, { requestKey: 'request_qa', platform: 'android', commitSha, appIdentifier: 'app.synthetic', credentials: [{ kind: 'android_keystore', version: 1 }] });
  return { runtime, call, machine, apps, queue };
}
test('native idle HTTP polling does not scan completed job history or change authority checks', async t => {
  const h = await harness(t, true), [a, b] = h.apps;
  const runner = await (await h.call(`/api/apps/${a}/native/runners`, { name: 'Read cost QA', platform: 'android' })).json() as any;
  const profile: Record<string, SqlCost> = {};
  const measured = async (label: string, response: Response) => {
    assert.equal(response.status, 200, await response.clone().text());
    profile[label] = JSON.parse(response.headers.get('X-Flora-Test-Sql')!);
    return response.json() as Promise<any>;
  };
  const pending = async (label: string) => assert.deepEqual(await measured(label, await h.machine(runner.token, 'pending', {})), { jobId: null });
  await pending('empty');
  const templates: any[] = [];
  for (const [index, appId] of [a!, b!].entries()) {
    const response = await h.queue(appId, (index ? 'b' : 'a').repeat(40));
    assert.equal(response.status, 201, await response.clone().text());
    templates.push(await response.json());
  }
  const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  const seed = async (perApp: number) => {
    const statements = ['DELETE FROM flora_native_jobs'];
    for (const [appIndex, template] of templates.entries()) for (let i = 0; i < perApp; i++) {
      const job = { ...template, id: `native_job_history_${appIndex}_${String(i).padStart(3, '0')}`, requestKey: `history_${i}`,
        platform: i % 2 ? 'ios' : 'android', state: 'failed', code: 'NATIVE_BUILD_FAILED', lease: null, claimedAt: null };
      statements.push(`INSERT INTO flora_native_jobs VALUES(${[job.id, job.appId, job.requestKey, JSON.stringify(job)].map(literal).join(',')})`);
    }
    for (let offset = 0; offset < statements.length; offset += 20) {
      const response = await h.call('/__test/control', { sql: statements.slice(offset, offset + 20).join(';') });
      assert.equal(response.status, 200, await response.text());
    }
  };
  await seed(10); await pending('history20'); await pending('history20Repeat');
  await seed(100); await pending('history200'); await pending('history200Repeat');
  const snapshot = async () => (await h.call('/__test/control', { sql: 'SELECT * FROM flora_native_jobs ORDER BY id' })).json();
  const beforeMigration = await snapshot();
  assert.equal((await h.call('/__test/control', { sql: 'DROP INDEX IF EXISTS flora_native_jobs_pending; DROP INDEX IF EXISTS flora_native_jobs_active_runner' })).status, 200);
  await pending('legacyHistory200');
  await measured('upgrade', await h.call('/__test/native-restart', {}, { 'X-Flora-Test-Measure-Sql': '1' }));
  await pending('upgradedHistory200');
  await measured('restart', await h.call('/__test/native-restart', {}, { 'X-Flora-Test-Measure-Sql': '1' }));
  await pending('restartedHistory200');
  assert.deepEqual(await snapshot(), beforeMigration, 'additive upgrade and repeated polling preserve every historical row');
  await measured('presence', await h.machine(runner.token, 'presence', {}));
  await measured('presenceRepeat', await h.machine(runner.token, 'presence', {}));
  await measured('session', await h.call('/api/auth/session', undefined, { 'X-Flora-Test-Measure-Sql': '1' }));
  await measured('sessionRepeat', await h.call('/api/auth/session', undefined, { 'X-Flora-Test-Measure-Sql': '1' }));
  await measured('historyList', await h.call(`/api/apps/${a}/native`, undefined, { 'X-Flora-Test-Measure-Sql': '1' }));
  const queued = { ...templates[0], id: 'native_job_history_0_000', requestKey: 'history_0', state: 'queued' };
  assert.equal((await h.call('/__test/control', { sql: `UPDATE flora_native_jobs SET data=${literal(JSON.stringify(queued))} WHERE id=${literal(queued.id)}` })).status, 200);
  assert.deepEqual(await measured('queued', await h.machine(runner.token, 'pending', {})), { jobId: queued.id });
  const claimed = await h.machine(runner.token, 'claim', { jobId: queued.id });
  assert.equal(claimed.status, 201, await claimed.clone().text());
  profile.claim = JSON.parse(claimed.headers.get('X-Flora-Test-Sql')!);
  const { lease } = await claimed.json() as any;
  await pending('active');
  await measured('heartbeat', await h.machine(runner.token, 'heartbeat', { lease }));
  assert.equal((await h.call(`/api/apps/${a}/native/jobs/${queued.id}/cancel`, {})).status, 200);
  await pending('cancelRequested');
  assert.equal((await measured('cancelled', await h.machine(runner.token, 'fail', { lease, code: 'CANCELLED' }))).state, 'cancelled');
  await pending('afterCancellation');
  t.diagnostic('Local workerd DO SQL counters (warm requests; D1 excluded): ' + JSON.stringify(profile));
  const query = `EXPLAIN QUERY PLAN SELECT data FROM flora_native_jobs WHERE app_id=${literal(a!)} AND json_extract(data,'$.platform')='android' AND json_extract(data,'$.state')='queued' ORDER BY json_extract(data,'$.createdAt'),id LIMIT 100`;
  const plan = await (await h.call('/__test/control', { sql: query })).json();
  t.diagnostic('Queued job query plan: ' + JSON.stringify(plan));
  for (const label of ['empty', 'history20', 'history20Repeat', 'history200', 'history200Repeat', 'upgradedHistory200', 'restartedHistory200']) {
    assert.ok(profile[label]!.rowsRead <= 50, `${label}: idle pending must have bounded reads, got ${profile[label]!.rowsRead}`);
    assert.equal(profile[label]!.rowsWritten, 0, label + ' must remain a read-only poll');
    assert.equal(profile[label]!.authRows, profile.empty!.authRows, 'history size must not change authority checks');
  }
  assert.equal(profile.history200!.rowsRead, profile.history20!.rowsRead, 'completed history must not add idle reads');
  assert.ok(profile.legacyHistory200!.rowsRead >= 200, 'same database without indexes must reproduce the historical scan');
  assert.ok(profile.upgradedHistory200!.rowsRead < profile.legacyHistory200!.rowsRead / 5, 'upgrade must reduce the same idle request by at least 80%');
  assert.equal(profile.restart!.indexWrites, 0, 'existing indexes must not be rebuilt on each constructor');
  assert.equal(profile.presenceRepeat!.rowsWritten, 0, 'existing presence write coalescing must remain effective');
});
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
