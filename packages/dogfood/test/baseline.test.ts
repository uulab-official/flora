import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { CONFIG_RUNTIME_SMOKE_V1 as profile, parseSourceBundle, parseBaselineBundle, assessReport, normalizeReportTestPath } from "@app-ops/dogfood";
import { bundleBytes, DOGFOOD_IMPORTED_AT, DOGFOOD_TEST_FILES, syntheticSourceBundle, syntheticBaseline, syntheticReport, withReport } from "../../../tests/dogfood-fixtures.ts";

const snapshot = () => parseSourceBundle(bundleBytes(syntheticSourceBundle()), DOGFOOD_IMPORTED_AT);
test("accepts exact imported four-test evidence, including suite count four", async () => {
  const s = await snapshot();
  const b = syntheticBaseline(s);
  const e = await parseBaselineBundle(bundleBytes(b), s);
  assert.deepEqual(assessReport(e, profile), { status: "passed", code: "PASSED", files: 2, tests: 4, passed: 4, failed: 0, skipped: 0, reportDigest: b.reportSha256 });
  assert.match(e.evidenceDigest, /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(e));
});

test("rejects plausible false passes in otherwise valid report envelopes", async () => {
  const s = await snapshot();
  const cases: [string, (b: ReturnType<typeof syntheticBaseline>) => unknown][] = [
    ["nonzero exit", b => ({ ...b, exitCode: 1 })], ["no exit", b => ({ ...b, exitCode: null })],
    ["empty", b => withReport(b, {})], ["null", b => withReport(b, null)],
    ["malformed", b => withReport(b, "{broken")], ["missing", b => withReport(b, "")],
    ["success alone", b => withReport(b, { success: true })],
    ...["other", "extra", "duplicate", "duplicate assertion", "skip", "todo", "pending", "aggregate", "success", "file", "window", "end before start"].map((kind): [string, (b: ReturnType<typeof syntheticBaseline>) => unknown] => [kind, b => {
      const r = syntheticReport();
      if (kind === "other") r.testResults[0]!.name = "/work/sample/tests/other.test.ts";
      if (kind === "extra") r.testResults.push(r.testResults[0]!);
      if (kind === "duplicate") r.testResults[1]!.name = r.testResults[0]!.name;
      if (kind === "duplicate assertion") r.testResults[0]!.assertionResults[1] = r.testResults[0]!.assertionResults[0]!;
      if (["skip", "todo", "pending"].includes(kind)) r.testResults[0]!.assertionResults[0]!.status = kind;
      if (kind === "aggregate") r.numPassedTests = 3;
      if (kind === "success") r.success = false;
      if (kind === "file") r.testResults[0]!.status = "failed";
      if (kind === "window") r.testResults[0]!.endTime += 10_000;
      if (kind === "end before start") r.testResults[0]!.endTime = r.testResults[0]!.startTime - 1;
      return withReport(b, r);
    }]),
  ];
  for (const [name, change] of cases) {
    const e = await parseBaselineBundle(bundleBytes(change(syntheticBaseline(s))), s);
    assert.notEqual(assessReport(e, profile).status, "passed", name);
  }
  const r = syntheticReport();
  r.testResults[0]!.status = "failed";
  r.testResults[0]!.assertionResults[0]!.status = "failed";
  Object.assign(r, { numPassedTests: 3, numFailedTests: 1, numPassedTestSuites: 3, numFailedTestSuites: 1, success: false });
  assert.equal(assessReport(await parseBaselineBundle(bundleBytes(withReport({ ...syntheticBaseline(s), exitCode: 1 }, r)), s), profile).status, "failed");
});

test("rejects malformed and source-mismatched envelopes before assessment", async () => {
  const s = await snapshot(); const b = syntheticBaseline(s);
  const changes: unknown[] = [
    { ...b, sourceDigest: "b".repeat(64) }, { ...b, commitSha: "b".repeat(40) }, { ...b, profileId: "other" },
    { ...b, trusted: true }, { ...b, isolated: true }, { ...b, platform: "android" }, { ...b, architecture: "other" },
    { ...b, reportSha256: "b".repeat(64) }, { ...b, reportBase64: "AA=" }, { ...b, argv: ["npm", "test"] },
    { ...b, argv: [...b.argv.slice(0, -1), "--outputFile=/other.json"] },
    { ...b, runtime: { ...b.runtime, node: "24.18.0" } }, { ...b, runtime: { ...b.runtime, vite: "1.0.0" } }, { ...b, runtime: { ...b.runtime, vitest: "1.0.0" } },
    { ...b, startedAt: "2026-02-30T00:00:00Z" }, { ...b, finishedAt: "2025-01-01T00:00:00Z" }, { ...b, durationMs: -1 }, { ...b, durationMs: 5000 },
    ...["sourceHashesBefore", "sourceHashesAfter"].flatMap(key => [
      { ...b, [key]: {} }, { ...b, [key]: { ...b.sourceHashesBefore, "package-lock.json": "b".repeat(64) } },
      { ...b, [key]: { ...b.sourceHashesBefore, extra: "b".repeat(64) } },
      { ...b, [key]: Object.fromEntries(Object.entries(b.sourceHashesBefore).slice(1)) },
      { ...b, [key]: { ...b.sourceHashesBefore, "package.json": "" } },
    ]),
    { ...b, sourceRoot: "relative" }, { ...b, reportPath: "../report.json" },
  ];
  for (const input of changes) await assert.rejects(parseBaselineBundle(bundleBytes(input), s), { code: "INVALID_INPUT" });
  await assert.rejects(parseBaselineBundle(new Uint8Array([0xff]), s), { code: "INVALID_INPUT" });
  await assert.rejects(parseBaselineBundle(new Uint8Array(2 * 1024 * 1024 + 1), s), { code: "INVALID_INPUT" });
  await assert.rejects(parseBaselineBundle(bundleBytes(withReport(b, "x".repeat(1024 * 1024 + 1))), s), { code: "INVALID_INPUT" });
  await assert.rejects(parseBaselineBundle(bundleBytes(b).slice(0, -1), s), { code: "INVALID_INPUT" });
});

test("uses platform-explicit lexical report paths on every host", async () => {
  const file = DOGFOOD_TEST_FILES[0];
  const valid = [
    ["linux", "/work/sample", `/work/sample/${file}`], ["darwin", "/work/sample/", file],
    ["win32", "C:\\work\\sample", `C:\\work\\sample\\${file.replaceAll("/", "\\")}`],
    ["win32", "C:/work/sample/", `C:/work/sample/${file}`],
    ["win32", "\\\\server\\share\\sample", `\\\\server\\share\\sample\\${file.replaceAll("/", "\\")}`],
  ];
  for (const [platform, sourceRoot, name] of valid) assert.equal(normalizeReportTestPath({ platform: platform as "linux", sourceRoot: sourceRoot!, name: name!, expectedFiles: DOGFOOD_TEST_FILES }), file);
  const invalid = [
    ["linux", "/work/sample", `/work/sample-other/${file}`], ["linux", "/work/sample", `/work/sample/../sample/${file}`],
    ["linux", "/work/sample", `tests\\config\\runtime.test.ts`], ["linux", "/work/sample", `./${file}`],
    ["linux", "/work//sample", file], ["linux", "/work/sample", `/work/sample//${file}`],
    ["linux", "/work/sample", `/work/Sample/${file}`], ["linux", "/work/sample", `${file}/`],
    ["linux", "/work/sample", `https://example.invalid/${file}`], ["linux", "/work/sample", `/work/sample/${file}\0`],
    ["win32", "C:\\work\\sample", `D:\\work\\sample\\${file}`],
    ["win32", "C:\\work\\sample", `c:\\work\\sample\\${file}`],
    ["win32", "C:\\work\\sample", `C:work\\sample\\${file}`],
    ["win32", "C:\\work\\sample", `\\work\\sample\\${file}`],
    ["win32", "C:\\work\\sample", `\\\\?\\C:\\work\\sample\\${file}`],
    ["win32", "C:\\work\\sample", `\\\\.\\C:\\work\\sample\\${file}`],
    ["win32", "C:\\work\\sample", `C:\\work\\sample\\${file}:ads`],
    ["win32", "\\\\server\\share\\sample", `\\\\server\\other\\sample\\${file}`],
    ["win32", "\\\\server\\share\\sample", `\\\\Server\\share\\sample\\${file}`],
    ["win32", "\\\\server", file], ["unknown", "/work/sample", file],
  ];
  for (const [platform, sourceRoot, name] of invalid) assert.throws(() => normalizeReportTestPath({ platform: platform as "linux", sourceRoot: sourceRoot!, name: name!, expectedFiles: DOGFOOD_TEST_FILES }), { code: "INVALID_INPUT" }, JSON.stringify([platform, sourceRoot, name]));
  const s = await snapshot(); const b = syntheticBaseline(s); const r = syntheticReport();
  r.testResults.forEach(f => { f.name = "C:\\work\\sample\\" + f.name.slice("/work/sample/".length).replaceAll("/", "\\"); });
  assert.equal(assessReport(await parseBaselineBundle(bundleBytes(withReport({ ...b, platform: "win32", sourceRoot: "C:\\work\\sample", reportPath: "C:\\results\\vitest.json", argv: [...b.argv.slice(0, -1), "--outputFile=C:\\results\\vitest.json"] }, r)), s), profile).status, "passed");
});

test("sanitizes bounded UTF-8 logs while binding original bytes and owning input", async () => {
  const s = await snapshot(); const b = syntheticBaseline(s);
  const bytes = bundleBytes({ ...b, log: "\u001b[31mred\u001b[0m\u0000\b\t\n" + "한".repeat(30_000) });
  const pending = parseBaselineBundle(bytes, s); bytes.fill(0);
  const e = await pending;
  assert.equal(e.safeLog.slice(0, 5), "red\t\n");
  assert.ok(new TextEncoder().encode(e.safeLog).length <= 65536);
  assert.ok(!e.safeLog.includes("\ufffd")); assert.equal(e.logTruncated, true);
  const first = await parseBaselineBundle(bundleBytes({ ...b, log: "\u001b[31mhello" }), s);
  const second = await parseBaselineBundle(bundleBytes({ ...b, log: "hello" }), s);
  assert.equal(first.safeLog, second.safeLog); assert.notEqual(first.evidenceDigest, second.evidenceDigest);
  const padded = await parseBaselineBundle(new TextEncoder().encode(" " + JSON.stringify(b)), s);
  assert.notEqual(padded.evidenceDigest, (await parseBaselineBundle(bundleBytes(b), s)).evidenceDigest);
});

test("portable dogfood source never imports Node or local adapters", () => {
  for (const file of readdirSync(new URL("../src", import.meta.url)).filter(f => f.endsWith(".ts"))) {
    const text = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(text, /(?:from\s+|import\s*\()(["'])(?:node:|@app-ops\/(?:db|runner-protocol))|\b(?:Buffer|process)\b/);
  }
});

test("rejects repeated root separators instead of silently repairing metadata", async () => {
  const s = await snapshot(); const b = syntheticBaseline(s);
  for (const [platform, sourceRoot] of [["linux", "//"], ["darwin", "//"], ["win32", "C://"], ["win32", "//server/share//"]] as const) {
    await assert.rejects(parseBaselineBundle(bundleBytes({ ...b, platform, sourceRoot, reportPath: "report.json", argv: [...b.argv.slice(0, -1), "--outputFile=report.json"] }), s), { code: "INVALID_INPUT" });
  }
});

test("accepts ISO offset timestamps and nanoseconds while rejecting impossible dates", async () => {
  const s = await snapshot(); const b = syntheticBaseline(s);
  for (const [startedAt, finishedAt] of [["2026-01-02T08:36:00.000000001+05:30", "2026-01-02T08:36:01.000000001+05:30"], ["2026-01-01T22:06:00-05:00", "2026-01-01T22:06:01-05:00"]]) {
    assert.equal(assessReport(await parseBaselineBundle(bundleBytes({ ...b, startedAt, finishedAt }), s), profile).status, "passed");
  }
  for (const startedAt of ["2026-02-30T03:06:00Z", "2026-01-02T24:06:00Z", "2026-01-02T03:06:00+24:00", "2026-01-02T03:06:00.000000002Z"]) {
    const finishedAt = startedAt === "2026-01-02T03:06:00.000000002Z" ? "2026-01-02T03:06:00.000000001Z" : b.finishedAt;
    await assert.rejects(parseBaselineBundle(bundleBytes({ ...b, startedAt, finishedAt }), s), { code: "INVALID_INPUT" });
  }
});

for (const [label, status] of [["object", { toString: null }], ["nested array", [[{ toString: null }]]]] as const) {
  test(`malformed ${label} assertion status is invalid data without coercion`, async () => {
    const s = await snapshot(); const report = syntheticReport();
    Object.assign(report.testResults[0]!.assertionResults[0]!, { status });
    const evidence = await parseBaselineBundle(bundleBytes(withReport(syntheticBaseline(s), report)), s);
    assert.equal(assessReport(evidence, profile).status, "invalid");
  });
}
