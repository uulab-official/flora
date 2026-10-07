import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runCli } from "@app-ops/cli";
import * as dbapi from "@app-ops/db";
import { bundleBytes, replaceSourceFile, syntheticSourceBundle, syntheticBaseline } from "../../../tests/dogfood-fixtures.ts";

async function fixture(t: TestContext, run: (root: string) => Promise<void>) {
  const mask = process.umask(), root = await fs.mkdtemp(join(await fs.realpath(os.tmpdir()), "flora-cli-"));
  t.mock.method(os, "homedir", () => root);
  try { await run(root); }
  finally { process.umask(mask); await fs.rm(root, { recursive: true, force: true }); }
}
async function cli(args: string[]) {
  let stdout = "", stderr = "";
  const code = await runCli(["dogfood", ...args], {
    stdout: value => { stdout += value; }, stderr: value => { stderr += value; },
    readFile: async () => { throw new Error("Dogfood must not use the legacy reader"); },
  });
  return { code, stdout, stderr };
}
async function source(root: string) {
  const file = join(root, "source.json"); await fs.writeFile(file, bundleBytes(syntheticSourceBundle()));
  const result = await cli(["import-source", "--file", file]); assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout) as { snapshotId: string; digest: string };
}
function dbPath(root: string) { return join(root, ".flora", "dogfood", "state.db"); }

test("dogfood help lists the supported workflow without opening storage", async t => {
  await fixture(t, async root => {
    for (const args of [[], ["--help"]]) {
      const result = await cli(args); assert.equal(result.code, 0); assert.equal(result.stderr, "");
      for (const command of ["serve", "import-source", "import-baseline", "status"]) assert.ok(result.stdout.includes(command));
    }
    assert.deepEqual(await fs.readdir(root), []);
  });
});

test("dogfood rejects malformed flags and bare UUID snapshot identifiers before I/O", async t => {
  await fixture(t, async root => {
    for (const args of [
      ["status"], ["status", "--json", "--unknown"], ["status", "--json", "--json"],
      ["import-source"], ["import-source", "--file", "a", "--file", "b"], ["import-source", "--file", "a", "--db", ""],
      ["import-baseline", "--snapshot", randomUUID(), "--file", "a"],
      ["serve", "--port", "-1"], ["serve", "--port", "65536"], ["serve", "--port", "1.5"], ["serve", "--host", "0.0.0.0"],
    ]) {
      const result = await cli(args); assert.equal(result.code, 2, JSON.stringify(args));
      assert.match(result.stderr, /^USAGE_ERROR\n/); assert.equal(result.stdout, "");
    }
    assert.deepEqual(await fs.readdir(root), []);
  });
});

test("dogfood CLI imports a valid source larger than one MiB using its dedicated reader", async t => {
  await fixture(t, async root => {
    const file = join(root, "synthetic source 경로.json");
    const bytes = bundleBytes(replaceSourceFile(syntheticSourceBundle(), "src/core/config/runtime.ts", "//" + "x".repeat(900_000) + "\n"));
    assert.ok(bytes.length > 1024 * 1024 && bytes.length < 2 * 1024 * 1024);
    await fs.writeFile(file, bytes);
    const imported = await cli(["import-source", "--file", file]); assert.equal(imported.code, 0, imported.stderr);
    const receipt = JSON.parse(imported.stdout);
    assert.match(receipt.snapshotId, /^inventory_[0-9a-f-]{36}$/); assert.match(receipt.digest, /^[0-9a-f]{64}$/);
    assert.equal(receipt.evidenceOrigin, "operator-import");
    assert.equal(receipt.connection, "one-shot-source-snapshot");
    assert.deepEqual(await fs.readFile(file), Buffer.from(bytes));
    const db = dbapi.openDatabase(dbPath(root));
    try { assert.equal(dbapi.listInventory(db).length, 1); }
    finally { db.close(); }
  });
});

test("oversize and malformed source input fail before creating private storage", async t => {
  await fixture(t, async root => {
    const file = join(root, "synthetic-private-input.json");
    await fs.writeFile(file, Buffer.alloc(2 * 1024 * 1024 + 1));
    for (const args of [["import-source", "--file", file], ["import-baseline", "--file", file, "--snapshot", "inventory_" + randomUUID()]]) {
      const result = await cli(args); assert.equal(result.code, 1);
      assert.equal(result.stderr, '{"error":"INPUT_TOO_LARGE"}\n'); assert.equal(result.stdout, "");
      await assert.rejects(fs.lstat(join(root, ".flora")), { code: "ENOENT" });
    }
    for (const value of ['{"private-synthetic-content":true}', '{"broken-private-synthetic-content"']) {
      await fs.writeFile(file, value); const result = await cli(["import-source", "--file", file]);
      assert.equal(result.code, 1); assert.ok(!result.stderr.includes("private-synthetic-content"));
      await assert.rejects(fs.lstat(join(root, ".flora")), { code: "ENOENT" });
    }
  });
});

test("oversize imports leave an existing SQLite database byte-identical", async t => {
  await fixture(t, async root => {
    const receipt = await source(root), before = await fs.readFile(dbPath(root)), file = join(root, "large.json");
    await fs.writeFile(file, Buffer.alloc(2 * 1024 * 1024 + 1));
    for (const args of [["import-source", "--file", file], ["import-baseline", "--snapshot", receipt.snapshotId, "--file", file]]) {
      assert.equal((await cli(args)).stderr, '{"error":"INPUT_TOO_LARGE"}\n');
      assert.deepEqual(await fs.readFile(dbPath(root)), before);
    }
  });
});

test("CLI source and baseline imports preserve opaque IDs and imported evidence through reopen", async t => {
  await fixture(t, async root => {
    const receipt = await source(root), db = dbapi.openDatabase(dbPath(root));
    const snapshot = dbapi.getInventory(db, receipt.snapshotId)!; db.close();
    const file = join(root, "baseline.json"); await fs.writeFile(file, bundleBytes(syntheticBaseline(snapshot)));
    const imported = await cli(["import-baseline", "--snapshot", receipt.snapshotId, "--file", file]);
    assert.equal(imported.code, 0, imported.stderr);
    const verification = JSON.parse(imported.stdout);
    assert.match(verification.verificationId, /^verification_[0-9a-f-]{36}$/);
    assert.equal(verification.state, "passed"); assert.equal(verification.evidenceKind, "development-baseline");
    assert.equal(verification.evidenceOrigin, "operator-import");
    assert.equal(verification.assessment.files, 2); assert.equal(verification.assessment.tests, 4);
    const status = await cli(["status", "--json"]); assert.equal(status.code, 0, status.stderr);
    const state = JSON.parse(status.stdout);
    assert.equal(state.selectedSnapshotId, receipt.snapshotId); assert.equal(state.freshness, "freshness_unknown");
    assert.equal(state.history[0].id, verification.verificationId); assert.equal(state.history[0].evidenceOrigin, "operator-import");
    assert.equal(state.providers.length, 1); assert.equal(state.providers[0].providerId, "unconfigured-isolated-runner");
    assert.ok(Object.values(state.providers[0].checks).every(value => value === "unknown"));
    assert.ok(!status.stdout.includes("bootstrapUrl"));
  });
});

test("CLI imports and status never acquire ownership or recover a live running attempt", async t => {
  await fixture(t, async root => {
    const receipt = await source(root), db = dbapi.openDatabase(dbPath(root)), now = Date.now();
    const record = dbapi.createVerification(db, { snapshotId: receipt.snapshotId, requestKey: "live", now }).record;
    dbapi.beginVerification(db, { recordId: record.id, attemptId: "live", runnerId: "synthetic", now, leaseMs: 30_000 });
    const before = dbapi.getVerification(db, record.id), owner = { nonce: randomUUID(), pid: process.pid, host: os.hostname() };
    dbapi.acquireDashboardOwner(db, owner);
    const ownerBefore = db.prepare("SELECT * FROM dashboard_server_owner").get();
    const file = join(root, "baseline.json"); await fs.writeFile(file, bundleBytes(syntheticBaseline(dbapi.getInventory(db, receipt.snapshotId)!)));
    try {
      for (const args of [["status", "--json"], ["import-source", "--file", join(root, "source.json")], ["import-baseline", "--snapshot", receipt.snapshotId, "--file", file]]) {
        const result = await cli(args); assert.equal(result.code, 0, result.stderr);
        assert.ok(!result.stdout.includes(owner.nonce));
        assert.deepEqual(dbapi.getVerification(db, record.id), before);
        assert.deepEqual(db.prepare("SELECT * FROM dashboard_server_owner").get(), ownerBefore);
      }
    } finally { db.close(); }
  });
});

test("unsafe store errors contain the code only", { skip: process.platform === "win32" }, async t => {
  await fixture(t, async root => {
    const unsafe = join(root, "unsafe-store"); await fs.mkdir(unsafe, { mode: 0o755 }); await fs.chmod(unsafe, 0o755);
    const result = await cli(["status", "--db", join(unsafe, "state.db"), "--json"]);
    assert.equal(result.code, 1); assert.equal(result.stderr, '{"error":"PRIVATE_STORE_UNSAFE"}\n');
    assert.equal(result.stdout, ""); assert.deepEqual(await fs.readdir(unsafe), []);
  });
});

test("the copyable first-use script imports only clearly synthetic examples", async t => {
  await fixture(t, async root => {
    const source = JSON.parse(await fs.readFile(new URL("../../../examples/dogfood-source.synthetic.json", import.meta.url), "utf8"));
    assert.equal(source.repository.fullName, "example/synthetic-app");
    const { runDogfoodDemo } = await import("../../../scripts/dogfood-demo.mjs");
    const result = await runDogfoodDemo();
    assert.equal(result.mode, "synthetic-dogfood-demo");
    assert.equal(result.baselineState, "passed");
    assert.equal(result.files, 2); assert.equal(result.tests, 4);
    assert.equal(result.evidenceOrigin, "operator-import");
    assert.equal(result.isolatedExecution, "not_run");
    await assert.rejects(fs.lstat(dbPath(root)), { code: "ENOENT" });
    const db = dbapi.openDatabase(join(root, ".flora", "dogfood", "demo.db"));
    try { assert.equal(dbapi.listInventory(db).length, 1); }
    finally { db.close(); }
    const realFile = join(root, "separate-synthetic-app.json");
    const second = { ...syntheticSourceBundle(), repository: { id: "another_synthetic_repo", fullName: "example/another-app", visibility: "private" } };
    await fs.writeFile(realFile, bundleBytes(second));
    const imported = await cli(["import-source", "--file", realFile]);
    assert.equal(imported.code, 0, imported.stderr);
    const realStore = dbapi.openDatabase(dbPath(root));
    try { assert.equal(dbapi.listInventory(realStore)[0]!.repository.id, "another_synthetic_repo"); }
    finally { realStore.close(); }
  });
});
