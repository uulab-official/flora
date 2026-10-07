import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSourceBundle } from "@app-ops/dogfood";
import { syntheticSourceBundle, syntheticBaseline } from "../../tests/dogfood-fixtures.ts";
import { SYNTHETIC_ORIGIN } from "./transport.mjs";
import { HOSTED_ASSETS } from "../build-cloudflare.mjs";

const require = createRequire(new URL("../../packages/cloudflare/package.json", import.meta.url));
const { build } = require("esbuild");
const { convertV4MiniflareOptions, CoreHeaders, Miniflare } = require("miniflare");

/** No test authentication substitute: production Worker + FloraAuth + real D1. */
export async function createHostedQaHarness() {
  const directory = await mkdtemp(join(tmpdir(), "flora-hosted-qa-"));
  let mf; let outbound = 0;
  try {
    const assets = new Map(), assetSha256 = {};
    for (const name of HOSTED_ASSETS) {
      const bytes = await readFile(new URL("../../packages/cloudflare/public/" + name, import.meta.url));
      assets.set("/" + name, bytes);
      assetSha256[name] = createHash("sha256").update(bytes).digest("hex");
    }
    const output = await build({ entryPoints: [fileURLToPath(new URL("../../packages/cloudflare/src/worker.ts", import.meta.url))],
      bundle: true, format: "esm", platform: "browser", target: "es2023", external: ["cloudflare:*", "node:*"], write: false, metafile: true, logLevel: "silent" });
    const script = output.outputFiles[0]?.text;
    if (!script) throw new Error("HOSTED_WORKER_BUNDLE_REQUIRED");
    const issuedAt = Date.now(), raw = randomBytes(32);
    const email = "owner@example.test", password = "  한글🙂 " + randomBytes(24).toString("base64url") + "  ";
    const token = raw.toString("base64url");
    mf = new Miniflare(convertV4MiniflareOptions({
      name: "flora-hosted-qa", modules: true, script, compatibilityDate: "2026-10-07", compatibilityFlags: ["nodejs_compat"],
      host: "127.0.0.1", port: 0, cf: false, telemetry: { enabled: false }, resourcePersistencePath: directory,
      bindings: {
        FLORA_ORIGIN: SYNTHETIC_ORIGIN, FLORA_OWNER_ID: "synthetic-owner", FLORA_OWNER_EMAIL: email, FLORA_DB_IDENTITY: "synthetic-db",
        FLORA_SETUP: { digest: createHash("sha256").update(raw).digest("hex"), issuedAt, expiresAt: issuedAt + 600_000, generation: 1, purpose: "enroll" },
      },
      d1Databases: { FLORA_DB: "flora-synthetic-db" },
      durableObjects: { FLORA_AUTH: { className: "FloraAuth", useSQLite: true } },
      serviceBindings: { ASSETS: request => {
        const path = new URL(request.url).pathname;
        const bytes = assets.get(path);
        if (!bytes || !["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 404 });
        const mime = path.endsWith(".png") ? "image/png" : path.endsWith(".svg") ? "image/svg+xml; charset=utf-8"
          : path.endsWith(".html") ? "text/html; charset=utf-8" : path.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8";
        return new Response(request.method === "HEAD" ? null : bytes, { headers: { "Content-Type": mime } });
      } },
      outboundService: () => { outbound++; return new Response("Synthetic network boundary", { status: 503 }); },
    }));
    const runtime = mf, runtimeUrl = await runtime.ready, db = await runtime.getD1Database("FLORA_DB");
    if (runtimeUrl.protocol !== "http:" || runtimeUrl.hostname !== "127.0.0.1" || !runtimeUrl.port || runtimeUrl.username || runtimeUrl.password) throw new Error("LOOPBACK_RUNTIME_REQUIRED");
    const migration = await readFile(new URL("../../packages/cloudflare/migrations/0001_private_imports.sql", import.meta.url), "utf8");
    await db.exec(migration.replace(/^--.*$/gm, "").split(/;\s*(?=CREATE|INSERT|PRAGMA|$)/).filter(value => value.trim()).map(value => value.replace(/\s*\n\s*/g, " ").trim() + ";").join("\n"));
    await db.prepare("INSERT INTO flora_deployment(singleton,owner_id,origin,db_identity) VALUES(1,?,?,?)")
      .bind("synthetic-owner", SYNTHETIC_ORIGIN, "synthetic-db").run();
    function source(index = 0) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= 100) throw new Error("SYNTHETIC_FIXTURE_INDEX");
      const value = syntheticSourceBundle();
      if (index) value.commitSha = index.toString(16).padStart(40, "b");
      return Buffer.from(JSON.stringify(value, null, 2) + "\n");
    }
    return {
      origin: SYNTHETIC_ORIGIN, email, password, token, source,
      sourceEvidence: { workerSha256: createHash("sha256").update(script).digest("hex"), assetSha256 },
      dispatchFetch: runtime.dispatchFetch.bind(runtime), outboundRequests: () => outbound,
      async httpFetch(input, init = {}) {
        const url = new URL(input);
        if (url.origin !== SYNTHETIC_ORIGIN || url.username || url.password || url.hash) throw new Error("SYNTHETIC_ORIGIN_REQUIRED");
        const headers = new Headers(init.headers);
        // Miniflare's supported original-URL header preserves the production
        // origin admission while the ordinary HTTP client connects to loopback.
        headers.set(CoreHeaders.ORIGINAL_URL, url.href);
        const destination = new URL(runtimeUrl);
        destination.pathname = url.pathname; destination.search = url.search;
        return fetch(destination, { ...init, headers, redirect: "manual" });
      },
      async baseline(sourceIndex = 0, attempt = 1) {
        if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 500) throw new Error("SYNTHETIC_FIXTURE_ATTEMPT");
        const snapshot = await parseSourceBundle(source(sourceIndex), issuedAt);
        return Buffer.from(JSON.stringify({ ...syntheticBaseline(snapshot), attemptKey: "synthetic-attempt-" + attempt }, null, 2) + "\n");
      },
      async close() { try { await runtime.dispose(); } finally { await rm(directory, { recursive: true, force: true }); } },
    };
  } catch (error) {
    try { await mf?.dispose(); } finally { await rm(directory, { recursive: true, force: true }); }
    throw error;
  }
}
