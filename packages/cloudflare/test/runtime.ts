import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { Json } from "miniflare";

export interface TestRuntimeOptions {
  entrypoint: string | URL;
  bindings?: Record<string, Json>;
  /** Every test DO is SQLite backed. Keys are bindings; values are class exports. */
  durableObjects?: Record<string, string>;
}

/** Local-only workerd harness. No account, remote proxy, credentials or deployment. */
export async function createTestRuntime(options: TestRuntimeOptions) {
  const directory = await mkdtemp(join(tmpdir(), "flora-runtime-"));
  let mf: Miniflare | undefined;
  try {
    const entrypoint = options.entrypoint instanceof URL ? fileURLToPath(options.entrypoint) : resolve(options.entrypoint);
    const output = await build({ entryPoints: [entrypoint], bundle: true, format: "esm", platform: "browser",
      target: "es2023", external: ["cloudflare:*", "node:*"], write: false, metafile: true });
    const script = output.outputFiles[0]?.text;
    if (!script) throw new Error("Missing test Worker bundle");
    mf = new Miniflare(convertV4MiniflareOptions({
      name: "flora-test", modules: true, script, compatibilityDate: "2026-10-07", compatibilityFlags: ["nodejs_compat"],
      host: "127.0.0.1", port: 0, cf: false, telemetry: { enabled: false },
      resourcePersistencePath: directory,
      bindings: options.bindings ?? {},
      d1Databases: { FLORA_DB: "flora-synthetic-db" },
      durableObjects: Object.fromEntries(Object.entries(options.durableObjects ?? {}).map(([name, className]) => [name, { className, useSQLite: true }])),
      outboundService: () => new Response("External network disabled in synthetic tests", { status: 503 }),
    }));
    const runtime = mf;
    const d1 = await runtime.getD1Database("FLORA_DB");
    return {
      mf: runtime, d1, inputs: Object.keys(output.metafile.inputs),
      namespace: (name: string) => runtime.getDurableObjectNamespace(name),
      fetch: runtime.dispatchFetch.bind(runtime),
      async dispose(): Promise<void> {
        try { await runtime.dispose(); }
        finally { await rm(directory, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    try { await mf?.dispose(); }
    finally { await rm(directory, { recursive: true, force: true }); }
    throw error;
  }
}
