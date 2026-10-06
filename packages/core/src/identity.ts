import { object, id, list, ensure } from "./errors.js";
export type Platform = "ios" | "android" | "web";
export interface Organization {
  id: string;
}
export interface Project {
  id: string;
  organizationId: string;
}
export interface Application extends Project {
  projectId: string;
}
export interface AppChild extends Project {
  applicationId: string;
}
export interface Catalog {
  organizations: Organization[];
  projects: Project[];
  applications: Application[];
  flavors: AppChild[];
  environments: AppChild[];
}
export interface Target {
  id: string;
  organizationId: string;
  projectId: string;
  applicationId: string;
  flavorId: string;
  environmentId: string;
  platform: Platform;
}
export function platform(v: unknown): Platform {
  ensure(v === "ios" || v === "android" || v === "web");
  return v;
}
function members<T>(value: unknown, keys: readonly string[]): T[] {
  const seen = new Set<string>();
  return list(value).map((v) => {
    const o = object(v, keys);
    const parsed = Object.fromEntries(keys.map((k) => [k, id(o[k])]));
    const key = String(parsed.organizationId ?? "") + ":" + parsed.id;
    ensure(!seen.has(key));
    seen.add(key);
    return parsed as T;
  });
}
function related<T extends Project>(rows: T[], value: string, org: string): T {
  const item = rows.find((x) => x.id === value && x.organizationId === org);
  ensure(
    item,
    rows.some((x) => x.id === value) ? "TENANT_MISMATCH" : "INVALID_RELATION",
  );
  return item;
}
export function parseCatalog(value: unknown): Catalog {
  const o = object(value, [
    "organizations",
    "projects",
    "applications",
    "flavors",
    "environments",
  ]);
  const c: Catalog = {
    organizations: members(o.organizations, ["id"]),
    projects: members(o.projects, ["id", "organizationId"]),
    applications: members(o.applications, [
      "id",
      "organizationId",
      "projectId",
    ]),
    flavors: members(o.flavors, ["id", "organizationId", "applicationId"]),
    environments: members(o.environments, [
      "id",
      "organizationId",
      "applicationId",
    ]),
  };
  for (const p of c.projects)
    ensure(
      c.organizations.some((x) => x.id === p.organizationId),
      "INVALID_RELATION",
    );
  for (const a of c.applications)
    related(c.projects, a.projectId, a.organizationId);
  for (const child of [...c.flavors, ...c.environments])
    related(c.applications, child.applicationId, child.organizationId);
  return c;
}
export function targetShape(value: unknown): Target {
  const keys = [
    "id",
    "organizationId",
    "projectId",
    "applicationId",
    "flavorId",
    "environmentId",
    "platform",
  ];
  const o = object(value, keys);
  return {
    id: id(o.id),
    organizationId: id(o.organizationId),
    projectId: id(o.projectId),
    applicationId: id(o.applicationId),
    flavorId: id(o.flavorId),
    environmentId: id(o.environmentId),
    platform: platform(o.platform),
  };
}
export function parseTarget(value: unknown, catalog: Catalog): Target {
  const c = parseCatalog(catalog);
  const t = targetShape(value);
  ensure(
    c.organizations.some((x) => x.id === t.organizationId),
    "INVALID_RELATION",
  );
  related(c.projects, t.projectId, t.organizationId);
  const a = related(c.applications, t.applicationId, t.organizationId);
  ensure(a.projectId === t.projectId, "INVALID_RELATION");
  for (const [rows, key] of [
    [c.flavors, t.flavorId],
    [c.environments, t.environmentId],
  ] as const)
    ensure(
      related(rows, key, t.organizationId).applicationId === t.applicationId,
      "INVALID_RELATION",
    );
  return t;
}
