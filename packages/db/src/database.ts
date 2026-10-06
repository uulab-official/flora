import { DatabaseSync } from "node:sqlite";
import { DomainError } from "@app-ops/core";
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    allowExtension: false,
    timeout: 5000,
  });
  db.exec("PRAGMA recursive_triggers=ON");
  return db;
}
export function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = run();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      error instanceof Error && error.message.includes("FOREIGN KEY")
        ? "INVALID_RELATION"
        : "CONFLICT",
    );
  }
}
export type Row = Record<string, string | number | null>;
export function row(
  db: DatabaseSync,
  sql: string,
  ...args: (string | number | null)[]
): Row | undefined {
  return db.prepare(sql).get(...args) as Row | undefined;
}
export function rows(
  db: DatabaseSync,
  sql: string,
  ...args: (string | number | null)[]
): Row[] {
  return db.prepare(sql).all(...args) as Row[];
}
