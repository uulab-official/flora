import type { DatabaseSync } from "node:sqlite";
import {
  parseCatalog,
  targetShape,
  parseSourceRevision,
  ensure,
  object,
  id,
  text,
} from "@app-ops/core";
import type { Catalog, Target, SourceRevision } from "@app-ops/core";
import { canonicalJson } from "@app-ops/config";
import { transaction, row } from "./database.js";
export function immutableInsert(
  db: DatabaseSync,
  table: string,
  columns: Record<string, string | number>,
  data: unknown,
): void {
  const canonical = canonicalJson(data);
  const existing =
    columns.org_id === undefined
      ? row(db, `SELECT data FROM ${table} WHERE id=?`, String(columns.id))
      : row(
          db,
          `SELECT data FROM ${table} WHERE org_id=? AND id=?`,
          String(columns.org_id),
          String(columns.id),
        );
  if (existing) {
    ensure(existing.data === canonical, "CONFLICT");
    return;
  }
  const names = [...Object.keys(columns), "data"];
  db.prepare(
    `INSERT INTO ${table}(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`,
  ).run(...Object.values(columns), canonical);
}
export function insertCatalog(db: DatabaseSync, input: Catalog): void {
  const c = parseCatalog(input);
  transaction(db, () => {
    for (const o of c.organizations)
      immutableInsert(db, "organizations", { id: o.id }, o);
    for (const p of c.projects)
      immutableInsert(
        db,
        "projects",
        { org_id: p.organizationId, id: p.id },
        p,
      );
    for (const a of c.applications)
      immutableInsert(
        db,
        "applications",
        { org_id: a.organizationId, id: a.id, project_id: a.projectId },
        a,
      );
    for (const [table, items] of [
      ["flavors", c.flavors],
      ["environments", c.environments],
    ] as const)
      for (const x of items)
        immutableInsert(
          db,
          table,
          { org_id: x.organizationId, id: x.id, app_id: x.applicationId },
          x,
        );
  });
}
export function saveTarget(db: DatabaseSync, input: Target): void {
  const t = targetShape(input);
  transaction(db, () =>
    immutableInsert(
      db,
      "platform_targets",
      {
        org_id: t.organizationId,
        id: t.id,
        project_id: t.projectId,
        app_id: t.applicationId,
        flavor_id: t.flavorId,
        environment_id: t.environmentId,
        platform: t.platform,
      },
      t,
    ),
  );
}
export function saveSource(db: DatabaseSync, input: SourceRevision): void {
  object(input, [
    "id",
    "organizationId",
    "applicationId",
    "repositoryId",
    "commitSha",
    "rootDirectory",
    "lockfileDigest",
    "adapterId",
    "adapterVersion",
    "toolchain",
  ]);
  const s = parseSourceRevision(input, {
    organizationId: input.organizationId,
    applicationId: input.applicationId,
  } as Target);
  transaction(db, () =>
    immutableInsert(
      db,
      "source_revisions",
      { org_id: s.organizationId, id: s.id, app_id: s.applicationId },
      s,
    ),
  );
}
export interface ReleaseInput {
  id: string;
  organizationId: string;
  applicationId: string;
  sourceRevisionId: string;
  version: string;
  createdBy: string;
}
export function createRelease(
  db: DatabaseSync,
  input: ReleaseInput,
): ReleaseInput {
  const o = object(input, [
    "id",
    "organizationId",
    "applicationId",
    "sourceRevisionId",
    "version",
    "createdBy",
  ]);
  const r: ReleaseInput = {
    id: id(o.id),
    organizationId: id(o.organizationId),
    applicationId: id(o.applicationId),
    sourceRevisionId: id(o.sourceRevisionId),
    version: text(o.version, 128),
    createdBy: id(o.createdBy),
  };
  transaction(db, () =>
    immutableInsert(
      db,
      "releases",
      {
        org_id: r.organizationId,
        id: r.id,
        app_id: r.applicationId,
        source_id: r.sourceRevisionId,
      },
      r,
    ),
  );
  return r;
}
