#!/usr/bin/env node

// packages/ota-runner/src/config.ts
import { lstat as lstat3, open as open3 } from "node:fs/promises";
import { constants as constants3 } from "node:fs";
import { isAbsolute as isAbsolute3 } from "node:path";

// packages/ota-runner/src/artifacts.ts
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
var MAX_ASSET_BYTES = 16 * 1024 * 1024;
var MAX_EXPORT_BYTES = 64 * 1024 * 1024;
var MAX_ASSETS = 64;
function invariant(value, code = "ARTIFACT_INVALID") {
  if (!value) throw new Error(code);
}
var sha256 = (value) => createHash("sha256").update(value).digest("hex");
function relativePath(value) {
  invariant(typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\\:\u0000-\u001f\u007f]/.test(value));
  invariant(value.split("/").every((part) => part && part !== "." && part !== ".." && ![".git", "node_modules"].includes(part)));
  return value;
}
async function readBoundedFile(root, input, limit) {
  const path2 = relativePath(input), boundary = await realpath(root);
  let cursor = boundary;
  for (const part of path2.split("/")) {
    cursor = join(cursor, part);
    const stat = await lstat(cursor);
    invariant(!stat.isSymbolicLink());
  }
  const actual = await realpath(cursor);
  invariant(actual.startsWith(boundary + sep));
  const file = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    invariant(stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= limit);
    const bytes = await file.readFile();
    invariant(bytes.length === stat.size && bytes.length <= limit);
    return bytes;
  } finally {
    await file.close();
  }
}
var types = { js: "application/javascript", bundle: "application/javascript", hbc: "application/octet-stream", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", mp4: "video/mp4", json: "application/json", xml: "application/octet-stream", wasm: "application/wasm" };
function assetMetadata(key, extension, bytes) {
  invariant(typeof key === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(key));
  invariant(typeof extension === "string" && /^\.?[A-Za-z0-9]{1,15}$/.test(extension));
  const ext = extension.replace(/^\./, "").toLowerCase(), contentType = types[ext];
  invariant(Object.hasOwn(types, ext) && typeof contentType === "string" && bytes.length > 0 && bytes.length <= MAX_ASSET_BYTES);
  return { key, contentType, fileExtension: "." + ext, digest: sha256(bytes), bytes: bytes.slice() };
}
function finishExport(expectation, launchAsset, assets) {
  invariant(["ios", "android"].includes(expectation.platform) && /^[a-f0-9]{40}$/.test(expectation.commitSha) && typeof expectation.runtimeVersion === "string" && expectation.runtimeVersion.length > 0 && expectation.runtimeVersion.length <= 128);
  invariant(assets.length <= MAX_ASSETS && (/* @__PURE__ */ new Set([launchAsset.key, ...assets.map((a) => a.key)])).size === assets.length + 1);
  invariant([launchAsset, ...assets].reduce((sum, a) => sum + a.bytes.length, 0) <= MAX_EXPORT_BYTES);
  const facts = { ...expectation, launchAsset: { key: launchAsset.key, digest: launchAsset.digest }, assets: assets.map((a) => ({ key: a.key, digest: a.digest })) };
  return { ...expectation, launchAsset, assets, artifactDigest: sha256(JSON.stringify(facts)) };
}
function decodeExport(text2, expectation) {
  try {
    invariant(Buffer.byteLength(text2) <= 96 * 1024 * 1024);
    const value = JSON.parse(text2);
    invariant(value.commitSha === expectation.commitSha && value.platform === expectation.platform && value.runtimeVersion === expectation.runtimeVersion && Array.isArray(value.assets));
    const decode = (input) => {
      invariant(typeof input.bytes === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(input.bytes));
      const bytes = Buffer.from(input.bytes, "base64");
      invariant(bytes.toString("base64") === input.bytes);
      const a = assetMetadata(input.key, input.fileExtension, bytes);
      invariant(a.digest === input.digest && a.contentType === input.contentType);
      return a;
    };
    const bundle = finishExport(expectation, decode(value.launchAsset), value.assets.map(decode));
    invariant(bundle.artifactDigest === value.artifactDigest);
    return bundle;
  } catch {
    throw new Error("ARTIFACT_INVALID");
  }
}

// packages/core/src/errors.ts
var DomainError = class extends Error {
  code;
  safeMessage;
  constructor(code) {
    super(code);
    this.name = "DomainError";
    this.code = code;
    this.safeMessage = code;
  }
};
function ensure(condition, code = "INVALID_INPUT") {
  if (!condition) throw new DomainError(code);
}
var forbidden = /* @__PURE__ */ new Set(["__proto__", "prototype", "constructor"]);
function safeJson(value, depth = 0) {
  ensure(depth <= 64);
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    ensure(Number.isFinite(value));
    return;
  }
  ensure(typeof value === "object" && value !== null);
  const proto = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    ensure(proto === Array.prototype);
    ensure(Reflect.ownKeys(value).length === value.length + 1);
    for (let i = 0; i < value.length; i++) {
      const d = Object.getOwnPropertyDescriptor(value, String(i));
      ensure(d && "value" in d && d.enumerable);
      safeJson(d.value, depth + 1);
    }
    return;
  }
  ensure(proto === Object.prototype || proto === null);
  for (const key of Reflect.ownKeys(value)) {
    ensure(typeof key === "string" && !forbidden.has(key));
    const d = Object.getOwnPropertyDescriptor(value, key);
    ensure(d && "value" in d && d.enumerable);
    safeJson(d.value, depth + 1);
  }
}
function object(value, keys) {
  safeJson(value);
  ensure(value !== null && typeof value === "object" && !Array.isArray(value));
  const o = value;
  ensure(
    Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k))
  );
  return o;
}
function text(value, max = 4096) {
  ensure(
    typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0")
  );
  return value;
}
function id(value) {
  const s = text(value, 96);
  ensure(/^[a-z][a-z0-9_-]{2,95}$/.test(s) && !forbidden.has(s));
  return s;
}
function digest(value) {
  const s = text(value, 64);
  ensure(/^[a-f0-9]{64}$/.test(s));
  return s;
}
function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  ensure(
    typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
  );
  return value;
}

// packages/config/src/canonical.ts
function canonicalJson(value) {
  safeJson(value);
  function encode(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(encode).join(",") + "]";
    const o = v;
    return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + encode(o[k])).join(",") + "}";
  }
  return encode(value);
}
function freeze(value) {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) freeze(v);
    Object.freeze(value);
  }
  return value;
}

// packages/dogfood/src/automation.ts
var AUTOMATION_MAX_ATTEMPTS = 3;
function relativePath2(value) {
  const path2 = text(value, 256);
  ensure(!/[\\:\u0000-\u001f\u007f]/.test(path2) && path2.split("/").every((part) => part !== "" && ![".", "..", "__proto__", "constructor", "prototype"].includes(part)));
  return path2;
}
function exactVersion(value) {
  const version = text(value, 32);
  ensure(/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[A-Za-z0-9.-]{1,16})?$/.test(version));
  return version;
}
function parseAutomationConfigSnapshot(input) {
  const value = object(input, ["schemaVersion", "bundler", "entryFile", "toolchain", "runtimeVersion", "platforms", "updatesUrl"]);
  ensure(value.schemaVersion === 1 && (value.bundler === "metro" || value.bundler === "expo"));
  const toolchain = object(value.toolchain, ["nodeVersion", "packageManager"]), manager = object(toolchain.packageManager, ["name", "version"]);
  ensure(manager.name === "npm" || manager.name === "pnpm" || manager.name === "yarn");
  const runtimeVersion = text(value.runtimeVersion, 128);
  ensure(!/[\u0000-\u001f\u007f]/.test(runtimeVersion));
  ensure(Array.isArray(value.platforms) && value.platforms.length > 0 && value.platforms.length <= 2 && new Set(value.platforms).size === value.platforms.length);
  const updatesUrl = text(value.updatesUrl, 2048);
  let url;
  try {
    url = new URL(updatesUrl);
  } catch {
    ensure(false);
  }
  ensure(url && !url.username && !url.password && !url.hash && (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  return freeze({ schemaVersion: 1, bundler: value.bundler, entryFile: relativePath2(value.entryFile), toolchain: { nodeVersion: exactVersion(toolchain.nodeVersion), packageManager: { name: manager.name, version: exactVersion(manager.version) } }, runtimeVersion, platforms: value.platforms.map(otaPlatform), updatesUrl: url.href });
}
function parseFloraConfig(input) {
  const value = object(input, ["schemaVersion", "ota", "export"]), ota = object(value.ota, ["runtimeVersion", "platforms", "url"]), adapter = object(value.export, ["bundler", "entryFile", "nodeVersion", "packageManager"]);
  return parseAutomationConfigSnapshot({ schemaVersion: value.schemaVersion, bundler: adapter.bundler, entryFile: adapter.entryFile, toolchain: { nodeVersion: adapter.nodeVersion, packageManager: adapter.packageManager }, runtimeVersion: ota.runtimeVersion, platforms: ota.platforms, updatesUrl: ota.url });
}
function parseAutomationQueueInput(input) {
  const value = object(input, ["requestKey", "detectionId", "channel", "runtimeVersion", "platform", "config"]);
  const config = parseAutomationConfigSnapshot(value.config), target = parseOTASelection({ channel: value.channel, runtimeVersion: value.runtimeVersion, platform: value.platform });
  ensure(config.runtimeVersion === target.runtimeVersion && config.platforms.includes(target.platform), "CONFIG_CONFLICT");
  return freeze({ requestKey: id(value.requestKey), detectionId: id(value.detectionId), ...target, config });
}
function parseAutomationLease(input) {
  const value = object(input, ["jobId", "appId", "attemptId", "runnerId", "credentialEpoch", "fence", "expiresAt"]);
  return freeze({ jobId: id(value.jobId), appId: id(value.appId), attemptId: id(value.attemptId), runnerId: id(value.runnerId), credentialEpoch: integer(value.credentialEpoch, 1), fence: integer(value.fence, 1), expiresAt: integer(value.expiresAt, 1) });
}
function parseAutomationFailureCode(value) {
  ensure(["EXPORT_FAILED", "SOURCE_UNAVAILABLE", "CONFIG_CHANGED", "ARTIFACT_INVALID", "LEASE_EXPIRED", "RUNNER_REVOKED", "CANCELLED", "PUBLICATION_REJECTED"].includes(String(value)));
  return value;
}
function parseAutomationExportReceipt(input) {
  const value = object(input, ["jobId", "attemptId", "commitSha", "configDigest", "toolchainDigest", "sourceArchiveDigest", "launchAssetId", "assetIds", "artifactDigest"]);
  const commitSha = text(value.commitSha, 40);
  ensure(/^[a-f0-9]{40}$/.test(commitSha));
  ensure(Array.isArray(value.assetIds) && value.assetIds.length <= OTA_MAX_ASSETS && new Set(value.assetIds).size === value.assetIds.length);
  const launchAssetId = otaAssetId(value.launchAssetId), assetIds = value.assetIds.map(otaAssetId);
  ensure(!assetIds.includes(launchAssetId));
  return freeze({ jobId: id(value.jobId), attemptId: id(value.attemptId), commitSha, configDigest: digest(value.configDigest), toolchainDigest: digest(value.toolchainDigest), sourceArchiveDigest: digest(value.sourceArchiveDigest), launchAssetId, assetIds, artifactDigest: digest(value.artifactDigest) });
}
function parseAutomationJob(input) {
  const value = object(input, ["requestKey", "detectionId", "channel", "runtimeVersion", "platform", "config", "id", "appId", "detection", "commitSha", "rootDirectory", "connection", "configDigest", "toolchainDigest", "createdAt", "updatedAt", "state", "attemptCount", "lease", "code", "deploymentId", "receipt"]);
  const queue = parseAutomationQueueInput({ requestKey: value.requestKey, detectionId: value.detectionId, channel: value.channel, runtimeVersion: value.runtimeVersion, platform: value.platform, config: value.config }), detection = parseGitHubDetection(value.detection), appId = id(value.appId), jobId = id(value.id);
  ensure(detection.appId === appId && detection.id === queue.detectionId && detection.commitSha === value.commitSha && detection.rootDirectory === value.rootDirectory && canonicalJson(detection.connection) === canonicalJson(value.connection), "INVALID_RELATION");
  const createdAt = integer(value.createdAt), updatedAt = integer(value.updatedAt, createdAt);
  ensure(["queued", "leased", "cancel_requested", "succeeded", "failed", "cancelled"].includes(String(value.state)));
  const lease = value.lease === null ? null : parseAutomationLease(value.lease);
  if (lease) ensure(lease.appId === appId && lease.jobId === jobId);
  const receipt = value.receipt === null ? null : parseAutomationExportReceipt(value.receipt), deploymentId = value.deploymentId === null ? null : text(value.deploymentId, 96);
  if (value.state === "succeeded") ensure(receipt && deploymentId && receipt.jobId === jobId);
  else ensure(receipt === null && deploymentId === null);
  ensure(value.state === "leased" || value.state === "cancel_requested" ? lease !== null : lease === null);
  return freeze({ ...queue, id: jobId, appId, detection, commitSha: detection.commitSha, rootDirectory: detection.rootDirectory, connection: detection.connection, configDigest: digest(value.configDigest), toolchainDigest: digest(value.toolchainDigest), createdAt, updatedAt, state: value.state, attemptCount: integer(value.attemptCount, 0, AUTOMATION_MAX_ATTEMPTS), lease, code: value.code === null ? null : parseAutomationFailureCode(value.code), deploymentId, receipt });
}
async function automationDigest(input) {
  const bytes = new TextEncoder().encode(canonicalJson(input));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function automationArtifactPayload(input, assets) {
  const { artifactDigest: _unused, ...core } = input;
  const { artifactDigest: _placeholder, ...receipt } = parseAutomationExportReceipt({ ...core, artifactDigest: "0".repeat(64) });
  ensure(canonicalJson(assets.map((asset) => asset.id)) === canonicalJson([receipt.launchAssetId, ...receipt.assetIds]), "INVALID_RELATION");
  return freeze({ receipt, assets: assets.map((asset) => {
    const { appId: _app, createdAt: _time, ...metadata } = parseOTAAsset(asset);
    return metadata;
  }) });
}

// packages/dogfood/src/operations.ts
var OTA_ASSET_MAX_BYTES = 16 * 1024 * 1024;
var OTA_MAX_ASSETS = 64;
var OTA_APP_MAX_BYTES = 64 * 1024 * 1024;
function parseGitHubConnectionUpdate(input) {
  const value = object(input, ["expectedVersion", "installationId", "owner", "repository", "ref"]);
  const owner = text(value.owner, 39), repository = text(value.repository, 100), ref = text(value.ref, 256);
  ensure(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner));
  ensure(/^[A-Za-z0-9_.-]+$/.test(repository) && ![".", ".."].includes(repository));
  ensure(!/[\u0000-\u0020\u007f~^:?*[\\]/.test(ref) && !ref.includes("..") && !ref.endsWith("/") && !ref.startsWith("/") && !ref.endsWith(".lock"));
  return freeze({ expectedVersion: integer(value.expectedVersion, 0, Number.MAX_SAFE_INTEGER - 1), installationId: integer(value.installationId, 1), owner, repository, ref });
}
function parseOTAAssetUpload(input) {
  const value = object(input, ["key", "contentType", "fileExtension"]);
  const key = text(value.key, 128), contentType = text(value.contentType, 128), fileExtension = text(value.fileExtension, 16);
  ensure(/^[A-Za-z0-9_-]+$/.test(key));
  ensure(/^(?:application\/(?:javascript|octet-stream|json|wasm|x-font-ttf|vnd\.ms-fontobject)|text\/javascript|image\/(?:png|jpeg|gif|webp|avif)|font\/(?:ttf|otf|woff|woff2)|audio\/(?:mpeg|mp4|wav|ogg)|video\/mp4)$/.test(contentType));
  ensure(/^\.[A-Za-z0-9]{1,15}$/.test(fileExtension));
  return freeze({ key, contentType, fileExtension });
}
function otaAssetId(value) {
  const result = text(value, 70);
  ensure(/^asset_[a-f0-9]{64}$/.test(result));
  return result;
}
function otaPlatform(value) {
  ensure(value === "ios" || value === "android");
  return value;
}
function parseOTASelection(input) {
  const value = object(input, ["channel", "runtimeVersion", "platform"]);
  const channel = text(value.channel, 64), runtimeVersion = text(value.runtimeVersion, 128);
  ensure(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(channel) && !/[\u0000-\u001f\u007f]/.test(runtimeVersion));
  return freeze({ channel, runtimeVersion, platform: otaPlatform(value.platform) });
}
function parseGitHubDetection(input) {
  const hasAutomation = typeof input === "object" && input !== null && Object.hasOwn(input, "automationConfig");
  const value = object(input, ["id", "appId", "connection", "rootDirectory", "detectedAt", "commitSha", "framework", "expoVersion", "reactNativeVersion", "configSource", "runtimeVersion", "platforms", "updatesEnabled", "updatesUrl", "reasons", ...hasAutomation ? ["automationConfig"] : []]);
  const connection = object(value.connection, ["appId", "version", "installationId", "owner", "repository", "ref", "connectedAt"]);
  const version = integer(connection.version, 1), appId = id(value.appId);
  const parsed = parseGitHubConnectionUpdate({ expectedVersion: version - 1, installationId: connection.installationId, owner: connection.owner, repository: connection.repository, ref: connection.ref });
  ensure(connection.appId === appId);
  const rootDirectory = text(value.rootDirectory, 4096);
  ensure(rootDirectory === "." || !/[\\:\u0000-\u001f\u007f]/.test(rootDirectory) && rootDirectory.split("/").every((part) => part !== "" && ![".", "..", "__proto__", "constructor", "prototype"].includes(part)));
  const commitSha = text(value.commitSha, 40);
  ensure(/^[a-f0-9]{40}$/.test(commitSha));
  ensure(["expo", "react-native", "flora", "unsupported"].includes(String(value.framework)) && ["app.json", "resolved-export", "flora.config.json", "none", "dynamic-required"].includes(String(value.configSource)));
  const nullable = (field, max) => field === null ? null : text(field, max);
  const runtimeVersion = nullable(value.runtimeVersion, 128);
  if (runtimeVersion) ensure(!/[\u0000-\u001f\u007f]/.test(runtimeVersion));
  ensure(Array.isArray(value.platforms) && value.platforms.length <= 2 && new Set(value.platforms).size === value.platforms.length);
  const platforms = value.platforms.map(otaPlatform);
  ensure(typeof value.updatesEnabled === "boolean" && Array.isArray(value.reasons) && value.reasons.length <= 16);
  const reasons = value.reasons.map((reason) => {
    const result = text(reason, 128);
    ensure(/^[A-Z][A-Z0-9_]*$/.test(result));
    return result;
  });
  const updatesUrl = nullable(value.updatesUrl, 2048);
  if (updatesUrl) {
    let url;
    try {
      url = new URL(updatesUrl);
    } catch {
      ensure(false);
    }
    ensure(url && !url.username && !url.password && !url.hash && (url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)));
  }
  if (value.updatesEnabled) ensure(value.framework !== "unsupported" && runtimeVersion && updatesUrl && platforms.length && reasons.length === 0 && !["none", "dynamic-required"].includes(String(value.configSource)));
  const automationConfig = hasAutomation && value.automationConfig !== null ? parseAutomationConfigSnapshot(value.automationConfig) : null;
  if (automationConfig) ensure(automationConfig.runtimeVersion === runtimeVersion && automationConfig.updatesUrl === updatesUrl && canonicalJson(automationConfig.platforms) === canonicalJson(platforms), "INVALID_RELATION");
  return freeze({ id: id(value.id), appId, connection: { appId, version, installationId: parsed.installationId, owner: parsed.owner, repository: parsed.repository, ref: parsed.ref, connectedAt: integer(connection.connectedAt) }, rootDirectory, detectedAt: integer(value.detectedAt), commitSha, framework: value.framework, expoVersion: nullable(value.expoVersion, 128), reactNativeVersion: nullable(value.reactNativeVersion, 128), configSource: value.configSource, runtimeVersion, platforms, updatesEnabled: value.updatesEnabled, updatesUrl, reasons, ...hasAutomation ? { automationConfig } : {} });
}
function parseOTAAsset(input) {
  const value = object(input, ["id", "appId", "digest", "hash", "key", "contentType", "fileExtension", "size", "createdAt"]);
  const hash = text(value.hash, 43);
  ensure(/^[A-Za-z0-9_-]{43}$/.test(hash));
  const hex = digest(value.digest);
  ensure(otaAssetId(value.id) === "asset_" + hex);
  const hashBytes = Uint8Array.from(hex.match(/../g), (pair) => Number.parseInt(pair, 16));
  ensure(btoa(String.fromCharCode(...hashBytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") === hash, "INVALID_RELATION");
  return freeze({ id: otaAssetId(value.id), appId: id(value.appId), digest: hex, hash, ...parseOTAAssetUpload({ key: value.key, contentType: value.contentType, fileExtension: value.fileExtension }), size: integer(value.size, 1, OTA_ASSET_MAX_BYTES), createdAt: integer(value.createdAt) });
}

// packages/dogfood/src/github.ts
function isGitHubInstallationToken(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 4096 && /^[A-Za-z0-9._~+/-]+=*$/.test(value);
}
var fileLimit = 256 * 1024;
var responseLimit = 1024 * 1024;
var utf8 = new TextEncoder();

// packages/dogfood/src/profile.ts
var CONFIG_RUNTIME_SMOKE_V1 = freeze({
  id: "config-runtime-smoke-v1",
  argv: [
    "node",
    "./node_modules/vitest/vitest.mjs",
    "run",
    "tests/config/runtime.test.ts",
    "tests/config/experience-runtime.test.ts",
    "--maxWorkers=1",
    "--reporter=json",
    "--outputFile=/results/vitest.json"
  ],
  files: [
    "tests/config/runtime.test.ts",
    "tests/config/experience-runtime.test.ts"
  ],
  expectedTests: 4,
  expectedTestsPerFile: 2,
  coverage: "Two configuration/runtime smoke test files and four tests; no build, signing, store, OTA, or isolation verification."
});

// packages/dogfood/src/source.ts
var MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
var MAX_FILE_BYTES = 1024 * 1024;
var MAX_TOTAL_FILE_BYTES = 1.5 * 1024 * 1024;
var OPTIONAL_FILE = "src/core/experience/types.ts";
var REQUIRED_FILES = [
  "package.json",
  "package-lock.json",
  "flavors/config.json",
  "src/core/config/runtime.ts",
  "src/core/experience/runtime.ts",
  "config/experience-contract.json",
  "vitest.config.mts",
  "tsconfig.json",
  ...CONFIG_RUNTIME_SMOKE_V1.files
];
var ALLOWED_FILES = /* @__PURE__ */ new Set([...REQUIRED_FILES, OPTIONAL_FILE]);

// packages/dogfood/src/baseline.ts
var MAX_BUNDLE = 2 * 1024 * 1024;
var MAX_REPORT = 1024 * 1024;

// packages/ota-runner/src/recovery.ts
import { constants as constants2 } from "node:fs";
import { lstat as lstat2, mkdir, open as open2, realpath as realpath2, unlink, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join as join2, resolve as resolve2 } from "node:path";
function parseRecoveryJournal(input, binding) {
  invariant(input && typeof input === "object" && !Array.isArray(input));
  const value = input;
  invariant(Object.keys(value).length === 4 && Object.keys(value).every((key) => ["schemaVersion", "origin", "lease", "receipt"].includes(key)) && value.schemaVersion === 1 && typeof value.origin === "string");
  const origin = new URL(value.origin);
  invariant(origin.origin === value.origin && !origin.username && !origin.password && (origin.protocol === "https:" || origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)));
  const lease = parseAutomationLease(value.lease), receipt = parseAutomationExportReceipt(value.receipt);
  invariant(lease.jobId === receipt.jobId && lease.attemptId === receipt.attemptId);
  if (binding) invariant(binding.origin === value.origin && binding.runnerId === lease.runnerId);
  return { schemaVersion: 1, origin: value.origin, lease, receipt };
}
async function privateDirectory(directory, create = false) {
  invariant(isAbsolute(directory) && resolve2(directory) === directory);
  if (create) {
    try {
      await mkdir(directory, { mode: 448 });
      await syncDirectory(dirname(directory));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  const stat = await lstat2(directory);
  invariant(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 511) === 448 && (!process.getuid || stat.uid === process.getuid()));
  return realpath2(directory);
}
async function syncDirectory(directory) {
  const handle = await open2(directory, constants2.O_RDONLY | constants2.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function writeRecoveryJournal(directory, input) {
  try {
    const record = parseRecoveryJournal(input);
    directory = await privateDirectory(directory, true);
    const path2 = join2(directory, record.lease.jobId + "." + record.lease.attemptId + ".json");
    const handle = await open2(path2, constants2.O_WRONLY | constants2.O_CREAT | constants2.O_EXCL | constants2.O_NOFOLLOW, 384);
    try {
      await handle.writeFile(JSON.stringify(record) + "\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(directory);
    return path2;
  } catch {
    throw new Error("RECOVERY_JOURNAL_UNAVAILABLE");
  }
}
async function readRecoveryJournal(path2, binding) {
  try {
    await privateDirectory(dirname(path2));
    const stat = await lstat2(path2);
    invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 16384 && (stat.mode & 511) === 384 && (!process.getuid || stat.uid === process.getuid()));
    const handle = await open2(path2, constants2.O_RDONLY | constants2.O_NOFOLLOW);
    try {
      const current = await handle.stat();
      invariant(current.ino === stat.ino && current.dev === stat.dev && current.isFile() && current.nlink === 1 && current.size <= 16384 && (current.mode & 511) === 384 && (!process.getuid || current.uid === process.getuid()));
      const bytes = await handle.readFile();
      invariant(bytes.length <= 16384);
      return parseRecoveryJournal(JSON.parse(bytes.toString("utf8")), binding);
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error("INVALID_RECOVERY_JOURNAL");
  }
}
function assertPublicationResult(result, record) {
  const { job, deployment } = result;
  invariant(job && deployment && job.id === record.lease.jobId && job.appId === record.lease.appId && job.state === "succeeded" && job.deploymentId === deployment.id && deployment.appId === record.lease.appId && deployment.commitSha === record.receipt.commitSha && deployment.launchAssetId === record.receipt.launchAssetId && JSON.stringify(deployment.assetIds) === JSON.stringify(record.receipt.assetIds) && JSON.stringify(parseAutomationExportReceipt(job.receipt)) === JSON.stringify(record.receipt), "PUBLICATION_RESULT_UNCONFIRMED");
}
async function clearRecoveryJournal(path2, record) {
  const current = await readRecoveryJournal(path2, { origin: record.origin, runnerId: record.lease.runnerId });
  invariant(JSON.stringify(current) === JSON.stringify(record), "RECOVERY_JOURNAL_CHANGED");
  await unlink(path2);
  await syncDirectory(dirname(path2));
  try {
    await lstat2(path2);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("RECOVERY_CLEANUP_UNCONFIRMED");
}
async function reconcilePublication(client, path2, remoteCheckpoint = false) {
  invariant(client.identity && (!remoteCheckpoint || client.clearCheckpoint), "INVALID_RUNNER_CONFIG");
  const record = await readRecoveryJournal(path2, client.identity);
  const result = await client.finalize(record.lease, record.receipt);
  assertPublicationResult(result, record);
  await clearRecoveryJournal(path2, record);
  if (remoteCheckpoint) await clearRemoteCheckpoint(client, record);
  return result;
}
async function clearRemoteCheckpoint(client, record) {
  invariant(client.clearCheckpoint, "INVALID_RUNNER_CONFIG");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await client.clearCheckpoint(record);
      invariant(["committed", "absent"].includes(result.disposition) && result.appId === record.lease.appId && result.jobId === record.lease.jobId && result.attemptId === record.lease.attemptId && (result.disposition === "absent" ? result.receiptDigest === null : result.receiptDigest === await automationDigest(record.receipt)), "RECOVERY_CHECKPOINT_UNAVAILABLE");
      return;
    } catch (error) {
      const status = error.status;
      if (attempt === 2 || typeof status !== "number" || status !== 0 && status < 500) throw new Error("RECOVERY_CHECKPOINT_UNAVAILABLE");
    }
  }
}
async function reconcileRemotePublications(client, directory) {
  invariant(client.identity && client.listCheckpoints && client.clearCheckpoint, "INVALID_RUNNER_CONFIG");
  const records = await client.listCheckpoints();
  directory = await privateDirectory(directory, true);
  const paths = new Set(await pendingRecoveryJournals(directory));
  for (const input of records) {
    const record = parseRecoveryJournal(input, client.identity), path2 = join2(directory, record.lease.jobId + "." + record.lease.attemptId + ".json");
    if (paths.has(path2)) {
      const local = await readRecoveryJournal(path2, client.identity);
      invariant(JSON.stringify(local) === JSON.stringify(record), "INVALID_RECOVERY_JOURNAL");
    } else {
      paths.add(await writeRecoveryJournal(directory, record));
    }
  }
  for (const path2 of [...paths].sort()) {
    try {
      await reconcilePublication(client, path2, true);
    } catch (error) {
      invariant(error instanceof Error, "RECOVERY_CHECKPOINT_UNAVAILABLE");
      if (error.status !== 409 || !["LEASE_STALE", "LEASE_EXPIRED"].includes(error.message)) throw error;
      const record = await readRecoveryJournal(path2, client.identity), proof = await client.clearCheckpoint(record, "stale");
      invariant(proof.disposition === "stale" && proof.appId === record.lease.appId && proof.jobId === record.lease.jobId && proof.attemptId === record.lease.attemptId && proof.receiptDigest === await automationDigest(record.receipt), "RECOVERY_CHECKPOINT_UNAVAILABLE");
      await clearRecoveryJournal(path2, record);
    }
  }
  return paths.size;
}
async function pendingRecoveryJournals(directory) {
  try {
    await lstat2(directory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error("RECOVERY_JOURNAL_UNAVAILABLE");
  }
  try {
    const canonical = await privateDirectory(directory);
    const entries = await readdir(canonical);
    return entries.filter((name) => name.endsWith(".json")).sort().map((name) => join2(canonical, name));
  } catch {
    throw new Error("RECOVERY_JOURNAL_UNAVAILABLE");
  }
}

// packages/ota-runner/src/client.ts
var RunnerHttpFailure = class extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
  status;
};
function createRunnerClient(options) {
  const origin = new URL(options.origin);
  invariant(origin.origin === options.origin && !origin.username && !origin.password && (origin.protocol === "https:" || origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)), "INVALID_RUNNER_CONFIG");
  invariant(/^[a-z][a-z0-9_-]{2,95}\.[A-Za-z0-9_-]{43}$/.test(options.token), "INVALID_RUNNER_CONFIG");
  const request = options.fetch ?? fetch;
  async function call(path2, data, binary, timeoutMs = 2e4) {
    let responseStatus = 0;
    try {
      const response = await request(options.origin + path2, { method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs), headers: { Authorization: "Bearer " + options.token, Origin: options.origin, "Content-Type": binary ? "application/octet-stream" : "application/json", ...binary ? { "X-Flora-Runner-Lease": Buffer.from(JSON.stringify(parseAutomationLease(binary.lease))).toString("base64url") } : {} }, body: binary ? new Uint8Array(binary.bytes) : JSON.stringify(data) });
      responseStatus = response.status;
      if (response.status === 204) return null;
      if (!response.body && !response.ok) throw new RunnerHttpFailure(response.status, "RUNNER_REQUEST_REJECTED");
      invariant(response.body, "RUNNER_RESPONSE_INVALID");
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        for (; ; ) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          invariant(size <= 1048576, "RUNNER_RESPONSE_INVALID");
          chunks.push(part.value);
        }
      } finally {
        void reader.cancel().catch(() => {
        });
      }
      let raw;
      try {
        raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        if (!response.ok) throw new RunnerHttpFailure(response.status, "RUNNER_REQUEST_REJECTED");
        throw new Error("RUNNER_RESPONSE_INVALID");
      }
      if (!response.ok) {
        const code = typeof raw?.error === "string" && /^[A-Z][A-Z0-9_]{1,95}$/.test(raw.error) ? raw.error : "RUNNER_REQUEST_REJECTED";
        throw new RunnerHttpFailure(response.status, code);
      }
      return raw;
    } catch (error) {
      if (error instanceof RunnerHttpFailure) throw error;
      throw new RunnerHttpFailure(responseStatus >= 400 ? responseStatus : 0, responseStatus >= 400 ? "RUNNER_REQUEST_REJECTED" : "RUNNER_TRANSPORT_UNAVAILABLE");
    }
  }
  const client = {
    identity: { origin: options.origin, runnerId: options.token.split(".")[0] },
    async claim() {
      const input = await call("/api/runner/claim", {});
      if (input === null) return null;
      invariant(input && typeof input === "object", "RUNNER_RESPONSE_INVALID");
      const raw = input, job = parseAutomationJob(raw.job), lease = parseAutomationLease(raw.lease);
      invariant(job.state === "leased" && job.lease && JSON.stringify(job.lease) === JSON.stringify(lease) && job.appId === lease.appId && job.id === lease.jobId && lease.expiresAt > Date.now() && lease.runnerId === options.token.split(".")[0], "RUNNER_RESPONSE_INVALID");
      invariant(await automationDigest(job.config) === job.configDigest && await automationDigest(job.config.toolchain) === job.toolchainDigest, "RUNNER_RESPONSE_INVALID");
      return { job, lease };
    },
    async heartbeat(lease) {
      return parseAutomationLease(await call("/api/runner/heartbeat", { lease: parseAutomationLease(lease) }));
    },
    async source(lease) {
      const value = await call("/api/runner/source", { lease: parseAutomationLease(lease) });
      invariant(value && typeof value.url === "string" && typeof value.token === "string" && typeof value.expiresAt === "number" && typeof value.maxBytes === "number" && typeof value.commitSha === "string", "RUNNER_RESPONSE_INVALID");
      return value;
    },
    async uploadAsset(lease, upload, bytes) {
      const metadata = parseOTAAssetUpload(upload), query = new URLSearchParams(metadata);
      const asset = parseOTAAsset(await call("/api/runner/assets?" + query.toString(), null, { lease, bytes }));
      invariant(asset.appId === lease.appId && asset.digest === sha256(bytes) && asset.size === bytes.length && asset.key === metadata.key && asset.contentType === metadata.contentType && asset.fileExtension === metadata.fileExtension, "RUNNER_RESPONSE_INVALID");
      return asset;
    },
    async finalize(lease, receipt) {
      const raw = await call("/api/runner/finalize", { lease: parseAutomationLease(lease), receipt }, void 0, 1e4);
      const job = parseAutomationJob(raw.job);
      invariant(job.id === lease.jobId && job.appId === lease.appId && job.state === "succeeded" && raw.deployment?.id === job.deploymentId, "RUNNER_RESPONSE_INVALID");
      const result = { job, deployment: raw.deployment };
      assertPublicationResult(result, { schemaVersion: 1, origin: options.origin, lease: parseAutomationLease(lease), receipt: parseAutomationExportReceipt(receipt) });
      return result;
    },
    async fail(lease, code) {
      await call("/api/runner/fail", { lease: parseAutomationLease(lease), code });
    },
    async saveCheckpoint(input) {
      const record = parseRecoveryJournal(input, client.identity), raw = await call("/api/runner/checkpoint-save", record, void 0, 1e4);
      invariant(raw && typeof raw === "object" && Object.keys(raw).length === 1 && raw.saved === true, "RUNNER_RESPONSE_INVALID");
    },
    async listCheckpoints() {
      const raw = await call("/api/runner/checkpoint-list", {}, void 0, 1e4);
      invariant(raw && typeof raw === "object" && Object.keys(raw).length === 1 && Array.isArray(raw.checkpoints) && raw.checkpoints.length <= 100, "RUNNER_RESPONSE_INVALID");
      const records = raw.checkpoints.map((record) => parseRecoveryJournal(record, client.identity));
      invariant(new Set(records.map((record) => record.lease.jobId + "." + record.lease.attemptId)).size === records.length, "RUNNER_RESPONSE_INVALID");
      return records;
    },
    async clearCheckpoint(input, expectedDisposition) {
      const record = parseRecoveryJournal(input, client.identity), raw = await call("/api/runner/checkpoint-clear", { jobId: record.lease.jobId, attemptId: record.lease.attemptId, ...expectedDisposition ? { expectedDisposition } : {} }, void 0, 1e4);
      invariant(raw && typeof raw === "object" && Object.keys(raw).length === 6 && raw.cleared === true && ["committed", "stale", "absent"].includes(String(raw.disposition)) && raw.appId === record.lease.appId && raw.jobId === record.lease.jobId && raw.attemptId === record.lease.attemptId && (raw.disposition === "absent" ? raw.receiptDigest === null : raw.receiptDigest === await automationDigest(record.receipt)) && (!expectedDisposition || raw.disposition === expectedDisposition), "RUNNER_RESPONSE_INVALID");
      return { disposition: raw.disposition, appId: record.lease.appId, jobId: record.lease.jobId, attemptId: record.lease.attemptId, receiptDigest: raw.receiptDigest };
    }
  };
  return client;
}

// packages/ota-runner/src/docker.ts
import { randomUUID } from "node:crypto";
import { resolve as resolve3, join as join5 } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir as mkdir3, writeFile as writeFile2, rm, chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// packages/ota-runner/src/process.ts
import { spawn } from "node:child_process";
import { delimiter, isAbsolute as isAbsolute2, join as join3 } from "node:path";
var npmCodes = ["ERESOLVE", "EINTEGRITY", "ENOTCACHED", "ELOCKVERIFY", "EUSAGE", "ENOENT", "EACCES", "ECONNRESET", "ETIMEDOUT", "ENOSPC", "ENOMEM", "EBADENGINE", "EUNSUPPORTEDPROTOCOL", "E401", "E403", "E404", "E500", "ENETUNREACH"];
var safeCodes = /* @__PURE__ */ new Set(["EXECUTION_FAILED", "CONFIG_CHANGED", "ARTIFACT_INVALID", "SOURCE_UNAVAILABLE", "ISOLATION_UNAVAILABLE", "DEPENDENCY_CACHE_INVALID", "PROCESS_TIMEOUT", "PROCESS_CANCELLED", "PROCESS_OUTPUT_LIMIT", "PROCESS_SPAWN_FAILED", "NPM_CONFIG_DUPLICATE", "EXPO_EXECUTION_DENIED", "EXPO_MODULE_MISSING", "EXPO_WORKER_LIMIT", "EXPO_OUTPUT_BUSY", ...npmCodes.map((code) => "NPM_" + code)]);
var childStages = ["configuration", "source-copy", "npm-version", "npm-install", "cache-validate", "cache-copy", "exporter", "expo-config", "expo-export", "artifact-read"];
var safeStages = /* @__PURE__ */ new Set(["execution", "source-verified", "dependency-seed", "dependency-preparation", "compiler", "artifact-verified", ...childStages, ...childStages.map((stage) => "dependency-preparation-" + stage), ...childStages.map((stage) => "compiler-" + stage)]);
function diagnosticLine(stage, code) {
  return JSON.stringify({ diagnostic: true, stage: safeStages.has(stage) ? stage : "execution", ...code ? { code: safeCodes.has(code) ? code : "EXECUTION_FAILED" } : {} });
}
var ProcessFailure = class extends Error {
  constructor(safeCode, containerDiagnostic) {
    super("EXECUTION_FAILED");
    this.safeCode = safeCode;
    this.containerDiagnostic = containerDiagnostic;
  }
  safeCode;
  containerDiagnostic;
};
function diagnosticCode(error) {
  if (error instanceof ProcessFailure) return error.safeCode;
  const code = error instanceof Error ? error.message : "EXECUTION_FAILED";
  return safeCodes.has(code) ? code : "EXECUTION_FAILED";
}
function childDiagnostic(stderr) {
  let found;
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.startsWith("FLORA_DIAGNOSTIC ") || line.length > 512) continue;
    try {
      const raw = JSON.parse(line.slice(17));
      if (raw.diagnostic === true && typeof raw.stage === "string" && childStages.includes(raw.stage) && typeof raw.code === "string" && safeCodes.has(raw.code) && Object.keys(raw).length === 3) found = { diagnostic: true, stage: raw.stage, code: raw.code };
    } catch {
    }
  }
  return found;
}
function failure(reason, stderr, diagnostics) {
  const code = reason === "timeout" ? "PROCESS_TIMEOUT" : reason === "cancelled" ? "PROCESS_CANCELLED" : reason === "output" ? "PROCESS_OUTPUT_LIMIT" : reason === "spawn" ? "PROCESS_SPAWN_FAILED" : "EXECUTION_FAILED";
  if (diagnostics === "npm" && reason === "exit") {
    if (/double-loading config [^\n]{1,256} as [^\n]{1,128} previously loaded as/.test(stderr)) return new ProcessFailure("NPM_CONFIG_DUPLICATE");
    const match = /npm (?:error|ERR!) code ([A-Z][A-Z0-9_]{0,63})(?:\r?\n|$)/.exec(stderr);
    if (match && npmCodes.includes(match[1])) return new ProcessFailure("NPM_" + match[1]);
  }
  if (diagnostics === "expo" && reason === "exit") {
    if (/\bEBUSY\b/.test(stderr)) return new ProcessFailure("EXPO_OUTPUT_BUSY");
    if (/\bEACCES\b|failed to map segment from shared object/.test(stderr)) return new ProcessFailure("EXPO_EXECUTION_DENIED");
    if (/Cannot find module|Failed to resolve plugin|\bMODULE_NOT_FOUND\b/.test(stderr)) return new ProcessFailure("EXPO_MODULE_MISSING");
    if (/\bEAGAIN\b|ERR_WORKER_INIT_FAILED/.test(stderr)) return new ProcessFailure("EXPO_WORKER_LIMIT");
  }
  return new ProcessFailure(code, diagnostics === "container" ? childDiagnostic(stderr) : void 0);
}
function processEnvironment(extra = {}) {
  const path2 = (process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(delimiter).filter(isAbsolute2).join(delimiter);
  return { PATH: path2, LANG: "C.UTF-8", CI: "1", ...extra };
}
async function trustedProcess(executable, args, options = {}) {
  let reason = "exit";
  const controller = new AbortController(), timeout = setTimeout(() => {
    reason = "timeout";
    controller.abort();
  }, options.timeoutMs ?? 6e4);
  const cancel = () => {
    reason = "cancelled";
    controller.abort();
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  let child;
  try {
    return await new Promise((resolve5, reject) => {
      let size = 0, failed = false, finished = false, stderr = "";
      const parts = [];
      const kill = () => {
        if (child?.pid) {
          try {
            if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch {
          }
        }
      };
      const fail = () => {
        if (!finished && !failed) {
          failed = true;
          kill();
        }
      };
      child = spawn(executable, [...args], { ...options.cwd ? { cwd: options.cwd } : {}, env: options.env ?? processEnvironment(), stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
      controller.signal.addEventListener("abort", fail, { once: true });
      const append = (part, stdout) => {
        if (failed) return;
        size += part.length;
        if (size > (options.maxBytes ?? 1024 * 1024)) {
          reason = "output";
          fail();
          return;
        }
        if (stdout) parts.push(part);
        else if (options.diagnostics) stderr = (stderr + part.toString("utf8")).slice(-16384);
      };
      child.stdout.on("data", (part) => append(part, true));
      child.stderr.on("data", (part) => append(part, false));
      child.on("error", () => {
        reason = "spawn";
        fail();
      });
      child.on("close", (code) => {
        controller.signal.removeEventListener("abort", fail);
        if (!finished) {
          finished = true;
          if (code === 0 && !failed && !controller.signal.aborted) resolve5(Buffer.concat(parts).toString("utf8"));
          else reject(failure(reason, stderr, options.diagnostics));
        }
      });
      child.stdin.on("error", () => {
      });
      child.stdin.end(options.input ?? "");
      if (controller.signal.aborted) fail();
    });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancel);
  }
}

// packages/ota-runner/src/dependencies.ts
import { createHash as createHash2 } from "node:crypto";
import { mkdir as mkdir2, writeFile, realpath as realpath3 } from "node:fs/promises";
import { dirname as dirname2, join as join4, sep as sep2 } from "node:path";
var NPM_REGISTRY = "https://registry.npmjs.org";
var HOSTED_NODE_VERSION = "24.19.0";
var HOSTED_NPM_VERSION = "10.9.8";
function object2(input) {
  invariant(input && typeof input === "object" && !Array.isArray(input));
  return input;
}
function vendorPath(resolved) {
  invariant(/^file:vendor\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\.tgz$/.test(resolved));
  return relativePath(resolved.slice(5));
}
function specification(input) {
  invariant(typeof input === "string" && input.length > 0 && input.length <= 256);
  if (input.startsWith("file:")) {
    vendorPath(input);
    return;
  }
  invariant(/^[A-Za-z0-9$._*+^~|<>= -]+$/.test(input));
}
function dependencies(input) {
  for (const [name, value] of Object.entries(object2(input))) {
    invariant(/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(name) && ![".", ".."].includes(name));
    specification(value);
  }
}
function overrides(input, depth = 0) {
  invariant(depth <= 8);
  for (const [name, value] of Object.entries(object2(input))) {
    invariant(name.length <= 256 && !/[\u0000-\u001f]/.test(name));
    if (typeof value === "string") specification(value);
    else overrides(value, depth + 1);
  }
}
function integrity(input) {
  invariant(typeof input === "string" && /^sha512-[A-Za-z0-9+/]{86}==$/.test(input));
  const value = input.slice(7);
  invariant(Buffer.from(value, "base64").length === 64 && Buffer.from(value, "base64").toString("base64") === value);
  return input;
}
function registryTarball(resolved) {
  const url = new URL(resolved);
  invariant(url.origin === NPM_REGISTRY && url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && resolved === url.href);
  invariant(/^\/(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+\/-\/[A-Za-z0-9._-]+\.tgz$/.test(url.pathname));
}
async function prepareNpmDependencySeed(source, rootDirectory, destination) {
  try {
    const base = await realpath3(source), root = await realpath3(join4(base, rootDirectory === "." ? "" : relativePath(rootDirectory)));
    invariant(root === base || root.startsWith(base + sep2));
    const packageBytes = await readBoundedFile(root, "package.json", 131072), lockBytes = await readBoundedFile(root, "package-lock.json", 8 * 1024 * 1024);
    const pkg = object2(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(packageBytes))), lock = object2(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(lockBytes)));
    invariant(lock.lockfileVersion === 3 && pkg.workspaces === void 0 && typeof pkg.name === "string" && typeof pkg.version === "string");
    const clean = { name: pkg.name, version: pkg.version, private: true };
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      if (pkg[field] !== void 0) {
        dependencies(pkg[field]);
        clean[field] = pkg[field];
      }
    }
    if (pkg.peerDependenciesMeta !== void 0) clean.peerDependenciesMeta = object2(pkg.peerDependenciesMeta);
    if (pkg.overrides !== void 0) {
      overrides(pkg.overrides);
      clean.overrides = pkg.overrides;
    }
    const packages = object2(lock.packages), entries = Object.entries(packages);
    invariant(entries.length > 1 && entries.length <= 2e3 && packages[""] !== void 0);
    const vendors = /* @__PURE__ */ new Map();
    let total = 0;
    for (const [path2, input] of entries) {
      invariant(path2.length <= 2048 && !/[\\\u0000-\u001f]/.test(path2) && path2.split("/").every((part) => part !== "." && part !== "..") && (path2 === "" || path2.startsWith("node_modules/")));
      const entry = object2(input);
      invariant(entry.link !== true);
      for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
        if (entry[field] !== void 0) dependencies(entry[field]);
      }
      if (path2 === "") continue;
      invariant(typeof entry.resolved === "string");
      const expected = integrity(entry.integrity);
      if (entry.resolved.startsWith("file:")) {
        const vendor = vendorPath(entry.resolved), existing = vendors.get(vendor);
        if (existing) {
          invariant(existing.integrity === expected);
          continue;
        }
        const bytes = await readBoundedFile(root, vendor, 16 * 1024 * 1024);
        invariant("sha512-" + createHash2("sha512").update(bytes).digest("base64") === expected);
        total += bytes.length;
        invariant(total <= 64 * 1024 * 1024);
        vendors.set(vendor, { bytes, integrity: expected });
      } else registryTarball(entry.resolved);
    }
    await mkdir2(destination, { mode: 448 });
    await writeFile(join4(destination, "package.json"), JSON.stringify(clean), { mode: 292 });
    await writeFile(join4(destination, "package-lock.json"), lockBytes, { mode: 292 });
    for (const [path2, { bytes }] of vendors) {
      await mkdir2(dirname2(join4(destination, path2)), { recursive: true, mode: 448 });
      await writeFile(join4(destination, path2), bytes, { mode: 292 });
    }
  } catch {
    throw new Error("DEPENDENCY_CACHE_INVALID");
  }
}

// packages/ota-runner/src/docker.ts
function containerIdentity() {
  const uid = process.getuid?.(), gid = process.getgid?.();
  invariant(typeof uid === "number" && uid > 0 && typeof gid === "number" && gid >= 0, "ISOLATION_UNAVAILABLE");
  return { uid, gid };
}
function path(input) {
  invariant(input.startsWith("/") && !/[\r\n,]/.test(input), "ISOLATION_UNAVAILABLE");
  return input;
}
function boundedArguments(image, name, profile, workspaceExecutable = false) {
  invariant(/^(?:[A-Za-z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/.test(image), "ISOLATION_UNAVAILABLE");
  invariant(/^flora-[A-Za-z0-9_-]+$/.test(name) && ["default", "github-hosted"].includes(profile), "ISOLATION_UNAVAILABLE");
  const { uid, gid } = containerIdentity(), owner = `uid=${uid},gid=${gid}`, hosted = profile === "github-hosted", memory = hosted ? 4294967296 : 1073741824, workspace = hosted ? 3221225472 : 805306368;
  return [
    "run",
    "--rm",
    "--pull=never",
    "--name",
    name,
    "--init",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=128",
    `--memory=${memory}`,
    `--memory-swap=${memory}`,
    "--cpus=2",
    `--user=${uid}:${gid}`,
    `--tmpfs=/workspace:rw,${workspaceExecutable ? "exec" : "noexec"},nosuid,nodev,size=${workspace},${owner}`,
    `--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=67108864,${owner}`,
    `--tmpfs=/output:rw,noexec,nosuid,nodev,size=68157440,${owner}`
  ];
}
function dockerArguments(image, name, source, runner, network = "none", profile = "default", cache) {
  invariant(network === "none" || /^[a-z][a-z0-9_-]{2,63}$/.test(network) && !["host", "bridge", "default"].includes(network), "ISOLATION_UNAVAILABLE");
  return [
    ...boundedArguments(image, name, profile, true),
    "--network=" + network,
    "--mount",
    `type=bind,src=${path(source)},dst=/source,readonly`,
    "--mount",
    `type=bind,src=${path(runner)},dst=/runner,readonly`,
    ...cache ? ["--mount", `type=bind,src=${path(cache)},dst=/dependency-cache,readonly`] : [],
    "--interactive",
    image,
    "node",
    "/runner/dist/inside-container.js"
  ];
}
function dockerCacheArguments(image, name, seed, runner, cache, profile) {
  invariant(profile === "github-hosted", "ISOLATION_UNAVAILABLE");
  return [...boundedArguments(image, name, profile), "--network=bridge", "--mount", `type=bind,src=${path(seed)},dst=/seed,readonly`, "--mount", `type=bind,src=${path(runner)},dst=/runner,readonly`, "--mount", `type=bind,src=${path(cache)},dst=/dependency-cache`, image, "node", "/runner/dist/prepare-cache-container.js"];
}
async function confirmRemoved(docker, name) {
  await trustedProcess(docker, ["rm", "--force", "--volumes", name], { timeoutMs: 1e4, maxBytes: 8192 }).catch(() => {
  });
  try {
    const remaining = await trustedProcess(docker, ["container", "ls", "--all", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"], { timeoutMs: 1e4, maxBytes: 8192 });
    invariant(remaining.trim() === "", "ISOLATION_CLEANUP_UNCONFIRMED");
  } catch {
    throw new Error("ISOLATION_CLEANUP_UNCONFIRMED");
  }
}
function createDockerExecutor(options) {
  const runner = resolve3(fileURLToPath(new URL("..", import.meta.url))), docker = options.executable ?? "docker", profile = options.resourceProfile ?? "default";
  const diagnostic = (stage, code) => {
    if (profile === "github-hosted") process.stdout.write(diagnosticLine(stage, code) + "\n");
  };
  invariant(options.dependencyPreparation === void 0 || options.dependencyPreparation === "npm-registry" && profile === "github-hosted" && (options.network === void 0 || options.network === "none"), "ISOLATION_UNAVAILABLE");
  const verify = async (signal) => {
    try {
      containerIdentity();
      dockerArguments(options.image, "flora-verify", "/source", "/runner", options.network, profile);
      await trustedProcess(docker, ["version", "--format", "{{.Server.Version}}"], { ...signal ? { signal } : {}, timeoutMs: 1e4, maxBytes: 8192 });
    } catch {
      throw new Error("ISOLATION_UNAVAILABLE");
    }
  };
  return { verify, async execute(job, source, signal) {
    await verify(signal);
    const name = "flora-" + randomUUID(), helper = await mkdtemp(join5(tmpdir(), "flora-helper-"));
    await chmod(helper, 493);
    let launched = false, cache, preparation, stage = "dependency-seed";
    try {
      await mkdir3(join5(helper, "dist"), { mode: 493 });
      await mkdir3(join5(helper, "scripts"), { mode: 493 });
      await writeFile2(join5(helper, "package.json"), '{"type":"module"}', { mode: 292 });
      await mkdir3(join5(helper, "config"), { mode: 493 });
      for (const config of ["npm-user.rc", "npm-global.rc"]) await writeFile2(join5(helper, "config", config), "", { mode: 292 });
      for (const file of ["dist/artifacts.js", "dist/process.js", "dist/expo.js", "dist/inside-container.js", "dist/dependencies.js", "dist/prepare-cache-container.js", "scripts/metro-export.mjs"]) await writeFile2(join5(helper, file), await readBoundedFile(runner, file, 1024 * 1024), { mode: 292 });
      if (options.dependencyPreparation) {
        invariant(job.config.toolchain.nodeVersion === HOSTED_NODE_VERSION && job.config.toolchain.packageManager.name === "npm" && job.config.toolchain.packageManager.version === HOSTED_NPM_VERSION, "CONFIG_CHANGED");
        diagnostic(stage);
        preparation = await mkdtemp(join5(tmpdir(), "flora-dependencies-"));
        cache = join5(preparation, "cache");
        await mkdir3(cache, { mode: 448 });
        const seed = join5(preparation, "seed");
        await prepareNpmDependencySeed(source, job.rootDirectory, seed);
        stage = "dependency-preparation";
        diagnostic(stage);
        const seedName = "flora-seed-" + randomUUID();
        try {
          const result = await trustedProcess(docker, dockerCacheArguments(options.image, seedName, seed, helper, cache, profile), { signal, timeoutMs: 66e4, maxBytes: 2 * 1024 * 1024, diagnostics: "container" });
          invariant(result === "FLORA_DEPENDENCY_CACHE_READY\n", "DEPENDENCY_CACHE_INVALID");
        } finally {
          await confirmRemoved(docker, seedName);
        }
      }
      stage = "compiler";
      diagnostic(stage);
      const args = dockerArguments(options.image, name, source, helper, options.network, profile, cache);
      launched = true;
      const output = await trustedProcess(docker, args, { signal, timeoutMs: 9e5, maxBytes: 96 * 1024 * 1024, diagnostics: "container", input: JSON.stringify({ appId: job.appId, channel: job.channel, platform: job.platform, commitSha: job.commitSha, rootDirectory: job.rootDirectory, config: job.config, dependencyCache: !!cache, offline: !!cache || (options.network ?? "none") === "none" }) });
      const exported = decodeExport(output, { platform: job.platform, runtimeVersion: job.runtimeVersion, commitSha: job.commitSha });
      diagnostic("artifact-verified");
      return exported;
    } catch (error) {
      const child = error instanceof ProcessFailure ? error.containerDiagnostic : void 0;
      diagnostic(child ? stage + "-" + child.stage : stage, child?.code ?? diagnosticCode(error));
      const code = error instanceof Error ? error.message : "EXPORT_FAILED";
      throw new Error(["ARTIFACT_INVALID", "CONFIG_CHANGED", "ISOLATION_CLEANUP_UNCONFIRMED"].includes(code) ? code : "EXPORT_FAILED");
    } finally {
      try {
        if (launched) await confirmRemoved(docker, name);
      } finally {
        await rm(helper, { recursive: true, force: true });
        if (preparation) await rm(preparation, { recursive: true, force: true });
      }
    }
  } };
}

// packages/ota-runner/src/config.ts
async function readRunnerConfig(path2) {
  try {
    const stat = await lstat3(path2);
    invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 16384 && (stat.mode & 63) === 0 && (!process.getuid || stat.uid === process.getuid()));
    const file = await open3(path2, constants3.O_RDONLY | constants3.O_NOFOLLOW);
    let raw;
    try {
      const current = await file.stat();
      invariant(current.ino === stat.ino && current.dev === stat.dev && current.size <= 16384 && current.nlink === 1 && (current.mode & 63) === 0 && (!process.getuid || current.uid === process.getuid()));
      raw = JSON.parse(await file.readFile("utf8"));
    } finally {
      await file.close();
    }
    invariant(raw && typeof raw === "object" && !Array.isArray(raw));
    const value = raw;
    invariant(Object.keys(value).every((key) => ["origin", "token", "dockerImage", "dockerNetwork", "resourceProfile", "dependencyPreparation", "publicationRecovery", "workDirectory", "recoveryDirectory"].includes(key)) && typeof value.origin === "string" && typeof value.token === "string" && typeof value.dockerImage === "string");
    invariant(value.resourceProfile === void 0 || value.resourceProfile === "default" || value.resourceProfile === "github-hosted");
    invariant(value.dependencyPreparation === void 0 || value.dependencyPreparation === "npm-registry" && value.resourceProfile === "github-hosted" && (value.dockerNetwork === void 0 || value.dockerNetwork === "none"));
    invariant(value.publicationRecovery === void 0 || value.publicationRecovery === "remote-checkpoint" && value.resourceProfile === "github-hosted");
    invariant(value.dockerNetwork === void 0 || typeof value.dockerNetwork === "string");
    invariant(value.workDirectory === void 0 || typeof value.workDirectory === "string" && isAbsolute3(value.workDirectory) && !/[\r\n,]/.test(value.workDirectory));
    invariant(value.recoveryDirectory === void 0 || typeof value.recoveryDirectory === "string" && isAbsolute3(value.recoveryDirectory) && !/[\r\n,]/.test(value.recoveryDirectory));
    createRunnerClient({ origin: value.origin, token: value.token });
    dockerArguments(value.dockerImage, "flora-config", "/source", "/runner", value.dockerNetwork, value.resourceProfile);
    return value;
  } catch {
    throw new Error("INVALID_RUNNER_CONFIG");
  }
}

// packages/ota-runner/src/source.ts
import { lstat as lstat4, open as open4, realpath as realpath4, readdir as readdir2 } from "node:fs/promises";
import { constants as constants4 } from "node:fs";
import { join as join6, sep as sep3 } from "node:path";
var gitEnvironment = () => processEnvironment({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" });
var gitFlags = ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never", "-c", "core.autocrlf=false", "-c", "http.followRedirects=false"];
async function git(root, args, signal, env = gitEnvironment()) {
  return trustedProcess("git", [...gitFlags, ...args], { cwd: root, env, signal, timeoutMs: 3e5, maxBytes: 2 * 1024 * 1024 });
}
async function withGitObjectBudget(directory, maxBytes, signal, download) {
  const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
  let checking = null, exceeded = false;
  async function check() {
    let bytes = 0, count = 0;
    async function walk(path2) {
      let entries;
      try {
        entries = await readdir2(path2, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        invariant(++count <= 12e3, "SOURCE_UNAVAILABLE");
        const next = join6(path2, entry.name);
        let stat;
        try {
          stat = await lstat4(next);
        } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        invariant(!stat.isSymbolicLink(), "SOURCE_UNAVAILABLE");
        if (stat.isDirectory()) await walk(next);
        else {
          invariant(stat.isFile(), "SOURCE_UNAVAILABLE");
          bytes += stat.size;
          invariant(bytes <= maxBytes, "SOURCE_UNAVAILABLE");
        }
      }
    }
    await walk(join6(directory, ".git/objects"));
  }
  const tick = () => {
    if (checking) return;
    checking = check().catch(() => {
      exceeded = true;
      controller.abort();
    }).finally(() => {
      checking = null;
    });
  };
  await check();
  const timer = setInterval(tick, 100);
  try {
    await download(combined);
    await checking;
    await check();
    invariant(!exceeded, "SOURCE_UNAVAILABLE");
  } catch {
    throw new Error("SOURCE_UNAVAILABLE");
  } finally {
    clearInterval(timer);
    await checking;
  }
}
async function verifySourceCheckout(job, directory, signal) {
  try {
    invariant(/^[a-f0-9]{40}$/.test(job.commitSha));
    invariant((await git(directory, ["rev-parse", "HEAD"], signal)).trim() === job.commitSha);
    invariant((await git(directory, ["status", "--porcelain=v1", "--untracked-files=all"], signal)).trim() === "");
    const paths = (await git(directory, ["ls-files", "-z"], signal)).split("\0").filter(Boolean).sort();
    invariant(paths.length > 0 && paths.length <= 1e4);
    const base = await realpath4(directory), records = [];
    let size = 0;
    for (const input of paths) {
      const path2 = relativePath(input);
      let cursor = base;
      for (const part of path2.split("/")) {
        cursor = join6(cursor, part);
        invariant(!(await lstat4(cursor)).isSymbolicLink());
      }
      const file = await open4(cursor, constants4.O_RDONLY | constants4.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        invariant(stat.isFile() && stat.nlink === 1 && stat.size <= 64 * 1024 * 1024);
        size += stat.size;
        invariant(size <= 64 * 1024 * 1024);
        const bytes = await file.readFile();
        invariant(bytes.length === stat.size);
        records.push([path2, bytes.length, sha256(bytes)]);
      } finally {
        await file.close();
      }
    }
    const relative = job.rootDirectory === "." ? "" : relativePath(job.rootDirectory), root = await realpath4(join6(base, relative));
    invariant(root === base || root.startsWith(base + sep3));
    const config = await readBoundedFile(root, "flora.config.json", 131072);
    invariant(await automationDigest(parseFloraConfig(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(config)))) === await automationDigest(job.config), "CONFIG_CHANGED");
    await readBoundedFile(root, job.config.entryFile, 2 * 1024 * 1024);
    return { root, sourceDigest: sha256(JSON.stringify(records)) };
  } catch (error) {
    throw new Error(error instanceof Error && error.message === "CONFIG_CHANGED" ? "CONFIG_CHANGED" : "SOURCE_UNAVAILABLE");
  }
}
function createGitHubSourceProvider(options = {}) {
  const request = options.fetch ?? fetch;
  return { async checkout(job, grant, directory, signal) {
    try {
      invariant(grant.commitSha === job.commitSha && grant.expiresAt > Date.now() && grant.maxBytes > 0 && grant.maxBytes <= 64 * 1024 * 1024 && isGitHubInstallationToken(grant.token));
      const { owner, repository } = job.connection;
      invariant(/^[A-Za-z0-9-]{1,39}$/.test(owner) && /^[A-Za-z0-9_.-]{1,100}$/.test(repository) && ![".", ".."].includes(repository));
      const base = `https://api.github.com/repos/${owner}/${repository}`;
      invariant(grant.url === base + "/tarball/" + job.commitSha);
      const response = await request(base + "/git/trees/" + job.commitSha + "?recursive=1", { redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(1e4)]), headers: { Authorization: "Bearer " + grant.token, Accept: "application/vnd.github+json", "User-Agent": "flora-ota-runner", "X-GitHub-Api-Version": "2022-11-28" } });
      invariant(response.status === 200 && response.body);
      const reader = response.body.getReader(), chunks = [];
      let count = 0;
      try {
        for (; ; ) {
          const part = await reader.read();
          if (part.done) break;
          count += part.value.length;
          invariant(count <= 2 * 1024 * 1024);
          chunks.push(part.value);
        }
      } finally {
        void reader.cancel().catch(() => {
        });
      }
      const tree = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      invariant(tree.truncated === false && Array.isArray(tree.tree) && tree.tree.length <= 1e4);
      let bytes = 0;
      for (const item of tree.tree) {
        invariant(item.type !== "commit" && item.mode !== "120000");
        if (item.type === "blob") {
          invariant(typeof item.size === "number" && Number.isSafeInteger(item.size) && item.size >= 0);
          bytes += item.size;
          invariant(bytes <= grant.maxBytes);
        }
      }
      await git(directory, ["init", "--quiet"], signal);
      const environment = { ...gitEnvironment(), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: "AUTHORIZATION: basic " + Buffer.from("x-access-token:" + grant.token).toString("base64") };
      await withGitObjectBudget(directory, grant.maxBytes + 8 * 1024 * 1024, signal, async (fetchSignal) => {
        await git(directory, ["fetch", "--depth=1", "--no-tags", `https://github.com/${owner}/${repository}.git`, job.commitSha], fetchSignal, environment);
      });
      await git(directory, ["checkout", "--detach", "--force", "FETCH_HEAD"], signal);
      return { directory, ...await verifySourceCheckout(job, directory, signal) };
    } catch (error) {
      throw new Error(error instanceof Error && error.message === "CONFIG_CHANGED" ? "CONFIG_CHANGED" : "SOURCE_UNAVAILABLE");
    }
  } };
}

// packages/ota-runner/src/main.ts
import { dirname as dirname3, join as join8, resolve as resolve4 } from "node:path";

// packages/ota-runner/src/daemon.ts
import { mkdtemp as mkdtemp2, mkdir as mkdir4, rm as rm2, realpath as realpath5 } from "node:fs/promises";
import { tmpdir as tmpdir2 } from "node:os";
import { join as join7, sep as sep4 } from "node:path";
async function runOne(options) {
  if (options.remoteCheckpoint) invariant(options.recoveryDirectory && options.client.identity && options.client.saveCheckpoint && options.client.listCheckpoints && options.client.clearCheckpoint, "INVALID_RUNNER_CONFIG");
  const claim = await options.client.claim();
  if (!claim) return { state: "empty" };
  const { job } = claim;
  let lease = claim.lease, done = false, heartbeat = null, finalizing = false, heartbeatStopped = false;
  const controller = new AbortController(), abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, 18 * 60 * 1e3), same = (a, b) => ["jobId", "appId", "attemptId", "runnerId", "credentialEpoch", "fence"].every((key) => a[key] === b[key]);
  const timer = setInterval(() => {
    if (done || heartbeatStopped || heartbeat) return;
    heartbeat = options.client.heartbeat(lease).then((next) => {
      invariant(same(lease, next) && next.expiresAt > Date.now(), "LEASE_EXPIRED");
      lease = next;
    }).catch(() => {
      if (!done) controller.abort();
    }).finally(() => {
      heartbeat = null;
    });
  }, options.heartbeatMs ?? 3e4);
  let directory, journalPath, record;
  try {
    const work = options.workDirectory ?? tmpdir2();
    await mkdir4(work, { recursive: true });
    directory = await mkdtemp2(join7(work, "flora-claim-"));
    const grant = await options.client.source(lease), checkout = await options.source.checkout(job, grant, directory, controller.signal);
    if (options.diagnostics) process.stdout.write(diagnosticLine("source-verified") + "\n");
    invariant(!controller.signal.aborted, "CANCELLED");
    const exported = await options.executor.execute(job, checkout.directory, controller.signal);
    invariant(exported.commitSha === job.commitSha && exported.platform === job.platform && exported.runtimeVersion === job.runtimeVersion, "ARTIFACT_INVALID");
    const uploaded = [];
    for (const asset of [exported.launchAsset, ...exported.assets]) {
      const uploadLease = lease, metadata = { key: asset.key, contentType: asset.contentType, fileExtension: asset.fileExtension };
      let saved;
      for (let attempt = 0; attempt < 3; attempt++) {
        invariant(!controller.signal.aborted, "CANCELLED");
        invariant(uploadLease.expiresAt - Date.now() >= 2e4, "LEASE_EXPIRED");
        invariant(sha256(asset.bytes) === asset.digest, "ARTIFACT_INVALID");
        try {
          saved = parseOTAAsset(await options.client.uploadAsset(uploadLease, metadata, asset.bytes));
          break;
        } catch (error) {
          if (!transient(error) || attempt === 2 || uploadLease.expiresAt - Date.now() < 2e4) throw error;
          await pause(250 * (attempt + 1), controller.signal);
        }
      }
      invariant(saved && saved.appId === job.appId && saved.digest === asset.digest && saved.size === asset.bytes.length && saved.key === asset.key, "ARTIFACT_INVALID");
      uploaded.push(saved);
    }
    const core = { jobId: job.id, attemptId: lease.attemptId, commitSha: job.commitSha, configDigest: job.configDigest, toolchainDigest: job.toolchainDigest, sourceArchiveDigest: checkout.sourceDigest, launchAssetId: uploaded[0].id, assetIds: uploaded.slice(1).map((asset) => asset.id) };
    const artifactDigest = await automationDigest(automationArtifactPayload(core, uploaded));
    heartbeatStopped = true;
    clearInterval(timer);
    await heartbeat;
    invariant(!controller.signal.aborted, "CANCELLED");
    const fresh = await options.client.heartbeat(lease);
    invariant(same(lease, fresh) && fresh.expiresAt - Date.now() >= 35e3, "LEASE_EXPIRED");
    lease = fresh;
    invariant(!controller.signal.aborted, "CANCELLED");
    const receipt = { ...core, artifactDigest };
    if (options.recoveryDirectory) {
      invariant(options.client.identity && options.client.identity.runnerId === lease.runnerId, "INVALID_RUNNER_CONFIG");
      record = { schemaVersion: 1, origin: options.client.identity.origin, lease, receipt };
      journalPath = await writeRecoveryJournal(options.recoveryDirectory, record);
    }
    const recoveryInsideCheckout = journalPath && [await realpath5(directory), await realpath5(checkout.directory)].some((root) => journalPath.startsWith(root + sep4));
    if (controller.signal.aborted || recoveryInsideCheckout) {
      if (journalPath && record) {
        try {
          await clearRecoveryJournal(journalPath, record);
        } catch {
          throw new Error("RECOVERY_CLEANUP_UNCONFIRMED");
        }
        journalPath = void 0;
        record = void 0;
      }
      throw new Error(recoveryInsideCheckout ? "INVALID_RUNNER_CONFIG" : "CANCELLED");
    }
    if (options.remoteCheckpoint) {
      try {
        await options.client.saveCheckpoint(record);
      } catch {
        throw new Error("RECOVERY_CHECKPOINT_UNAVAILABLE");
      }
      invariant(lease.expiresAt - Date.now() >= 35e3, "LEASE_EXPIRED");
      invariant(!controller.signal.aborted, "CANCELLED");
    }
    finalizing = true;
    for (let attempt = 0; attempt < 3; attempt++) {
      invariant(!controller.signal.aborted, "CANCELLED");
      try {
        const result = await options.client.finalize(lease, receipt);
        if (record) {
          assertPublicationResult(result, record);
          await clearRecoveryJournal(journalPath, record);
          if (options.remoteCheckpoint) await clearRemoteCheckpoint(options.client, record);
        }
        done = true;
        return { state: "succeeded", jobId: job.id };
      } catch (error) {
        if (!transient(error) || attempt === 2 || lease.expiresAt - Date.now() < 11e3) throw error;
        await pause(250 * (attempt + 1));
      }
    }
    throw new Error("PUBLICATION_RESULT_UNCONFIRMED");
  } catch (error) {
    if (error instanceof Error && ["ISOLATION_CLEANUP_UNCONFIRMED", "RECOVERY_JOURNAL_UNAVAILABLE", "RECOVERY_CLEANUP_UNCONFIRMED", "RECOVERY_CHECKPOINT_UNAVAILABLE", "INVALID_RUNNER_CONFIG"].includes(error.message)) throw error;
    if (finalizing && (journalPath || !(error instanceof RunnerHttpFailure) || transient(error))) return { state: "publication_unknown", jobId: job.id, code: "PUBLICATION_REJECTED", ...journalPath ? { recoveryJournal: journalPath } : {} };
    if (error instanceof RunnerHttpFailure && [401, 403, 409].includes(error.status)) throw error;
    const message = error instanceof Error ? error.message : "EXPORT_FAILED", allowed = ["EXPORT_FAILED", "SOURCE_UNAVAILABLE", "CONFIG_CHANGED", "ARTIFACT_INVALID", "CANCELLED", "LEASE_EXPIRED", "RUNNER_REVOKED"];
    const code = controller.signal.aborted ? "CANCELLED" : allowed.includes(message) ? message : finalizing ? "PUBLICATION_REJECTED" : "EXPORT_FAILED";
    await options.client.fail(lease, code).catch(() => {
    });
    return { state: controller.signal.aborted ? "interrupted" : "failed", jobId: job.id, code };
  } finally {
    done = true;
    clearTimeout(timeout);
    clearInterval(timer);
    options.signal?.removeEventListener("abort", abort);
    await heartbeat;
    if (directory) await rm2(directory, { recursive: true, force: true });
  }
}
function transient(error) {
  return error instanceof RunnerHttpFailure && (error.status === 0 || error.status >= 500);
}
async function pause(ms, signal) {
  if (signal?.aborted) return;
  await new Promise((resolve5) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve5();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}
async function runDaemon(options) {
  let claimFailures = 0;
  while (!options.signal?.aborted) {
    let result;
    try {
      result = await runOne(options);
      claimFailures = 0;
    } catch (error) {
      if (!transient(error) || ++claimFailures >= 3) throw error;
      await pause(250 * claimFailures, options.signal);
      continue;
    }
    options.onOutcome?.(result);
    if (result.state === "publication_unknown") throw new Error("PUBLICATION_RECONCILIATION_REQUIRED");
    if (result.state === "empty") await pause(options.pollMs ?? 5e3, options.signal);
  }
}

// packages/ota-runner/src/main.ts
async function main() {
  const args = process.argv.slice(2), once = args.includes("--once"), index = args.indexOf("--config"), reconcile = args.indexOf("--reconcile");
  if (index < 0 || !args[index + 1] || reconcile >= 0 && (once || !args[reconcile + 1]) || args.length !== (reconcile >= 0 ? 4 : once ? 3 : 2) || args.some((arg, i) => i !== index + 1 && i !== (reconcile >= 0 ? reconcile + 1 : -1) && !["--config", "--once", "--reconcile"].includes(arg))) {
    process.stderr.write("Usage: flora-ota-runner --config /absolute/private/runner.json [--once | --reconcile /absolute/private/recovery.json]\n");
    process.exitCode = 2;
    return;
  }
  const config = await readRunnerConfig(args[index + 1]);
  const controller = new AbortController(), stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const client = createRunnerClient(config);
    if (reconcile >= 0) {
      const result = await reconcilePublication(client, resolve4(args[reconcile + 1]), config.publicationRecovery === "remote-checkpoint");
      process.stdout.write(JSON.stringify({ state: "succeeded", jobId: result.job.id, deploymentId: result.deployment.id }) + "\n");
      return;
    }
    const recoveryDirectory = config.recoveryDirectory ?? join8(dirname3(resolve4(args[index + 1])), "recovery"), pending = await pendingRecoveryJournals(recoveryDirectory);
    if (config.publicationRecovery === "remote-checkpoint") await reconcileRemotePublications(client, recoveryDirectory);
    else if (pending.length) {
      process.stdout.write(JSON.stringify({ state: "publication_unknown", recoveryJournal: pending[0] }) + "\n");
      throw new Error("PUBLICATION_RECONCILIATION_REQUIRED");
    }
    const executor = createDockerExecutor({ image: config.dockerImage, ...config.dockerNetwork ? { network: config.dockerNetwork } : {}, ...config.resourceProfile ? { resourceProfile: config.resourceProfile } : {}, ...config.dependencyPreparation ? { dependencyPreparation: config.dependencyPreparation } : {} });
    await executor.verify(controller.signal);
    const options = { client, recoveryDirectory, source: createGitHubSourceProvider(), executor, signal: controller.signal, ...config.workDirectory ? { workDirectory: config.workDirectory } : {}, ...config.publicationRecovery === "remote-checkpoint" ? { remoteCheckpoint: true } : {}, ...config.resourceProfile === "github-hosted" ? { diagnostics: true } : {} };
    if (once) {
      const result = await runOne(options);
      process.stdout.write(JSON.stringify(result) + "\n");
      if (!["empty", "succeeded"].includes(result.state)) process.exitCode = 1;
    } else await runDaemon({ ...options, onOutcome: (result) => process.stdout.write(JSON.stringify(result) + "\n") });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
void main().catch((error) => {
  const code = error instanceof RunnerHttpFailure ? error.message : error instanceof Error && ["INVALID_RUNNER_CONFIG", "ISOLATION_UNAVAILABLE", "ISOLATION_CLEANUP_UNCONFIRMED", "PUBLICATION_RECONCILIATION_REQUIRED", "INVALID_RECOVERY_JOURNAL", "RECOVERY_JOURNAL_UNAVAILABLE", "RECOVERY_CLEANUP_UNCONFIRMED", "RECOVERY_CHECKPOINT_UNAVAILABLE", "PUBLICATION_RESULT_UNCONFIRMED"].includes(error.message) ? error.message : "RUNNER_STOPPED";
  process.stderr.write(code + "\n");
  process.exitCode = 1;
});
