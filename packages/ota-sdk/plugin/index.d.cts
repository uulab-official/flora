/** Public, immutable settings returned by the Flora server for one registered app.
 * The certificate contains only the signing public key; private keys stay on the server. */
declare namespace withFloraOTA {
interface FloraOTAPluginOptions {
  appId: string;
  url: string;
  channel: string;
  runtimeVersion: string;
  certificate: string;
  keyId: string;
  /** Explicit opt-in: disable a competing expo-updates loader for this binary. */
  disableExpoUpdates: true;
}
}
declare function withFloraOTA<T extends { updates?: { enabled?: boolean; [key: string]: unknown } }>(config: T, options: withFloraOTA.FloraOTAPluginOptions): T;
export = withFloraOTA;
