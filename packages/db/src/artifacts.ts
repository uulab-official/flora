import type { DatabaseSync } from "node:sqlite";
import { object, id, digest, integer, text, ensure } from "@app-ops/core";
import { canonicalJson } from "@app-ops/config";
import type { Job, LeaseProof } from "@app-ops/runner-protocol";
import { transaction, row, rows } from "./database.js";
import { immutableInsert } from "./catalog.js";
import type { ReleaseInput } from "./catalog.js";
import { activeLease, getJob } from "./jobs.js";
import { appendEvent, listEvents } from "./events.js";
import type { AuditEvent } from "./events.js";
export interface ArtifactInput {
  id: string;
  organizationId: string;
  jobId: string;
  attemptId: string;
  releaseId: string;
  targetId: string;
  sourceRevisionId: string;
  snapshotId: string;
  digest: string;
  sizeBytes: number;
  mediaType: string;
  storageKey: string;
}
export type Artifact = ArtifactInput;
export function recordArtifact(
  db: DatabaseSync,
  input: ArtifactInput,
  proof: LeaseProof,
): Artifact {
  const o = object(input, [
    "id",
    "organizationId",
    "jobId",
    "attemptId",
    "releaseId",
    "targetId",
    "sourceRevisionId",
    "snapshotId",
    "digest",
    "sizeBytes",
    "mediaType",
    "storageKey",
  ]);
  const a: Artifact = {
    id: id(o.id),
    organizationId: id(o.organizationId),
    jobId: id(o.jobId),
    attemptId: id(o.attemptId),
    releaseId: id(o.releaseId),
    targetId: id(o.targetId),
    sourceRevisionId: id(o.sourceRevisionId),
    snapshotId: id(o.snapshotId),
    digest: digest(o.digest),
    sizeBytes: integer(o.sizeBytes),
    mediaType: text(o.mediaType, 128),
    storageKey: text(o.storageKey, 128),
  };
  ensure(
    a.storageKey === "simulation/" + a.digest &&
      a.mediaType === "application/json",
  );
  return transaction(db, () => {
    const { job: j, proof: p } = activeLease(db, proof, true);
    ensure(a.organizationId === p.organizationId, "TENANT_MISMATCH");
    ensure(
      a.jobId === j.id &&
        a.attemptId === p.attemptId &&
        a.releaseId === j.releaseId &&
        a.targetId === j.targetId &&
        a.sourceRevisionId === j.sourceRevisionId &&
        a.snapshotId === j.snapshotId,
      "INVALID_RELATION",
    );
    const existing = row(
      db,
      "SELECT data FROM artifacts WHERE org_id=? AND id=?",
      a.organizationId,
      a.id,
    );
    if (existing) {
      ensure(existing.data === canonicalJson(a), "CONFLICT");
      return a;
    }
    immutableInsert(
      db,
      "artifacts",
      {
        org_id: a.organizationId,
        id: a.id,
        job_id: a.jobId,
        attempt_id: a.attemptId,
        release_id: a.releaseId,
        target_id: a.targetId,
        source_id: a.sourceRevisionId,
        snapshot_id: a.snapshotId,
        digest: a.digest,
        size_bytes: a.sizeBytes,
      },
      a,
    );
    appendEvent(
      db,
      p.organizationId,
      p.jobId,
      p.runnerId,
      "artifact.recorded",
      p.now,
      p,
    );
    return a;
  });
}
export interface ReleaseSummary {
  release: ReleaseInput;
  jobs: Job[];
  artifacts: Artifact[];
  events: AuditEvent[];
}
export function getReleaseSummary(
  db: DatabaseSync,
  org: string,
  releaseId: string,
): ReleaseSummary {
  id(org);
  id(releaseId);
  const r = row(
    db,
    "SELECT data FROM releases WHERE org_id=? AND id=?",
    org,
    releaseId,
  );
  ensure(r, "NOT_FOUND");
  const jobs = rows(
    db,
    "SELECT id FROM jobs WHERE org_id=? AND release_id=? ORDER BY rowid",
    org,
    releaseId,
  ).map((x) => getJob(db, org, String(x.id)));
  const artifacts = rows(
    db,
    "SELECT data FROM artifacts WHERE org_id=? AND release_id=? ORDER BY rowid",
    org,
    releaseId,
  ).map((x) => JSON.parse(String(x.data)) as Artifact);
  return {
    release: JSON.parse(String(r.data)) as ReleaseInput,
    jobs,
    artifacts,
    events: jobs
      .flatMap((j) => listEvents(db, org, j.id))
      .sort((a, b) => a.sequence - b.sequence),
  };
}
