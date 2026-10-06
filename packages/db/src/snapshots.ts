import type { DatabaseSync } from "node:sqlite";
import { ensure, object } from "@app-ops/core";
import { resolveSnapshot, canonicalJson } from "@app-ops/config";
import type { ConfigSnapshot } from "@app-ops/config";
import { transaction, row } from "./database.js";
import { immutableInsert } from "./catalog.js";
export async function saveSnapshot(
  db: DatabaseSync,
  input: ConfigSnapshot,
): Promise<void> {
  object(input, [
    "schemaVersion",
    "id",
    "digest",
    "target",
    "source",
    "entries",
  ]);
  ensure(input.schemaVersion === 1);
  const s = await resolveSnapshot({
    target: input.target,
    source: input.source,
    entries: input.entries,
  });
  ensure(
    s.id === input.id &&
      s.digest === input.digest &&
      canonicalJson(s) === canonicalJson(input),
  );
  transaction(db, () => {
    const source = row(
      db,
      "SELECT data FROM source_revisions WHERE org_id=? AND id=?",
      s.target.organizationId,
      s.source.id,
    );
    const target = row(
      db,
      "SELECT data FROM platform_targets WHERE org_id=? AND id=?",
      s.target.organizationId,
      s.target.id,
    );
    ensure(
      source?.data === canonicalJson(s.source) &&
        target?.data === canonicalJson(s.target),
      "INVALID_RELATION",
    );
    const existing = row(
      db,
      "SELECT id FROM config_snapshots WHERE org_id=? AND id=?",
      s.target.organizationId,
      s.id,
    );
    immutableInsert(
      db,
      "config_snapshots",
      {
        org_id: s.target.organizationId,
        id: s.id,
        app_id: s.target.applicationId,
        target_id: s.target.id,
        source_id: s.source.id,
        digest: s.digest,
      },
      s,
    );
    if (!existing)
      for (const entry of s.entries)
        if (entry.binding.kind !== "CONFIG")
          db.prepare("INSERT INTO snapshot_references VALUES(?,?,?,?,?,?)").run(
            s.target.organizationId,
            s.id,
            entry.key,
            entry.binding.kind,
            entry.binding.resourceId,
            entry.binding.versionId,
          );
  });
}
