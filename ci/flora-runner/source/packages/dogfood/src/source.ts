import {
  DomainError, ensure, forbidden, integer, object, safeJson, text,
} from "@app-ops/core";
import { canonicalJson, freeze } from "@app-ops/config";
import { CONFIG_RUNTIME_SMOKE_V1 } from "./profile.js";
import type {
  Fact, FlavorFact, Freshness, HeadObservation, InventorySnapshot, RuntimeFacts, SourceBundleV1, VerifiedSourceFile,
} from "./types.js";

const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 1.5 * 1024 * 1024;
const OPTIONAL_FILE = "src/core/experience/types.ts";
const REQUIRED_FILES = [
  "package.json",
  "package-lock.json",
  "flavors/config.json",
  "src/core/config/runtime.ts",
  "src/core/experience/runtime.ts",
  "config/experience-contract.json",
  "vitest.config.mts",
  "tsconfig.json",
  ...CONFIG_RUNTIME_SMOKE_V1.files,
] as const;
const ALLOWED_FILES: ReadonlySet<string> = new Set([...REQUIRED_FILES, OPTIONAL_FILE]);
const FACT_FILES: ReadonlySet<string> = new Set([
  "package.json", "package-lock.json", "flavors/config.json",
]);

function record(value: unknown): Record<string, unknown> {
  ensure(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function rootDirectory(value: unknown): string {
  const root = text(value);
  ensure(root === "." || (
    !/[\\:\u0000-\u001f\u007f]/.test(root) &&
    root.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !forbidden.has(part))
  ));
  return root;
}

function commitSha(value: unknown): string {
  const sha = text(value, 64);
  ensure(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha));
  return sha;
}

function timestamp(value: unknown): string {
  const date = text(value, 64);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(date);
  ensure(match && Number.isFinite(Date.parse(date)));
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  ensure(month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!);
  ensure(Number(match[4]) < 24 && Number(match[5]) < 60 && Number(match[6]) < 60);
  return date;
}

function timestampNanoseconds(value: unknown): bigint {
  const date = timestamp(value);
  const fraction = /\.(\d{1,9})/.exec(date)?.[1] ?? "";
  // Date.parse handles the timezone offset only at an exact whole second.
  // Add the original fractional digits with integer arithmetic, never rounding
  // through milliseconds or changing the timestamp retained in provenance.
  const wholeSecond = Date.parse(date.replace(/\.\d{1,9}/, ""));
  return BigInt(wholeSecond) * 1_000_000n + BigInt(fraction.padEnd(9, "0"));
}

function utf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DomainError("INVALID_INPUT");
  }
}

function json(content: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new DomainError("INVALID_INPUT");
  }
  safeJson(value);
  return value;
}

function decodeBase64(value: unknown): Uint8Array<ArrayBuffer> {
  ensure(typeof value === "string" && value.length <= Math.ceil(MAX_FILE_BYTES / 3) * 4);
  ensure(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value));
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new DomainError("INVALID_INPUT");
  }
  // Reject non-zero padding bits as well as whitespace and alternate alphabets.
  ensure(btoa(binary) === value && binary.length <= MAX_FILE_BYTES);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hash(algorithm: "SHA-1" | "SHA-256", bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(algorithm, bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function escapePointer(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

/**
 * Reads exactly the declared JSON facts after all supplied byte hashes validate.
 * Never evaluates scripts/modules, writes files, connects to a repository, or
 * claims that imported provenance proves execution or live source freshness.
 */
export async function parseSourceBundle(bytes: Uint8Array, importedAt: number): Promise<InventorySnapshot> {
  ensure(bytes instanceof Uint8Array && bytes.byteLength <= MAX_BUNDLE_BYTES);
  integer(importedAt);
  const envelope = object(json(utf8(bytes)), [
    "schemaVersion", "repository", "commitSha", "rootDirectory", "fetchedAt", "selectedFlavor", "files",
  ]);
  ensure(envelope.schemaVersion === 1);
  const repo = object(envelope.repository, ["id", "fullName", "visibility"]);
  ensure(repo.visibility === "private" || repo.visibility === "public");
  const repository: SourceBundleV1["repository"] = {
    id: text(repo.id), fullName: text(repo.fullName), visibility: repo.visibility,
  };
  const commit = commitSha(envelope.commitSha);
  const root = rootDirectory(envelope.rootDirectory);
  const fetchedAt = timestamp(envelope.fetchedAt);
  const selectedFlavor = text(envelope.selectedFlavor);
  ensure(!forbidden.has(selectedFlavor));
  ensure(Array.isArray(envelope.files) && envelope.files.length >= REQUIRED_FILES.length && envelope.files.length <= ALLOWED_FILES.size);
  const files: VerifiedSourceFile[] = [];
  const seen = new Set<string>();
  const factJson = new Map<string, string>();
  let totalBytes = 0;
  for (const input of envelope.files) {
    const file = object(input, ["path", "gitBlobSha", "sha256", "contentBase64"]);
    const path = text(file.path);
    ensure(ALLOWED_FILES.has(path) && !seen.has(path));
    seen.add(path);
    const gitBlobSha = text(file.gitBlobSha, 40);
    const sha256 = text(file.sha256, 64);
    ensure(/^[a-f0-9]{40}$/.test(gitBlobSha) && /^[a-f0-9]{64}$/.test(sha256));
    const decoded = decodeBase64(file.contentBase64);
    totalBytes += decoded.byteLength;
    ensure(totalBytes <= MAX_TOTAL_FILE_BYTES);
    const header = new TextEncoder().encode(`blob ${decoded.byteLength}\0`);
    const blob = new Uint8Array(header.length + decoded.length);
    blob.set(header);
    blob.set(decoded, header.length);
    ensure(await hash("SHA-256", decoded) === sha256);
    ensure(await hash("SHA-1", blob) === gitBlobSha);
    const content = utf8(decoded);
    if (FACT_FILES.has(path)) factJson.set(path, content);
    files.push({ path, gitBlobSha, sha256, byteLength: decoded.byteLength });
  }
  ensure(REQUIRED_FILES.every((path) => seen.has(path)));
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const facts = (path: string) => record(json(factJson.get(path)!));
  const fact = <T>(path: string, pointer: string, value: T): Fact<T> => ({
    value,
    provenance: {
      repositoryId: repository.id, commitSha: commit, fetchedAt, path,
      gitBlobSha: files.find((file) => file.path === path)!.gitBlobSha, pointer,
    },
  });
  const registry = facts("flavors/config.json");
  const flavorIds = Object.keys(registry).sort();
  ensure(flavorIds.length > 0 && flavorIds.length <= 100 && Object.hasOwn(registry, selectedFlavor));
  const flavors: FlavorFact[] = flavorIds.map((id) => {
    text(id);
    const entry = record(own(registry, id));
    const app = record(own(entry, "app"));
    const base = "/" + escapePointer(id);
    return {
      id,
      productType: fact("flavors/config.json", base + "/productType", text(own(entry, "productType"))),
      appName: fact("flavors/config.json", base + "/app/name", text(own(app, "name"))),
      declaredPackage: fact("flavors/config.json", base + "/app/package", text(own(app, "package"))),
    };
  });
  const pkg = facts("package.json");
  const lock = facts("package-lock.json");
  const packages = record(own(lock, "packages"));
  const optionalText = (path: string, pointer: string, value: unknown): Fact<string> | null =>
    value === undefined ? null : fact(path, pointer, text(value));
  const engines = own(pkg, "engines");
  const version = (name: string): Fact<string> | null => {
    const key = "node_modules/" + name;
    const item = own(packages, key);
    return item === undefined ? null : optionalText("package-lock.json", "/packages/" + escapePointer(key) + "/version", own(record(item), "version"));
  };
  const runtime: RuntimeFacts = {
    appVersion: optionalText("package.json", "/version", own(pkg, "version")),
    nodeEngine: optionalText("package.json", "/engines/node", engines === undefined ? undefined : own(record(engines), "node")),
    lockfileVersion: fact("package-lock.json", "/lockfileVersion", integer(own(lock, "lockfileVersion"), 1)),
    packageEntryCount: fact("package-lock.json", "/packages", Object.keys(packages).length),
    versions: { vitest: version("vitest"), vite: version("vite"), expo: version("expo"), "react-native": version("react-native") },
    runtimeVersion: "not-evaluated", adsMode: "not-evaluated", otaDestination: "not-evaluated", installedBinaryIdentity: "not-inspected",
  };
  const digest = await hash("SHA-256", new TextEncoder().encode(canonicalJson({
    repository, commitSha: commit, rootDirectory: root, selectedFlavor, files,
  })));
  return freeze({
    id: "inventory_" + globalThis.crypto.randomUUID(), digest, repository,
    commitSha: commit, rootDirectory: root, fetchedAt, importedAt, selectedFlavor,
    files, flavors, runtime, evidenceOrigin: "operator-import", connection: "one-shot-source-snapshot",
  });
}


/**
 * Compares only imported observations for this repository/root. The caller must
 * retain and display the observation time and origin with this status. A newer
 * different hash is not a claim that the observed commit is a descendant.
 */
export function deriveFreshness(snapshot: InventorySnapshot, observation: HeadObservation | null): Freshness {
  if (observation === null) return "freshness_unknown";
  let observedAt: bigint;
  let fetchedAt: bigint;
  let head: string;
  try {
    const value = object(observation, [
      "repositoryId", "rootDirectory", "headCommitSha", "observedAt", "evidenceOrigin",
    ]);
    ensure(value.evidenceOrigin === "operator-import");
    ensure(text(value.repositoryId) === snapshot.repository.id);
    ensure(rootDirectory(value.rootDirectory) === snapshot.rootDirectory);
    head = commitSha(value.headCommitSha);
    observedAt = timestampNanoseconds(value.observedAt);
    fetchedAt = timestampNanoseconds(snapshot.fetchedAt);
  } catch (error) {
    if (error instanceof DomainError) return "freshness_unknown";
    throw error;
  }
  if (observedAt < fetchedAt) return "freshness_unknown";
  if (head === snapshot.commitSha) return "observed_current";
  return observedAt > fetchedAt ? "stale" : "freshness_unknown";
}
