import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  parseRemoteBuildPlan, runRemoteBuild,
} from "../packages/cli/dist/providers-external.js";

const cm = ["codemagic", "start", "--app", "app123", "--workflow", "ios-release", "--branch", "main"];
const bt = ["bitrise", "start", "--app", "slug-456", "--workflow", "release", "--branch", "release/1"];
const execute = (args: string[]) => parseRemoteBuildPlan([...args, "--execute"]);

test("dry-run validates inputs without credentials or sending network requests", async () => {
  let calls = 0;
  const forbiddenRequest: typeof fetch = async () => { calls++; throw Error("unexpected request"); };
  const result = await runRemoteBuild(parseRemoteBuildPlan(cm), {}, forbiddenRequest);
  assert.equal(calls, 0);
  assert.equal(result.dryRun, true);
  assert.ok(JSON.stringify(result).includes("CODEMAGIC_API_TOKEN"));
  assert.ok(!JSON.stringify(result).includes("x-auth-token"));
  assert.equal(parseRemoteBuildPlan(cm).endpoint, "https://api.codemagic.io/builds");
  assert.equal(parseRemoteBuildPlan(bt).endpoint, "https://api.bitrise.io/v0.1/apps/slug-456/builds");
});

test("invalid requests reject branching, duplicate flags, control characters, injections and unknown endpoints", () => {
  const invalid = [
    ["eas", ...cm.slice(1)],
    [...cm, "--branch", "other"],
    [...cm.slice(0, -1), "main;rm -rf /"],
    [...cm.slice(0, -1), "../evil"],
    [...cm.slice(0, -1), "feature//bad"],
    ["bitrise", "cancel", "--app", "slug-456"],
    ["codemagic", "status", "--build", "abc123"],
    ["codemagic", "cancel", "--build", "../../private"],
    ["bitrise", "start", "--app", "example.com/path", "--workflow", "w", "--branch", "main"],
    [...bt, "--execute", "--execute"],
    ["bitrise", "status", "--app", "id", "--build", "abc", "--workflow", "surprise"],
  ];
  for (const args of invalid) assert.throws(() => parseRemoteBuildPlan(args));
  assert.throws(() => parseRemoteBuildPlan(["bitrise", "start", "--app", "x", "--workflow", "w"]), /PROVIDER_INVALID_INPUT/);
});

test("Codemagic API request sends only fixed endpoint and explicit JSON, returns build receipt without leaking token", async () => {
  const secret = "test-codemagic-private-secret";
  const requested: unknown[] = [];
  const request: typeof fetch = async (input, init) => {
    requested.push([input, init?.method, init?.redirect, init?.headers, init?.body]);
    assert.equal(input, "https://api.codemagic.io/builds");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "manual");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-auth-token"), secret);
    assert.deepEqual(JSON.parse(init?.body as string), { appId: "app123", workflowId: "ios-release", branch: "main" });
    return new Response(JSON.stringify({ buildId: "build123" }), { status: 201, headers: { "Content-Type": "application/json" } });
  };
  const result = await runRemoteBuild(execute(cm), { CODEMAGIC_API_TOKEN: secret }, request);
  assert.deepEqual(result, { provider: "codemagic", operation: "start", state: "requested", buildId: "build123" });
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(requested.length, 1);
});

test("Bitrise API supports start, status and cancel while retaining explicit caller approval", async () => {
  const secret = "test-bitrise-private-token";
  const calls: string[] = [];
  const request: typeof fetch = async (input, init) => {
    calls.push(String(input));
    assert.equal(new Headers(init?.headers).get("Authorization"), secret);
    if (init?.method === "GET") {
      return new Response(JSON.stringify({ data: { status: 1 } }), { status: 200 });
    }
    if (String(input).endsWith("/abort")) {
      assert.deepEqual(JSON.parse(init?.body as string), {});
      return new Response("{}", { status: 200 });
    }
    assert.deepEqual(JSON.parse(init?.body as string), {
      hook_info: { type: "bitrise" }, build_params: { branch: "release/1", workflow_id: "release" },
    });
    return new Response(JSON.stringify({ results: [{ build_slug: "build0123" }] }), { status: 201 });
  };
  const environment = { BITRISE_API_TOKEN: secret };
  assert.deepEqual(await runRemoteBuild(execute(bt), environment, request),
    { provider: "bitrise", operation: "start", state: "requested", buildId: "build0123" });
  assert.deepEqual(await runRemoteBuild(execute(["bitrise", "status", "--app", "slug-456", "--build", "build0123"]), environment, request),
    { provider: "bitrise", operation: "status", state: "status", buildId: "build0123", status: "succeeded" });
  assert.deepEqual(await runRemoteBuild(execute(["bitrise", "cancel", "--app", "slug-456", "--build", "build0123"]), environment, request),
    { provider: "bitrise", operation: "cancel", state: "cancel_requested", buildId: "build0123" });
  assert.equal(calls.length, 3);
});

test("a completed Codemagic cancel returns already_finished, not a claim of cancellation", async () => {
  const r = await runRemoteBuild(
    execute(["codemagic", "cancel", "--build", "build123"]),
    { CODEMAGIC_API_TOKEN: "sample-secret-value" },
    async () => new Response("", { status: 208 }),
  );
  assert.deepEqual(r, { provider: "codemagic", operation: "cancel", state: "already_finished", buildId: "build123" });
});

test("external transport fails closed on missing token, redirect, unavailable host, huge response and malformed response", async () => {
  const plan = execute(cm);
  await assert.rejects(runRemoteBuild(plan, {}, async () => { throw Error("SHOULD_NOT_FETCH"); }), /PROVIDER_TOKEN_MISSING/);
  const tests = [
    [() => new Response(null, { status: 302 }), "PROVIDER_REDIRECT_REJECTED"],
    [() => new Response("private auth error", { status: 403 }), "PROVIDER_PERMISSION_DENIED"],
    [() => new Response("429 throttled", { status: 429 }), "PROVIDER_RATE_LIMITED"],
    [() => new Response("x".repeat(65537), { status: 200 }), "PROVIDER_RESPONSE_INVALID"],
    [() => new Response(JSON.stringify({ unknown: "id" }), { status: 200 }), "PROVIDER_RESPONSE_INVALID"],
  ] as const;
  for (const [response, expected] of tests) {
    await assert.rejects(runRemoteBuild(plan, { CODEMAGIC_API_TOKEN: "sample-secret-value" }, async () => response()), new RegExp(expected));
  }
  await assert.rejects(runRemoteBuild(plan, { CODEMAGIC_API_TOKEN: "sample-secret-value" }, async () => { throw Error("PRIVATE_TOKEN_IN_NETWORK_ERROR"); }), /PROVIDER_NETWORK_UNAVAILABLE/);
});

test("CLI lists provider capabilities, offers dry-run and fails on missing credential without token echo", () => {
  const cli = resolve("packages/cli/dist/main.js");
  const cmd = (...args: string[]) => spawnSync(process.execPath, [cli, "providers", ...args], {
    encoding: "utf8", timeout: 10000,
    env: { ...process.env, CODEMAGIC_API_TOKEN: "", BITRISE_API_TOKEN: "" },
  });
  const dry = cmd(...cm);
  assert.equal(dry.status, 0, dry.stderr);
  const result = JSON.parse(dry.stdout);
  assert.equal(result.dryRun, true);
  assert.equal(result.plan.execute, false);
  assert.equal(result.tokenEnvironment, "CODEMAGIC_API_TOKEN");
  const attempted = cmd(...cm, "--execute");
  assert.equal(attempted.status, 1);
  assert.ok(attempted.stderr.includes("PROVIDER_TOKEN_MISSING"));
  assert.equal(attempted.stdout, "");
  assert.equal(cmd("codemagic", "start", "--bad").status, 1);
});
