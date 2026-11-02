import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, mkdir, mkdtemp, realpath, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../dist/native-main.js", import.meta.url));
async function run(t: TestContext, args: string[]) {
  const child = spawn(process.execPath, [entry, ...args], {stdio: ["ignore", "pipe", "pipe"]});
  let stdout = "", stderr = "";
  child.stdout.on("data", bytes => {stdout += bytes;}); child.stderr.on("data", bytes => {stderr += bytes;});
  const ended = new Promise<{code: number | null; stdout: string; stderr: string}>((resolve, reject) => {
    child.on("error", reject); child.on("close", code => resolve({code, stdout, stderr}));
  });
  t.after(async () => {if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await ended.catch(() => {});});
  return ended;
}
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flora-artifact-cli-"))); await chmod(root, 0o700);
  t.after(() => rm(root, {recursive: true, force: true}));
  let requests = 0; const server = createServer((req, res) => {requests++; req.resume(); res.end("{}");});
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));});
  const store = join(root, "artifacts"), out = join(root, "out"); await mkdir(store, {mode: 0o700}); await mkdir(out, {mode: 0o700});
  const fileName = "native_job_sample.apk", bytes = Buffer.from("synthetic unsigned native CLI output"), pin = "b".repeat(64);
  const receipt = {jobId: "native_job_sample", appId: "app_fixture", platform: "android", fileName, commitSha: "a".repeat(40),
    sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length, appIdentifier: "test.app", signerFingerprint: pin, completionConfirmed: true};
  await writeFile(join(store, fileName), bytes, {mode: 0o600}); await writeFile(join(store, fileName + ".receipt.json"), JSON.stringify(receipt), {mode: 0o600});
  const config = join(root, "native.json"), tool = await realpath(process.execPath);
  await writeFile(config, JSON.stringify({origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "native_runner_fixture."+"a".repeat(43),
    appId: "app_fixture", platform: "android", sourceDirectory: root, artifactDirectory: store, expectedCertificateSha256: pin,
    tools: {git: tool, keytool: tool, apksigner: tool, aapt2: tool, zipalign: tool}, android: {directory: "android", apkPath: "unused.apk"}}), {mode: 0o600});
  return {root, config, store, out, fileName, bytes, receipt, requests: () => requests};
}
const posix = {skip: process.platform === "win32", timeout: 15000};
test("actual native CLI lists, inspects and exports an existing output without a network or compiler request", posix, async t => {
  const f = await fixture(t);
  const list = await run(t, ["--config", f.config, "--artifacts"]); assert.equal(list.code, 0); const catalogue = JSON.parse(list.stdout);
  assert.equal(catalogue.state, "native_artifacts"); assert.equal(catalogue.records[0].integrityVerified, false);
  const check = await run(t, ["--config", f.config, "--inspect", f.fileName]); assert.equal(check.code, 0);
  const proof = JSON.parse(check.stdout); assert.equal(proof.integrityVerified, true); assert.equal(proof.signatureRechecked, false); assert.equal(proof.installVerified, false);
  const target = join(f.out, "result.apk"), copy = await run(t, ["--config", f.config, "--export", f.fileName, "--output", target]);
  assert.equal(copy.code, 0); assert.equal(JSON.parse(copy.stdout).exported, true); assert.deepEqual(await readFile(target), f.bytes);
  const repeat = await run(t, ["--config", f.config, "--export", f.fileName, "--output", target]); assert.equal(repeat.code, 1); assert.equal(JSON.parse(repeat.stderr).code, "NATIVE_EXPORT_EXISTS");
  assert.equal(f.requests(), 0); assert.ok(![list.stdout,check.stdout,copy.stdout,repeat.stderr].join("").includes(f.root));
});
test("actual catalogue displays recovery attention without deleting pending data or contacting the server", posix, async t => {
  const f = await fixture(t); await mkdir(join(f.store, ".pending"), {mode: 0o700}); const marker = join(f.store, ".pending", "PRIVATE_LEASE"); await writeFile(marker, "PRIVATE_TOKEN");
  const result = await run(t, ["--config", f.config, "--artifacts"]);
  assert.equal(result.code, 1); assert.equal(result.stderr, ""); assert.equal(JSON.parse(result.stdout).pendingEntries, 1);
  assert.equal(JSON.parse(result.stdout).recoveryRequired, true); assert.equal(await readFile(marker,"utf8"), "PRIVATE_TOKEN");
  assert.ok(!result.stdout.includes("PRIVATE")); assert.equal(f.requests(),0);
});
test("actual CLI rejects mutated or unconfirmed outputs without releasing an export", posix, async t => {
  const f = await fixture(t); await writeFile(join(f.store,f.fileName), Buffer.alloc(f.bytes.length, 0x71));
  const changed = await run(t, ["--config", f.config, "--inspect", f.fileName]); assert.equal(changed.code,1); assert.equal(JSON.parse(changed.stderr).code,"NATIVE_ARTIFACT_HASH_MISMATCH");
  await writeFile(join(f.store,f.fileName+".receipt.json"),JSON.stringify({...f.receipt,completionConfirmed:false}));
  const unconfirmed = await run(t,["--config",f.config,"--export",f.fileName,"--output",join(f.out,"result.apk")]);
  assert.equal(unconfirmed.code,1);assert.equal(JSON.parse(unconfirmed.stderr).code,"NATIVE_ARTIFACT_UNCONFIRMED");assert.equal(f.requests(),0);
});
test("actual native help exposes offline modes and invalid export syntax reads no config", {timeout: 10000}, async t => {
  const help = await run(t, ["--help"]); assert.equal(help.code,0);assert.match(help.stdout,/--artifacts/);assert.match(help.stdout,/--inspect/);assert.match(help.stdout,/--export/);
  const invalid = await run(t,["--config","/PRIVATE_DO_NOT_READ","--export","../bad.apk","--output","/out.apk"]);
  assert.equal(invalid.code,2);assert.ok(!invalid.stderr.includes("PRIVATE_DO_NOT_READ"));assert.equal(JSON.parse(invalid.stderr).code,"INVALID_NATIVE_CONFIG");
});
