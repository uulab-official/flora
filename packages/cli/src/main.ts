import {Writable} from "node:stream";
import {createSetupIO} from "./setup/terminal.js";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { DomainError, ensure } from "@app-ops/core";
import { resolveSnapshot } from "@app-ops/config";
import { readInputFile, decodeWorkflow } from "./config-command.js";
import { runSetupCommand } from "./setup-command.js";
import { inspectToolchain } from "./doctor.js";
import { simulateWorkflow } from "./simulate.js";
import { runDogfoodCommand } from "./dogfood-command.js";
import type { Scenario } from "./simulate.js";
export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readFile: (path: string) => Promise<Uint8Array>;
}
const productName = (process.env.PRODUCT_NAME || "Flora")
  .replace(/[\x00-\x1f\x7f]/g, "")
  .slice(0, 80);
const help =
  productName +
  " — " +
  "Local App Operations Foundation\nplatform doctor [--json] [--strict]\nplatform config validate --file <json>\nplatform job simulate --file <json> [--scenario happy-path|runner-replacement|unsafe-expiry]\nflora dogfood --help\nflora setup [runner | --resume <private-state> | inspect --state <private-state> --json]\nDoctor --strict exits 1 when Node, pnpm or Git prerequisites are not verified.\nFoundation commands are local. setup can provision a new Cloudflare server and guide a PC Runner; review its explicit resource scope.\n";
export async function runCli(
  argv: readonly string[],
  io: CliIO,
): Promise<number> {
  try {
    if (argv[0] === "setup") return await runSetupCommand(argv.slice(1),createSetupIO(new Writable({write(chunk,_encoding,done){try{io.stdout(chunk.toString());done();}catch(error){done(error as Error);}}})));
    if (argv[0] === "dogfood") return await runDogfoodCommand(argv.slice(1), io);
    if (argv.length === 0 || (argv.length === 1 && argv[0] === "--help")) {
      io.stdout(help);
      return 0;
    }
    if (argv.length === 1 && argv[0] === "--version") {
      io.stdout("0.1.0\n");
      return 0;
    }
    if (
      argv[0] === "doctor" &&
      argv.length <= 3 &&
      argv.slice(1).every(flag => flag === "--json" || flag === "--strict") &&
      new Set(argv.slice(1)).size === argv.length - 1
    ) {
      const report = await inspectToolchain();
      io.stdout(JSON.stringify(report, null, 2) + "\n");
      return argv.includes("--strict") && !report.readiness.ready ? 1 : 0;
    }
    const config = argv[0] === "config" && argv[1] === "validate",
      simulation = argv[0] === "job" && argv[1] === "simulate";
    if (
      (!config && !simulation) ||
      argv[2] !== "--file" ||
      !argv[3] ||
      !(
        argv.length === 4 ||
        (simulation && argv.length === 6 && argv[4] === "--scenario")
      )
    ) {
      io.stderr("USAGE_ERROR\n" + help);
      return 2;
    }
    const scenario = argv[5] ?? "happy-path";
    if (
      simulation &&
      !["happy-path", "runner-replacement", "unsafe-expiry"].includes(scenario)
    ) {
      io.stderr("USAGE_ERROR\n");
      return 2;
    }
    const w = decodeWorkflow(await io.readFile(argv[3]));
    if (config) {
      const snapshot = await resolveSnapshot({
        target: w.target,
        source: w.source,
        entries: w.configEntries,
      });
      io.stdout(
        JSON.stringify(
          {
            mode: "local",
            snapshotId: snapshot.id,
            digest: snapshot.digest,
            target: snapshot.target,
            entries: snapshot.entries.map((e) => ({
              key: e.key,
              kind: e.binding.kind,
              ...(e.binding.kind === "CONFIG"
                ? {}
                : {
                    resourceId: e.binding.resourceId,
                    versionId: e.binding.versionId,
                  }),
            })),
          },
          null,
          2,
        ) + "\n",
      );
    } else
      io.stdout(
        JSON.stringify(
          await simulateWorkflow(w, scenario as Scenario),
          null,
          2,
        ) + "\n",
      );
    return 0;
  } catch (e) {
    io.stderr(
      JSON.stringify({
        error:
          e instanceof DomainError
            ? e.safeMessage
            : "INPUT_OR_OPERATION_FAILED",
      }) + "\n",
    );
    return 1;
  }
}
export async function main(): Promise<void> {
  ensure(process.versions.node.split(".")[0] === "24");
  process.exitCode = await runCli(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    readFile: readInputFile,
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
