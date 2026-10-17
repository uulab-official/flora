import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createTestRuntime } from './runtime.ts';

const origin = 'https://vault.example.test';
const keyring = () => JSON.stringify({ active: 'v1', keys: { v1: randomBytes(32).toString('base64url') } });
function input(expectedVersion = 0, text = 'synthetic-secret-file', kind = 'android_keystore') {
  return { kind, expectedVersion, label: 'QA only', metadata: { appIdentifier: 'app.synthetic' },
    payload: { fileBase64: Buffer.from(text).toString('base64'), password: 'synthetic-sensitive-password', keyAlias: 'qa' } };
}
async function harness(t: TestContext) {
  const ring = keyring(), runtime = await createTestRuntime({ entrypoint: new URL('./fixtures/credential-vault-entry.ts', import.meta.url),
    durableObjects: { TEST_VAULT: 'CredentialVaultFixture' }, bindings: { FLORA_VAULT_KEYS: ring } });
  t.after(() => runtime.dispose());
  const call = (body: Record<string, unknown>) => runtime.fetch(origin, { method: 'POST', body: JSON.stringify(body) });
  const list = async (appId: string) => { const response = await call({ action: 'list', appId }); assert.equal(response.status, 200); return await response.json() as any; };
  const sql = async (query: string, args: unknown[] = []) => { const response = await call({ action: 'sql', sql: query, args }); assert.equal(response.status, 200); return await response.json() as any[]; };
  return { ring, runtime, call, list, sql };
}

test('vault independently registers, rotates and disables two apps without exposing raw material', async t => {
  const h = await harness(t);
  await h.sql('CREATE TABLE legacy_keys (secret TEXT NOT NULL)'); await h.sql('INSERT INTO legacy_keys VALUES(?)', ['existing-private-key']);
  for (const appId of ['app_first', 'app_second']) assert.equal((await h.call({ appId, input: input() })).status, 200);
  const second = await h.list('app_second');
  const first = await h.list('app_first'); assert.equal(first.credentials[0].version, 1); assert.equal(first.history[0].action, 'registered');
  assert.equal((await h.call({ appId: 'app_first', input: input(1, 'replacement-secret') })).status, 200);
  assert.deepEqual(await h.list('app_second'), second);
  assert.equal((await h.call({ action: 'disable', appId: 'app_first', kind: 'android_keystore', expectedVersion: 2 })).status, 200);
  const disabled = await h.list('app_first'); assert.equal(disabled.credentials[0].version, 3); assert.equal(disabled.credentials[0].activeVersion, null);
  assert.deepEqual(disabled.history.map((event: any) => event.action), ['registered', 'rotated', 'disabled']);
  assert.equal((await h.call({ appId: 'app_first', input: input(3) })).status, 200);
  const restarted = await h.list('app_first'); assert.equal(restarted.credentials[0].activeVersion, 4);
  assert.deepEqual(await h.sql('SELECT * FROM legacy_keys'), [{ secret: 'existing-private-key' }]);
  const stored = JSON.stringify(await h.sql('SELECT * FROM flora_credential_versions'));
  assert.doesNotMatch(stored, /synthetic-secret-file|synthetic-sensitive-password|replacement-secret|fileBase64|keyPassword/);
  assert.doesNotMatch(JSON.stringify(restarted), /synthetic-sensitive-password|fileBase64|ciphertext|wrappedKey|payloadJson/);
  assert.equal(restarted.history.length, 4);
});

test('stale and concurrent candidates cannot move another binding or create extra versions', async t => {
  const h = await harness(t);
  const responses = await Promise.all([h.call({ appId: 'app_first', input: input() }), h.call({ appId: 'app_first', input: input() })]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  const before = await h.list('app_first');
  assert.equal((await h.call({ appId: 'app_first', input: input() })).status, 409);
  assert.equal((await h.call({ action: 'disable', appId: 'app_second', kind: 'android_keystore', expectedVersion: 1 })).status, 404);
  assert.deepEqual(await h.list('app_first'), before);
  assert.equal((await h.sql('SELECT count(*) AS count FROM flora_credential_versions'))[0].count, 1);
});

test('revocation at asynchronous and transactional fences leaves no candidate, binding or event', async t => {
  const h = await harness(t);
  for (const revokeAt of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    const response = await h.call({ appId: 'app_first', input: input(), revokeAt });
    assert.equal(response.status, 401, `fence ${revokeAt}`);
    assert.deepEqual((await h.list('app_first')).credentials, []);
  }
  assert.deepEqual(await h.sql('SELECT * FROM flora_credential_history'), []);
});

test('missing or malformed keyring is unavailable without touching legacy SQL', async t => {
  const h = await harness(t);
  for (const ring of [null, '', '{}', JSON.stringify({ active: 'v1', keys: { v1: 'invalid' } }), JSON.stringify({ active: 'v2', keys: JSON.parse(h.ring).keys }), JSON.stringify({ ...JSON.parse(h.ring), extra: true }),
    JSON.stringify({ active: 'v1', keys: Object.fromEntries(['v1','v2','v3','v4'].map(key => [key, randomBytes(32).toString('base64url')])) })]) {
    const response = await h.call({ appId: 'app_first', input: input(), keyring: ring }); assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'VAULT_UNAVAILABLE' });
    const listed = await h.call({ action: 'list', appId: 'app_first', keyring: ring }); assert.equal(listed.status, 200);
    assert.equal((await listed.json() as any).configured, false);
  }
  assert.deepEqual((await h.list('app_first')).credentials, []);
});

test('wrong KEK, changed owner/database/app context and tampered envelope fail closed', async t => {
  const h = await harness(t); assert.equal((await h.call({ appId: 'app_first', input: input() })).status, 200);
  for (const options of [{ keyring: keyring() }, { ownerId: 'different-owner' }, { dbIdentity: 'different-db' }]) {
    const response = await h.call({ action: 'list', appId: 'app_first', ...options }); assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'VAULT_UNAVAILABLE' });
  }
  const [row] = await h.sql('SELECT * FROM flora_credential_versions');
  await h.sql('UPDATE flora_credential_versions SET app_id=? WHERE app_id=?', ['app_second', 'app_first']);
  assert.equal((await h.call({ action: 'list', appId: 'app_second' })).status, 503);
  await h.sql('UPDATE flora_credential_versions SET app_id=? WHERE app_id=?', ['app_first', 'app_second']);
  const changed = JSON.parse(row.envelope); changed.ciphertext = 'A' + changed.ciphertext.slice(1);
  if (changed.ciphertext === JSON.parse(row.envelope).ciphertext) changed.ciphertext = 'B' + changed.ciphertext.slice(1);
  await h.sql('UPDATE flora_credential_versions SET envelope=?', [JSON.stringify(changed)]);
  assert.equal((await h.call({ action: 'list', appId: 'app_first' })).status, 503);
  assert.equal((await h.call({ appId: 'app_first', input: input(1) })).status, 503);
  assert.equal((await h.sql('SELECT count(*) AS count FROM flora_credential_history'))[0].count, 1);
  await h.sql('UPDATE flora_credential_versions SET envelope=?', [row.envelope]);
  const data = JSON.parse(row.data); data.label = 'tampered label';
  await h.sql('UPDATE flora_credential_versions SET data=?', [JSON.stringify(data)]);
  assert.equal((await h.call({ action: 'list', appId: 'app_first' })).status, 503);
});

test('fresh DEKs and nonces round-trip under retained KEKs and survive registry reconstruction', async t => {
  const h = await harness(t); assert.equal((await h.call({ appId: 'app_first', input: input() })).status, 200);
  assert.equal((await h.call({ appId: 'app_first', input: input(1) })).status, 200);
  const rows = await h.sql('SELECT * FROM flora_credential_versions ORDER BY version');
  const envelopes = rows.map(row => JSON.parse(row.envelope));
  assert.notEqual(envelopes[0].iv, envelopes[1].iv); assert.notEqual(envelopes[0].wrapIv, envelopes[1].wrapIv);
  assert.notEqual(envelopes[0].iv, envelopes[0].wrapIv); assert.notEqual(envelopes[0].wrappedKey, envelopes[1].wrappedKey);
  const keys = JSON.parse(h.ring).keys; const kek = await crypto.subtle.importKey('raw', Buffer.from(keys.v1, 'base64url'), 'AES-GCM', false, ['decrypt']);
  const envelope = envelopes[0]; const aad = (purpose: string) => new TextEncoder().encode(JSON.stringify(['flora-credential-v1', 'synthetic-owner', 'synthetic-db', 'app_first', 'android_keystore', 1, 'v1', purpose, rows[0].data]));
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(envelope.wrapIv, 'base64url'), additionalData: aad('dek'), tagLength: 128 }, kek, Buffer.from(envelope.wrappedKey, 'base64url'));
  const dek = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(envelope.iv, 'base64url'), additionalData: aad('payload'), tagLength: 128 }, dek, Buffer.from(envelope.ciphertext, 'base64url'));
  assert.equal(JSON.parse(new TextDecoder().decode(plaintext)).password, 'synthetic-sensitive-password');
  const newRing = JSON.stringify({ active: 'v2', keys: { ...keys, v2: randomBytes(32).toString('base64url') } });
  const listed = await h.call({ action: 'list', appId: 'app_first', keyring: newRing }); assert.equal(listed.status, 200);
  assert.equal((await h.call({ appId: 'app_first', input: input(2), keyring: newRing })).status, 200);
  assert.equal((await h.call({ action: 'list', appId: 'app_first', keyring: h.ring })).status, 503);
});

test('version and encrypted-byte capacity are checked atomically without removing earlier versions', async t => {
  const h = await harness(t);
  for (let version = 0; version < 20; version++) assert.equal((await h.call({ appId: 'app_first', input: input(version) })).status, 200);
  assert.equal((await h.call({ appId: 'app_first', input: input(20) })).status, 409);
  assert.equal((await h.list('app_first')).history.length, 20);
  const large = 'z'.repeat(1_048_576);
  assert.equal((await h.call({ appId: 'app_large', input: input(0, large) })).status, 200);
  assert.equal((await h.call({ appId: 'app_large', input: input(1, large) })).status, 200);
  const before = await h.list('app_large');
  const denied = await h.call({ appId: 'app_large', input: input(2, large) }); assert.equal(denied.status, 409);
  assert.deepEqual(await denied.json(), { error: 'CREDENTIAL_CAPACITY' }); assert.deepEqual(await h.list('app_large'), before);
});

test('owner encrypted-byte accounting applies across apps and transaction rollback retains the earlier state', async t => {
  const h = await harness(t), large = 'z'.repeat(1_048_576);
  for (const appId of ['app_large_a', 'app_large_b', 'app_large_c', 'app_large_d']) {
    assert.equal((await h.call({ appId, input: input(0, large) })).status, 200);
    assert.equal((await h.call({ appId, input: input(1, large) })).status, 200);
  }
  const denied = await h.call({ appId: 'app_large_e', input: input(0, large) });
  assert.equal(denied.status, 409); assert.deepEqual(await denied.json(), { error: 'CREDENTIAL_CAPACITY' });
  assert.deepEqual((await h.list('app_large_e')).credentials, []);
  const usage = (await h.sql('SELECT SUM(encrypted_bytes) AS used FROM flora_credential_versions'))[0].used;
  assert.ok(usage <= 16 * 1024 * 1024);
  const before = await h.list('app_large_a');
  await h.sql("CREATE TRIGGER reject_history BEFORE INSERT ON flora_credential_history BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  assert.equal((await h.call({ appId: 'app_first', input: input() })).status, 401);
  assert.deepEqual((await h.list('app_first')).credentials, []);
  assert.deepEqual(await h.list('app_large_a'), before);
  assert.equal((await h.sql('SELECT count(*) AS count FROM flora_credential_versions'))[0].count, 8);
});
