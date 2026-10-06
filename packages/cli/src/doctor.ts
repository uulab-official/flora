import { realpathSync, readFileSync, statSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { spawn } from "node:child_process";
export interface ToolReport {
  status: "available" | "unavailable" | "unsupported";
  version: string | null;
}
export function resolvePnpmEntry(
  candidate: string | undefined = process.env.npm_execpath,
): string | null {
  if (!candidate) return null;
  try {
    const entry = realpathSync(candidate);
    if (
      ![".js", ".cjs", ".mjs"].includes(extname(entry)) ||
      !statSync(entry).isFile()
    )
      return null;
    let directory = dirname(entry);
    for (let i = 0; i < 4; i++) {
      try {
        const pkg = JSON.parse(
          readFileSync(join(directory, "package.json"), "utf8"),
        );
        if (pkg.name === "pnpm" && pkg.version === "11.19.0") return entry;
      } catch {}
      const next = dirname(directory);
      if (next === directory) break;
      directory = next;
    }
  } catch {}
  return null;
}
function probe(command: string, args: string[]): Promise<ToolReport> {
  return new Promise((resolve) => {
    let output = "",
      settled = false;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: available ? "available" : "unavailable",
        version: available
          ? (output.trim().split("\n")[0]?.slice(0, 256) ?? null)
          : null,
      });
    };
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, 3000);
    const collect = (chunk: Buffer) => {
      if (output.length < 4096)
        output += chunk.toString("utf8").slice(0, 4096 - output.length);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}
export interface DoctorReport {
  mode: "local";
  os: string;
  architecture: string;
  node: { version: string; supported: boolean };
  pnpm: ToolReport;
  tools: { xcode: ToolReport; java: ToolReport; git: ToolReport };
  nativeBuildVerified: false;
}
export async function inspectToolchain(): Promise<DoctorReport> {
  const entry = resolvePnpmEntry();
  const [pnpm, xcode, java, git] = await Promise.all([
    entry
      ? probe(process.execPath, [entry, "--version"])
      : Promise.resolve({ status: "unavailable" as const, version: null }),
    process.platform === "darwin"
      ? probe("xcodebuild", ["-version"])
      : Promise.resolve({ status: "unsupported" as const, version: null }),
    probe("java", ["-version"]),
    probe("git", ["--version"]),
  ]);
  return {
    mode: "local",
    os: process.platform,
    architecture: process.arch,
    node: {
      version: process.version,
      supported: process.versions.node === "24.19.0",
    },
    pnpm,
    tools: { xcode, java, git },
    nativeBuildVerified: false,
  };
}
