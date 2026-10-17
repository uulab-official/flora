import { parseConfiguration } from "./index.js";
import type { FloraConfiguration } from "./index.js";
export type FloraTelemetryEventType = "update_seen" | "downloaded" | "activation_requested" | "launch_confirmed" | "restart_confirmed" | "failed" | "rolled_back";
export type FloraTelemetryStage = "check" | "download" | "activation" | "launch";
export type FloraTelemetryCode = "NETWORK_UNAVAILABLE" | "TIMEOUT" | "SIGNATURE_INVALID" | "ASSET_HASH_MISMATCH" | "UPDATE_INCOMPATIBLE" | "UNCONFIRMED_LAUNCH" | "STORED_UPDATE_INVALID" | "NATIVE_OPERATION_FAILED" | "CHECK_FAILED" | "DOWNLOAD_FAILED" | "ACTIVATION_FAILED" | "LAUNCH_CONFIRMATION_FAILED" | "UNKNOWN";
export interface FloraTelemetryLaunch { appId: string; runtimeVersion: string; source: "embedded" | "update"; updateId: string | null; rollback?: { updateId: string; reason: "UNCONFIRMED_LAUNCH" | "STORED_UPDATE_INVALID" } }
export interface FloraTelemetryReporter {
  record(deploymentId: string, type: FloraTelemetryEventType, detail?: { stage?: FloraTelemetryStage; code?: FloraTelemetryCode }): Promise<void>;
  requestActivation(deploymentId: string): Promise<void>;
  beginLaunch(info: FloraTelemetryLaunch): Promise<void>;
  confirmLaunch(expectedUpdateId: string | null): Promise<void>;
  flush(): Promise<void>;
}
export interface FloraTelemetryOptions {
  storage: { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };
  /** Supply a cryptographically random UUID v4, such as Crypto.randomUUID. */
  createId(): string;
  environment: "physical-device" | "android-emulator" | "ios-simulator" | "unknown";
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  storageTimeoutMs?: number;
  requestTimeoutMs?: number;
}
const maxEventAge = 7 * 24 * 60 * 60 * 1000;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const types: readonly string[] = ["update_seen", "downloaded", "activation_requested", "launch_confirmed", "restart_confirmed", "failed", "rolled_back"];
const stages: readonly string[] = ["check", "download", "activation", "launch"];
const codes: readonly string[] = ["NETWORK_UNAVAILABLE", "TIMEOUT", "SIGNATURE_INVALID", "ASSET_HASH_MISMATCH", "UPDATE_INCOMPATIBLE", "UNCONFIRMED_LAUNCH", "STORED_UPDATE_INVALID", "NATIVE_OPERATION_FAILED", "CHECK_FAILED", "DOWNLOAD_FAILED", "ACTIVATION_FAILED", "LAUNCH_CONFIRMATION_FAILED", "UNKNOWN"];
/** Never forward arbitrary native messages, URLs, stack traces, or provider data. */
export function floraTelemetryErrorCode(error: unknown, fallback: FloraTelemetryCode): FloraTelemetryCode {
  if (error && typeof error === "object") {
    const code = (error as { telemetryCode?: unknown }).telemetryCode ?? (error as { code?: unknown }).code;
    if (typeof code === "string" && codes.includes(code)) return code as FloraTelemetryCode;
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && codes.includes(message)) return message as FloraTelemetryCode;
    const aliases: Record<string, FloraTelemetryCode> = { NETWORK_ERROR: "NETWORK_UNAVAILABLE", NETWORK_FAILURE: "NETWORK_UNAVAILABLE", NETWORK_TIMEOUT: "TIMEOUT" };
    for (const candidate of [code, message]) if (typeof candidate === "string" && Object.hasOwn(aliases, candidate)) return aliases[candidate]!;
  }
  return fallback;
}
interface Event { id: string; type: FloraTelemetryEventType; observedAt: number; stage?: FloraTelemetryStage; code?: FloraTelemetryCode }
interface Entry { deploymentId: string; event: Event }
interface Ticket { token: string; expiresAt: number; environment: FloraTelemetryOptions["environment"] }
interface State { installationId: string; events: Entry[]; tickets: Record<string, Ticket>; pending?: { deploymentId: string; launchId: string; observedAt: number }; downloaded?: { deploymentId: string; launchId: string; observedAt: number } }
function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("TIMEOUT")), ms); work.then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); reject(new Error("UNAVAILABLE")); }); });
}
function timeout(value: number | undefined, fallback: number, max: number): number { return Number.isFinite(value) ? Math.max(10, Math.min(max, Math.trunc(value!))) : fallback; }
/** Opt in explicitly. Reports are durable, app scoped, bounded, and best effort;
 * telemetry can neither select an executable nor authorize a native launch. */
export function createFloraTelemetry(configuration: FloraConfiguration, options: FloraTelemetryOptions): FloraTelemetryReporter {
  const config = parseConfiguration(configuration), base = new URL(config.url), environment = options.environment;
  if (base.search || !["physical-device", "android-emulator", "ios-simulator", "unknown"].includes(environment) || config.platform === "ios" && environment === "android-emulator" || config.platform === "android" && environment === "ios-simulator") throw new Error("CONFIGURATION_INVALID");
  const key = "flora.telemetry.v1:" + encodeURIComponent(JSON.stringify([base.origin, config.appId, config.platform, config.channel, config.runtimeVersion]));
  const now = options.now ?? Date.now, storageMs = timeout(options.storageTimeoutMs, 1000, 5000), requestMs = timeout(options.requestTimeoutMs, 4000, 10000);
  const transport = options.fetch ?? globalThis.fetch;
  let storageHealthy = true;
  let state: State | undefined, loaded = false, serial = Promise.resolve(), inflight: Promise<void> | null = null, retryAt = 0, failures = 0;
  let flushRequested = false, eventRevision = 0, kickedRevision = 0, retriesRemaining = 2, retryable = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const preferredDeployments = new Set<string>();
  let lastObservedAt = 0;
  let launchId: string | undefined, launch: FloraTelemetryLaunch | undefined, confirmed = false;
  const id = () => { const value = options.createId(); if (!uuid.test(value)) throw new Error("ID_INVALID"); return value; };
  function validEvent(value: unknown): value is Entry {
    if (!value || typeof value !== "object") return false;
    const entry = value as Entry, e = entry.event;
    return uuid.test(entry.deploymentId) && !!e && uuid.test(e.id) && types.includes(e.type) && Number.isSafeInteger(e.observedAt) && e.observedAt > 0 && e.observedAt <= now() && (e.stage === undefined || stages.includes(e.stage)) && (e.code === undefined || codes.includes(e.code)) && (!(e.type === "failed" || e.type === "rolled_back") || !!e.stage && stages.includes(e.stage) && !!e.code && codes.includes(e.code));
  }
  async function load() {
    if (loaded) return; loaded = true;
    try {
      const raw = await bounded(options.storage.getItem(key), storageMs);
      if (raw && raw.length <= 65536) {
        const parsed = JSON.parse(raw) as State;
        if (uuid.test(parsed.installationId) && Array.isArray(parsed.events)) {
          state = { installationId: parsed.installationId, events: parsed.events.filter(validEvent).slice(-64).map(entry => ({ deploymentId: entry.deploymentId, event: { id: entry.event.id, type: entry.event.type, observedAt: entry.event.observedAt, ...((entry.event.type === "failed" || entry.event.type === "rolled_back") && entry.event.stage ? { stage: entry.event.stage } : {}), ...((entry.event.type === "failed" || entry.event.type === "rolled_back") && entry.event.code ? { code: entry.event.code } : {}) } })), tickets: {} };
          for (const [deploymentId, ticket] of Object.entries(parsed.tickets ?? {}).slice(-16)) if (uuid.test(deploymentId) && typeof ticket?.token === "string" && ticket.token.length > 0 && ticket.token.length <= 8192 && Number.isSafeInteger(ticket.expiresAt) && ticket.expiresAt > now() && ticket.environment === environment) state.tickets[deploymentId] = ticket;
          if (parsed.pending && uuid.test(parsed.pending.deploymentId) && uuid.test(parsed.pending.launchId) && Number.isSafeInteger(parsed.pending.observedAt) && parsed.pending.observedAt >= now() - maxEventAge && parsed.pending.observedAt <= now()) state.pending = parsed.pending;
          if (parsed.downloaded && uuid.test(parsed.downloaded.deploymentId) && uuid.test(parsed.downloaded.launchId) && Number.isSafeInteger(parsed.downloaded.observedAt) && parsed.downloaded.observedAt >= now() - maxEventAge && parsed.downloaded.observedAt <= now()) state.downloaded = parsed.downloaded;
        }
      }
    } catch { storageHealthy = false; /* Avoid new ephemeral installation identities when persistence is broken. */ }
    state ??= { installationId: id(), events: [], tickets: {} };
    lastObservedAt = Math.max(0, ...state.events.map(entry => entry.event.observedAt));
  }
  async function save() {
    if (!state || !storageHealthy) return;
    // Tickets are hints, not required for replay. Keep the serialized queue bounded.
    const encoded = JSON.stringify(state);
    if (encoded.length > 65536) { state.tickets = {}; }
    try { await bounded(options.storage.setItem(key, JSON.stringify(state)), storageMs); } catch { storageHealthy = false; throw new Error("STORAGE_UNAVAILABLE"); }
  }
  function mutate(work: () => Promise<void> | void): Promise<void> {
    const result = serial.then(async () => { await load(); await work(); await save(); });
    serial = result.catch(() => {}); return serial;
  }
  function append(deploymentId: string, type: FloraTelemetryEventType, detail: { stage?: FloraTelemetryStage; code?: FloraTelemetryCode } = {}) {
    if (!state || !uuid.test(deploymentId) || !types.includes(type) || !Number.isSafeInteger(now()) || now() <= 0 || now() < lastObservedAt) return;
    lastObservedAt = now();
    // One observation per stage per local generation; retries retain the same ID.
    const failure = type === "failed" || type === "rolled_back";
    const stage = failure ? detail.stage && stages.includes(detail.stage) ? detail.stage : "launch" : undefined;
    const code = failure ? detail.code && codes.includes(detail.code) ? detail.code : "UNKNOWN" : undefined;
    if (state.events.some(entry => entry.deploymentId === deploymentId && entry.event.type === type && entry.event.code === code && entry.event.stage === stage)) return;
    const event: Event = { id: id(), type, observedAt: now(), ...(stage ? { stage } : {}), ...(code ? { code } : {}) };
    state.events.push({ deploymentId, event }); state.events = state.events.slice(-64); eventRevision++;
  }
  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), requestMs);
    try {
      const response = await bounded(transport(new URL(base.pathname + path, base.origin).href, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "omit", redirect: "error", signal: controller.signal }), requestMs);
      if (!response.ok) throw Object.assign(new Error("NETWORK_UNAVAILABLE"), { status: response.status });
      const text = await bounded(response.text(), requestMs);
      if (text.length > 32768) throw new Error("RESULT_INVALID");
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("RESULT_INVALID");
      return parsed as Record<string, unknown>;
    } finally { clearTimeout(timer); }
  }
  async function runFlush() {
    if (now() < retryAt) return;
    try {
      await serial; await mutate(() => { const cutoff = now() - maxEventAge; state!.events = state!.events.filter(entry => entry.event.observedAt >= cutoff && entry.event.observedAt <= now()); if (state!.pending && (state!.pending.observedAt < cutoff || state!.pending.observedAt > now())) delete state!.pending; if (state!.downloaded && (state!.downloaded.observedAt < cutoff || state!.downloaded.observedAt > now())) delete state!.downloaded; });
      if (!storageHealthy) return;
      // At most four deployment batches per requested pass, never a polling loop.
      for (let batch = 0; batch < 4; batch++) {
        // Lifecycle callbacks can append while an older batch is in flight.
        // Re-read after each acknowledgement instead of freezing deployment IDs.
        await serial;
        let deploymentId: string | undefined;
        for (const preferred of preferredDeployments) {
          preferredDeployments.delete(preferred);
          if (state!.events.some(entry => entry.deploymentId === preferred)) { deploymentId = preferred; break; }
        }
        deploymentId ??= state!.events[0]?.deploymentId;
        if (!deploymentId) break;
        let ticket = state!.tickets[deploymentId];
        if (!ticket || ticket.expiresAt <= now() + 1000) {
          const result = await post("/telemetry/session", { installationId: state!.installationId, deploymentId, platform: config.platform, channel: config.channel, runtimeVersion: config.runtimeVersion, environment });
          if (typeof result.token !== "string" || result.token.length < 1 || result.token.length > 8192 || !Number.isSafeInteger(result.expiresAt) || (result.expiresAt as number) <= now()) throw new Error("RESULT_INVALID");
          ticket = { token: result.token, expiresAt: result.expiresAt as number, environment };
          const captured = ticket; await mutate(() => { state!.tickets[deploymentId] = captured; const ids = Object.keys(state!.tickets); for (const old of ids.slice(0, Math.max(0, ids.length - 16))) delete state!.tickets[old]; });
        }
        const snapshot = state!.events.filter(entry => entry.deploymentId === deploymentId).slice(0, 16);
        if (!snapshot.length) continue;
        let result: Record<string, unknown>;
        try { result = await post("/telemetry", { token: ticket.token, events: snapshot.map(entry => entry.event) }); }
        catch (error) {
          if (!error || typeof error !== "object" || (error as { status?: unknown }).status !== 401) throw error;
          // One bounded renewal; the server may revoke a still-unexpired ticket.
          await mutate(() => { delete state!.tickets[deploymentId]; });
          const renewed = await post("/telemetry/session", { installationId: state!.installationId, deploymentId, platform: config.platform, channel: config.channel, runtimeVersion: config.runtimeVersion, environment });
          if (typeof renewed.token !== "string" || renewed.token.length < 1 || renewed.token.length > 8192 || !Number.isSafeInteger(renewed.expiresAt) || (renewed.expiresAt as number) <= now()) throw new Error("RESULT_INVALID");
          const next: Ticket = { token: renewed.token, expiresAt: renewed.expiresAt as number, environment };
          await mutate(() => { state!.tickets[deploymentId] = next; });
          result = await post("/telemetry", { token: next.token, events: snapshot.map(entry => entry.event) });
        }
        const ids = new Set(snapshot.map(entry => entry.event.id));
        const acknowledged = result.accepted === true ? [...ids] : result.acknowledged;
        if (!Array.isArray(acknowledged) || acknowledged.length !== ids.size || new Set(acknowledged).size !== ids.size || acknowledged.some(value => typeof value !== "string" || !ids.has(value))) throw new Error("RESULT_INVALID");
        const ack = new Set(acknowledged);
        await mutate(() => { state!.events = state!.events.filter(entry => !ack.has(entry.event.id)); });
      }
      failures = 0; retryAt = 0; retryable = false;
    } catch (error) {
      failures = Math.min(failures + 1, 6); retryAt = now() + Math.min(3600000, 60000 * 2 ** (failures - 1));
      const status = error && typeof error === "object" ? (error as { status?: unknown }).status : undefined;
      retryable = typeof status === "number" ? status === 408 || status === 429 || status >= 500 : error instanceof Error && ["TIMEOUT", "UNAVAILABLE"].includes(error.message);
    }
  }
  function scheduleRetry() {
    if (!storageHealthy || !state?.events.length || !retryable || retryAt <= now() || retriesRemaining <= 0) {
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined; return;
    }
    if (retryTimer !== undefined) return;
    // One failure-driven timer, at most twice per new lifecycle work. A healthy
    // or idle outbox never polls, and an explicit flush cannot skip backoff.
    retryTimer = setTimeout(() => { retryTimer = undefined; retriesRemaining--; void flush(); }, Math.min(3600000, Math.max(10, retryAt - now())));
    (retryTimer as unknown as { unref?: () => void }).unref?.();
  }
  function flush(): Promise<void> {
    flushRequested = true;
    if (!inflight) inflight = (async () => {
      do {
        flushRequested = false;
        await runFlush(); await serial;
      } while (flushRequested && storageHealthy && state?.events.length && now() >= retryAt);
    })().finally(() => {
      inflight = null;
      // A caller can arrive after the driver's final check but before this
      // microtask. Hand off its wake and include that pass in the returned work.
      if (flushRequested && storageHealthy && state?.events.length && now() >= retryAt) return flush();
      scheduleRetry();
    });
    return inflight;
  }
  const kick = (deploymentId?: string) => {
    if (eventRevision !== kickedRevision) {
      kickedRevision = eventRevision; retriesRemaining = 2;
      if (inflight && deploymentId && uuid.test(deploymentId)) {
        preferredDeployments.add(deploymentId);
        if (preferredDeployments.size > 64) preferredDeployments.delete(preferredDeployments.values().next().value!);
      }
    }
    void flush();
  };
  const reporter: FloraTelemetryReporter = {
    async record(deploymentId, type, detail) { await mutate(() => { if (type === "downloaded" && uuid.test(deploymentId)) { launchId ??= id(); state!.downloaded = { deploymentId, launchId, observedAt: now() }; } append(deploymentId, type, detail); }); kick(deploymentId); },
    async requestActivation(deploymentId) { await mutate(() => { if (!uuid.test(deploymentId)) return; launchId ??= id(); state!.pending = { deploymentId, launchId, observedAt: now() }; append(deploymentId, "activation_requested", { stage: "activation" }); }); },
    async beginLaunch(info) {
      await mutate(() => {
        if (launch || info.appId !== config.appId || info.runtimeVersion !== config.runtimeVersion || (info.source !== "embedded" && info.source !== "update") || (info.source === "update" ? !info.updateId || !uuid.test(info.updateId) : info.updateId !== null)) return;
        launchId ??= id(); launch = { ...info };
        if (info.rollback && uuid.test(info.rollback.updateId) && ["UNCONFIRMED_LAUNCH", "STORED_UPDATE_INVALID"].includes(info.rollback.reason)) append(info.rollback.updateId, "rolled_back", { stage: "launch", code: info.rollback.reason });
      }); kick(info.rollback?.updateId);
    },
    async confirmLaunch(expectedUpdateId) {
      await mutate(() => {
        if (!launch || launch.updateId !== expectedUpdateId || confirmed || !expectedUpdateId || now() < lastObservedAt) return;
        confirmed = true; append(expectedUpdateId, "launch_confirmed", { stage: "launch" });
        const previous = [state!.pending, state!.downloaded].some(receipt => receipt?.deploymentId === expectedUpdateId && receipt.launchId !== launchId);
        if (previous) { append(expectedUpdateId, "restart_confirmed", { stage: "launch" }); delete state!.pending; delete state!.downloaded; }
      }); kick(expectedUpdateId ?? undefined);
    },
    flush,
  };
  return Object.freeze(reporter);
}
