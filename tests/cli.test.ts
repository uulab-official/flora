import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const cli = resolve("packages/cli/dist/main.js"),
  example = resolve("examples/local-workflow.json");
function run(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env,
    timeout: 15_000,
  });
}
test("doctor reports actual local OS without pretending native readiness", () => {
  const r = run(["doctor", "--json"]);
  assert.equal(r.status, 0);
  const report = JSON.parse(r.stdout);
  assert.equal(report.mode, "local");
  assert.equal(report.os, process.platform);
  assert.equal(report.node.version, process.version);
  assert.equal(report.nativeBuildVerified, false);
});
test("strict doctor fails missing prerequisites while legacy doctor remains informational", () => {
  const env = { ...process.env, PATH: "", npm_execpath: "" };
  for (const flags of [["--strict", "--json"], ["--json", "--strict"], ["--strict"]]) {
    const result = run(["doctor", ...flags], env);
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.readiness.ready, false);
    assert.ok(report.readiness.issues.some((issue: { code: string }) => issue.code === "PNPM_NOT_VERIFIED"));
    assert.ok(report.readiness.issues.some((issue: { code: string }) => issue.code === "GIT_UNAVAILABLE"));
    assert.equal(report.nativeBuildVerified, false);
    assert.equal(result.stderr, "");
  }
  const legacy = run(["doctor", "--json"], env);
  assert.equal(legacy.status, 0);
  assert.equal(JSON.parse(legacy.stdout).readiness.ready, false);
  for (const flags of [["--strict", "--strict"], ["--json", "--json"], ["--strict", "--invalid"]])
    assert.equal(run(["doctor", ...flags], env).status, 2);
});
test("strict doctor succeeds on verified prerequisites and rejects the actual pnpm version mismatch", () => {
  const directory = mkdtempSync(join(tmpdir(), "flora-doctor-toolchain-"));
  try {
    const entry = join(directory, "pnpm.cjs");
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "pnpm", version: "11.19.0" }));
    writeFileSync(entry, "console.log('11.19.0');console.error('private-sample')");
    const env = { ...process.env, npm_execpath: entry };
    const healthy = run(["doctor", "--strict", "--json"], env);
    assert.equal(healthy.status, 0, healthy.stderr + healthy.stdout);
    const report = JSON.parse(healthy.stdout);
    assert.deepEqual(report.readiness, { ready: true, issues: [] });
    assert.equal(report.nativeBuildVerified, false);
    assert.ok(!healthy.stdout.includes("private-sample"));
    writeFileSync(entry, "console.log('10.9.0')");
    const mismatch = run(["doctor", "--strict"], env);
    assert.equal(mismatch.status, 1);
    assert.equal(JSON.parse(mismatch.stdout).readiness.issues[0].code, "PNPM_VERSION_UNSUPPORTED");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("doctor runner-service diagnostics block strict readiness without leaking private input", () => {
  const directory = mkdtempSync(join(tmpdir(), "flora-runner-cli-"));
  try {
    const entry = join(directory, "pnpm.cjs");
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "pnpm", version: "11.19.0" }));
    writeFileSync(entry, "console.log('11.19.0')");
    const env = { ...process.env, npm_execpath: entry };
    const privatePath = join(directory, "private-sample-missing.json");
    const strict = run(["doctor", "--json", "--runner-service", privatePath, "--strict"], env);
    assert.equal(strict.status, 1, strict.stderr);
    const report = JSON.parse(strict.stdout);
    assert.equal(report.runner.readOnly, true);
    assert.equal(report.runner.serverOnlineVerified, false);
    assert.equal(report.runner.ready, false);
    assert.equal(report.readiness.ready, false);
    assert.ok(report.readiness.issues.some((issue: { tool: string }) => issue.tool === "runner"));
    assert.equal(strict.stderr, "");
    assert.ok(!strict.stdout.includes("private-sample"));
    const informational = run(["doctor", "--runner-service", privatePath], env);
    assert.equal(informational.status, 0, informational.stderr);
    assert.equal(JSON.parse(informational.stdout).runner.ready, false);
    assert.equal(run(["doctor", "--json"], env).status, 0);
    assert.equal(JSON.parse(run(["doctor", "--json"], env).stdout).runner, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("doctor rejects incomplete or duplicate runner-service flags without exposing arguments", () => {
  for (const flags of [
    ["--runner-service"],
    ["--runner-service", "--strict"],
    ["--runner-service", "private-sample", "--runner-service", "private-sample"],
    ["--runner-service", "private-sample", "--json", "--json"],
    ["--runner-service=private-sample"],
  ]) {
    const result = run(["doctor", ...flags]);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^USAGE_ERROR\n/);
    assert.ok(!result.stderr.includes("private-sample"));
  }
});
test("configuration CLI hides values and aliases share implementation", () => {
  const r = run(["config", "validate", "--file", example]);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.match(report.snapshotId, /^cfg_[a-f0-9]{64}$/);
  assert.ok(!r.stdout.includes("api.example.invalid"));
  assert.equal(run(["--version"]).stdout.trim(), "0.1.0");
  assert.equal(run(["unknown"]).status, 2);
  assert.equal(run(["doctor", "--invalid"]).status, 2);
});
for (const scenario of ["happy-path", "runner-replacement", "unsafe-expiry"])
  test("CLI local scenario " + scenario, () => {
    const r = run([
      "job",
      "simulate",
      "--file",
      example,
      "--scenario",
      scenario,
    ]);
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.mode, "local-simulation");
    const job = report.summary.jobs[0];
    assert.equal(
      job.status,
      scenario === "unsafe-expiry" ? "waiting" : "success",
    );
    assert.equal(
      report.summary.artifacts.length,
      scenario === "unsafe-expiry" ? 0 : 1,
    );
    if (scenario === "runner-replacement") {
      assert.equal(job.fence, 2);
      assert.equal(report.rejectedOperations[0].code, "LEASE_STALE");
    }
  });
test("read-only Unicode paths and repeat runs preserve input and snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "platform 경로 "));
  try {
    const file = join(dir, "설정 공백.json");
    const before = readFileSync(example);
    writeFileSync(file, before);
    chmodSync(file, 0o444);
    const a = run(["config", "validate", "--file", file]);
    const b = run(["config", "validate", "--file", file], {
      ...process.env,
      PRODUCT_NAME: "Renamed",
    });
    assert.equal(a.status, 0);
    assert.equal(b.status, 0);
    assert.equal(
      JSON.parse(a.stdout).snapshotId,
      JSON.parse(b.stdout).snapshotId,
    );
    assert.deepEqual(readFileSync(file), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("malformed oversized and plaintext secret input fail without echoing content", () => {
  const dir = mkdtempSync(join(tmpdir(), "platform-invalid-"));
  try {
    const file = join(dir, "input.json");
    for (const value of [
      "{bad-json-private-sample",
      JSON.stringify({ constructor: "private-sample" }),
      "x".repeat(1_048_577),
    ]) {
      writeFileSync(file, value);
      const r = run(["config", "validate", "--file", file]);
      assert.equal(r.status, 1);
      assert.ok(!r.stderr.includes("private-sample"));
    }
    const data = JSON.parse(readFileSync(example, "utf8"));
    data.configEntries[1].binding.value = "private-sample";
    writeFileSync(file, JSON.stringify(data));
    const r = run(["config", "validate", "--file", file]);
    assert.equal(r.status, 1);
    assert.ok(!r.stderr.includes("private-sample"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("display branding can change without changing internal command names", () => {
  const r = run(["--help"], { ...process.env, PRODUCT_NAME: "NewName" });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes("NewName"));
  assert.ok(r.stdout.includes("platform config validate"));
});
test("setup dispatch honors supplied CLI output and never echoes unknown arguments",async()=>{
 const modulePath="../packages/cli/dist/main.js",{runCli}=await import(modulePath),output:string[]=[],errors:string[]=[];
 assert.equal(await runCli(["setup","--token","synthetic-private-value"],{stdout:(s:string)=>output.push(s),stderr:(s:string)=>errors.push(s),readFile:async()=>{throw Error("no read");}}),2);
 assert.equal(output.length,1);assert.equal(JSON.parse(output[0]!).code,"SETUP_USAGE_ERROR");assert.ok(!output.join().includes("synthetic-private-value"));assert.deepEqual(errors,[]);
});
