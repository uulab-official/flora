import { organizationRoute } from "./org/routes.js";
import { parseAdminPath } from "../public/admin-routes.js";

/** Shared metadata admission. The front never consumes or duplicates a body. */
export class HttpFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export const BODY_LIMITS = { auth: 8192, source: 1048576, baseline: 131072, head: 4096 } as const;
export type Route = { kind: "public-asset" | "private-asset" | "auth" | "hosted" | "internal" | "updates" | "sdk-telemetry" | "runner" | "hook" | "connection" | "credentials" | "native-management" | "native-runner" | "github-callback" | "ci-binding" | "ci-token"; path: string; limit: number; binary?: boolean; adminPath?: string };
import { managementRoute } from "@app-ops/dashboard/operations-http";
import { automationManagementRoute, automationRunnerRoute } from "@app-ops/dashboard/automation-http";
export function telemetryDetailRoute(path:string):{appId:string;deploymentId:string;installationRef:string|null}|null {
  const match=/^\/api\/apps\/([a-z][a-z0-9_-]{2,95})\/ota\/deployments\/([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\/telemetry(?:\/installations\/(i1\.[A-Za-z0-9_-]{39,480}))?$/.exec(path);
  return match?{appId:match[1]!,deploymentId:match[2]!,installationRef:match[3]??null}:null;
}
export function telemetryJourneyRoute(path:string):{appId:string;deploymentId:string;installationRef:string}|null {
  if(!path.endsWith("/journey"))return null;
  const route=telemetryDetailRoute(path.slice(0,-"/journey".length));
  return route?.installationRef?{...route,installationRef:route.installationRef}:null;
}
export function autoRollbackPolicyRoute(path: string): string | null {
  return /^\/api\/apps\/([a-z][a-z0-9_-]{2,95})\/ota\/rollback-policy$/.exec(path)?.[1] ?? null;
}
export function autoRollbackInstallationsRoute(path: string): string | null {
  return /^\/api\/apps\/([a-z][a-z0-9_-]{2,95})\/ota\/rollback-installations$/.exec(path)?.[1] ?? null;
}
const assets: Record<string, { kind: "public-asset" | "private-asset"; file: string }> = {
  "/organization.js":{kind:"public-asset",file:"/organization.js"},"/organization.css":{kind:"public-asset",file:"/organization.css"},
  "/join":{kind:"public-asset",file:"/join.html"},"/join.js":{kind:"public-asset",file:"/join.js"},"/join.css":{kind:"public-asset",file:"/join.css"},
  "/account-security.js":{kind:"private-asset",file:"/account-security.js"},
  "/project-gallery.css": {kind:"private-asset",file:"/project-gallery.css"},
  "/project-branding.js": {kind:"private-asset",file:"/project-branding.js"},
  "/onboarding-download.js": {kind:"private-asset",file:"/onboarding-download.js"},
  "/onboarding-files.js": {kind:"public-asset",file:"/onboarding-files.js"},
  "/onboarding.js": {kind:"private-asset",file:"/onboarding.js"}, "/onboarding-model.js": {kind:"private-asset",file:"/onboarding-model.js"}, "/onboarding.css": {kind:"private-asset",file:"/onboarding.css"},
  "/login": { kind: "public-asset", file: "/auth.html" }, "/setup": { kind: "public-asset", file: "/auth.html" },
  "/admin-routes.js": { kind: "public-asset", file: "/admin-routes.js" },
  "/auth.js": { kind: "public-asset", file: "/auth.js" }, "/auth.css": { kind: "public-asset", file: "/auth.css" },
  "/brand.png": { kind: "public-asset", file: "/brand.png" }, "/icons.svg": { kind: "public-asset", file: "/icons.svg" },
  "/": { kind: "private-asset", file: "/index.html" }, "/app.js": { kind: "private-asset", file: "/app.js" }, "/project-views.js": { kind: "private-asset", file: "/project-views.js" }, "/app.css": { kind: "private-asset", file: "/app.css" },
  "/deployment-devices.js": { kind: "private-asset", file: "/deployment-devices.js" },
  "/auto-rollback.js": { kind: "private-asset", file: "/auto-rollback.js" },
};
export function routeRequest(request: Request, internal = false): Route {
  const url = new URL(request.url), path = url.pathname;
  let method = "GET", kind: Route["kind"] = "auth", limit = 0, query: string[] = [];
  let binary = false;
  const orgRoute=organizationRoute(path,request.method);
  const management = managementRoute(path);
  const automation = automationManagementRoute(path), runner = automationRunnerRoute(path);
  const admin = parseAdminPath(path);
  const icon = /^\/project-icons\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,95}\.(?:png|webp|jpg)$/.test(path) && !path.includes("..");
  const asset = Object.hasOwn(assets, path) ? assets[path] : icon ? { kind: "private-asset" as const, file: path } : admin ? { kind: "private-asset" as const, file: "/index.html" } : undefined;
  if(orgRoute){kind=orgRoute.public?"auth":"hosted";method=orgRoute.method;limit=method==="POST"?16384:0;query=orgRoute.query;}
  else if (/^\/api\/native-runner\/(?:pending|claim|heartbeat|credentials|complete|fail|presence)$/.test(path)) { kind = "native-runner"; method = "POST"; limit = 16384; }
  else if (/^\/api\/apps\/[a-z][a-z0-9_-]{2,95}\/native(?:\/(?:runners|jobs)(?:\/[a-z][a-z0-9_-]{2,95}\/(?:revoke|cancel))?)?$/.test(path)) {
    kind = "native-management"; if (!path.endsWith("/native")) { method = "POST"; limit = 16384; }
  }
  else if (/^\/api\/apps\/[a-z][a-z0-9_-]{2,95}\/credentials(?:\/disable)?$/.test(path)) {
    kind = "credentials";
    if (path.endsWith("/disable") || request.method === "POST") { method = "POST"; limit = path.endsWith("/disable") ? BODY_LIMITS.auth : 1_500_000; }
  }
  else if (path === "/api/runner/presence" || path === "/api/runner/usage") { kind = "runner"; method = "POST"; limit = BODY_LIMITS.auth; }
  else if (path === "/api/runner/github/oidc") { kind = "ci-token"; method = "POST"; limit = BODY_LIMITS.auth; }
  else if (/^\/api\/apps\/[a-z][a-z0-9_-]{2,95}\/automation\/ci$/.test(path)) { kind = "ci-binding"; if (request.method === "POST") { method = "POST"; limit = BODY_LIMITS.auth; } else query = ["resolve"]; }
  else if (path === "/github/app/callback") { kind = "github-callback"; query = ["state", "code"]; }
  else if (["/api/github/connection", "/api/github/installations"].includes(path)) kind = "connection";
  else if (path === "/api/github/repositories") { kind = "connection"; query = ["installationId", "cursor"]; }
  else if (["/api/github/manifest/start", "/api/github/manifest/complete"].includes(path) || /^\/api\/apps\/[a-z][a-z0-9_-]{2,95}\/signing-key$/.test(path)) { kind = "connection"; method = "POST"; limit = BODY_LIMITS.auth; }
  else if (runner || automation) { const matched = runner ?? automation!; kind = runner ? "runner" : "hosted"; method = matched.method; limit = matched.limit; query = matched.query; binary = matched.binary; }
  else if (path === "/api/github/webhook") { kind = "hook"; method = "POST"; limit = 131072; }
  else if (telemetryJourneyRoute(path)) { kind = "hosted"; query = ["cursor"]; }
  else if (telemetryDetailRoute(path)) { kind = "hosted"; query = telemetryDetailRoute(path)!.installationRef ? ["cursor"] : ["cursor", "filter"]; }
  else if (autoRollbackPolicyRoute(path)) { kind = "hosted"; if (request.method === "POST") { method = "POST"; limit = BODY_LIMITS.auth; } }
  else if (autoRollbackInstallationsRoute(path)) { kind = "hosted"; method = "POST"; limit = BODY_LIMITS.auth; }
  else if (management) { kind = "hosted"; method = management.method; limit = management.limit; query = management.query; binary = management.binary; }
  else if (/^\/updates\/[a-z][a-z0-9_-]{2,95}\/telemetry(?:\/session)?$/.test(path)) {kind="sdk-telemetry";method="POST";limit=8192;}
  else if (/^\/updates\/[a-z][a-z0-9_-]{2,95}(?:\/assets\/(?:asset_)?[a-f0-9]{64})?$/.test(path)) { kind = "updates"; query = path.includes("/assets/") ? [] : ["channel"]; }
  else if (asset) { kind = asset.kind; if (path === "/login") query = ["returnTo"]; }
  else if (internal && path === "/_internal/session-check") kind = "internal";
  else if (["/api/auth/session", "/api/auth/options"].includes(path)) { /* GET, no query */ }
  else if (["/api/auth/login", "/api/auth/enroll", "/api/auth/recover", "/api/auth/logout", "/api/auth/reauth", "/api/auth/member/password"].includes(path)) { method = "POST"; limit = BODY_LIMITS.auth; }
  else if (path === "/api/apps") { kind = "hosted"; query=request.method==="GET"?["appCursor"]:[]; if (request.method === "POST") { method = "POST"; limit = 16384; } }
  else if (/^\/api\/apps\/[a-z][a-z0-9_-]{2,95}\/settings$/.test(path)) { kind = "hosted"; method = "POST"; limit = 65536; }
  else if (/^\/api\/apps\/[a-z][a-z0-9_-]{2,95}\/ota\/verification$/.test(path)) { kind = "hosted"; method = "POST"; limit = BODY_LIMITS.auth; }
  else if (path === "/api/projects") {kind = "hosted";query=["appCursor","appId"];}
  else if (path === "/api/state") { kind = "hosted"; query = ["snapshotId", "snapshotCursor", "historyCursor", "appId", "appCursor"]; }
  else if (/^\/api\/baselines\/[a-z][a-z0-9_-]{2,95}\/log$/.test(path)) { kind = "hosted"; query = ["appId"]; }
  else if (["/api/sources", "/api/baselines", "/api/head"].includes(path)) {
    kind = "hosted"; method = "POST";
    limit = path === "/api/sources" ? BODY_LIMITS.source : path === "/api/baselines" ? BODY_LIMITS.baseline : BODY_LIMITS.head;
    query = path === "/api/baselines" ? ["snapshotId", "appId"] : ["appId"];
  } else throw new HttpFailure(404, "NOT_FOUND");
  if (request.method !== method) throw new HttpFailure(405, "METHOD_NOT_ALLOWED");
  if(path==="/api/projects"&&url.searchParams.has("appId")&&url.searchParams.has("appCursor"))throw new HttpFailure(400,"INVALID_INPUT");
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (!query.includes(key) || seen.has(key) || !value || value.length > (["snapshotId", "appId"].includes(key) ? 96 : 512)) throw new HttpFailure(400, "INVALID_INPUT");
    if (["snapshotId", "appId"].includes(key) && !/^[a-z][a-z0-9_-]{2,95}$/.test(value)) throw new HttpFailure(400, "INVALID_INPUT");
    if (key === "filter" && !["issues", "unresolved", "resolved"].includes(value)) throw new HttpFailure(400, "INVALID_INPUT");
    if (kind === "ci-binding" && key === "resolve" && value !== "1") throw new HttpFailure(400, "INVALID_INPUT");
    if (path === "/login" && key === "returnTo") {
      const destination = parseAdminPath(value);
      if (!destination || (value !== "/" && destination.path !== value)) throw new HttpFailure(400, "INVALID_INPUT");
    }
    seen.add(key);
  }
  if (url.hash || (url.href.includes("?") && seen.size === 0) || (path === "/api/baselines" && !seen.has("snapshotId"))) throw new HttpFailure(400, "INVALID_INPUT");
  contentMetadata(request, limit, binary);
  return { kind, path: asset?.file ?? path, limit, ...(binary ? { binary: true } : {}), ...(admin ? { adminPath: admin.path } : {}) };
}
export function contentMetadata(request: Request, limit: number, binary = false): void {
  if (request.headers.has("Content-Encoding")) throw new HttpFailure(415, "JSON_REQUIRED");
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length)))) throw new HttpFailure(400, "INVALID_INPUT");
  if (limit === 0) {
    if (request.body || (length !== null && length !== "0") || request.headers.has("Transfer-Encoding")) throw new HttpFailure(400, "INVALID_INPUT");
    return;
  }
  if (!(binary ? request.headers.get("Content-Type") === "application/octet-stream" : /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("Content-Type") ?? ""))) throw new HttpFailure(415, "JSON_REQUIRED");
  if (length !== null && Number(length) > limit) throw new HttpFailure(413, "BODY_TOO_LARGE");
}
export async function readBody(request: Request, limit: number, binary = false): Promise<Uint8Array> {
  contentMetadata(request, limit, binary);
  if (!request.body || request.signal?.aborted) throw new HttpFailure(400, "INVALID_INPUT");
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HttpFailure(408, "BODY_TIMEOUT")), 10000);
    abort = () => reject(new HttpFailure(400, "BODY_CANCELLED"));
    request.signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const part = await Promise.race([reader.read(), interrupted]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new HttpFailure(413, "BODY_TOO_LARGE");
      chunks.push(part.value);
    }
    const length = request.headers.get("Content-Length");
    if (length !== null && Number(length) !== size) throw new HttpFailure(400, "INVALID_INPUT");
    const result = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } catch (error) { throw error instanceof HttpFailure ? error : new HttpFailure(400, "BODY_CANCELLED"); }
  finally {
    clearTimeout(timer);
    if (abort) request.signal?.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
  }
}
export function parseJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch { throw new HttpFailure(400, "INVALID_INPUT"); }
}
export function secureResponse(response: Response, allowGitHubManifest = false): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'" + (allowGitHubManifest ? " https://github.com" : "") + "; frame-ancestors 'none'; object-src 'none'");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.delete("Access-Control-Allow-Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
export function json(value: unknown, status = 200, headers = new Headers()): Response {
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).length > 1048576) throw new HttpFailure(503, "RESPONSE_TOO_LARGE");
  headers.set("Content-Type", "application/json; charset=utf-8");
  return secureResponse(new Response(body, { status, headers }));
}
