/** Trusted Expo configuration gate. Repository config runs only in the export
 * container; its claimed settings are compared with a pre-install source snapshot. */
import { X509Certificate } from "node:crypto";
import { join } from "node:path";
import { invariant, readBoundedFile } from "./artifacts.js";
import { trustedProcess,ProcessFailure,diagnosticCode } from "./process.js";
import type { AutomationConfigSnapshot } from "@app-ops/dogfood";

export interface ExpoExportJob {
  appId: string;
  channel: string;
  platform: "ios" | "android";
  config: AutomationConfigSnapshot;
}
interface FloraConnection {
  appId: string; url: string; channel: string; runtimeVersion: string;
  certificate: string; keyId: string;
}
const connectionKeys = ["appId", "url", "channel", "runtimeVersion", "certificate", "keyId"] as const;
function record(value: unknown): Record<string, unknown> {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), "CONFIG_CHANGED");
  return value as Record<string, unknown>;
}
function connection(input: unknown, plugin = false): FloraConnection {
  const value = record(input), keys: readonly string[] = plugin ? [...connectionKeys, "disableExpoUpdates"] : connectionKeys;
  invariant(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), "CONFIG_CHANGED");
  if (plugin) invariant(value.disableExpoUpdates === true, "CONFIG_CHANGED");
  const { appId, url, channel, runtimeVersion, certificate, keyId } = value;
  invariant(typeof appId === "string" && /^[a-z][a-z0-9_-]{2,95}$/.test(appId), "CONFIG_CHANGED");
  invariant(typeof channel === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(channel), "CONFIG_CHANGED");
  invariant(typeof runtimeVersion === "string" && runtimeVersion.length > 0 && Buffer.byteLength(runtimeVersion) <= 128 && !/[\u0000-\u001f\u007f]/.test(runtimeVersion), "CONFIG_CHANGED");
  invariant(typeof keyId === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(keyId), "CONFIG_CHANGED");
  invariant(typeof url === "string" && url.length <= 2048 && typeof certificate === "string" && Buffer.byteLength(certificate) <= 16384, "CONFIG_CHANGED");
  try {
    const address = new URL(url);
    invariant(address.protocol === "https:" && address.hostname && !address.username && !address.password && !address.hash
      && address.pathname === `/updates/${appId}` && (!address.search || address.search === `?channel=${channel}`)
      && url === `${address.origin}/updates/${appId}${address.search}`, "CONFIG_CHANGED");
    const pem = certificate.replace(/\r\n/g, "\n").trim() + "\n";
    invariant(/^-----BEGIN CERTIFICATE-----\n(?:[A-Za-z0-9+/=]+\n)+-----END CERTIFICATE-----\n$/.test(pem), "CONFIG_CHANGED");
    const key = new X509Certificate(pem).publicKey, bits = key.asymmetricKeyDetails?.modulusLength;
    invariant(key.asymmetricKeyType === "rsa" && bits && bits >= 2048 && bits <= 8192, "CONFIG_CHANGED");
    return { appId, url, channel, runtimeVersion, certificate: pem, keyId };
  } catch { throw new Error("CONFIG_CHANGED"); }
}

/** Read before dependency install scripts can mutate the copied source. The
 * controller's clean tracked checkout and source digest bind this public file. */
export async function readExpoConnection(root: string): Promise<FloraConnection | undefined> {
  let bytes: Uint8Array;
  try { bytes = await readBoundedFile(root, "flora.connection.json", 32768); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("CONFIG_CHANGED"); }
  try { return connection(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
  catch { throw new Error("CONFIG_CHANGED"); }
}

export function verifyExpoConfiguration(job: ExpoExportJob, input: unknown, committedConnection?: unknown): "flora" | "expo-updates" {
  const config = record(input);
  invariant(job.config.bundler === "expo" && job.config.platforms.includes(job.platform), "CONFIG_CHANGED");
  const native = config[job.platform] === undefined ? {} : record(config[job.platform]);
  const runtime = native.runtimeVersion ?? config.runtimeVersion;
  invariant(runtime === job.config.runtimeVersion, "CONFIG_CHANGED");
  if (config.platforms !== undefined) invariant(Array.isArray(config.platforms) && config.platforms.includes(job.platform), "CONFIG_CHANGED");
  const plugins = config.plugins === undefined ? [] : config.plugins;
  invariant(Array.isArray(plugins), "CONFIG_CHANGED");
  const flora = plugins.filter(entry => entry === "@flora/ota/plugin" || Array.isArray(entry) && entry[0] === "@flora/ota/plugin");
  const updates = record(config.updates);
  if (committedConnection !== undefined || flora.length > 0) {
    invariant(Array.isArray(config.platforms) && config.platforms.includes(job.platform), "CONFIG_CHANGED");
    invariant(committedConnection !== undefined && flora.length === 1 && Array.isArray(flora[0]) && flora[0].length === 2, "CONFIG_CHANGED");
    const source = connection(committedConnection), resolved = connection(flora[0][1], true);
    invariant(connectionKeys.every(key => source[key] === resolved[key]), "CONFIG_CHANGED");
    invariant(source.appId === job.appId && source.channel === job.channel && source.url === job.config.updatesUrl && source.runtimeVersion === job.config.runtimeVersion, "CONFIG_CHANGED");
    invariant(updates.enabled === false && (updates.url === undefined || updates.url === source.url), "CONFIG_CHANGED");
    return "flora";
  }
  invariant(updates.url === job.config.updatesUrl && updates.enabled !== false, "CONFIG_CHANGED");
  return "expo-updates";
}

/** Called only by the container entrypoint (or explicit test fixture). No daemon
 * CLI option can select this helper as a host execution fallback. */
export async function exportExpoProject(root: string, output: string, job: ExpoExportJob, env: Record<string, string>, committedConnection?: unknown): Promise<void> {
  const cli = join(root, "node_modules/expo/bin/cli");
  const command=async(stage:"expo-config"|"expo-export",args:string[],timeoutMs:number,maxBytes:number)=>{try{return await trustedProcess(process.execPath,[cli,...args],{cwd:root,env,timeoutMs,maxBytes,diagnostics:"expo"});}catch(error){throw new ProcessFailure(diagnosticCode(error),{diagnostic:true,stage,code:diagnosticCode(error)});}};
  const raw = await command("expo-config",["config", "--json"],60000,262144);
  let config: unknown; try { config = JSON.parse(raw); } catch { throw new Error("CONFIG_CHANGED"); }
  verifyExpoConfiguration(job, config, committedConnection);
  await command("expo-export",["export", "--platform", job.platform, "--output-dir", output],300000,1024*1024);
}
