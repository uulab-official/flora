import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { DomainError, ensure, object, id, text } from "@app-ops/core";
import { parseApplicationRegistration, parseSettingsUpdate, verifyGitHubWebhook, parseGitHubWebhook } from "@app-ops/dogfood";
import type { HeadObservation } from "@app-ops/dogfood";
import type { DogfoodService } from "./service.js";
import { dispatchManagement, dispatchUpdate, managementRoute } from "./operations-http.js";
import { automationManagementRoute, automationRunnerRoute, AutomationHttpFailure, dispatchAutomationManagement, dispatchAutomationRunner, runnerToken, runnerUploadLease } from "./automation-http.js";
import { checkRequest, createSessionSecurity, HttpError, RESPONSE_HEADERS } from "./security.js";

const BODY_LIMIT = 2 * 1024 * 1024;
const ACTIVE = new Set(["queued", "running", "cancelling", "timing_out"]);
const ASSETS = [
  ["/", new URL("../public/index.html", import.meta.url), "text/html; charset=utf-8"],
  ["/app.js", new URL("../public/app.js", import.meta.url), "text/javascript; charset=utf-8"],
  ["/app.css", new URL("../public/app.css", import.meta.url), "text/css; charset=utf-8"],
  ["/brand.png", new URL("../public/brand.png", import.meta.url), "image/png"],
  ["/icons.svg", new URL("../public/icons.svg", import.meta.url), "image/svg+xml"],
] as const;
function send(res: ServerResponse, status: number, body?: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { ...RESPONSE_HEADERS, "Content-Type": "application/json; charset=utf-8" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}
function error(res: ServerResponse, err: unknown): void {
  if (err instanceof HttpError || err instanceof AutomationHttpFailure) { send(res, err.status, { error: err.code }); return; }
  if (err instanceof DomainError) {
    const status = ["NOT_FOUND", "GITHUB_REPOSITORY_UNAVAILABLE", "GITHUB_REF_NOT_FOUND"].includes(err.code) ? 404 : ["PERMISSION_DENIED", "GITHUB_ACCESS_DENIED"].includes(err.code) ? 403 : err.code === "GITHUB_APP_UNSUPPORTED" ? 422 : ["PROVIDER_UNCONFIGURED", "PROVIDER_UNSUPPORTED"].includes(err.code) ? 503 : ["CONFLICT", "CONFIG_CONFLICT", "IDEMPOTENCY_CONFLICT", "INVALID_TRANSITION", "LEASE_STALE"].includes(err.code) ? 409 : 400;
    send(res, status, { error: err.code }); return;
  }
  send(res, 500, { error: "INTERNAL_ERROR" });
}
async function bytes(req: IncomingMessage, limit = BODY_LIMIT, binary = false): Promise<Uint8Array> {
  if (!(binary ? req.headers["content-type"] === "application/octet-stream" : /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "")) || req.headers["content-encoding"]) throw new HttpError(415, "JSON_REQUIRED");
  if (binary && Number(req.headers["content-length"]) > limit) throw new HttpError(413, "BODY_TOO_LARGE");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "BODY_TOO_LARGE");
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
export async function startDashboard({ service, port = 0, githubWebhookSecret }: { service: DogfoodService; port?: number; githubWebhookSecret?: string }): Promise<{ origin: string; bootstrapUrl: string; close(): Promise<void> }> {
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
    if (path === "/api/github/webhook") {
      if (req.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
      query(url, []); ensure(service.automation && githubWebhookSecret, "PROVIDER_UNCONFIGURED");
      ensure(/^sha256=[a-f0-9]{64}$/.test(typeof req.headers["x-hub-signature-256"] === "string" ? req.headers["x-hub-signature-256"] : ""), "PERMISSION_DENIED");
      const data = await bytes(req, 131072), headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(",") : value);
      await verifyGitHubWebhook(data, headers.get("X-Hub-Signature-256"), githubWebhookSecret);
      const event = parseGitHubWebhook(data, headers);
      send(res, 202, event ? await service.automation.handleGitHubPush(event) : { jobs: [], ignored: 1 }); return;
    }
    const asset = assets.get(rawUrl);
    if (path.startsWith("/updates/")) {
      if (req.method !== "GET") throw new HttpError(405, "METHOD_NOT_ALLOWED");
      if (req.headers["transfer-encoding"] || req.headers["content-length"] && req.headers["content-length"] !== "0") throw new HttpError(400, "INVALID_INPUT");
      ensure(service.operations, "PROVIDER_UNSUPPORTED");
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(",") : value);
      const response = await dispatchUpdate(new Request(url, { headers }), service.operations, origin);
      res.writeHead(response.status, { ...RESPONSE_HEADERS, ...Object.fromEntries(response.headers) });
      res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined); return;
    }
    const management = managementRoute(path);
    const automation = automationManagementRoute(path), runner = automationRunnerRoute(path);
    const cancel = /^\/api\/runs\/([a-z][a-z0-9_-]{2,95})\/cancel$/.exec(path);
    const settings = /^\/api\/apps\/([a-z][a-z0-9_-]{2,95})\/settings$/.exec(path);
    const methods = automation || runner ? [(automation ?? runner)!.method] : management ? [management.method] : asset ? ["GET"] : path === "/api/session" || path === "/api/apps" ? ["GET", "POST"] : path === "/api/state" ? ["GET"] : ["/api/sources", "/api/baselines", "/api/head", "/api/runs"].includes(path) || cancel || settings ? ["POST"] : null;
    if (!methods) throw new HttpError(404, "NOT_FOUND");
    if (!methods.includes(req.method ?? "")) { res.setHeader("Allow", methods.join(", ")); throw new HttpError(405, "METHOD_NOT_ALLOWED"); }
    if (asset) { res.writeHead(200, { ...RESPONSE_HEADERS, "Content-Type": asset.type }); res.end(asset.bytes); return; }
    query(url, automation || runner ? (automation ?? runner)!.query : management ? management.query : path === "/api/state" || path === "/api/baselines" ? ["snapshotId", "appId"] : ["/api/sources", "/api/head", "/api/runs"].includes(path) || cancel ? ["appId"] : []);
    if (runner) {
      ensure(service.automation, "PROVIDER_UNSUPPORTED");
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(",") : value);
      await service.automation.authorizeRunner(runnerToken(headers), runner.binary ? runnerUploadLease(headers) : undefined);
      const data = await bytes(req, runner.limit, runner.binary);
      const result = await dispatchAutomationRunner(runner, url, headers, runner.binary ? data : json(data), service.automation);
      send(res, result === null ? 204 : runner.binary || runner.action === "claim" ? 201 : 200, result === null ? undefined : result); return;
    }
    const appId = url.searchParams.has("appId") ? id(url.searchParams.get("appId")) : undefined;
    if (req.method === "GET") {
      const csrfToken = session.authenticate(req);
      if (req.headers["content-length"] && req.headers["content-length"] !== "0" || req.headers["transfer-encoding"]) throw new HttpError(400, "INVALID_INPUT");
      if (path === "/api/session") { send(res, 200, { csrfToken }); return; }
      if (automation) { ensure(service.automation, "PROVIDER_UNSUPPORTED"); send(res, 200, await dispatchAutomationManagement(automation, null, service.automation)); return; }
      if (management) { ensure(service.operations, "PROVIDER_UNSUPPORTED"); send(res, 200, await dispatchManagement(management, url, null, service.operations)); return; }
      if (path === "/api/apps") { send(res, 200, (await service.getState()).applications ?? []); return; }
      const snapshotId = url.searchParams.has("snapshotId") ? id(url.searchParams.get("snapshotId")) : undefined;
      send(res, 200, await service.getState(snapshotId, appId)); return;
    }
    if (path === "/api/session") {
      if (req.headers.origin !== origin) throw new HttpError(403, "FORBIDDEN");
      const body = object(json(await bytes(req)), ["bootstrap"]);
      const exchanged = session.exchange(body.bootstrap); res.setHeader("Set-Cookie", exchanged.cookie);
      send(res, 200, { csrfToken: exchanged.csrfToken }); return;
    }
    session.authorize(req, origin);
    if (automation) {
      ensure(service.automation, "PROVIDER_UNSUPPORTED");
      const result = await dispatchAutomationManagement(automation, json(await bytes(req, automation.limit)), service.automation);
      send(res, ["enroll", "queue"].includes(automation.action) ? 201 : 200, result); return;
    }
    if (management) {
      ensure(service.operations, "PROVIDER_UNSUPPORTED");
      const data = await bytes(req, management.limit, management.binary);
      send(res, 201, await dispatchManagement(management, url, management.binary ? data : json(data), service.operations)); return;
    }
    const data = await bytes(req);
    if (path === "/api/apps") { ensure(service.registerApplication, "PROVIDER_UNSUPPORTED"); send(res, 201, await service.registerApplication(parseApplicationRegistration(json(data)))); return; }
    if (settings) { ensure(service.updateApplicationSettings, "PROVIDER_UNSUPPORTED"); send(res, 200, await service.updateApplicationSettings(id(settings[1]), parseSettingsUpdate(json(data)))); return; }
    if (path === "/api/sources") { send(res, 201, await service.importSource(data, appId)); return; }
    if (path === "/api/baselines") { send(res, 201, await service.importBaseline(id(url.searchParams.get("snapshotId")), data, appId)); return; }
    if (path === "/api/head") {
      const body = object(json(data), ["repositoryId", "rootDirectory", "headCommitSha", "observedAt", "evidenceOrigin"]);
      if (body.evidenceOrigin !== "operator-import") throw new HttpError(400, "INVALID_INPUT");
      await service.importHead(body as unknown as HeadObservation, appId); send(res, 204); return;
    }
    if (path === "/api/runs") {
      const body = object(json(data), ["snapshotId", "requestKey"]);
      const record = await service.requestRun(id(body.snapshotId), text(body.requestKey, 256), appId);
      send(res, ACTIVE.has(record.state) ? 202 : 200, record); return;
    }
    object(json(data), []);
    send(res, 202, await service.cancelRun(id(cancel![1]), appId));
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
