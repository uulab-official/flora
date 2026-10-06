import { object, id, text, digest, ensure, safeJson } from "./errors.js";
import type { Target } from "./identity.js";
export interface SourceRevision {
  id: string;
  organizationId: string;
  applicationId: string;
  repositoryId: string;
  commitSha: string;
  rootDirectory: string;
  lockfileDigest: string;
  adapterId: string;
  adapterVersion: string;
  toolchain: Record<string, string>;
}
export function parseSourceRevision(
  value: unknown,
  target: Target,
): SourceRevision {
  const o = object(value, [
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
  const root = text(o.rootDirectory);
  ensure(
    root === "." ||
      (!/[\\:\0]/.test(root) &&
        root.split("/").every((s) => s !== "" && s !== "." && s !== "..")),
  );
  const sha = text(o.commitSha);
  ensure(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha));
  safeJson(o.toolchain);
  ensure(
    o.toolchain !== null &&
      typeof o.toolchain === "object" &&
      !Array.isArray(o.toolchain),
  );
  const toolchain = Object.fromEntries(
    Object.entries(o.toolchain).map(([k, v]) => [text(k, 64), text(v, 128)]),
  );
  const s: SourceRevision = {
    id: id(o.id),
    organizationId: id(o.organizationId),
    applicationId: id(o.applicationId),
    repositoryId: id(o.repositoryId),
    commitSha: sha,
    rootDirectory: root,
    lockfileDigest: digest(o.lockfileDigest),
    adapterId: id(o.adapterId),
    adapterVersion: text(o.adapterVersion, 128),
    toolchain,
  };
  ensure(s.organizationId === target.organizationId, "TENANT_MISMATCH");
  ensure(s.applicationId === target.applicationId, "INVALID_RELATION");
  return s;
}
