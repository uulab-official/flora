import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ensure, integer, text } from "@app-ops/core";
import { canonicalJson, freeze } from "@app-ops/config";
import { applicationId, parseApplicationRegistration, parseSettingsUpdate } from "@app-ops/dogfood";
import type { ApplicationRegistration, ApplicationSummary, ManagedApplication, SettingsUpdate } from "@app-ops/dogfood";
import { row, rows, transaction } from "./database.js";
import type { Row } from "./database.js";
function summary(r: Row): ApplicationSummary {
  return { id: String(r.app_id), name: String(r.name), createdAt: Number(r.created_at) };
}
export function getApplication(db: DatabaseSync, appId: string): ManagedApplication | null {
  const found = row(db, `SELECT a.*,h.values_json,h.updated_at FROM managed_applications a JOIN application_settings_history h ON h.app_id=a.app_id AND h.version=a.settings_version WHERE a.app_id=?`, applicationId(appId));
  return found ? freeze({ ...summary(found), repositoryId: String(found.repository_id), rootDirectory: String(found.root_directory), settings: { version: Number(found.settings_version), values: JSON.parse(String(found.values_json)) as Record<string,string>, updatedAt: Number(found.updated_at) } }) : null;
}
export function listApplications(db: DatabaseSync): ApplicationSummary[] {
  return rows(db, "SELECT * FROM managed_applications ORDER BY created_at,app_id").map(r => freeze(summary(r)));
}
export function getApplicationForSnapshot(db: DatabaseSync, snapshotId: string): ManagedApplication | null {
  const found = row(db, "SELECT a.app_id FROM managed_applications a JOIN inventory_snapshots s ON a.repository_id=s.repository_id AND a.root_directory=s.root_directory WHERE s.id=?", text(snapshotId));
  return found ? getApplication(db, String(found.app_id)) : null;
}
/** Must be called inside the importing or registration transaction. */
export function registerApplicationInTransaction(db: DatabaseSync, input: ApplicationRegistration, now: number, automatic = false): ManagedApplication {
  const value = parseApplicationRegistration(input); integer(now);
  const found = row(db, "SELECT app_id,name FROM managed_applications WHERE repository_id=? AND root_directory=?", value.repositoryId, value.rootDirectory);
  if (found) { ensure(automatic || found.name === value.name, "CONFLICT"); return getApplication(db, String(found.app_id))!; }
  ensure(Number(row(db, "SELECT count(*) n FROM managed_applications")!.n) < 100, "CONFLICT");
  const appId = "app_" + randomUUID();
  db.prepare("INSERT INTO managed_applications(app_id,name,repository_id,root_directory,created_at) VALUES(?,?,?,?,?)").run(appId,value.name,value.repositoryId,value.rootDirectory,now);
  db.prepare("INSERT INTO application_settings_history VALUES(?,0,'{}',?)").run(appId,now);
  return getApplication(db,appId)!;
}
export function registerApplication(db: DatabaseSync, input: ApplicationRegistration, now: number): ManagedApplication {
  const value = parseApplicationRegistration(input); integer(now);
  return transaction(db, () => registerApplicationInTransaction(db,value,now));
}
export function updateApplicationSettings(db: DatabaseSync, appId: string, input: SettingsUpdate, now: number): ManagedApplication {
  applicationId(appId); const value = parseSettingsUpdate(input); integer(now);
  return transaction(db, () => {
    const current = getApplication(db,appId); ensure(current,"NOT_FOUND");
    ensure(current.settings.version === value.expectedVersion,"CONFLICT"); ensure(now >= current.settings.updatedAt);
    db.prepare("INSERT INTO application_settings_history VALUES(?,?,?,?)").run(appId,value.expectedVersion+1,canonicalJson(value.values),now);
    ensure(db.prepare("UPDATE managed_applications SET settings_version=settings_version+1 WHERE app_id=? AND settings_version=?").run(appId,value.expectedVersion).changes === 1,"CONFLICT");
    return getApplication(db,appId)!;
  });
}
