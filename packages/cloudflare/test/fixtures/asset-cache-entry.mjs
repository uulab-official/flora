import worker from "../../src/worker.js";

let fault = "";
let invalidConfig = false;
const open = caches.open.bind(caches);
// Targeted local-only fault injection around the real workerd Cache API.
caches.open = async name => {
  if (fault === "open") throw new Error("fixture cache unavailable");
  const cache = await open(name);
  return new Proxy(cache, { get(target, key) {
    if (key === fault) return () => { throw new Error("fixture cache operation unavailable"); };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
};

/** Test-only published-asset authority; real Cache API and DO transport remain in use. */
export class AssetCacheFixtureAuth {
  constructor(state) { this.state = state; }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__fixture/control") {
      await this.state.storage.put("mode", await request.text());
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/__fixture/count") return Response.json(await this.state.storage.get("count") ?? 0);
    const count = (await this.state.storage.get("count") ?? 0) + 1;
    await this.state.storage.put("count", count);
    const mode = await this.state.storage.get("mode") ?? "public";
    const headers = new Headers({ "Cache-Control": "public, max-age=31536000, immutable", "ETag": '"fixture"', "X-Fixture-Origin-Call": String(count) });
    if (mode === "private") headers.set("Cache-Control", "private, max-age=31536000, immutable");
    if (mode === "no-store") headers.set("Cache-Control", "public, no-store, max-age=31536000, immutable");
    if (mode === "cookie") headers.set("Set-Cookie", "fixture=private; Secure");
    if (mode === "vary") headers.set("Vary", "Accept-Language");
    if (mode === "mutable") headers.set("Cache-Control", "public, max-age=60");
    if (mode === "failure") return new Response("unavailable", { status: 503, headers });
    if (request.headers.has("Range")) return new Response("range-origin", { status: 206, headers });
    if (request.headers.has("If-None-Match")) return new Response(null, { status: 304, headers });
    headers.set("Content-Length", String(new TextEncoder().encode(url.pathname).length));
    return new Response(url.pathname, { headers });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__fixture/")) {
      const stub = env.FLORA_AUTH.get(env.FLORA_AUTH.idFromName("flora-owner-v1"));
      if (url.pathname === "/__fixture/cache-fault") { fault = await request.text(); return new Response(null, { status: 204 }); }
      if (url.pathname === "/__fixture/invalid-config") { invalidConfig = (await request.text()) === "1"; return new Response(null, { status: 204 }); }
      return await stub.fetch(request);
    }
    return worker.fetch(request, { ...env, ...(invalidConfig ? { FLORA_OWNER_ID: "" } : {}), ASSETS: { fetch: async () => new Response("asset") } }, ctx);
  },
};
