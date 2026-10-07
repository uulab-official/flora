import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { digest, ensure, integer, object, safeJson, text } from "@app-ops/core";
import { canonicalJson, freeze } from "@app-ops/config";
import type { HeadObservation, InventorySnapshot } from "@app-ops/dogfood";
import { row, rows, transaction } from "./database.js";

export function getInventory(db: DatabaseSync, snapshotId: string): InventorySnapshot | null {
  const found = row(db, "SELECT data FROM inventory_snapshots WHERE id=?", text(snapshotId));
  return found ? freeze(JSON.parse(String(found.data)) as InventorySnapshot) : null;
}
export function listInventory(db: DatabaseSync): InventorySnapshot[] {
  return rows(db, "SELECT data FROM inventory_snapshots ORDER BY imported_at,id").map(r => freeze(JSON.parse(String(r.data)) as InventorySnapshot));
}
export function saveInventory(db: DatabaseSync, snapshot: InventorySnapshot): InventorySnapshot {
  safeJson(snapshot);
  const owned = JSON.parse(canonicalJson(snapshot)) as InventorySnapshot;
  text(owned.id); digest(owned.digest); integer(owned.importedAt);
  ensure(owned.evidenceOrigin === "operator-import" && owned.connection === "one-shot-source-snapshot");
  const expected = createHash("sha256").update(canonicalJson({ repository: owned.repository, commitSha: owned.commitSha, rootDirectory: owned.rootDirectory, selectedFlavor: owned.selectedFlavor, files: owned.files })).digest("hex");
  ensure(expected === owned.digest);
  return transaction(db, () => {
    const first = row(db, "SELECT repository_id,root_directory FROM inventory_snapshots LIMIT 1");
    ensure(!first || (first.repository_id === owned.repository.id && first.root_directory === owned.rootDirectory), "CONFLICT");
    const existing = row(db, "SELECT id FROM inventory_snapshots WHERE digest=?", owned.digest);
    if (existing) return getInventory(db, String(existing.id))!;
    db.prepare("INSERT INTO inventory_snapshots(id,digest,repository_id,root_directory,commit_sha,imported_at,data) VALUES(?,?,?,?,?,?,?)")
      .run(owned.id, owned.digest, owned.repository.id, owned.rootDirectory, owned.commitSha, owned.importedAt, canonicalJson(owned));
    return getInventory(db, owned.id)!;
  });
}
export function saveHeadObservation(db: DatabaseSync, observation: HeadObservation): void {
  const value = object(observation, ["repositoryId", "rootDirectory", "headCommitSha", "observedAt", "evidenceOrigin"]);
  text(value.repositoryId); text(value.rootDirectory);
  ensure(value.evidenceOrigin === "operator-import" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(text(value.headCommitSha)));
  const observed = text(value.observedAt, 64);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(observed);
  ensure(match);
  const whole = Date.parse(match[1]! + match[3]!);
  ensure(Number.isFinite(whole) && whole >= 0);
  // Validate calendar components even when a timezone offset is supplied.
  ensure(new Date(Date.parse(match[1]! + "Z")).toISOString().slice(0, 19) === match[1]);
  const order = (BigInt(whole) * 1000000n + BigInt((match[2] ?? "").padEnd(9, "0"))).toString().padStart(24, "0");
  const data = canonicalJson(value);
  transaction(db, () => {
    ensure(row(db, "SELECT id FROM inventory_snapshots WHERE repository_id=? AND root_directory=? LIMIT 1", String(value.repositoryId), String(value.rootDirectory)), "CONFLICT");
    db.prepare("INSERT INTO source_head_observations(repository_id,root_directory,observed_order,data) VALUES(?,?,?,?)").run(String(value.repositoryId), String(value.rootDirectory), order, data);
  });
}
export function getHeadObservation(db: DatabaseSync, snapshot: InventorySnapshot): HeadObservation | null {
  const found = row(db, "SELECT data FROM source_head_observations WHERE repository_id=? AND root_directory=? ORDER BY observed_order DESC,sequence DESC LIMIT 1", snapshot.repository.id, snapshot.rootDirectory);
  return found ? freeze(JSON.parse(String(found.data)) as HeadObservation) : null;
}
