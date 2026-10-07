import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
} as const;
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}
function equal(received: unknown, secret: string | null): boolean {
  // Fixed-size canonical tokens avoid both length-dependent comparison and coercion.
  if (!secret || typeof received !== "string" || !/^[a-f0-9]{64}$/.test(received)) return false;
  return timingSafeEqual(Buffer.from(received, "hex"), Buffer.from(secret, "hex"));
}
export function checkRequest(req: IncomingMessage, origin: string): void {
  const seen = new Set<string>();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!.toLowerCase();
    if (name.startsWith("x-forwarded-") || name === "forwarded" || seen.has(name)) throw new HttpError(403, "FORBIDDEN");
    seen.add(name);
  }
  if (req.headers.host !== new URL(origin).host) throw new HttpError(403, "FORBIDDEN");
  if (req.headers.origin !== undefined && req.headers.origin !== origin) throw new HttpError(403, "FORBIDDEN");
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") throw new HttpError(403, "FORBIDDEN");
}
export function createSessionSecurity() {
  let bootstrap: string | null = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + 300_000;
  let session: string | null = null;
  let csrf: string | null = null;
  return {
    get bootstrap() { return bootstrap; },
    exchange(value: unknown) {
      if (Date.now() >= expiresAt || !equal(value, bootstrap)) throw new HttpError(401, "SESSION_REQUIRED");
      bootstrap = null;
      session = randomBytes(32).toString("hex"); csrf = randomBytes(32).toString("hex");
      return { cookie: `flora_session=${session}; HttpOnly; SameSite=Strict; Path=/`, csrfToken: csrf };
    },
    authenticate(req: IncomingMessage): string {
      const cookies = (req.headers.cookie ?? "").split(";").map(item => item.trim()).filter(item => item.startsWith("flora_session="));
      if (cookies.length !== 1 || !equal(cookies[0]!.slice("flora_session=".length), session)) throw new HttpError(401, "SESSION_REQUIRED");
      return csrf!;
    },
    authorize(req: IncomingMessage, origin: string): void {
      this.authenticate(req);
      if (req.headers.origin !== origin || !equal(req.headers["x-flora-csrf"], csrf)) throw new HttpError(403, "FORBIDDEN");
    },
    discard(): void { bootstrap = session = csrf = null; },
  };
}
