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
    dbIdentity: "db-synthetic", setup: null, orgLimits: {metadataBytes:67_108_864,auditBytes:268_435_456},
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


test("only explicit UULab deployments can opt into the 12 codepoint policy", () => {
  const uulab = { ...environment(), FLORA_WORKSPACE_NAME: "UULab", FLORA_PASSWORD_MIN_LENGTH: "12" };
  assert.equal(readConfig(uulab).passwordMinimum, 12);
  assert.equal(readConfig(uulab).workspaceName, "UULab");
  assert.equal(readConfig(environment()).passwordMinimum, undefined);
  assert.equal(readConfig({ ...environment(), FLORA_WORKSPACE_NAME: "UULab" }).passwordMinimum, undefined);
  for (const patch of [{FLORA_PASSWORD_MIN_LENGTH: "12"}, {FLORA_WORKSPACE_NAME: "Other", FLORA_PASSWORD_MIN_LENGTH: "12"},
    {FLORA_WORKSPACE_NAME: "UULab", FLORA_PASSWORD_MIN_LENGTH: "11"}, {FLORA_PASSWORD_MIN_LENGTH: 12}, {FLORA_WORKSPACE_NAME: "UULab\n"}]) rejects(patch);
});

test("optional private R2 binding is structurally checked without any provider call", () => {
  const never = () => { throw new Error("Configuration must not call R2"); };
  assert.deepEqual(readConfig({ ...environment(), FLORA_OTA_ASSETS: { get: never, put: never } as unknown as NonNullable<FloraEnv["FLORA_OTA_ASSETS"]> }), readConfig(environment()));
  for (const value of [null, "bucket", {}, { get: never }, { put: never }, { get: never, put: true }]) rejects({ FLORA_OTA_ASSETS: value });
});

test("GitHub asset storage pins private repository identity and excludes simultaneous R2 configuration", () => {
  const github = { FLORA_OTA_ASSET_STORAGE: "github-releases", FLORA_OTA_ASSET_REPOSITORY: "uulab-official/flora-ota-assets", FLORA_OTA_ASSET_REPOSITORY_ID: "1422798122", FLORA_OTA_ASSET_INSTALLATION_ID: "170528052" };
  assert.deepEqual(readConfig({ ...environment(), ...github }), readConfig(environment()));
  for (const key of ["FLORA_OTA_ASSET_REPOSITORY", "FLORA_OTA_ASSET_REPOSITORY_ID", "FLORA_OTA_ASSET_INSTALLATION_ID"]) for (const value of [undefined, null, "", "01", "bad/repo/path"]) rejects({ ...github, [key]: value });
  for (const patch of [{FLORA_OTA_ASSET_STORAGE:"disk"}, {FLORA_OTA_ASSETS:{get(){},put(){}}}, {FLORA_OTA_ASSET_REPOSITORY_ID:"9007199254740992"}, {FLORA_OTA_ASSET_REPOSITORY:"https://github.com/owner/repo"}]) rejects({...github,...patch});
  rejects({ FLORA_OTA_ASSET_REPOSITORY: github.FLORA_OTA_ASSET_REPOSITORY });
});

test('organization storage budgets are operator-controlled positive safe byte counts',()=>{
  const config=readConfig(environment()) as any;
  assert.deepEqual(config.orgLimits,{metadataBytes:67_108_864,auditBytes:268_435_456});
  assert.deepEqual((readConfig({...environment(),FLORA_ORG_METADATA_BYTES:'2048',FLORA_ORG_AUDIT_BYTES:'4096'} as FloraEnv) as any).orgLimits,{metadataBytes:2048,auditBytes:4096});
  for(const key of ['FLORA_ORG_METADATA_BYTES','FLORA_ORG_AUDIT_BYTES'])for(const value of ['0','-1','1.5','01','9007199254740992','1e9',' 1024',12,null])rejects({[key]:value});
});
