import { object, id, text, list, ensure, integer } from "@app-ops/core";
export type RunnerCapability =
  | "node"
  | "xcode"
  | "android-sdk"
  | "ios"
  | "android"
  | "web";
export type JobKind = "build" | "store_submit" | "store_release";
export type JobStatus =
  | "queued"
  | "assigned"
  | "running"
  | "waiting"
  | "success"
  | "failed"
  | "cancelled"
  | "expired";
export interface NewJobInput {
  organizationId: string;
  releaseId: string;
  targetId: string;
  sourceRevisionId: string;
  snapshotId: string;
  kind: JobKind;
  idempotencyKey: string;
  createdBy: string;
  requiredCapabilities: readonly RunnerCapability[];
}
export interface Job extends NewJobInput {
  id: string;
  requestDigest: string;
  status: JobStatus;
  attemptCount: number;
  currentAttemptId: string | null;
  fence: number;
  leaseUntil: number | null;
  waitingReason: string | null;
  resultDigest: string | null;
  artifactId: string | null;
}
export interface Lease {
  organizationId: string;
  jobId: string;
  runnerId: string;
  attemptId: string;
  fence: number;
  expiresAt: number;
}
export interface LeaseProof {
  organizationId: string;
  jobId: string;
  runnerId: string;
  attemptId: string;
  fence: number;
  now: number;
}
export interface ClaimInput {
  organizationId: string;
  jobId: string;
  runnerId: string;
  runnerOs: "darwin" | "win32" | "linux";
  capabilities: readonly RunnerCapability[];
  now: number;
  leaseDurationMs?: number;
}
export interface CancelInput {
  organizationId: string;
  jobId: string;
  actorId: string;
  reason: string;
  now: number;
  authorization: {
    organizationId: string;
    actorId: string;
    actions: readonly string[];
  };
}
export type FailureCode =
  | "BUILD_FAILED"
  | "RUNNER_LOST"
  | "UNSUPPORTED_TOOLCHAIN";
export function capabilities(v: unknown): RunnerCapability[] {
  return [
    ...new Set(
      list(v).map((x) => {
        ensure(
          x === "node" ||
            x === "xcode" ||
            x === "android-sdk" ||
            x === "ios" ||
            x === "android" ||
            x === "web",
        );
        return x;
      }),
    ),
  ].sort();
}
export function parseNewJobInput(v: unknown): NewJobInput {
  const o = object(v, [
    "organizationId",
    "releaseId",
    "targetId",
    "sourceRevisionId",
    "snapshotId",
    "kind",
    "idempotencyKey",
    "createdBy",
    "requiredCapabilities",
  ]);
  ensure(
    o.kind === "build" ||
      o.kind === "store_submit" ||
      o.kind === "store_release",
  );
  return {
    organizationId: id(o.organizationId),
    releaseId: id(o.releaseId),
    targetId: id(o.targetId),
    sourceRevisionId: id(o.sourceRevisionId),
    snapshotId: id(o.snapshotId),
    kind: o.kind,
    idempotencyKey: text(o.idempotencyKey, 128),
    createdBy: id(o.createdBy),
    requiredCapabilities: capabilities(o.requiredCapabilities),
  };
}
export function parseProof(v: unknown): LeaseProof {
  const o = object(v, [
    "organizationId",
    "jobId",
    "runnerId",
    "attemptId",
    "fence",
    "now",
  ]);
  return {
    organizationId: id(o.organizationId),
    jobId: id(o.jobId),
    runnerId: id(o.runnerId),
    attemptId: id(o.attemptId),
    fence: integer(o.fence, 1),
    now: integer(o.now),
  };
}
export function proofOf(l: Lease, now: number): LeaseProof {
  return parseProof({
    organizationId: l.organizationId,
    jobId: l.jobId,
    runnerId: l.runnerId,
    attemptId: l.attemptId,
    fence: l.fence,
    now,
  });
}
