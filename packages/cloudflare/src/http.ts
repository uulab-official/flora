/** Shared metadata admission. The front never consumes or duplicates a body. */
export class HttpFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export const BODY_LIMITS = { auth: 8192, source: 1048576, baseline: 131072, head: 4096 } as const;
export type Route = { kind: "public-asset" | "private-asset" | "auth" | "hosted" | "internal"; path: string; limit: number };
const assets: Record<string, { kind: "public-asset" | "private-asset"; file: string }> = {
  "/login": { kind: "public-asset", file: "/auth.html" }, "/setup": { kind: "public-asset", file: "/auth.html" },
  "/auth.js": { kind: "public-asset", file: "/auth.js" }, "/auth.css": { kind: "public-asset", file: "/auth.css" },
  "/brand.png": { kind: "public-asset", file: "/brand.png" }, "/icons.svg": { kind: "public-asset", file: "/icons.svg" },
  "/": { kind: "private-asset", file: "/index.html" }, "/app.js": { kind: "private-asset", file: "/app.js" }, "/app.css": { kind: "private-asset", file: "/app.css" },
};
export function routeRequest(request: Request, internal = false): Route {
  const url = new URL(request.url), path = url.pathname;
  let method = "GET", kind: Route["kind"] = "auth", limit = 0, query: string[] = [];
  const asset = Object.hasOwn(assets, path) ? assets[path] : undefined;
  if (asset) kind = asset.kind;
  else if (internal && path === "/_internal/session-check") kind = "internal";
  else if (path === "/api/auth/session") { /* GET, no query */ }
  else if (["/api/auth/login", "/api/auth/enroll", "/api/auth/recover", "/api/auth/logout"].includes(path)) { method = "POST"; limit = BODY_LIMITS.auth; }
  else if (path === "/api/state") { kind = "hosted"; query = ["snapshotId", "snapshotCursor", "historyCursor"]; }
  else if (/^\/api\/baselines\/[a-z][a-z0-9_-]{2,95}\/log$/.test(path)) kind = "hosted";
  else if (["/api/sources", "/api/baselines", "/api/head"].includes(path)) {
    kind = "hosted"; method = "POST";
    limit = path === "/api/sources" ? BODY_LIMITS.source : path === "/api/baselines" ? BODY_LIMITS.baseline : BODY_LIMITS.head;
    if (path === "/api/baselines") query = ["snapshotId"];
  } else throw new HttpFailure(404, "NOT_FOUND");
  if (request.method !== method) throw new HttpFailure(405, "METHOD_NOT_ALLOWED");
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (!query.includes(key) || seen.has(key) || !value || value.length > (key === "snapshotId" ? 96 : 512)) throw new HttpFailure(400, "INVALID_INPUT");
    if (key === "snapshotId" && !/^[a-z][a-z0-9_-]{2,95}$/.test(value)) throw new HttpFailure(400, "INVALID_INPUT");
    seen.add(key);
  }
  if (url.hash || (url.href.includes("?") && seen.size === 0) || (path === "/api/baselines" && !seen.has("snapshotId"))) throw new HttpFailure(400, "INVALID_INPUT");
  contentMetadata(request, limit);
  return { kind, path: asset?.file ?? path, limit };
}
export function contentMetadata(request: Request, limit: number): void {
  if (request.headers.has("Content-Encoding")) throw new HttpFailure(415, "JSON_REQUIRED");
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length)))) throw new HttpFailure(400, "INVALID_INPUT");
  if (limit === 0) {
    if (request.body || (length !== null && length !== "0") || request.headers.has("Transfer-Encoding")) throw new HttpFailure(400, "INVALID_INPUT");
    return;
  }
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("Content-Type") ?? "")) throw new HttpFailure(415, "JSON_REQUIRED");
  if (length !== null && Number(length) > limit) throw new HttpFailure(413, "BODY_TOO_LARGE");
}
export async function readBody(request: Request, limit: number): Promise<Uint8Array> {
  contentMetadata(request, limit);
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
export function secureResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
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
