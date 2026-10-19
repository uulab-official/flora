import { realpathSync, readFileSync, statSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { spawn } from "node:child_process";
import type { RunnerDoctorReport } from "./runner-doctor.js";
export interface ToolReport {
  status: "available" | "unavailable" | "unsupported";
  version: string | null;
  reason?: "not-verified" | "not-found" | "timeout" | "execution-failed" | "unrecognized-output" | "output-limit";
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
type ToolName = "pnpm" | "git" | "xcode" | "java";
function toolVersion(tool: ToolName, output: string): string | null {
  // Return only recognized numeric versions, never arbitrary program output.
  for (const line of output.split(/\r?\n/)) {
    let match: RegExpMatchArray | null;
    if (tool === "pnpm" && (match = line.trim().match(/^v?(\d{1,4}\.\d{1,4}\.\d{1,4})$/)))
      return match[1]!;
    if (tool === "git" && (match = line.match(/^git version (\d{1,4}\.\d{1,4}(?:\.\d{1,4})?)(?=[\s.(+-]|$)/)))
      return "git version " + match[1];
    if (tool === "xcode" && (match = line.match(/^Xcode (\d{1,4}(?:\.\d{1,4}){0,2})(?=\s|$)/)))
      return "Xcode " + match[1];
    if (tool === "java" && (match = line.match(/^(openjdk|java)(?: version)? "?(\d{1,4}(?:[._]\d{1,4}){0,3})(?=["\s+-]|$)/)))
      return match[1] + ' version "' + match[2] + '"';
  }
  return null;
}
export function probeTool(tool: ToolName, command: string, args: readonly string[], timeoutMs = 3000): Promise<ToolReport> {
  return new Promise((resolve) => {
    let output = "", size = 0, settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (report: ToolReport) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      output = "";
      resolve(report);
    };
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stop = (reason: "timeout" | "output-limit") => {
      finish({ status: "unavailable", version: null, reason });
      try { child.kill("SIGKILL"); } catch {}
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    };
    timer = setTimeout(() => stop("timeout"), timeoutMs);
    const collect = (chunk: Buffer) => {
      if (settled) return;
      size += chunk.byteLength;
      if (size > 4096) { stop("output-limit"); return; }
      output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error: NodeJS.ErrnoException) => finish({
      status: "unavailable", version: null,
      reason: error.code === "ENOENT" ? "not-found" : "execution-failed",
    }));
    child.once("close", (code) => {
      if (settled) return;
      const version = code === 0 ? toolVersion(tool, output) : null;
      finish(version ? { status: "available", version } : {
        status: "unavailable", version: null,
        reason: code === 0 ? "unrecognized-output" : "execution-failed",
      });
    });
  });
}
export interface DoctorReadiness {
  ready: boolean;
  issues: {
    tool: "node" | "pnpm" | "git" | "runner";
    code: string;
    message: string;
    remediation: string;
    runnerIndex?: number;
  }[];
}
export interface DoctorReport {
  mode: "local";
  os: string;
  architecture: string;
  node: { version: string; supported: boolean };
  pnpm: ToolReport;
  tools: { xcode: ToolReport; java: ToolReport; git: ToolReport };
  readiness: DoctorReadiness;
  nativeBuildVerified: false;
  runner?: RunnerDoctorReport;
}
export function assessReadiness(report: Pick<DoctorReport, "node" | "pnpm" | "tools">): DoctorReadiness {
  const issues: DoctorReadiness["issues"] = [];
  if (!report.node.supported || report.node.version !== "v24.19.0")
    issues.push({ tool: "node", code: "NODE_VERSION_UNSUPPORTED",
      message: "The local foundation requires the pinned Node version.",
      remediation: "Select Node 24.19.0 using your existing Node installation or version manager, then rerun doctor." });
  if (report.pnpm.status !== "available" || report.pnpm.version !== "11.19.0") {
    const reason = report.pnpm.reason;
    const code = report.pnpm.status === "available" ? "PNPM_VERSION_UNSUPPORTED" :
      reason === "not-verified" ? "PNPM_NOT_VERIFIED" :
      reason === "timeout" ? "PNPM_TIMEOUT" :
      reason === "unrecognized-output" ? "PNPM_VERSION_UNVERIFIED" : "PNPM_UNAVAILABLE";
    issues.push({ tool: "pnpm", code,
      message: reason === "not-verified" ? "This invocation did not provide a verified pnpm entry; this does not prove pnpm is uninstalled." :
        reason === "timeout" ? "The pnpm version probe timed out." : "The pinned pnpm version could not be verified.",
      remediation: "From the Flora checkout, run: npm exec --yes --package=pnpm@11.19.0 -- pnpm flora doctor --strict --json" });
  }
  if (report.tools.git.status !== "available")
    issues.push({ tool: "git", code: report.tools.git.reason === "timeout" ? "GIT_TIMEOUT" : "GIT_UNAVAILABLE",
      message: report.tools.git.reason === "timeout" ? "The Git version probe timed out." : "A Git version could not be verified.",
      remediation: "Make Git available on PATH, verify git --version, then rerun doctor. See docs/getting-started.ko.md." });
  return { ready: issues.length === 0, issues };
}
export async function inspectToolchain(): Promise<DoctorReport> {
  const entry = resolvePnpmEntry();
  const [pnpm, xcode, java, git] = await Promise.all([
    entry
      ? probeTool("pnpm", process.execPath, [entry, "--version"])
      : Promise.resolve({ status: "unavailable" as const, version: null, reason: "not-verified" as const }),
    process.platform === "darwin"
      ? probeTool("xcode", "xcodebuild", ["-version"])
      : Promise.resolve({ status: "unsupported" as const, version: null }),
    probeTool("java", "java", ["-version"]),
    probeTool("git", "git", ["--version"]),
  ]);
  const facts = { node: { version: process.version, supported: process.versions.node === "24.19.0" },
    pnpm, tools: { xcode, java, git } };
  return {
    mode: "local",
    os: process.platform,
    architecture: process.arch,
    ...facts,
    readiness: assessReadiness(facts),
    nativeBuildVerified: false,
  };
}
