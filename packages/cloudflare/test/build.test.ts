import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = new URL("../../../", import.meta.url);
test("hosted_build_contains_only_private_slice_and_exact_assets", async () => {
  assert.ok(await access(new URL("scripts/build-cloudflare.mjs", root)).then(() => true, () => false), "Hosted build must exist");
  const result = spawnSync(process.execPath, ["scripts/build-cloudflare.mjs"], { cwd: root, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  assert.equal(result.status, 0, result.stderr);
  const meta = JSON.parse(await readFile(new URL("packages/cloudflare/dist/hosted/meta.json", root), "utf8"));
  for (const path of Object.keys(meta.inputs)) assert.doesNotMatch(path, /(?:auth-state.*test|fixtures|runner-protocol|\/dashboard\/dist\/(?:server|service|index|blocked-provider)|\/cli\/|\/db\/)/);
  const bundle = await readFile(new URL("packages/cloudflare/dist/hosted/worker.js", root), "utf8");
  assert.doesNotMatch(bundle, /node:(?:sqlite|http|https|fs|child_process)|__test\/|SYNTHETIC_|setInterval/);
  for (const name of ["index.html", "app.js", "auth.html", "auth.js", "auth.css"]) assert.equal(await readFile(new URL("packages/cloudflare/dist/hosted/public/" + name, root), "utf8"), await readFile(new URL("packages/cloudflare/public/" + name, root), "utf8"));
  assert.equal(await readFile(new URL("packages/cloudflare/dist/hosted/public/app.css", root), "utf8"), await readFile(new URL("packages/dashboard/public/app.css", root), "utf8"));
});

test("official_wrangler_validates_example_but_deployment_placeholders_block", async t => {
  assert.ok(await access(new URL("scripts/build-cloudflare.mjs", root)).then(() => true, () => false), "Hosted config guard must exist");
  const { validateDeploymentConfig, validateExampleConfig } = await import("../../../scripts/build-cloudflare.mjs");
  const file = new URL("packages/cloudflare/wrangler.example.jsonc", root);
  const config = await validateExampleConfig(file);
  assert.equal(config.compatibility_date, "2026-10-07");
  assert.deepEqual(config.compatibility_flags, ["nodejs_compat"]);
  assert.equal(config.assets.run_worker_first, true);
  assert.equal(config.workers_dev, false); assert.equal(config.preview_urls, false);
  assert.deepEqual(config.migrations, [{ tag: "v1", new_sqlite_classes: ["FloraAuth"] }]);
  assert.equal(config.limits?.cpu_ms, undefined, "Combined script must preserve the DO default CPU budget");
  await assert.rejects(validateDeploymentConfig(file), /DEPLOYMENT_CONFIGURATION_REQUIRED/);
  const temp = await mkdtemp(join(tmpdir(), "flora-build-config-")); t.after(() => rm(temp, { recursive: true, force: true }));
  const target = join(temp, "wrangler.jsonc");
  const value = JSON.parse(await readFile(file, "utf8"));
  value.vars = { FLORA_ORIGIN: "https://flora.example.test", FLORA_OWNER_ID: "synthetic-owner", FLORA_OWNER_EMAIL: "owner@example.test", FLORA_DB_IDENTITY: "synthetic-db" };
  value.d1_databases[0].database_id = "11111111-1111-4111-8111-111111111111";
  value.d1_databases[0].database_name = "synthetic-db";
  await writeFile(target, JSON.stringify(value)); await validateDeploymentConfig(target);
  delete value.d1_databases[0].database_id;
  await writeFile(target, JSON.stringify(value)); await assert.rejects(validateDeploymentConfig(target), /DEPLOYMENT_CONFIGURATION_REQUIRED/);
});
