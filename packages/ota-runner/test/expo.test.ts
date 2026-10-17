import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import type { AutomationConfigSnapshot } from "@app-ops/dogfood";
import { readExport } from "../dist/index.js";

const certificate = await readFile(new URL("../../ota-sdk/test/fixtures/plugin-public-cert.pem", import.meta.url), "utf8");
const otherCertificate = await readFile(new URL("./fixtures/other-public-cert.pem", import.meta.url), "utf8");
const config: AutomationConfigSnapshot = { schemaVersion: 1, bundler: "expo", entryFile: "index.js", toolchain: { nodeVersion: "24.19.0", packageManager: { name: "npm", version: "10.9.8" } }, runtimeVersion: "native-1", platforms: ["ios", "android"], updatesUrl: "https://flora.example.test/updates/app_isso" };
const job = { appId: "app_isso", channel: "flora-verification", platform: "ios" as const, config };
const connection = { appId: job.appId, url: config.updatesUrl, channel: job.channel, runtimeVersion: config.runtimeVersion, certificate, keyId: "server-1" };
const resolved = () => ({ name: "Isso", slug: "isso", platforms: ["ios", "android", "web"], runtimeVersion: "native-1", updates: { enabled: false }, plugins: [["@flora/ota/plugin", { ...connection, disableExpoUpdates: true }]] });
async function api() { return import("../dist/expo.js"); }

test("Flora Expo export accepts its job-bound public native configuration with expo-updates disabled", async () => {
  const { verifyExpoConfiguration } = await api();
  assert.equal(verifyExpoConfiguration(job, resolved(), connection), "flora");
  assert.equal(verifyExpoConfiguration({ ...job, platform: "android" }, resolved(), connection), "flora");
});

test("Flora Expo export rejects foreign apps, URLs, runtime, channel, platform and trust material", async () => {
  const { verifyExpoConfiguration } = await api();
  for (const [field, value] of [
    ["appId", "app_promise"], ["url", "https://flora.example.test/updates/app_promise"],
    ["channel", "production"], ["runtimeVersion", "native-other"], ["keyId", "server-2"],
    ["certificate", otherCertificate],
    ["certificate", await readFile(new URL("../../ota-sdk/test/fixtures/plugin-weak-public-cert.pem", import.meta.url), "utf8")],
    ["disableExpoUpdates", false], ["privateKey", "not-public-configuration"],
  ] as const) {
    const valueConfig = resolved(); Object.assign(valueConfig.plugins[0]![1]!, { [field]: value });
    assert.throws(() => verifyExpoConfiguration(job, valueConfig, connection), /CONFIG_CHANGED/, field);
  }
  for (const changed of [
    { ...job, appId: "app_promise" }, { ...job, channel: "production" },
    { ...job, config: { ...config, updatesUrl: "https://other.example.test/updates/app_isso" } },
    { ...job, config: { ...config, runtimeVersion: "native-other" } },
    { ...job, config: { ...config, platforms: ["android"] as AutomationConfigSnapshot["platforms"] } },
  ]) assert.throws(() => verifyExpoConfiguration(changed, resolved(), connection), /CONFIG_CHANGED/);
  assert.throws(() => verifyExpoConfiguration(job, { ...resolved(), platforms: ["android"] }, connection), /CONFIG_CHANGED/);
  assert.throws(() => verifyExpoConfiguration(job, { ...resolved(), platforms: undefined }, connection), /CONFIG_CHANGED/);
  assert.throws(() => verifyExpoConfiguration(job, { ...resolved(), ios: { runtimeVersion: "native-other" } }, connection), /CONFIG_CHANGED/);
});

test("connection snapshot is bounded and cannot be replaced by dependency-install writes", async t => {
  const { readExpoConnection, verifyExpoConfiguration } = await api();
  const root = await mkdtemp(join(tmpdir(), "flora-expo-binding-")); t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await readExpoConnection(root), undefined);
  const path = join(root, "flora.connection.json");
  await writeFile(path, JSON.stringify(connection));
  const snapshot = await readExpoConnection(root);
  await writeFile(path, JSON.stringify({ ...connection, certificate: otherCertificate }));
  const afterInstall = resolved(); Object.assign(afterInstall.plugins[0]![1]!, { certificate: otherCertificate });
  assert.throws(() => verifyExpoConfiguration(job, afterInstall, snapshot), /CONFIG_CHANGED/);
  await writeFile(path, " ".repeat(32769));
  await assert.rejects(readExpoConnection(root), /CONFIG_CHANGED/);
  await rm(path); await symlink("/etc/passwd", path);
  await assert.rejects(readExpoConnection(root), /CONFIG_CHANGED/);
});

test("Flora cannot fall back to an EAS configuration or a missing or duplicated native plugin", async () => {
  const { verifyExpoConfiguration } = await api();
  const base = resolved();
  for (const changed of [
    { ...base, updates: { enabled: true, url: config.updatesUrl } },
    { ...base, updates: { enabled: false, url: "https://u.expo.dev/another-project" } },
    { ...base, plugins: [] }, { ...base, plugins: [base.plugins[0], base.plugins[0]] },
    { ...base, plugins: ["@flora/ota/plugin"] }, { ...base, updates: {} },
  ]) assert.throws(() => verifyExpoConfiguration(job, changed, connection), /CONFIG_CHANGED/);
  assert.throws(() => verifyExpoConfiguration(job, base), /CONFIG_CHANGED/, "a plugin cannot supply the committed trust anchor itself");
});

test("legacy optional expo-updates export still requires the exact queued URL and runtime", async () => {
  const { verifyExpoConfiguration } = await api();
  const legacy = { runtimeVersion: "native-1", updates: { enabled: true, url: config.updatesUrl } };
  assert.equal(verifyExpoConfiguration(job, legacy), "expo-updates");
  for (const changed of [
    { ...legacy, updates: { enabled: false, url: config.updatesUrl } },
    { ...legacy, updates: { enabled: true, url: "https://u.expo.dev/another-project" } },
    { ...legacy, runtimeVersion: "native-other" },
  ]) assert.throws(() => verifyExpoConfiguration(job, changed), /CONFIG_CHANGED/);
});

test("committed native binding cannot contain credentials, weak certificates or another app destination", async () => {
  const { verifyExpoConfiguration } = await api();
  for (const changed of [
    { ...connection, token: "not-source-material" }, { ...connection, keyId: "server\nkey" },
    { ...connection, url: "http://flora.example.test/updates/app_isso" },
    { ...connection, url: config.updatesUrl + "?channel=production" },
    { ...connection, certificate: certificate + certificate },
    { ...connection, certificate: "-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----" },
  ]) assert.throws(() => verifyExpoConfiguration(job, resolved(), changed), /CONFIG_CHANGED/);
  const crlf = { ...connection, certificate: certificate.replaceAll("\n", "\r\n") };
  assert.equal(verifyExpoConfiguration(job, resolved(), crlf), "flora");
});
test("Expo child failures identify config versus export and expose only fixed diagnostic codes",async t=>{
 const {exportExpoProject}=await api(),{ProcessFailure}=await import("../dist/process.js"),{mkdir}=await import("node:fs/promises");const root=await mkdtemp(join(tmpdir(),"flora-expo-safe-diagnostic-"));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,"node_modules/expo/bin"),{recursive:true});
 for(const [phase,reported,expected] of [["config","EACCES","EXPO_EXECUTION_DENIED"],["export","EACCES","EXPO_EXECUTION_DENIED"],["export","EBUSY","EXPO_OUTPUT_BUSY"]]){
  await writeFile(join(root,"node_modules/expo/bin/cli"),`if(process.argv[2]===${JSON.stringify(phase)}){process.stderr.write(${JSON.stringify(reported+" private-source-canary\n")});process.exitCode=1;}else process.stdout.write(${JSON.stringify(JSON.stringify(resolved()))});`);
  await assert.rejects(exportExpoProject(root,join(root,"output"),job,{PATH:process.env.PATH!,CI:"1"},connection),error=>{assert.ok(error instanceof ProcessFailure);assert.equal(error.safeCode,expected);assert.equal(error.containerDiagnostic?.stage,"expo-"+phase);assert.ok(!JSON.stringify(error).includes("private-source-canary"));return true;});
 }
});

// Optional because the Runner's default Metro installation intentionally has no
// Expo dependency. Set this to an inspected Expo 57 app with @flora/ota installed.
const expoApp = process.env.FLORA_RUNNER_EXPO_TEST_APP;
test("real Expo 57 CLI exports the Flora branch and stops mismatched EAS settings before output", { skip: !expoApp }, async t => {
  const { exportExpoProject, readExpoConnection } = await api();
  const installed = createRequire(join(expoApp!, "package.json"));
  assert.match(installed("expo/package.json").version, /^57\./);
  const root = await mkdtemp(join(tmpdir(), "flora-expo-export-")); t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(join(expoApp!, "node_modules"), join(root, "node_modules"), "dir");
  const sdk = JSON.parse(await readFile(join(dirname(installed.resolve("@flora/ota/plugin")), "../package.json"), "utf8"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "flora-export-fixture", private: true, main: "index.js", dependencies: { expo: installed("expo/package.json").version, "@flora/ota": sdk.version } }));
  await writeFile(join(root, "index.js"), "globalThis.FloraExpoFixture='isso-only';\n");
  await writeFile(join(root, "flora.connection.json"), JSON.stringify(connection));
  await writeFile(join(root, "app.json"), JSON.stringify({ expo: resolved() }));
  const binding = await readExpoConnection(root), output = join(root, "export");
  const env = { PATH: process.env.PATH!, CI: "1", EXPO_NO_TELEMETRY: "1", EXPO_NO_DOTENV: "1", EXPO_OFFLINE: "1" };
  await exportExpoProject(root, output, job, env, binding);
  const bundle = await readExport(output, { platform: "ios", runtimeVersion: "native-1", commitSha: "a".repeat(40) });
  assert.ok(bundle.launchAsset.bytes.length > 0);
  assert.equal(bundle.platform, "ios"); assert.equal(bundle.runtimeVersion, "native-1");
  const invalidOutput = join(root, "invalid-export");
  await writeFile(join(root, "app.json"), JSON.stringify({ expo: { ...resolved(), updates: { enabled: false, url: "https://u.expo.dev/foreign" } } }));
  await assert.rejects(exportExpoProject(root, invalidOutput, job, env, binding), /CONFIG_CHANGED/);
  await assert.rejects(readFile(join(invalidOutput, "metadata.json")), { code: "ENOENT" });
});
