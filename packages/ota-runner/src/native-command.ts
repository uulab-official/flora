import { isAbsolute, extname } from "node:path";
import { isNativeArtifactName, isNativeArtifactError } from "./native-artifact-access.js";
import type { NativeArtifactCatalogue, NativeArtifactInspection, NativeArtifactExport } from "./native-artifact-access.js";
import { createNativeClient } from "./native-client.js";
import type { NativeArtifact, NativeClient, NativePlatform } from "./native-client.js";

export const NATIVE_USAGE = "Usage: flora-native-runner --config /absolute/private/native.json [--config /absolute/private/other.json ...] --daemon\n       flora-native-runner --config /absolute/private/native.json --job JOB_ID\n       flora-native-runner --config /absolute/private/native.json --artifacts\n       flora-native-runner --config /absolute/private/native.json --inspect FILE_NAME\n       flora-native-runner --config /absolute/private/native.json --export FILE_NAME --output /absolute/private/copy.apk\n       flora-native-runner --help\n";
export type NativeCommand =
  | { readonly mode: "help"; readonly paths: readonly string[] }
  | { readonly mode: "daemon"; readonly paths: readonly string[] }
  | { readonly mode: "job"; readonly paths: readonly string[]; readonly jobId: string }
  | { readonly mode: "artifacts"; readonly paths: readonly string[] }
  | { readonly mode: "inspect"; readonly paths: readonly string[]; readonly fileName: string }
  | { readonly mode: "export"; readonly paths: readonly string[]; readonly fileName: string; readonly output: string };

/** Parse a closed command before opening configuration or sending requests. */
export function parseNativeCommand(argv: readonly string[]): NativeCommand {
  const invalid = () => { throw new Error("INVALID_NATIVE_CONFIG"); };
  if (!Array.isArray(argv) || argv.length > 66 || argv.some(arg => typeof arg !== "string" || !arg.length || arg.length > 4096 || /[\x00-\x1f\x7f]/.test(arg))) return invalid();
  const args = [...argv];
  if (args.length === 1 && args[0] === "--help") return Object.freeze({ mode: "help", paths: Object.freeze([]) });
  const paths: string[] = [];
  let mode: "job" | "daemon" | "artifacts" | "inspect" | "export" | undefined, jobId: string | undefined, fileName: string | undefined, output: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--config") {
      const path = args[++index];
      if (!path || path.startsWith("--") || paths.includes(path) || paths.length >= 32) return invalid();
      paths.push(path);
    } else if (arg === "--artifacts" && !mode) mode = "artifacts";
    else if ((arg === "--inspect" || arg === "--export") && !mode) {
      mode = arg === "--inspect" ? "inspect" : "export"; fileName = args[++index];
      if (!isNativeArtifactName(fileName)) return invalid();
    } else if (arg === "--output" && output === undefined) {
      output = args[++index]; if (!output || !isAbsolute(output)) return invalid();
    } else if (arg === "--daemon" && !mode) mode = "daemon";
    else if (arg === "--job" && !mode) {
      mode = "job"; jobId = args[++index];
      if (!jobId || /^[a-z][a-z0-9_-]{2,95}$/.exec(jobId)?.[0] !== jobId) return invalid();
    } else return invalid();
  }
  if (!paths.length || !mode || mode !== "daemon" && paths.length !== 1 || mode === "job" && !jobId) return invalid();
  if (mode === "export" ? !output || !fileName || extname(output) !== extname(fileName) : output !== undefined) return invalid();
  const ownedPaths = Object.freeze(paths);
  if (mode === "job") return Object.freeze({mode, paths: ownedPaths, jobId: jobId!});
  if (mode === "inspect") return Object.freeze({mode, paths: ownedPaths, fileName: fileName!});
  if (mode === "export") return Object.freeze({mode, paths: ownedPaths, fileName: fileName!, output: output!});
  return Object.freeze({mode, paths: ownedPaths});
}

export interface NativeSessionConfig { origin: string; token: string; appId: string; platform: NativePlatform }
export interface NativeCommandDependencies<C extends NativeSessionConfig> {
  readConfig(path: string): Promise<C>;
  checkRecovery(config: C): Promise<void>;
  artifacts?: {
    list(config: C, signal?: AbortSignal): Promise<NativeArtifactCatalogue>;
    inspect(config: C, fileName: string, signal?: AbortSignal): Promise<NativeArtifactInspection>;
    export(config: C, fileName: string, output: string, signal?: AbortSignal): Promise<NativeArtifactExport>;
  };
  runJob(config: C, client: NativeClient, jobId: string, options: { signal: AbortSignal; diagnostics: boolean }): Promise<NativeArtifact>;
  runDaemon(entries: { config: C; client: NativeClient }[], options: { signal: AbortSignal; diagnostics: boolean }): Promise<void>;
}
export type NativeCommandResult =
  | NativeArtifactCatalogue | NativeArtifactInspection | NativeArtifactExport
  | { state: "help" }
  | { state: "stopped"; code: "NATIVE_CANCELLED" | "NATIVE_DAEMON_STOPPED" }
  | (NativeArtifact & { state: "succeeded"; jobId: string; appId: string });

/** A session owns all its clients. Closing it never implies server rollback. */
export async function runNativeCommand<C extends NativeSessionConfig>(argv: readonly string[], dependencies: NativeCommandDependencies<C>, signal?: AbortSignal): Promise<NativeCommandResult> {
  const command = parseNativeCommand(argv);
  if (command.mode === "help") return {state: "help"};
  const lifetime = new AbortController();
  const stop = () => lifetime.abort(); // Do not propagate arbitrary private reasons.
  const live = () => { if (lifetime.signal.aborted) throw new Error("NATIVE_CANCELLED"); };
  signal?.addEventListener("abort", stop, {once: true});
  if (signal?.aborted) stop();
  try {
    live();
    const configs: C[] = [];
    for (const path of command.paths) {
      live();
      // A filesystem/tool-based config read is not preempted. Its late result
      // cannot start a new config read, heartbeat, claim, or signing operation.
      const config = await dependencies.readConfig(path);
      live();
      configs.push(config);
    }
    // Offline artifact access must remain usable when recovery blocks new builds.
    // Do not construct a client, send presence, or mutate recovery in these modes.
    if (command.mode === "artifacts" || command.mode === "inspect" || command.mode === "export") {
      const access = dependencies.artifacts;
      if (!access) throw new Error("INVALID_NATIVE_CONFIG");
      if (command.mode === "export") return await access.export(configs[0]!, command.fileName, command.output, lifetime.signal);
      const result = command.mode === "artifacts" ? await access.list(configs[0]!, lifetime.signal)
        : await access.inspect(configs[0]!, command.fileName, lifetime.signal);
      live(); return result;
    }
    const entries = configs.map(config => ({config, client: createNativeClient({...config, signal: lifetime.signal})}));
    // One-shot jobs must not bypass the daemon's unresolved-completion gate.
    // Check every selected app before any presence, queue or claim request.
    for (const {config} of entries) {
      live();
      await dependencies.checkRecovery(config);
      live();
    }
    if (command.mode === "daemon") {
      await dependencies.runDaemon(entries, {signal: lifetime.signal, diagnostics: true});
      return {state: "stopped", code: lifetime.signal.aborted ? "NATIVE_CANCELLED" : "NATIVE_DAEMON_STOPPED"};
    }
    const {config, client} = entries[0]!;
    await client.presence();
    live();
    // Presence is asynchronous; an unresolved receipt may appear while waiting.
    await dependencies.checkRecovery(config);
    live();
    const artifact = await dependencies.runJob(config, client, command.jobId, {signal: lifetime.signal, diagnostics: true});
    // A confirmed controller result must not become failure just because a stop
    // follows it. Uncertain completion is thrown by the existing controller.
    return {state: "succeeded", jobId: command.jobId, appId: config.appId,
      fileName: artifact.fileName, sha256: artifact.sha256, byteLength: artifact.byteLength,
      appIdentifier: artifact.appIdentifier, platform: artifact.platform, signerFingerprint: artifact.signerFingerprint,
      ...(artifact.teamId ? {teamId: artifact.teamId} : {})};
  } finally {
    lifetime.abort();
    signal?.removeEventListener("abort", stop);
  }
}

/** Public CLI status is bounded, secret-free and preserves ambiguous writes. */
export function nativeCommandFailure(error: unknown, signal?: AbortSignal): {state: "stopped" | "completion_unknown" | "attention" | "failed"; code: string; exitCode: number} {
  const message = error instanceof Error ? error.message : "";
  if (message === "NATIVE_COMPLETION_UNKNOWN") return {state: "completion_unknown", code: message, exitCode: 1};
  if (message === "NATIVE_COMPLETION_RECONCILIATION_REQUIRED") return {state: "attention", code: message, exitCode: 1};
  if (message === "NATIVE_EXPORT_UNCONFIRMED") return {state: "attention", code: message, exitCode: 1};
  if (signal?.aborted) return {state: "stopped", code: "NATIVE_CANCELLED", exitCode: 0};
  if (message === "INVALID_NATIVE_CONFIG") return {state: "failed", code: message, exitCode: 2};
  if (isNativeArtifactError(message)) return {state: "failed", code: message, exitCode: 1};
  const code = ["NATIVE_RUNNERS_DISABLED", "ISOLATION_UNAVAILABLE", "NATIVE_CANCELLED"].includes(message) ? message : "NATIVE_BUILD_FAILED";
  return {state: "failed", code, exitCode: 1};
}
