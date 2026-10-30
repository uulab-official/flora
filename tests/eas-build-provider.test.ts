import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseEASBuildPlan, runEASBuild } from "../packages/cli/dist/providers-eas.js";

const args = ["eas", "start", "--platform", "android", "--profile", "preview"];

test("EAS integration is dry-run unless explicit execute is provided", () => {
  const plan = parseEASBuildPlan(args);
  assert.deepEqual(plan, { provider: "expo-eas", operation: "start", platform: "android", profile: "preview", execute: false });
  const result = runEASBuild(plan, {});
  assert.ok("dryRun" in result);
  assert.equal(result.dryRun, true);
  assert.ok("tokenEnvironment" in result);
  assert.equal(result.tokenEnvironment, "EXPO_TOKEN");
  assert.ok(!JSON.stringify(result).includes("secret"));
});
test("EAS build flags are bounded and reject unexpected actions or shell-like values", () => {
  const bad = [
    ["eas", "submit", "--platform", "android", "--profile", "preview"],
    [...args, "--profile", "prod"],
    ["eas", "start", "--platform", "all", "--profile", "preview"],
    ["eas", "start", "--platform", "ios", "--profile", "prod;rm -rf"],
    [...args, "--execute", "--execute"],
    [...args.slice(0, -1), "../outside"],
    ["eas", "start", "--platform", "android", "--profile"],
  ];
  for (const flags of bad) assert.throws(() => parseEASBuildPlan(flags), /PROVIDER_INVALID_INPUT/);
  assert.equal(parseEASBuildPlan([...args, "--execute"]).execute, true);
});
test("EAS requires local configuration and own token; does not download CLI on demand", () => {
  const plan = parseEASBuildPlan([...args, "--execute"]);
  assert.throws(() => runEASBuild(plan, {}), /PROVIDER_TOKEN_MISSING/);
  if (process.platform === "win32") {
    assert.throws(() => runEASBuild(plan, { EXPO_TOKEN: "sample-secret" }), /PROVIDER_LOCAL_EXECUTOR_UNSUPPORTED/);
    return;
  }
  assert.throws(() => runEASBuild(plan, { EXPO_TOKEN: "sample-secret" }, join(tmpdir(), "missing-flora-expo")), /PROVIDER_LOCAL_SETUP_REQUIRED/);
});
test("pinned installed EAS executable is invoked without shell and results are normalized", () => {
  if (process.platform === "win32") return;
  const dir = mkdtempSync(join(tmpdir(), "flora-eas-provider-"));
  try {
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "eas-cli"), { recursive: true });
    writeFileSync(join(dir, "node_modules", ".bin", "eas"), "mock not executable");
    writeFileSync(join(dir, "node_modules", "eas-cli", "package.json"), JSON.stringify({ version: "16.24.1" }));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { "eas-cli": "16.24.1" } }));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(join(dir, "eas.json"), "{}");
    let called = 0;
    const secret = "actual-private-eas-token";
    const mocked = ((command: string, flags: string[], options: Record<string, unknown>) => {
      called++;
      assert.equal(command, join(dir, "node_modules", ".bin", "eas"));
      assert.deepEqual(flags, ["build", "--platform", "android", "--profile", "preview", "--non-interactive", "--no-wait", "--json"]);
      assert.equal(options.shell, false);
      assert.equal((options.env as Record<string, unknown>).EXPO_TOKEN, secret);
      assert.equal(options.cwd, dir);
      return { status: 0, stdout: JSON.stringify([{ id: "9cc8abc4-504a-4ccb-93e7-eab65a1c681f" }]), stderr: "not forwarded", error: undefined };
    }) as unknown as typeof spawnSync;
    const result = runEASBuild(parseEASBuildPlan([...args, "--execute"]), { EXPO_TOKEN: secret }, dir, mocked);
    assert.equal(called, 1);
    assert.deepEqual(result, { provider: "expo-eas", operation: "start", state: "requested", buildIds: ["9cc8abc4-504a-4ccb-93e7-eab65a1c681f"] });
    assert.ok(!JSON.stringify(result).includes(secret));
    const failed = ((..._args: unknown[]) => ({ status: 1, stdout: secret, stderr: secret, error: undefined })) as unknown as typeof spawnSync;
    assert.throws(() => runEASBuild(parseEASBuildPlan([...args, "--execute"]), { EXPO_TOKEN: secret }, dir, failed), /^Error: PROVIDER_LOCAL_EXECUTION_UNAVAILABLE$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("EAS CLI command offers a credential-free plan from a different working directory", () => {
  const cli = resolve("packages/cli/dist/main.js");
  const result = spawnSync(process.execPath, [cli, "providers", ...args], { encoding: "utf8", timeout: 10000, env: { ...process.env, EXPO_TOKEN: "" } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).plan.provider, "expo-eas");
});
