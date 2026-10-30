/**
 * Local-only verification of the public part of Flora native Runner receipts.
 * This is a byte/hash consistency check, NOT Apple/Android signature validation
 * and NOT a cryptographically authenticated Runner statement.
 *
 * A user downloads the public receipt from their authenticated Flora console
 * and copies the actual .apk/.aab/.ipa from their OWN Runner into the same folder.
 * No artifact is uploaded to Flora, GitHub, or a third party.
 */
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, isAbsolute, join, sep } from "node:path";
import { BuildVerifyError } from "./build-verifier.js";

const fail = (code: string): never => { throw new BuildVerifyError(code); };
const MAX_RECEIPT = 65_536;
const MAX_ARTIFACT = 4 * 1024 ** 3;
const SLUG = /^[a-z][a-z0-9_-]{2,95}$/;
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,179}\.(?:apk|aab|ipa)$/;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*){1,15}$/;
const RECEIPT_NAME = "flora-native-build-receipt.json";

export interface NativeVerifyOptions {
  directory: string;
  appId: string;
  commitSha: string;
}
export interface NativeVerifyResult {
  schemaVersion: 1;
  status: "bytes_match_runner_report";
  appId: string;
  jobId: string;
  commitSha: string;
  platform: "ios" | "android";
  fileName: string;
  byteLength: number;
  sha256: string;
  appIdentifier: string;
  signerFingerprint: string;
  runnerReported: true;
  provenanceAttested: false;
  signatureVerified: false;
}
interface Receipt {
  schemaVersion: 1;
  source: "flora-native-runner-report";
  appId: string;
  jobId: string;
  commitSha: string;
  state: "succeeded";
  artifactVerification: "runner_reported";
  artifact: {
    fileName: string; sha256: string; byteLength: number;
    appIdentifier: string; platform: "ios" | "android";
    signerFingerprint: string; teamId?: string;
  };
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  if (!required.every(key => Object.hasOwn(value, key)) ||
    Object.keys(value).some(key => !required.includes(key) && !optional.includes(key)))
    fail("NATIVE_RECEIPT_INVALID");
}
function parseReceipt(value: unknown, plan: NativeVerifyOptions): Receipt {
  if (!isObject(value)) return fail("NATIVE_RECEIPT_INVALID");
  exact(value, ["schemaVersion","source","appId","jobId","commitSha","state","artifactVerification","artifact"]);
  const artifact = value.artifact;
  if (!isObject(artifact)) return fail("NATIVE_RECEIPT_INVALID");
  exact(artifact, ["fileName","sha256","byteLength","appIdentifier","platform","signerFingerprint"], ["teamId"]);
  if (value.schemaVersion !== 1 || value.source !== "flora-native-runner-report" ||
    value.appId !== plan.appId || !SLUG.test(String(value.jobId)) ||
    value.commitSha !== plan.commitSha || value.state !== "succeeded" ||
    value.artifactVerification !== "runner_reported" ||
    typeof artifact.fileName !== "string" || !NAME.test(artifact.fileName) ||
    basename(artifact.fileName) !== artifact.fileName ||
    typeof artifact.sha256 !== "string" || !HEX64.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.byteLength) || (artifact.byteLength as number) < 1 ||
    (artifact.byteLength as number) > MAX_ARTIFACT ||
    typeof artifact.appIdentifier !== "string" || artifact.appIdentifier.length > 254 ||
    !IDENTIFIER.test(artifact.appIdentifier) ||
    typeof artifact.signerFingerprint !== "string" || !HEX64.test(artifact.signerFingerprint) ||
    !["ios", "android"].includes(String(artifact.platform)))
    return fail("NATIVE_RECEIPT_INVALID");
  const platform = artifact.platform;
  if ((platform === "ios" ? !artifact.fileName.endsWith(".ipa") : !(artifact.fileName.endsWith(".apk") || artifact.fileName.endsWith(".aab"))) ||
    (platform === "ios" ? artifact.teamId !== undefined && (typeof artifact.teamId !== "string" ||
      !/^[A-Z0-9]{10}$/.test(artifact.teamId)) : artifact.teamId !== undefined))
    return fail("NATIVE_RECEIPT_INVALID");
  return value as unknown as Receipt;
}
export function parseNativeVerifyOptions(args: readonly string[]): NativeVerifyOptions {
  if (args[0] !== "verify-native") return fail("BUILD_VERIFY_USAGE");
  const values = new Map<string,string>();
  for (let i=1;i<args.length;i+=2) {
    const key=args[i],value=args[i+1];
    if (!key || !["--dir","--app-id","--commit"].includes(key) ||
      values.has(key) || !value || value.length>1024 || value.startsWith("--"))
      return fail("BUILD_VERIFY_USAGE");
    values.set(key,value);
  }
  const directory=values.get("--dir"),appId=values.get("--app-id"),commitSha=values.get("--commit");
  if (values.size!==3 || !directory || !isAbsolute(directory) ||
      !appId || !SLUG.test(appId) || !commitSha || !HEX40.test(commitSha))
    return fail("BUILD_VERIFY_USAGE");
  return {directory,appId,commitSha};
}
async function readSafeReceipt(path:string):Promise<unknown> {
  try {
    const previous=await lstat(path);
    if (!previous.isFile() || previous.isSymbolicLink() || previous.nlink!==1 ||
      previous.size<2 || previous.size>MAX_RECEIPT) fail("NATIVE_RECEIPT_INVALID");
    const fd=await open(path,constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const now=await fd.stat();
      if (!now.isFile() || now.nlink!==1 || now.size!==previous.size ||
        now.ino!==previous.ino || now.dev!==previous.dev) fail("NATIVE_RECEIPT_INVALID");
      const bytes=await fd.readFile();
      if (bytes.byteLength!==now.size) fail("NATIVE_RECEIPT_INVALID");
      return JSON.parse(bytes.toString("utf8")) as unknown;
    } finally { await fd.close(); }
  } catch(error) {
    if (error instanceof BuildVerifyError) throw error;
    return fail("NATIVE_RECEIPT_INVALID");
  }
}
async function hashExactFile(path:string,expected:number):Promise<string> {
  try {
    const previous=await lstat(path);
    if (!previous.isFile() || previous.isSymbolicLink() || previous.nlink!==1 ||
      previous.size!==expected || previous.size<1 || previous.size>MAX_ARTIFACT)
      return fail("NATIVE_ARTIFACT_INVALID");
    const handle=await open(path,constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const initial=await handle.stat();
      if (!initial.isFile() || initial.nlink!==1 || initial.ino!==previous.ino ||
        initial.dev!==previous.dev || initial.size!==expected)
        return fail("NATIVE_ARTIFACT_CHANGED");
      const digest=createHash("sha256");let total=0;
      for await (const chunk of handle.createReadStream({autoClose:false})) {
        total+=(chunk as Buffer).byteLength;
        if (total>expected) return fail("NATIVE_ARTIFACT_CHANGED");
        digest.update(chunk as Buffer);
      }
      const after=await handle.stat();
      if (total!==expected || after.size!==expected || initial.ino!==after.ino || initial.dev!==after.dev)
        return fail("NATIVE_ARTIFACT_CHANGED");
      return digest.digest("hex");
    } finally { await handle.close(); }
  } catch(error) {
    if (error instanceof BuildVerifyError) throw error;
    return fail("NATIVE_ARTIFACT_UNREADABLE");
  }
}
export async function verifyLocalNativeArtifact(plan:NativeVerifyOptions):Promise<NativeVerifyResult> {
  if (!isAbsolute(plan.directory)||!SLUG.test(plan.appId)||!HEX40.test(plan.commitSha))
    return fail("BUILD_VERIFY_USAGE");
  let dir:string;
  try {
    const stat=await lstat(plan.directory);
    if (!stat.isDirectory()||stat.isSymbolicLink()) return fail("NATIVE_DIRECTORY_INVALID");
    dir=await realpath(plan.directory);
  } catch(error) {
    if (error instanceof BuildVerifyError) throw error;
    return fail("NATIVE_DIRECTORY_INVALID");
  }
  const receipt=parseReceipt(await readSafeReceipt(join(dir,RECEIPT_NAME)),plan);
  const name=receipt.artifact.fileName,path=join(dir,name);
  try {
    const list=await readdir(dir);
    if (list.length!==2 || !list.includes(RECEIPT_NAME) || !list.includes(name))
      return fail("NATIVE_ARTIFACT_SET_INVALID");
    if (await realpath(path)!==dir+sep+name) return fail("NATIVE_ARTIFACT_INVALID");
  } catch(error) {
    if (error instanceof BuildVerifyError) throw error;
    return fail("NATIVE_ARTIFACT_INVALID");
  }
  const digest=await hashExactFile(path,receipt.artifact.byteLength);
  if (digest!==receipt.artifact.sha256) return fail("NATIVE_ARTIFACT_HASH_MISMATCH");
  return {
    schemaVersion:1,status:"bytes_match_runner_report",
    appId:receipt.appId,jobId:receipt.jobId,commitSha:receipt.commitSha,
    platform:receipt.artifact.platform,fileName:name,
    byteLength:receipt.artifact.byteLength,sha256:digest,
    appIdentifier:receipt.artifact.appIdentifier,
    signerFingerprint:receipt.artifact.signerFingerprint,
    runnerReported:true,provenanceAttested:false,signatureVerified:false,
  };
}
