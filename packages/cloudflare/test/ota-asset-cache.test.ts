import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createTestRuntime } from "./runtime.ts";

const origin = "https://flora.example.test";
const digest = "a".repeat(64);
const asset = `/updates/application_one/assets/asset_${digest}`;
async function harness(t: TestContext) {
  const runtime = await createTestRuntime({ entrypoint: new URL("./fixtures/asset-cache-entry.mjs", import.meta.url),
    durableObjects: { FLORA_AUTH: "AssetCacheFixtureAuth" }, bindings: {
      FLORA_ORIGIN: origin, FLORA_OWNER_ID: "synthetic-owner", FLORA_OWNER_EMAIL: "owner@example.test", FLORA_DB_IDENTITY: "synthetic-db",
    } });
  t.after(() => runtime.dispose());
  return {
    call: (path = asset, init?: Parameters<typeof runtime.fetch>[1]) => runtime.fetch(origin + path, init),
    raw: runtime.fetch,
    mode: async (value: string) => { const response = await runtime.fetch(origin + "/__fixture/control", { method: "POST", body: value }); assert.equal(response.status, 204); },
    cacheFault: async (value: string) => { const response = await runtime.fetch(origin + "/__fixture/cache-fault", { method: "POST", body: value }); assert.equal(response.status, 204); },
    count: async () => Number(await (await runtime.fetch(origin + "/__fixture/count")).json()),
  };
}

async function read(response: { status: number; text(): Promise<string>; headers: { get(name: string): string | null } }) {
  return { status: response.status, text: await response.text(), call: response.headers.get("X-Fixture-Origin-Call") };
}

test("immutable published OTA assets reuse real edge cache and isolate app and digest", async t => {
  const h = await harness(t);
  const first = await read(await h.call()); assert.equal(first.status, 200); assert.equal(first.call, "1");
  const second = await read(await h.call()); assert.deepEqual(second, first); assert.equal(await h.count(), 1);
  const other = await read(await h.call(asset.replace("application_one", "application_two"))); assert.equal(other.call, "2");
  const digestTwo = await read(await h.call(asset.replace(digest, "b".repeat(64)))); assert.equal(digestTwo.call, "3");
  assert.equal((await read(await h.call())).call, "1");
});

test("front origin method query and path admission still precedes a populated cache", async t => {
  const h = await harness(t); await read(await h.call());
  for (const [url, init, expected] of [
    [origin + asset + "?override=1", undefined, 400],
    [origin + asset + "?", undefined, 400],
    [origin + asset, { method: "POST" }, 405],
    [origin + asset.replace("asset_" + digest, "invalid"), undefined, 404],
    ["https://other.example.test" + asset, undefined, 403],
  ] as const) assert.equal((await h.raw(url, init)).status, expected);
  assert.equal((await h.raw(origin + "/__fixture/invalid-config", { method: "POST", body: "1" })).status, 204);
  assert.equal((await h.call()).status, 503, "cached assets cannot bypass deployment configuration validation");
  assert.equal((await h.raw(origin + "/__fixture/invalid-config", { method: "POST", body: "0" })).status, 204);
  assert.equal((await read(await h.call())).call, "1");
  assert.equal(await h.count(), 1);
});

test("manifest and authenticated requests do not populate or consume OTA asset cache", async t => {
  const h = await harness(t);
  await read(await h.call("/updates/application_one")); await read(await h.call("/updates/application_one"));
  assert.equal(await h.count(), 2);
  for (const headers of [{ Cookie: "session=private" }, { Authorization: "Bearer private" }]) {
    await read(await h.call(asset, { headers })); await read(await h.call(asset, { headers }));
  }
  assert.equal(await h.count(), 6);
  const firstPublic = await read(await h.call()); assert.equal(firstPublic.call, "7");
  await read(await h.call(asset, { headers: { Cookie: "session=private" } }));
  assert.equal((await read(await h.call())).call, "7"); assert.equal(await h.count(), 8);
});

test("range conditional and client cache-control preserve origin semantics without poisoning full asset", async t => {
  const h = await harness(t);
  for (const headers of [{ Range: "bytes=0-2" }, { "If-None-Match": '"fixture"' }, { "If-Modified-Since": "Wed, 21 Oct 2015 07:28:00 GMT" }, { "Cache-Control": "no-cache" }]) {
    const response = await read(await h.call(asset, { headers }));
    assert.equal(response.status, "Range" in headers ? 206 : "If-None-Match" in headers ? 304 : 200);
  }
  assert.equal(await h.count(), 4);
  const full = await read(await h.call()); assert.equal(full.call, "5");
  assert.equal((await read(await h.call(asset, { headers: { Range: "bytes=0-2" } }))).status, 206);
  assert.equal((await read(await h.call())).call, "5"); assert.equal(await h.count(), 6);
});

test("private mutable cookie varying and failed origin responses are never cached", async t => {
  const h = await harness(t);
  for (const mode of ["private", "no-store", "cookie", "vary", "mutable", "failure"]) {
    await h.mode(mode);
    const a = await read(await h.call()); const b = await read(await h.call()); assert.notEqual(a.call, b.call, mode);
  }
  assert.equal(await h.count(), 12);
  await h.mode("public"); const good = await read(await h.call()); assert.equal(good.status, 200);
  await h.mode("failure"); assert.deepEqual(await read(await h.call()), good);
  assert.equal(await h.count(), 13, "a verified immutable object remains available without a new origin operation");
});

test("cache open match and put outages always retain authoritative success and failure", async t => {
  const h = await harness(t);
  for (const fault of ["open", "match", "put"]) {
    await h.cacheFault(fault);
    await h.mode("public");
    const a = await read(await h.call()); const b = await read(await h.call());
    assert.equal(a.status, 200); assert.equal(b.status, 200); assert.notEqual(a.call, b.call);
    await h.mode("failure"); assert.equal((await read(await h.call())).status, 503);
  }
  assert.equal(await h.count(), 9);
  await h.cacheFault(""); await h.mode("public");
  const healthy = await read(await h.call()); assert.deepEqual(await read(await h.call()), healthy);
  assert.equal(await h.count(), 10);
});
