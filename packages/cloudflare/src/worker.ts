import type { Request as BindingRequest } from "@cloudflare/workers-types";
import { readConfig } from "./config.js";
import type { FloraEnv } from "./contracts.js";
import { HttpFailure, json, routeRequest, secureResponse } from "./http.js";
export { FloraAuth } from "./auth-do.js";

export default {
  async fetch(request: Request, env: FloraEnv): Promise<Response> {
    try {
      const config = readConfig(env), url = new URL(request.url);
      if (url.origin !== config.origin) throw new HttpFailure(403, "FORBIDDEN");
      const route = routeRequest(request);
      if (request.method === "POST" && request.headers.get("Origin") !== config.origin) throw new HttpFailure(403, "FORBIDDEN");
      if (route.kind === "public-asset" || route.kind === "private-asset") {
        if (route.kind === "private-asset") {
          const stub = env.FLORA_AUTH.get(env.FLORA_AUTH.idFromName("flora-owner-v1"));
          const headers = new Headers();
          const cookie = request.headers.get("Cookie"); if (cookie) headers.set("Cookie", cookie);
          const verdict = await stub.fetch(new Request(config.origin + "/_internal/session-check", { headers }) as unknown as BindingRequest);
          if (verdict.status !== 204) {
            if (verdict.status === 401 || verdict.status === 403) return json({ error: verdict.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN" }, verdict.status);
            return json({ error: "DEPENDENCY_UNAVAILABLE" }, 503);
          }
        }
        // Fixed asset name, no query/SPA fallback, and no conditional-cache headers.
        const asset = await env.ASSETS.fetch(new Request(config.origin + route.path) as unknown as BindingRequest);
        if (asset.status !== 200) return json({ error: "DEPENDENCY_UNAVAILABLE" }, 503);
        return secureResponse(asset as unknown as Response);
      }
      const stub = env.FLORA_AUTH.get(env.FLORA_AUTH.idFromName("flora-owner-v1"));
      // Preserve this exact Request and body stream. There is no authentication second hop.
      return secureResponse(await stub.fetch(request as unknown as BindingRequest) as unknown as Response);
    } catch (error) {
      return error instanceof HttpFailure ? json({ error: error.code }, error.status) : json({ error: "DEPENDENCY_UNAVAILABLE" }, 503);
    }
  },
};
