/** User-owned EAS CLI integration. No EAS API keys ever reach Flora or logs.
 * Requires a preconfigured local Expo app and pinned locally installed eas-cli.
 * This is an explicit alternative build provider, never part of Flora OTA. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { RemoteProviderError } from "./providers-external.js";

export interface EASBuildPlan {
  provider: "expo-eas";
  operation: "start";
  platform: "android" | "ios";
  profile: string;
  execute: boolean;
}
export interface EASBuildReceipt {
  provider: "expo-eas";
  operation: "start";
  state: "requested" | "submitted_unverified";
  buildIds: string[];
}
export function parseEASBuildPlan(args: readonly string[]): EASBuildPlan {
  const [provider, operation, ...rest] = args;
  if (provider !== "eas" || operation !== "start") throw new RemoteProviderError("PROVIDER_INVALID_INPUT");
  const flags = new Map<string, string>();
  let execute = false;
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i]!;
    if (name === "--execute") {
      if (execute) throw new RemoteProviderError("PROVIDER_INVALID_INPUT");
      execute = true;
    } else if (name === "--platform" || name === "--profile") {
      if (flags.has(name)) throw new RemoteProviderError("PROVIDER_INVALID_INPUT");
      const value = rest[++i];
      if (!value || value.startsWith("--") || value.length > 64) throw new RemoteProviderError("PROVIDER_INVALID_INPUT");
      flags.set(name, value);
    } else throw new RemoteProviderError("PROVIDER_INVALID_INPUT");
  }
  const platform = flags.get("--platform");
  const profile = flags.get("--profile");
  if (flags.size !== 2 || (platform !== "ios" && platform !== "android") ||
      typeof profile !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile))
    throw new RemoteProviderError("PROVIDER_INVALID_INPUT");
  return { provider: "expo-eas", operation: "start", platform, profile, execute };
}
type Spawn = typeof spawnSync;
function parseIds(output: string): string[] {
  if (output.length > 262144) return [];
  let value: unknown;
  try { value = JSON.parse(output); } catch { return []; }
  const items = Array.isArray(value) ? value : [value];
  const ids: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const id = (item as Record<string, unknown>).id;
    if (typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{6,127}$/.test(id)) ids.push(id);
  }
  return [...new Set(ids)];
}
/** A build only starts after explicit --execute; stdout/stderr are never echoed. */
export function runEASBuild(
  plan: EASBuildPlan,
  environment: Readonly<NodeJS.ProcessEnv>,
  root = process.cwd(),
  spawn: Spawn = spawnSync,
): EASBuildReceipt | { dryRun: true; plan: EASBuildPlan; tokenEnvironment: "EXPO_TOKEN" } {
  if (!plan.execute) return { dryRun: true, plan, tokenEnvironment: "EXPO_TOKEN" };
  if (process.platform === "win32") throw new RemoteProviderError("PROVIDER_LOCAL_EXECUTOR_UNSUPPORTED");
  const token = environment.EXPO_TOKEN;
  if (typeof token !== "string" || token.length < 8 || token.length > 8192 || /[\0\r\n]/.test(token))
    throw new RemoteProviderError("PROVIDER_TOKEN_MISSING");
  const binary = join(root, "node_modules", ".bin", "eas");
  if (![binary, join(root, "package.json"), join(root, "eas.json")].every(path => existsSync(path)) ||
      !["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]
        .some(name => existsSync(join(root, name))))
    throw new RemoteProviderError("PROVIDER_LOCAL_SETUP_REQUIRED");
  // Never silently run an unpinned local binary or install one over the network.
  try {
    const app = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
    const deps = { ...(app.dependencies as Record<string, unknown> | undefined ?? {}),
      ...(app.devDependencies as Record<string, unknown> | undefined ?? {}) };
    const pin = deps["eas-cli"];
    const installed = JSON.parse(readFileSync(join(root, "node_modules", "eas-cli", "package.json"), "utf8")) as Record<string, unknown>;
    if (typeof pin !== "string" || !/^\d+\.\d+\.\d+$/.test(pin) || installed.version !== pin)
      throw new Error("UNPINNED");
  } catch { throw new RemoteProviderError("PROVIDER_LOCAL_SETUP_REQUIRED"); }
  const args = ["build", "--platform", plan.platform, "--profile", plan.profile, "--non-interactive", "--no-wait", "--json"];
  let result: ReturnType<Spawn>;
  try {
    result = spawn(binary, args, {
      cwd: root, encoding: "utf8", shell: false, timeout: 90000, maxBuffer: 262144,
      env: { ...environment, CI: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch { throw new RemoteProviderError("PROVIDER_LOCAL_EXECUTION_UNAVAILABLE"); }
  if (result.error || result.status !== 0 || typeof result.stdout !== "string")
    throw new RemoteProviderError("PROVIDER_LOCAL_EXECUTION_UNAVAILABLE");
  const buildIds = parseIds(result.stdout);
  return { provider: "expo-eas", operation: "start", state: buildIds.length ? "requested" : "submitted_unverified", buildIds };
}
