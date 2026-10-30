/**
 * Public-only, app-scoped export of a trusted Runner's signed-artifact report.
 * No credentials, bearer tokens, signing material or private source bytes.
 * The resulting JSON is NOT an attestation; local users still verify bytes.
 */
const ID = /^[a-z][a-z0-9_-]{2,95}$/;
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,179}\.(?:apk|aab|ipa)$/;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;

export function createNativePublicReceipt(appId, job) {
  const artifact = job?.artifact;
  if (!ID.test(appId ?? "") || job?.appId !== appId || !ID.test(job.id ?? "") ||
    !SHA.test(job.commitSha ?? "") || job.state !== "succeeded" ||
    job.artifactVerification !== "runner_reported" ||
    !artifact || artifact.platform !== job.platform ||
    !["ios", "android"].includes(job.platform) ||
    typeof artifact.fileName !== "string" || !NAME.test(artifact.fileName) ||
    !HASH.test(artifact.sha256 ?? "") || !HASH.test(artifact.signerFingerprint ?? "") ||
    !Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 1 ||
    artifact.byteLength > 4 * 1024 ** 3 ||
    typeof artifact.appIdentifier !== "string" || artifact.appIdentifier.length > 254 ||
    !IDENTIFIER.test(artifact.appIdentifier) ||
    (job.platform === "ios" ? !artifact.fileName.endsWith(".ipa") :
      !(artifact.fileName.endsWith(".apk") || artifact.fileName.endsWith(".aab"))) ||
    (job.platform === "ios" ? artifact.teamId !== undefined && !/^[A-Z0-9]{10}$/.test(artifact.teamId) : artifact.teamId !== undefined))
    return null;
  // Fixed allowlist: never serialize the source job, lease, internal credentials,
  // private runner data, or server storage paths.
  const safeArtifact = {
    fileName: artifact.fileName, sha256: artifact.sha256,
    byteLength: artifact.byteLength, appIdentifier: artifact.appIdentifier,
    platform: artifact.platform, signerFingerprint: artifact.signerFingerprint,
    ...(artifact.teamId === undefined ? {} : { teamId: artifact.teamId }),
  };
  return JSON.stringify({
    schemaVersion: 1, source: "flora-native-runner-report",
    appId, jobId: job.id, commitSha: job.commitSha, state: "succeeded",
    artifactVerification: "runner_reported", artifact: safeArtifact,
  }, null, 2) + "\n";
}
