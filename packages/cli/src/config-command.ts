import { open } from "node:fs/promises";
import {
  object,
  parseCatalog,
  parseTarget,
  parseSourceRevision,
  text,
  ensure,
} from "@app-ops/core";
import { resolveSnapshot } from "@app-ops/config";
import type { Catalog, Target, SourceRevision } from "@app-ops/core";
import type { ConfigSnapshot } from "@app-ops/config";
export interface WorkflowInput {
  catalog: Catalog;
  target: Target;
  source: SourceRevision;
  configEntries: unknown;
  releaseVersion: string;
}
export function parseWorkflow(input: unknown): WorkflowInput {
  const o = object(input, [
    "catalog",
    "target",
    "source",
    "configEntries",
    "releaseVersion",
  ]);
  const catalog = parseCatalog(o.catalog),
    target = parseTarget(o.target, catalog),
    source = parseSourceRevision(o.source, target);
  return {
    catalog,
    target,
    source,
    configEntries: o.configEntries,
    releaseVersion: text(o.releaseVersion, 128),
  };
}
export async function readInputFile(path: string): Promise<Uint8Array> {
  const f = await open(path, "r");
  try {
    ensure((await f.stat()).isFile());
    const buffer = Buffer.alloc(1_048_577);
    let length = 0;
    while (length < buffer.length) {
      const result = await f.read(buffer, length, buffer.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    ensure(length <= 1_048_576);
    return buffer.subarray(0, length);
  } finally {
    await f.close();
  }
}
export function decodeWorkflow(bytes: Uint8Array): WorkflowInput {
  ensure(bytes.byteLength <= 1_048_576);
  return parseWorkflow(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
}
export async function validateConfigFile(
  path: string,
): Promise<ConfigSnapshot> {
  const w = decodeWorkflow(await readInputFile(path));
  return resolveSnapshot({
    target: w.target,
    source: w.source,
    entries: w.configEntries,
  });
}
