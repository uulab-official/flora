import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { link, lstat, open, opendir, realpath, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

export interface NativeArtifactScope {appId: string; platform: "android" | "ios"; artifactDirectory: string; expectedCertificateSha256: string}
export interface NativeArtifactRecord {
  appId: string; platform: "android" | "ios"; jobId: string; fileName: string; commitSha: string;
  sha256: string; byteLength: number; appIdentifier: string; signerFingerprint: string;
  completionRecorded: boolean; integrityVerified: boolean; signatureRechecked: false; installVerified: false; remoteRechecked: false;
}
export interface NativeArtifactCatalogue {
  state: "native_artifacts"; appId: string; platform: "android" | "ios"; storePresent: boolean;
  records: NativeArtifactRecord[]; issues: {code: string; fileName?: string}[]; scannedEntries: number;
  pendingEntries: number; interruptedDirectories: number; unrecognizedEntries: number;
  truncated: boolean; snapshotChanged: boolean; recoveryRequired: boolean; remoteRechecked: false;
}
export type NativeArtifactInspection = NativeArtifactRecord & {state: "native_artifact_inspected"};
export type NativeArtifactExport = NativeArtifactRecord & {state: "native_artifact_exported"; exported: true};
const MAX_BYTES = 512 * 1024 * 1024, RECEIPT_BYTES = 128 * 1024, ENTRY_LIMIT = 1024, RECORD_LIMIT = 200;
const CODES = new Set(["NATIVE_CANCELLED", "INVALID_NATIVE_CONFIG", "NATIVE_ARTIFACT_PLATFORM_UNSUPPORTED", "NATIVE_ARTIFACT_NAME_INVALID",
  "NATIVE_ARTIFACT_STORE_UNSAFE", "NATIVE_ARTIFACT_FILE_UNSAFE", "NATIVE_ARTIFACT_NOT_FOUND", "NATIVE_ARTIFACT_RECEIPT_INVALID",
  "NATIVE_ARTIFACT_SCOPE_MISMATCH", "NATIVE_ARTIFACT_UNCONFIRMED", "NATIVE_ARTIFACT_CHANGED", "NATIVE_ARTIFACT_HASH_MISMATCH",
  "NATIVE_ARTIFACT_IO_FAILED", "NATIVE_ARTIFACT_READ_TIMEOUT", "NATIVE_EXPORT_PATH_INVALID", "NATIVE_EXPORT_PARENT_UNSAFE",
  "NATIVE_EXPORT_EXISTS", "NATIVE_EXPORT_UNCONFIRMED"]);
export function isNativeArtifactError(code: string): boolean {return CODES.has(code);}
function fail(code: string): never {throw new Error(code);}
function requireThat(value: unknown, code: string): asserts value {if (!value) fail(code);}
function safe(error: unknown): Error {
  if (error instanceof Error && CODES.has(error.message)) return error;
  return new Error("NATIVE_ARTIFACT_IO_FAILED");
}
function live(signal?: AbortSignal): void {if (signal?.aborted) fail("NATIVE_CANCELLED");}
function exact(value: unknown, pattern: RegExp): value is string {return typeof value === "string" && pattern.exec(value)?.[0] === value;}
export function isNativeArtifactName(value: unknown): value is string {return exact(value, /^[a-z][a-z0-9_-]{2,95}\.(?:apk|aab|ipa)$/);}
function ownedScope(input: NativeArtifactScope): Readonly<NativeArtifactScope> {
  requireThat(process.platform !== "win32", "NATIVE_ARTIFACT_PLATFORM_UNSUPPORTED");
  requireThat(input && exact(input.appId, /^[a-z][a-z0-9_-]{2,95}$/) && ["android", "ios"].includes(input.platform)
    && typeof input.artifactDirectory === "string" && isAbsolute(input.artifactDirectory) && !/[\x00-\x1f\x7f]/.test(input.artifactDirectory)
    && exact(input.expectedCertificateSha256, /^[a-f0-9]{64}$/), "INVALID_NATIVE_CONFIG");
  return Object.freeze({appId: input.appId, platform: input.platform, artifactDirectory: resolve(input.artifactDirectory), expectedCertificateSha256: input.expectedCertificateSha256});
}
function filename(scope: NativeArtifactScope, value: string): void {
  requireThat(isNativeArtifactName(value) && (scope.platform === "ios" ? value.endsWith(".ipa") : /\.(apk|aab)$/.test(value)), "NATIVE_ARTIFACT_NAME_INVALID");
}
async function directory(path: string, code = "NATIVE_ARTIFACT_STORE_UNSAFE"): Promise<BigIntStats> {
  try {
    const stat = await lstat(path, {bigint: true});
    requireThat(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o777n) === 0o700n
      && stat.uid === BigInt(process.getuid!()) && await realpath(path) === path, code);
    return stat;
  } catch (error) {if (error instanceof Error && error.message === code) throw error; fail(code);}
}
function privateFile(stat: BigIntStats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && (stat.mode & 0o777n) === 0o600n && stat.uid === BigInt(process.getuid!());
}
function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
    && a.mode === b.mode && a.uid === b.uid && a.nlink === b.nlink;
}
interface PrivateFile {handle: FileHandle; before: BigIntStats; path: string}
async function privateOpen(path: string): Promise<PrivateFile> {
  let handle: FileHandle | undefined;
  try {
    const before = await lstat(path, {bigint: true}); requireThat(privateFile(before), "NATIVE_ARTIFACT_FILE_UNSAFE");
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    requireThat(same(before, await handle.stat({bigint: true})), "NATIVE_ARTIFACT_CHANGED");
    return {handle, before, path};
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") fail("NATIVE_ARTIFACT_NOT_FOUND");
    throw safe(error);
  }
}
async function unchanged(file: PrivateFile): Promise<void> {
  requireThat(same(file.before, await file.handle.stat({bigint: true})) && same(file.before, await lstat(file.path, {bigint: true})), "NATIVE_ARTIFACT_CHANGED");
}
async function rootUnchanged(scope: NativeArtifactScope, before: BigIntStats): Promise<void> {
  const now = await directory(scope.artifactDirectory);
  requireThat(now.ino === before.ino && now.dev === before.dev, "NATIVE_ARTIFACT_CHANGED");
}
function project(value: unknown, scope: NativeArtifactScope, name: string): NativeArtifactRecord {
  requireThat(value && typeof value === "object" && !Array.isArray(value), "NATIVE_ARTIFACT_RECEIPT_INVALID");
  const v = value as Record<string, unknown>;
  requireThat(Object.keys(v).every(k => ["jobId", "appId", "commitSha", "fileName", "sha256", "byteLength", "appIdentifier", "platform", "signerFingerprint", "teamId", "completionConfirmed", "sourceEntitlements"].includes(k))
    && exact(v.jobId, /^[a-z][a-z0-9_-]{2,95}$/) && exact(v.appId, /^[a-z][a-z0-9_-]{2,95}$/)
    && isNativeArtifactName(v.fileName) && exact(v.commitSha, /^[a-f0-9]{40}$/) && exact(v.sha256, /^[a-f0-9]{64}$/)
    && exact(v.signerFingerprint, /^[a-f0-9]{64}$/) && typeof v.completionConfirmed === "boolean"
    && typeof v.byteLength === "number" && Number.isSafeInteger(v.byteLength) && v.byteLength > 0 && v.byteLength <= MAX_BYTES
    && exact(v.appIdentifier, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/) && (v.platform === "android" || v.platform === "ios")
    && (v.teamId === undefined || exact(v.teamId, /^[A-Z0-9]{10}$/)), "NATIVE_ARTIFACT_RECEIPT_INVALID");
  requireThat(v.appId === scope.appId && v.platform === scope.platform && v.fileName === name
    && name === v.jobId + extname(name) && v.signerFingerprint === scope.expectedCertificateSha256, "NATIVE_ARTIFACT_SCOPE_MISMATCH");
  return {appId: v.appId, platform: v.platform, jobId: v.jobId, fileName: v.fileName, commitSha: v.commitSha,
    sha256: v.sha256, byteLength: v.byteLength, appIdentifier: v.appIdentifier, signerFingerprint: v.signerFingerprint,
    completionRecorded: v.completionConfirmed, integrityVerified: false, signatureRechecked: false, installVerified: false, remoteRechecked: false};
}
async function receipt(scope: NativeArtifactScope, name: string, signal?: AbortSignal): Promise<{file: PrivateFile; record: NativeArtifactRecord}> {
  live(signal); const file = await privateOpen(join(scope.artifactDirectory, name + ".receipt.json"));
  try {
    requireThat(file.before.size > 0n && file.before.size <= BigInt(RECEIPT_BYTES), "NATIVE_ARTIFACT_RECEIPT_INVALID");
    const bytes = Buffer.alloc(Number(file.before.size) + 1); let length = 0;
    while (length < bytes.length) {live(signal); const part = await file.handle.read(bytes, length, bytes.length-length, length); if (!part.bytesRead) break; length += part.bytesRead;}
    requireThat(length === Number(file.before.size), "NATIVE_ARTIFACT_CHANGED"); await unchanged(file); live(signal);
    let value: unknown; try {value = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes.subarray(0,length)));} catch {fail("NATIVE_ARTIFACT_RECEIPT_INVALID");}
    return {file, record: project(value, scope, name)};
  } catch (error) {await file.handle.close().catch(() => {}); throw safe(error);}
}
async function names(path: string, signal?: AbortSignal): Promise<{values: string[]; truncated: boolean}> {
  const values: string[] = []; const dir = await opendir(path); let truncated = false;
  try {for await (const entry of dir) {live(signal); if (values.length === ENTRY_LIMIT) {truncated = true; break;} values.push(entry.name);}}
  finally {await dir.close().catch(() => {});}
  return {values: values.sort(), truncated};
}
/** Historical local observations only. No network, signing, recovery or executable readiness claim. */
export async function listNativeArtifacts(input: NativeArtifactScope, signal?: AbortSignal): Promise<NativeArtifactCatalogue> {
  try {
    live(signal); const scope = ownedScope(input);
    const result: NativeArtifactCatalogue = {state: "native_artifacts", appId: scope.appId, platform: scope.platform, storePresent: false,
      records: [], issues: [], scannedEntries: 0, pendingEntries: 0, interruptedDirectories: 0, unrecognizedEntries: 0,
      truncated: false, snapshotChanged: false, recoveryRequired: false, remoteRechecked: false};
    try {await lstat(scope.artifactDirectory);} catch (error) {if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return result; throw error;}
    const root = await directory(scope.artifactDirectory), found = await names(scope.artifactDirectory, signal);
    result.storePresent = true; result.scannedEntries = found.values.length; result.truncated = found.truncated;
    let receipts = 0;
    for (const name of found.values) {
      live(signal);
      if (name === ".pending") {
        try {await directory(join(scope.artifactDirectory, name)); const pending = await names(join(scope.artifactDirectory, name), signal); result.pendingEntries = pending.values.length; result.truncated ||= pending.truncated;}
        catch (error) {if (signal?.aborted) throw error; result.issues.push({code: "NATIVE_ARTIFACT_STORE_UNSAFE"});} continue;
      }
      if (name.startsWith(".native-")) {result.interruptedDirectories++; continue;}
      const base = name.endsWith(".receipt.json") ? name.slice(0, -13) : "";
      if (isNativeArtifactName(base)) {
        if (receipts++ >= RECORD_LIMIT) {result.truncated = true; continue;}
        try {
          filename(scope, base); const loaded = await receipt(scope, base, signal);
          try {
            result.records.push(loaded.record);
            try {const binary = await privateOpen(join(scope.artifactDirectory, base)); try {requireThat(binary.before.size === BigInt(loaded.record.byteLength), "NATIVE_ARTIFACT_CHANGED");} finally {await binary.handle.close();}}
            catch (error) {result.issues.push({code: safe(error).message, fileName: base});}
          } finally {await loaded.file.handle.close();}
        } catch (error) {if (signal?.aborted) throw error; result.issues.push({code: safe(error).message});}
      } else if (isNativeArtifactName(name)) {
        if (!found.values.includes(name + ".receipt.json")) result.issues.push({code: "NATIVE_ARTIFACT_RECEIPT_MISSING"});
      } else result.unrecognizedEntries++;
    }
    await rootUnchanged(scope, root); const after = await lstat(scope.artifactDirectory, {bigint: true});
    result.snapshotChanged = root.mtimeNs !== after.mtimeNs || root.ctimeNs !== after.ctimeNs;
    result.recoveryRequired = result.truncated || result.snapshotChanged || result.pendingEntries > 0 || result.interruptedDirectories > 0
      || result.unrecognizedEntries > 0 || result.issues.length > 0 || result.records.some(r => !r.completionRecorded);
    live(signal); return result;
  } catch (error) {throw safe(error);}
}
async function transfer(input: NativeArtifactScope, name: string, destination: string | undefined, signal?: AbortSignal): Promise<NativeArtifactRecord> {
  let metadata: Awaited<ReturnType<typeof receipt>> | undefined, source: PrivateFile | undefined, output: FileHandle | undefined;
  let temp: string | undefined, tempIdentity: BigIntStats | undefined, published = false;
  try {
    live(signal); const scope = ownedScope(input); filename(scope, name);
    let target: string | undefined, parent: string | undefined, parentStat: BigIntStats | undefined;
    if (destination !== undefined) {
      requireThat(typeof destination === "string" && isAbsolute(destination) && !/[\x00-\x1f\x7f]/.test(destination) && extname(destination) === extname(name), "NATIVE_EXPORT_PATH_INVALID");
      target = resolve(destination); parent = dirname(target);
      const relation = relative(scope.artifactDirectory, target);
      requireThat(relation.startsWith(".." + "/") || isAbsolute(relation), "NATIVE_EXPORT_PATH_INVALID");
      parentStat = await directory(parent, "NATIVE_EXPORT_PARENT_UNSAFE");
      try {await lstat(target); fail("NATIVE_EXPORT_EXISTS");} catch (error) {if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;}
    }
    const root = await directory(scope.artifactDirectory); metadata = await receipt(scope, name, signal);
    requireThat(metadata.record.completionRecorded, "NATIVE_ARTIFACT_UNCONFIRMED");
    source = await privateOpen(join(scope.artifactDirectory, name)); requireThat(source.before.size === BigInt(metadata.record.byteLength), "NATIVE_ARTIFACT_CHANGED");
    if (target) {
      const candidate = join(parent!, ".flora-export-" + randomUUID() + ".partial");
      output = await open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      temp = candidate; tempIdentity = await output.stat({bigint: true});
    }
    const digest = createHash("sha256"), buffer = Buffer.alloc(64 * 1024), deadline = performance.now() + 120000; let size = 0;
    for (;;) {
      live(signal); requireThat(performance.now() < deadline, "NATIVE_ARTIFACT_READ_TIMEOUT");
      const part = await source.handle.read(buffer, 0, buffer.length, size); if (!part.bytesRead) break;
      size += part.bytesRead; requireThat(size <= metadata.record.byteLength, "NATIVE_ARTIFACT_CHANGED"); digest.update(buffer.subarray(0, part.bytesRead));
      if (output) {let offset = 0; while (offset < part.bytesRead) {live(signal); const written = await output.write(buffer, offset, part.bytesRead-offset, size-part.bytesRead+offset); requireThat(written.bytesWritten > 0, "NATIVE_ARTIFACT_IO_FAILED"); offset += written.bytesWritten;}}
    }
    requireThat(size === metadata.record.byteLength, "NATIVE_ARTIFACT_CHANGED");
    requireThat(digest.digest("hex") === metadata.record.sha256, "NATIVE_ARTIFACT_HASH_MISMATCH");
    await unchanged(source); await unchanged(metadata.file); await rootUnchanged(scope, root); live(signal);
    if (target) {
      await output!.sync();
      const copy = await output!.stat({bigint: true});
      requireThat(privateFile(copy) && copy.ino === tempIdentity!.ino && copy.dev === tempIdentity!.dev
        && copy.size === BigInt(size) && same(copy, await lstat(temp!, {bigint: true})), "NATIVE_ARTIFACT_CHANGED");
      await output!.close(); output = undefined;
      const current = await directory(parent!, "NATIVE_EXPORT_PARENT_UNSAFE");
      requireThat(current.dev === parentStat!.dev && current.ino === parentStat!.ino, "NATIVE_EXPORT_PARENT_UNSAFE");
      await unchanged(source); await unchanged(metadata.file); live(signal);
      // A hard link to our verified private copy is an atomic no-replace commit.
      try {await link(temp!, target);} catch (error) {if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") fail("NATIVE_EXPORT_EXISTS"); throw error;}
      published = true; await unlink(temp!); temp = undefined;
      const final = await lstat(target, {bigint: true}); requireThat(privateFile(final) && final.size === BigInt(size), "NATIVE_EXPORT_UNCONFIRMED");
      const dir = await open(parent!, constants.O_RDONLY | constants.O_NOFOLLOW); try {await dir.sync();} finally {await dir.close();}
      // Do not downgrade an already published result to cancelled after this point.
    }
    return {...metadata.record, integrityVerified: true};
  } catch (error) {if (published) fail("NATIVE_EXPORT_UNCONFIRMED"); throw safe(error);}
  finally {
    await output?.close().catch(() => {});
    if (temp && tempIdentity) {
      try {const current = await lstat(temp, {bigint: true});
        if (current.ino === tempIdentity.ino && current.dev === tempIdentity.dev) await unlink(temp);
      } catch { /* Never delete a substituted or unidentifiable file. */ }
    }
    await source?.handle.close().catch(() => {}); await metadata?.file.handle.close().catch(() => {});
  }
}
export async function inspectNativeArtifact(scope: NativeArtifactScope, fileName: string, signal?: AbortSignal): Promise<NativeArtifactInspection> {
  return {...await transfer(scope, fileName, undefined, signal), state: "native_artifact_inspected"};
}
export async function exportNativeArtifact(scope: NativeArtifactScope, fileName: string, destination: string, signal?: AbortSignal): Promise<NativeArtifactExport> {
  return {...await transfer(scope, fileName, destination, signal), state: "native_artifact_exported", exported: true};
}
