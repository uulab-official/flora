import type { DurableObjectState, Request as BindingRequest } from "@cloudflare/workers-types";
import worker, { FloraAuth } from "../../dist/worker.js";
import type { FloraEnv } from "../../src/contracts.js";

const consoleRecords: { level: string; args: string[] }[] = [];
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  console[level] = (...args: unknown[]) => { consoleRecords.push({ level, args: args.map(value => typeof value === "string" ? value : JSON.stringify(value)) }); };
}
let clock = 1_800_000_000_000;
Date.now = () => clock;
const assetBinding = { fetch: async (request: Request) => new Response(["/index.html", "/app.js", "/app.css"].includes(new URL(request.url).pathname) ? "PRIVATE_ASSET" : "GENERIC_AUTH_ASSET") };

/** Test-only race/dependency controls. This module never enters the product bundle. */
export class HostedFixtureAuth {
  private authority: FloraAuth;
  private readonly fixtureEnv: FloraEnv;
  private failD1 = false;
  private failAuth = false;
  private revokeBeforeD1Read = false;
  private revokeAfterSubmission = false;
  private loseResponse = false;
  private writes = 0;
  private held: { release: () => void; response: Promise<Response> } | null = null;
  private readonly recreate: () => void;
  constructor(private readonly ctx: DurableObjectState, env: FloraEnv) {
    const sql = ctx.storage.sql, exec = sql.exec.bind(sql);
    sql.exec = ((query: string, ...args: (string | number | null | ArrayBuffer)[]) => {
      if (this.failAuth) throw new Error("SYNTHETIC_PRIVATE_AUTH_QUOTA");
      return exec(query, ...args);
    }) as typeof sql.exec;
    const revoke = () => { exec("DELETE FROM flora_auth_sessions"); };
    const wrapStatement = (statement: ReturnType<FloraEnv["FLORA_DB"]["prepare"]>): ReturnType<FloraEnv["FLORA_DB"]["prepare"]> => new Proxy(statement, { get: (target, key) => {
      if (key === "bind") return (...args: unknown[]) => wrapStatement(target.bind(...args));
      const member = Reflect.get(target, key);
      if (typeof member !== "function") return member;
      return async (...args: unknown[]) => {
        if (this.failD1) throw new Error("SYNTHETIC_PRIVATE_D1_QUOTA");
        const result = await member.apply(target, args);
        if (this.revokeBeforeD1Read) { this.revokeBeforeD1Read = false; revoke(); }
        return result;
      };
    }});
    const db = new Proxy(env.FLORA_DB, { get: (target, key) => {
      if (key === "prepare") return (query: string) => wrapStatement(target.prepare(query));
      if (key === "batch") return async (statements: Parameters<FloraEnv["FLORA_DB"]["batch"]>[0]) => {
        this.writes++;
        if (this.failD1) throw new Error("SYNTHETIC_PRIVATE_D1_QUOTA");
        const pending = target.batch(statements);
        if (this.revokeAfterSubmission) { this.revokeAfterSubmission = false; revoke(); }
        const result = await pending;
        if (this.loseResponse) { this.loseResponse = false; throw new Error("SYNTHETIC_LOST_RESPONSE"); }
        return result;
      };
      const member = Reflect.get(target, key); return typeof member === "function" ? member.bind(target) : member;
    }});
    this.fixtureEnv = { ...env, FLORA_DB: db, ASSETS: assetBinding as unknown as FloraEnv["ASSETS"] };
    this.authority = new FloraAuth(ctx, this.fixtureEnv);
    this.recreate = () => { this.authority = new FloraAuth(ctx, this.fixtureEnv); };
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.headers.get("X-Flora-Fixture-Stream-Probe") === "1") {
      // Count pulls at the real DO authority boundary, not at the outer transport.
      const reader = request.body!.getReader(), writesBefore = this.writes;
      let reads = 0, bytesRead = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const part = await reader.read();
          if (part.done) controller.close();
          else { reads++; bytesRead += part.value.byteLength; controller.enqueue(part.value); }
        },
        cancel(reason) { return reader.cancel(reason); },
      }, { highWaterMark: 0 });
      const result = await this.authority.fetch(new Request(request, { body }));
      return Response.json({ status: result.status, body: await result.json(), reads, bytesRead,
        contentLength: request.headers.get("Content-Length"), writes: this.writes - writesBefore });
    }
    if (path === "/__test/control") {
      const data = await request.json() as { now?: number; restart?: boolean; failD1?: boolean; failAuth?: boolean; revokeBeforeD1Read?: boolean; revokeAfterSubmission?: boolean; loseResponse?: boolean; stats?: boolean; evict?: boolean; sql?: string; captureConsole?: boolean; probeConsole?: boolean; resetConsole?: boolean; holdImport?: string; releaseImport?: boolean };
      if (data.probeConsole) console.info("SYNTHETIC_CAPTURE_PROBE");
      if (data.resetConsole) consoleRecords.length = 0;
      if (data.captureConsole) return Response.json({ logs: consoleRecords });
      if (data.sql) return Response.json(this.ctx.storage.sql.exec(data.sql).toArray());
      if (data.evict) this.ctx.abort("Synthetic eviction");
      if (data.holdImport !== undefined) {
        if (this.held) return new Response("held", { status: 409 });
        let begin!: () => void, release!: () => void;
        const started = new Promise<void>(resolve => { begin = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        const body = new ReadableStream<Uint8Array>({ async pull(c) { begin(); await gate; c.enqueue(new TextEncoder().encode(data.holdImport!)); c.close(); } }, { highWaterMark: 0 });
        const headers = new Headers(request.headers); headers.delete("Content-Length");
        const response = this.authority.fetch(new Request(this.fixtureEnv.FLORA_ORIGIN + "/api/sources", { method: "POST", headers, body }));
        this.held = { release, response }; this.ctx.waitUntil(response.then(() => {}));
        const admission = await Promise.race([started.then(() => null), response]);
        return admission ?? Response.json({ held: true });
      }
      if (data.releaseImport) {
        if (!this.held) return new Response("missing", { status: 404 });
        this.held.release(); const response = await this.held.response; this.held = null;
        return Response.json({ status: response.status, body: await response.json() });
      }
      if (data.now !== undefined) clock = data.now;
      for (const key of ["failD1", "failAuth", "revokeBeforeD1Read", "revokeAfterSubmission", "loseResponse"] as const) if (data[key] !== undefined) this[key] = data[key];
      if (data.restart) this.recreate();
      return Response.json({ writes: this.writes });
    }
    const headers = new Headers(request.headers); headers.set("Content-Type", "application/json"); headers.set("Origin", this.fixtureEnv.FLORA_ORIGIN);
    if (path === "/__test/slow-import") {
      const body = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); } }, { highWaterMark: 0 });
      return this.authority.fetch(new Request(this.fixtureEnv.FLORA_ORIGIN + "/api/sources", { method: "POST", headers, body }));
    }
    if (path === "/__test/body-probe") {
      const call = async (length: number, declared: string | null, cancel = false) => {
        const metadata = new Headers(headers);
        if (declared !== null) metadata.set("Content-Length", declared); else metadata.delete("Content-Length");
        const body = new ReadableStream<Uint8Array>({ start(c) { if (cancel) c.error(new Error("SYNTHETIC_CANCELLED")); else { c.enqueue(new Uint8Array(length).fill(32)); c.close(); } } });
        return (await this.authority.fetch(new Request(this.fixtureEnv.FLORA_ORIGIN + "/api/sources", { method: "POST", headers: metadata, body }))).status;
      };
      return Response.json({ missing: await call(1048576, null), lying: await call(1048577, "1"), mismatched: await call(3, "4"), cancelled: await call(0, null, true), writes: this.writes });
    }
    if (path === "/__test/admission-probe") {
      const cases = [
        { headers: { "X-Flora-CSRF": "invalid" } }, { headers: { Origin: "https://other.example.test" } },
        { headers: { "Content-Type": "text/plain" } }, { headers: { "Content-Encoding": "gzip" } },
        { headers: { "Content-Length": "1048577" } }, { path: "/api/sources?wrong=1" },
        { method: "PATCH" }, { path: "/api/baselines" }, { path: "/api/auth/login", headers: { "Content-Encoding": "identity" } },
      ];
      const results = [];
      for (const item of cases) {
        let reads = 0;
        const h = new Headers(headers);
        for (const [key, value] of Object.entries(item.headers ?? {})) if (value !== undefined) h.set(key, value);
        const body = new ReadableStream<Uint8Array>({ pull(c) { reads++; c.error(new Error("Unexpected body read")); } }, { highWaterMark: 0 });
        const result = await this.authority.fetch(new Request(this.fixtureEnv.FLORA_ORIGIN + (item.path ?? "/api/sources"), { method: item.method ?? "POST", headers: h, body }));
        results.push({ status: result.status, reads });
      }
      return Response.json(results);
    }
    return this.authority.fetch(request);
  }
}
export default {
  async fetch(request: Request, env: FloraEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/__test/stream-size-probe") {
      // Fully receive the synthetic outer upload before exercising cancellation.
      // The inner request still traverses the real front and real DO byte reader.
      const input = await request.json() as { path: string; bodyBase64: string };
      const bytes = Uint8Array.from(atob(input.bodyBase64), character => character.charCodeAt(0));
      let offset = 0;
      const body = new ReadableStream<Uint8Array>({ pull(controller) {
        const end = Math.min(offset + 16_384, bytes.length);
        controller.enqueue(bytes.subarray(offset, end)); offset = end;
        if (offset === bytes.length) controller.close();
      } }, { highWaterMark: 0 });
      const headers = new Headers(request.headers);
      headers.delete("Content-Length"); headers.delete("Transfer-Encoding");
      headers.set("X-Flora-Fixture-Stream-Probe", "1");
      return worker.fetch(new Request(env.FLORA_ORIGIN + input.path, { method: "POST", headers, body }), {
        ...env, ASSETS: assetBinding as unknown as FloraEnv["ASSETS"],
      });
    }
    if (path === "/__test/declared-size-probe") {
      // Test metadata rejection inside workerd: a huge known-length TCP upload may
      // otherwise reset the local emulator socket when the front rejects it unread.
      const input = await request.json() as { path: string; length: number };
      let reads = 0, authorityCalls = 0;
      const body = new ReadableStream<Uint8Array>({ pull(controller) {
        reads++; controller.error(new Error("Unexpected declared-oversize body read"));
      } }, { highWaterMark: 0 });
      const headers = new Headers(request.headers);
      headers.set("Content-Length", String(input.length));
      const result = await worker.fetch(new Request(env.FLORA_ORIGIN + input.path, { method: "POST", headers, body }), {
        ...env, ASSETS: assetBinding as unknown as FloraEnv["ASSETS"], FLORA_AUTH: {
          idFromName() { authorityCalls++; throw new Error("Unexpected declared-oversize authority call"); },
          get() { throw new Error("Unexpected declared-oversize authority lookup"); },
        } as unknown as FloraEnv["FLORA_AUTH"],
      });
      return Response.json({ status: result.status, body: await result.json(), reads, authorityCalls });
    }
    if (path === "/__test/front-probe") {
      let calls = 0, sameRequest = false, reads = 0;
      const body = new ReadableStream<Uint8Array>({ pull(c) { reads++; c.error(new Error("Front touched upload")); } }, { highWaterMark: 0 });
      body.tee = () => { throw new Error("Front tee"); };
      const original = new Request(env.FLORA_ORIGIN + "/api/sources", { method: "POST", headers: { Origin: env.FLORA_ORIGIN, "Content-Type": "application/json" }, body });
      for (const name of ["json", "text", "arrayBuffer", "clone"] as const) Object.defineProperty(original, name, { value: () => { throw new Error("Front consumed request"); } });
      const reply = new Response("streamed response", { status: 207 });
      for (const name of ["json", "text", "arrayBuffer", "clone"] as const) Object.defineProperty(reply, name, { value: () => { throw new Error("Front consumed response"); } });
      const result = await worker.fetch(original, { ...env, ASSETS: assetBinding as unknown as FloraEnv["ASSETS"], FLORA_AUTH: {
        idFromName(name: string) { if (name !== "flora-owner-v1") throw new Error("Wrong singleton"); return "fixed"; },
        get() { return { fetch(candidate: Request) { calls++; sameRequest = candidate === original; return Promise.resolve(reply); } }; },
      } as unknown as FloraEnv["FLORA_AUTH"] });
      return Response.json({ status: result.status, calls, sameRequest, reads, body: await result.text() });
    }
    if (path.startsWith("/__test/")) return env.FLORA_AUTH.get(env.FLORA_AUTH.idFromName("flora-owner-v1")).fetch(request as unknown as BindingRequest) as unknown as Promise<Response>;
    return worker.fetch(request, { ...env, ASSETS: assetBinding as unknown as FloraEnv["ASSETS"] });
  },
};
