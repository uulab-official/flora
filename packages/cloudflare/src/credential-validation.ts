import { CREDENTIAL_KINDS, type CredentialKind, type ValidatedCredential } from './credential-types.js';
export { CREDENTIAL_KINDS } from './credential-types.js';
export type { CredentialKind, CredentialImportInput, ValidatedCredential } from './credential-types.js';
export class CredentialValidationError extends Error {
  readonly code = 'INVALID_CREDENTIAL_IMPORT';
  constructor() { super('Invalid credential import'); this.name = 'CredentialValidationError'; }
}
function invalid(): never { throw new CredentialValidationError(); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).some(key => !keys.includes(key))) invalid();
}
function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\x00-\x1f\x7f]/.test(value)) invalid();
  return value;
}
export function parseCredentialKind(value: unknown): CredentialKind {
  if (!CREDENTIAL_KINDS.includes(value as CredentialKind)) invalid();
  return value as CredentialKind;
}
function fileBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !value.length || value.length > 1398104 || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) invalid();
  let decoded: string;
  try { decoded = atob(value); } catch { invalid(); }
  if (!decoded.length || decoded.length > 1048576 || btoa(decoded) !== value) invalid();
  return Uint8Array.from(decoded, char => char.charCodeAt(0));
}
function pemBytes(pem: string): Uint8Array<ArrayBuffer> {
  const match = /^\s*-----BEGIN PRIVATE KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END PRIVATE KEY-----\s*$/.exec(pem);
  if (!match) invalid();
  return fileBytes(match[1]!.replace(/[\r\n]/g, ''));
}
async function privateKey(pem: string, ec: boolean): Promise<string> {
  const key = await crypto.subtle.importKey('pkcs8', pemBytes(pem), ec
    ? { name: 'ECDSA', namedCurve: 'P-256' }
    : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, true, ['sign']);
  if (!ec && (key.algorithm as { name: string; modulusLength: number }).modulusLength < 2048) invalid();
  const jwk = await crypto.subtle.exportKey('jwk', key) as JsonWebKey;
  // Fingerprint only the public key, stable across PKCS8 serialization.
  const canonical = ec ? JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })
    : JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
function identity(metadata: Record<string,string>, field: string, derived: string) {
  if (metadata[field] !== undefined && metadata[field] !== derived) invalid();
  metadata[field] = derived;
}
export async function validateCredentialImport(value: unknown): Promise<ValidatedCredential> {
  try {
    const source = record(value);
    exact(source, ['kind', 'label', 'expectedVersion', 'metadata', 'payload']);
    const kind = parseCredentialKind(source.kind);
    const label = text(source.label, 120).trim();
    if (!label || !Number.isSafeInteger(source.expectedVersion) || (source.expectedVersion as number) < 0 || (source.expectedVersion as number) >= Number.MAX_SAFE_INTEGER) invalid();
    const rawMetadata = record(source.metadata);
    exact(rawMetadata, ['appIdentifier', 'teamId', 'keyId', 'issuerId', 'projectId', 'environment']);
    const metadata: Record<string,string> = {};
    for (const [key, value] of Object.entries(rawMetadata)) {
      const safe = text(value);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/.test(safe)) invalid();
      metadata[key] = safe;
    }
    const rawPayload = record(source.payload);
    exact(rawPayload, ['fileBase64', 'password', 'keyAlias', 'keyPassword']);
    const bytes = fileBytes(rawPayload.fileBase64);
    const payload: Record<string,string> = { fileBase64: rawPayload.fileBase64 as string };
    for (const field of ['password', 'keyAlias', 'keyPassword']) {
      if (rawPayload[field] !== undefined) {
        if (typeof rawPayload[field] !== 'string' || (rawPayload[field] as string).length > 4096 || /\x00/.test(rawPayload[field] as string)) invalid();
        payload[field] = rawPayload[field] as string;
      }
    }
    let verification: ValidatedCredential['verification'] = 'stored_unverified';
    let fingerprint: string | null = null;
    if (['apns', 'app_store_connect', 'google_play', 'fcm'].includes(kind)) {
      if (bytes.byteLength > 65536) invalid();
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      if (kind === 'apns' || kind === 'app_store_connect') fingerprint = await privateKey(content, true);
      else {
        const account = record(JSON.parse(content));
        if (account.type !== 'service_account' || (account.token_uri !== undefined && account.token_uri !== 'https://oauth2.googleapis.com/token')) invalid();
        const project = text(account.project_id);
        const email = text(account.client_email, 320);
        if (!/^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$/.test(email)) invalid();
        identity(metadata, 'projectId', project);
        metadata.clientEmail = email;
        metadata.privateKeyId = text(account.private_key_id);
        identity(metadata, 'keyId', metadata.privateKeyId);
        fingerprint = await privateKey(textPem(account.private_key), false);
      }
      verification = 'key_format_verified';
    } else if (kind === 'firebase_android') {
      if (bytes.byteLength > 65536) invalid();
      const config = record(JSON.parse(new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(bytes)));
      const projectInfo = record(config.project_info);
      const project = text(projectInfo.project_id);
      const identifier = text(metadata.appIdentifier);
      if (!Array.isArray(config.client) || config.client.length > 100) invalid();
      const matches = config.client.some(client => {
        const info = record(record(client).client_info);
        return record(info.android_client_info).package_name === identifier;
      });
      if (!matches) invalid();
      identity(metadata, 'projectId', project);
      verification = 'app_identity_verified';
    }
    const payloadJson = JSON.stringify(payload);
    return { kind, label, expectedVersion: source.expectedVersion as number, metadata, payloadJson,
      byteLength: new TextEncoder().encode(payloadJson).byteLength, verification, fingerprint, expiresAt: null };
  } catch { throw new CredentialValidationError(); }
}
function textPem(value: unknown): string {
  if (typeof value !== 'string' || value.length > 65536) invalid();
  return value;
}
