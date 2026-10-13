import { ensure, id, integer, object, safeJson, text } from "@app-ops/core";
import { canonicalJson, freeze } from "@app-ops/config";

export interface ApplicationRegistration { name: string; repositoryId: string; rootDirectory: string }
/** Bounded selector metadata; full repository/root identity lives on the selected app. */
export interface ApplicationSummary { id: string; name: string; createdAt: number }
export interface ApplicationSettings { version: number; values: Record<string, string>; updatedAt: number }
export interface ManagedApplication extends ApplicationSummary, ApplicationRegistration { settings: ApplicationSettings }
export interface SettingsUpdate { expectedVersion: number; values: Record<string, string> }
export interface ApplicationStore {
  registerApplication(input: ApplicationRegistration, now: number): Promise<ManagedApplication>;
  listApplications(): Promise<ApplicationSummary[]>;
  getApplication(appId: string): Promise<ManagedApplication | null>;
  getApplicationForSnapshot(snapshotId: string): Promise<ManagedApplication | null>;
  updateApplicationSettings(appId: string, input: SettingsUpdate, now: number): Promise<ManagedApplication>;
}
export function parseApplicationRegistration(input: unknown): ApplicationRegistration {
  const value = object(input, ["name", "repositoryId", "rootDirectory"]);
  const rootDirectory = text(value.rootDirectory, 4096);
  ensure(rootDirectory === "." || (!/[\\:\u0000-\u001f\u007f]/.test(rootDirectory)
    && rootDirectory.split("/").every(part => part !== "" && part !== "." && part !== ".." && !["__proto__", "prototype", "constructor"].includes(part))));
  return freeze({ name: text(value.name, 256), repositoryId: text(value.repositoryId, 4096), rootDirectory });
}
/** Plain public configuration only. Credentials remain outside this registry. */
export function parseSettingsUpdate(input: unknown): SettingsUpdate {
  const value = object(input, ["expectedVersion", "values"]);
  const expectedVersion = integer(value.expectedVersion, 0, Number.MAX_SAFE_INTEGER - 1);
  safeJson(value.values);
  ensure(value.values !== null && typeof value.values === "object" && !Array.isArray(value.values));
  const values: Record<string, string> = {};
  const entries = Object.entries(value.values);
  ensure(entries.length <= 64);
  for (const [key, item] of entries) {
    ensure(/^[A-Z][A-Z0-9_]{0,127}$/.test(key) && typeof item === "string" && item.length <= 2048 && !item.includes("\0"));
    values[key] = item;
  }
  ensure(new TextEncoder().encode(canonicalJson(values)).byteLength <= 8192);
  return freeze({ expectedVersion, values });
}
export function applicationId(value: unknown): string { return id(value); }
