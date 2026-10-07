import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeEvidence, decodeEvidence, LIMITS } from "../scripts/dashboard-qa/evidence.mjs";
import { createQaHarness } from "../scripts/dashboard-qa/server.mjs";
import { navigateBootstrapDocument } from "../scripts/dashboard-qa/navigation.mjs";

const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
const commit = "a".repeat(40);
function evidence() { return [{ name: "synthetic-desktop-empty.png", bytes: png }, { name: "synthetic-evidence.json", bytes: Buffer.from('{"syntheticOnly":true}') }]; }

test("render evidence roundtrips through timestamped log lines with bounded chunks and exact hashes", () => {
  const lines = encodeEvidence(evidence(), commit); assert.ok(lines.every(line => line.length <= LIMITS.lineBytes));
  const result = decodeEvidence(lines.map(line => "2026-01-01T00:00:00Z " + line).join("\n"), commit);
  assert.equal(result.commit, commit); assert.equal(result.files.length, 2); assert.deepEqual(result.files[0]!.bytes, png);
});

test("evidence decoder rejects incomplete, duplicate, tampered, oversized and wrong-commit logs", () => {
  const lines = encodeEvidence(evidence(), commit);
  const invalid = [lines.slice(0, -1), [...lines, lines.at(-1)!], lines.filter(line => !line.includes('"index":0')), lines.map(line => line.replace('iVBOR', 'jVBOR')), [...lines.slice(0, 2), lines[1]!, ...lines.slice(2)]];
  for (const log of invalid) assert.throws(() => decodeEvidence(log.join("\n"), commit));
  assert.throws(() => decodeEvidence(lines.join("\n"), "b".repeat(40)));
  assert.throws(() => decodeEvidence("x".repeat(LIMITS.logBytes + 1), commit));
});

test("evidence encoder accepts only synthetic bounded image/summary names without traversal", () => {
  for (const name of ["../leak.png", "private.png", "synthetic-a.svg", "synthetic-a/b.png", "synthetic-__proto__.json"]) assert.throws(() => encodeEvidence([{ name, bytes: png }], commit));
  assert.throws(() => encodeEvidence([{ name: "synthetic-large.png", bytes: Buffer.alloc(LIMITS.fileBytes + 1) }], commit));
  assert.throws(() => encodeEvidence([...evidence(), evidence()[0]!], commit));
});

test("QA harness starts an empty authenticated loopback fixture and creates only a synthetic queued record", async () => {
  const harness = await createQaHarness();
  try {
    assert.match(harness.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await fetch(harness.origin + "/api/state")).status, 401);
    assert.equal((await harness.state()).snapshots.length, 0);
    const session = await fetch(harness.origin + "/api/session", { method: "POST", headers: { Origin: harness.origin, "Content-Type": "application/json" }, body: JSON.stringify({ bootstrap: new URL(harness.bootstrapUrl).hash.slice(1) }) });
    const csrf = (await session.json() as { csrfToken: string }).csrfToken;
    const headers = { Origin: harness.origin, Cookie: session.headers.get("set-cookie")!.split(";")[0]!, "Content-Type": "application/json", "X-Flora-CSRF": csrf };
    const source = await fetch(harness.origin + "/api/sources", { method: "POST", headers, body: JSON.stringify(harness.source()) });
    assert.equal(source.status, 201);
    const baseline = await fetch(harness.origin + "/api/baselines?snapshotId=" + (await harness.state()).selectedSnapshotId, { method: "POST", headers, body: JSON.stringify(await harness.baseline()) }); assert.equal(baseline.status, 201);
    const queued = await harness.seedQueued(); assert.equal(queued.state, "queued"); assert.equal(queued.evidence, null);
    const state = await harness.state(); assert.ok(state.providers.every(provider => Object.values(provider.checks).every(check => check === "unknown")));
  } finally { await harness.close(); }
});

test("render workflow is public standard Linux only, sandboxed, bounded and has no artifact upload", () => {
  const workflow = readFileSync(new URL("../.github/workflows/dashboard-rendered.yml", import.meta.url), "utf8");
  assert.match(workflow, /runs-on: ubuntu-22\.04/); assert.match(workflow, /timeout-minutes: 10/); assert.match(workflow, /github.event.repository.private == false/);
  assert.match(workflow, /verify\/flora-dogfood-\*/); assert.match(workflow, /contents: read/); assert.match(workflow, /persist-credentials: false/);
  assert.ok(!/upload-artifact|runs-on:.*self-hosted|secrets\.|sudo|sysctl|apparmor|pull_request_target/.test(workflow));
  const capture = readFileSync(new URL("../scripts/dashboard-qa/capture.mjs", import.meta.url), "utf8");
  assert.match(capture, /chromiumSandbox: true/); assert.match(capture, /channel: "chrome"/); assert.match(capture, /route.abort\(/);
  assert.ok(!/console\.(?:log|error)\(error\)|bypassCSP:\s*true|args:\s*\[/.test(capture));
});

test("evidence total-file and total-byte ceilings fail before anything can be emitted", () => {
  assert.throws(() => encodeEvidence(Array.from({ length: LIMITS.files + 1 }, (_, index) => ({ name: `synthetic-${index}.png`, bytes: png })), commit));
  const large = Buffer.alloc(LIMITS.fileBytes); png.copy(large);
  assert.throws(() => encodeEvidence(Array.from({ length: 9 }, (_, index) => ({ name: `synthetic-${index}.png`, bytes: large })), commit));
});

for (const aliased of [false, true]) test(`private decoder rejects invalid evidence and contains verified files from ${aliased ? "an aliased" : "a direct"} working directory`, () => {
  const temporary = mkdtempSync(join(tmpdir(), "flora-qa-decoder-"));
  const physical = join(temporary, "physical"); mkdirSync(physical);
  const directory = aliased ? join(temporary, "alias") : physical;
  if (aliased) symlinkSync(physical, directory, process.platform === "win32" ? "junction" : "dir");
  const decoder = fileURLToPath(new URL("../scripts/dashboard-qa/decode.mjs", import.meta.url));
  const log = join(directory, "job.log");
  try {
    writeFileSync(log, "truncated log");
    assert.throws(() => execFileSync(process.execPath, [decoder, log, commit], { cwd: directory, stdio: "pipe" }));
    assert.equal(existsSync(join(directory, ".superpowers")), false);
    writeFileSync(log, encodeEvidence(evidence(), commit).join("\n"));
    const decoded = JSON.parse(execFileSync(process.execPath, [decoder, log, commit], { cwd: directory, encoding: "utf8" }));
    assert.equal(decoded.verifiedCommit, commit); assert.equal(decoded.files, 2);
    // Child cwd may canonicalize aliases such as macOS /var -> /private/var.
    assert.equal(realpathSync(dirname(decoded.privateDirectory)), realpathSync(join(directory, ".superpowers")));
    const output = join(decoded.privateDirectory, "synthetic-desktop-empty.png"); assert.deepEqual(readFileSync(output), png);
    if (process.platform !== "win32") assert.equal(statSync(output).mode & 0o777, 0o600);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});


test("bootstrap navigation starts a fresh document even when the unauthorized page has the same URL path", async () => {
  let current = "http://127.0.0.1:4567/"; let bootstrapStarts = 0;
  const target = current + "#" + "a".repeat(64); const navigations: string[] = [];
  await navigateBootstrapDocument({ async goto(url, options) {
    assert.equal(options.waitUntil, "domcontentloaded"); navigations.push(url);
    const previous = new URL(current); const next = new URL(url);
    const sameDocument = previous.origin === next.origin && previous.pathname === next.pathname && previous.search === next.search;
    current = url;
    if (!sameDocument && next.hash) bootstrapStarts++;
  } }, target);
  assert.equal(bootstrapStarts, 1, "hash-only navigation cannot restart the rejected session client");
  assert.deepEqual(navigations, ["about:blank", target]); assert.equal(current, target);
  const capture = readFileSync(new URL("../scripts/dashboard-qa/capture.mjs", import.meta.url), "utf8");
  assert.match(capture, /await navigateBootstrapDocument\(page, harness\.bootstrapUrl\)/);
  assert.ok(!capture.includes("page.goto(harness.bootstrapUrl"));
});

test("render gate verifies actual Korean font glyph usage rather than advertised font availability", async () => {
  const { verifyKoreanFontUsage, fontConfiguration } = await import("../scripts/dashboard-qa/fonts.mjs");
  const sample = "앱의 지금을, 근거와 함께";
  const valid = [{ familyName: "Noto Sans CJK KR", postScriptName: "NotoSansCJKkr-Bold", glyphCount: 20, isCustomFont: false }];
  const proof = verifyKoreanFontUsage(valid, sample); assert.ok(proof.koreanCodePoints > 0); assert.deepEqual(proof.fonts, valid);
  for (const fonts of [[], [{ ...valid[0]!, familyName: "Arial" }], [{ ...valid[0]!, glyphCount: 0 }], [{ ...valid[0]!, glyphCount: 1 }], [{ ...valid[0]!, isCustomFont: true }]]) assert.throws(() => verifyKoreanFontUsage(fonts, sample));
  assert.throws(() => verifyKoreanFontUsage(valid, "Latin only"));
  const configuration = fontConfiguration("/tmp/private & fonts");
  assert.ok(configuration.includes("/tmp/private &amp; fonts/package/usr/share/fonts/opentype/noto")); assert.ok(configuration.includes("Noto Sans CJK KR"));
  const setup = readFileSync(new URL("../scripts/dashboard-qa/fonts.sh", import.meta.url), "utf8");
  assert.match(setup, /apt-get download 'fonts-noto-cjk=1:20220127\+repack1-1'/); assert.match(setup, /dpkg-deb --extract/);
  assert.ok(!/sudo|apt-get (?:install|update)|dpkg --install|sysctl|apparmor/.test(setup));
  const capture = readFileSync(new URL("../scripts/dashboard-qa/capture.mjs", import.meta.url), "utf8");
  assert.match(capture, /CSS\.getPlatformFontsForNode/); assert.match(capture, /FONTCONFIG_FILE: fontConfig/);
  assert.ok(!capture.includes("document.fonts.check"));
});
