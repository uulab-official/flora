import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types";
import { DomainError, digest, ensure, integer, object, safeJson, text } from "@app-ops/core";
import { canonicalJson, freeze, sha256 } from "@app-ops/config";
import { assertParsedBaseline, assessReport, CONFIG_RUNTIME_SMOKE_V1 } from "@app-ops/dogfood";
import type { BaselineEvidence, HeadObservation, InventorySnapshot, ReportAssessment, VerificationRecord } from "@app-ops/dogfood";
import type { BaselineSummary, FloraConfig, HostedStore, Page, SnapshotSummary } from "./contracts.js";

type Row = Record<string, string | number | null>;
const PAGE_SIZE = 20;
const ROW_LIMIT = 524288;
const encoder = new TextEncoder();
const baselineColumns = "owner_id,id,snapshot_id,source_digest,request_key,created_at,state,code,platform,node,exit_code,evidence_digest,log_truncated,assessment,safe_log,evidence";
const summaryColumns = "id,snapshot_id,created_at,state,code,platform,node,exit_code,evidence_digest,log_truncated,assessment";

/** A request can verify the explicitly provisioned marker, never create or repair it. */
export async function verifyD1Identity(db: D1Database, config: FloraConfig): Promise<void> {
  const marker = await db.prepare("SELECT owner_id,origin,db_identity FROM flora_deployment WHERE singleton=1").first<Row>();
  ensure(marker && marker.owner_id === config.ownerId && marker.origin === config.origin && marker.db_identity === config.dbIdentity, "CONFIG_CONFLICT");
}
function byteSize(fields: unknown[]): number {
  const size = encoder.encode(canonicalJson(fields)).byteLength;
  ensure(size <= ROW_LIMIT, "INPUT_TOO_LARGE");
  return size;
}
function inventory(row: Row): InventorySnapshot { return freeze(JSON.parse(String(row.data)) as InventorySnapshot); }
function baseline(row: Row): VerificationRecord {
  return freeze({
    id: String(row.id), snapshotId: String(row.snapshot_id), sourceDigest: String(row.source_digest), profileId: CONFIG_RUNTIME_SMOKE_V1.id,
    evidenceKind: "development-baseline", evidenceOrigin: "operator-import", requestKind: "baseline-import",
    state: row.state as VerificationRecord["state"], code: String(row.code), cleanupCode: null,
    requestKey: String(row.request_key), attemptId: null, fence: 0, leaseUntil: null,
    createdAt: Number(row.created_at), updatedAt: Number(row.created_at),
    evidence: JSON.parse(String(row.evidence)) as BaselineEvidence, assessment: JSON.parse(String(row.assessment)) as ReportAssessment,
  });
}
function summary(row: Row): BaselineSummary {
  return freeze({ id: String(row.id), snapshotId: String(row.snapshot_id), createdAt: Number(row.created_at),
    state: row.state as BaselineSummary["state"], code: String(row.code), assessment: JSON.parse(String(row.assessment)) as ReportAssessment,
    platform: row.platform as BaselineSummary["platform"], node: String(row.node), exitCode: row.exit_code === null ? null : Number(row.exit_code),
    evidenceDigest: String(row.evidence_digest), logTruncated: row.log_truncated === 1 });
}
interface Cursor { kind: "inventory" | "baseline"; owner: string; snapshot: string | null; time: number; id: string }
function encodeCursor(value: Cursor): string {
  return btoa(String.fromCharCode(...encoder.encode(canonicalJson(value)))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decodeCursor(value: string | null, kind: Cursor["kind"], owner: string, snapshot: string | null): Cursor | null {
  if (value === null) return null;
  ensure(typeof value === "string" && value.length > 0 && value.length <= 512 && /^[A-Za-z0-9_-]+$/.test(value));
  try {
    const encoded = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(encoded + "=".repeat((4 - encoded.length % 4) % 4));
    const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(binary, c => c.charCodeAt(0))));
    const cursor = object(decoded, ["kind", "owner", "snapshot", "time", "id"]);
    ensure(cursor.kind === kind && cursor.owner === owner && cursor.snapshot === snapshot);
    integer(cursor.time); text(cursor.id, 96);
    const result = cursor as unknown as Cursor;
    ensure(encodeCursor(result) === value);
    return result;
  } catch { throw new DomainError("INVALID_INPUT"); }
}
function page<T>(rows: Row[], map: (row: Row) => T, identity: Omit<Cursor, "time" | "id">, timeColumn: string): Page<T> {
  const visible = rows.slice(0, PAGE_SIZE), last = visible.at(-1);
  return { items: visible.map(map), nextCursor: rows.length > PAGE_SIZE && last
    ? encodeCursor({ ...identity, time: Number(last[timeColumn]), id: String(last.id) }) : null };
}
function writeError(error: unknown): never {
  // Only known constraint outcomes become domain conflicts; outages remain failures.
  if (error instanceof Error && /flora capacity exceeded|one app only|unknown app|baseline source mismatch|UNIQUE constraint failed/.test(error.message)) {
    throw new DomainError("CONFLICT");
  }
  throw error;
}

/** D1 owns facts only. The caller's synchronous hook guards submission, not D1 completion. */
export function createD1ImportStore(db: D1Database, config: FloraConfig, beforeCommit: () => void): HostedStore {
  // Capture immutable authority so a caller cannot switch the owner between awaited operations.
  const identity = { ...config };
  const owner = text(identity.ownerId, 256);
  const verify = () => verifyD1Identity(db, identity);
  const findInventory = (id: string) => db.prepare("SELECT data FROM inventory_snapshots WHERE owner_id=? AND id=?").bind(owner, id).first<Row>();
  async function submit(statements: D1PreparedStatement[]): Promise<D1Result<Row>[]> {
    // No await, callback, or asynchronous validation between this hook and submission.
    beforeCommit();
    try { return await db.batch<Row>(statements); }
    catch (error) { return writeError(error); }
  }
  return {
    async saveInventory(snapshot) {
      safeJson(snapshot);
      const owned = JSON.parse(canonicalJson(snapshot)) as InventorySnapshot;
      text(owned.id, 96); digest(owned.digest); integer(owned.importedAt);
      ensure(owned.evidenceOrigin === "operator-import" && owned.connection === "one-shot-source-snapshot");
      text(owned.repository.id); text(owned.rootDirectory); text(owned.selectedFlavor);
      ensure(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(text(owned.commitSha, 64)));
      ensure(Array.isArray(owned.files) && owned.files.length > 0);
      const paths = new Set<string>();
      for (const file of owned.files) {
        object(file, ["path", "gitBlobSha", "sha256", "byteLength"]);
        text(file.path); digest(file.sha256); integer(file.byteLength);
        ensure(/^[a-f0-9]{40}$/.test(text(file.gitBlobSha, 40)) && !paths.has(file.path)); paths.add(file.path);
      }
      owned.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      const expected = await sha256(canonicalJson({ repository: owned.repository, commitSha: owned.commitSha,
        rootDirectory: owned.rootDirectory, selectedFlavor: owned.selectedFlavor, files: owned.files }));
      ensure(expected === owned.digest);
      await verify();
      const lookup = () => db.prepare("SELECT data FROM inventory_snapshots WHERE owner_id=? AND digest=?").bind(owner, owned.digest);
      const existing = await lookup().first<Row>();
      if (existing) return inventory(existing);
      const fields = [owner, owned.id, owned.digest, owned.repository.id, owned.rootDirectory, owned.commitSha, owned.importedAt, canonicalJson(owned)];
      const size = byteSize(fields);
      const insert = db.prepare(`INSERT INTO inventory_snapshots(owner_id,id,digest,repository_id,root_directory,commit_sha,imported_at,data,stored_bytes)
        SELECT ?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM inventory_snapshots WHERE owner_id=? AND digest=?)
        ON CONFLICT(owner_id,digest) DO NOTHING`).bind(...fields, size, owner, owned.digest);
      const result = await submit([insert, lookup()]);
      const saved = result[1]?.results[0]; ensure(saved, "CONFLICT");
      const receipt = inventory(saved);
      ensure(receipt.digest === owned.digest && receipt.repository.id === owned.repository.id && receipt.rootDirectory === owned.rootDirectory, "IDEMPOTENCY_CONFLICT");
      return receipt;
    },
    async getInventory(snapshotId) {
      text(snapshotId, 96); await verify();
      const found = await findInventory(snapshotId); return found ? inventory(found) : null;
    },
    async persistBaseline(input) {
      object(input, ["snapshotId", "evidence", "assessment", "now"]);
      const snapshotId = text(input.snapshotId, 96), now = integer(input.now), evidence = input.evidence;
      // Preserve the parser-owned frozen object across the database wait; do not serialize/clone first.
      await verify();
      const row = await findInventory(snapshotId); ensure(row, "NOT_FOUND");
      const snapshot = inventory(row);
      assertParsedBaseline(evidence, snapshot);
      const assessment = assessReport(evidence, CONFIG_RUNTIME_SMOKE_V1);
      ensure(canonicalJson(assessment) === canonicalJson(input.assessment));
      const key = evidence.sourceDigest + ":" + evidence.attemptKey;
      const lookup = () => db.prepare(`SELECT ${baselineColumns} FROM baseline_imports WHERE owner_id=? AND request_key=?`).bind(owner, key);
      const check = (found: Row) => {
        ensure(found.snapshot_id === snapshotId && found.source_digest === evidence.sourceDigest && found.evidence_digest === evidence.evidenceDigest, "IDEMPOTENCY_CONFLICT");
        return baseline(found);
      };
      const existing = await lookup().first<Row>();
      if (existing) return check(existing);
      // Revalidate caller-owned prepared assessment after the final read, immediately before encoding.
      assertParsedBaseline(evidence, snapshot);
      ensure(canonicalJson(assessReport(evidence, CONFIG_RUNTIME_SMOKE_V1)) === canonicalJson(input.assessment));
      const id = "verification_" + crypto.randomUUID();
      const fields = [owner, id, snapshotId, evidence.sourceDigest, key, now, assessment.status, assessment.code,
        evidence.platform, evidence.runtime.node, evidence.exitCode, evidence.evidenceDigest, evidence.logTruncated ? 1 : 0,
        canonicalJson(assessment), evidence.safeLog, canonicalJson(evidence)];
      const size = byteSize(fields);
      const insert = db.prepare(`INSERT INTO baseline_imports(${baselineColumns},stored_bytes)
        SELECT ${fields.map(() => "?").join(",")},? WHERE NOT EXISTS(SELECT 1 FROM baseline_imports WHERE owner_id=? AND request_key=?)
        ON CONFLICT(owner_id,request_key) DO NOTHING`).bind(...fields, size, owner, key);
      const result = await submit([insert, lookup()]);
      const saved = result[1]?.results[0]; ensure(saved, "CONFLICT"); return check(saved);
    },
    async saveHeadObservation(observation) {
      const value = object(observation, ["repositoryId", "rootDirectory", "headCommitSha", "observedAt", "evidenceOrigin"]);
      const repositoryId = text(value.repositoryId), rootDirectory = text(value.rootDirectory);
      ensure(value.evidenceOrigin === "operator-import" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(text(value.headCommitSha, 64)));
      const observed = text(value.observedAt, 64);
      const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(observed);
      ensure(match);
      const whole = Date.parse(match[1]! + match[3]!);
      ensure(Number.isFinite(whole) && whole >= 0);
      ensure(new Date(Date.parse(match[1]! + "Z")).toISOString().slice(0, 19) === match[1]);
      const order = (BigInt(whole) * 1000000n + BigInt((match[2] ?? "").padEnd(9, "0"))).toString().padStart(24, "0");
      const fields = [owner, repositoryId, rootDirectory, order, canonicalJson(value)];
      const size = byteSize(fields);
      await verify();
      const statement = db.prepare("INSERT INTO source_head_observations(owner_id,repository_id,root_directory,observed_order,data,stored_bytes) VALUES(?,?,?,?,?,?)").bind(...fields, size);
      await submit([statement]);
    },
    async getHeadObservation(snapshot) {
      const repositoryId = text(snapshot.repository.id), rootDirectory = text(snapshot.rootDirectory);
      await verify();
      const found = await db.prepare("SELECT data FROM source_head_observations WHERE owner_id=? AND repository_id=? AND root_directory=? ORDER BY observed_order DESC,sequence DESC LIMIT 1")
        .bind(owner, repositoryId, rootDirectory).first<Row>();
      return found ? freeze(JSON.parse(String(found.data)) as HeadObservation) : null;
    },
    async pageInventory(cursor) {
      await verify();
      const cursorOwner = await sha256(owner);
      const after = decodeCursor(cursor, "inventory", cursorOwner, null);
      const query = db.prepare(`SELECT id,digest,commit_sha,imported_at FROM inventory_snapshots WHERE owner_id=?
        ${after ? "AND (imported_at<? OR (imported_at=? AND id<?))" : ""} ORDER BY imported_at DESC,id DESC LIMIT 21`);
      const rows = await (after ? query.bind(owner, after.time, after.time, after.id) : query.bind(owner)).all<Row>();
      return page<SnapshotSummary>(rows.results, row => ({ id: String(row.id), digest: String(row.digest), commitSha: String(row.commit_sha), importedAt: Number(row.imported_at) }),
        { kind: "inventory", owner: cursorOwner, snapshot: null }, "imported_at");
    },
    async pageBaselines(snapshotId, cursor) {
      text(snapshotId, 96);
      await verify();
      const cursorOwner = await sha256(owner);
      const after = decodeCursor(cursor, "baseline", cursorOwner, snapshotId);
      const query = db.prepare(`SELECT ${summaryColumns} FROM baseline_imports WHERE owner_id=? AND snapshot_id=?
        ${after ? "AND (created_at<? OR (created_at=? AND id<?))" : ""} ORDER BY created_at DESC,id DESC LIMIT 21`);
      const rows = await (after ? query.bind(owner, snapshotId, after.time, after.time, after.id) : query.bind(owner, snapshotId)).all<Row>();
      return page(rows.results, summary, { kind: "baseline", owner: cursorOwner, snapshot: snapshotId }, "created_at");
    },
    async getSafeLog(recordId) {
      text(recordId, 96); await verify();
      const row = await db.prepare("SELECT id,safe_log,log_truncated FROM baseline_imports WHERE owner_id=? AND id=?").bind(owner, recordId).first<Row>();
      return row ? { id: String(row.id), safeLog: String(row.safe_log), logTruncated: row.log_truncated === 1 } : null;
    },
  };
}
