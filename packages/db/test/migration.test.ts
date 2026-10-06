import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as store from "@app-ops/db";
import { resolveSnapshot } from "@app-ops/config";
import { catalog, target, source } from "../../../tests/fixtures.ts";
import { setup } from "./support.ts";
test("migration is idempotent and checks its checksum", () => {
  const db = store.openDatabase(":memory:");
  try {
    store.migrate(db);
    store.migrate(db);
    assert.equal(
      (
        db.prepare("select count(*) as n from schema_migrations").get() as {
          n: number;
        }
      ).n,
      1,
    );
    db.prepare("update schema_migrations set checksum=?").run("bad");
    assert.throws(() => store.migrate(db), { code: "MIGRATION_MISMATCH" });
  } finally {
    db.close();
  }
});
test("catalog rejects cross-app target and retains immutable identity", async () => {
  const { db } = await setup();
  try {
    assert.throws(
      () =>
        store.saveTarget(db, {
          ...target,
          id: "target_other",
          flavorId: "other",
        }),
      { code: "INVALID_RELATION" },
    );
    assert.throws(
      () => store.saveTarget(db, { ...target, id: "duplicate_target" }),
      { code: "CONFLICT" },
    );
    store.saveTarget(db, target);
    assert.throws(
      () => store.saveTarget(db, { ...target, platform: "android" }),
      { code: "CONFLICT" },
    );
  } finally {
    db.close();
  }
});
test("snapshot and source are immutable and digest is revalidated", async () => {
  const { db, snapshot } = await setup();
  try {
    await assert.rejects(
      () => store.saveSnapshot(db, { ...snapshot, digest: "c".repeat(64) }),
      { code: "INVALID_INPUT" },
    );
    assert.throws(() =>
      db.prepare("update config_snapshots set data=?").run("{}"),
    );
    assert.throws(() => db.exec("delete from config_snapshots"));
    assert.throws(() => db.exec("delete from source_revisions"));
    assert.throws(
      () =>
        store.createRelease(db, {
          id: "release_other",
          organizationId: "org_demo",
          applicationId: "app_other",
          sourceRevisionId: "source_demo",
          version: "1",
          createdBy: "user_demo",
        }),
      { code: "INVALID_RELATION" },
    );
  } finally {
    db.close();
  }
});
test("source and snapshot persist across reopening the database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "platform-db-"));
  try {
    const path = join(dir, "state.db");
    const { db, snapshot } = await setup(path);
    db.close();
    const again = store.openDatabase(path);
    try {
      store.migrate(again);
      assert.equal(
        (
          again.prepare("PRAGMA recursive_triggers").get() as {
            recursive_triggers: number;
          }
        ).recursive_triggers,
        1,
      );
      assert.equal(
        (
          again
            .prepare("select digest from config_snapshots where id=?")
            .get(snapshot.id) as { digest: string }
        ).digest,
        snapshot.digest,
      );
    } finally {
      again.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("REPLACE cannot bypass immutable source and snapshot triggers", async () => {
  const { db, snapshot } = await setup();
  try {
    assert.throws(() =>
      db
        .prepare(
          "INSERT OR REPLACE INTO source_revisions(org_id,id,app_id,data) VALUES(?,?,?,?)",
        )
        .run("org_demo", "source_demo", "app_demo", "{}"),
    );
    assert.throws(() =>
      db
        .prepare(
          "INSERT OR REPLACE INTO config_snapshots(org_id,id,app_id,target_id,source_id,digest,data) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          "org_demo",
          snapshot.id,
          "app_demo",
          "target_demo",
          "source_demo",
          "tampered",
          "{}",
        ),
    );
  } finally {
    db.close();
  }
});
test("source storage validates before reading accessor properties", async () => {
  const { db } = await setup();
  try {
    let invoked = 0;
    const input = Object.defineProperty({ ...source }, "organizationId", {
      get() {
        invoked++;
        return "org_demo";
      },
      enumerable: true,
    });
    assert.throws(() => store.saveSource(db, input), { code: "INVALID_INPUT" });
    assert.equal(invoked, 0);
  } finally {
    db.close();
  }
});
