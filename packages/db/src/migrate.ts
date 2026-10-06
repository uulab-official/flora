import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ensure } from "@app-ops/core";
import { transaction, row } from "./database.js";
export function migrate(db: DatabaseSync): void {
  const sql = readFileSync(
    new URL("../migrations/0001_foundation.sql", import.meta.url),
    "utf8",
  );
  const checksum = createHash("sha256").update(sql).digest("hex");
  transaction(db, () => {
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL) STRICT",
    );
    const applied = row(
      db,
      "SELECT checksum FROM schema_migrations WHERE version=1",
    );
    if (applied) {
      ensure(applied.checksum === checksum, "MIGRATION_MISMATCH");
      return;
    }
    db.exec(sql);
    db.prepare("INSERT INTO schema_migrations VALUES(1,?)").run(checksum);
  });
}
