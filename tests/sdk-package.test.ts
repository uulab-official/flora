import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, cp, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = fileURLToPath(new URL("../scripts/pack-ota-sdk.mjs", import.meta.url));
const { resolveNpmCLI } = await import(new URL("../scripts/pack-ota-sdk.mjs", import.meta.url).href) as { resolveNpmCLI(): Promise<string> };
test("the standalone SDK tarball installs offline into two independent app projects", async t => {
  const directory = await mkdtemp(join(tmpdir(), "flora-sdk-consumer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const unrelated = join(root, "packages/ota-sdk/dist", `pack-test-${process.pid}.env`);
  await writeFile(unrelated, "SYNTHETIC_PRIVATE_MARKER=not-an-sdk-file\n", { flag: "wx" });
  t.after(() => rm(unrelated, { force: true }));
  const output = join(directory, "packages");
  const packed = spawnSync(process.execPath, [script, "--out", output], { cwd: root, encoding: "utf8", timeout: 30000 });
  assert.equal(packed.status, 0, packed.stderr);
  const artifact = JSON.parse(packed.stdout) as { path: string; sha256: string; files: string[] };
  assert.equal(createHash("sha256").update(await readFile(artifact.path)).digest("hex"), artifact.sha256);
  assert.ok(artifact.files.includes("LICENSE"));
  assert.ok(artifact.files.includes("dist/index.js"));
  assert.ok(artifact.files.includes("dist/expo-updates.js"));
  assert.ok(artifact.files.every(path => !/node_modules|\.env|test\/|\.db|\.tsbuildinfo/.test(path)));
  const repeated = spawnSync(process.execPath, [script, "--out", output], { cwd: root, encoding: "utf8", timeout: 30000 });
  assert.equal(repeated.status, 1, "A candidate already used by app lockfiles must not be overwritten");
  assert.match(repeated.stderr, /SDK_PACKAGE_EXISTS/);
  assert.equal(createHash("sha256").update(await readFile(artifact.path)).digest("hex"), artifact.sha256);
  for (const appId of ["app_first", "app_second"]) {
    const consumer = join(directory, appId); await mkdir(consumer);
    await writeFile(join(consumer, "package.json"), JSON.stringify({ name: appId, version: "1.0.0", type: "module", private: true }));
    const installed = spawnSync(process.execPath, [await resolveNpmCLI(), "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--registry=http://127.0.0.1:9", "--cache", join(consumer, ".cache"), artifact.path], { cwd: consumer, encoding: "utf8", timeout: 30000 });
    assert.equal(installed.status, 0, installed.stderr);
    await writeFile(join(consumer, "verify.mjs"), `
      import assert from 'node:assert/strict';
      import {createFloraClient} from '@flora/ota';
      import {createExpoUpdatesAdapter} from '@flora/ota/expo-updates';
      import {createRequire} from 'node:module';
      const require=createRequire(import.meta.url);
      assert.throws(()=>require.resolve('expo'));
      assert.throws(()=>require.resolve('react-native'));
      assert.equal(typeof createExpoUpdatesAdapter,'function');
      const appId=${JSON.stringify(appId)},config={appId,url:'https://flora.example/updates/'+appId,channel:'preview',runtimeVersion:'native-1',platform:'android'};
      const engine={name:'installed-test-engine',protocol:'expo-updates-v1',trust:'native-engine',getNativeConfiguration:async()=>({...config,enabled:true}),check:async()=>({available:false}),download:async()=>({downloaded:false}),reload:async()=>{throw new Error('Unexpected reload');}};
      const client=createFloraClient(config,engine);
      assert.deepEqual(await client.checkForUpdate(),{available:false});
      assert.equal(client.configuration.appId,appId);
    `);
    const verified = spawnSync(process.execPath, ["verify.mjs"], { cwd: consumer, encoding: "utf8", timeout: 10000 });
    assert.equal(verified.status, 0, verified.stderr);
  }
});

test("SDK packaging refuses a removed adapter even when an older dist file remains", async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "flora-sdk-stale-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const relative of ["scripts/pack-ota-sdk.mjs", "package.json", "tsconfig.base.json", "LICENSE", "packages/ota-sdk"]) {
    await mkdir(join(directory, relative, ".."), { recursive: true });
    await cp(join(root, relative), join(directory, relative), { recursive: true, filter: source => !source.endsWith("node_modules") });
  }
  await symlink(join(root, "node_modules"), join(directory, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  await rm(join(directory, "packages/ota-sdk/src/expo-updates.ts"));
  const packed = spawnSync(process.execPath, [join(directory, "scripts/pack-ota-sdk.mjs"), "--out", join(directory, "artifacts")], { cwd: directory, encoding: "utf8", timeout: 30000 });
  assert.notEqual(packed.status, 0, "Fresh source must supply every advertised SDK export");
  assert.match(packed.stderr, /SDK_PACKAGE_FAILED/);
});
