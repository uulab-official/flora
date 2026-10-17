export type NativePlatform = 'ios' | 'android';
export type NativeCredentialKind = 'ios_distribution' | 'ios_provisioning' | 'android_keystore';
export interface NativeCredentialPin { kind: NativeCredentialKind; version: number }
export interface NativeJobInput {
  requestKey: string; commitSha: string; platform: NativePlatform; appIdentifier: string;
  teamId?: string; credentials: NativeCredentialPin[];
}
export interface NativeSource {
  owner: string; repository: string; ref: string; rootDirectory: string;
  installationId: number; connectionVersion: number;
}
export interface NativeLease {
  jobId: string; appId: string; platform: NativePlatform; runnerId: string; attemptId: string;
  credentialEpoch: number; fence: number; expiresAt: number;
}
export interface NativeArtifactReceipt {
  fileName: string; sha256: string; byteLength: number; appIdentifier: string;
  platform: NativePlatform; signerFingerprint: string; teamId?: string;
}
export interface NativeJob extends NativeJobInput {
  id: string; appId: string; source: NativeSource; configDigest: string; createdAt: number;
  updatedAt: number; state: 'queued' | 'leased' | 'cancel_requested' | 'cancelled' | 'failed' | 'succeeded';
  lease: NativeLease | null; claimedAt: number | null; code: string | null; artifact: NativeArtifactReceipt | null;
  /** Signing is verified by the trusted native controller, not by the Worker. */
  artifactVerification: 'runner_reported' | null;
}
export interface NativeRunnerSummary {
  id: string; appId: string; platform: NativePlatform; name: string; createdAt: number;
  credentialEpoch: number; revokedAt: number | null; lastSeenAt: number | null;
}
export interface NativeRunnerCredential extends NativeRunnerSummary { tokenHash: string }
export class NativeBuildError extends Error {
  constructor(readonly status: number, readonly code: string) { super('Native build request failed'); this.name = 'NativeBuildError'; }
}
export function nativeCheck(condition: unknown, status = 400, code = 'INVALID_NATIVE_INPUT'): asserts condition {
  if (!condition) throw new NativeBuildError(status, code);
}
export function nativeObject(input: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  nativeCheck(input && typeof input === 'object' && !Array.isArray(input));
  const value = input as Record<string, unknown>;
  nativeCheck(required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
  return value;
}
export function nativeId(value: unknown): string { nativeCheck(typeof value === 'string' && /^[a-z][a-z0-9_-]{2,95}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value)); return value; }
export function nativePlatform(value: unknown): NativePlatform { nativeCheck(value === 'ios' || value === 'android'); return value; }
export function nativeInteger(value: unknown, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  nativeCheck(Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum); return value as number;
}
function identity(value: unknown): string { nativeCheck(typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*){1,15}$/.test(value) && value.length <= 254); return value; }
export function nativePins(input: unknown, platform: NativePlatform): NativeCredentialPin[] {
  nativeCheck(Array.isArray(input));
  const allowed = platform === 'ios' ? ['ios_distribution', 'ios_provisioning'] : ['android_keystore'];
  nativeCheck(input.length === allowed.length);
  const pins = input.map(item => { const value = nativeObject(item, ['kind', 'version']); nativeCheck(typeof value.kind === 'string' && allowed.includes(value.kind)); return { kind: value.kind as NativeCredentialKind, version: nativeInteger(value.version) }; });
  nativeCheck(new Set(pins.map(pin => pin.kind)).size === allowed.length); return pins.sort((a, b) => a.kind.localeCompare(b.kind));
}
export function parseNativeJobInput(input: unknown): NativeJobInput {
  const value = nativeObject(input, ['requestKey', 'commitSha', 'platform', 'appIdentifier', 'credentials'], ['teamId']);
  const platform = nativePlatform(value.platform), appIdentifier = identity(value.appIdentifier);
  nativeCheck(typeof value.commitSha === 'string' && /^[a-f0-9]{40}$/.test(value.commitSha));
  nativeCheck(platform === 'ios' ? typeof value.teamId === 'string' && /^[A-Z0-9]{10}$/.test(value.teamId) : value.teamId === undefined);
  return { requestKey: nativeId(value.requestKey), commitSha: value.commitSha, platform, appIdentifier,
    ...(platform === 'ios' ? { teamId: value.teamId as string } : {}), credentials: nativePins(value.credentials, platform) };
}
export function parseNativeLease(input: unknown): NativeLease {
  const v = nativeObject(input, ['jobId', 'appId', 'platform', 'runnerId', 'attemptId', 'credentialEpoch', 'fence', 'expiresAt']);
  return { jobId: nativeId(v.jobId), appId: nativeId(v.appId), platform: nativePlatform(v.platform), runnerId: nativeId(v.runnerId), attemptId: nativeId(v.attemptId),
    credentialEpoch: nativeInteger(v.credentialEpoch), fence: nativeInteger(v.fence), expiresAt: nativeInteger(v.expiresAt) };
}
export function parseNativeArtifact(input: unknown): NativeArtifactReceipt {
  const v = nativeObject(input, ['fileName', 'sha256', 'byteLength', 'appIdentifier', 'platform', 'signerFingerprint'], ['teamId']);
  const platform = nativePlatform(v.platform);
  nativeCheck(typeof v.fileName === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,126}\.(?:ipa|apk|aab)$/.test(v.fileName));
  nativeCheck(platform === 'ios' ? v.fileName.endsWith('.ipa') : /\.(?:apk|aab)$/.test(v.fileName));
  nativeCheck(typeof v.sha256 === 'string' && /^[a-f0-9]{64}$/.test(v.sha256));
  nativeCheck(typeof v.signerFingerprint === 'string' && /^[a-f0-9]{64}$/.test(v.signerFingerprint));
  nativeCheck(platform === 'ios' ? typeof v.teamId === 'string' && /^[A-Z0-9]{10}$/.test(v.teamId) : v.teamId === undefined);
  return { fileName: v.fileName, sha256: v.sha256, byteLength: nativeInteger(v.byteLength, 1, 512 * 1024 * 1024), appIdentifier: identity(v.appIdentifier), platform, signerFingerprint: v.signerFingerprint,
    ...(platform === 'ios' ? { teamId: v.teamId as string } : {}) };
}
