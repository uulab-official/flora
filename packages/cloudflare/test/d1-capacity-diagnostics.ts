import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";

type SocketState = { id: number; observedAt: number; completedAt: number };
type RequestState = { id: number; socket: SocketState };
type TransportEvent = { event: "send" | "headers" | "complete" | "error"; atMs: number; requestId: number;
  socketId?: number; socketObservedAgeMs?: number; socketIdleMs?: number; requestBytes?: number; status?: number; errorCode?: string };
type Notification = { request?: object & { contentLength?: unknown }; socket?: object;
  response?: { statusCode?: unknown }; error?: { code?: unknown } };
const ERROR_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_ABORTED"]);

/** Failure-only observer of this test process. No transport, timers, retries, or payload inspection. */
export function observeD1Capacity(emit: (message: string) => void) {
  const started = performance.now();
  const events: TransportEvent[] = [];
  const sockets = new WeakMap<object, SocketState>();
  const requests = new WeakMap<object, RequestState>();
  const listeners: [string, (message: unknown) => void][] = [];
  let requestId = 0, socketId = 0, observerErrors = 0;
  let batchIndex = 0, completedRows = 0, batchStarted = started, invocationMs = -1;
  let batchLoop = performance.eventLoopUtilization();
  const record = (event: TransportEvent) => { events.push(event); if (events.length > 12) events.shift(); };
  function listen(name: string, observe: (message: Notification) => void) {
    // Diagnostics must not turn their own error into a test/runtime failure.
    const listener = (message: unknown) => { try { observe(message as Notification); } catch { observerErrors++; } };
    subscribe(name, listener);
    listeners.push([name, listener]);
  }
  listen("undici:client:sendHeaders", ({ request, socket }) => {
    if (!request || !socket) return;
    const now = performance.now();
    let state = sockets.get(socket);
    if (!state) { state = { id: ++socketId, observedAt: now, completedAt: -1 }; sockets.set(socket, state); }
    const entry = { id: ++requestId, socket: state };
    requests.set(request, entry);
    record({ event: "send", atMs: now - started, requestId: entry.id, socketId: state.id,
      socketObservedAgeMs: now - state.observedAt, socketIdleMs: state.completedAt < 0 ? -1 : now - state.completedAt,
      requestBytes: typeof request.contentLength === "number" && Number.isFinite(request.contentLength) && request.contentLength >= 0 ? request.contentLength : -1 });
  });
  listen("undici:request:headers", ({ request, response }) => {
    const entry = request && requests.get(request);
    if (!entry) return;
    const status = response?.statusCode;
    record({ event: "headers", atMs: performance.now() - started, requestId: entry.id,
      status: typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : -1 });
  });
  listen("undici:request:trailers", ({ request }) => {
    const entry = request && requests.get(request);
    if (!entry) return;
    entry.socket.completedAt = performance.now();
    record({ event: "complete", atMs: entry.socket.completedAt - started, requestId: entry.id });
  });
  listen("undici:request:error", ({ request, error }) => {
    const entry = request && requests.get(request);
    if (!entry) return;
    const code = error?.code;
    record({ event: "error", atMs: performance.now() - started, requestId: entry.id,
      errorCode: typeof code === "string" && ERROR_CODES.has(code) ? code : "UNCLASSIFIED" });
  });
  return {
    beginBatch(index: number, rows: number) {
      batchIndex = index; completedRows = rows; batchStarted = performance.now(); invocationMs = -1;
      batchLoop = performance.eventLoopUtilization();
    },
    submitted() { invocationMs = performance.now() - batchStarted; },
    rethrow(error: unknown): never {
      try {
        const now = performance.now(), loop = performance.eventLoopUtilization(batchLoop);
        emit("D1_CAPACITY_DIAGNOSTIC " + JSON.stringify({ batchIndex, completedRows, elapsedMs: now - started,
          batchElapsedMs: now - batchStarted, invocationMs: invocationMs < 0 ? now - batchStarted : invocationMs,
          eventLoopActiveMs: loop.active, eventLoopIdleMs: loop.idle, eventLoopUtilization: loop.utilization,
          nodeRssBytes: process.memoryUsage.rss(), observerErrors, events }));
      } catch { /* Retain the original exception even if diagnostic output fails. */ }
      throw error;
    },
    dispose() { for (const [name, listener] of listeners.splice(0)) unsubscribe(name, listener); },
  };
}
