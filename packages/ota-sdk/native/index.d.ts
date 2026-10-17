import type { FloraNativeEngine } from "../dist/native-adapter.js";
import type { FloraTelemetryReporter } from "../dist/telemetry.js";
export { FloraNativeError } from "../dist/native-adapter.js";
export type { FloraLaunchInfo, FloraNativeEngine, FloraNativeErrorCode } from "../dist/native-adapter.js";
export declare function createFloraNativeEngine(options?: { telemetry?: FloraTelemetryReporter }): FloraNativeEngine;
export { FloraAssetError } from "../dist/asset-resolver.js";
export interface FloraExpoAssetConstructor {
  fromModule(value: unknown): { uri: string; localUri: string | null; downloaded: boolean };
  fromMetadata(value: any): { uri: string; localUri: string | null; downloaded: boolean };
}
/** Synchronous: call before importing routers/screens/fonts. Only binary-owned
 * verified launch constants supply asset maps and local file URIs. */
export declare function installFloraAssetResolver(options?: { expoAsset?: FloraExpoAssetConstructor }): Readonly<{
  source: "embedded" | "update"; updateId: string | null; assetCount: number;
}>;
