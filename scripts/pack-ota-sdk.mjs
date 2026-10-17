import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, constants, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join, resolve, dirname, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageRoot = join(root, "packages/ota-sdk");
const publicFiles = ["dist/index.js", "dist/index.d.ts", "dist/expo-updates.js", "dist/expo-updates.d.ts", "dist/native-adapter.js", "dist/native-adapter.d.ts", "dist/asset-resolver.js", "dist/asset-resolver.d.ts", "dist/telemetry.js", "dist/telemetry.d.ts",
  "native/index.js", "native/index.d.ts", "plugin/index.cjs", "plugin/transforms.cjs", "plugin/index.d.cts", "expo-module.config.json", "FloraOta.podspec", "ios/FloraOta.swift", "ios/FloraOtaBridge.m", "ios/FloraOTACore.swift", "ios/FloraOTAURLSessionTransport.swift",
  "android/build.gradle", "android/src/main/AndroidManifest.xml",
  ...["FloraProtocol", "FloraStore", "FloraEngine", "FloraOTAController", "FloraOtaModule", "FloraOtaPackage", "FloraReactHost"].map(name => `android/src/main/java/com/flora/ota/${name}.kt`),
  "android/src/expo/java/com/flora/ota/FloraExpoPackage.kt",
  "flora.config.schema.json", "README.md"];
/** Run npm's JavaScript entry with this Node, including Windows installations,
 * rather than executing a batch shim or a second Node found on PATH. */
export async function resolveNpmCLI() {
  const directories = [dirname(process.execPath), ...(process.env.PATH ?? "").split(delimiter).filter(Boolean)];
  for (const directory of directories) {
    for (const candidate of [join(directory, "node_modules/npm/bin/npm-cli.js"), join(directory, "../lib/node_modules/npm/bin/npm-cli.js"), join(directory, "npm")]) {
      try { const path = await realpath(candidate), source = await readFile(path, "utf8");
        if (path.endsWith("npm-cli.js") || /^#![^\n]*\bnode\b/.test(source)) return path;
      } catch { /* Try the next standard installation path. */ }
    }
  }
  throw new Error("SDK_NPM_UNAVAILABLE");
}
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: false, timeout: 30000, maxBuffer: 1048576 });
  if (result.error || result.status !== 0) throw new Error("SDK_PACKAGE_COMMAND_FAILED");
  return result.stdout;
}

/** Local distribution only. A fresh build and an explicit public file list keep
 * unrelated dist files, credentials, workspace dependencies and tests out. */
export async function packOTASDK(outdir = join(root, "dist/sdk")) {
  const destination = resolve(outdir);
  const require = createRequire(join(root, "package.json"));
  const stage = await mkdtemp(join(tmpdir(), "flora-sdk-pack-"));
  try {
    const buildOutput = join(stage, "compiled");
    run(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", join(packageRoot, "tsconfig.json"), "--outDir", buildOutput], root);
    const source = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    if (source.name !== "@flora/ota" || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(source.version)
      || Object.keys(source.dependencies ?? {}).length
      || JSON.stringify(source.peerDependencies) !== JSON.stringify({ "react-native": ">=0.86.3 <0.87" })
      || JSON.stringify(source.peerDependenciesMeta) !== JSON.stringify({ "react-native": { optional: true } })) throw new Error("SDK_PACKAGE_INVALID");
    const manifest = { name: source.name, version: source.version, private: true, type: "module", license: source.license,
      exports: source.exports, peerDependencies: source.peerDependencies, peerDependenciesMeta: source.peerDependenciesMeta, files: [...publicFiles, "LICENSE"] };
    await writeFile(join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    for (const file of publicFiles) {
      await mkdir(join(stage, file, ".."), { recursive: true });
      await copyFile(file.startsWith("dist/") ? join(buildOutput, file.slice(5)) : join(packageRoot, file), join(stage, file));
    }
    await copyFile(join(root, "LICENSE"), join(stage, "LICENSE"));
    const npm = await resolveNpmCLI();
    const emptyConfig = join(stage, "empty.npmrc"); await writeFile(emptyConfig, "");
    const reports = JSON.parse(run(process.execPath, [npm, "pack", "--json", "--ignore-scripts", "--offline", "--registry=http://127.0.0.1:9",
      "--userconfig", emptyConfig, "--cache", join(stage, ".cache"), "--pack-destination", stage], stage));
    const report = reports[0];
    const allowed = new Set(["package.json", "LICENSE", ...publicFiles]);
    if (reports.length !== 1 || report?.filename !== `flora-ota-${source.version}.tgz`
      || !Array.isArray(report.files) || report.files.length !== allowed.size
      || !report.files.every(file => allowed.has(file.path))) throw new Error("SDK_PACKAGE_INVALID");
    const bytes = await readFile(join(stage, report.filename));
    await mkdir(destination, { recursive: true });
    const path = join(destination, report.filename);
    // Repeated builds use a fresh destination rather than replace an existing
    // artifact that an app may already reference in its lockfile.
    await copyFile(join(stage, report.filename), path, constants.COPYFILE_EXCL);
    return { name: source.name, version: source.version, distribution: "local-tarball", path,
      sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, files: report.files.map(file => file.path) };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(resolve(process.argv[1]))).href) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--out" || !args[1] || /[\u0000-\u001f]/.test(args[1]))) {
    process.stderr.write("Usage: node scripts/pack-ota-sdk.mjs [--out DIRECTORY]\n"); process.exitCode = 2;
  } else {
    try { process.stdout.write(JSON.stringify(await packOTASDK(args[1])) + "\n"); }
    catch (error) { process.stderr.write(error?.code === "EEXIST" ? "SDK_PACKAGE_EXISTS: choose a new output directory\n" : "SDK_PACKAGE_FAILED\n"); process.exitCode = 1; }
  }
}
