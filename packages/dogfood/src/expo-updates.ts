import { DomainError, ensure } from "@app-ops/core";
import { importRSAPrivateKey } from "./github.js";
import type { ExpoManifestSigner } from "./operations.js";

export interface ExpoSigningCredentials { keyId: string; privateKey: string }
/** Signing credentials are distinct from GitHub App credentials. The native
 * binary must contain the matching public certificate/key ID beforehand. */
export function createRSAManifestSigner(credentials: ExpoSigningCredentials): ExpoManifestSigner {
  ensure(/^[A-Za-z0-9._-]{1,128}$/.test(credentials.keyId), "PROVIDER_UNCONFIGURED");
  let key: Promise<CryptoKey> | undefined;
  return {
    keyId: credentials.keyId,
    async sign(bytes) {
      try {
        key ??= importRSAPrivateKey(credentials.privateKey);
        return new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await key, new Uint8Array(bytes).buffer));
      } catch { throw new DomainError("PROVIDER_UNCONFIGURED"); }
    },
  };
}
