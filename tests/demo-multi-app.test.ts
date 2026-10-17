import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { runCli } from "@app-ops/cli";
import { openDatabase } from "@app-ops/db";
import { runDogfoodDemo } from "../scripts/dogfood-demo.mjs";

test("synthetic demo refuses an unrelated registered app without injecting demo data", async t => {
  const directory = await mkdtemp(join(await realpath(os.tmpdir()), "flora-demo-multi-"));
  const previousMask = process.umask(0o077);
  t.mock.method(os, "homedir", () => directory);
  try {
    const registration = join(directory, "registration.json");
    await writeFile(registration, JSON.stringify({ name: "Real app placeholder", repositoryId: "unrelated-repository", rootDirectory: "." }));
    let output = "", errors = "";
    assert.equal(await runCli(["dogfood", "register-app", "--file", registration], { stdout: value => { output += value; }, stderr: value => { errors += value; }, readFile: async () => { throw new Error("legacy reader"); } }), 0, errors);
    const registered = JSON.parse(output), path = join(directory, ".flora", "dogfood", "state.db");
    await assert.rejects(runDogfoodDemo(path), /CONFLICT/);
    const db = openDatabase(path);
    try {
      assert.deepEqual(db.prepare("SELECT app_id FROM managed_applications").all().map(row => row.app_id), [registered.id]);
      assert.equal(db.prepare("SELECT count(*) n FROM inventory_snapshots").get()!.n, 0);
      assert.equal(db.prepare("SELECT count(*) n FROM verification_records").get()!.n, 0);
    } finally { db.close(); }
  } finally { process.umask(previousMask); await rm(directory, { recursive: true, force: true }); }
});
