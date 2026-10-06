import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  object,
  id,
  text,
  integer,
  ensure,
  digest,
  list,
  safeJson,
} from "@app-ops/core";
import { canonicalJson, sha256 } from "@app-ops/config";
import {
  parseNewJobInput,
  parseProof,
  capabilities,
  afterInterruption,
} from "@app-ops/runner-protocol";
import type {
  NewJobInput,
  Job,
  JobStatus,
  ClaimInput,
  Lease,
  LeaseProof,
  CancelInput,
  FailureCode,
} from "@app-ops/runner-protocol";
import { transaction, row, rows } from "./database.js";
import type { Row } from "./database.js";
import { appendEvent } from "./events.js";
function fromRow(r: Row): Job {
  return {
    ...parseNewJobInput(JSON.parse(String(r.request_data))),
    id: String(r.id),
    requestDigest: String(r.request_digest),
    status: r.status as JobStatus,
    attemptCount: Number(r.attempt_count),
    currentAttemptId: r.current_attempt_id as string | null,
    fence: Number(r.fence),
    leaseUntil: r.lease_until as number | null,
    waitingReason: r.waiting_reason as string | null,
    resultDigest: r.result_digest as string | null,
    artifactId: r.artifact_id as string | null,
  };
}
export function getJob(db: DatabaseSync, org: string, jobId: string): Job {
  const r = row(
    db,
    "SELECT * FROM jobs WHERE org_id=? AND id=?",
    id(org),
    id(jobId),
  );
  ensure(r, "NOT_FOUND");
  return fromRow(r);
}
export async function createJob(
  db: DatabaseSync,
  value: NewJobInput,
): Promise<Job> {
  const input = parseNewJobInput(value);
  const serialized = canonicalJson(input);
  const requestDigest = await sha256(
    canonicalJson({ ...input, idempotencyKey: null }),
  );
  return transaction(db, () => {
    const existing = row(
      db,
      "SELECT * FROM jobs WHERE org_id=? AND idempotency_key=?",
      input.organizationId,
      input.idempotencyKey,
    );
    if (existing) {
      ensure(existing.request_digest === requestDigest, "IDEMPOTENCY_CONFLICT");
      return fromRow(existing);
    }
    const release = row(
      db,
      "SELECT source_id FROM releases WHERE org_id=? AND id=?",
      input.organizationId,
      input.releaseId,
    );
    const snapshot = row(
      db,
      "SELECT source_id,target_id FROM config_snapshots WHERE org_id=? AND id=?",
      input.organizationId,
      input.snapshotId,
    );
    ensure(
      release?.source_id === input.sourceRevisionId &&
        snapshot?.source_id === input.sourceRevisionId &&
        snapshot?.target_id === input.targetId,
      "INVALID_RELATION",
    );
    const jobId = "job_" + randomUUID();
    db.prepare(
      "INSERT INTO jobs(org_id,id,release_id,target_id,source_id,snapshot_id,kind,idempotency_key,request_digest,request_data,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      input.organizationId,
      jobId,
      input.releaseId,
      input.targetId,
      input.sourceRevisionId,
      input.snapshotId,
      input.kind,
      input.idempotencyKey,
      requestDigest,
      serialized,
      "queued",
    );
    appendEvent(
      db,
      input.organizationId,
      jobId,
      input.createdBy,
      "job.created",
      Date.now(),
    );
    return getJob(db, input.organizationId, jobId);
  });
}
export function claimJob(db: DatabaseSync, value: ClaimInput): Lease | null {
  safeJson(value);
  const o = object({ leaseDurationMs: 30_000, ...value }, [
    "organizationId",
    "jobId",
    "runnerId",
    "runnerOs",
    "capabilities",
    "now",
    "leaseDurationMs",
  ]);
  const org = id(o.organizationId),
    jobId = id(o.jobId),
    runnerId = id(o.runnerId),
    now = integer(o.now),
    ttl = integer(o.leaseDurationMs, 5000, 120000);
  ensure(
    o.runnerOs === "darwin" || o.runnerOs === "win32" || o.runnerOs === "linux",
  );
  const caps = capabilities(o.capabilities);
  const expiresAt = integer(now + ttl);
  return transaction(db, () => {
    const j = getJob(db, org, jobId);
    if (j.status !== "queued") return null;
    const t = row(
      db,
      "SELECT platform FROM platform_targets WHERE org_id=? AND id=?",
      org,
      j.targetId,
    );
    ensure(t, "INVALID_RELATION");
    const required =
      t.platform === "ios"
        ? ["ios", "xcode"]
        : t.platform === "android"
          ? ["android", "android-sdk"]
          : ["web", "node"];
    if (
      (t.platform === "ios" && o.runnerOs !== "darwin") ||
      ![...required, ...j.requiredCapabilities].every((c) =>
        caps.includes(c as (typeof caps)[number]),
      )
    )
      return null;
    ensure(j.attemptCount < 3, "INVALID_TRANSITION");
    const attemptId = "attempt_" + randomUUID(),
      fence = j.fence + 1;
    db.prepare(
      "INSERT INTO job_attempts(org_id,id,job_id,runner_id,fence,expires_at,lease_duration,status) VALUES(?,?,?,?,?,?,?,?)",
    ).run(org, attemptId, jobId, runnerId, fence, expiresAt, ttl, "assigned");
    const updated = db
      .prepare(
        "UPDATE jobs SET status=?,attempt_count=attempt_count+1,current_attempt_id=?,fence=?,lease_until=? WHERE org_id=? AND id=? AND status=? AND fence=?",
      )
      .run(
        "assigned",
        attemptId,
        fence,
        expiresAt,
        org,
        jobId,
        "queued",
        j.fence,
      );
    ensure(updated.changes === 1, "CONFLICT");
    const lease = {
      organizationId: org,
      jobId,
      runnerId,
      attemptId,
      fence,
      expiresAt,
    };
    appendEvent(db, org, jobId, runnerId, "job.claimed", now, {
      organizationId: org,
      jobId,
      runnerId,
      attemptId,
      fence,
      now,
    });
    return lease;
  });
}
export function activeLease(
  db: DatabaseSync,
  input: LeaseProof,
  runningOnly = false,
): { job: Job; attempt: Row; proof: LeaseProof } {
  const p = parseProof(input);
  const j = getJob(db, p.organizationId, p.jobId);
  const a = row(
    db,
    "SELECT * FROM job_attempts WHERE org_id=? AND id=? AND job_id=?",
    p.organizationId,
    p.attemptId,
    p.jobId,
  );
  ensure(
    a &&
      j.currentAttemptId === p.attemptId &&
      j.fence === p.fence &&
      a.fence === p.fence &&
      a.runner_id === p.runnerId &&
      (j.status === "running" || (!runningOnly && j.status === "assigned")) &&
      a.status === j.status &&
      j.leaseUntil !== null &&
      p.now < j.leaseUntil &&
      p.now < Number(a.expires_at),
    "LEASE_STALE",
  );
  return { job: j, attempt: a, proof: p };
}
export function startJob(db: DatabaseSync, input: LeaseProof): Job {
  return transaction(db, () => {
    const { job: j, proof: p } = activeLease(db, input);
    ensure(j.status === "assigned", "INVALID_TRANSITION");
    db.prepare(
      "UPDATE job_attempts SET status=? WHERE org_id=? AND id=? AND status=?",
    ).run("running", p.organizationId, p.attemptId, "assigned");
    ensure(
      db
        .prepare(
          "UPDATE jobs SET status=? WHERE org_id=? AND id=? AND status=? AND fence=?",
        )
        .run("running", p.organizationId, p.jobId, "assigned", p.fence)
        .changes === 1,
      "CONFLICT",
    );
    appendEvent(
      db,
      p.organizationId,
      p.jobId,
      p.runnerId,
      "job.started",
      p.now,
      p,
    );
    return getJob(db, p.organizationId, p.jobId);
  });
}
export function heartbeat(db: DatabaseSync, input: LeaseProof): Lease {
  return transaction(db, () => {
    const { attempt: a, proof: p } = activeLease(db, input);
    const expiresAt = integer(
      Math.max(Number(a.expires_at), p.now + Number(a.lease_duration)),
    );
    db.prepare(
      "UPDATE job_attempts SET expires_at=? WHERE org_id=? AND id=?",
    ).run(expiresAt, p.organizationId, p.attemptId);
    ensure(
      db
        .prepare(
          "UPDATE jobs SET lease_until=? WHERE org_id=? AND id=? AND fence=?",
        )
        .run(expiresAt, p.organizationId, p.jobId, p.fence).changes === 1,
      "CONFLICT",
    );
    return {
      organizationId: p.organizationId,
      jobId: p.jobId,
      runnerId: p.runnerId,
      attemptId: p.attemptId,
      fence: p.fence,
      expiresAt,
    };
  });
}
function interrupt(
  db: DatabaseSync,
  j: Job,
  proof: LeaseProof,
  expired: boolean,
  retryable: boolean,
  code: string,
): void {
  const next = afterInterruption(j.kind, j.attemptCount, expired, retryable);
  db.prepare("UPDATE job_attempts SET status=? WHERE org_id=? AND id=?").run(
    expired ? "expired" : "failed",
    j.organizationId,
    proof.attemptId,
  );
  ensure(
    db
      .prepare(
        "UPDATE jobs SET status=?,current_attempt_id=NULL,lease_until=NULL,waiting_reason=? WHERE org_id=? AND id=? AND fence=? AND status=?",
      )
      .run(next.status, next.reason, j.organizationId, j.id, j.fence, j.status)
      .changes === 1,
    "CONFLICT",
  );
  appendEvent(
    db,
    j.organizationId,
    j.id,
    proof.runnerId,
    expired ? "job.expired" : "job.failed",
    proof.now,
    proof,
    code,
  );
}
export function recoverExpiredJobs(
  db: DatabaseSync,
  organizationId: string,
  now: number,
): number {
  id(organizationId);
  integer(now);
  return transaction(db, () => {
    const expired = rows(
      db,
      "SELECT * FROM jobs WHERE org_id=? AND status IN ('assigned','running') AND lease_until<=?",
      organizationId,
      now,
    );
    for (const r of expired) {
      const j = fromRow(r);
      ensure(j.currentAttemptId, "INVALID_RELATION");
      const a = row(
        db,
        "SELECT runner_id FROM job_attempts WHERE org_id=? AND id=?",
        organizationId,
        j.currentAttemptId,
      );
      ensure(a, "INVALID_RELATION");
      interrupt(
        db,
        j,
        {
          organizationId,
          jobId: j.id,
          runnerId: String(a.runner_id),
          attemptId: j.currentAttemptId,
          fence: j.fence,
          now,
        },
        true,
        true,
        "LEASE_EXPIRED",
      );
    }
    return expired.length;
  });
}
export function failJob(
  db: DatabaseSync,
  input: LeaseProof & { failureCode: FailureCode; retryable: boolean },
): Job {
  const o = object(input, [
    "organizationId",
    "jobId",
    "runnerId",
    "attemptId",
    "fence",
    "now",
    "failureCode",
    "retryable",
  ]);
  ensure(
    o.failureCode === "BUILD_FAILED" ||
      o.failureCode === "RUNNER_LOST" ||
      o.failureCode === "UNSUPPORTED_TOOLCHAIN",
  );
  ensure(typeof o.retryable === "boolean");
  const { failureCode, retryable, ...proof } = input;
  return transaction(db, () => {
    const { job: j, proof: p } = activeLease(db, proof);
    interrupt(db, j, p, false, retryable, failureCode);
    return getJob(db, p.organizationId, p.jobId);
  });
}
export function cancelJob(db: DatabaseSync, input: CancelInput): Job {
  const o = object(input, [
    "organizationId",
    "jobId",
    "actorId",
    "reason",
    "now",
    "authorization",
  ]);
  const org = id(o.organizationId),
    jobId = id(o.jobId),
    actor = id(o.actorId),
    now = integer(o.now);
  text(o.reason, 256);
  const a = object(o.authorization, ["organizationId", "actorId", "actions"]);
  ensure(
    a.organizationId === org &&
      a.actorId === actor &&
      list(a.actions).includes("job.cancel"),
    "PERMISSION_DENIED",
  );
  return transaction(db, () => {
    const j = getJob(db, org, jobId);
    if (j.status === "cancelled") return j;
    ensure(
      ["queued", "assigned", "running", "waiting"].includes(j.status),
      "INVALID_TRANSITION",
    );
    if (j.currentAttemptId)
      db.prepare(
        "UPDATE job_attempts SET status='cancelled' WHERE org_id=? AND id=? AND status IN ('assigned','running')",
      ).run(org, j.currentAttemptId);
    ensure(
      db
        .prepare(
          "UPDATE jobs SET status=?,fence=fence+1,lease_until=NULL,waiting_reason=NULL WHERE org_id=? AND id=? AND status=? AND fence=?",
        )
        .run("cancelled", org, jobId, j.status, j.fence).changes === 1,
      "CONFLICT",
    );
    appendEvent(
      db,
      org,
      jobId,
      actor,
      "job.cancelled",
      now,
      null,
      "OPERATOR_CANCELLED",
    );
    return getJob(db, org, jobId);
  });
}
export function completeJob(
  db: DatabaseSync,
  input: LeaseProof & { artifactId: string; resultDigest: string },
): Job {
  object(input, [
    "organizationId",
    "jobId",
    "runnerId",
    "attemptId",
    "fence",
    "now",
    "artifactId",
    "resultDigest",
  ]);
  const { artifactId, resultDigest, ...value } = input;
  id(artifactId);
  digest(resultDigest);
  const p = parseProof(value);
  return transaction(db, () => {
    const j = getJob(db, p.organizationId, p.jobId);
    if (j.status === "success") {
      const a = row(
        db,
        "SELECT runner_id FROM job_attempts WHERE org_id=? AND id=? AND job_id=?",
        p.organizationId,
        p.attemptId,
        p.jobId,
      );
      ensure(
        j.currentAttemptId === p.attemptId &&
          j.fence === p.fence &&
          a?.runner_id === p.runnerId &&
          j.artifactId === artifactId &&
          j.resultDigest === resultDigest,
        "CONFLICT",
      );
      return j;
    }
    activeLease(db, p, true);
    ensure(j.kind === "build", "PROVIDER_UNCONFIGURED");
    const artifact = row(
      db,
      "SELECT * FROM artifacts WHERE org_id=? AND id=? AND job_id=? AND attempt_id=?",
      p.organizationId,
      artifactId,
      p.jobId,
      p.attemptId,
    );
    ensure(artifact && artifact.digest === resultDigest, "INVALID_RELATION");
    db.prepare(
      "UPDATE job_attempts SET status=?,result_digest=? WHERE org_id=? AND id=?",
    ).run("success", resultDigest, p.organizationId, p.attemptId);
    ensure(
      db
        .prepare(
          "UPDATE jobs SET status=?,lease_until=NULL,result_digest=?,artifact_id=? WHERE org_id=? AND id=? AND status=? AND fence=?",
        )
        .run(
          "success",
          resultDigest,
          artifactId,
          p.organizationId,
          p.jobId,
          "running",
          p.fence,
        ).changes === 1,
      "CONFLICT",
    );
    appendEvent(
      db,
      p.organizationId,
      p.jobId,
      p.runnerId,
      "job.completed",
      p.now,
      p,
    );
    return getJob(db, p.organizationId, p.jobId);
  });
}
