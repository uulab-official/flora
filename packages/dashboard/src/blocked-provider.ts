import { DomainError } from "@app-ops/core";
import type { VerificationProvider } from "@app-ops/runner-protocol";

/** The only product provider. It never runs source or falls back to a subprocess. */
export function createBlockedProvider(): VerificationProvider {
  const id = "unconfigured-isolated-runner";
  return {
    id,
    preflight: async requirements => ({
      providerId: id, os: null, capabilities: [],
      checks: { toolchain: "unknown", filesystem: "unknown", network: "unknown", cpu: "unknown",
        resources: "unknown", processTreeCancel: "unknown", outputBoundary: "unknown", cleanup: "unknown" },
      reasons: [
        "No verified isolated execution environment is configured",
        `toolchain: verify Node ${requirements.nodeVersion} and the required execution OS and SDKs`,
        "filesystem: verify isolated source and workspace boundaries",
        "network: verify execution network isolation",
        `cpu: verify ${requirements.limits.cpuCores} core quota and ${requirements.limits.cpuTimeMs}ms cumulative CPU time enforcement`,
        `resources: verify ${requirements.limits.memoryMiB}MiB memory, ${requirements.limits.pids} PIDs and ${requirements.limits.diskMiB}MiB disk limits`,
        "processTreeCancel: verify termination of the entire execution tree",
        `outputBoundary: verify ${requirements.limits.reportBytes} report bytes and ${requirements.limits.logBytes} log bytes`,
        "cleanup: verify workspace removal and confirmed execution termination",
      ],
    }),
    run: async () => { throw new DomainError("PROVIDER_UNSUPPORTED"); },
    cancel: async () => ({ processTreeStopped: false, workspaceRemoved: false, outputBoundaryEnforced: false }),
  };
}
