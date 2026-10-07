import { ensure } from "@app-ops/core";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { parseSourceBundle } from "@app-ops/dogfood";
import { openDatabase, migrate, createSqliteDogfoodStore, saveInventory, acquireDashboardOwner, releaseDashboardOwner, interruptVerifications } from "@app-ops/db";
import { createDogfoodService } from "@app-ops/dashboard/service";
import { createBlockedProvider } from "@app-ops/dashboard/blocked-provider";
import type { CliIO } from "./main.js";
import { readDogfoodInputFile } from "./dogfood-input.js";
import { preparePrivateStore, verifyPrivateStore } from "./private-store.js";

const help = "Flora local dogfood\n" +
  "flora dogfood serve [--db <path>] [--port <0..65535>]\n" +
  "flora dogfood import-source --file <json> [--db <path>]\n" +
  "flora dogfood import-baseline --snapshot <inventory_id> --file <json> [--db <path>]\n" +
  "flora dogfood status [--db <path>] --json\n" +
  "Static imports are operator evidence. No native builds or verified isolated execution.\n";
type Command = { name: "status" | "import-source" | "import-baseline" | "serve"; dbPath?: string; file?: string; snapshotId?: string; port?: number };
function parse(args: readonly string[]): Command | null {
  const name = args[0];
  if (name !== "status" && name !== "import-source" && name !== "import-baseline" && name !== "serve") return null;
  const allowed = new Set(name === "status" ? ["--db", "--json"] : name === "serve" ? ["--db", "--port"]
    : name === "import-source" ? ["--db", "--file"] : ["--db", "--file", "--snapshot"]);
  const options = new Map<string, string>();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]!;
    if (!allowed.has(flag) || options.has(flag)) return null;
    if (flag === "--json") options.set(flag, "true");
    else {
      const value = args[++i];
      if (!value || value.startsWith("--") || value.includes("\0")) return null;
      options.set(flag, value);
    }
  }
  if (name === "status" && !options.has("--json")) return null;
  if ((name === "import-source" || name === "import-baseline") && !options.has("--file")) return null;
  const snapshotId = options.get("--snapshot"), port = options.get("--port");
  if (name === "import-baseline" && (!snapshotId || !/^inventory_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(snapshotId))) return null;
  if (port !== undefined && (!/^(0|[1-9][0-9]{0,4})$/.test(port) || Number(port) > 65535)) return null;
  return { name, ...(options.has("--db") ? { dbPath: options.get("--db")! } : {}),
    ...(options.has("--file") ? { file: options.get("--file")! } : {}),
    ...(snapshotId ? { snapshotId } : {}), ...(port !== undefined ? { port: Number(port) } : {}) };
}

export async function runDogfoodCommand(args: readonly string[], io: Pick<CliIO, "stdout" | "stderr">): Promise<number> {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) { io.stdout(help); return 0; }
  const command = parse(args);
  if (!command) { io.stderr("USAGE_ERROR\n" + help); return 2; }

  // Read the bounded input before creating/opening/migrating any database.
  const bytes = command.file ? await readDogfoodInputFile(command.file) : null;
  const snapshot = command.name === "import-source" ? await parseSourceBundle(bytes!, Date.now()) : null;
  const dbPath = await preparePrivateStore(command.dbPath);
  await verifyPrivateStore(dbPath);
  const db = openDatabase(dbPath);
  let service: Awaited<ReturnType<typeof createDogfoodService>> | null = null;
  let server: { close(): Promise<void> } | null = null;
  let ownedNonce: string | null = null;
  let signal: (() => void) | null = null;
  try {
    migrate(db); await verifyPrivateStore(dbPath);
    if (command.name === "serve") {
      const nonce = randomUUID();
      acquireDashboardOwner(db, { nonce, pid: process.pid, host: hostname() });
      ownedNonce = nonce;
      interruptVerifications(db, Date.now());
    }
    service = await createDogfoodService(createSqliteDogfoodStore(db), [createBlockedProvider()], Date.now);
    if (command.name === "serve") {
      const stopped = new Promise<void>(resolve => { signal = resolve; });
      process.on("SIGINT", signal!); process.on("SIGTERM", signal!);
      // Only the local serve path loads the Node HTTP adapter.
      const { startDashboard } = await import("@app-ops/dashboard");
      const app = await startDashboard({ service, ...(command.port === undefined ? {} : { port: command.port }) });
      server = app;
      await verifyPrivateStore(dbPath);
      io.stdout(app.bootstrapUrl + "\n");
      await stopped;
      return 0;
    }
    let output: unknown;
    if (command.name === "import-source") {
      ensure(snapshot);
      const saved = saveInventory(db, snapshot);
      output = { snapshotId: saved.id, digest: saved.digest, evidenceOrigin: saved.evidenceOrigin, connection: saved.connection };
    } else if (command.name === "import-baseline") {
      const record = await service.importBaseline(command.snapshotId!, bytes!);
      output = { verificationId: record.id, snapshotId: record.snapshotId, state: record.state,
        evidenceKind: record.evidenceKind, evidenceOrigin: record.evidenceOrigin, assessment: record.assessment };
    } else output = await service.getState();
    await verifyPrivateStore(dbPath);
    io.stdout(JSON.stringify(output) + "\n");
    return 0;
  } finally {
    try { if (service) await service.close(); }
    finally {
      try { if (server) await server.close(); }
      finally {
        try {
          if (ownedNonce !== null) releaseDashboardOwner(db, ownedNonce);
          await verifyPrivateStore(dbPath);
        } finally {
          db.close();
          if (signal) { process.off("SIGINT", signal); process.off("SIGTERM", signal); }
        }
      }
    }
  }
}
