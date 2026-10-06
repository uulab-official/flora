import type { DatabaseSync } from "node:sqlite";
import { id } from "@app-ops/core";
import type { LeaseProof } from "@app-ops/runner-protocol";
import { rows } from "./database.js";
export interface AuditEvent {
  sequence: number;
  organizationId: string;
  jobId: string;
  actorId: string;
  action: string;
  at: number;
  attemptId: string | null;
  fence: number | null;
  safeCode: string | null;
}
export function appendEvent(
  db: DatabaseSync,
  org: string,
  job: string,
  actor: string,
  action: string,
  at: number,
  proof: LeaseProof | null = null,
  code: string | null = null,
): void {
  db.prepare(
    "INSERT INTO audit_events(org_id,job_id,actor_id,action,at,attempt_id,fence,safe_code) VALUES(?,?,?,?,?,?,?,?)",
  ).run(
    org,
    job,
    actor,
    action,
    at,
    proof?.attemptId ?? null,
    proof?.fence ?? null,
    code,
  );
}
export function listEvents(
  db: DatabaseSync,
  organizationId: string,
  jobId: string,
): AuditEvent[] {
  return rows(
    db,
    "SELECT * FROM audit_events WHERE org_id=? AND job_id=? ORDER BY sequence",
    id(organizationId),
    id(jobId),
  ).map((r) => ({
    sequence: Number(r.sequence),
    organizationId: String(r.org_id),
    jobId: String(r.job_id),
    actorId: String(r.actor_id),
    action: String(r.action),
    at: Number(r.at),
    attemptId: r.attempt_id as string | null,
    fence: r.fence as number | null,
    safeCode: r.safe_code as string | null,
  }));
}
