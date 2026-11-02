import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listNativeArtifacts, inspectNativeArtifact, exportNativeArtifact } from "../dist/native-artifact-access.js";

const posix = { skip: process.platform === "win32", timeout: 10000 };
async function fixture(t: TestContext, bytes = Buffer.from("synthetic unsigned native output")) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flora-native-output-")));
  await chmod(root, 0o700); t.after(() => rm(root, { recursive: true, force: true }));
  const store = join(root, "artifacts"), out = join(root, "export");
  await mkdir(store, {mode: 0o700}); await mkdir(out, {mode: 0o700});
  const config = {appId: "app_fixture", platform: "android" as const, artifactDirectory: store, expectedCertificateSha256: "b".repeat(64)};
  const fileName = "native_job_fixture.apk", source = join(store, fileName), receiptPath = source + ".receipt.json";
  const receipt = {jobId: "native_job_fixture", appId: config.appId, commitSha: "a".repeat(40), fileName,
    sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length, appIdentifier: "test.flora.app",
    platform: "android", signerFingerprint: config.expectedCertificateSha256, completionConfirmed: true};
  await writeFile(source, bytes, {mode: 0o600}); await writeFile(receiptPath, JSON.stringify(receipt), {mode: 0o600});
  return {root, store, out, config, fileName, source, receiptPath, receipt, bytes,
    save: (value: unknown) => writeFile(receiptPath, JSON.stringify(value), {mode: 0o600})};
}

test("catalogue reports historical metadata without inventing fresh signature or integrity proof", posix, async t => {
  const f = await fixture(t); const report = await listNativeArtifacts(f.config);
  assert.equal(report.state, "native_artifacts"); assert.equal(report.appId, f.config.appId);
  assert.equal(report.records.length, 1); assert.equal(report.records[0]!.fileName, f.fileName);
  assert.equal(report.records[0]!.integrityVerified, false); assert.equal(report.records[0]!.completionRecorded, true);
  assert.equal(report.records[0]!.signatureRechecked, false); assert.equal(report.remoteRechecked, false);
  assert.equal(report.truncated, false); assert.equal(report.recoveryRequired, false);
  assert.ok(!JSON.stringify(report).includes(f.root));
});
test("missing store is an explicit read-only empty observation, never created", posix, async t => {
  const f = await fixture(t), missing = join(f.root, "absent");
  const result = await listNativeArtifacts({...f.config, artifactDirectory: missing});
  assert.equal(result.storePresent, false); assert.deepEqual(result.records, []);
  await assert.rejects(lstat(missing), {code: "ENOENT"});
});
test("pending and interrupted output remains visible and byte-identical without reading private marker contents", posix, async t => {
  const f = await fixture(t); await f.save({...f.receipt, completionConfirmed: false});
  await mkdir(join(f.store, ".pending"), {mode: 0o700}); await writeFile(join(f.store, ".pending", "PRIVATE_TOKEN"), "SECRET_LEASE");
  await mkdir(join(f.store, ".native-123"), {mode: 0o700}); const before = await readFile(f.receiptPath);
  const result = await listNativeArtifacts(f.config);
  assert.equal(result.recoveryRequired, true); assert.equal(result.pendingEntries, 1); assert.equal(result.interruptedDirectories, 1);
  assert.equal(result.records[0]!.completionRecorded, false); assert.ok(!JSON.stringify(result).includes("PRIVATE_TOKEN"));
  assert.deepEqual(await readFile(f.receiptPath), before); assert.equal(await readFile(join(f.store, ".pending", "PRIVATE_TOKEN"), "utf8"), "SECRET_LEASE");
});
for (const [field, value] of [["appId", "app_other"], ["platform", "ios"], ["fileName", "native_job_other.apk"], ["jobId", "native_job_other"], ["signerFingerprint", "c".repeat(64)]] as const) {
  test(`foreign or mismatched receipt ${field} cannot authorize inspection or export`, posix, async t => {
    const f = await fixture(t); await f.save({...f.receipt, [field]: value});
    const report = await listNativeArtifacts(f.config); assert.equal(report.records.length, 0); assert.equal(report.recoveryRequired, true);
    await assert.rejects(inspectNativeArtifact(f.config, f.fileName), /NATIVE_ARTIFACT_(SCOPE_MISMATCH|RECEIPT_INVALID)/);
    await assert.rejects(exportNativeArtifact(f.config, f.fileName, join(f.out, "copy.apk")), /NATIVE_ARTIFACT_(SCOPE_MISMATCH|RECEIPT_INVALID)/);
    assert.deepEqual(await readdir(f.out), []);
  });
}
for (const patch of [{byteLength: 0}, {byteLength: 512*1024*1024+1}, {sha256: "z".repeat(64)}, {completionConfirmed: "true"}, {commitSha: "a".repeat(40)+"\n"}, {appIdentifier: "PRIVATE\nTOKEN"}, {password: "PRIVATE_TOKEN"}]) {
  test(`malformed receipt ${Object.keys(patch)[0]} fails closed with fixed diagnostics`, posix, async t => {
    const f = await fixture(t); await f.save({...f.receipt, ...patch});
    await assert.rejects(inspectNativeArtifact(f.config, f.fileName), /^Error: NATIVE_ARTIFACT_RECEIPT_INVALID$/);
    const report = await listNativeArtifacts(f.config); assert.equal(report.recoveryRequired, true); assert.ok(!JSON.stringify(report).includes("PRIVATE_TOKEN"));
  });
}
test("unconfirmed completion cannot export bytes even when their hash matches", posix, async t => {
  const f = await fixture(t); await f.save({...f.receipt, completionConfirmed: false});
  await assert.rejects(exportNativeArtifact(f.config, f.fileName, join(f.out, "copy.apk")), /NATIVE_ARTIFACT_UNCONFIRMED/);
  assert.deepEqual(await readdir(f.out), []);
});
test("inspection and no-replace export verify the same source bytes and preserve all originals", posix, async t => {
  const f = await fixture(t, Buffer.alloc(2*1024*1024+11, 0x5a)), original = await readFile(f.receiptPath);
  const inspected = await inspectNativeArtifact(f.config, f.fileName);
  assert.equal(inspected.state, "native_artifact_inspected"); assert.equal(inspected.integrityVerified, true);
  assert.equal(inspected.signatureRechecked, false); assert.equal(inspected.installVerified, false);
  const target = join(f.out, "copy.apk"), exported = await exportNativeArtifact(f.config, f.fileName, target);
  assert.equal(exported.state, "native_artifact_exported"); assert.equal(exported.sha256, f.receipt.sha256); assert.equal(exported.exported, true);
  assert.ok(!JSON.stringify(exported).includes(f.root)); assert.deepEqual(await readFile(target), f.bytes);
  assert.equal((await lstat(target)).mode & 0o777, 0o600); assert.equal((await lstat(target)).nlink, 1);
  assert.deepEqual(await readFile(f.source), f.bytes); assert.deepEqual(await readFile(f.receiptPath), original);
  assert.deepEqual(await readdir(f.out), ["copy.apk"]);
});
for (const sameLength of [true, false]) test(`tampered source ${sameLength ? "same" : "different"} size never becomes an exported file`, posix, async t => {
  const f = await fixture(t); await writeFile(f.source, Buffer.alloc(f.bytes.length+(sameLength?0:1), 0x71));
  await assert.rejects(exportNativeArtifact(f.config, f.fileName, join(f.out, "copy.apk")), /NATIVE_ARTIFACT_(HASH_MISMATCH|CHANGED)/);
  assert.deepEqual(await readdir(f.out), []);
});
test("existing export target and a dangling target symlink are never replaced", posix, async t => {
  const f = await fixture(t), target = join(f.out, "copy.apk"); await writeFile(target, "EXISTING_PRIVATE_FILE", {mode: 0o600});
  await assert.rejects(exportNativeArtifact(f.config, f.fileName, target), /NATIVE_EXPORT_EXISTS/);
  assert.equal(await readFile(target, "utf8"), "EXISTING_PRIVATE_FILE"); await rm(target); await symlink(join(f.out, "missing"), target);
  await assert.rejects(exportNativeArtifact(f.config, f.fileName, target), /NATIVE_EXPORT_EXISTS/); assert.ok((await lstat(target)).isSymbolicLink());
});
for (const which of ["source", "receiptPath"] as const) for (const attack of ["symlink", "hardlink", "shared", "fifo"] as const) {
  test(`${which} ${attack} is refused without following or blocking`, posix, async t => {
    const f = await fixture(t), path = f[which];
    if (attack === "shared") await chmod(path, 0o644);
    else if (attack === "hardlink") await link(path, join(f.root, "alias"));
    else { await rm(path); if (attack === "fifo") execFileSync("mkfifo", ["-m", "600", path]); else await symlink(join(f.root, "private-missing"), path); }
    await assert.rejects(inspectNativeArtifact(f.config, f.fileName), /NATIVE_ARTIFACT_(FILE_UNSAFE|NOT_FOUND)/);
  });
}
test("source directory and output parent must be canonical private directories", posix, async t => {
  const f = await fixture(t); await chmod(f.store, 0o755);
  await assert.rejects(listNativeArtifacts(f.config), /NATIVE_ARTIFACT_STORE_UNSAFE/); await chmod(f.store, 0o700);
  const alias = join(f.root, "alias"); await symlink(f.store, alias);
  await assert.rejects(inspectNativeArtifact({...f.config, artifactDirectory: alias}, f.fileName), /NATIVE_ARTIFACT_STORE_UNSAFE/);
  await chmod(f.out, 0o755); await assert.rejects(exportNativeArtifact(f.config, f.fileName, join(f.out, "copy.apk")), /NATIVE_EXPORT_PARENT_UNSAFE/);
  assert.equal((await lstat(f.out)).mode & 0o777, 0o755);
});
test("invalid names, relative destinations and extension changes reject before file reads", posix, async t => {
  const f = await fixture(t);
  for (const name of ["../private.apk", "/secret.apk", "native_job_fixture.apk\n", "native_job_fixture.ipa", "__proto__", "native_job_fixture.apk/other"]) {
    await assert.rejects(inspectNativeArtifact(f.config, name), /NATIVE_ARTIFACT_NAME_INVALID/);
  }
  for (const target of ["relative.apk", join(f.out, "copy.ipa"), join(f.out, "copy.apk\n")]) {
    await assert.rejects(exportNativeArtifact(f.config, f.fileName, target), /NATIVE_EXPORT_PATH_INVALID/);
  }
});
test("pre-cancelled inspection and export read nothing and expose no cancellation reason", posix, async t => {
  const f = await fixture(t), abort = new AbortController(); abort.abort("PRIVATE_REASON");
  await assert.rejects(inspectNativeArtifact(f.config, f.fileName, abort.signal), /^Error: NATIVE_CANCELLED$/);
  await assert.rejects(exportNativeArtifact(f.config, f.fileName, join(f.out, "copy.apk"), abort.signal), /^Error: NATIVE_CANCELLED$/);
  assert.deepEqual(await readdir(f.out), []);
});
test("cancellation after temporary output creation removes only its partial copy", posix, async t => {
  const f = await fixture(t, Buffer.alloc(8*1024*1024, 0x5a)), abort = new AbortController();
  const watcher = watch(f.out, (_event, name) => { if (name?.toString().endsWith(".partial")) abort.abort(); });
  t.after(() => watcher.close());
  await assert.rejects(exportNativeArtifact(f.config, f.fileName, join(f.out, "copy.apk"), abort.signal), /NATIVE_CANCELLED/);
  assert.deepEqual(await readdir(f.out), []); assert.deepEqual(await readFile(f.source), f.bytes);
});
test("catalogue truncation is explicit and unknown entry names are never serialized", posix, async t => {
  const f = await fixture(t); for (let n = 0; n < 1030; n++) await writeFile(join(f.store, `PRIVATE_SECRET_${n}`), "private");
  const report = await listNativeArtifacts(f.config);
  assert.equal(report.truncated, true); assert.equal(report.recoveryRequired, true); assert.ok(report.scannedEntries <= 1024);
  assert.ok(!JSON.stringify(report).includes("PRIVATE_SECRET"));
});
test("oversized and invalid UTF-8 receipts are rejected before projection", posix, async t => {
  const f = await fixture(t); await writeFile(f.receiptPath, Buffer.alloc(131073, 0x20));
  await assert.rejects(inspectNativeArtifact(f.config, f.fileName), /NATIVE_ARTIFACT_RECEIPT_INVALID/);
  await writeFile(f.receiptPath, Buffer.concat([Buffer.from(JSON.stringify({...f.receipt, sourceEntitlements: ""}).slice(0,-2)), Buffer.from([0xff]), Buffer.from('"}') ]));
  await assert.rejects(inspectNativeArtifact(f.config, f.fileName), /NATIVE_ARTIFACT_RECEIPT_INVALID/);
});
test("Windows filesystem operations explicitly refuse rather than pretending POSIX privacy", {skip: process.platform !== "win32"}, async () => {
  await assert.rejects(listNativeArtifacts({appId: "app_fixture", platform: "android", artifactDirectory: "C:\\private", expectedCertificateSha256: "b".repeat(64)}), /NATIVE_ARTIFACT_PLATFORM_UNSUPPORTED/);
});

test("two concurrent exports grant exactly one no-replace publication", posix, async t => {
  const f = await fixture(t, Buffer.alloc(1024*1024, 0x53)), target = join(f.out, "copy.apk");
  const attempts = await Promise.allSettled([exportNativeArtifact(f.config, f.fileName, target), exportNativeArtifact(f.config, f.fileName, target)]);
  assert.equal(attempts.filter(r => r.status === "fulfilled").length, 1);
  assert.match(String(attempts.find(r => r.status === "rejected")!.reason), /NATIVE_EXPORT_EXISTS/);
  assert.deepEqual(await readFile(target), f.bytes); assert.deepEqual(await readdir(f.out), ["copy.apk"]);
});
test("receipt mutation during copying refuses publication without rewriting the changed record", posix, async t => {
  const f = await fixture(t, Buffer.alloc(16*1024*1024, 0x51)); let changed = false; let writing: Promise<unknown> = Promise.resolve();
  const watcher = watch(f.out, (_event, name) => {if (!changed && name?.toString().endsWith(".partial")) {changed = true; writing = f.save({...f.receipt, completionConfirmed: false});}});
  t.after(() => watcher.close());
  await assert.rejects(exportNativeArtifact(f.config, f.fileName, join(f.out, "copy.apk")), /NATIVE_ARTIFACT_CHANGED/);
  await writing; assert.equal(changed, true); assert.deepEqual(await readdir(f.out), []);
  assert.equal(JSON.parse(await readFile(f.receiptPath, "utf8")).completionConfirmed, false);
});
test("iOS and AAB receipts retain their format without claiming newly verified code signatures", posix, async t => {
  for (const [platform, extension] of [["ios", "ipa"], ["android", "aab"]] as const) {
    const f = await fixture(t), fileName = `native_job_fixture.${extension}`;
    await writeFile(join(f.store, fileName), f.bytes, {mode: 0o600});
    await writeFile(join(f.store, fileName + ".receipt.json"), JSON.stringify({...f.receipt, fileName, platform, ...(platform === "ios" ? {teamId:"ABC1234567",sourceEntitlements:{values:{PRIVATE_VALUE:"SECRET"}}} : {})}), {mode: 0o600});
    const result = await inspectNativeArtifact({...f.config, platform}, fileName);
    assert.equal(result.integrityVerified, true); assert.equal(result.signatureRechecked, false); assert.ok(!JSON.stringify(result).includes("SECRET"));
  }
});
test("catalogue record cap cannot masquerade as a complete healthy inventory", posix, async t => {
  const f = await fixture(t);
  for (let n = 0; n < 201; n++) {
    const jobId = "native_job_extra_" + n, fileName = jobId + ".apk";
    await writeFile(join(f.store,fileName),f.bytes,{mode:0o600});
    await writeFile(join(f.store,fileName+".receipt.json"),JSON.stringify({...f.receipt,jobId,fileName}),{mode:0o600});
  }
  const result = await listNativeArtifacts(f.config); assert.equal(result.records.length,200); assert.equal(result.truncated,true); assert.equal(result.recoveryRequired,true);
  assert.equal((await inspectNativeArtifact(f.config, f.fileName)).integrityVerified,true);
});

test("a temporary-name collision never deletes a file this export did not create", posix, async t => {
  const f = await fixture(t), crypto = (await import("node:crypto")).default;
  const {syncBuiltinESMExports} = await import("node:module");
  const id = "00000000-0000-4000-8000-000000000000" as const;
  const collision = join(f.out, `.flora-export-${id}.partial`); await writeFile(collision, "EXISTING_TEMPORARY_FILE", {mode: 0o600});
  const mocked = t.mock.method(crypto, "randomUUID", () => id); syncBuiltinESMExports();
  try {
    await assert.rejects(exportNativeArtifact(f.config, f.fileName, join(f.out, "copy.apk")), /NATIVE_ARTIFACT_IO_FAILED/);
    assert.equal(await readFile(collision, "utf8"), "EXISTING_TEMPORARY_FILE");
  } finally {mocked.mock.restore(); syncBuiltinESMExports();}
});

test("a replaced temporary pathname is neither published nor deleted as our copy", posix, async t => {
  const f = await fixture(t, Buffer.alloc(16*1024*1024, 0x4b)); let replaced: string | undefined; let replacing: Promise<unknown> = Promise.resolve();
  const watcher = watch(f.out, (_event, name) => {
    if (!replaced && name?.toString().endsWith(".partial")) {
      replaced = join(f.out, name.toString()); const path = replaced;
      replacing = rm(path).then(() => writeFile(path, "FOREIGN_REPLACEMENT", {mode: 0o600}));
    }
  }); t.after(() => watcher.close());
  await assert.rejects(exportNativeArtifact(f.config, f.fileName, join(f.out, "copy.apk")), /NATIVE_ARTIFACT_CHANGED/);
  await replacing; assert.ok(replaced); assert.equal(await readFile(replaced,"utf8"),"FOREIGN_REPLACEMENT");
  await assert.rejects(lstat(join(f.out,"copy.apk")), {code:"ENOENT"});
});
