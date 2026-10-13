import {
  ensure,
  object,
  targetShape,
  parseSourceRevision,
} from "@app-ops/core";
import type { Target, SourceRevision } from "@app-ops/core";
import { parseConfigEntries, levels } from "./schema.js";
import type { ConfigEntry } from "./schema.js";
import { canonicalJson, sha256, freeze } from "./canonical.js";
export interface ConfigSnapshot {
  schemaVersion: 1;
  id: string;
  digest: string;
  target: Target;
  source: SourceRevision;
  entries: readonly ConfigEntry[];
}
export async function resolveSnapshot(input: {
  target: Target;
  source: SourceRevision;
  entries: unknown;
}): Promise<ConfigSnapshot> {
  object(input, ["target", "source", "entries"]);
  const target = targetShape(input.target);
  const source = parseSourceRevision(input.source, target);
  const entries = parseConfigEntries(input.entries);
  const winners = new Map<string, ConfigEntry>();
  const seen = new Set<string>();
  for (const e of entries) {
    ensure(e.scope.organizationId === target.organizationId, "TENANT_MISMATCH");
    if (e.binding.kind !== "CONFIG")
      ensure(
        e.binding.organizationId === target.organizationId,
        "TENANT_MISMATCH",
      );
    const matches = Object.entries(e.scope).every(
      ([key, value]) =>
        key === "level" || target[key as keyof Target] === value,
    );
    if (!matches) continue;
    const unique = e.key + ":" + e.scope.level;
    ensure(!seen.has(unique), "CONFIG_CONFLICT");
    seen.add(unique);
    const previous = winners.get(e.key);
    if (previous) {
      ensure(previous.binding.kind === e.binding.kind, "CONFIG_CONFLICT");
      if (levels[previous.scope.level] > levels[e.scope.level]) continue;
    }
    winners.set(e.key, e);
  }
  const data = {
    schemaVersion: 1 as const,
    target,
    source,
    entries: [...winners.values()].sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
    ),
  };
  const canonical = canonicalJson(data);
  const checksum = await sha256(canonical);
  return freeze({
    ...(JSON.parse(canonical) as typeof data),
    id: "cfg_" + checksum,
    digest: checksum,
  });
}
