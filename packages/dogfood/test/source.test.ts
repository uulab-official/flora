import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "@app-ops/config";
import { CONFIG_RUNTIME_SMOKE_V1, deriveFreshness, parseSourceBundle } from "@app-ops/dogfood";
import {
  bundleBytes, DOGFOOD_FETCHED_AT, DOGFOOD_IMPORTED_AT, DOGFOOD_TEST_FILES,
  replaceSourceFile, sourceFile, syntheticRegistry, syntheticSourceBundle,
} from "../../../tests/dogfood-fixtures.ts";

// These tests fail if the parser exports executable/undeclared input, invents
// facts, or attaches provenance to anything other than the verified byte source.
test("imports only declared fields with byte provenance", async () => {
  const bundle = syntheticSourceBundle();
  const snapshot = await parseSourceBundle(bundleBytes(bundle), DOGFOOD_IMPORTED_AT);
  assert.equal(snapshot.evidenceOrigin, "operator-import");
  assert.equal(snapshot.connection, "one-shot-source-snapshot");
  assert.deepEqual(snapshot.repository, bundle.repository);
  assert.equal(snapshot.commitSha, bundle.commitSha);
  assert.equal(snapshot.rootDirectory, bundle.rootDirectory);
  assert.equal(snapshot.fetchedAt, DOGFOOD_FETCHED_AT);
  assert.equal(snapshot.importedAt, DOGFOOD_IMPORTED_AT);
  assert.equal(snapshot.selectedFlavor, bundle.selectedFlavor);
  assert.equal(snapshot.flavors.length, 11);
  const registryFile = bundle.files.find((file) => file.path === "flavors/config.json")!;
  for (const [id, value] of Object.entries(syntheticRegistry())) {
    const flavor = snapshot.flavors.find((item) => item.id === id)!;
    const pointer = "/" + id.replaceAll("~", "~0").replaceAll("/", "~1");
    const provenance = {
      repositoryId: bundle.repository.id, commitSha: bundle.commitSha,
      fetchedAt: bundle.fetchedAt, path: registryFile.path, gitBlobSha: registryFile.gitBlobSha,
    };
    assert.deepEqual(flavor.productType, { value: value.productType, provenance: { ...provenance, pointer: pointer + "/productType" } });
    assert.deepEqual(flavor.appName, { value: value.app.name, provenance: { ...provenance, pointer: pointer + "/app/name" } });
    assert.deepEqual(flavor.declaredPackage, { value: value.app.package, provenance: { ...provenance, pointer: pointer + "/app/package" } });
  }
  assert.equal(snapshot.runtime.appVersion?.value, "1.2.3");
  assert.equal(snapshot.runtime.appVersion?.provenance.pointer, "/version");
  assert.equal(snapshot.runtime.nodeEngine?.value, ">=24.19.0 <25");
  assert.equal(snapshot.runtime.nodeEngine?.provenance.pointer, "/engines/node");
  assert.equal(snapshot.runtime.lockfileVersion.value, 3);
  assert.equal(snapshot.runtime.lockfileVersion.provenance.pointer, "/lockfileVersion");
  assert.equal(snapshot.runtime.packageEntryCount.value, 5);
  assert.equal(snapshot.runtime.packageEntryCount.provenance.pointer, "/packages");
  for (const [name, version] of Object.entries({ vitest: "4.0.0", vite: "7.0.0", expo: "54.0.0", "react-native": "0.81.0" })) {
    const fact = snapshot.runtime.versions[name as keyof typeof snapshot.runtime.versions];
    assert.equal(fact?.value, version);
    assert.equal(fact?.provenance.pointer, `/packages/node_modules~1${name}/version`);
    assert.equal(fact?.provenance.path, "package-lock.json");
  }
  assert.equal(snapshot.runtime.runtimeVersion, "not-evaluated");
  assert.equal(snapshot.runtime.adsMode, "not-evaluated");
  assert.equal(snapshot.runtime.otaDestination, "not-evaluated");
  assert.equal(snapshot.runtime.installedBinaryIdentity, "not-inspected");
  assert.deepEqual(snapshot.files, bundle.files.map(({ contentBase64, ...file }) => ({
    ...file, byteLength: Buffer.from(contentBase64, "base64").length,
  })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const serialized = JSON.stringify(snapshot);
  for (const value of ["contentBase64", "do-not-export", "postinstall", "not-the-resolved-version", "fixture-only", "trusted", "systemVerified", "isolated"]) {
    assert.ok(!serialized.includes(value), value);
  }
});

// Reordering inputs/refetching must not alter identity; changed verified bytes,
// source revision, selection, repository, or root must alter the digest.
test("digests canonical verified source facts independently of fetch time", async () => {
  const bundle = syntheticSourceBundle();
  const first = await parseSourceBundle(bundleBytes(bundle), DOGFOOD_IMPORTED_AT);
  const second = await parseSourceBundle(bundleBytes({ ...bundle, fetchedAt: "2026-01-03T03:04:05.000Z", files: [...bundle.files].reverse() }), DOGFOOD_IMPORTED_AT + 86400000);
  assert.equal(first.digest, second.digest);
  assert.notEqual(first.id, second.id);
  assert.equal(typeof first.id, "string");
  assert.ok(first.id.length > 0);
  assert.equal(first.digest, createHash("sha256").update(canonicalJson({
    repository: bundle.repository, commitSha: bundle.commitSha, rootDirectory: bundle.rootDirectory,
    selectedFlavor: bundle.selectedFlavor, files: first.files,
  })).digest("hex"));
  for (const changed of [
    { ...bundle, commitSha: "b".repeat(40) },
    { ...bundle, repository: { ...bundle.repository, id: "repo_other" } },
    { ...bundle, rootDirectory: "apps/other" },
    { ...bundle, selectedFlavor: "sample-2" },
    replaceSourceFile(bundle, "src/core/config/runtime.ts", "// changed bytes\n"),
  ]) assert.notEqual((await parseSourceBundle(bundleBytes(changed), DOGFOOD_IMPORTED_AT)).digest, first.digest);
});

// Missing declarations are unknown, never inferred from package scripts or
// dependency ranges. Only the one explicitly optional path may be absent.
test("keeps missing optional facts unknown and hash-only sources unevaluated", async () => {
  let bundle = syntheticSourceBundle();
  bundle = replaceSourceFile(bundle, "package.json", '{}');
  bundle = replaceSourceFile(bundle, "package-lock.json", '{"lockfileVersion":3,"packages":{}}');
  bundle = replaceSourceFile(bundle, "config/experience-contract.json", "not parsed as JSON");
  bundle = { ...bundle, rootDirectory: ".", files: bundle.files.filter((file) => file.path !== "src/core/experience/types.ts") };
  const snapshot = await parseSourceBundle(bundleBytes(bundle), DOGFOOD_IMPORTED_AT);
  assert.equal(snapshot.files.length, 10);
  assert.equal(snapshot.runtime.appVersion, null);
  assert.equal(snapshot.runtime.nodeEngine, null);
  assert.equal(snapshot.runtime.packageEntryCount.value, 0);
  assert.deepEqual(snapshot.runtime.versions, { vitest: null, vite: null, expo: null, "react-native": null });
  for (const file of bundle.files) await assert.rejects(
    parseSourceBundle(bundleBytes({ ...bundle, files: bundle.files.filter((f) => f.path !== file.path) }), DOGFOOD_IMPORTED_AT),
    { code: "INVALID_INPUT" }, file.path,
  );
});

// Every mutation must reject instead of normalizing an ambiguous source or
// accepting operator-supplied trust. A late error must not execute early files.
test("rejects hostile bundles without side effects", async () => {
  const directory = mkdtempSync(join(tmpdir(), "synthetic-source-"));
  const marker = join(directory, "executed");
  const payload = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`;
  let bundle = replaceSourceFile(syntheticSourceBundle(), "vitest.config.mts", payload);
  bundle = replaceSourceFile(bundle, "src/core/config/runtime.ts", payload);
  bundle = replaceSourceFile(bundle, "package.json", JSON.stringify({ version: "1.0.0", scripts: { postinstall: `node -e ${JSON.stringify(payload)}` } }));
  try {
    await parseSourceBundle(bundleBytes(bundle), DOGFOOD_IMPORTED_AT);
    assert.equal(existsSync(marker), false);
    const first = bundle.files[0]!;
    const hostile: unknown[] = [
      { ...bundle, files: bundle.files.map((file) => file.path === "src/core/experience/types.ts" ? first : file) },
      ...["../package.json", "C:\\package.json", "\\\\host\\package.json", "/package.json", "./package.json", "flavors//config.json", "flavors/../package.json", "package.json\0", ".env", "app.config.js"].map((path) => ({ ...bundle, files: bundle.files.map((file) => file.path === "src/core/experience/types.ts" ? sourceFile(path, payload) : file) })),
      ...["", "..", "../app", "C:\\app", "/app", "./app", "app//src", "app/", "app/../src", "app\0"].map((rootDirectory) => ({ ...bundle, rootDirectory })),
      { ...bundle, selectedFlavor: "missing" },
      { ...bundle, selectedFlavor: "constructor" },
      { ...bundle, trusted: true },
      { ...bundle, systemVerified: true },
      { ...bundle, isolated: true },
      { ...bundle, schemaVersion: 2 },
      { ...bundle, repository: { ...bundle.repository, trusted: true } },
      { ...bundle, files: [{ ...first, trusted: true }, ...bundle.files.slice(1)] },
      { ...bundle, files: [{ ...first, sha256: "0".repeat(64) }, ...bundle.files.slice(1)] },
      { ...bundle, files: [{ ...first, gitBlobSha: "0".repeat(40) }, ...bundle.files.slice(1)] },
      ...["@@@=", "YQ", "YQ===", "YQ==\n", "YR==", "YWJ=", "-w=="].map((contentBase64) => ({ ...bundle, files: [{ ...first, contentBase64 }, ...bundle.files.slice(1)] })),
      replaceSourceFile(bundle, "package.json", new Uint8Array([0xc0, 0xaf])),
      replaceSourceFile(bundle, "src/core/config/runtime.ts", new Uint8Array([0xff])),
      replaceSourceFile(bundle, "package.json", '{"__proto__":{"polluted":true}}'),
      replaceSourceFile(bundle, "flavors/config.json", '{"constructor":{}}'),
      replaceSourceFile(bundle, "package-lock.json", '{"lockfileVersion":3,"packages":{"prototype":{}}}'),
      JSON.parse(JSON.stringify(bundle).replace('"schemaVersion":1', '"schemaVersion":1,"__proto__":{}')),
    ];
    for (const [index, value] of hostile.entries()) {
      await assert.rejects(parseSourceBundle(bundleBytes(value), DOGFOOD_IMPORTED_AT), { code: "INVALID_INPUT" }, `mutation ${index}`);
      assert.equal(existsSync(marker), false, `mutation ${index}`);
    }
    assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// Invalid JSON structure/declared field types cannot be promoted to facts.
test("rejects malformed envelopes and declared fact schemas", async () => {
  const bundle = syntheticSourceBundle();
  const invalid: unknown[] = [
    null, [], 1, {}, { ...bundle, files: [] }, { ...bundle, files: {} },
    { ...bundle, repository: null }, { ...bundle, repository: { ...bundle.repository, visibility: "unknown" } },
    { ...bundle, commitSha: "not-a-commit" }, { ...bundle, fetchedAt: "not-a-date" },
    { ...bundle, fetchedAt: "2026-02-30T00:00:00.000Z" },
    ...["null", "[]", "{", '{"version":1}', '{"engines":{"node":false}}'].map((content) => replaceSourceFile(bundle, "package.json", content)),
    ...['{}', '{"lockfileVersion":"3","packages":{}}', '{"lockfileVersion":3,"packages":[]}', '{"lockfileVersion":3,"packages":{"node_modules/vitest":{"version":4}}}'].map((content) => replaceSourceFile(bundle, "package-lock.json", content)),
    ...["{}", "[]", JSON.stringify({ "sample/~one": { productType: "demo", app: { name: "Demo" } } })].map((content) => replaceSourceFile(bundle, "flavors/config.json", content)),
  ];
  for (const [index, value] of invalid.entries()) await assert.rejects(parseSourceBundle(bundleBytes(value), DOGFOOD_IMPORTED_AT), { code: "INVALID_INPUT" }, `schema ${index}`);
  for (const bytes of [new Uint8Array([0xff]), new TextEncoder().encode("{"), new Uint8Array()]) await assert.rejects(parseSourceBundle(bytes, DOGFOOD_IMPORTED_AT), { code: "INVALID_INPUT" });
  for (const at of [NaN, Infinity, -1, 0.5]) await assert.rejects(parseSourceBundle(bundleBytes(bundle), at), { code: "INVALID_INPUT" });
});

// Limits apply to the original envelope and decoded bytes before parsing facts.
test("bounds bundle bytes, decoded bytes and flavor count", async () => {
  const bundle = syntheticSourceBundle();
  await assert.rejects(parseSourceBundle(new Uint8Array(2 * 1024 * 1024 + 1).fill(32), DOGFOOD_IMPORTED_AT), { code: "INVALID_INPUT" });
  await assert.rejects(parseSourceBundle(bundleBytes(replaceSourceFile(bundle, "src/core/config/runtime.ts", "x".repeat(1024 * 1024 + 1))), DOGFOOD_IMPORTED_AT), { code: "INVALID_INPUT" });
  let tooManyBytes = replaceSourceFile(bundle, "src/core/config/runtime.ts", "x".repeat(800 * 1024));
  tooManyBytes = replaceSourceFile(tooManyBytes, "src/core/experience/runtime.ts", "x".repeat(800 * 1024));
  await assert.rejects(parseSourceBundle(bundleBytes(tooManyBytes), DOGFOOD_IMPORTED_AT), { code: "INVALID_INPUT" });
  await assert.rejects(parseSourceBundle(bundleBytes(replaceSourceFile(bundle, "flavors/config.json", JSON.stringify(syntheticRegistry(101)))), DOGFOOD_IMPORTED_AT), { code: "INVALID_INPUT" });
  assert.equal((await parseSourceBundle(bundleBytes(replaceSourceFile(bundle, "flavors/config.json", JSON.stringify(syntheticRegistry(100)))), DOGFOOD_IMPORTED_AT)).flavors.length, 100);
  assert.equal((await parseSourceBundle(bundleBytes(replaceSourceFile(bundle, "src/core/config/runtime.ts", "x".repeat(1024 * 1024))), DOGFOOD_IMPORTED_AT)).files.find((file) => file.path === "src/core/config/runtime.ts")?.byteLength, 1024 * 1024);
});

// This exact argv is an allowlist, not a configurable npm script or shell line.
test("defines the exact bounded config runtime smoke profile", () => {
  assert.deepEqual(CONFIG_RUNTIME_SMOKE_V1.argv, [
    "node", "./node_modules/vitest/vitest.mjs", "run",
    "tests/config/runtime.test.ts", "tests/config/experience-runtime.test.ts",
    "--maxWorkers=1", "--reporter=json", "--outputFile=/results/vitest.json",
  ]);
  assert.deepEqual(CONFIG_RUNTIME_SMOKE_V1.files, DOGFOOD_TEST_FILES);
  assert.equal(CONFIG_RUNTIME_SMOKE_V1.id, "config-runtime-smoke-v1");
  assert.equal(CONFIG_RUNTIME_SMOKE_V1.expectedTests, 4);
  assert.equal(CONFIG_RUNTIME_SMOKE_V1.expectedTestsPerFile, 2);
  assert.ok(CONFIG_RUNTIME_SMOKE_V1.coverage.length > 0);
  assert.ok(Object.isFrozen(CONFIG_RUNTIME_SMOKE_V1));
  assert.ok(Object.isFrozen(CONFIG_RUNTIME_SMOKE_V1.argv));
  assert.ok(Object.isFrozen(CONFIG_RUNTIME_SMOKE_V1.files));
});


// A local import timestamp or elapsed wall time cannot make a remote claim.
// Removing any repository/root/time/origin fence changes these results.
test("keeps freshness, provenance and capabilities distinct", async () => {
  const snapshot = await parseSourceBundle(bundleBytes(syntheticSourceBundle()), DOGFOOD_IMPORTED_AT);
  const observation = {
    repositoryId: snapshot.repository.id, rootDirectory: snapshot.rootDirectory,
    headCommitSha: snapshot.commitSha, observedAt: "2026-01-03T03:04:05.000Z",
    evidenceOrigin: "operator-import" as const,
  };
  const original = structuredClone(observation);
  assert.equal(deriveFreshness(snapshot, null), "freshness_unknown");
  assert.equal(deriveFreshness({ ...snapshot, importedAt: DOGFOOD_IMPORTED_AT + 365 * 86400000 }, null), "freshness_unknown");
  assert.equal(deriveFreshness(snapshot, observation), "observed_current");
  assert.equal(deriveFreshness(snapshot, { ...observation, observedAt: snapshot.fetchedAt }), "observed_current");
  assert.equal(deriveFreshness(snapshot, { ...observation, headCommitSha: "b".repeat(40) }), "stale");
  assert.equal(deriveFreshness(snapshot, { ...observation, headCommitSha: "b".repeat(40), observedAt: snapshot.fetchedAt }), "freshness_unknown");
  for (const changed of [
    { repositoryId: "repo_other" }, { rootDirectory: "apps/other" },
    { observedAt: "2026-01-01T03:04:05.000Z" }, { observedAt: "invalid" },
    { observedAt: "2026-02-30T00:00:00.000Z" }, { headCommitSha: "invalid" },
  ]) assert.equal(deriveFreshness(snapshot, { ...observation, ...changed }), "freshness_unknown");
  assert.equal(deriveFreshness(snapshot, JSON.parse(JSON.stringify({ ...observation, evidenceOrigin: "system-verified" }))), "freshness_unknown");
  assert.equal(deriveFreshness(snapshot, JSON.parse(JSON.stringify({ ...observation, trusted: true }))), "freshness_unknown");
  let invoked = false;
  const getter = Object.defineProperty({ ...observation }, "headCommitSha", { get() { invoked = true; return snapshot.commitSha; } });
  assert.equal(deriveFreshness(snapshot, getter), "freshness_unknown");
  assert.equal(invoked, false);
  assert.deepEqual(observation, original);
  assert.equal(snapshot.evidenceOrigin, "operator-import");
  assert.equal(snapshot.connection, "one-shot-source-snapshot");
});

// Date.parse alone would erase the nanosecond ordering of these valid inputs.
test("keeps an older same-SHA submillisecond observation unknown", async () => {
  const fetchedAt = "2026-01-02T03:04:05.000000002Z";
  const snapshot = await parseSourceBundle(bundleBytes({ ...syntheticSourceBundle(), fetchedAt }), DOGFOOD_IMPORTED_AT);
  const observation = {
    repositoryId: snapshot.repository.id, rootDirectory: snapshot.rootDirectory,
    headCommitSha: snapshot.commitSha, observedAt: "2026-01-02T03:04:05.000000001Z",
    evidenceOrigin: "operator-import" as const,
  };
  assert.equal(deriveFreshness(snapshot, observation), "freshness_unknown");
  assert.equal(snapshot.fetchedAt, fetchedAt);
  assert.equal(snapshot.runtime.appVersion?.provenance.fetchedAt, fetchedAt);
  assert.equal(observation.observedAt, "2026-01-02T03:04:05.000000001Z");
});

test("marks a later different-SHA submillisecond observation stale", async () => {
  const snapshot = await parseSourceBundle(bundleBytes({
    ...syntheticSourceBundle(), fetchedAt: "2026-01-02T03:04:05.000000001Z",
  }), DOGFOOD_IMPORTED_AT);
  for (const observedAt of [
    "2026-01-02T03:04:05.000000002Z",
    "2026-01-02T08:34:05.000000002+05:30",
    "2026-01-01T22:04:05.000000002-05:00",
  ]) assert.equal(deriveFreshness(snapshot, {
    repositoryId: snapshot.repository.id, rootDirectory: snapshot.rootDirectory,
    headCommitSha: "b".repeat(40), observedAt, evidenceOrigin: "operator-import",
  }), "stale", observedAt);
});

// Timezone spelling and trailing fractional zeroes do not change the instant;
// equality cannot establish which of two conflicting hashes is newer.
test("compares equivalent offsets and fractional widths without rewriting provenance", async () => {
  for (const [fetchedAt, observedAt] of [
    ["2026-01-02T03:04:05.1Z", "2026-01-02T08:34:05.100000000+05:30"],
    ["2026-01-01T22:04:05.123456789-05:00", "2026-01-02T03:04:05.123456789Z"],
    ["2026-01-02T03:04:05Z", "2026-01-02T03:04:05.000000000+00:00"],
  ] as const) {
    const snapshot = await parseSourceBundle(bundleBytes({ ...syntheticSourceBundle(), fetchedAt }), DOGFOOD_IMPORTED_AT);
    const observation = {
      repositoryId: snapshot.repository.id, rootDirectory: snapshot.rootDirectory,
      headCommitSha: snapshot.commitSha, observedAt, evidenceOrigin: "operator-import" as const,
    };
    assert.equal(deriveFreshness(snapshot, observation), "observed_current");
    assert.equal(deriveFreshness(snapshot, { ...observation, headCommitSha: "b".repeat(40) }), "freshness_unknown");
    assert.equal(snapshot.fetchedAt, fetchedAt);
    assert.equal(snapshot.runtime.appVersion?.provenance.fetchedAt, fetchedAt);
    assert.equal(observation.observedAt, observedAt);
  }
});
