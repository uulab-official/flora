import type { FloraConfig, FloraEnv, SetupWindow } from "./contracts.js";

function requireConfig(condition: unknown): asserts condition {
  if (!condition) throw new Error("Invalid Flora configuration");
}
function identifier(value: unknown): string {
  requireConfig(typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(value));
  return value;
}
function binding(value: unknown, methods: string[]): void {
  requireConfig(value !== null && typeof value === "object");
  const candidate = value as Record<string, unknown>;
  requireConfig(methods.every(method => typeof candidate[method] === "function"));
}
function setupWindow(value: unknown): SetupWindow | null {
  if (value === undefined) return null;
  requireConfig(value !== null && typeof value === "object" && !Array.isArray(value));
  const setup = value as Record<string, unknown>;
  const keys = ["digest", "issuedAt", "expiresAt", "generation", "purpose"];
  requireConfig(Object.keys(setup).length === keys.length && keys.every(key => Object.hasOwn(setup, key)));
  requireConfig(typeof setup.digest === "string" && /^[a-f0-9]{64}$/.test(setup.digest));
  requireConfig(typeof setup.issuedAt === "number" && Number.isSafeInteger(setup.issuedAt) && setup.issuedAt >= 0);
  requireConfig(typeof setup.expiresAt === "number" && Number.isSafeInteger(setup.expiresAt) && setup.expiresAt === setup.issuedAt + 600_000);
  requireConfig(typeof setup.generation === "number" && Number.isSafeInteger(setup.generation) && setup.generation > 0);
  requireConfig(setup.purpose === "enroll" || setup.purpose === "recover");
  return Object.freeze({ digest: setup.digest, issuedAt: setup.issuedAt, expiresAt: setup.expiresAt, generation: setup.generation, purpose: setup.purpose });
}

/** Structural deployment validation only; the DO/D1 also verify persisted identity. */
export function readConfig(env: FloraEnv): FloraConfig {
  requireConfig(env !== null && typeof env === "object");
  let url: URL;
  try { url = new URL(env.FLORA_ORIGIN); }
  catch { throw new Error("Invalid Flora configuration"); }
  requireConfig(url.protocol === "https:" && url.origin === env.FLORA_ORIGIN && url.username === "" && url.password === "");
  const ownerId = identifier(env.FLORA_OWNER_ID), dbIdentity = identifier(env.FLORA_DB_IDENTITY);
  requireConfig(typeof env.FLORA_OWNER_EMAIL === "string" && env.FLORA_OWNER_EMAIL.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.FLORA_OWNER_EMAIL));
  binding(env.FLORA_DB, ["prepare", "batch", "exec"]);
  binding(env.FLORA_AUTH, ["idFromName", "get"]);
  binding(env.ASSETS, ["fetch"]);
  return Object.freeze({ origin: url.origin, ownerId, ownerEmail: env.FLORA_OWNER_EMAIL, dbIdentity, setup: setupWindow(env.FLORA_SETUP) });
}
