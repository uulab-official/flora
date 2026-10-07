import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ensure } from "@app-ops/core";
import { transaction, rows } from "./database.js";
export function migrate(db: DatabaseSync): void {
  const migrations = ["0001_foundation.sql", "0002_dogfood.sql"].map((name, i) => {
    const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    return { version: i + 1, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  });
  transaction(db, () => {
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL) STRICT");
    const applied = rows(db, "SELECT version,checksum FROM schema_migrations ORDER BY version");
    ensure(applied.length <= migrations.length, "MIGRATION_MISMATCH");
    for (const [i, record] of applied.entries()) {
      ensure(record.version === i + 1 && record.checksum === migrations[i]!.checksum, "MIGRATION_MISMATCH");
    }
    for (const migration of migrations.slice(applied.length)) {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(migration.version, migration.checksum);
    }
  });
}
