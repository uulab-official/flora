import type { DurableObjectState, Request as WorkerRequest } from "@cloudflare/workers-types";
import { FloraAuth } from "../../dist/auth-do.js";
import type { AuthGrant, FloraEnv } from "../../src/contracts.js";

// Test-only controls, never imported by a production entrypoint. Every request
// still runs the real authority and native scrypt against local SQLite storage.
let clock = 1_800_000_000_000;
Date.now = () => clock;

export class FixtureAuth {
  private authority: FloraAuth;
  private readonly fixtureEnv: FloraEnv;
  private grant: AuthGrant | undefined;
  private release: (() => void) | null = null;
  private jumpOnReservation: number | undefined;
  private setupOnReservation: FloraEnv["FLORA_SETUP"] | undefined;
  private failStorage = false;
  private failSync = false;
  private readonly randomValues = crypto.getRandomValues.bind(crypto);
  private readonly hash = crypto.subtle.digest.bind(crypto.subtle);

  constructor(private readonly ctx: DurableObjectState, env: FloraEnv) {
    this.fixtureEnv = { ...env, ASSETS: { fetch: async () => new Response("fixture") } as unknown as FloraEnv["ASSETS"] };
    const sql = ctx.storage.sql;
    const exec = sql.exec.bind(sql);
    sql.exec = ((query: string, ...values: (string | number | null | ArrayBuffer)[]) => {
      if (this.failStorage) throw new Error("SYNTHETIC_STORAGE_PRIVATE_DETAIL");
      const result = exec(query, ...values);
      if (query.includes("UPDATE flora_auth_budget") && this.jumpOnReservation !== undefined) {
        clock = this.jumpOnReservation;
        this.jumpOnReservation = undefined;
      }
      if (query.includes("UPDATE flora_auth_budget") && this.setupOnReservation) {
        this.fixtureEnv.FLORA_SETUP = this.setupOnReservation;
        this.setupOnReservation = undefined;
      }
      return result;
    }) as typeof sql.exec;
    const sync = ctx.storage.sync.bind(ctx.storage);
    ctx.storage.sync = () => this.failSync ? Promise.reject(new Error("SYNTHETIC_SYNC_PRIVATE_DETAIL")) : sync();
    this.authority = new FloraAuth(ctx, this.fixtureEnv);
    this.recreate = () => { this.authority = new FloraAuth(ctx, this.fixtureEnv); };
  }
  private readonly recreate: () => void;

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/__test/control") {
      const action = await request.json() as { now?: number; setup?: FloraEnv["FLORA_SETUP"] | null; ownerEmail?: string; restart?: boolean; evict?: boolean; sql?: string; failStorage?: boolean; failSync?: boolean; failCrypto?: "random" | "digest" | "off"; jumpOnReservation?: number; setupOnReservation?: FloraEnv["FLORA_SETUP"]; heavy?: "take" | "release"; assertGrant?: boolean; fakeGrant?: boolean };
      if (action.now !== undefined) clock = action.now;
      if (action.setup === null) delete this.fixtureEnv.FLORA_SETUP;
      else if (action.setup) this.fixtureEnv.FLORA_SETUP = action.setup;
      if (action.ownerEmail) this.fixtureEnv.FLORA_OWNER_EMAIL = action.ownerEmail;
      if (action.failStorage !== undefined) this.failStorage = action.failStorage;
      if (action.failSync !== undefined) this.failSync = action.failSync;
      if (action.jumpOnReservation !== undefined) this.jumpOnReservation = action.jumpOnReservation;
      if (action.setupOnReservation) this.setupOnReservation = action.setupOnReservation;
      if (action.failCrypto) {
        crypto.getRandomValues = action.failCrypto === "random" ? () => { throw new Error("SYNTHETIC_RANDOM_PRIVATE_DETAIL"); } : this.randomValues;
        crypto.subtle.digest = action.failCrypto === "digest" ? () => { throw new Error("SYNTHETIC_HASH_PRIVATE_DETAIL"); } : this.hash;
      }
      if (action.restart) this.recreate();
      if (action.evict) this.ctx.abort("Synthetic eviction");
      if (action.heavy === "take") this.release = this.authority.tryHeavy("import");
      if (action.heavy === "release") { this.release?.(); this.release?.(); this.release = null; }
      if (action.sql) return Response.json(this.ctx.storage.sql.exec(action.sql).toArray());
      if (action.assertGrant) {
        try { this.authority.assertCurrent(this.grant!); return new Response("current"); }
        catch { return new Response("rejected", { status: 401 }); }
      }
      if (action.fakeGrant) {
        try { this.authority.assertCurrent({ ...this.grant! }); return new Response("current"); }
        catch { return new Response("rejected", { status: 401 }); }
      }
      return new Response("ok");
    }
    if (new URL(request.url).pathname === "/__test/auth-before-body") {
      // Consume only the outer fixture envelope. A real login can fail closed
      // before reading its body; sending that denial during a local HTTP upload
      // otherwise races Miniflare/undici connection reuse on some platforms.
      const bytes = new Uint8Array(await request.arrayBuffer());
      let reads = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) { reads++; controller.enqueue(bytes); controller.close(); },
      }, { highWaterMark: 0 });
      const response = await this.authority.fetch(new Request(new URL("/api/auth/login", request.url), {
        method: "POST", headers: request.headers, body,
      }));
      response.headers.set("X-Flora-Test-Body-Reads", String(reads));
      return response;
    }
    if (new URL(request.url).pathname === "/__test/unread-body") {
      let reads = 0;
      const body = new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.error(new Error("Unexpected body read")); } }, { highWaterMark: 0 });
      const response = await this.authority.fetch(new Request(new URL("/api/auth/login", request.url), { method: "POST", headers: { Origin: this.fixtureEnv.FLORA_ORIGIN, "Content-Type": "application/json" }, body }));
      return Response.json({ status: response.status, reads });
    }
    if (new URL(request.url).pathname === "/__test/slow-body") {
      const body = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); } }, { highWaterMark: 0 });
      return this.authority.fetch(new Request(new URL("/api/auth/login", request.url), { method: "POST", headers: { Origin: this.fixtureEnv.FLORA_ORIGIN, "Content-Type": "application/json" }, body }));
    }
    if (new URL(request.url).pathname === "/__test/grant") {
      try { this.grant = await this.authority.requireSession(request); return new Response("ok"); }
      catch { return new Response("rejected", { status: 401 }); }
    }
    return this.authority.fetch(request);
  }
}

export default {
  fetch(request: Request, env: FloraEnv) {
    return env.FLORA_AUTH.get(env.FLORA_AUTH.idFromName("flora-owner-v1")).fetch(request as unknown as WorkerRequest);
  },
};
