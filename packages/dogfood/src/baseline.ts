import { DomainError, ensure, object, safeJson, text, integer, digest } from "@app-ops/core";
import { freeze } from "@app-ops/config";
import { CONFIG_RUNTIME_SMOKE_V1 } from "./profile.js";
import { normalizeReportTestPath, validateReportMetadata } from "./report-path.js";
import type { BaselineBundleV1, BaselineEvidence, InventorySnapshot, ReportAssessment, VerificationProfile } from "./types.js";

const MAX_BUNDLE = 2 * 1024 * 1024;
const MAX_REPORT = 1024 * 1024;
const parsedEvidence = new WeakSet<BaselineEvidence>();
function json(bytes: Uint8Array): unknown {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    safeJson(value); return value;
  } catch { throw new DomainError("INVALID_INPUT"); }
}
function record(value: unknown): Record<string, unknown> {
  ensure(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function date(value: unknown): bigint {
  const result = text(value, 64);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(result);
  ensure(match);
  const whole = Date.parse(match[1]! + match[3]!);
  ensure(Number.isFinite(whole) && whole >= 946684800000 && whole <= 4133980799999);
  // Date.parse otherwise silently normalizes impossible calendar dates.
  const local = Date.parse(match[1]! + "Z");
  ensure(Number.isFinite(local) && new Date(local).toISOString().slice(0, 19) === match[1]);
  return BigInt(whole) * 1_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"));
}

async function sha(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hashed = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hashed), byte => byte.toString(16).padStart(2, "0")).join("");
}
function reportBytes(value: unknown): Uint8Array<ArrayBuffer> {
  ensure(typeof value === "string" && value.length <= Math.ceil(MAX_REPORT / 3) * 4);
  ensure(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value));
  const binary = atob(value);
  ensure(btoa(binary) === value && binary.length <= MAX_REPORT);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
function hashes(value: unknown, snapshot: InventorySnapshot): Record<string, string> {
  const map = object(value, snapshot.files.map(file => file.path));
  ensure(snapshot.files.length > 0);
  for (const file of snapshot.files) ensure(digest(map[file.path]) === file.sha256);
  return map as Record<string, string>;
}
/** Keep every snapshot-dependent parser condition shared with prepared storage. */
function assertSnapshotBinding(evidence: Pick<BaselineBundleV1,
  "sourceDigest" | "commitSha" | "profileId" | "runtime" | "sourceHashesBefore" | "sourceHashesAfter"
>, snapshot: InventorySnapshot): void {
  ensure(evidence.sourceDigest === snapshot.digest && evidence.commitSha === snapshot.commitSha && evidence.profileId === CONFIG_RUNTIME_SMOKE_V1.id);
  ensure(evidence.runtime.vitest === snapshot.runtime.versions.vitest?.value && evidence.runtime.vite === snapshot.runtime.versions.vite?.value);
  hashes(evidence.sourceHashesBefore, snapshot); hashes(evidence.sourceHashesAfter, snapshot);
}
function sanitizeLog(value: unknown): { safeLog: string; logTruncated: boolean } {
  ensure(typeof value === "string");
  // Strip complete terminal CSI/OSC sequences, then remaining C0/C1 controls.
  const safe = value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
  const bytes = new TextEncoder().encode(safe);
  let end = Math.min(bytes.length, 65536);
  if (end < bytes.length) while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { safeLog: new TextDecoder().decode(bytes.slice(0, end)), logTruncated: bytes.length > end };
}

/** Strict internal-consistency parsing, never execution or isolation attestation. */
export async function parseBaselineBundle(bytes: Uint8Array, snapshot: InventorySnapshot): Promise<BaselineEvidence> {
  ensure(bytes instanceof Uint8Array && bytes.length <= MAX_BUNDLE);
  const owned = Uint8Array.from(bytes); // Own bytes before the first asynchronous boundary.
  const b = object(json(owned), ["schemaVersion", "sourceDigest", "commitSha", "profileId", "attemptKey", "platform", "architecture", "sourceRoot", "reportPath", "argv", "runtime", "startedAt", "finishedAt", "durationMs", "exitCode", "reportBase64", "reportSha256", "sourceHashesBefore", "sourceHashesAfter", "log"]);
  ensure(b.schemaVersion === 1);
  digest(b.sourceDigest); text(b.attemptKey, 256);
  ensure(b.platform === "linux" || b.platform === "darwin" || b.platform === "win32");
  ensure(b.architecture === "x64" || b.architecture === "arm64");
  validateReportMetadata(b.platform, text(b.sourceRoot), text(b.reportPath));
  ensure(Array.isArray(b.argv) && b.argv.length === CONFIG_RUNTIME_SMOKE_V1.argv.length);
  const argv = b.argv;
  ensure(argv.every((arg, i) => arg === (i === argv.length - 1 ? "--outputFile=" + b.reportPath : CONFIG_RUNTIME_SMOKE_V1.argv[i])));
  const runtime = object(b.runtime, ["node", "npm", "vitest", "vite"]);
  ensure(runtime.node === "24.19.0");
  ensure(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(text(runtime.npm, 128)));
  const start = date(b.startedAt), end = date(b.finishedAt);
  ensure(start <= end && typeof b.durationMs === "number" && Number.isFinite(b.durationMs) && b.durationMs >= 0 && Math.abs(b.durationMs - Number(end - start) / 1_000_000) <= 1000);
  ensure(b.exitCode === null || (typeof b.exitCode === "number" && Number.isSafeInteger(b.exitCode) && b.exitCode >= 0 && b.exitCode <= 255));
  assertSnapshotBinding(b as unknown as BaselineBundleV1, snapshot);
  const decoded = reportBytes(b.reportBase64), reportDigest = digest(b.reportSha256);
  const log = sanitizeLog(b.log);
  // All values have been copied/validated before any await.
  ensure(await sha(decoded) === reportDigest);
  let report: unknown = null;
  try { report = json(decoded); } catch (error) { if (!(error instanceof DomainError)) throw error; }
  const evidence = freeze({ ...(b as unknown as BaselineBundleV1), log: log.safeLog, ...log, report, evidenceDigest: await sha(owned) });
  parsedEvidence.add(evidence);
  return evidence;
}

/** Internal prepared-data guard. Only immutable output of the parser is accepted. */
export function assertParsedBaseline(evidence: BaselineEvidence, snapshot: InventorySnapshot): void {
  ensure(parsedEvidence.has(evidence));
  assertSnapshotBinding(evidence, snapshot);
}

export function assessReport(evidence: BaselineEvidence, profile: VerificationProfile): ReportAssessment {
  const result: ReportAssessment = { status: "invalid", code: "INVALID_REPORT", files: 0, tests: 0, passed: 0, failed: 0, skipped: 0, reportDigest: evidence.reportSha256 };
  try {
    ensure(evidence.profileId === profile.id && profile.id === CONFIG_RUNTIME_SMOKE_V1.id);
    safeJson(evidence.report);
    const report = record(evidence.report);
    ensure(Array.isArray(report.testResults) && report.testResults.length === profile.files.length);
    ensure(typeof report.success === "boolean");
    const start = Date.parse(evidence.startedAt), end = Date.parse(evidence.finishedAt);
    const time = (value: unknown): number => {
      ensure(typeof value === "number" && Number.isFinite(value) && value >= start - 1000 && value <= end + 1000); return value;
    };
    time(report.startTime);
    const seen = new Set<string>(); let failedFiles = 0;
    for (const input of report.testResults) {
      const file = record(input);
      const path = normalizeReportTestPath({ platform: evidence.platform, sourceRoot: evidence.sourceRoot, name: text(file.name), expectedFiles: profile.files });
      ensure(!seen.has(path)); seen.add(path); result.files++;
      ensure(time(file.startTime) <= time(file.endTime));
      ensure(Array.isArray(file.assertionResults) && file.assertionResults.length === profile.expectedTestsPerFile);
      const names = new Set<string>(); let failures = 0, skipped = 0;
      for (const item of file.assertionResults) {
        const assertion = record(item);
        const name = text(assertion.fullName); text(assertion.title);
        ensure(!names.has(name)); names.add(name);
        ensure(Array.isArray(assertion.ancestorTitles) && assertion.ancestorTitles.every(v => typeof v === "string"));
        ensure([...assertion.ancestorTitles, assertion.title].join(" ") === name);
        ensure(Array.isArray(assertion.failureMessages));
        ensure(typeof assertion.status === "string");
        result.tests++;
        if (assertion.status === "passed") { ensure(assertion.failureMessages.length === 0); result.passed++; }
        else if (assertion.status === "failed") { failures++; result.failed++; }
        else if (["skipped", "skip", "pending", "todo", "disabled"].includes(assertion.status)) { skipped++; result.skipped++; }
        else ensure(false);
      }
      ensure(file.status === (failures > 0 ? "failed" : "passed"));
      if (failures) failedFiles++;
      ensure(skipped === 0);
    }
    ensure(result.tests === profile.expectedTests);
    ensure(integer(report.numTotalTests) === result.tests && integer(report.numPassedTests) === result.passed && integer(report.numFailedTests) === result.failed);
    ensure(integer(report.numPendingTests) === 0 && integer(report.numTodoTests) === 0);
    const suites = integer(report.numTotalTestSuites, result.files);
    const failedSuites = integer(report.numFailedTestSuites);
    ensure(integer(report.numPendingTestSuites) === 0 && integer(report.numPassedTestSuites) + failedSuites === suites);
    ensure((failedSuites === 0) === (failedFiles === 0) && failedSuites >= failedFiles);
    ensure(report.success === (result.failed === 0));
    if (evidence.exitCode === null) { result.code = "EXIT_UNCONFIRMED"; return result; }
    if (evidence.exitCode !== 0 || result.failed > 0) { result.status = "failed"; result.code = "TESTS_FAILED"; return result; }
    result.status = "passed"; result.code = "PASSED";
  } catch (error) { if (!(error instanceof DomainError)) throw error; }
  return result;
}
