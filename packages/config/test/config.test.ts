import test from "node:test";
import assert from "node:assert/strict";
import * as config from "@app-ops/config";
import { target, source } from "../../../tests/fixtures.ts";
const entry = (level: string, value: string, extra = {}) => ({
  key: "API_URL",
  versionId: "version_one",
  scope: { level, organizationId: "org_demo", ...extra },
  binding: { kind: "CONFIG", value },
});
const entries = [
  entry("organization", "base"),
  entry("environment", "prod", {
    applicationId: "app_demo",
    environmentId: "production",
  }),
  entry("target", "exact", {
    applicationId: "app_demo",
    flavorId: "free",
    environmentId: "production",
    platform: "ios",
  }),
];
test("exact target overrides do not leak across axes", async () => {
  const s = await config.resolveSnapshot({ target, source, entries });
  assert.equal(s.entries[0]?.binding.kind, "CONFIG");
  assert.deepEqual(s.entries[0]?.binding, { kind: "CONFIG", value: "exact" });
  for (const change of [
    { flavorId: "pro" },
    { environmentId: "staging" },
    { platform: "android" as const },
  ]) {
    const v = await config.resolveSnapshot({
      target: { ...target, ...change },
      source,
      entries,
    });
    assert.notDeepEqual(v.entries[0]?.binding, {
      kind: "CONFIG",
      value: "exact",
    });
  }
});
test("stable immutable snapshots preserve versions and input order", async () => {
  const s = await config.resolveSnapshot({ target, source, entries });
  const t = await config.resolveSnapshot({
    target,
    source,
    entries: [...entries].reverse(),
  });
  assert.equal(s.digest, t.digest);
  assert.equal(s.id, "cfg_" + s.digest);
  assert.ok(Object.isFrozen(s.source.toolchain));
  assert.throws(() => {
    (s.source.toolchain as Record<string, string>).node = "bad";
  });
  const v = await config.resolveSnapshot({
    target,
    source: { ...source, commitSha: "c".repeat(40) },
    entries,
  });
  assert.notEqual(s.digest, v.digest);
});
test("rejects ambiguous scope, duplicate and kind changes", async () => {
  await assert.rejects(
    () =>
      config.resolveSnapshot({
        target,
        source,
        entries: [entries[0], entries[0]],
      }),
    { code: "CONFIG_CONFLICT" },
  );
  assert.throws(
    () =>
      config.parseConfigEntries([
        entry("target", "x", {
          applicationId: "app_demo",
          flavorId: "free",
          environmentId: "production",
        }),
      ]),
    { code: "INVALID_INPUT" },
  );
  await assert.rejects(
    () =>
      config.resolveSnapshot({
        target,
        source,
        entries: [
          entry("organization", "x"),
          {
            ...entry("environment", "x", {
              applicationId: "app_demo",
              environmentId: "production",
            }),
            binding: {
              kind: "SECRET",
              organizationId: "org_demo",
              resourceId: "secret_demo",
              versionId: "version_one",
            },
          },
        ],
      }),
    { code: "CONFIG_CONFLICT" },
  );
});
test("secret references never accept plaintext or another tenant", async () => {
  const e = {
    key: "API_TOKEN",
    versionId: "version_one",
    scope: { level: "organization", organizationId: "org_demo" },
    binding: {
      kind: "SECRET",
      organizationId: "org_demo",
      resourceId: "secret_demo",
      versionId: "version_one",
    },
  };
  const s = await config.resolveSnapshot({ target, source, entries: [e] });
  assert.equal(s.entries[0]?.binding.kind, "SECRET");
  assert.throws(
    () =>
      config.parseConfigEntries([
        { ...e, binding: { ...e.binding, value: "private-value" } },
      ]),
    { code: "INVALID_INPUT" },
  );
  await assert.rejects(
    () =>
      config.resolveSnapshot({
        target,
        source,
        entries: [
          { ...e, binding: { ...e.binding, organizationId: "org_other" } },
        ],
      }),
    { code: "TENANT_MISMATCH" },
  );
});
test("canonical JSON rejects dangerous structures and allows plain JSON", () => {
  assert.equal(
    config.canonicalJson({ b: 2, a: [true, null] }),
    '{"a":[true,null],"b":2}',
  );
  assert.equal(
    config.canonicalJson(Object.assign(Object.create(null), { x: 1 })),
    '{"x":1}',
  );
  for (const v of [
    undefined,
    NaN,
    new Date(),
    JSON.parse('{"constructor":{}}'),
    Array(2),
  ])
    assert.throws(() => config.canonicalJson(v), { code: "INVALID_INPUT" });
  const a = [1];
  Object.defineProperty(a, "0", {
    get() {
      throw Error("getter ran");
    },
  });
  assert.throws(() => config.canonicalJson(a), { code: "INVALID_INPUT" });
  let deep: unknown = null;
  for (let i = 0; i < 66; i++) deep = { x: deep };
  assert.throws(() => config.canonicalJson(deep), { code: "INVALID_INPUT" });
});
test("snapshot validates its original request envelope before reading fields", async () => {
  let invoked = 0;
  const base = { target, source, entries: [] };
  for (const value of [
    { ...base, unknown: "value" },
    Object.defineProperty({ ...base }, "secret", {
      value: "hidden",
      enumerable: false,
    }),
    Object.defineProperty({ ...base }, "target", {
      get() {
        invoked++;
        return target;
      },
      enumerable: true,
    }),
  ])
    await assert.rejects(() => config.resolveSnapshot(value), {
      code: "INVALID_INPUT",
    });
  assert.equal(invoked, 0);
});
