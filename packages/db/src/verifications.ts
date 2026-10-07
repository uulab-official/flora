import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { DomainError, ensure, integer, object, safeJson, text } from "@app-ops/core";
import { canonicalJson, freeze } from "@app-ops/config";
import { assertParsedBaseline, assessReport, CONFIG_RUNTIME_SMOKE_V1, parseBaselineBundle } from "@app-ops/dogfood";
import type { BaselineEvidence, PreparedBaselineImport, ReportAssessment, VerificationCompletion, VerificationCreation, VerificationFence, VerificationRecord, VerificationState } from "@app-ops/dogfood";
import { getInventory } from "./inventory.js";
import { row, rows, transaction } from "./database.js";
import type { Row } from "./database.js";

/** Local process ownership only. The caller may recover attempts only after this succeeds. */
export function acquireDashboardOwner(db: DatabaseSync, input: { nonce: string; pid: number; host: string }): void {
  object(input, ["nonce", "pid", "host"]);
  const nonce = text(input.nonce, 256), pid = integer(input.pid, 1, 2 ** 31 - 1), host = text(input.host, 255);
  transaction(db, () => {
    const current = row(db, "SELECT * FROM dashboard_server_owner WHERE singleton=1");
    if (current) {
      ensure(current.host === host && typeof current.pid === "number" && Number.isInteger(current.pid)
        && current.pid > 0 && current.pid < 2 ** 31, "STORE_IN_USE");
      let absent = false;
      try { process.kill(current.pid, 0); }
      catch (error) { absent = error instanceof Error && "code" in error && error.code === "ESRCH"; }
      // A live (including reused) PID, EPERM, another host, or uncertainty is never recoverable.
      if (!absent) throw new DomainError("STORE_IN_USE");
      db.prepare("UPDATE dashboard_server_owner SET nonce=?,pid=?,host=?,acquired_at=? WHERE singleton=1")
        .run(nonce, pid, host, Date.now());
    } else {
      db.prepare("INSERT INTO dashboard_server_owner(singleton,nonce,pid,host,acquired_at) VALUES(1,?,?,?,?)")
        .run(nonce, pid, host, Date.now());
    }
  });
}

/** A stale closer cannot remove the next process's ownership row. */
export function releaseDashboardOwner(db: DatabaseSync, nonce: string): void {
  text(nonce, 256);
  db.prepare("DELETE FROM dashboard_server_owner WHERE singleton=1 AND nonce=?").run(nonce);
}

function fromRow(value: Row): VerificationRecord {
  return freeze({
    id: String(value.id), snapshotId: String(value.snapshot_id), sourceDigest: String(value.source_digest), profileId: String(value.profile_id),
    evidenceKind: value.evidence_kind as VerificationRecord["evidenceKind"], evidenceOrigin: value.evidence_origin as VerificationRecord["evidenceOrigin"],
    state: value.state as VerificationState, code: value.code as string | null, cleanupCode: value.cleanup_code as VerificationRecord["cleanupCode"],
    requestKind: value.request_kind as VerificationRecord["requestKind"], requestKey: String(value.request_key), attemptId: value.attempt_id as string | null,
    fence: Number(value.fence), leaseUntil: value.lease_until as number | null, createdAt: Number(value.created_at), updatedAt: Number(value.updated_at),
    evidence: value.evidence === null ? null : JSON.parse(String(value.evidence)) as BaselineEvidence,
    assessment: value.assessment === null ? null : JSON.parse(String(value.assessment)) as ReportAssessment,
  });
}
export function getVerification(db: DatabaseSync, recordId: string): VerificationRecord | null {
  const found = row(db, "SELECT * FROM verification_records WHERE id=?", text(recordId));
  return found ? fromRow(found) : null;
}
function requireRecord(db: DatabaseSync, id: string): VerificationRecord {
  const record = getVerification(db, id); ensure(record, "NOT_FOUND"); return record;
}
export function listVerifications(db: DatabaseSync, snapshotId: string): VerificationRecord[] {
  return rows(db, "SELECT * FROM verification_records WHERE snapshot_id=? ORDER BY created_at,id", text(snapshotId)).map(fromRow);
}
function safeCode(value: unknown): string {
  const code = text(value, 96); ensure(/^[A-Z][A-Z0-9_]*$/.test(code)); return code;
}
function parsedAssessment(db: DatabaseSync, snapshotId: string, evidence: BaselineEvidence, assessment: ReportAssessment): ReportAssessment {
  const snapshot = getInventory(db, snapshotId); ensure(snapshot, "NOT_FOUND");
  assertParsedBaseline(evidence, snapshot);
  safeJson(assessment);
  const actual = assessReport(evidence, CONFIG_RUNTIME_SMOKE_V1);
  ensure(canonicalJson(actual) === canonicalJson(assessment));
  return actual;
}

/** Internal only. The public import path parses and hashes before this transaction. */
export function persistBaseline(db: DatabaseSync, input: PreparedBaselineImport): VerificationRecord {
  object(input, ["snapshotId", "evidence", "assessment", "now"]);
  const snapshotId = text(input.snapshotId), now = integer(input.now), evidence = input.evidence;
  // Reject caller-mutated or fabricated evidence before opening a transaction.
  parsedAssessment(db, snapshotId, evidence, input.assessment);
  const id = "verification_" + randomUUID();
  return transaction(db, () => {
    const assessment = parsedAssessment(db, snapshotId, evidence, input.assessment);
    const key = evidence.sourceDigest + ":" + evidence.attemptKey;
    const existing = row(db, "SELECT * FROM verification_records WHERE request_kind='baseline-import' AND request_key=?", key);
    if (existing) {
      const record = fromRow(existing);
      ensure(record.snapshotId === snapshotId && record.evidence?.evidenceDigest === evidence.evidenceDigest, "IDEMPOTENCY_CONFLICT");
      return record;
    }
    db.prepare(`INSERT INTO verification_records(id,snapshot_id,source_digest,profile_id,evidence_kind,evidence_origin,state,code,cleanup_code,request_kind,request_key,attempt_id,fence,lease_until,created_at,updated_at,evidence,assessment)
      VALUES(?,?,?,?,'development-baseline','operator-import',?,?,NULL,'baseline-import',?,NULL,0,NULL,?,?,?,?)`)
      .run(id, snapshotId, evidence.sourceDigest, evidence.profileId, assessment.status, assessment.code, key, now, now, canonicalJson(evidence), canonicalJson(assessment));
    return requireRecord(db, id);
  });
}
export async function importBaseline(db: DatabaseSync, snapshotId: string, bytes: Uint8Array, now: number): Promise<VerificationRecord> {
  integer(now);
  const snapshot = getInventory(db, snapshotId); ensure(snapshot, "NOT_FOUND");
  const evidence = await parseBaselineBundle(bytes, snapshot);
  return persistBaseline(db, { snapshotId, evidence, assessment: assessReport(evidence, CONFIG_RUNTIME_SMOKE_V1), now });
}
export function createVerification(db: DatabaseSync, input: { snapshotId: string; requestKey: string; now: number }): VerificationCreation {
  object(input, ["snapshotId", "requestKey", "now"]);
  const snapshotId = text(input.snapshotId), requestKey = text(input.requestKey, 512), now = integer(input.now);
  const id = "verification_" + randomUUID();
  return transaction(db, () => {
    const snapshot = getInventory(db, snapshotId); ensure(snapshot, "NOT_FOUND");
    const existing = row(db, "SELECT * FROM verification_records WHERE request_kind='run-request' AND request_key=?", requestKey);
    if (existing) {
      const record = fromRow(existing); ensure(record.snapshotId === snapshotId, "IDEMPOTENCY_CONFLICT");
      return { record, created: false };
    }
    db.prepare(`INSERT INTO verification_records(id,snapshot_id,source_digest,profile_id,evidence_kind,evidence_origin,state,code,cleanup_code,request_kind,request_key,attempt_id,fence,lease_until,created_at,updated_at,evidence,assessment)
      VALUES(?,?,?,?,'isolated-runner-result','flora-request','queued',NULL,NULL,'run-request',?,NULL,0,NULL,?,?,NULL,NULL)`)
      .run(id, snapshot.id, snapshot.digest, CONFIG_RUNTIME_SMOKE_V1.id, requestKey, now, now);
    return { record: requireRecord(db, id), created: true };
  });
}
export function beginVerification(db: DatabaseSync, input: { recordId: string; attemptId: string; runnerId: string; now: number; leaseMs: number }): VerificationFence {
  object(input, ["recordId", "attemptId", "runnerId", "now", "leaseMs"]);
  const recordId = text(input.recordId), attemptId = text(input.attemptId, 256), runnerId = text(input.runnerId, 256);
  const now = integer(input.now), leaseMs = integer(input.leaseMs, 5000, 120000), expiresAt = integer(now + leaseMs);
  return transaction(db, () => {
    const record = requireRecord(db, recordId); ensure(record.state === "queued", "INVALID_TRANSITION");
    ensure(now >= record.updatedAt);
    const fence = integer(record.fence + 1);
    db.prepare("INSERT INTO verification_attempts(id,record_id,runner_id,fence,expires_at,lease_ms,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'running',?,?)")
      .run(attemptId, recordId, runnerId, fence, expiresAt, leaseMs, now, now);
    ensure(db.prepare("UPDATE verification_records SET state='running',evidence_origin='flora-execution',attempt_id=?,fence=?,lease_until=?,updated_at=? WHERE id=? AND state='queued' AND fence=?")
      .run(attemptId, fence, expiresAt, now, recordId, record.fence).changes === 1, "INVALID_TRANSITION");
    return { recordId, attemptId, runnerId, fence, expiresAt };
  });
}
function proof(input: VerificationFence): VerificationFence {
  object(input, ["recordId", "attemptId", "runnerId", "fence", "expiresAt"]);
  return { recordId: text(input.recordId), attemptId: text(input.attemptId, 256), runnerId: text(input.runnerId, 256), fence: integer(input.fence, 1), expiresAt: integer(input.expiresAt) };
}
function active(db: DatabaseSync, fence: VerificationFence, now: number, expired: boolean): VerificationRecord {
  const record = requireRecord(db, fence.recordId);
  const attempt = row(db, "SELECT * FROM verification_attempts WHERE id=? AND record_id=?", fence.attemptId, fence.recordId);
  ensure(record.state === "running" && record.attemptId === fence.attemptId && record.fence === fence.fence && record.leaseUntil === fence.expiresAt
    && attempt?.state === "running" && attempt.runner_id === fence.runnerId && attempt.fence === fence.fence && attempt.expires_at === fence.expiresAt
    && now >= record.updatedAt && (expired ? now >= fence.expiresAt : now < fence.expiresAt), "LEASE_STALE");
  return record;
}
function updateAttempt(db: DatabaseSync, record: VerificationRecord, state: VerificationState, now: number): void {
  if (record.attemptId === null) return;
  ensure(db.prepare("UPDATE verification_attempts SET state=?,updated_at=? WHERE id=? AND record_id=? AND state=?")
    .run(state, now, record.attemptId, record.id, record.state).changes === 1, "LEASE_STALE");
}
export function finishVerification(db: DatabaseSync, input: VerificationFence, completion: VerificationCompletion, now: number): VerificationRecord {
  const fence = proof(input); integer(now);
  object(completion, ["state", "code", "evidence", "assessment"]);
  ensure(["passed", "failed", "invalid", "blocked"].includes(completion.state));
  if (completion.code !== null) safeCode(completion.code);
  // The synchronous write owns no mutable caller references after return.
  return transaction(db, () => {
    const record = active(db, fence, now, false);
    if (completion.evidence !== null) {
      ensure(completion.assessment !== null && completion.evidence.attemptKey === fence.attemptId);
      const actual = parsedAssessment(db, record.snapshotId, completion.evidence, completion.assessment);
      ensure(completion.state === actual.status && completion.code === actual.code);
    } else ensure(completion.state !== "passed" && completion.assessment === null && completion.code !== null);
    updateAttempt(db, record, completion.state, now);
    ensure(db.prepare(`UPDATE verification_records SET state=?,code=?,evidence=?,assessment=?,lease_until=NULL,updated_at=?
      WHERE id=? AND state='running' AND attempt_id=? AND fence=? AND lease_until=? AND lease_until>?
      AND EXISTS(SELECT 1 FROM verification_attempts WHERE id=? AND record_id=? AND runner_id=? AND fence=? AND expires_at=?)`)
      .run(completion.state, completion.code, completion.evidence === null ? null : canonicalJson(completion.evidence), completion.assessment === null ? null : canonicalJson(completion.assessment), now,
        fence.recordId, fence.attemptId, fence.fence, fence.expiresAt, now, fence.attemptId, fence.recordId, fence.runnerId, fence.fence, fence.expiresAt).changes === 1, "LEASE_STALE");
    return requireRecord(db, fence.recordId);
  });
}
export function blockVerification(db: DatabaseSync, recordId: string, code: string, now: number): VerificationRecord {
  text(recordId); safeCode(code); integer(now);
  return transaction(db, () => {
    const record = requireRecord(db, recordId); ensure(record.state === "queued", "INVALID_TRANSITION"); ensure(now >= record.updatedAt);
    ensure(db.prepare("UPDATE verification_records SET state='blocked',code=?,updated_at=? WHERE id=? AND state='queued' AND fence=?")
      .run(code, now, recordId, record.fence).changes === 1, "INVALID_TRANSITION");
    return requireRecord(db, recordId);
  });
}
export function requestCancellation(db: DatabaseSync, recordId: string, now: number): VerificationRecord {
  text(recordId); integer(now);
  return transaction(db, () => {
    const record = requireRecord(db, recordId);
    if (record.state === "cancelling") return record;
    ensure(record.state === "queued" || record.state === "running", "INVALID_TRANSITION"); ensure(now >= record.updatedAt);
    updateAttempt(db, record, "cancelling", now);
    ensure(db.prepare("UPDATE verification_records SET state='cancelling',fence=fence+1,lease_until=NULL,code='CANCELLED',updated_at=? WHERE id=? AND state=? AND fence=?")
      .run(now, recordId, record.state, record.fence).changes === 1, "INVALID_TRANSITION");
    return requireRecord(db, recordId);
  });
}
function finalizeCleanup(db: DatabaseSync, recordId: string, confirmed: boolean, now: number, prior: "cancelling" | "timing_out"): VerificationRecord {
  text(recordId); integer(now); ensure(typeof confirmed === "boolean");
  return transaction(db, () => {
    const record = requireRecord(db, recordId); ensure(record.state === prior, "INVALID_TRANSITION"); ensure(now >= record.updatedAt);
    const state = prior === "cancelling" ? "cancelled" : "failed";
    updateAttempt(db, record, state, now);
    ensure(db.prepare("UPDATE verification_records SET state=?,code=?,cleanup_code=?,updated_at=? WHERE id=? AND state=? AND fence=?")
      .run(state, prior === "cancelling" ? "CANCELLED" : "TIMEOUT", !confirmed && record.attemptId !== null ? "CLEANUP_UNCONFIRMED" : null, now, recordId, prior, record.fence).changes === 1, "INVALID_TRANSITION");
    return requireRecord(db, recordId);
  });
}
export function finishCancellation(db: DatabaseSync, recordId: string, cleanupConfirmed: boolean, now: number): VerificationRecord {
  return finalizeCleanup(db, recordId, cleanupConfirmed, now, "cancelling");
}
export function expireVerification(db: DatabaseSync, input: VerificationFence, now: number): VerificationRecord {
  const fence = proof(input); integer(now);
  return transaction(db, () => {
    const record = active(db, fence, now, true);
    updateAttempt(db, record, "timing_out", now);
    ensure(db.prepare(`UPDATE verification_records SET state='timing_out',code='TIMEOUT',fence=fence+1,lease_until=NULL,updated_at=?
      WHERE id=? AND state='running' AND attempt_id=? AND fence=? AND lease_until=? AND lease_until<=?
      AND EXISTS(SELECT 1 FROM verification_attempts WHERE id=? AND record_id=? AND runner_id=? AND fence=? AND expires_at=?)`)
      .run(now, fence.recordId, fence.attemptId, fence.fence, fence.expiresAt, now, fence.attemptId, fence.recordId, fence.runnerId, fence.fence, fence.expiresAt).changes === 1, "LEASE_STALE");
    return requireRecord(db, fence.recordId);
  });
}
export function finishTimeout(db: DatabaseSync, recordId: string, cleanupConfirmed: boolean, now: number): VerificationRecord {
  return finalizeCleanup(db, recordId, cleanupConfirmed, now, "timing_out");
}
/** Local owner-controlled startup recovery only; never called by adapter construction. */
export function interruptVerifications(db: DatabaseSync, now: number): number {
  integer(now);
  return transaction(db, () => {
    const pending = rows(db, "SELECT * FROM verification_records WHERE state IN ('queued','running','cancelling','timing_out')").map(fromRow);
    for (const record of pending) {
      ensure(now >= record.updatedAt);
      const timeout = record.state === "timing_out" || (record.state === "running" && record.leaseUntil !== null && now >= record.leaseUntil);
      const state = timeout ? "failed" : "interrupted";
      updateAttempt(db, record, state, now);
      ensure(db.prepare("UPDATE verification_records SET state=?,code=?,cleanup_code=?,fence=fence+1,lease_until=NULL,updated_at=? WHERE id=? AND state=? AND fence=?")
        .run(state, timeout ? "TIMEOUT" : "INTERRUPTED", record.attemptId === null ? null : "CLEANUP_UNCONFIRMED", now, record.id, record.state, record.fence).changes === 1, "CONFLICT");
    }
    return pending.length;
  });
}
