import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, rename, rm, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { verifyNativeArtifactFile } from "./native-artifact-file.mjs";

// Local-only, app-scoped build receipt store; never a public HTTP endpoint.
// Caller must supply an independently authorized build job (not manifest data).
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
async function privateDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path || (info.mode & 0o077) !== 0)
    throw new Error("ARTIFACT_STORE_DIRECTORY_UNSAFE");
}
function segment(value) {
  if (typeof value !== "string" || !ID.test(value) || value === "." || value === "..") throw new Error("ARTIFACT_SCOPE_INVALID");
  return value;
}
export async function publishLocalArtifact({ root, sourcePath, manifest, authorizedJob }) {
  if (typeof root !== "string" || !isAbsolute(root)) throw new Error("ARTIFACT_ROOT_INVALID");
  const appId = segment(authorizedJob?.appId);
  const jobId = segment(authorizedJob?.jobId);
  const sourceReceipt = await verifyNativeArtifactFile({ filePath: sourcePath, manifest, expected: authorizedJob });
  const directory = join(resolve(root), appId, jobId);
  await mkdir(resolve(root), { recursive: true, mode: 0o700 });
  await privateDirectory(resolve(root));
  await mkdir(join(resolve(root), appId), { mode: 0o700, recursive: true });
  await privateDirectory(join(resolve(root), appId));
  await mkdir(directory, { mode: 0o700, recursive: true });
  await privateDirectory(directory);
  const ticket = randomBytes(12).toString("hex");
  const temp = join(directory, "." + ticket + ".partial");
  const target = join(directory, ticket + ".bin");
  let input, output;
  try {
    input = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await input.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size !== sourceReceipt.byteCount)
      throw new Error("ARTIFACT_SOURCE_CHANGED");
    output = await open(temp, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > sourceReceipt.byteCount) throw new Error("ARTIFACT_SOURCE_CHANGED");
      await output.writeFile(chunk);
      hash.update(chunk);
    }
    const after = await input.stat();
    if (size !== sourceReceipt.byteCount || before.ino !== after.ino || before.dev !== after.dev
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error("ARTIFACT_SOURCE_CHANGED");
    const digest = hash.digest();
    if (!timingSafeEqual(digest, Buffer.from(sourceReceipt.sha256, "hex"))) throw new Error("ARTIFACT_COPY_HASH_MISMATCH");
    await output.sync();
    await output.close(); output = null;
    // Destination has a random, previously absent name inside the private local store.
    await rename(temp, target);
    const committed = await lstat(target);
    if (!committed.isFile() || committed.nlink !== 1 || committed.size !== size) throw new Error("ARTIFACT_PUBLISH_INVALID");
    return Object.freeze({ ...sourceReceipt, artifactId: ticket, storage: "local-only", filePath: target });
  } catch (error) {
    if (output) { await output.close().catch(() => {}); output = null; }
    await rm(temp, { force: true });
    throw error;
  } finally {
    if (output) await output.close().catch(() => {});
    if (input) await input.close().catch(() => {});
  }
}
export async function resolveLocalArtifact({ root, receipt, authorizedJob }) {
  if (typeof root !== "string" || !root.startsWith("/")) throw new Error("ARTIFACT_ROOT_INVALID");
  const appId = segment(authorizedJob?.appId);
  const jobId = segment(authorizedJob?.jobId);
  if (!receipt || receipt.appId !== appId || receipt.jobId !== jobId ||
      receipt.repository !== authorizedJob.repository || receipt.sourceSha !== authorizedJob.sourceSha ||
      receipt.platform !== authorizedJob.platform || !/^[a-f0-9]{24}$/.test(receipt.artifactId))
    throw new Error("ARTIFACT_SCOPE_MISMATCH");
  const directory = join(resolve(root), appId, jobId);
  await privateDirectory(resolve(root));
  await privateDirectory(join(resolve(root), appId));
  await privateDirectory(directory);
  const filePath = join(directory, receipt.artifactId + ".bin");
  const manifest = { ...receipt };
  return verifyNativeArtifactFile({ filePath, manifest, expected: authorizedJob });
}
