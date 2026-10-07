import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { DomainError, object, id, text } from "@app-ops/core";
import type { HeadObservation } from "@app-ops/dogfood";
import type { DogfoodService } from "./service.js";
import { checkRequest, createSessionSecurity, HttpError, RESPONSE_HEADERS } from "./security.js";

const BODY_LIMIT = 2 * 1024 * 1024;
const ACTIVE = new Set(["queued", "running", "cancelling", "timing_out"]);
const ASSETS = [
  ["/", new URL("../public/index.html", import.meta.url), "text/html; charset=utf-8"],
  ["/app.js", new URL("../public/app.js", import.meta.url), "text/javascript; charset=utf-8"],
  ["/app.css", new URL("../public/app.css", import.meta.url), "text/css; charset=utf-8"],
] as const;
function send(res: ServerResponse, status: number, body?: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { ...RESPONSE_HEADERS, "Content-Type": "application/json; charset=utf-8" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}
function error(res: ServerResponse, err: unknown): void {
  if (err instanceof HttpError) { send(res, err.status, { error: err.code }); return; }
  if (err instanceof DomainError) {
    const status = err.code === "NOT_FOUND" ? 404 : ["CONFLICT", "IDEMPOTENCY_CONFLICT", "INVALID_TRANSITION", "LEASE_STALE"].includes(err.code) ? 409 : 400;
    send(res, status, { error: err.code }); return;
  }
  send(res, 500, { error: "INTERNAL_ERROR" });
}
async function bytes(req: IncomingMessage): Promise<Uint8Array> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "") || req.headers["content-encoding"]) throw new HttpError(415, "JSON_REQUIRED");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new HttpError(413, "BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}
function json(data: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)); }
  catch { throw new HttpError(400, "INVALID_INPUT"); }
}
function query(url: URL, allowed: readonly string[]): void {
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length || keys.some(key => !allowed.includes(key))) throw new HttpError(400, "INVALID_INPUT");
}

/** Local adapter only. The caller retains ownership of service/storage lifecycle. */
export async function startDashboard({ service, port = 0 }: { service: DogfoodService; port?: number }): Promise<{ origin: string; bootstrapUrl: string; close(): Promise<void> }> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new HttpError(400, "INVALID_INPUT");
  const assets = new Map<string, { bytes: Buffer; type: string }>(await Promise.all(ASSETS.map(async ([path, url, type]) => [path, { bytes: await readFile(url), type }] as const)));
  const session = createSessionSecurity(); let origin = ""; let closing: Promise<void> | null = null; let stopping = false;
  const handlers = new Set<Promise<void>>();
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    checkRequest(req, origin);
    const rawUrl = req.url ?? "";
    // Accept origin-form requests only; never normalize a supplied filesystem path.
    if (!rawUrl.startsWith("/") || rawUrl.startsWith("//") || rawUrl.includes("#")) throw new HttpError(404, "NOT_FOUND");
    const path = rawUrl.split("?")[0]!;
    const url = new URL(rawUrl, origin);
    const asset = assets.get(rawUrl);
    const cancel = /^\/api\/runs\/([a-z][a-z0-9_-]{2,95})\/cancel$/.exec(path);
    const methods = asset ? ["GET"] : path === "/api/session" ? ["GET", "POST"] : path === "/api/state" ? ["GET"] : ["/api/sources", "/api/baselines", "/api/head", "/api/runs"].includes(path) || cancel ? ["POST"] : null;
    if (!methods) throw new HttpError(404, "NOT_FOUND");
    if (!methods.includes(req.method ?? "")) { res.setHeader("Allow", methods.join(", ")); throw new HttpError(405, "METHOD_NOT_ALLOWED"); }
    if (asset) { res.writeHead(200, { ...RESPONSE_HEADERS, "Content-Type": asset.type }); res.end(asset.bytes); return; }
    query(url, path === "/api/state" || path === "/api/baselines" ? ["snapshotId"] : []);
    if (req.method === "GET") {
      const csrfToken = session.authenticate(req);
      if (req.headers["content-length"] && req.headers["content-length"] !== "0" || req.headers["transfer-encoding"]) throw new HttpError(400, "INVALID_INPUT");
      if (path === "/api/session") { send(res, 200, { csrfToken }); return; }
      const snapshotId = url.searchParams.has("snapshotId") ? id(url.searchParams.get("snapshotId")) : undefined;
      send(res, 200, await service.getState(snapshotId)); return;
    }
    if (path === "/api/session") {
      if (req.headers.origin !== origin) throw new HttpError(403, "FORBIDDEN");
      const body = object(json(await bytes(req)), ["bootstrap"]);
      const exchanged = session.exchange(body.bootstrap); res.setHeader("Set-Cookie", exchanged.cookie);
      send(res, 200, { csrfToken: exchanged.csrfToken }); return;
    }
    session.authorize(req, origin);
    const data = await bytes(req);
    if (path === "/api/sources") { send(res, 201, await service.importSource(data)); return; }
    if (path === "/api/baselines") { send(res, 201, await service.importBaseline(id(url.searchParams.get("snapshotId")), data)); return; }
    if (path === "/api/head") {
      const body = object(json(data), ["repositoryId", "rootDirectory", "headCommitSha", "observedAt", "evidenceOrigin"]);
      if (body.evidenceOrigin !== "operator-import") throw new HttpError(400, "INVALID_INPUT");
      await service.importHead(body as unknown as HeadObservation); send(res, 204); return;
    }
    if (path === "/api/runs") {
      const body = object(json(data), ["snapshotId", "requestKey"]);
      const record = await service.requestRun(id(body.snapshotId), text(body.requestKey, 256));
      send(res, ACTIVE.has(record.state) ? 202 : 200, record); return;
    }
    object(json(data), []);
    send(res, 202, await service.cancelRun(id(cancel![1])));
  }
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 10_000, connectionsCheckingInterval: 1000 }, (req, res) => {
    if (stopping) { send(res, 503, { error: "SERVER_CLOSING" }); return; }
    const deadline = setTimeout(() => { send(res, 408, { error: "REQUEST_TIMEOUT" }); res.once("finish", () => req.destroy()); }, 10_000);
    res.once("close", () => clearTimeout(deadline));
    const pending = handle(req, res).catch(err => error(res, err));
    handlers.add(pending);
    void pending.then(() => handlers.delete(pending), () => handlers.delete(pending));
  });
  server.setTimeout(10_000);
  server.on("clientError", (err, socket) => {
    if (!socket.writable || socket.writableEnded) return;
    const code = (err as NodeJS.ErrnoException).code;
    const status = code === "HPE_HEADER_OVERFLOW" ? 431 : code === "ERR_HTTP_REQUEST_TIMEOUT" ? 408 : 400;
    socket.end(`HTTP/1.1 ${status} ${status === 431 ? "Request Header Fields Too Large" : status === 408 ? "Request Timeout" : "Bad Request"}\r\n${Object.entries(RESPONSE_HEADERS).map(([k, v]) => k + ": " + v).join("\r\n")}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Dashboard did not bind");
  origin = `http://127.0.0.1:${address.port}`;
  return { origin, bootstrapUrl: `${origin}/#${session.bootstrap}`, close() {
    if (closing) return closing;
    stopping = true; session.discard();
    closing = (async () => {
      const socketsClosed = new Promise<void>((resolve, reject) => { server.close(err => err ? reject(err) : resolve()); server.closeAllConnections(); });
      // A disconnected/timed-out response can still own an awaited storage call.
      // Drain it before the caller is allowed to dispose the service/database.
      await socketsClosed;
      await Promise.allSettled([...handlers]);
    })();
    return closing;
  } };
}
