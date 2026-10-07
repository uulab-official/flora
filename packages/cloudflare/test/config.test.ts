import test from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../dist/config.js";
import type { FloraEnv } from "../dist/contracts.js";

// Shape-only bindings: configuration parsing must never issue a storage/network call.
function environment(): FloraEnv {
  const never = () => { throw new Error("Configuration must not call a binding"); };
  return {
    FLORA_ORIGIN: "https://flora.example.com", FLORA_OWNER_ID: "owner-synthetic",
    FLORA_OWNER_EMAIL: "owner@example.com", FLORA_DB_IDENTITY: "db-synthetic",
    FLORA_DB: { prepare: never, batch: never, exec: never } as unknown as FloraEnv["FLORA_DB"],
    FLORA_AUTH: { idFromName: never, get: never } as unknown as FloraEnv["FLORA_AUTH"],
    ASSETS: { fetch: never } as unknown as FloraEnv["ASSETS"],
  };
}
function rejects(patch: Record<string, unknown>): void {
  assert.throws(() => readConfig({ ...environment(), ...patch } as FloraEnv), { message: "Invalid Flora configuration" });
}

test("missing_owner_origin_or_binding_fails_closed", () => {
  for (const key of ["FLORA_ORIGIN", "FLORA_OWNER_ID", "FLORA_OWNER_EMAIL", "FLORA_DB_IDENTITY", "FLORA_DB", "FLORA_AUTH", "ASSETS"]) {
    for (const value of [undefined, null, "", {}]) rejects({ [key]: value });
  }
  for (const value of [" owner", "owner\n", "x".repeat(257)]) rejects({ FLORA_OWNER_ID: value });
  for (const value of ["not-an-email", "owner@example.com\n", "owner@example.com other"]) rejects({ FLORA_OWNER_EMAIL: value });
  rejects({ FLORA_DB: { prepare() {}, batch: null, exec() {} } });
  rejects({ FLORA_AUTH: { idFromName() {} } });
  rejects({ ASSETS: { fetch: true } });
});

test("non_https_or_non_origin_url_is_rejected", () => {
  for (const origin of ["http://flora.example.com", "https://flora.example.com/", "https://flora.example.com/private",
    "https://flora.example.com?owner=1", "https://flora.example.com#private", "https://owner@flora.example.com",
    "https://owner:password@flora.example.com", " https://flora.example.com", "https://flora.example.com\n", "not-a-url"]) {
    rejects({ FLORA_ORIGIN: origin });
  }
});

test("missing_setup_means_locked", () => {
  assert.deepEqual(readConfig(environment()), {
    origin: "https://flora.example.com", ownerId: "owner-synthetic", ownerEmail: "owner@example.com",
    dbIdentity: "db-synthetic", setup: null,
  });
});

test("setup_window_is_exact_bounded_and_owned", () => {
  const setup = { digest: "a".repeat(64), issuedAt: 1_000, expiresAt: 601_000, generation: 1, purpose: "enroll" as const };
  const config = readConfig({ ...environment(), FLORA_SETUP: setup });
  assert.deepEqual(config.setup, setup);
  setup.generation = 2;
  assert.equal(config.setup?.generation, 1);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.setup));
  for (const patch of [{ digest: "A".repeat(64) }, { digest: "a".repeat(63) }, { issuedAt: -1 },
    { expiresAt: 601_001 }, { generation: 0 }, { generation: 1.5 }, { generation: Number.MAX_SAFE_INTEGER + 1 },
    { purpose: "login" }, { ownerId: "untrusted" }]) rejects({ FLORA_SETUP: { ...setup, ...patch } });
  rejects({ FLORA_SETUP: JSON.stringify(setup) });
});
