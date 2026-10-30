/**
 * Verify a PRIVATE caller's downloaded GitHub Actions artifact folder.
 * Local-only: no network access, credentials, GitHub installation token,
 * remote uploads, or Store-signature claims.
 *
 * A SHA256 receipt proves matching bytes relative to the local JSON manifest;
 * it is NOT a cryptographically signed GitHub provenance attestation.
 */
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, basename, sep } from "node:path";

const MAX_RECEIPT_BYTES = 65_536;
const MAX_FILE_BYTES = 4 * 1024 ** 3;
const MAX_TOTAL_BYTES = 8 * 1024 ** 3;
const MAX_ARTIFACTS = 10;
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;
const RUN = /^[1-9][0-9]{0,19}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,179}\.(?:apk|aab|ipa)$/;
type Platform = "android" | "ios";
type Profile = "preview" | "production";
interface BuildArtifact { name: string; sha256: string }
interface BuildReceipt {
  schemaVersion: number;
  source: string;
  repository: string;
  commitSha: string;
  runId: string;
  runAttempt: string;
  platform: Platform;
  profile: Profile;
  signingVerified: boolean;
  files: BuildArtifact[];
}
export interface BuildVerifyOptions {
  directory: string;
  repository: string;
  commitSha: string;
  runId?: string;
}
export interface BuildVerifyResult {
  schemaVersion: 1;
  status: "integrity_verified";
  repository: string;
  commitSha: string;
  runId: string;
  runAttempt: string;
  platform: Platform;
  profile: Profile;
  artifactCount: number;
  byteLength: number;
  files: BuildArtifact[];
  provenanceAttested: false;
  signatureVerified: false;
}

export class BuildVerifyError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BuildVerifyError"; }
}
const fail = (code: string): never => { throw new BuildVerifyError(code); };
const obj = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("BUILD_RECEIPT_INVALID");
  return value as Record<string, unknown>;
};
const exact = (value: Record<string, unknown>, keys: string[]) => {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some(k => !Object.hasOwn(value, k)))
    fail("BUILD_RECEIPT_INVALID");
};
const validRepo = (value: string) =>
  REPO.test(value) && !value.split("/").some(s => s === "." || s === ".." || s.endsWith(".lock"));
const isReceiptName = (name: string, platform: Platform) =>
  NAME.test(name) && basename(name) === name && !name.startsWith(".") &&
  (platform === "ios" ? name.endsWith(".ipa") : name.endsWith(".apk") || name.endsWith(".aab"));
function parseReceipt(value: unknown, options: BuildVerifyOptions): BuildReceipt {
  const data = obj(value);
  exact(data, ["schemaVersion", "source", "repository", "commitSha", "runId", "runAttempt",
    "platform", "profile", "signingVerified", "files"]);
  if (data.schemaVersion !== 1 || data.source !== "github-actions-caller" ||
    data.repository !== options.repository || data.commitSha !== options.commitSha ||
    typeof data.runId !== "string" || !RUN.test(data.runId) ||
    typeof data.runAttempt !== "string" || !RUN.test(data.runAttempt) ||
    (options.runId && data.runId !== options.runId) ||
    (data.platform !== "ios" && data.platform !== "android") ||
    (data.profile !== "preview" && data.profile !== "production") ||
    data.signingVerified !== false || !Array.isArray(data.files) ||
    data.files.length < 1 || data.files.length > MAX_ARTIFACTS)
    return fail("BUILD_RECEIPT_INVALID");
  const platform: Platform = data.platform;
  const files: BuildArtifact[] = [];
  const seen = new Set<string>();
  for (const raw of data.files) {
    const record = obj(raw); exact(record, ["name", "sha256"]);
    const name = record.name, sha256 = record.sha256;
    if (typeof name !== "string" || typeof sha256 !== "string" ||
      !isReceiptName(name, platform) || !HASH.test(sha256) ||
      seen.has(name.toLowerCase()) || name === "flora-build-receipt.json")
      return fail("BUILD_RECEIPT_INVALID");
    seen.add(name.toLowerCase()); files.push({ name, sha256 });
  }
  return {
    schemaVersion: 1, source: "github-actions-caller",
    repository: options.repository, commitSha: options.commitSha,
    runId: data.runId, runAttempt: data.runAttempt,
    platform, profile: data.profile, signingVerified: false, files,
  };
}
export function parseBuildVerifyOptions(args: readonly string[]): BuildVerifyOptions {
  if (args[0] !== "verify") fail("BUILD_VERIFY_USAGE");
  const allowed = new Set(["--dir", "--repository", "--commit", "--run-id"]);
  const flags = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!flag || !allowed.has(flag) || flags.has(flag) || !value ||
      value.startsWith("--") || value.length > 1024) fail("BUILD_VERIFY_USAGE");
    flags.set(flag, value);
  }
  const directory = flags.get("--dir");
  const repository = flags.get("--repository");
  const commitSha = flags.get("--commit");
  const runId = flags.get("--run-id");
  if (!directory || !isAbsolute(directory) || !repository ||
    !validRepo(repository) || !commitSha || !SHA.test(commitSha) ||
    (runId !== undefined && !RUN.test(runId)) ||
    flags.size !== (runId === undefined ? 3 : 4)) fail("BUILD_VERIFY_USAGE");
  return { directory, repository, commitSha, ...(runId === undefined ? {} : { runId }) };
}
async function hashFile(file: string, expectedBytes: number): Promise<string> {
  const digest = createHash("sha256");
  let count = 0;
  try {
    for await (const chunk of createReadStream(file, { flags: "r" })) {
      count += (chunk as Buffer).byteLength;
      if (count > expectedBytes || count > MAX_FILE_BYTES) fail("BUILD_ARTIFACT_INVALID");
      digest.update(chunk as Buffer);
    }
  } catch (error) {
    if (error instanceof BuildVerifyError) throw error;
    return fail("BUILD_ARTIFACT_UNREADABLE");
  }
  if (count !== expectedBytes) fail("BUILD_ARTIFACT_CHANGED");
  return digest.digest("hex");
}
export async function verifyDownloadedBuild(options: BuildVerifyOptions): Promise<BuildVerifyResult> {
  if (!isAbsolute(options.directory) || !validRepo(options.repository) ||
    !SHA.test(options.commitSha) || (options.runId && !RUN.test(options.runId)))
    fail("BUILD_VERIFY_USAGE");
  let directory: string;
  try {
    const d = await lstat(options.directory);
    if (!d.isDirectory() || d.isSymbolicLink()) fail("BUILD_DIRECTORY_INVALID");
    directory = await realpath(options.directory);
  } catch (error) {
    if (error instanceof BuildVerifyError) throw error;
    return fail("BUILD_DIRECTORY_INVALID");
  }
  const receiptPath = join(directory, "flora-build-receipt.json");
  let data: BuildReceipt;
  try {
    const r = await lstat(receiptPath);
    if (!r.isFile() || r.isSymbolicLink() || r.nlink !== 1 || r.size > MAX_RECEIPT_BYTES || r.size < 2)
      fail("BUILD_RECEIPT_INVALID");
    const bytes = await readFile(receiptPath);
    if (bytes.byteLength !== r.size || bytes.byteLength > MAX_RECEIPT_BYTES)
      fail("BUILD_RECEIPT_INVALID");
    data = parseReceipt(JSON.parse(bytes.toString("utf8")) as unknown, options);
  } catch (error) {
    if (error instanceof BuildVerifyError) throw error;
    return fail("BUILD_RECEIPT_INVALID");
  }
  const items = await readdir(directory);
  if (items.length !== data.files.length + 1 ||
    !items.includes("flora-build-receipt.json") ||
    new Set(items.map(name => name.toLowerCase())).size !== items.length)
    fail("BUILD_ARTIFACT_SET_INVALID");
  const files: BuildArtifact[] = [];
  let byteLength = 0;
  for (const item of data.files) {
    const path = join(directory, item.name);
    try {
      const l = await lstat(path);
      if (!l.isFile() || l.isSymbolicLink() || l.nlink !== 1 ||
        l.size < 1 || l.size > MAX_FILE_BYTES || byteLength + l.size > MAX_TOTAL_BYTES)
        fail("BUILD_ARTIFACT_INVALID");
      // In addition to lstat, prevent unexpectedly reaching a different inode.
      const resolved = await realpath(path);
      if (resolved !== directory + sep + item.name) fail("BUILD_ARTIFACT_INVALID");
      const hashed = await hashFile(path, l.size);
      const after = await stat(path);
      if (after.size !== l.size || after.ino !== l.ino || after.dev !== l.dev)
        fail("BUILD_ARTIFACT_CHANGED");
      if (hashed !== item.sha256) fail("BUILD_ARTIFACT_HASH_MISMATCH");
      byteLength += l.size;
    } catch (error) {
      if (error instanceof BuildVerifyError) throw error;
      return fail("BUILD_ARTIFACT_UNREADABLE");
    }
    files.push({ ...item });
  }
  return {
    schemaVersion: 1, status: "integrity_verified",
    repository: data.repository, commitSha: data.commitSha, runId: data.runId,
    runAttempt: data.runAttempt, platform: data.platform, profile: data.profile,
    artifactCount: files.length, byteLength, files,
    provenanceAttested: false, signatureVerified: false,
  };
}
