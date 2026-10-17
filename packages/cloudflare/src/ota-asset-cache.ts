import type { ExecutionContext, Response as BindingResponse } from "@cloudflare/workers-types";
import { OTA_ASSET_MAX_BYTES } from "@app-ops/dogfood";

const cacheName = "flora-published-ota-assets-v1";
const bypassHeaders = ["Authorization", "Cookie", "Range", "If-Range", "If-Match", "If-None-Match", "If-Modified-Since", "If-Unmodified-Since", "Cache-Control", "Pragma"];

function cacheable(response: Response): boolean {
  if (response.status !== 200 || response.headers.has("Set-Cookie") || response.headers.has("Vary") || response.headers.has("Content-Encoding")) return false;
  const directives = (response.headers.get("Cache-Control") ?? "").toLowerCase().split(",").map(value => value.trim());
  // Accept only the immutable public-asset contract, never a personalized or
  // revalidation-dependent response. Cache API otherwise changes HTTP semantics.
  if (directives.length !== 3 || !directives.includes("public") || !directives.includes("immutable")) return false;
  const ttl = directives.find(value => /^max-age=[1-9][0-9]*$/.test(value));
  if (!ttl || Number(ttl.slice(8)) > 31536000) return false;
  const size = response.headers.get("Content-Length");
  return size !== null && /^[1-9][0-9]*$/.test(size) && Number(size) <= OTA_ASSET_MAX_BYTES;
}

/** Call only AFTER configuration, origin and route admission. No body buffering.
 * The authority verifies published app/digest membership on every cache miss;
 * verified immutable artifacts may then be served without D1 or R2 operations.
 */
export async function publishedOTAAsset(request: Request, authoritativeFetch: () => Promise<Response>, ctx?: Pick<ExecutionContext, "waitUntil">): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.search || url.hash
    || !/^\/updates\/[a-z][a-z0-9_-]{2,95}\/assets\/(?:asset_)?[a-f0-9]{64}$/.test(url.pathname)
    || bypassHeaders.some(name => request.headers.has(name))) return authoritativeFetch();

  let cache: Awaited<ReturnType<typeof caches.open>>;
  // Header-free, full canonical URL keys isolate origin, app and digest. Range,
  // conditional and authenticated requests retain the authority's behavior.
  const key = url.href;
  try {
    cache = await caches.open(cacheName);
    const hit = await cache.match(key);
    if (hit && cacheable(hit as unknown as Response)) return hit as unknown as Response;
  } catch {
    // Cache outages must still pass through the authoritative free-budget guard.
    return authoritativeFetch();
  }
  const response = await authoritativeFetch();
  if (cacheable(response)) {
    try {
      const store = cache.put(key, response.clone() as unknown as BindingResponse).catch(() => undefined);
      if (ctx) ctx.waitUntil(store);
      else await store; // Direct/test callers have no background request lifetime.
    } catch { /* Cache failure never replaces the already-authorized response. */ }
  }
  return response;
}
