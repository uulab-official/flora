import { isAbsolute } from 'node:path';
import { isRecord } from './build-lifecycle.mjs';
const digest = value => typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
export function snapshotSignaturePolicy(value) {
  if (!isRecord(value) || Object.keys(value).some(k => !['scheme','javaExecutable','expectedSignerSha256','timeoutMs'].includes(k))
      || value.scheme !== 'aab-jar-v1' || !digest(value.expectedSignerSha256)
      || typeof value.javaExecutable !== 'string' || !isAbsolute(value.javaExecutable) || /[\x00-\x1f\x7f]/.test(value.javaExecutable)
      || !Number.isSafeInteger(value.timeoutMs ?? 30000) || (value.timeoutMs ?? 30000) < 100 || (value.timeoutMs ?? 30000) > 120000)
    throw new Error('ARTIFACT_SIGNATURE_POLICY_INVALID');
  return Object.freeze({ scheme: value.scheme, javaExecutable: value.javaExecutable, expectedSignerSha256: value.expectedSignerSha256, timeoutMs: value.timeoutMs ?? 30000 });
}
export function signatureExpectation(policy) {
  if (policy === undefined) return null;
  policy = snapshotSignaturePolicy(policy);
  return Object.freeze({ scheme: policy.scheme, signerSha256: policy.expectedSignerSha256 });
}
export function validateSignatureExpectation(value) {
  if (!isRecord(value) || Object.keys(value).length !== 2 || value.scheme !== 'aab-jar-v1' || !digest(value.signerSha256))
    throw new Error('ARTIFACT_SIGNATURE_POLICY_INVALID');
  return Object.freeze({scheme:value.scheme,signerSha256:value.signerSha256});
}
export function validateSignatureEvidence(value, artifact, expectation) {
  const fields = ['version','scheme','verifier','sha256','byteCount','signerSha256','signedEntries','verifiedAt','certificateNotBefore','certificateNotAfter','javaFeature','bundleValidated','installVerified'];
  if (!isRecord(value) || Object.keys(value).length !== fields.length || Object.keys(value).some(k => !fields.includes(k))
      || value.version !== 1 || value.scheme !== 'aab-jar-v1' || value.verifier !== 'flora-jarfile-v1'
      || !digest(value.sha256) || value.sha256 !== artifact.sha256 || value.byteCount !== artifact.byteCount
      || artifact.platform !== 'android' || artifact.format !== 'aab' || !digest(value.signerSha256)
      || !Number.isSafeInteger(value.signedEntries) || value.signedEntries < 2 || value.signedEntries > 50000
      || !Number.isSafeInteger(value.javaFeature) || value.javaFeature < 17 || value.javaFeature > 1000
      || typeof value.verifiedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.verifiedAt)
      || !Number.isFinite(Date.parse(value.verifiedAt)) || new Date(value.verifiedAt).toISOString() !== value.verifiedAt || !Number.isSafeInteger(value.certificateNotBefore) || !Number.isSafeInteger(value.certificateNotAfter)
      || Date.parse(value.verifiedAt) < value.certificateNotBefore || Date.parse(value.verifiedAt) > value.certificateNotAfter
      || value.bundleValidated !== false || value.installVerified !== false
      || (expectation && (value.scheme !== expectation.scheme || value.signerSha256 !== expectation.signerSha256)))
    throw new Error('ARTIFACT_SIGNATURE_EVIDENCE_INVALID');
  return Object.freeze(Object.fromEntries(fields.map(k => [k, value[k]])));
}
// Historical observation only. A matching digest does not establish backup provenance.
export function validateArtifactSigning(artifact) {
  if (artifact.signatureVerified === true) return validateSignatureEvidence(artifact.signatureEvidence, artifact);
  if (artifact.signatureVerified !== false || artifact.signatureEvidence !== undefined) throw new Error('ARTIFACT_SIGNATURE_EVIDENCE_INVALID');
  return null;
}
