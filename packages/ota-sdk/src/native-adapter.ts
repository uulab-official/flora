import { floraTelemetryErrorCode } from "./telemetry.js";
import type { FloraTelemetryReporter } from "./telemetry.js";
import { createFloraClient } from "./index.js";
import type { NativeConfiguration, NativeUpdateEngine, UpdateIdentity } from "./index.js";

/** The installed native module owns signing, downloads, atomic activation and rollback. */
export interface FloraNativeBridge {
  getNativeConfiguration(): Promise<unknown>;
  check(): Promise<unknown>;
  download(): Promise<unknown>;
  reload(expectedUpdateId: string): Promise<unknown>;
  getLaunchInfo(): Promise<unknown>;
  markLaunchSuccessful(expectedUpdateId: string | null): Promise<unknown>;
}
export interface FloraLaunchInfo {
  readonly appId: string;
  readonly runtimeVersion: string;
  readonly source: "embedded" | "update";
  readonly updateId: string | null;
  readonly assets: Readonly<Record<string, string>>;
  readonly rollback?: Readonly<{ updateId: string; reason: "UNCONFIRMED_LAUNCH" | "STORED_UPDATE_INVALID" }>;
}
export interface FloraNativeEngine extends NativeUpdateEngine {
  getLaunchInfo(): Promise<FloraLaunchInfo>;
  /** Pass the ID captured at this JS launch, only after the app is ready.
   * Native code rejects stale IDs rather than confirming a different launch. */
  markLaunchSuccessful(expectedUpdateId: string | null): Promise<void>;
}
export type FloraNativeErrorCode = "NATIVE_MODULE_UNAVAILABLE" | "NATIVE_RESULT_INVALID" | "NATIVE_OPERATION_FAILED";
export class FloraNativeError extends Error {
  readonly code: FloraNativeErrorCode;
  constructor(code: FloraNativeErrorCode) { super(code); this.name = "FloraNativeError"; this.code = code; }
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function requireResult(condition: unknown): asserts condition {
  if (!condition) throw new FloraNativeError("NATIVE_RESULT_INVALID");
}
function record(value: unknown): Record<string, unknown> {
  requireResult(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
/** Injectable entry point; importing this module never imports React Native. */
export function createFloraNativeEngine(bridge: FloraNativeBridge, options: { telemetry?: FloraTelemetryReporter } = {}): FloraNativeEngine {
  const methods = ["getNativeConfiguration", "check", "download", "reload", "getLaunchInfo", "markLaunchSuccessful"] as const;
  if (!bridge || methods.some(method => typeof bridge[method] !== "function")) throw new FloraNativeError("NATIVE_MODULE_UNAVAILABLE");
  async function call(method: typeof methods[number], argument?: string | null): Promise<unknown> {
    try {
      if (method === "reload") return await bridge.reload(argument as string);
      if (method === "markLaunchSuccessful") return await bridge.markLaunchSuccessful(argument ?? null);
      return await bridge[method]();
    } catch (error) { const failure = new FloraNativeError("NATIVE_OPERATION_FAILED"); Object.defineProperty(failure, "telemetryCode", { value: floraTelemetryErrorCode(error, "NATIVE_OPERATION_FAILED") }); throw failure; }
  }
  let installed: Readonly<NativeConfiguration> | undefined;
  async function configuration(): Promise<NativeConfiguration> {
    const raw = record(await call("getNativeConfiguration"));
    requireResult(typeof raw.enabled === "boolean");
    let parsed;
    try { parsed = createFloraClient(raw as unknown as NativeConfiguration, engine).configuration; }
    catch { throw new FloraNativeError("NATIVE_RESULT_INVALID"); }
    const current = Object.freeze({ ...parsed, enabled: raw.enabled });
    if (installed) requireResult(Object.keys(installed).every(key => current[key as keyof NativeConfiguration] === installed![key as keyof NativeConfiguration]));
    else installed = current;
    return current;
  }
  async function identity(value: unknown): Promise<UpdateIdentity> {
    const raw = record(value), config = await configuration();
    requireResult(typeof raw.id === "string" && uuid.test(raw.id));
    requireResult(["appId", "channel", "runtimeVersion", "platform"].every(key => raw[key] === config[key as keyof NativeConfiguration]));
    return Object.freeze({ id: raw.id, appId: config.appId, channel: config.channel, runtimeVersion: config.runtimeVersion, platform: config.platform });
  }
  const engine: FloraNativeEngine = Object.freeze({
    name: "flora-native", protocol: "expo-updates-v1", trust: "native-engine",
    getNativeConfiguration: configuration,
    async check() {
      const raw = record(await call("check"));
      requireResult(typeof raw.available === "boolean");
      return raw.available ? { available: true as const, update: await identity(raw.update) } : { available: false as const };
    },
    async download() {
      const raw = record(await call("download"));
      requireResult(typeof raw.downloaded === "boolean");
      return raw.downloaded ? { downloaded: true as const, update: await identity(raw.update) } : { downloaded: false as const };
    },
    async reload(expectedUpdateId: string) {
      requireResult(typeof expectedUpdateId === "string" && uuid.test(expectedUpdateId));
      await call("reload", expectedUpdateId);
    },
    async getLaunchInfo() {
      const raw = record(await call("getLaunchInfo")), config = await configuration();
      requireResult(raw.appId === config.appId && raw.runtimeVersion === config.runtimeVersion);
      requireResult(raw.source === "embedded" || raw.source === "update");
      requireResult(raw.source === "embedded" ? raw.updateId === null : typeof raw.updateId === "string" && uuid.test(raw.updateId));
      let rollback: FloraLaunchInfo["rollback"];
      if (raw.rollback !== undefined) {
        const detail = record(raw.rollback);
        requireResult(typeof detail.updateId === "string" && uuid.test(detail.updateId));
        requireResult(detail.reason === "UNCONFIRMED_LAUNCH" || detail.reason === "STORED_UPDATE_INVALID");
        rollback = Object.freeze({ updateId: detail.updateId, reason: detail.reason });
      }
      const assets = record(raw.assets), copied: Record<string, string> = Object.create(null);
      requireResult(Object.keys(assets).length <= 64);
      for (const [key, uri] of Object.entries(assets)) {
        requireResult(key.length > 0 && key.length <= 512 && !/[\u0000-\u001f\u007f]/.test(key));
        requireResult(typeof uri === "string" && uri.length <= 4096 && uri.startsWith("file:///") && !/[\u0000-\u001f\u007f]/.test(uri));
        copied[key] = uri;
      }
      const info = Object.freeze({ appId: config.appId, runtimeVersion: config.runtimeVersion, source: raw.source, updateId: raw.updateId as string | null, assets: Object.freeze(copied), ...(rollback === undefined ? {} : { rollback }) });
      try { await options.telemetry?.beginLaunch(info); } catch {}
      return info;
    },
    async markLaunchSuccessful(expectedUpdateId: string | null) {
      requireResult(expectedUpdateId === null || typeof expectedUpdateId === "string" && uuid.test(expectedUpdateId));
      try { await call("markLaunchSuccessful", expectedUpdateId); } catch (error) { if (expectedUpdateId) try { await options.telemetry?.record(expectedUpdateId, "failed", { stage: "launch", code: "LAUNCH_CONFIRMATION_FAILED" }); } catch {} throw error; }
      try { await options.telemetry?.confirmLaunch(expectedUpdateId); } catch {}
    },
  });
  return engine;
}
