import { ensure } from "./errors.js";
export type Capability =
  | "build"
  | "store.upload"
  | "store.submit"
  | "ota.publish"
  | "web.deploy";
export interface ProviderDescriptor {
  id: string;
  version: string;
  capabilities: readonly Capability[];
}
export function requireCapability(
  provider: ProviderDescriptor | null,
  capability: Capability,
): void {
  ensure(provider, "PROVIDER_UNCONFIGURED");
  ensure(provider.capabilities.includes(capability), "PROVIDER_UNSUPPORTED");
}
