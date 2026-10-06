import {
  existsSync,
  statSync,
  readFileSync,
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { resolvePnpmEntry } from "./pnpm-entry.mjs";
export function requireLockfile(directory) {
  const file = join(directory, "pnpm-lock.yaml");
  if (!existsSync(file) || !statSync(file).isFile() || !statSync(file).size)
    throw Error("LOCKFILE_REQUIRED");
}
export function snapshotFiles(root, paths) {
  return new Map(
    paths.map((path) => [
      path,
      createHash("sha256")
        .update(readFileSync(join(root, path)))
        .digest("hex"),
    ]),
  );
}
export function assertUnchanged(root, snapshot) {
  for (const [path, expected] of snapshot) {
    if (
      !existsSync(join(root, path)) ||
      createHash("sha256")
        .update(readFileSync(join(root, path)))
        .digest("hex") !== expected
    )
      throw Error("SOURCE_CHANGED");
  }
}
function run(command, args, cwd, env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
  });
  if (result.error || result.status !== 0)
    throw Error(
      (result.stderr || result.stdout || "COMMAND_FAILED").slice(-12000),
    );
  return result.stdout;
}
export async function verifyClean() {
  const root = process.cwd();
  requireLockfile(root);
  const entry = resolvePnpmEntry();
  if (!entry) throw Error("Run pnpm verify:clean with pinned pnpm 11.19.0");
  const files = run("git", ["ls-files", "-z"], root, process.env)
    .split("\0")
    .filter(Boolean);
  const before = snapshotFiles(root, files);
  const temp = mkdtempSync(join(tmpdir(), "app-ops-clean-"));
  try {
    for (const file of files) {
      const target = join(temp, file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(root, file), target);
    }
    requireLockfile(temp);
    const env = { ...process.env, XDG_DATA_HOME: join(temp, ".xdg") };
    run(
      process.execPath,
      [
        entry,
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--store-dir",
        join(temp, ".store"),
      ],
      temp,
      env,
    );
    assertUnchanged(temp, before);
    const checked = run(process.execPath, [entry, "check"], temp, env);
    for (const args of [
      ["doctor", "--json"],
      ["config", "validate", "--file", "examples/local-workflow.json"],
      [
        "job",
        "simulate",
        "--file",
        "examples/local-workflow.json",
        "--scenario",
        "runner-replacement",
      ],
    ])
      run(process.execPath, [entry, "platform", ...args], temp, env);
    assertUnchanged(temp, before);
    assertUnchanged(root, before);
    console.log(checked.slice(-1800));
    console.log(
      JSON.stringify({
        cleanInstall: "passed",
        sourceFiles: files.length,
        isolatedStore: true,
        originalUnchanged: true,
      }),
    );
  } finally {
    rmSync(temp, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  verifyClean().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
