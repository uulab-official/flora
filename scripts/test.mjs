import { readdirSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
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
const r = spawnSync(process.execPath, ["--test", ...files.sort()], {
  stdio: "inherit",
});
process.exit(r.status ?? 1);
