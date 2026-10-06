import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensure, DomainError } from "@app-ops/core";
import { resolveSnapshot, canonicalJson, sha256 } from "@app-ops/config";
import {
  openDatabase,
  migrate,
  insertCatalog,
  saveTarget,
  saveSource,
  saveSnapshot,
  createRelease,
  createJob,
  claimJob,
  startJob,
  recoverExpiredJobs,
  recordArtifact,
  completeJob,
  getReleaseSummary,
} from "@app-ops/db";
import { proofOf } from "@app-ops/runner-protocol";
import type { Lease } from "@app-ops/runner-protocol";
import type { ReleaseSummary } from "@app-ops/db";
import { parseWorkflow } from "./config-command.js";
import type { WorkflowInput } from "./config-command.js";
export type Scenario = "happy-path" | "runner-replacement" | "unsafe-expiry";
export interface SimulationReport {
  mode: "local-simulation";
  notice: string;
  scenario: Scenario;
  configSnapshotId: string;
  summary: ReleaseSummary;
  rejectedOperations: { runnerId: string; code: string }[];
}
export async function simulateWorkflow(
  input: WorkflowInput,
  scenario: Scenario,
): Promise<SimulationReport> {
  ensure(
    ["happy-path", "runner-replacement", "unsafe-expiry"].includes(scenario),
  );
  const w = parseWorkflow(input);
  const snapshot = await resolveSnapshot({
    target: w.target,
    source: w.source,
    entries: w.configEntries,
  });
  const directory = await mkdtemp(join(tmpdir(), "app-ops-simulation-"));
  const db = openDatabase(join(directory, "state.db"));
  try {
    migrate(db);
    insertCatalog(db, w.catalog);
    saveTarget(db, w.target);
    saveSource(db, w.source);
    await saveSnapshot(db, snapshot);
    const release = createRelease(db, {
      id: "release_local",
      organizationId: w.target.organizationId,
      applicationId: w.target.applicationId,
      sourceRevisionId: w.source.id,
      version: w.releaseVersion,
      createdBy: "user_local",
    });
    const j = await createJob(db, {
      organizationId: w.target.organizationId,
      releaseId: release.id,
      targetId: w.target.id,
      sourceRevisionId: w.source.id,
      snapshotId: snapshot.id,
      kind: scenario === "unsafe-expiry" ? "store_submit" : "build",
      idempotencyKey: "local_simulation",
      createdBy: "user_local",
      requiredCapabilities: [],
    });
    let now = Date.now();
    const inputClaim = {
      organizationId: j.organizationId,
      jobId: j.id,
      runnerId: "simulated_runner_a",
      runnerOs: "darwin" as const,
      capabilities: [
        "ios",
        "xcode",
        "android",
        "android-sdk",
        "web",
        "node",
      ] as const,
      leaseDurationMs: 30_000,
      now,
    };
    const first = claimJob(db, inputClaim);
    ensure(first, "INVALID_TRANSITION");
    startJob(db, proofOf(first, now));
    let lease: Lease = first;
    const rejectedOperations: { runnerId: string; code: string }[] = [];
    if (scenario !== "happy-path") {
      now += 30_000;
      recoverExpiredJobs(db, j.organizationId, now);
      if (scenario === "runner-replacement") {
        const second = claimJob(db, {
          ...inputClaim,
          runnerId: "simulated_runner_b",
          now,
        });
        ensure(second, "INVALID_TRANSITION");
        lease = second;
        startJob(db, proofOf(second, now));
        try {
          completeJob(db, {
            ...proofOf(first, now),
            artifactId: "expired_artifact",
            resultDigest: "0".repeat(64),
          });
          throw new Error("stale completion accepted");
        } catch (e) {
          ensure(
            e instanceof DomainError && e.code === "LEASE_STALE",
            "INVALID_TRANSITION",
          );
          rejectedOperations.push({ runnerId: first.runnerId, code: e.code });
        }
      }
    }
    if (scenario !== "unsafe-expiry") {
      const bytes = canonicalJson({
        simulation: true,
        sourceRevisionId: w.source.id,
        snapshotId: snapshot.id,
        jobId: j.id,
        attemptId: lease.attemptId,
      });
      const checksum = await sha256(bytes);
      const artifact = recordArtifact(
        db,
        {
          id: "artifact_local",
          organizationId: j.organizationId,
          jobId: j.id,
          attemptId: lease.attemptId,
          releaseId: release.id,
          targetId: j.targetId,
          sourceRevisionId: j.sourceRevisionId,
          snapshotId: j.snapshotId,
          digest: checksum,
          sizeBytes: new TextEncoder().encode(bytes).byteLength,
          mediaType: "application/json",
          storageKey: "simulation/" + checksum,
        },
        proofOf(lease, now),
      );
      completeJob(db, {
        ...proofOf(lease, now),
        artifactId: artifact.id,
        resultDigest: checksum,
      });
    }
    return {
      mode: "local-simulation",
      notice:
        "Synthetic metadata only. No native build, credentials, provider request or deployment.",
      scenario,
      configSnapshotId: snapshot.id,
      summary: getReleaseSummary(db, j.organizationId, release.id),
      rejectedOperations,
    };
  } finally {
    db.close();
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}
