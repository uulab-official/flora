import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { DomainError, ensure } from "@app-ops/core";
import { resolveSnapshot } from "@app-ops/config";
import { readInputFile, decodeWorkflow } from "./config-command.js";
import { inspectToolchain } from "./doctor.js";
import { simulateWorkflow } from "./simulate.js";
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
  "Local App Operations Foundation\nplatform doctor [--json]\nplatform config validate --file <json>\nplatform job simulate --file <json> [--scenario happy-path|runner-replacement|unsafe-expiry]\nNo native builds, provider connections or deployments.\n";
export async function runCli(
  argv: readonly string[],
  io: CliIO,
): Promise<number> {
  try {
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
      (argv.length === 1 || (argv.length === 2 && argv[1] === "--json"))
    ) {
      io.stdout(JSON.stringify(await inspectToolchain(), null, 2) + "\n");
      return 0;
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
