import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolvePnpmEntry } from "../src/doctor.ts";
import * as doctor from "../src/doctor.ts";
import type { DoctorReport } from "../src/doctor.ts";

type Facts = Pick<DoctorReport, "node" | "pnpm" | "tools">;
function readyFacts(): Facts {
  return {
    node: { version: "v24.19.0", supported: true },
    pnpm: { status: "available", version: "11.19.0" },
    tools: {
      git: { status: "available", version: "git version 2.54.0" },
      xcode: { status: "unsupported", version: null },
      java: { status: "unavailable", version: null },
    },
  };
}
function assess(facts: Facts) {
  const evaluate = Reflect.get(doctor, "assessReadiness");
  assert.equal(typeof evaluate, "function", "doctor must assess required prerequisites");
  return evaluate(facts) as {
    ready: boolean;
    issues: { tool: string; code: string; message: string; remediation: string }[];
  };
}
async function probe(tool: "pnpm" | "git" | "xcode" | "java", source: string, timeoutMs = 3000) {
  const evaluate = Reflect.get(doctor, "probeTool");
  assert.equal(typeof evaluate, "function", "doctor must bound and sanitize real tool probes");
  return evaluate(tool, process.execPath, ["-e", source], timeoutMs) as Promise<{
    status: string; version: string | null; reason?: string;
  }>;
}

test("missing optional native tools do not block the local foundation", () => {
  assert.deepEqual(assess(readyFacts()), { ready: true, issues: [] });
});
test("an unsupported Node patch is a blocking prerequisite with a recovery hint", () => {
  const facts = readyFacts();
  facts.node = { version: "v24.18.0", supported: false };
  const result = assess(facts);
  assert.equal(result.ready, false);
  assert.equal(result.issues[0]?.code, "NODE_VERSION_UNSUPPORTED");
  assert.match(result.issues[0]?.remediation ?? "", /24\.19\.0/);
});
test("a different pnpm version cannot satisfy the pinned toolchain", () => {
  const facts = readyFacts();
  facts.pnpm.version = "10.9.0";
  const result = assess(facts);
  assert.equal(result.ready, false);
  assert.equal(result.issues[0]?.code, "PNPM_VERSION_UNSUPPORTED");
  assert.match(result.issues[0]?.remediation ?? "", /pnpm@11\.19\.0/);
});
test("all missing required tools are reported instead of stopping at the first one", () => {
  const facts = readyFacts();
  facts.node.supported = false;
  facts.pnpm = { status: "unavailable", version: null };
  facts.tools.git = { status: "unavailable", version: null };
  const result = assess(facts);
  assert.equal(result.ready, false);
  assert.deepEqual(result.issues.map(issue => issue.tool), ["node", "pnpm", "git"]);
  assert.ok(result.issues.every(issue => issue.remediation.length > 0));
});
test("real version probes discard unrelated stdout and stderr rather than expose them", async () => {
  for (const [tool, output, expected] of [
    ["pnpm", "11.19.0", "11.19.0"],
    ["git", "git version 2.54.0 (private-sample)", "git version 2.54.0"],
    ["xcode", "Xcode 27.1", "Xcode 27.1"],
    ["java", 'openjdk version "17.0.20" 2026-07-21', 'openjdk version "17.0.20"'],
  ] as const) {
    const result = await probe(tool,
      `process.stdout.write(${JSON.stringify(output + "\nprivate-sample\n")}); process.stderr.write('private-sample');`);
    assert.equal(result.status, "available");
    assert.equal(result.version, expected);
    assert.ok(!JSON.stringify(result).includes("private-sample"));
  }
});
test("a successful command with unrecognized output is not verified", async () => {
  const result = await probe("pnpm", "console.log('private-sample')");
  assert.equal(result.status, "unavailable");
  assert.equal(result.version, null);
  assert.equal(result.reason, "unrecognized-output");
  assert.ok(!JSON.stringify(result).includes("private-sample"));
});
test("failed commands cannot leak their error text into the report", async () => {
  const result = await probe("git", "console.error('private-sample');process.exitCode=7");
  assert.equal(result.status, "unavailable");
  assert.equal(result.version, null);
  assert.equal(result.reason, "execution-failed");
  assert.ok(!JSON.stringify(result).includes("private-sample"));
});
test("a hung tool probe is terminated and reported as a timeout", async () => {
  const result = await probe("git", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)", 200);
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "timeout");
  const facts = readyFacts();
  facts.tools.git = result as Facts["tools"]["git"];
  assert.equal(assess(facts).issues[0]?.code, "GIT_TIMEOUT");
});
test("excessive tool output is bounded and rejected", async () => {
  const result = await probe("pnpm", "process.stdout.write('private-sample'.repeat(1000))");
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "output-limit");
  assert.ok(!JSON.stringify(result).includes("private-sample"));
});
test("pnpm resolves a pinned JavaScript entry and rejects cmd wrappers", () => {
  const dir = mkdtempSync(join(tmpdir(), "platform-pnpm-"));
  try {
    mkdirSync(join(dir, "bin"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "pnpm", version: "11.19.0" }),
    );
    const js = join(dir, "bin", "pnpm.cjs"),
      cmd = join(dir, "pnpm.cmd");
    writeFileSync(js, "// fixture, never executed");
    writeFileSync(cmd, "echo do-not-execute");
    assert.equal(resolvePnpmEntry(js), realpathSync(js));
    assert.equal(resolvePnpmEntry(cmd), null);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "pnpm", version: "different" }),
    );
    assert.equal(resolvePnpmEntry(js), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
