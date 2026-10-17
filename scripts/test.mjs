import { readdirSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";
const configuredConcurrency = process.env.FLORA_TEST_CONCURRENCY;
if (configuredConcurrency !== undefined && !/^[1-4]$/.test(configuredConcurrency))
  throw new Error("FLORA_TEST_CONCURRENCY must be an integer from 1 to 4");
const concurrency = Math.min(Number(configuredConcurrency ?? 2), availableParallelism());
const files = [];
function walk(p) {
  if (!existsSync(p)) return;
  if (statSync(p).isFile()) {
    if (p.endsWith(".test.ts")) files.push(resolve(p));
    return;
  }
  for (const e of readdirSync(p, { withFileTypes: true })) {
    if (!["node_modules", "dist", ".git"].includes(e.name))
      walk(p + "/" + e.name);
  }
}
for (const p of process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["packages", "tests"])
  walk(p);
if (!files.length) throw new Error("No tests selected");
// Workerd-backed tests and real Metro exports share host memory and CPU. Bound
// file workers conservatively; use FLORA_TEST_CONCURRENCY=1 during native builds.
// Transport failures remain test failures, without replaying ambiguous mutations.
const r = spawnSync(process.execPath, ["--test", `--test-concurrency=${concurrency}`, ...files.sort()], {
  stdio: "inherit",
});
process.exit(r.status ?? 1);
