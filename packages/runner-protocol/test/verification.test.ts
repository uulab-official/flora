import test from "node:test";
import assert from "node:assert/strict";
import * as protocol from "@app-ops/runner-protocol";
import type { CapabilityReport, ExecutionRequirements } from "@app-ops/runner-protocol";
import { verifiedSyntheticCapabilities } from "../../../tests/dogfood-fixtures.ts";

const requirements: ExecutionRequirements = {
  os: ["linux", "darwin", "win32"], capabilities: ["node"], nodeVersion: "24.19.0", isolationRequired: true,
  limits: { timeoutMs: 30000, cpuCores: 1, cpuTimeMs: 30000, memoryMiB: 512, pids: 64, diskMiB: 512, reportBytes: 1048576, logBytes: 65536 },
};

test("blocks without a fully verified provider", () => {
  assert.equal(typeof protocol.selectProvider, "function");
  const verified = verifiedSyntheticCapabilities();
  assert.deepEqual(protocol.selectProvider(requirements, [verified]), { providerId: verified.providerId, reasons: [] });
  assert.equal(protocol.selectProvider(requirements, []).providerId, null);
  for (const check of Object.keys(verified.checks) as (keyof CapabilityReport["checks"])[]) {
    for (const value of ["failed", "unknown"] as const) {
      const selection = protocol.selectProvider(requirements, [{ ...verified, checks: { ...verified.checks, [check]: value } }]);
      assert.equal(selection.providerId, null, `${check} ${value}`);
      assert.ok(selection.reasons.some(reason => reason.includes(check)), `${check} reason`);
    }
  }
  assert.equal(protocol.selectProvider(requirements, [{ ...verified, os: null }]).providerId, null);
  assert.equal(protocol.selectProvider(requirements, [{ ...verified, capabilities: [] }]).providerId, null);
});

test("keeps freshness, provenance and capabilities distinct from the control host", () => {
  assert.equal(typeof protocol.selectProvider, "function");
  const ios: ExecutionRequirements = { ...requirements, os: ["darwin"], capabilities: ["ios", "xcode"] };
  const mac: CapabilityReport = { ...verifiedSyntheticCapabilities("mac"), os: "darwin", capabilities: ["ios", "xcode"] };
  for (const os of ["linux", "win32"] as const) {
    const control = { ...mac, providerId: `control-${os}`, os };
    assert.equal(protocol.selectProvider(ios, [control]).providerId, null);
    assert.equal(protocol.selectProvider(ios, [control, mac]).providerId, "mac");
  }
  const matchingNodeAndResources = { ...verifiedSyntheticCapabilities(), checks: { ...verifiedSyntheticCapabilities().checks, cpu: "unknown" as const, filesystem: "unknown" as const, network: "unknown" as const } };
  assert.equal(protocol.selectProvider(requirements, [matchingNodeAndResources]).providerId, null);
  assert.ok(protocol.selectProvider(requirements, [matchingNodeAndResources]).reasons.some(reason => reason.includes("cpu")));
});
