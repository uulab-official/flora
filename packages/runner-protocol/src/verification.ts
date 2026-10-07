import type { BaselineEvidence, InventorySnapshot, VerificationFence, VerificationProfile } from "@app-ops/dogfood";
import type { RunnerCapability } from "./schema.js";

export const VERIFICATION_CHECKS = Object.freeze([
  "toolchain", "filesystem", "network", "cpu", "resources", "processTreeCancel", "outputBoundary", "cleanup",
] as const);
export interface ExecutionRequirements {
  os: readonly ("linux" | "darwin" | "win32")[];
  capabilities: readonly RunnerCapability[];
  nodeVersion: string;
  isolationRequired: true;
  limits: {
    timeoutMs: 30000; cpuCores: 1; cpuTimeMs: 30000; memoryMiB: 512;
    pids: 64; diskMiB: 512; reportBytes: 1048576; logBytes: 65536;
  };
}
export interface CapabilityReport {
  providerId: string;
  os: "linux" | "darwin" | "win32" | null;
  checks: Record<(typeof VERIFICATION_CHECKS)[number], "passed" | "failed" | "unknown">;
  capabilities: readonly RunnerCapability[];
  reasons: string[];
}
export interface CleanupReport {
  processTreeStopped: boolean;
  workspaceRemoved: boolean;
  outputBoundaryEnforced: boolean;
}
export interface RunInput {
  snapshot: InventorySnapshot;
  profile: VerificationProfile;
  fence: VerificationFence;
  requirements: ExecutionRequirements;
}
export interface ProviderResult { evidence: BaselineEvidence; cleanup: CleanupReport }

/**
 * Server-registered capability boundary; never selected from imported/browser JSON.
 * Preflight attests these exact requirements, including both CPU quota and cumulative
 * CPU time enforcement. Matching Node, memory or PID limits proves no isolation.
 * A future adapter must reverify source bytes against snapshot digests before use,
 * enforce every limit, and return the immutable parseBaselineBundle result itself.
 * This contract provides neither a source downloader nor a real execution adapter.
 */
export interface VerificationProvider {
  id: string;
  preflight(requirements: ExecutionRequirements): Promise<CapabilityReport>;
  run(input: RunInput, signal: AbortSignal): Promise<ProviderResult>;
  cancel(attemptId: string): Promise<CleanupReport>;
}

/** Reports must come directly from the server's registered provider instances. */
export function selectProvider(requirements: ExecutionRequirements, reports: readonly CapabilityReport[]): { providerId: string | null; reasons: string[] } {
  const reasons: string[] = [];
  for (const report of reports) {
    const missing: string[] = [];
    if (report.os === null || !requirements.os.includes(report.os)) missing.push("required execution OS is unavailable");
    for (const capability of requirements.capabilities) {
      if (!report.capabilities.includes(capability)) missing.push(`required capability ${capability} is unavailable`);
    }
    for (const check of VERIFICATION_CHECKS) {
      if (report.checks[check] !== "passed") missing.push(`${check} is ${report.checks[check] ?? "unknown"}`);
    }
    if (missing.length === 0) return { providerId: report.providerId, reasons: [] };
    reasons.push(...missing.map(reason => `${report.providerId}: ${reason}`), ...report.reasons);
  }
  return { providerId: null, reasons: reasons.length ? reasons : ["No verified execution provider is registered"] };
}
