import { createFloraClient } from "./index.js";
import type { FloraLaunchInfo } from "./native-adapter.js";
import type { NativeConfiguration, NativeUpdateEngine } from "./index.js";

export type FloraAssetErrorCode = "NATIVE_ASSET_CONFIGURATION_INVALID" | "ASSET_METADATA_INVALID" | "ASSET_NOT_IN_MANIFEST";
export class FloraAssetError extends Error {
  readonly code: FloraAssetErrorCode;
  constructor(code: FloraAssetErrorCode) { super(code); this.name = "FloraAssetError"; this.code = code; }
}
function requireAsset(condition: unknown, code: FloraAssetErrorCode = "NATIVE_ASSET_CONFIGURATION_INVALID"): asserts condition {
  if (!condition) throw new FloraAssetError(code);
}
function record(value: unknown): Record<string, unknown> {
  requireAsset(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hashKey = /^[a-f0-9]{32}(?:[a-f0-9]{32})?$/;
const unavailable = async (): Promise<never> => { throw new FloraAssetError("NATIVE_ASSET_CONFIGURATION_INVALID"); };
const parserEngine: NativeUpdateEngine = { name: "flora-native-asset-parser", protocol: "expo-updates-v1", trust: "native-engine",
  getNativeConfiguration: unavailable, check: unavailable, download: unavailable, reload: unavailable };

export interface FloraAssetMetadata { readonly hash?: unknown; readonly fileHashes?: unknown; readonly scales?: unknown }
export interface FloraAssetSourceResolver {
  readonly asset: FloraAssetMetadata;
  fromSource(uri: string): unknown;
}
export interface FloraAssetResolver {
  readonly launch: FloraLaunchInfo;
  resolveMetadata(metadata: FloraAssetMetadata): string;
  transform(resolver: FloraAssetSourceResolver): unknown;
}

/** Reads binary-owned native constants. No URL, map or trust override is accepted
 * by the native installer. This pure codec also supports deterministic tests. */
export function createFloraAssetResolver(configurationValue: unknown, launchValue: unknown, deviceScale: () => number): FloraAssetResolver | undefined {
  const rawConfiguration = record(configurationValue), raw = record(launchValue);
  let configuration;
  try { configuration = createFloraClient(rawConfiguration as unknown as NativeConfiguration, parserEngine).configuration; }
  catch { throw new FloraAssetError("NATIVE_ASSET_CONFIGURATION_INVALID"); }
  requireAsset(rawConfiguration.enabled === true && raw.appId === configuration.appId && raw.runtimeVersion === configuration.runtimeVersion);
  requireAsset(raw.source === "embedded" || raw.source === "update");
  const entries = Object.entries(record(raw.assets));
  requireAsset(entries.length <= 64);
  if (raw.source === "embedded") { requireAsset(raw.updateId === null && entries.length === 0); return undefined; }
  requireAsset(typeof raw.updateId === "string" && uuid.test(raw.updateId));
  const updateId = raw.updateId, assets: Record<string, string> = Object.create(null), owned = new Set<string>();
  for (const [key, value] of entries) {
    requireAsset(hashKey.test(key) && typeof value === "string" && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value));
    let address;
    try { address = new URL(value); } catch { throw new FloraAssetError("NATIVE_ASSET_CONFIGURATION_INVALID"); }
    requireAsset(address.protocol === "file:" && !address.hostname && !address.search && !address.hash && value.startsWith("file:///") && value === address.href);
    let path: string;
    try { path = decodeURIComponent(address.pathname); } catch { throw new FloraAssetError("NATIVE_ASSET_CONFIGURATION_INVALID"); }
    requireAsset(!path.includes("/../") && !path.includes("/./") && !path.includes("\\"));
    const namespace = configuration.platform === "ios"
      ? new RegExp(`/FloraOTA/${configuration.appId}/[a-f0-9]{64}/${updateId}/[a-f0-9]{64}\\.[A-Za-z0-9]{1,15}$`)
      : new RegExp(`/flora-ota/[a-f0-9]{64}/updates/${updateId}/[a-f0-9]{64}\\.bin$`);
    requireAsset(namespace.test(path) && !owned.has(value));
    owned.add(value); assets[key] = value;
  }
  const launch: FloraLaunchInfo = Object.freeze({ appId: configuration.appId, runtimeVersion: configuration.runtimeVersion,
    source: "update", updateId, assets: Object.freeze(assets) });
  function resolveMetadata(metadata: FloraAssetMetadata): string {
    requireAsset(metadata && typeof metadata === "object", "ASSET_METADATA_INVALID");
    const scales = metadata.scales;
    requireAsset(Array.isArray(scales) && scales.length > 0 && scales.length <= 64
      && scales.every((scale, index) => typeof scale === "number" && Number.isFinite(scale) && scale > 0 && (index === 0 || scale > scales[index - 1])), "ASSET_METADATA_INVALID");
    let hashes: string[];
    if (metadata.fileHashes !== undefined) {
      requireAsset(Array.isArray(metadata.fileHashes) && metadata.fileHashes.length === scales.length
        && metadata.fileHashes.every(hash => typeof hash === "string" && hashKey.test(hash))
        && new Set(metadata.fileHashes).size === metadata.fileHashes.length, "ASSET_METADATA_INVALID");
      hashes = metadata.fileHashes as string[];
    } else {
      requireAsset(scales.length === 1 && typeof metadata.hash === "string" && hashKey.test(metadata.hash), "ASSET_METADATA_INVALID");
      hashes = [metadata.hash];
    }
    const scale = deviceScale();
    requireAsset(typeof scale === "number" && Number.isFinite(scale) && scale > 0, "ASSET_METADATA_INVALID");
    const index = scales.findIndex(candidate => candidate >= scale), key = hashes[index < 0 ? hashes.length - 1 : index]!;
    const uri = assets[key]; requireAsset(uri !== undefined, "ASSET_NOT_IN_MANIFEST"); return uri;
  }
  return Object.freeze({ launch, resolveMetadata,
    transform(resolver: FloraAssetSourceResolver) {
      requireAsset(resolver && typeof resolver.fromSource === "function", "ASSET_METADATA_INVALID");
      return resolver.fromSource(resolveMetadata(resolver.asset));
    } });
}
