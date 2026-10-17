export const CREDENTIAL_KINDS = [
  'ios_distribution', 'ios_provisioning', 'android_keystore', 'app_store_connect',
  'google_play', 'apns', 'fcm', 'firebase_android', 'firebase_ios',
] as const;
export type CredentialKind = typeof CREDENTIAL_KINDS[number];
export interface CredentialImportInput {
  kind: CredentialKind;
  label: string;
  expectedVersion: number;
  metadata: Record<string, string>;
  payload: { fileBase64: string; password?: string; keyAlias?: string; keyPassword?: string };
}
export interface ValidatedCredential {
  kind: CredentialKind;
  label: string;
  expectedVersion: number;
  metadata: Record<string, string>;
  payloadJson: string;
  byteLength: number;
  verification: 'stored_unverified' | 'key_format_verified' | 'app_identity_verified';
  fingerprint: string | null;
  expiresAt: number | null;
}
