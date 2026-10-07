import { createRequire } from "node:module";
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageRoot = join(root, "packages/cloudflare");
process.env.WRANGLER_LOG_PATH ??= join(packageRoot, "dist/hosted-build.log");
process.env.WRANGLER_SEND_METRICS = "false";
const require = createRequire(join(packageRoot, "package.json"));
const { build } = require("esbuild");

/** Official pinned Wrangler parser; this does not create or access an account. */
export async function validateExampleConfig(file = join(packageRoot, "wrangler.example.jsonc")) {
  const { unstable_readConfig } = require("wrangler");
  const config = unstable_readConfig({ config: file instanceof URL ? fileURLToPath(file) : resolve(file) });
  const fail = () => { throw new Error("INVALID_HOSTED_CONFIGURATION"); };
  if (config.compatibility_date !== "2026-10-07" || JSON.stringify(config.compatibility_flags) !== '["nodejs_compat"]'
    || config.workers_dev !== false || config.preview_urls !== false || config.limits?.cpu_ms !== undefined
    || config.assets?.binding !== "ASSETS" || config.assets?.run_worker_first !== true
    || config.assets?.html_handling !== "none" || config.assets?.not_found_handling !== "none") fail();
  if (JSON.stringify(config.migrations) !== '[{"tag":"v1","new_sqlite_classes":["FloraAuth"]}]') fail();
  if (config.durable_objects.bindings.length !== 1 || config.durable_objects.bindings[0].name !== "FLORA_AUTH"
    || config.durable_objects.bindings[0].class_name !== "FloraAuth" || config.durable_objects.bindings[0].script_name) fail();
  if (config.d1_databases.length !== 1 || config.d1_databases[0].binding !== "FLORA_DB") fail();
  return config;
}

/** A separate, owner-completed file and explicit existing D1 identity are mandatory. */
export async function validateDeploymentConfig(file) {
  let config;
  try { config = await validateExampleConfig(file); }
  catch { throw new Error("DEPLOYMENT_CONFIGURATION_REQUIRED"); }
  const vars = config.vars ?? {}, db = config.d1_databases[0];
  const values = [vars.FLORA_ORIGIN, vars.FLORA_OWNER_ID, vars.FLORA_OWNER_EMAIL, vars.FLORA_DB_IDENTITY, db.database_name, db.database_id];
  if (values.some(value => typeof value !== "string" || !value || /REPLACE_WITH/.test(value))
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(db.database_id)) throw new Error("DEPLOYMENT_CONFIGURATION_REQUIRED");
  const { readConfig } = await import(pathToFileURL(join(packageRoot, "dist/config.js")).href);
  try {
    readConfig({ ...vars, FLORA_AUTH: { idFromName() {}, get() {} }, FLORA_DB: { prepare() {}, batch() {}, exec() {} }, ASSETS: { fetch() {} } });
  } catch { throw new Error("DEPLOYMENT_CONFIGURATION_REQUIRED"); }
  return config;
}

export async function buildHosted() {
  await validateExampleConfig();
  const outdir = join(packageRoot, "dist/hosted"), publicDir = join(outdir, "public");
  await mkdir(publicDir, { recursive: true });
  const output = await build({ absWorkingDir: root, entryPoints: [join(packageRoot, "src/worker.ts")], outfile: join(outdir, "worker.js"), bundle: true, format: "esm", platform: "browser", target: "es2023", external: ["cloudflare:*", "node:crypto", "node:buffer"], metafile: true });
  for (const input of Object.keys(output.metafile.inputs)) {
    if (/(?:\/cli\/|\/db\/|runner-protocol|\/dashboard\/dist\/(?:server|service|index|blocked-provider)|\/test\/)/.test(input)) throw new Error("FORBIDDEN_HOSTED_BUNDLE_INPUT");
  }
  const code = await readFile(join(outdir, "worker.js"), "utf8");
  if (/node:(?:sqlite|http|https|fs|child_process)|setInterval|__test\//.test(code)) throw new Error("FORBIDDEN_HOSTED_BUNDLE_INPUT");
  await writeFile(join(outdir, "meta.json"), JSON.stringify(output.metafile, null, 2) + "\n");
  for (const file of ["index.html", "app.js", "auth.html", "auth.js", "auth.css"]) await copyFile(join(packageRoot, "public", file), join(publicDir, file));
  await copyFile(join(root, "packages/dashboard/public/app.css"), join(publicDir, "app.css"));
  console.log("Hosted bundle and six assets built; configuration validated locally. No deployment performed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length) {
      if (args.length !== 2 || args[0] !== "--deployment-config") throw new Error("INVALID_BUILD_ARGUMENTS");
      await validateDeploymentConfig(args[1]);
    }
    await buildHosted();
  } catch (error) { console.error(error instanceof Error ? error.message : "HOSTED_BUILD_FAILED"); process.exitCode = 1; }
}
