import { object, id, text, list, ensure, platform } from "@app-ops/core";
export const levels = {
  organization: 0,
  project: 1,
  application: 2,
  flavor: 3,
  environment: 4,
  platform: 5,
  target: 6,
} as const;
export type Level = keyof typeof levels;
export interface Scope {
  level: Level;
  organizationId: string;
  projectId?: string;
  applicationId?: string;
  flavorId?: string;
  environmentId?: string;
  platform?: "ios" | "android" | "web";
}
export type Binding =
  | { kind: "CONFIG"; value: string }
  | {
      kind: "SECRET" | "FILE" | "CREDENTIAL";
      organizationId: string;
      resourceId: string;
      versionId: string;
    };
export interface ConfigEntry {
  key: string;
  versionId: string;
  scope: Scope;
  binding: Binding;
}
const fields: Record<Level, string[]> = {
  organization: [],
  project: ["projectId"],
  application: ["applicationId"],
  flavor: ["applicationId", "flavorId"],
  environment: ["applicationId", "environmentId"],
  platform: ["applicationId", "platform"],
  target: ["applicationId", "flavorId", "environmentId", "platform"],
};
export function parseConfigEntries(input: unknown): ConfigEntry[] {
  return list(input).map((v) => {
    const o = object(v, ["key", "versionId", "scope", "binding"]);
    const key = text(o.key, 128);
    ensure(/^[A-Z][A-Z0-9_]{0,127}$/.test(key));
    ensure(o.scope !== null && typeof o.scope === "object");
    const level = (o.scope as Record<string, unknown>).level;
    ensure(typeof level === "string" && Object.hasOwn(levels, level));
    const l = level as Level;
    const s = object(o.scope, ["level", "organizationId", ...fields[l]]);
    const scope: Scope = { level: l, organizationId: id(s.organizationId) };
    for (const field of fields[l])
      Object.assign(scope, {
        [field]: field === "platform" ? platform(s[field]) : id(s[field]),
      });
    ensure(o.binding !== null && typeof o.binding === "object");
    const kind = (o.binding as Record<string, unknown>).kind;
    let binding: Binding;
    if (kind === "CONFIG") {
      const b = object(o.binding, ["kind", "value"]);
      ensure(
        typeof b.value === "string" &&
          b.value.length <= 65536 &&
          !b.value.includes("\0"),
      );
      binding = { kind, value: b.value };
    } else {
      ensure(kind === "SECRET" || kind === "FILE" || kind === "CREDENTIAL");
      const b = object(o.binding, [
        "kind",
        "organizationId",
        "resourceId",
        "versionId",
      ]);
      binding = {
        kind,
        organizationId: id(b.organizationId),
        resourceId: id(b.resourceId),
        versionId: id(b.versionId),
      };
    }
    return { key, versionId: id(o.versionId), scope, binding };
  });
}
