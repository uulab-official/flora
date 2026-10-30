export interface NativePublicArtifact {
  fileName: string;
  sha256: string;
  byteLength: number;
  appIdentifier: string;
  platform: "ios" | "android";
  signerFingerprint: string;
  teamId?: string;
}
export interface NativePublicJob {
  appId: string;
  id: string;
  commitSha: string;
  state: string;
  artifactVerification: string | null;
  platform: string;
  artifact: NativePublicArtifact | null;
}
export function createNativePublicReceipt(appId: string, job: NativePublicJob): string | null;
