import { DurableObject } from "cloudflare:workers";
import { readConfig } from "./config.js";
import type { AuthGrant, FloraConfig, FloraEnv } from "./contracts.js";
import { createPasswordVerifier, verifyPassword } from "./auth/password.js";
import { AuthFailure, AuthState } from "./auth-state.js";
import { createD1ImportStore } from "./d1-import-store.js";
import { handleHostedApi, hostedFailure } from "./hosted-api.js";
import { HttpFailure, json, parseJson, readBody, routeRequest, secureResponse } from "./http.js";

const sessionName = "__Host-flora_session", csrfName = "__Host-flora_csrf";
const cookieOptions = "; Secure; HttpOnly; SameSite=Strict; Path=/";
const maxBody = 8192, lifetime = 3_600_000;

function encode(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function decode(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const raw = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "="), character => character.charCodeAt(0));
  return raw.length === 32 && encode(raw) === value ? raw : null;
}
async function digest(bytes: Uint8Array): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, "0")).join("");
}
function cookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header || header.length > 4096) return null;
  const matches = header.split(";").map(value => value.trim()).filter(value => value.startsWith(name + "="));
  return matches.length === 1 ? matches[0]!.slice(name.length + 1) : null;
}
function validPassword(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256 || new TextEncoder().encode(value).length > 1024) return false;
  let length = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff || ++length > 128) return false;
  }
  return length >= 15;
}
function origin(request: Request, config: FloraConfig): void {
  if (new URL(request.url).origin !== config.origin) throw new AuthFailure(403, "FORBIDDEN");
  if (!["GET", "HEAD"].includes(request.method) && request.headers.get("Origin") !== config.origin) throw new AuthFailure(403, "FORBIDDEN");
}

/** The sole owner authority. Instantiate through idFromName("flora-owner-v1"). */
export class FloraAuth extends DurableObject<FloraEnv> {
  private state: AuthState | undefined;
  private readonly ready: Promise<void>;
  private heavy: "kdf" | "import" | null = null;
  private readonly grants = new WeakSet<AuthGrant>();

  constructor(ctx: ConstructorParameters<typeof DurableObject<FloraEnv>>[0], env: FloraEnv) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      try { this.state = new AuthState(ctx.storage, readConfig(env)); }
      catch { /* Unavailable until eviction/redeploy; never expose storage errors. */ }
    });
  }

  private config(): FloraConfig {
    if (!this.state) throw new AuthFailure(503, "AUTH_UNAVAILABLE");
    const config = readConfig(this.env);
    this.state.synchronize(config, Date.now());
    return config;
  }

  tryHeavy(kind: "kdf" | "import"): (() => void) | null {
    if (this.heavy !== null) return null;
    this.heavy = kind;
    let active = true;
    return () => { if (active) { active = false; this.heavy = null; } };
  }

  async requireSession(request: Request): Promise<AuthGrant> {
    await this.ready;
    try {
      const config = this.config();
      origin(request, config);
      const rawSession = decode(cookie(request, sessionName)), rawCsrf = decode(cookie(request, csrfName));
      if (!rawSession || !rawCsrf) throw new AuthFailure(401, "UNAUTHENTICATED");
      const sessionHash = await digest(rawSession), csrfHash = await digest(rawCsrf);
      const session = this.state!.session(sessionHash, Date.now());
      if (session.csrf_hash !== csrfHash) throw new AuthFailure(401, "UNAUTHENTICATED");
      if (!["GET", "HEAD"].includes(request.method) && request.headers.get("X-Flora-CSRF") !== encode(rawCsrf)) throw new AuthFailure(403, "FORBIDDEN");
      const grant = Object.freeze({ ownerId: config.ownerId, sessionHash, epoch: session.epoch, expiresAt: session.expires_at });
      this.grants.add(grant);
      return grant;
    } catch (error) { throw error instanceof AuthFailure ? error : new AuthFailure(503, "AUTH_UNAVAILABLE"); }
  }

  /** Synchronous fence immediately before each D1 submission, never after it. */
  assertCurrent(grant: AuthGrant): void {
    try {
      this.config();
      if (!this.grants.has(grant)) throw new AuthFailure(401, "UNAUTHENTICATED");
      this.state!.assertCurrent(grant, Date.now());
    } catch (error) { throw error instanceof AuthFailure ? error : new AuthFailure(503, "AUTH_UNAVAILABLE"); }
  }

  private async body(request: Request): Promise<Record<string, unknown>> {
    const value = parseJson(await readBody(request, maxBody));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuthFailure(400, "INVALID_REQUEST");
    return value as Record<string, unknown>;
  }

  private async newSession() {
    const session = crypto.getRandomValues(new Uint8Array(32)), csrf = crypto.getRandomValues(new Uint8Array(32));
    return { sessionToken: encode(session), csrfToken: encode(csrf), sessionHash: await digest(session), csrfHash: await digest(csrf), expiresAt: Date.now() + lifetime };
  }

  private async authenticate(request: Request, kind: "login" | "enroll" | "recover"): Promise<Response> {
    const release = this.tryHeavy("kdf");
    if (!release) throw new AuthFailure(409, "BUSY", 1);
    try {
      const input = await this.body(request), config = this.config();
      const keys = kind === "login" ? ["email", "password"] : ["email", "password", "token", "confirmation"];
      if (Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) throw new AuthFailure(400, "INVALID_REQUEST");
      if (kind !== "login" && input.confirmation !== input.password) throw new AuthFailure(400, "INVALID_REQUEST");
      let tokenDigest: string | undefined, setup: FloraConfig["setup"] = null;
      if (kind !== "login") {
        const token = decode(input.token);
        if (!token || input.email !== config.ownerEmail) throw new AuthFailure(403, "SETUP_UNAVAILABLE");
        tokenDigest = await digest(token);
        setup = this.state!.requireSetup(config, kind, tokenDigest, Date.now());
      }
      if (!validPassword(input.password)) throw new AuthFailure(kind === "login" ? 401 : 400, kind === "login" ? "UNAUTHENTICATED" : "INVALID_PASSWORD");
      const owner = this.state!.owner();
      const runnable = kind !== "login" || input.email === config.ownerEmail && owner.verifier !== null;
      this.state!.reserve(Date.now(), runnable);
      await this.ctx.storage.sync();
      if (!runnable) throw new AuthFailure(401, "UNAUTHENTICATED");
      if (kind === "login" && !await verifyPassword(input.password, owner.verifier!)) throw new AuthFailure(401, "UNAUTHENTICATED");
      const verifier = kind === "login" ? null : await createPasswordVerifier(input.password);
      const session = await this.newSession();
      const currentConfig = this.config(), now = Date.now();
      if (kind === "login") this.state!.login(owner.epoch, session, now);
      else this.state!.claim(currentConfig, setup!, tokenDigest!, verifier!, session, now);
      const headers = new Headers();
      headers.append("Set-Cookie", sessionName + "=" + session.sessionToken + cookieOptions + "; Max-Age=3600");
      headers.append("Set-Cookie", csrfName + "=" + session.csrfToken + cookieOptions + "; Max-Age=3600");
      return json({ csrfToken: session.csrfToken, expiresAt: session.expiresAt }, 200, headers);
    } finally { release(); }
  }

  override async fetch(request: Request): Promise<Response> {
    await this.ready;
    try {
      origin(request, this.config());
      const route = routeRequest(request, true), path = new URL(request.url).pathname;
      if (route.kind === "internal") {
        const grant = await this.requireSession(request); this.assertCurrent(grant);
        return secureResponse(new Response(null, { status: 204 }));
      }
      if (route.kind === "hosted") {
        const grant = await this.requireSession(request);
        const release = request.method === "POST" ? this.tryHeavy("import") : null;
        if (request.method === "POST" && !release) throw new AuthFailure(409, "BUSY", 1);
        try {
          const store = createD1ImportStore(this.env.FLORA_DB, this.config(), () => this.assertCurrent(grant));
          const response = await handleHostedApi(request, store, Date.now);
          this.assertCurrent(grant);
          return response;
        } catch (error) {
          if (error instanceof AuthFailure) throw error;
          return hostedFailure(error);
        } finally { release?.(); }
      }
      if (request.method === "GET" && path === "/api/auth/session") {
        const grant = await this.requireSession(request);
        this.assertCurrent(grant);
        return json({ csrfToken: cookie(request, csrfName), expiresAt: grant.expiresAt });
      }
      if (request.method === "POST") {
        if (path === "/api/auth/login") return await this.authenticate(request, "login");
        if (path === "/api/auth/enroll") return await this.authenticate(request, "enroll");
        if (path === "/api/auth/recover") return await this.authenticate(request, "recover");
        if (path === "/api/auth/logout") {
          const grant = await this.requireSession(request);
          const input = await this.body(request);
          if (Object.keys(input).length !== 0) throw new AuthFailure(400, "INVALID_REQUEST");
          this.assertCurrent(grant);
          this.state!.logout(grant, Date.now());
          const headers = new Headers();
          for (const name of [sessionName, csrfName]) headers.append("Set-Cookie", name + "=" + cookieOptions + "; Max-Age=0");
          return json({ ok: true }, 200, headers);
        }
      }
      return json({ error: "NOT_FOUND" }, 404);
    } catch (error) {
      if (error instanceof HttpFailure) return json({ error: error.code }, error.status);
      const failure = error instanceof AuthFailure ? error : new AuthFailure(503, "AUTH_UNAVAILABLE");
      const headers = new Headers();
      if (failure.retryAfter !== undefined) headers.set("Retry-After", String(failure.retryAfter));
      return json({ error: failure.code }, failure.status, headers);
    }
  }
}
