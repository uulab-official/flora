import { ensure, object, safeJson } from "@app-ops/core";
import { applicationId, OTA_ASSET_MAX_BYTES, parseGitHubConnectionUpdate, parseOTAAssetUpload, parseOTAPublishInput, parseOTARollbackInput, parseOTASelection, otaAssetId } from "@app-ops/dogfood";
import type { OperationsService } from "@app-ops/dogfood";

export interface ManagementRoute { appId: string; action: "ota/publication" | "operations" | "github" | "github/sync" | "ota/assets" | "ota/deployments" | "ota/rollbacks"; method: "GET" | "POST"; limit: number; binary: boolean; query: string[]; deploymentId?: string }
export function managementRoute(path: string): ManagementRoute | null {
  const publication=/^\/api\/apps\/([a-z][a-z0-9_-]{2,95})\/ota\/deployments\/([a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\/publication$/.exec(path);
  if(publication) return {appId:applicationId(publication[1]),deploymentId:publication[2]!,action:"ota/publication",method:"GET",limit:0,binary:false,query:[]};
  const match = /^\/api\/apps\/([a-z][a-z0-9_-]{2,95})\/(operations|github(?:\/sync)?|ota\/(?:assets|deployments|rollbacks))$/.exec(path);
  if (!match) return null;
  const action = match[2] as ManagementRoute["action"];
  return { appId: applicationId(match[1]), action, method: action === "operations" ? "GET" : "POST", limit: action === "operations" ? 0 : action === "ota/assets" ? OTA_ASSET_MAX_BYTES : 131072, binary: action === "ota/assets", query: action === "ota/assets" ? ["key", "contentType", "fileExtension"] : [] };
}
export async function dispatchManagement(route: ManagementRoute, url: URL, data: unknown, operations: OperationsService): Promise<unknown> {
  if (route.action === "ota/publication") {ensure(route.deploymentId);return operations.getPublication(route.appId,route.deploymentId);}
  if (route.action === "operations") return operations.getState(route.appId);
  if (route.action === "ota/assets") {
    ensure(data instanceof Uint8Array);
    return operations.uploadAsset(route.appId, parseOTAAssetUpload(Object.fromEntries(route.query.map(key => [key, url.searchParams.get(key)]))), data);
  }
  if (route.action === "ota/deployments") return operations.publish(route.appId, parseOTAPublishInput(data));
  if (route.action === "ota/rollbacks") return operations.rollback(route.appId, parseOTARollbackInput(data));
  safeJson(data);
  ensure(data && typeof data === "object" && !Array.isArray(data));
  const raw = data as Record<string, unknown>;
  const resolved = Object.hasOwn(raw, "resolvedConfig");
  if (route.action === "github/sync") {
    object(raw, resolved ? ["resolvedConfig"] : []);
    return operations.detect(route.appId, resolved ? raw.resolvedConfig : undefined);
  }
  const names = ["expectedVersion", "installationId", "owner", "repository", "ref"];
  object(raw, [...names, ...(resolved ? ["resolvedConfig"] : [])]);
  const input = parseGitHubConnectionUpdate(Object.fromEntries(names.map(key => [key, raw[key]])));
  return operations.connect(route.appId, input, resolved ? raw.resolvedConfig : undefined);
}

/** Read-only native-client distribution; no cookies or management privileges. */
export async function dispatchUpdate(request: Request, operations: OperationsService, origin: string): Promise<Response> {
  const url = new URL(request.url);
  const asset = /^\/updates\/([a-z][a-z0-9_-]{2,95})\/assets\/((?:asset_)?[a-f0-9]{64})$/.exec(url.pathname);
  if (asset) {
    ensure(!url.search, "INVALID_INPUT");
    const assetId = asset[2]!.startsWith("asset_") ? asset[2]! : "asset_" + asset[2]!;
    const stored = await operations.getPublishedAsset(applicationId(asset[1]), otaAssetId(assetId));
    ensure(stored, "NOT_FOUND");
    return new Response(stored.bytes as BodyInit, { headers: { "Content-Type": stored.asset.contentType, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" } });
  }
  const match = /^\/updates\/([a-z][a-z0-9_-]{2,95})$/.exec(url.pathname);
  ensure(match, "NOT_FOUND");
  ensure([...url.searchParams.keys()].every(key => key === "channel") && url.searchParams.getAll("channel").length <= 1);
  const selection = parseOTASelection({ channel: url.searchParams.get("channel") ?? request.headers.get("expo-channel-name") ?? "production", runtimeVersion: request.headers.get("expo-runtime-version"), platform: request.headers.get("expo-platform") });
  return operations.getUpdate(applicationId(match[1]), selection, origin, request.headers);
}
