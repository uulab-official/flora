import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import {
  listIntegrationProviders, parseProviderManifest, requireIntegrationAdapter,
} from "@app-ops/core";

const external = {
  id: "example-build", name: "Example provider", version: "1.0.0",
  execution: "external-api", maturity: "planned",
  capabilities: ["build"], platforms: ["android"], authentication: "user-api-key",
  setupDocument: "docs/development/example-provider.md",
};

test("built-in integrations report real maturity and do not imply connection", () => {
  const providers = listIntegrationProviders();
  const byId = (id: string) => providers.find(item => item.id === id)!;
  assert.equal(byId("flora-pc-ota").maturity, "existing-runtime");
  assert.equal(byId("flora-pc-native").maturity, "manual-setup");
  assert.equal(byId("github-actions-native").maturity, "workflow-template");
  assert.equal(byId("expo-eas").maturity, "planned");
  assert.equal(byId("codemagic").maturity, "manual-setup");
  assert.equal(byId("bitrise").maturity, "manual-setup");
  assert.ok(providers.every(item => item.capabilities.length && item.setupDocument.startsWith("docs/")));
  providers[0]!.capabilities = ["store.submit"];
  assert.deepEqual(listIntegrationProviders()[0]!.capabilities, ["ota.publish"]);
});

test("external manifests are inert metadata: reject built-in IDs, extra keys, credentials and runtime claims", () => {
  assert.equal(parseProviderManifest(external).maturity, "planned");
  const records: unknown[] = [
    { ...external, id: "flora-pc-ota" },
    { ...external, token: "shhh" },
    { ...external, maturity: "existing-runtime" },
    { ...external, capabilities: ["build", "build"] },
    { ...external, platforms: ["ios", "ios"] },
    { ...external, setupDocument: "../private.md" },
    { ...external, name: "bad", authentication: "unrestricted" },
  ];
  for (const invalid of records.slice(1)) {
    assert.throws(() => parseProviderManifest(invalid));
  }
  assert.throws(() => listIntegrationProviders([records[0]]), { code: "CONFLICT" });
  assert.throws(() => listIntegrationProviders([external, external]), { code: "CONFLICT" });
  assert.equal(listIntegrationProviders([external]).at(-1)!.id, "example-build");
});

test("plugin metadata cannot authorize remote execution without installed adapter and supported capability", () => {
  const providers = listIntegrationProviders([external]);
  const installed = new Set(["flora-pc-ota", "github-actions-native", "example-build"]);
  assert.equal(requireIntegrationAdapter(providers, "flora-pc-ota", "ota.publish", "ios", installed).id, "flora-pc-ota");
  assert.throws(
    () => requireIntegrationAdapter(providers, "flora-pc-native", "build", "ios", installed),
    { code: "PROVIDER_UNCONFIGURED" }
  );
  assert.throws(
    () => requireIntegrationAdapter(providers, "github-actions-native", "ota.publish", "ios", installed),
    { code: "PROVIDER_UNSUPPORTED" }
  );
  assert.throws(
    () => requireIntegrationAdapter(providers, "example-build", "build", "android", installed),
    { code: "PROVIDER_UNSUPPORTED" }
  );
  assert.throws(
    () => requireIntegrationAdapter(providers, "github-actions-native", "build", "web", installed),
    { code: "PROVIDER_UNSUPPORTED" }
  );
});

test("CLI reports provider maturity but does not assert that accounts or runners are connected", () => {
  const run = spawnSync(process.execPath, [resolve("packages/cli/dist/main.js"), "providers", "list", "--json"], { encoding: "utf8", timeout: 12000 });
  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout);
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.connected, false);
  assert.ok(output.providers.some((item: { id: string; maturity: string }) => item.id === "flora-pc-ota" && item.maturity === "existing-runtime"));
  assert.equal(spawnSync(process.execPath, [resolve("packages/cli/dist/main.js"), "providers", "delete"], { encoding: "utf8", timeout: 12000 }).status, 2);
});
