import {Writable} from "node:stream";
import {createSetupIO} from "./setup/terminal.js";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { DomainError, ensure, listIntegrationProviders } from "@app-ops/core";
import { parseRemoteBuildPlan, runRemoteBuild, RemoteProviderError } from "./providers-external.js";
import { parseEASBuildPlan, runEASBuild } from "./providers-eas.js";
import { resolveSnapshot } from "@app-ops/config";
import { readInputFile, decodeWorkflow } from "./config-command.js";
import { runSetupCommand } from "./setup-command.js";
import { inspectToolchain } from "./doctor.js";
import { inspectRunnerService } from "./runner-doctor.js";
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
  "Local App Operations Foundation\nplatform doctor [--json] [--strict] [--runner-service <absolute-service.json>]\nflora providers list [--json]\nflora providers eas start --platform android|ios --profile PROFILE [--execute]\nflora providers codemagic start --app ID --workflow ID --branch BRANCH [--execute]\nflora providers codemagic cancel --build ID [--execute]\nflora providers bitrise start --app ID --workflow ID --branch BRANCH [--execute]\nflora providers bitrise status|cancel --app ID --build ID [--execute]\nplatform config validate --file <json>\nplatform job simulate --file <json> [--scenario happy-path|runner-replacement|unsafe-expiry]\nflora dogfood --help\nflora setup [runner | --resume <private-state> | renew --state <private-state> | inspect --state <private-state> --json]\nDoctor --strict exits 1 when required prerequisites or selected local Runner checks are not verified.\nRunner doctor only reads local files and the configured local Docker socket; server connectivity and native builds remain unverified.\nFoundation commands are local. setup can provision a new Cloudflare server and guide a PC Runner; review its explicit resource scope.\n";
function doctorOptions(argv: readonly string[]): { strict: boolean; runnerService?: string } | null {
  const seen = new Set<string>();
  let runnerService: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (!["--json", "--strict", "--runner-service"].includes(flag) || seen.has(flag)) return null;
    seen.add(flag);
    if (flag === "--runner-service") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) return null;
      runnerService = value;
    }
  }
  return { strict: seen.has("--strict"), ...(runnerService === undefined ? {} : { runnerService }) };
}
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
    if (argv[0] === "providers") {
      if (argv[1] === "list") {
        if (argv.length !== 2 && !(argv.length === 3 && argv[2] === "--json")) {
          io.stderr("USAGE_ERROR\n" + help); return 2;
        }
        const providers = listIntegrationProviders();
        // This catalog is NOT proof of connection or a successful build.
        if (argv[2] === "--json") {
          io.stdout(JSON.stringify({ schemaVersion: 1, connected: false, providers }, null, 2) + "\n");
        } else {
          io.stdout("Flora build/OTA integrations (connected status not checked)\n" +
            providers.map(item => item.id + "\t" + item.execution + "\t" + item.maturity + "\t" + item.platforms.join(",") + "\n").join(""));
        }
        return 0;
      }
      if (argv[1] === "eas") {
        const plan = parseEASBuildPlan(argv.slice(1));
        io.stdout(JSON.stringify(runEASBuild(plan, process.env), null, 2) + "\n");
        return 0;
      }
      const plan = parseRemoteBuildPlan(argv.slice(1));
      const result = await runRemoteBuild(plan, process.env);
      io.stdout(JSON.stringify(result, null, 2) + "\n");
      return 0;
    }
    if (argv[0] === "doctor") {
      const options = doctorOptions(argv.slice(1));
      if (!options) { io.stderr("USAGE_ERROR\n" + help); return 2; }
      const report = await inspectToolchain();
      if (options.runnerService !== undefined) {
        const runner = await inspectRunnerService(options.runnerService);
        report.runner = runner;
        report.readiness = {
          ready: report.readiness.ready && runner.ready,
          issues: [...report.readiness.issues, ...runner.issues.map(issue => ({
            tool: "runner" as const, code: issue.code, message: issue.message, remediation: issue.remediation,
            ...(issue.runnerIndex === undefined ? {} : { runnerIndex: issue.runnerIndex }),
          }))],
        };
      }
      io.stdout(JSON.stringify(report, null, 2) + "\n");
      return options.strict && !report.readiness.ready ? 1 : 0;
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
            : e instanceof RemoteProviderError ? e.code : "INPUT_OR_OPERATION_FAILED",
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
