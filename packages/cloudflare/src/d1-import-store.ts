import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types";
import { DomainError, digest, ensure, integer, object, safeJson, text } from "@app-ops/core";
import { canonicalJson, freeze, sha256 } from "@app-ops/config";
import { applicationId, parseApplicationRegistration, parseSettingsUpdate, assertParsedBaseline, assessReport, CONFIG_RUNTIME_SMOKE_V1 } from "@app-ops/dogfood";
import type { ApplicationRegistration, ApplicationStore, ManagedApplication, BaselineEvidence, HeadObservation, InventorySnapshot, ReportAssessment, VerificationRecord } from "@app-ops/dogfood";
import { createD1AutomationStore } from "./automation-store.js";
import { createD1OperationsStore } from "./operations-store.js";
import type { BaselineSummary, FloraConfig, HostedStore, Page, SnapshotSummary, ReadScope, MutationSubmit } from "./contracts.js";

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
interface Cursor { kind: "inventory" | "baseline"; owner: string; snapshot: string | null; app?: string; scope?: string; time: number; id: string }
function encodeCursor(value: Cursor): string {
  return btoa(String.fromCharCode(...encoder.encode(canonicalJson(value)))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decodeCursor(value: string | null, kind: Cursor["kind"], owner: string, snapshot: string | null, app?: string, scope?: string): Cursor | null {
  if (value === null) return null;
  ensure(typeof value === "string" && value.length > 0 && value.length <= 512 && /^[A-Za-z0-9_-]+$/.test(value));
  try {
    const encoded = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(encoded + "=".repeat((4 - encoded.length % 4) % 4));
    const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(binary, c => c.charCodeAt(0))));
    const cursor = object(decoded, ["kind", "owner", "snapshot", "time", "id", ...(app === undefined ? [] : ["app"]), ...(scope === undefined ? [] : ["scope"])]);
    ensure(cursor.kind === kind && cursor.owner === owner && cursor.snapshot === snapshot && cursor.app === app && cursor.scope === scope);
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
  if (error instanceof Error && /flora capacity exceeded|one app only|unknown app|baseline source mismatch|UNIQUE constraint failed|settings version conflict/.test(error.message)) {
    throw new DomainError("CONFLICT");
  }
  throw error;
}

/** D1 owns facts only. The caller's synchronous hook guards submission, not D1 completion. */
export function createD1ImportStore(db: D1Database, config: FloraConfig, beforeCommit: () => void, externalAssets?:import("./external-assets.js").ExternalOTAAssets, scope?:ReadScope, mutate?:MutationSubmit,readFence?:()=>void,selection?:()=>{appIds:string[];platforms:string[]}|undefined): HostedStore {
  // Capture immutable authority so a caller cannot switch the owner between awaited operations.
  const identity = { ...config };
  const owner = text(identity.ownerId, 256);
  const visible=scope?Object.freeze([...scope.appIds]):undefined;
  const scopeKey=scope?JSON.stringify([scope.subject,scope.permissionRevision,visible]):undefined;
  const scopeSql=visible?" AND a.id IN(SELECT value FROM json_each(?))":"";
  const scopeBinds=visible?[JSON.stringify(visible)]:[];
  const allow=(appId:string)=>ensure(!visible||visible.includes(appId),"NOT_FOUND");
  const verify = async () => {readFence?.();await verifyD1Identity(db, identity);readFence?.();};
  const repositoryScope=visible?" AND EXISTS(SELECT 1 FROM applications a WHERE a.owner_id=inventory_snapshots.owner_id AND a.repository_id=inventory_snapshots.repository_id AND a.root_directory=inventory_snapshots.root_directory"+scopeSql+")":"";
  const findInventory = (id: string) => db.prepare("SELECT data FROM inventory_snapshots WHERE owner_id=? AND id=?"+repositoryScope).bind(owner, id,...scopeBinds).first<Row>();
  async function submit(statements: D1PreparedStatement[]): Promise<D1Result<Row>[]> {
    // No await, callback, or asynchronous validation between this hook and submission.
    beforeCommit();
    try { return await (mutate?mutate(()=>db.batch<Row>(statements)):db.batch<Row>(statements)); }
    catch (error) { return writeError(error); }
  }
  const appColumns = "a.id,a.name,a.repository_id,a.root_directory,a.created_at,s.version,s.values_json,s.updated_at";
  function managed(row: Row): ManagedApplication {
    return freeze({ id: String(row.id), name: String(row.name), repositoryId: String(row.repository_id), rootDirectory: String(row.root_directory),
      createdAt: Number(row.created_at), settings: { version: Number(row.version), values: JSON.parse(String(row.values_json)), updatedAt: Number(row.updated_at) } });
  }
  const appQuery = `SELECT ${appColumns} FROM applications a JOIN application_settings s ON s.owner_id=a.owner_id AND s.app_id=a.id
    AND s.version=(SELECT max(version) FROM application_settings WHERE owner_id=a.owner_id AND app_id=a.id) WHERE a.owner_id=?`;
  async function getApp(appId: string) {
    applicationId(appId); allow(appId); await verify();
    const row = await db.prepare(appQuery + " AND a.id=?").bind(owner, appId).first<Row>();
    return row ? managed(row) : null;
  }
  function registrationStatements(value: ApplicationRegistration, now: number): D1PreparedStatement[] {
    const id = "application_" + crypto.randomUUID();
    const fields = [owner, id, value.name, value.repositoryId, value.rootDirectory, now];
    const settings = [owner, id, 0, "{}", now];
    return [
      db.prepare(`INSERT INTO applications(owner_id,id,name,repository_id,root_directory,created_at,stored_bytes)
        SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM applications WHERE owner_id=? AND repository_id=? AND root_directory=?)`)
        .bind(...fields, byteSize(fields), owner, value.repositoryId, value.rootDirectory),
      db.prepare(`INSERT INTO application_settings(owner_id,app_id,version,values_json,updated_at,stored_bytes)
        SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM applications WHERE owner_id=? AND id=?)`)
        .bind(...settings, byteSize(settings), owner, id),
    ];
  }
  const applications: ApplicationStore = {
    async registerApplication(input, now) {
      ensure(!scope,"PERMISSION_DENIED");
      const value = parseApplicationRegistration(input); integer(now); await verify();
      const lookup = () => db.prepare(appQuery + " AND a.repository_id=? AND a.root_directory=?").bind(owner, value.repositoryId, value.rootDirectory);
      const check = (row: Row) => { ensure(row.name === value.name, "CONFLICT"); return managed(row); };
      const existing = await lookup().first<Row>(); if (existing) return check(existing);
      const inserted = await submit([...registrationStatements(value, now), lookup()]);
      const row = inserted[2]?.results[0]; ensure(row, "CONFLICT"); return check(row);
    },
    async listApplications() {
      await verify();
      const rows = await db.prepare("SELECT a.id,a.name,a.created_at FROM applications a WHERE a.owner_id=?"+scopeSql+" ORDER BY a.created_at,a.id LIMIT 100").bind(owner,...scopeBinds).all<Row>();
      return rows.results.map(row => freeze({ id: String(row.id), name: String(row.name), createdAt: Number(row.created_at) }));
    },
    getApplication: getApp,
    async getApplicationForSnapshot(snapshotId) {
      text(snapshotId, 96); await verify();
      const row = await db.prepare(appQuery + scopeSql + " AND EXISTS(SELECT 1 FROM inventory_snapshots i WHERE i.owner_id=a.owner_id AND i.repository_id=a.repository_id AND i.root_directory=a.root_directory AND i.id=?)")
        .bind(owner, ...scopeBinds, snapshotId).first<Row>();
      return row ? managed(row) : null;
    },
    async updateApplicationSettings(appId, input, now) {
      applicationId(appId); const value = parseSettingsUpdate(input); integer(now);
      const current = await getApp(appId); ensure(current, "NOT_FOUND");
      ensure(current.settings.version === value.expectedVersion, "CONFLICT");
      ensure(now >= current.settings.updatedAt);
      const fields = [owner, appId, value.expectedVersion + 1, canonicalJson(value.values), now];
      const results = await submit([
        db.prepare(`INSERT INTO application_settings(owner_id,app_id,version,values_json,updated_at,stored_bytes)
          SELECT ?,?,?,?,?,? WHERE (SELECT max(version) FROM application_settings WHERE owner_id=? AND app_id=?)=?
          AND (SELECT updated_at FROM application_settings WHERE owner_id=? AND app_id=? AND version=?)<=?`)
          .bind(...fields, byteSize(fields), owner, appId, value.expectedVersion, owner, appId, value.expectedVersion, now),
        db.prepare(appQuery + " AND a.id=?").bind(owner, appId),
      ]);
      ensure((results[0]?.meta.changes ?? 0) > 0, "CONFLICT"); const row = results[1]?.results[0]; ensure(row, "CONFLICT"); return managed(row);
    },
  };
  const operations = createD1OperationsStore(db, owner, applications, verify, beforeCommit,externalAssets,mutate);
  return {
    automation: createD1AutomationStore(db, owner, applications, operations, verify, beforeCommit,mutate,scope,selection),
    operations,
    applications,
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
      const registration = parseApplicationRegistration({ name: owned.repository.id.slice(0, 256), repositoryId: owned.repository.id, rootDirectory: owned.rootDirectory });
      const insert = db.prepare(`INSERT INTO inventory_snapshots(owner_id,id,digest,repository_id,root_directory,commit_sha,imported_at,data,stored_bytes)
        SELECT ?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM inventory_snapshots WHERE owner_id=? AND digest=?)
        ON CONFLICT(owner_id,digest) DO NOTHING`).bind(...fields, size, owner, owned.digest);
      if(scope){const matching=await db.prepare(appQuery+scopeSql+" AND a.repository_id=? AND a.root_directory=?").bind(owner,...scopeBinds,owned.repository.id,owned.rootDirectory).first<Row>();ensure(matching,"NOT_FOUND");}
      const registrations=scope?[]:registrationStatements(registration, owned.importedAt);
      const result = await submit([...registrations, insert, lookup()]);
      const saved = result[registrations.length+1]?.results[0]; ensure(saved, "CONFLICT");
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
    async pageInventory(cursor, appId) {
      await verify();
      const cursorOwner = await sha256(owner), cursorScope=scopeKey?await sha256(scopeKey):undefined;
      const app = appId === undefined ? null : await getApp(appId);
      if (appId !== undefined) ensure(app, "NOT_FOUND");
      const after = decodeCursor(cursor, "inventory", cursorOwner, null, appId, cursorScope);
      const query = db.prepare(`SELECT id,digest,commit_sha,imported_at FROM inventory_snapshots WHERE owner_id=?
        ${app ? "AND repository_id=? AND root_directory=?" : ""} ${repositoryScope}
        ${after ? "AND (imported_at<? OR (imported_at=? AND id<?))" : ""} ORDER BY imported_at DESC,id DESC LIMIT 21`);
      const binds = [owner, ...(app ? [app.repositoryId, app.rootDirectory] : []), ...scopeBinds, ...(after ? [after.time, after.time, after.id] : [])];
      const rows = await query.bind(...binds).all<Row>();
      return page<SnapshotSummary>(rows.results, row => ({ id: String(row.id), digest: String(row.digest), commitSha: String(row.commit_sha), importedAt: Number(row.imported_at) }),
        { kind: "inventory", owner: cursorOwner, snapshot: null, ...(cursorScope?{scope:cursorScope}:{}), ...(appId === undefined ? {} : { app: appId }) }, "imported_at");
    },
    async pageBaselines(snapshotId, cursor, appId) {
      text(snapshotId, 96);
      await verify();
      const cursorOwner = await sha256(owner), cursorScope=scopeKey?await sha256(scopeKey):undefined;
      if (appId !== undefined || scope) {const app=await applications.getApplicationForSnapshot(snapshotId);ensure(app&&(appId===undefined||app.id===applicationId(appId)), "NOT_FOUND");}
      const after = decodeCursor(cursor, "baseline", cursorOwner, snapshotId, appId, cursorScope);
      const query = db.prepare(`SELECT ${summaryColumns} FROM baseline_imports WHERE owner_id=? AND snapshot_id=?
        ${after ? "AND (created_at<? OR (created_at=? AND id<?))" : ""} ORDER BY created_at DESC,id DESC LIMIT 21`);
      const rows = await (after ? query.bind(owner, snapshotId, after.time, after.time, after.id) : query.bind(owner, snapshotId)).all<Row>();
      return page(rows.results, summary, { kind: "baseline", owner: cursorOwner, snapshot: snapshotId, ...(cursorScope?{scope:cursorScope}:{}), ...(appId === undefined ? {} : { app: appId }) }, "created_at");
    },
    async getSafeLog(recordId, appId) {
      text(recordId, 96); if(appId)allow(appId);await verify();
      const row = await db.prepare(`SELECT id,safe_log,log_truncated FROM baseline_imports WHERE owner_id=? AND id=? ${visible?"AND EXISTS(SELECT 1 FROM inventory_snapshots i JOIN applications a ON a.owner_id=i.owner_id AND a.repository_id=i.repository_id AND a.root_directory=i.root_directory WHERE i.owner_id=baseline_imports.owner_id AND i.id=baseline_imports.snapshot_id"+scopeSql+")":""} ${appId === undefined ? "" : "AND EXISTS(SELECT 1 FROM inventory_snapshots i JOIN applications a ON a.owner_id=i.owner_id AND a.repository_id=i.repository_id AND a.root_directory=i.root_directory WHERE i.owner_id=baseline_imports.owner_id AND i.id=baseline_imports.snapshot_id AND a.id=?)"}`).bind(owner, recordId,...scopeBinds, ...(appId === undefined ? [] : [applicationId(appId)])).first<Row>();
      return row ? { id: String(row.id), safeLog: String(row.safe_log), logTruncated: row.log_truncated === 1 } : null;
    },
  };
}
