import { randomBytes } from 'node:crypto';
import { lstat, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isBuildId } from './build-lifecycle.mjs';
import { validateArtifactMetadata } from './native-artifact-integrity.mjs';
import { verifyNativeArtifactFile } from './native-artifact-file.mjs';
import { copyVerifiedNativeArtifact } from './verified-copy.mjs';
import { localPath, privateDirectory, syncDirectory } from './private-paths.mjs';

const fields = ['appId', 'jobId', 'repository', 'sourceSha', 'platform', 'byteCount', 'sha256'];
const copyFields = object => Object.freeze(Object.fromEntries(fields.map(key => [key, object[key]])));
function identities(manifest, authorizedJob) {
  if (!isBuildId(authorizedJob?.appId) || !isBuildId(authorizedJob?.jobId)) throw new Error('ARTIFACT_SCOPE_INVALID');
  validateArtifactMetadata({ manifest, expected: authorizedJob, byteCount: manifest?.byteCount });
  return { manifest: copyFields(manifest), authorizedJob: copyFields(authorizedJob) };
}
async function directoryFor(root, job, create = false) {
  root = localPath(root, 'ARTIFACT_ROOT_INVALID');
  // The operator must control the canonical parent and all ancestors above it.
  const parent = dirname(root), info = await lstat(parent);
  if (!info.isDirectory() || await realpath(parent) !== parent || (info.mode & 0o022) !== 0
      || info.uid !== process.geteuid()) throw new Error('ARTIFACT_STORE_PARENT_UNSAFE');
  try {
    await privateDirectory(root, { create });
    const app = join(root, job.appId); await privateDirectory(app, { create });
    const directory = join(app, job.jobId); await privateDirectory(directory, { create }); return directory;
  } catch (error) { if (error.message === 'BUILD_DIRECTORY_UNSAFE') throw new Error('ARTIFACT_STORE_DIRECTORY_UNSAFE'); throw error; }
}
export async function publishLocalArtifact({ root, sourcePath, manifest, authorizedJob }) {
  ({ manifest, authorizedJob } = identities(manifest, authorizedJob));
  const directory = await directoryFor(root, authorizedJob, true), artifactId = randomBytes(12).toString('hex');
  const filePath = join(directory, artifactId + '.bin');
  const receipt = await copyVerifiedNativeArtifact({ sourcePath, targetPath: filePath, manifest, expected: authorizedJob });
  // Internal receipt only: a public response must whitelist fields and omit filePath.
  return Object.freeze({ ...receipt, artifactId, storage: 'local-only', filePath });
}
async function locate({ root, receipt, authorizedJob }) {
  const identity = identities(receipt, authorizedJob);
  if (typeof receipt.artifactId !== 'string' || !/^[a-f0-9]{24}$/.test(receipt.artifactId) || receipt.artifactId.length !== 24)
    throw new Error('ARTIFACT_SCOPE_MISMATCH');
  const artifactId = receipt.artifactId, directory = await directoryFor(root, identity.authorizedJob);
  return { ...identity, directory, filePath: join(directory, artifactId + '.bin') };
}
export async function resolveLocalArtifact(options) {
  const value = await locate(options);
  return verifyNativeArtifactFile({ filePath: value.filePath, manifest: value.manifest, expected: value.authorizedJob });
}
export async function exportLocalArtifact({ targetPath, ...options }) {
  const value = await locate(options);
  return copyVerifiedNativeArtifact({ sourcePath: value.filePath, targetPath, manifest: value.manifest, expected: value.authorizedJob });
}
// Internal rollback of an artifact just created by this process; never expose as a general delete endpoint.
export async function discardUncommittedArtifact(options) {
  const value = await locate(options); await rm(value.filePath); await syncDirectory(value.directory);
}
