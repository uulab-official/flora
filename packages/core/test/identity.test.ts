import test from "node:test";
import assert from "node:assert/strict";
import * as core from "@app-ops/core";
import { catalog, target, source } from "../../../tests/fixtures.ts";
test("validates distinct flavor/environment targets", () => {
  const c = core.parseCatalog(catalog);
  assert.equal(core.parseTarget(target, c).flavorId, "free");
  assert.equal(
    core.parseTarget({ ...target, flavorId: "pro" }, c).flavorId,
    "pro",
  );
});
test("rejects cross-tenant and cross-app relationships", () => {
  const c = core.parseCatalog(catalog);
  assert.throws(
    () => core.parseTarget({ ...target, organizationId: "org_other" }, c),
    { code: "TENANT_MISMATCH" },
  );
  assert.throws(() => core.parseTarget({ ...target, flavorId: "other" }, c), {
    code: "INVALID_RELATION",
  });
});
test("source rejects traversal, absolute paths and unexpected fields", () => {
  assert.equal(
    core.parseSourceRevision(source, target).repositoryId,
    "repo_demo",
  );
  for (const rootDirectory of [
    "../app",
    "/tmp/app",
    "C:\\app",
    "a//b",
    "a/./b",
    "",
  ])
    assert.throws(() =>
      core.parseSourceRevision({ ...source, rootDirectory }, target),
    );
  assert.throws(() =>
    core.parseSourceRevision({ ...source, token: "not-allowed" }, target),
  );
});
test("rejects duplicate IDs and dangerous nested keys", () => {
  assert.throws(() =>
    core.parseCatalog({
      ...catalog,
      organizations: [{ id: "org_demo" }, { id: "org_demo" }],
    }),
  );
  assert.throws(() =>
    core.parseSourceRevision(
      { ...source, toolchain: JSON.parse('{"constructor":"x"}') },
      target,
    ),
  );
});
test("unconfigured and unsupported providers fail closed", () => {
  assert.throws(() => core.requireCapability(null, "store.upload"), {
    code: "PROVIDER_UNCONFIGURED",
  });
  assert.throws(
    () =>
      core.requireCapability(
        { id: "local", version: "1", capabilities: ["build"] },
        "ota.publish",
      ),
    { code: "PROVIDER_UNSUPPORTED" },
  );
  core.requireCapability(
    { id: "local", version: "1", capabilities: ["build"] },
    "build",
  );
});
