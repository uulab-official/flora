import type { DurableObject } from 'cloudflare:workers';
import { parseCredentialKind, validateCredentialImport } from './credential-validation.js';
import type { CredentialKind, ValidatedCredential } from './credential-types.js';
import type { NativeCredentialPin, NativeJobInput } from './native-types.js';
type Storage = ConstructorParameters<typeof DurableObject>[0]['storage'];
type Fence = () => void;
type Verification = ValidatedCredential['verification'];
export interface CredentialSummary {
  kind: CredentialKind; label: string; version: number; activeVersion: number | null;
  metadata: Record<string, string>; verification: Verification; fingerprint: string | null;
  expiresAt: number | null; createdAt: number; byteLength: number;
}
export interface CredentialHistory extends CredentialSummary {
  id: string; action: 'registered' | 'rotated' | 'disabled'; actor: string;
}
export interface CredentialView { appId: string; configured: boolean; credentials: CredentialSummary[]; history: CredentialHistory[] }
type VersionRow = { app_id: string; kind: CredentialKind; version: number; data: string; envelope: string; encrypted_bytes: number };
type BindingRow = { kind: CredentialKind; revision: number; active_version: number | null; last_version: number };
interface Envelope { schemaVersion: 1; keyId: string; iv: string; ciphertext: string; wrapIv: string; wrappedKey: string }
interface Keyring { active: string; keys: Map<string, Uint8Array> }
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const appCapacity = 4 * 1024 * 1024, ownerCapacity = 16 * 1024 * 1024, maxEnvelope = 2 * 1024 * 1024;
const maxVersions = 20;
const encode = (bytes: Uint8Array): string => {
  let raw = ''; for (let offset = 0; offset < bytes.length; offset += 8192) raw += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(raw).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};
function decode(value: unknown, maximum: number): Uint8Array {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) throw unavailable();
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
  if (bytes.length > maximum || encode(bytes) !== value) throw unavailable(); return bytes;
}
function unavailable() { return new CredentialVaultError(503, 'VAULT_UNAVAILABLE'); }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function parseKeyring(raw: string | undefined): Keyring | null {
  try {
    if (typeof raw !== 'string' || raw.length > 8192) return null;
    const value: unknown = JSON.parse(raw);
    if (!exact(value, ['active', 'keys']) || typeof value.active !== 'string' || !value.keys || typeof value.keys !== 'object' || Array.isArray(value.keys)) return null;
    const entries = Object.entries(value.keys);
    if (!entries.length || entries.length > 3 || entries.some(([id]) => !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(id))) return null;
    const keys = new Map(entries.map(([id, key]) => { const bytes = decode(key, 32); if (bytes.length !== 32) throw unavailable(); return [id, bytes]; }));
    return keys.has(value.active) ? { active: value.active, keys } : null;
  } catch { return null; }
}
function checkIdentifier(value: string) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{2,95}$/.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) throw new CredentialVaultError(400, 'INVALID_CREDENTIAL_INPUT');
}
function checkRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= Number.MAX_SAFE_INTEGER) throw new CredentialVaultError(400, 'INVALID_CREDENTIAL_INPUT');
}
function checkActor(value: string) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 254 || /[\x00-\x1f\x7f]/.test(value)) throw new CredentialVaultError(400, 'INVALID_CREDENTIAL_INPUT');
}
export class CredentialVaultError extends Error {
  constructor(readonly status: number, readonly code: 'VAULT_UNAVAILABLE' | 'CREDENTIAL_CONFLICT' | 'CREDENTIAL_CAPACITY' | 'CREDENTIAL_NOT_FOUND' | 'INVALID_CREDENTIAL_INPUT') {
    super('Credential vault request failed'); this.name = 'CredentialVaultError';
  }
}
/** Private owner authority: no generic raw export or OTA Runner capability.
 * All crypto finishes before the short synchronous CAS/capacity transaction. */
export class CredentialVault {
  private readonly ring: Keyring | null;
  constructor(private readonly storage: Storage, keyring: string | undefined, private readonly config: { ownerId: string; dbIdentity: string }) {
    this.ring = parseKeyring(keyring);
    if ([config.ownerId, config.dbIdentity].some(value => typeof value !== 'string' || !value || value.length > 256 || /[\x00-\x1f\x7f]/.test(value))) throw unavailable();
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS flora_credential_versions (
      app_id TEXT NOT NULL, kind TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL,
      envelope TEXT NOT NULL, encrypted_bytes INTEGER NOT NULL, PRIMARY KEY(app_id,kind,version));
      CREATE TABLE IF NOT EXISTS flora_credential_bindings (
      app_id TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER NOT NULL, active_version INTEGER,
      last_version INTEGER NOT NULL, PRIMARY KEY(app_id,kind));
      CREATE TABLE IF NOT EXISTS flora_credential_history (
      id TEXT PRIMARY KEY, app_id TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER NOT NULL,
      data TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  }
  private rows(appId: string): VersionRow[] {
    return this.storage.sql.exec<VersionRow>('SELECT app_id,kind,version,data,envelope,encrypted_bytes FROM flora_credential_versions WHERE app_id=? ORDER BY kind,version', appId).toArray();
  }
  private binding(appId: string, kind: CredentialKind): BindingRow | null {
    return this.storage.sql.exec<BindingRow>('SELECT kind,revision,active_version,last_version FROM flora_credential_bindings WHERE app_id=? AND kind=?', appId, kind).toArray()[0] ?? null;
  }
  private aad(row: Pick<VersionRow, 'app_id' | 'kind' | 'version' | 'data'>, keyId: string, purpose: 'dek' | 'payload'): Uint8Array {
    return encoder.encode(JSON.stringify(['flora-credential-v1', this.config.ownerId, this.config.dbIdentity, row.app_id, row.kind, row.version, keyId, purpose, row.data]));
  }
  private async seal(row: Pick<VersionRow, 'app_id' | 'kind' | 'version' | 'data'>, payload: string, fence: Fence): Promise<string> {
    if (!this.ring) throw unavailable();
    const keyId = this.ring.active, raw = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12)), wrapIv = crypto.getRandomValues(new Uint8Array(12));
    // A coincident nonce is harmless across keys, but keeping both distinct is
    // explicit and simplifies forensic checks of each version envelope.
    while (encode(iv) === encode(wrapIv)) crypto.getRandomValues(wrapIv);
    try {
      const kek = await crypto.subtle.importKey('raw', this.ring.keys.get(keyId)!, 'AES-GCM', false, ['encrypt']); fence();
      const dek = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']); fence();
      const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv, additionalData: this.aad(row, keyId, 'dek'), tagLength: 128 }, kek, raw); fence();
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: this.aad(row, keyId, 'payload'), tagLength: 128 }, dek, encoder.encode(payload)); fence();
      return JSON.stringify({ schemaVersion: 1, keyId, iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)), wrapIv: encode(wrapIv), wrappedKey: encode(new Uint8Array(wrapped)) } satisfies Envelope);
    } finally { raw.fill(0); }
  }
  private async authenticate(rows: VersionRow[], fence: Fence): Promise<void> {
    if (!this.ring) throw unavailable();
    for (const row of rows) {
      let kek: CryptoKey, dek: CryptoKey, raw: ArrayBuffer | undefined, plaintext: ArrayBuffer | undefined, envelope: Envelope;
      try {
        if (encoder.encode(row.envelope).length !== row.encrypted_bytes || row.encrypted_bytes > maxEnvelope) throw unavailable();
        const candidate: unknown = JSON.parse(row.envelope);
        if (!exact(candidate, ['schemaVersion', 'keyId', 'iv', 'ciphertext', 'wrapIv', 'wrappedKey']) || candidate.schemaVersion !== 1 || typeof candidate.keyId !== 'string') throw unavailable();
        envelope = candidate as unknown as Envelope;
        const key = this.ring.keys.get(envelope.keyId); if (!key) throw unavailable();
        kek = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
      } catch { throw unavailable(); }
      fence();
      try {
        const iv = decode(envelope.wrapIv, 12); if (iv.length !== 12) throw unavailable();
        const wrapped = decode(envelope.wrappedKey, 48); if (wrapped.length !== 48) throw unavailable();
        raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: this.aad(row, envelope.keyId, 'dek'), tagLength: 128 }, kek, wrapped);
        if (raw.byteLength !== 32) throw unavailable();
      } catch { throw unavailable(); }
      try {
        fence();
        try { dek = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']); } catch { throw unavailable(); }
        fence();
        try {
          const iv = decode(envelope.iv, 12); if (iv.length !== 12) throw unavailable();
          plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: this.aad(row, envelope.keyId, 'payload'), tagLength: 128 }, dek, decode(envelope.ciphertext, 1_500_000));
          const data = JSON.parse(row.data) as CredentialSummary;
          if (plaintext.byteLength !== data.byteLength || data.kind !== row.kind || data.version !== row.version || data.activeVersion !== row.version) throw unavailable();
          JSON.parse(decoder.decode(plaintext));
        } catch { throw unavailable(); }
        fence();
      } finally { if (raw) new Uint8Array(raw).fill(0); if (plaintext) new Uint8Array(plaintext).fill(0); }
    }
  }
  private view(appId: string, rows = this.rows(appId)): CredentialView {
    const bindings = this.storage.sql.exec<BindingRow>('SELECT kind,revision,active_version,last_version FROM flora_credential_bindings WHERE app_id=? ORDER BY kind', appId).toArray();
    const credentials = bindings.map(binding => {
      const row = rows.find(row => row.kind === binding.kind && row.version === binding.last_version);
      if (!row) throw unavailable();
      return { ...JSON.parse(row.data) as CredentialSummary, version: binding.revision, activeVersion: binding.active_version };
    });
    const history = this.storage.sql.exec<{ data: string }>('SELECT data FROM flora_credential_history WHERE app_id=? ORDER BY created_at,rowid', appId).toArray().map(row => JSON.parse(row.data) as CredentialHistory);
    return { appId, configured: true, credentials, history };
  }
  /** The native controller owns the app/platform/job authority. This synchronous
   * binding check can run after every crypto await and inside its audit transaction. */
  assertNativePins(appId: string, scope: Pick<NativeJobInput, 'platform' | 'appIdentifier' | 'teamId' | 'credentials'>): void {
    checkIdentifier(appId); if (!this.ring) throw unavailable();
    const expected = scope.platform === 'ios' ? ['ios_distribution', 'ios_provisioning'] : ['android_keystore'];
    if (scope.credentials.length !== expected.length || new Set(scope.credentials.map(pin => pin.kind)).size !== expected.length) throw new CredentialVaultError(400, 'INVALID_CREDENTIAL_INPUT');
    for (const pin of scope.credentials) {
      checkRevision(pin.version);
      if (!expected.includes(pin.kind)) throw new CredentialVaultError(400, 'INVALID_CREDENTIAL_INPUT');
      const binding = this.binding(appId, pin.kind);
      if (!binding || binding.revision !== pin.version || binding.active_version !== pin.version) throw new CredentialVaultError(409, 'CREDENTIAL_CONFLICT');
      const row = this.rows(appId).find(row => row.kind === pin.kind && row.version === pin.version); if (!row) throw unavailable();
      let summary: CredentialSummary; try { summary = JSON.parse(row.data) as CredentialSummary; } catch { throw unavailable(); }
      if (summary.metadata.appIdentifier !== scope.appIdentifier || scope.platform === 'ios' && summary.metadata.teamId !== scope.teamId
        || summary.expiresAt !== null && summary.expiresAt <= Date.now()) throw new CredentialVaultError(409, 'CREDENTIAL_CONFLICT');
    }
  }
  /** Internal lease-scoped use only. The caller's fence checks live authority,
   * cancellation and pinned bindings, and records the grant before any response. */
  async grantNativeCredentials(appId: string, scope: Pick<NativeJobInput, 'platform' | 'appIdentifier' | 'teamId' | 'credentials'>, fence: Fence): Promise<Array<NativeCredentialPin & {
    metadata: Record<string, string>; fingerprint: string | null; payload: { fileBase64: string; password?: string; keyAlias?: string; keyPassword?: string };
  }>> {
    this.assertNativePins(appId, scope); fence();
    const result = [];
    for (const pin of scope.credentials) {
      const row = this.rows(appId).find(row => row.kind === pin.kind && row.version === pin.version); if (!row) throw unavailable();
      let envelope: Envelope, kek: CryptoKey, raw: ArrayBuffer | undefined, plaintext: ArrayBuffer | undefined;
      try {
        if (encoder.encode(row.envelope).length !== row.encrypted_bytes || row.encrypted_bytes > maxEnvelope) throw unavailable();
        const parsed: unknown = JSON.parse(row.envelope);
        if (!exact(parsed, ['schemaVersion', 'keyId', 'iv', 'ciphertext', 'wrapIv', 'wrappedKey']) || parsed.schemaVersion !== 1 || typeof parsed.keyId !== 'string') throw unavailable();
        envelope = parsed as unknown as Envelope;
        const key = this.ring!.keys.get(envelope.keyId); if (!key) throw unavailable();
        kek = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
      } catch { throw unavailable(); }
      fence(); this.assertNativePins(appId, scope);
      try {
        try {
          const iv = decode(envelope.wrapIv, 12), wrapped = decode(envelope.wrappedKey, 48);
          if (iv.length !== 12 || wrapped.length !== 48) throw unavailable();
          raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: this.aad(row, envelope.keyId, 'dek'), tagLength: 128 }, kek, wrapped);
          if (raw.byteLength !== 32) throw unavailable();
        } catch { throw unavailable(); }
        fence(); this.assertNativePins(appId, scope);
        let dek: CryptoKey; try { dek = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']); } catch { throw unavailable(); }
        fence(); this.assertNativePins(appId, scope);
        try {
          const iv = decode(envelope.iv, 12); if (iv.length !== 12) throw unavailable();
          plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: this.aad(row, envelope.keyId, 'payload'), tagLength: 128 }, dek, decode(envelope.ciphertext, 1_500_000));
          const summary = JSON.parse(row.data) as CredentialSummary;
          if (plaintext.byteLength !== summary.byteLength || summary.kind !== row.kind || summary.version !== row.version || summary.activeVersion !== row.version) throw unavailable();
          const payload = JSON.parse(decoder.decode(plaintext));
          if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.fileBase64 !== 'string'
            || Object.keys(payload).some(key => !['fileBase64', 'password', 'keyAlias', 'keyPassword'].includes(key))) throw unavailable();
          result.push({ ...pin, metadata: summary.metadata, fingerprint: summary.fingerprint, payload });
        } catch { throw unavailable(); }
        fence(); this.assertNativePins(appId, scope);
      } finally { if (raw) new Uint8Array(raw).fill(0); if (plaintext) new Uint8Array(plaintext).fill(0); }
    }
    fence(); this.assertNativePins(appId, scope);
    // Keep the machine response under the shared bounded JSON response limit.
    if (encoder.encode(JSON.stringify(result)).length > 950_000) throw new CredentialVaultError(409, 'CREDENTIAL_CAPACITY');
    return result;
  }
  async list(appId: string, fence: Fence): Promise<CredentialView> {
    checkIdentifier(appId); fence();
    if (!this.ring) return { appId, configured: false, credentials: [], history: [] };
    const rows = this.rows(appId), view = this.view(appId, rows);
    await this.authenticate(rows, fence); fence();
    return view;
  }
  async import(appId: string, input: unknown, actor: string, fence: Fence, committed?:(version:number)=>void): Promise<CredentialView> {
    checkIdentifier(appId); checkActor(actor); fence(); if (!this.ring) throw unavailable();
    const validated = await validateCredentialImport(input); fence();
    checkRevision(validated.expectedVersion);
    const prior = this.binding(appId, validated.kind);
    if ((prior?.revision ?? 0) !== validated.expectedVersion) throw new CredentialVaultError(409, 'CREDENTIAL_CONFLICT');
    const rows = this.rows(appId); await this.authenticate(rows, fence); fence();
    const version = validated.expectedVersion + 1, now = Date.now();
    const summary: CredentialSummary = { kind: validated.kind, label: validated.label, version, activeVersion: version, metadata: validated.metadata,
      verification: validated.verification, fingerprint: validated.fingerprint, expiresAt: validated.expiresAt, createdAt: now, byteLength: validated.byteLength };
    const row = { app_id: appId, kind: validated.kind, version, data: JSON.stringify(summary) };
    const envelope = await this.seal(row, validated.payloadJson, fence); fence();
    const encryptedBytes = encoder.encode(envelope).length;
    if (encryptedBytes > maxEnvelope) throw new CredentialVaultError(409, 'CREDENTIAL_CAPACITY');
    return this.storage.transactionSync(() => {
      fence(); const current = this.binding(appId, validated.kind);
      if ((current?.revision ?? 0) !== validated.expectedVersion) throw new CredentialVaultError(409, 'CREDENTIAL_CONFLICT');
      const usage = this.storage.sql.exec<{ app_bytes: number; owner_bytes: number; versions: number }>(
        'SELECT COALESCE(SUM(CASE WHEN app_id=? THEN encrypted_bytes ELSE 0 END),0) AS app_bytes, COALESCE(SUM(encrypted_bytes),0) AS owner_bytes, COALESCE(SUM(CASE WHEN app_id=? AND kind=? THEN 1 ELSE 0 END),0) AS versions FROM flora_credential_versions', appId, appId, validated.kind).one();
      if (usage.app_bytes + encryptedBytes > appCapacity || usage.owner_bytes + encryptedBytes > ownerCapacity || usage.versions >= maxVersions) throw new CredentialVaultError(409, 'CREDENTIAL_CAPACITY');
      this.storage.sql.exec('INSERT INTO flora_credential_versions VALUES(?,?,?,?,?,?)', appId, validated.kind, version, row.data, envelope, encryptedBytes);
      this.storage.sql.exec('INSERT INTO flora_credential_bindings VALUES(?,?,?,?,?) ON CONFLICT(app_id,kind) DO UPDATE SET revision=excluded.revision,active_version=excluded.active_version,last_version=excluded.last_version', appId, validated.kind, version, version, version);
      const event: CredentialHistory = { ...summary, id: crypto.randomUUID(), action: current ? 'rotated' : 'registered', actor };
      this.storage.sql.exec('INSERT INTO flora_credential_history VALUES(?,?,?,?,?,?)', event.id, appId, validated.kind, version, JSON.stringify(event), now);
      committed?.(version);return this.view(appId);
    });
  }
  async disable(appId: string, kindInput: unknown, expectedVersion: unknown, actor: string, fence: Fence, committed?:(version:number)=>void): Promise<CredentialView> {
    checkIdentifier(appId); checkActor(actor); checkRevision(expectedVersion); const kind = parseCredentialKind(kindInput);
    fence(); if (!this.ring) throw unavailable();
    const prior = this.binding(appId, kind); if (!prior) throw new CredentialVaultError(404, 'CREDENTIAL_NOT_FOUND');
    if (prior.revision !== expectedVersion) throw new CredentialVaultError(409, 'CREDENTIAL_CONFLICT');
    if (prior.active_version === null) throw new CredentialVaultError(409, 'CREDENTIAL_CONFLICT');
    const rows = this.rows(appId); await this.authenticate(rows, fence); fence();
    return this.storage.transactionSync(() => {
      fence(); const current = this.binding(appId, kind);
      if (!current || current.revision !== expectedVersion || current.active_version === null) throw new CredentialVaultError(409, 'CREDENTIAL_CONFLICT');
      const row = rows.find(row => row.kind === kind && row.version === current.last_version); if (!row) throw unavailable();
      const now = Date.now(), event: CredentialHistory = { ...JSON.parse(row.data) as CredentialSummary, id: crypto.randomUUID(), action: 'disabled', actor, version: expectedVersion + 1, activeVersion: null, createdAt: now };
      this.storage.sql.exec('UPDATE flora_credential_bindings SET revision=?,active_version=NULL WHERE app_id=? AND kind=?', event.version, appId, kind);
      this.storage.sql.exec('INSERT INTO flora_credential_history VALUES(?,?,?,?,?,?)', event.id, appId, kind, event.version, JSON.stringify(event), now);
      committed?.(event.version);return this.view(appId);
    });
  }
}
