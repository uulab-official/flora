import type { ExecutionContext, Request as BindingRequest } from "@cloudflare/workers-types";
import { readConfig } from "./config.js";
import type { FloraEnv } from "./contracts.js";
import { HttpFailure, json, routeRequest, secureResponse } from "./http.js";
import { publishedOTAAsset } from "./ota-asset-cache.js";
export { FloraAuth } from "./auth-do.js";

export default {
  async fetch(request: Request, env: FloraEnv, ctx?: Pick<ExecutionContext, "waitUntil">): Promise<Response> {
    try {
      const config = readConfig(env), url = new URL(request.url);
      if (url.origin !== config.origin) throw new HttpFailure(403, "FORBIDDEN");
      const route = routeRequest(request);
      if (route.path === "/api/auth/options") return json({ passwordMinimum: config.passwordMinimum ?? 15,
        ...(config.workspaceName ? { workspaceName: config.workspaceName } : {}),
        ...(config.workspaceName === "UULab" && config.ownerEmail === "admin@admin.com" ? { ownerEmail: config.ownerEmail } : {}) });
      if (route.kind === "updates") {
        // App-specific private signers stay inside the owner authority; no RPC
        // or HTTP response ever exports them to the front Worker or the client.
        const stub = env.FLORA_AUTH.get(env.FLORA_AUTH.idFromName("flora-owner-v1"));
        return await publishedOTAAsset(request, async () => await stub.fetch(request as unknown as BindingRequest) as unknown as Response, ctx);
      }
      if (request.method === "POST" && (route.kind === "runner" || route.kind === "hook" || route.kind === "ci-token" || route.kind === "native-runner" || route.kind === "sdk-telemetry"
        ? request.headers.has("Origin") && request.headers.get("Origin") !== config.origin
        : request.headers.get("Origin") !== config.origin)) throw new HttpFailure(403, "FORBIDDEN");
      if (route.kind === "public-asset" || route.kind === "private-asset") {
        if (route.kind === "private-asset") {
          const stub = env.FLORA_AUTH.get(env.FLORA_AUTH.idFromName("flora-owner-v1"));
          const headers = new Headers();
          const cookie = request.headers.get("Cookie"); if (cookie) headers.set("Cookie", cookie);
          const verdict = await stub.fetch(new Request(config.origin + "/_internal/session-check", { headers }) as unknown as BindingRequest);
          if (verdict.status !== 204) {
            // The accepted document entry can guide visitors to login; private
            // assets and API requests must retain their authentication errors.
            if (verdict.status === 401 && route.path === "/index.html") return secureResponse(new Response(null, { status: 302, headers: { Location: url.pathname === "/" ? "/login" : "/login?returnTo=" + encodeURIComponent(route.adminPath!) } }));
            if (verdict.status === 401 || verdict.status === 403) return json({ error: verdict.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN" }, verdict.status);
            return json({ error: "DEPENDENCY_UNAVAILABLE" }, 503);
          }
        }
        // Only admitted admin documents map to the fixed private shell; unknown URLs never fall back.
        const asset = await env.ASSETS.fetch(new Request(config.origin + route.path) as unknown as BindingRequest);
        if (asset.status !== 200) return json({ error: "DEPENDENCY_UNAVAILABLE" }, 503);
        return secureResponse(asset as unknown as Response, route.kind === "private-asset" && route.path === "/index.html");
      }
      const stub = env.FLORA_AUTH.get(env.FLORA_AUTH.idFromName("flora-owner-v1"));
      // Preserve this exact Request and body stream. There is no authentication second hop.
      return secureResponse(await stub.fetch(request as unknown as BindingRequest) as unknown as Response);
    } catch (error) {
      return error instanceof HttpFailure ? json({ error: error.code }, error.status) : json({ error: "DEPENDENCY_UNAVAILABLE" }, 503);
    }
  },
};
