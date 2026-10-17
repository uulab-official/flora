import { FloraOTAError } from "./index.js";
import type { NativeConfiguration, NativeUpdateEngine, UpdateIdentity } from "./index.js";
/** Pass the installed OSS expo-updates module; there is no runtime import,
 * EAS endpoint, login, project ID, or request-header override in this adapter. */
export interface ExpoUpdatesModule {
  readonly isEnabled: boolean;
  readonly runtimeVersion: string | null;
  checkForUpdateAsync(): Promise<unknown>;
  fetchUpdateAsync(): Promise<unknown>;
  reloadAsync(): Promise<void>;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FloraOTAError("UPDATE_INCOMPATIBLE"); return value as Record<string, unknown>;
}
/** readInstalledConfiguration MUST read a native bridge/build-generated immutable
 * binding compiled into the installed binary, including URL/channel/platform.
 * Returning a JS config object is not proof of native installation. Module runtime
 * and enabled state are independently checked. Native code owns signatures/hashes,
 * rollback and safe loading; unrelated engine callers must not replace pending OTA. */
export function createExpoUpdatesAdapter(updates: ExpoUpdatesModule, readInstalledConfiguration: () => Promise<NativeConfiguration>): NativeUpdateEngine {
  let pending: UpdateIdentity | null = null;
  async function native(): Promise<NativeConfiguration> {
    const configuration = await readInstalledConfiguration();
    if (!updates.isEnabled || !updates.runtimeVersion || updates.runtimeVersion !== configuration.runtimeVersion) throw new FloraOTAError("NATIVE_CONFIGURATION_MISMATCH");
    return { ...configuration, enabled: configuration.enabled && updates.isEnabled };
  }
  async function identity(raw: unknown): Promise<UpdateIdentity> {
    const manifest = record(raw), metadata = record(manifest.metadata), flora = record(record(manifest.extra).flora), configuration = await native();
    if (typeof manifest.id !== "string" || typeof manifest.runtimeVersion !== "string" || typeof metadata.channel !== "string" || typeof flora.appId !== "string") throw new FloraOTAError("UPDATE_INCOMPATIBLE");
    return { id: manifest.id, appId: flora.appId, channel: metadata.channel, runtimeVersion: manifest.runtimeVersion, platform: configuration.platform };
  }
  return Object.freeze({
    name: "expo-updates", protocol: "expo-updates-v1", trust: "native-engine", getNativeConfiguration: native,
    async check() {
      pending = null; const result = record(await updates.checkForUpdateAsync());
      if (result.isAvailable === false || result.isRollBackToEmbedded === true) return { available: false as const };
      if (result.isAvailable !== true) throw new FloraOTAError("UPDATE_INCOMPATIBLE");
      return { available: true as const, update: await identity(result.manifest) };
    },
    async download() {
      pending = null; const result = record(await updates.fetchUpdateAsync());
      if (result.isNew === false || result.isRollBackToEmbedded === true) return { downloaded: false as const };
      if (result.isNew !== true) throw new FloraOTAError("UPDATE_INCOMPATIBLE");
      pending = await identity(result.manifest); return { downloaded: true as const, update: pending };
    },
    async reload(expectedUpdateId: string) {
      await native(); if (!pending || pending.id !== expectedUpdateId) throw new FloraOTAError("UPDATE_NOT_DOWNLOADED");
      pending = null; await updates.reloadAsync();
    },
  });
}
