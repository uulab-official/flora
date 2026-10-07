import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import os from "node:os";
import { runCli } from "@app-ops/cli";

/** A reproducible fictional example; this does not execute source or attest a real test run. */
export async function runDogfoodDemo(dbPath = join(os.homedir(), ".flora", "dogfood", "demo.db")) {
  const storage = ["--db", dbPath];
  async function invoke(args) {
    let stdout = "", stderr = "";
    const code = await runCli(["dogfood", ...args, ...storage], {
      stdout: value => { stdout += value; }, stderr: value => { stderr += value; },
      readFile: async () => { throw new Error("LEGACY_READER_NOT_SUPPORTED"); },
    });
    if (code !== 0) throw new Error(stderr.trim());
    return JSON.parse(stdout);
  }
  const source = await invoke(["import-source", "--file", fileURLToPath(new URL("../examples/dogfood-source.synthetic.json", import.meta.url))]);
  const baseline = await invoke(["import-baseline", "--snapshot", source.snapshotId, "--file", fileURLToPath(new URL("../examples/dogfood-baseline.synthetic.json", import.meta.url))]);
  return { mode: "synthetic-dogfood-demo", snapshotId: source.snapshotId, verificationId: baseline.verificationId,
    baselineState: baseline.state, files: baseline.assessment.files, tests: baseline.assessment.tests,
    evidenceOrigin: baseline.evidenceOrigin, isolatedExecution: "not_run" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const action = args[0] === "--serve" || args[0] === "--status" ? args.shift() : "import";
  if (args.length !== 0 && !(args.length === 2 && args[0] === "--db" && args[1])) {
    console.error("Usage: node scripts/dogfood-demo.mjs [--serve|--status] [--db <private-path>]"); process.exitCode = 2;
  } else {
    const dbPath = args[1] ?? join(os.homedir(), ".flora", "dogfood", "demo.db");
    try {
      if (action === "import") console.log(JSON.stringify(await runDogfoodDemo(dbPath), null, 2));
      else process.exitCode = await runCli(["dogfood", action === "--serve" ? "serve" : "status", "--db", dbPath, ...(action === "--status" ? ["--json"] : [])], {
        stdout: value => process.stdout.write(value), stderr: value => process.stderr.write(value),
        readFile: async () => { throw new Error("LEGACY_READER_NOT_SUPPORTED"); },
      });
    }
    catch (error) { console.error(error instanceof Error ? error.message : "DEMO_FAILED"); process.exitCode = 1; }
  }
}
