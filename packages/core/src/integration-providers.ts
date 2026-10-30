import { ensure, object, safeJson, text } from "./errors.js";
import type { Capability, ProviderDescriptor } from "./providers.js";

/**
 * Manifests describe integrations; they DO NOT load third-party JavaScript,
 * grant credentials, or prove that a provider is connected or running.
 */
export type ProviderExecution = "local-pc" | "github-actions" | "external-api";
export type ProviderMaturity = "existing-runtime" | "manual-setup" | "workflow-template" | "planned";
export type ProviderPlatform = "ios" | "android" | "web";
export type ProviderAuth = "runner-token" | "github-app" | "user-api-key" | "none";

export interface IntegrationProvider extends ProviderDescriptor {
  name: string;
  execution: ProviderExecution;
  maturity: ProviderMaturity;
  platforms: readonly ProviderPlatform[];
  authentication: ProviderAuth;
  setupDocument: string;
}

const descriptor = (
  id: string, name: string, execution: ProviderExecution, maturity: ProviderMaturity,
  capabilities: readonly Capability[], platforms: readonly ProviderPlatform[],
  authentication: ProviderAuth, setupDocument: string,
): IntegrationProvider => ({
  id, name, version: "1.0.0", execution, maturity, capabilities, platforms,
  authentication, setupDocument,
});

/**
 * The catalog is deliberately truthful about what already runs vs. what is
 * only an example or a future integration. It is not a connection status API.
 */
const builtIns: readonly IntegrationProvider[] = Object.freeze([
  descriptor("flora-pc-ota", "Flora local OTA runner", "local-pc", "existing-runtime",
    ["ota.publish"], ["ios", "android"], "runner-token", "docs/development/automation-runner.ko.md"),
  descriptor("flora-pc-native", "Flora native build runner", "local-pc", "manual-setup",
    ["build"], ["ios", "android"], "runner-token", "docs/development/native-build-signing.ko.md"),
  descriptor("github-actions-native", "GitHub Actions private caller", "github-actions", "workflow-template",
    ["build"], ["ios", "android"], "github-app", "docs/development/reusable-expo-build.ko.md"),
  descriptor("expo-eas", "Expo EAS (future adapter)", "external-api", "planned",
    ["build", "ota.publish"], ["ios", "android"], "user-api-key", "docs/development/build-provider-options.ko.md"),
  descriptor("codemagic", "Codemagic (future adapter)", "external-api", "planned",
    ["build"], ["ios", "android"], "user-api-key", "docs/development/build-provider-options.ko.md"),
  descriptor("bitrise", "Bitrise (future adapter)", "external-api", "planned",
    ["build"], ["ios", "android"], "user-api-key", "docs/development/build-provider-options.ko.md"),
]);

const validCapabilities: readonly Capability[] = ["build", "store.upload", "store.submit", "ota.publish", "web.deploy"];
const validPlatforms: readonly ProviderPlatform[] = ["ios", "android", "web"];
const validExecution: readonly ProviderExecution[] = ["local-pc", "github-actions", "external-api"];
const validMaturity: readonly ProviderMaturity[] = ["existing-runtime", "manual-setup", "workflow-template", "planned"];
const validAuth: readonly ProviderAuth[] = ["runner-token", "github-app", "user-api-key", "none"];
const includes = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === "string" && values.includes(value as T);

/** Accepts descriptive third-party manifests only, never executable code or credentials. */
export function parseProviderManifest(value: unknown): IntegrationProvider {
  safeJson(value);
  const data = object(value, [
    "id", "name", "version", "execution", "maturity", "capabilities", "platforms", "authentication", "setupDocument",
  ]);
  const id = text(data.id, 64), name = text(data.name, 96), version = text(data.version, 24);
  ensure(/^[a-z][a-z0-9-]{2,63}$/.test(id) && /^\d+\.\d+\.\d+$/.test(version));
  ensure(includes(validExecution, data.execution) && includes(validMaturity, data.maturity));
  ensure(data.maturity === "planned", "PROVIDER_UNSUPPORTED"); // external metadata cannot claim installed executors
  ensure(includes(validAuth, data.authentication));
  const capabilities = data.capabilities, platforms = data.platforms;
  ensure(Array.isArray(capabilities) && capabilities.length > 0 && capabilities.length <= 5);
  ensure(Array.isArray(platforms) && platforms.length > 0 && platforms.length <= 3);
  ensure(capabilities.every(item => includes(validCapabilities, item)));
  ensure(platforms.every(item => includes(validPlatforms, item)));
  ensure(new Set(capabilities).size === capabilities.length && new Set(platforms).size === platforms.length);
  const setupDocument = text(data.setupDocument, 256);
  ensure(/^docs\/[a-zA-Z0-9_./-]+\.md$/.test(setupDocument)
    && !setupDocument.split("/").includes("..") && !setupDocument.includes("//"));
  return {
    id, name, version, execution: data.execution,
    maturity: "planned", capabilities: [...capabilities] as Capability[],
    platforms: [...platforms] as ProviderPlatform[],
    authentication: data.authentication, setupDocument,
  };
}

/** Safe, immutable-ish snapshots: callers cannot mutate built-in source arrays. */
export function listIntegrationProviders(external: readonly unknown[] = []): IntegrationProvider[] {
  ensure(external.length <= 32);
  const result = builtIns.map(item => ({
    ...item, capabilities: [...item.capabilities], platforms: [...item.platforms],
  }));
  const names = new Set(result.map(item => item.id));
  for (const item of external) {
    const entry = parseProviderManifest(item);
    ensure(!names.has(entry.id), "CONFLICT");
    names.add(entry.id); result.push(entry);
  }
  return result;
}

/**
 * Only a registered, reviewed adapter may handle an operation. Merely listing
 * a manifest or connecting a remote endpoint grants no execution permission.
 */
export function requireIntegrationAdapter(
  providers: readonly IntegrationProvider[], providerId: string, capability: Capability,
  platform: ProviderPlatform, installedAdapters: ReadonlySet<string>,
): IntegrationProvider {
  const provider = providers.find(item => item.id === providerId);
  ensure(provider, "PROVIDER_UNCONFIGURED");
  ensure(provider.maturity !== "planned", "PROVIDER_UNSUPPORTED");
  ensure(provider.capabilities.includes(capability) && provider.platforms.includes(platform), "PROVIDER_UNSUPPORTED");
  ensure(installedAdapters.has(provider.id), "PROVIDER_UNCONFIGURED");
  return provider;
}
