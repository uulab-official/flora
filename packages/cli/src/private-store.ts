import fs from "node:fs/promises";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DomainError, ensure } from "@app-ops/core";

const unsafe = "PRIVATE_STORE_UNSAFE";
const sidecars = ["-journal", "-wal", "-shm"] as const;
function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}
function paths(platform: NodeJS.Platform) { return platform === "win32" ? path.win32 : path.posix; }
function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return paths(platform).relative(a, b) === "";
}
function within(candidate: string, directory: string, platform: NodeJS.Platform): boolean {
  const p = paths(platform), relative = p.relative(directory, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + p.sep) && !p.isAbsolute(relative);
}

/** Windows permits only local profile storage; POSIX access is checked against filesystem metadata. */
export function resolvePrivateStorePath(dbPath: string | undefined, profile: string, platform: NodeJS.Platform): string {
  const p = paths(platform);
  ensure(typeof profile === "string" && p.isAbsolute(profile) && !profile.includes("\0"), unsafe);
  const dedicated = p.join(profile, ".flora", "dogfood");
  const input = dbPath ?? p.join(dedicated, "state.db");
  ensure(typeof input === "string" && input.length > 0 && !input.includes("\0") && !input.endsWith(p.sep), unsafe);
  if (platform === "win32") {
    // Reject UNC/device paths, drive-relative paths, alternate data streams, and Win32 aliases.
    ensure(/^[a-z]:[\\/]/i.test(input) && /^[a-z]:[\\/]/i.test(profile), unsafe);
    const components = input.slice(3).split(/[\\/]/);
    ensure(components.every(component => component.length > 0 && !/[\x00-\x1f<>:"|?*]/.test(component)
      && !/[. ]$/.test(component) && !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(component)), unsafe);
  } else ensure(input !== ":memory:" && !input.startsWith("file:"), unsafe);
  const absolute = p.resolve(input);
  ensure(p.basename(absolute) !== "." && p.basename(absolute) !== ".." && absolute !== p.parse(absolute).root, unsafe);
  if (platform === "win32") ensure(within(absolute, dedicated, platform), unsafe);
  return absolute;
}

async function optionalStat(file: string): Promise<Stats | null> {
  try { return await fs.lstat(file); }
  catch (error) { if (errorCode(error) === "ENOENT") return null; throw error; }
}
function currentUid(): number {
  ensure(typeof process.getuid === "function", unsafe);
  return process.getuid();
}
function privateDirectory(stats: Stats, platform: NodeJS.Platform): void {
  ensure(stats.isDirectory() && !stats.isSymbolicLink(), unsafe);
  if (platform !== "win32") ensure(stats.uid === currentUid() && (stats.mode & 0o7777) === 0o700, unsafe);
}
function privateFile(stats: Stats, platform: NodeJS.Platform): void {
  ensure(stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1, unsafe);
  if (platform !== "win32") ensure(stats.uid === currentUid() && (stats.mode & 0o7777) === 0o600, unsafe);
}
async function ancestry(directory: string, platform: NodeJS.Platform): Promise<Stats> {
  const p = paths(platform), root = p.parse(directory).root;
  let current = root, last = await fs.lstat(root);
  for (const component of ["", ...directory.slice(root.length).split(p.sep).filter(Boolean)]) {
    if (component) { current = p.join(current, component); last = await fs.lstat(current); }
    ensure(last.isDirectory() && !last.isSymbolicLink(), unsafe);
    if (platform !== "win32") {
      ensure(last.uid === 0 || last.uid === currentUid(), unsafe);
      // Root-owned sticky temporary roots protect an owned child against other users' renames.
      ensure((last.mode & 0o022) === 0 || (last.uid === 0 && (last.mode & 0o1000) !== 0), unsafe);
    }
  }
  ensure(samePath(await fs.realpath(directory), directory, platform), unsafe);
  return last;
}
async function validateDirectory(directory: string, platform: NodeJS.Platform): Promise<void> {
  privateDirectory(await ancestry(directory, platform), platform);
}
async function createDirectory(directory: string, platform: NodeJS.Platform): Promise<void> {
  if (!await optionalStat(directory)) {
    await ancestry(paths(platform).dirname(directory), platform);
    try { await fs.mkdir(directory, platform === "win32" ? undefined : { mode: 0o700 }); }
    catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
  }
  await validateDirectory(directory, platform);
}
async function validateFiles(dbPath: string, platform: NodeJS.Platform, required: boolean): Promise<Stats | null> {
  const db = await optionalStat(dbPath);
  ensure(db || !required, unsafe);
  if (db) privateFile(db, platform);
  for (const suffix of sidecars) {
    const stats = await optionalStat(dbPath + suffix);
    if (stats) privateFile(stats, platform);
  }
  return db;
}
async function validateDedicatedParents(dbPath: string, profile: string, platform: NodeJS.Platform): Promise<void> {
  const p = paths(platform), dedicated = p.join(profile, ".flora", "dogfood");
  if (within(dbPath, dedicated, platform)) {
    await validateDirectory(p.join(profile, ".flora"), platform);
    await validateDirectory(dedicated, platform);
  }
}
async function verify(dbPath: string, profile: string, platform: NodeJS.Platform): Promise<string> {
  await validateDirectory(paths(platform).dirname(dbPath), platform);
  await validateDedicatedParents(dbPath, profile, platform);
  await validateFiles(dbPath, platform, true);
  const canonical = await fs.realpath(dbPath);
  ensure(samePath(canonical, dbPath, platform), unsafe);
  return canonical;
}

/** Check immediately before SQLite open, and again after operations while sidecars still exist. */
export async function verifyPrivateStore(dbPath: string): Promise<void> {
  try {
    const profile = os.homedir(), platform = process.platform;
    await verify(resolvePrivateStorePath(dbPath, profile, platform), profile, platform);
  } catch { throw new DomainError(unsafe); }
}

/** Creates only dedicated private directories and an exclusive 0600 database; never repairs permissions. */
export async function preparePrivateStore(dbPath?: string): Promise<string> {
  try {
    const profile = os.homedir(), platform = process.platform, p = paths(platform);
    const absolute = resolvePrivateStorePath(dbPath, profile, platform), parent = p.dirname(absolute);
    if (platform !== "win32") process.umask(0o077);
    if (dbPath === undefined || platform === "win32" || samePath(parent, p.join(profile, ".flora", "dogfood"), platform)) {
      await ancestry(profile, platform);
      await createDirectory(p.join(profile, ".flora"), platform);
      const dedicated = p.join(profile, ".flora", "dogfood");
      await createDirectory(dedicated, platform);
      if (platform === "win32") {
        let directory = dedicated;
        for (const component of p.relative(dedicated, parent).split(p.sep).filter(Boolean)) {
          directory = p.join(directory, component); await createDirectory(directory, platform);
        }
      }
    } else {
      await validateDedicatedParents(absolute, profile, platform);
      await createDirectory(parent, platform);
    }
    await validateDirectory(parent, platform);
    await validateDedicatedParents(absolute, profile, platform);
    const existing = await validateFiles(absolute, platform, false);
    const noFollow = platform === "win32" ? 0 : constants.O_NOFOLLOW;
    let file;
    try {
      file = await fs.open(absolute, existing ? constants.O_RDONLY | noFollow : constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    } catch (error) {
      if (existing || errorCode(error) !== "EEXIST") throw error;
      // Another private-store initializer may have won the exclusive creation race.
      await validateDirectory(parent, platform); await validateFiles(absolute, platform, true);
      file = await fs.open(absolute, constants.O_RDONLY | noFollow);
    }
    try {
      const opened = await file.stat(); privateFile(opened, platform);
      const named = await fs.lstat(absolute); privateFile(named, platform);
      ensure(opened.dev === named.dev && opened.ino === named.ino, unsafe);
    } finally { await file.close(); }
    // Return only a freshly checked canonical path in an unshared, owner-private final directory.
    return await verify(absolute, profile, platform);
  } catch { throw new DomainError(unsafe); }
}
