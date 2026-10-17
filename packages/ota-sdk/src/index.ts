import { floraTelemetryErrorCode } from "./telemetry.js";
import type { FloraTelemetryReporter } from "./telemetry.js";
export { createFloraTelemetry, floraTelemetryErrorCode } from "./telemetry.js";
export type { FloraTelemetryReporter, FloraTelemetryOptions, FloraTelemetryEventType, FloraTelemetryCode, FloraTelemetryStage } from "./telemetry.js";
/** Flora selects and validates updates. Only a trusted native engine may verify,
 * download, persist and load executable code. This package never fetches or evals it. */
export type NativePlatform = "ios" | "android";
export interface FloraConfiguration { appId: string; url: string; channel: string; runtimeVersion: string; platform: NativePlatform }
export interface NativeConfiguration extends FloraConfiguration { enabled: boolean }
export interface UpdateIdentity { id: string; appId: string; channel: string; runtimeVersion: string; platform: NativePlatform }
export type CheckResult = { available: false } | { available: true; update: UpdateIdentity };
export type DownloadResult = { downloaded: false } | { downloaded: true; update: UpdateIdentity };
/** Implementations must read installed binary settings; selecting a manifest,
 * signature trust, asset hash verification, persistence/rollback and atomic reload
 * remain native engine responsibilities. Own the engine exclusively while using
 * this facade so unrelated callers cannot replace its pending executable. */
export interface NativeUpdateEngine {
  readonly name: string;
  readonly protocol: "expo-updates-v1";
  readonly trust: "native-engine";
  getNativeConfiguration(): Promise<NativeConfiguration>;
  check(): Promise<CheckResult>;
  download(): Promise<DownloadResult>;
  reload(expectedUpdateId: string): Promise<void>;
}
export type FloraOTAErrorCode = "CONFIGURATION_INVALID" | "NATIVE_CONFIGURATION_MISMATCH" | "UPDATE_INCOMPATIBLE" | "BUSY" | "UPDATE_NOT_CHECKED" | "UPDATE_NOT_DOWNLOADED";
export class FloraOTAError extends Error { readonly code: FloraOTAErrorCode; constructor(code: FloraOTAErrorCode) { super(code); this.code = code; this.name = "FloraOTAError"; } }
function requireCondition(condition: unknown, code: FloraOTAErrorCode): asserts condition { if (!condition) throw new FloraOTAError(code); }
export function parseConfiguration(value: FloraConfiguration): Readonly<FloraConfiguration> {
  requireCondition(value && typeof value.appId === "string" && typeof value.channel === "string" && typeof value.url === "string" && /^[a-z][a-z0-9_-]{2,95}$/.test(value.appId) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.channel) && typeof value.runtimeVersion === "string" && value.runtimeVersion.length > 0 && value.runtimeVersion.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value.runtimeVersion) && ["ios", "android"].includes(value.platform), "CONFIGURATION_INVALID");
  let url: URL; try { url = new URL(value.url); } catch { throw new FloraOTAError("CONFIGURATION_INVALID"); }
  requireCondition(url.protocol === "https:" && !url.username && !url.password && !url.hash && url.pathname === "/updates/" + value.appId && value.url.length <= 2048, "CONFIGURATION_INVALID");
  const queries = [...url.searchParams.entries()];
  requireCondition(queries.length === 0 || queries.length === 1 && queries[0]![0] === "channel" && queries[0]![1] === value.channel, "CONFIGURATION_INVALID");
  return Object.freeze({ appId: value.appId, url: url.href, channel: value.channel, runtimeVersion: value.runtimeVersion, platform: value.platform });
}
/** No Expo, EAS, React Native, account or project identifier is required here. */
export function createFloraClient(configuration: FloraConfiguration, engine: NativeUpdateEngine, options: { telemetry?: FloraTelemetryReporter } = {}) {
  const config = parseConfiguration(configuration);
  requireCondition(engine && typeof engine.name === "string" && engine.name.length > 0 && engine.protocol === "expo-updates-v1" && engine.trust === "native-engine", "CONFIGURATION_INVALID");
  const telemetry = options.telemetry;
  const report = async (id: string | undefined, type: "update_seen" | "downloaded" | "failed", stage?: "check" | "download" | "activation", error?: unknown) => { if (id) try { await telemetry?.record(id, type, { ...(stage ? { stage } : {}), ...(type === "failed" ? { code: floraTelemetryErrorCode(error, stage === "check" ? "CHECK_FAILED" : stage === "download" ? "DOWNLOAD_FAILED" : "ACTIVATION_FAILED") } : {}) }); } catch {} };
  let lastSeen: string | undefined; let busy = false; let checked: Readonly<UpdateIdentity> | null = null; let downloaded: Readonly<UpdateIdentity> | null = null;
  async function verifyNative() {
    const native = await engine.getNativeConfiguration();
    requireCondition(native?.enabled === true, "NATIVE_CONFIGURATION_MISMATCH");
    let parsed: Readonly<FloraConfiguration>; try { parsed = parseConfiguration(native); } catch { throw new FloraOTAError("NATIVE_CONFIGURATION_MISMATCH"); }
    requireCondition(["appId", "url", "channel", "runtimeVersion", "platform"].every(key => parsed[key as keyof FloraConfiguration] === config[key as keyof FloraConfiguration]), "NATIVE_CONFIGURATION_MISMATCH");
  }
  function compatible(update: UpdateIdentity): Readonly<UpdateIdentity> {
    requireCondition(update && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(update.id) && ["appId", "channel", "runtimeVersion", "platform"].every(key => update[key as keyof UpdateIdentity] === config[key as keyof FloraConfiguration]), "UPDATE_INCOMPATIBLE");
    return Object.freeze({ id: update.id, appId: update.appId, channel: update.channel, runtimeVersion: update.runtimeVersion, platform: update.platform });
  }
  async function exclusive<T>(work: () => Promise<T>): Promise<T> {
    requireCondition(!busy, "BUSY"); busy = true;
    try { await verifyNative(); return await work(); }
    catch (error) { checked = null; downloaded = null; throw error; }
    finally { busy = false; }
  }
  return Object.freeze({
    configuration: config,
    checkForUpdate: () => exclusive<CheckResult>(async () => {
      checked = null; downloaded = null; let result: CheckResult; try { result = await engine.check(); } catch (error) { await report(lastSeen, "failed", "check", error); throw error; }
      if (result.available === false) return { available: false };
      requireCondition(result.available === true, "UPDATE_INCOMPATIBLE"); checked = compatible(result.update);
      lastSeen = checked.id; await report(checked.id, "update_seen"); return { available: true, update: checked };
    }),
    downloadUpdate: () => exclusive<DownloadResult>(async () => {
      requireCondition(checked, "UPDATE_NOT_CHECKED"); const expectedId = checked.id;
      try {
        downloaded = null; const result = await engine.download();
        if (result.downloaded === false) { checked = null; return { downloaded: false }; }
        requireCondition(result.downloaded === true, "UPDATE_INCOMPATIBLE"); const update = compatible(result.update);
        requireCondition(update.id === expectedId, "UPDATE_INCOMPATIBLE"); downloaded = update;
        await report(update.id, "downloaded"); return { downloaded: true, update };
      } catch (error) { await report(expectedId, "failed", "download", error); throw error; }
    }),
    reload: () => exclusive(async () => {
      requireCondition(downloaded, "UPDATE_NOT_DOWNLOADED"); const id = downloaded.id; checked = null; downloaded = null;
      try { await telemetry?.requestActivation(id); } catch {}
      try { await engine.reload(id); } catch (error) { await report(id, "failed", "activation", error); throw error; }
    }),
  });
}
