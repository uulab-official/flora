import test from "node:test";
import assert from "node:assert/strict";
import * as core from "@app-ops/core";
import * as config from "@app-ops/config";
import * as store from "@app-ops/db";
import { catalog, target, source } from "./fixtures.ts";

const clone = <T>(v: T): T => structuredClone(v);
const mkEntry = (level: string, extra: Record<string, string> = {}) => ({
  key: "API_URL",
  versionId: "version_one",
  scope: { level, organizationId: "org_demo", ...extra },
  binding: { kind: "CONFIG", value: level },
});
const entries = [
  mkEntry("organization"),
  mkEntry("project", { projectId: "project_demo" }),
  mkEntry("application", { applicationId: "app_demo" }),
  mkEntry("flavor", { applicationId: "app_demo", flavorId: "free" }),
  mkEntry("environment", {
    applicationId: "app_demo",
    environmentId: "production",
  }),
  mkEntry("platform", { applicationId: "app_demo", platform: "ios" }),
  mkEntry("target", {
    applicationId: "app_demo",
    flavorId: "free",
    environmentId: "production",
    platform: "ios",
  }),
];
function* permutations<T>(xs: T[]): Generator<T[]> {
  if (xs.length === 0) {
    yield [];
    return;
  }
  for (let i = 0; i < xs.length; i++)
    for (const rest of permutations(xs.filter((_, j) => i !== j)))
      yield [xs[i]!, ...rest];
}
async function setup() {
  const db = store.openDatabase(":memory:");
  store.migrate(db);
  store.insertCatalog(db, catalog);
  store.saveTarget(db, target);
  store.saveSource(db, source);
  const snapshot = await config.resolveSnapshot({
    target,
    source,
    entries: [],
  });
  await store.saveSnapshot(db, snapshot);
  store.createRelease(db, {
    id: "release_demo",
    organizationId: "org_demo",
    applicationId: "app_demo",
    sourceRevisionId: "source_demo",
    version: "1",
    createdBy: "user_demo",
  });
  return { db, snapshot };
}

test("independent: all 5,040 complete precedence permutations produce identical exact-target snapshot", async () => {
  const expected = await config.resolveSnapshot({ target, source, entries });
  let count = 0;
  for (const input of permutations(entries)) {
    const s = await config.resolveSnapshot({ target, source, entries: input });
    assert.equal(s.digest, expected.digest);
    assert.deepEqual(s.entries[0]?.binding, {
      kind: "CONFIG",
      value: "target",
    });
    count++;
  }
  assert.equal(count, 5040);
  for (let n = 1; n < entries.length; n++) {
    const s = await config.resolveSnapshot({
      target,
      source,
      entries: entries.slice(0, n),
    });
    assert.deepEqual(s.entries[0]?.binding, {
      kind: "CONFIG",
      value: entries[n - 1]!.scope.level,
    });
  }
});

test("independent: kind conflicts never depend on precedence or entry order", async () => {
  const mixed = [
    entries[0]!,
    {
      ...entries[3]!,
      binding: {
        kind: "SECRET",
        organizationId: "org_demo",
        resourceId: "secret_demo",
        versionId: "version_one",
      },
    },
    entries[6]!,
  ];
  for (const input of permutations(mixed))
    await assert.rejects(
      () => config.resolveSnapshot({ target, source, entries: input }),
      { code: "CONFIG_CONFLICT" },
    );
});

test("independent: input mutations during asynchronous hashing cannot mutate snapshots", async () => {
  const t = clone(target),
    s = clone(source),
    e = clone(entries);
  const promise = config.resolveSnapshot({ target: t, source: s, entries: e });
  t.flavorId = "pro";
  s.toolchain.node = "malicious";
  s.commitSha = "d".repeat(40);
  e[6]!.binding.value = "malicious";
  const result = await promise;
  assert.equal(result.target.flavorId, "free");
  assert.equal(result.source.toolchain.node, source.toolchain.node);
  assert.equal(result.source.commitSha, source.commitSha);
  assert.deepEqual(result.entries[0]?.binding, {
    kind: "CONFIG",
    value: "target",
  });
  assert.ok(Object.isFrozen(result.entries[0]!.scope));
  assert.ok(Object.isFrozen(result.entries[0]!.binding));
});

test("independent: source/target/version changes alter digest and reference payloads remain strict", async () => {
  const base = await config.resolveSnapshot({ target, source, entries });
  for (const changed of [
    { target: { ...target, id: "target_new" }, source, entries },
    {
      target,
      source: { ...source, toolchain: { node: "different" } },
      entries,
    },
    {
      target,
      source,
      entries: entries.map((e) => ({ ...e, versionId: "version_two" })),
    },
  ])
    assert.notEqual(
      (await config.resolveSnapshot(changed)).digest,
      base.digest,
    );
  for (const kind of ["SECRET", "FILE", "CREDENTIAL"]) {
    const e = {
      ...entries[0]!,
      binding: {
        kind,
        organizationId: "org_demo",
        resourceId: "secret_demo",
        versionId: "version_one",
      },
    };
    await config.resolveSnapshot({ target, source, entries: [e] });
    for (const bad of ["value", "plaintext", "token", "keyMaterial"])
      assert.throws(
        () =>
          config.parseConfigEntries([
            { ...e, binding: { ...e.binding, [bad]: "SENSITIVE" } },
          ]),
        { code: "INVALID_INPUT" },
      );
    await assert.rejects(
      () =>
        config.resolveSnapshot({
          target,
          source,
          entries: [
            { ...e, binding: { ...e.binding, organizationId: "org_other" } },
          ],
        }),
      { code: "TENANT_MISMATCH" },
    );
  }
});

test("independent: strict shapes reject custom prototypes, accessors, symbols, holes, cycles and hidden keys", () => {
  const getter = Object.defineProperty({}, "x", {
    get() {
      throw Error("getter invoked");
    },
    enumerable: true,
  });
  const hidden = Object.defineProperty({}, "x", { value: 1 });
  const symbol = { [Symbol("bad")]: 1 };
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const bad of [
    Object.create({ x: 1 }),
    getter,
    hidden,
    symbol,
    cycle,
    Object.assign([1], { extra: 1 }),
    [1, , 2],
    JSON.parse('{"x":{"__proto__":1}}'),
  ])
    assert.throws(() => config.canonicalJson(bad), { code: "INVALID_INPUT" });
  assert.throws(() => core.parseTarget({ ...target, extra: "x" }, catalog), {
    code: "INVALID_INPUT",
  });
  assert.throws(
    () =>
      core.parseSourceRevision(
        { ...source, toolchain: { node: "x", bad: () => 1 } },
        target,
      ),
    { code: "INVALID_INPUT" },
  );
  assert.throws(
    () =>
      config.parseConfigEntries([
        { ...entries[0]!, scope: { ...entries[0]!.scope, platform: "ios" } },
      ]),
    { code: "INVALID_INPUT" },
  );
});

test("independent: failed catalog inserts roll back earlier inserts", async () => {
  const { db } = await setup();
  try {
    const bad = clone(catalog);
    bad.organizations.push({ id: "org_new" });
    bad.projects.push({ id: "project_new", organizationId: "org_demo" });
    bad.applications[0]!.projectId = "project_new";
    assert.throws(() => store.insertCatalog(db, bad), { code: "CONFLICT" });
    assert.equal(
      db.prepare("SELECT 1 FROM organizations WHERE id=?").get("org_new"),
      undefined,
    );
    assert.equal(
      db.prepare("SELECT 1 FROM projects WHERE id=?").get("project_new"),
      undefined,
    );
  } finally {
    db.close();
  }
});

test("independent: persisted snapshot must bind byte-identical registered target and source, with no partial references", async () => {
  const { db, snapshot } = await setup();
  try {
    for (const input of [
      { ...snapshot, digest: "f".repeat(64) },
      { ...snapshot, id: "cfg_invalid" },
      { ...snapshot, entries: [entries[0]!] },
    ])
      await assert.rejects(
        () => store.saveSnapshot(db, input as config.ConfigSnapshot),
        { code: "INVALID_INPUT" },
      );
    const unregistered = await config.resolveSnapshot({
      target,
      source: { ...source, commitSha: "c".repeat(40) },
      entries: [],
    });
    await assert.rejects(() => store.saveSnapshot(db, unregistered), {
      code: "INVALID_RELATION",
    });
    assert.equal(
      (
        db.prepare("SELECT count(*) n FROM config_snapshots").get() as {
          n: number;
        }
      ).n,
      1,
    );
    assert.equal(
      (
        db.prepare("SELECT count(*) n FROM snapshot_references").get() as {
          n: number;
        }
      ).n,
      0,
    );
    await store.saveSnapshot(db, snapshot);
    assert.equal(
      (
        db.prepare("SELECT count(*) n FROM config_snapshots").get() as {
          n: number;
        }
      ).n,
      1,
    );
  } finally {
    db.close();
  }
});

test("independent: SQL foreign keys block cross-tenant and cross-app references in every stable provenance layer", async () => {
  const { db, snapshot } = await setup();
  try {
    assert.equal(
      (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number })
        .foreign_keys,
      1,
    );
    assert.throws(() =>
      db
        .prepare("INSERT INTO applications VALUES(?,?,?,?)")
        .run("org_other", "app_evil", "project_demo", "{}"),
    );
    assert.throws(() =>
      db
        .prepare("INSERT INTO flavors VALUES(?,?,?,?)")
        .run("org_other", "flavor_evil", "app_demo", "{}"),
    );
    assert.throws(() =>
      db
        .prepare("INSERT INTO environments VALUES(?,?,?,?)")
        .run("org_other", "env_evil", "app_demo", "{}"),
    );
    assert.throws(
      () =>
        store.saveTarget(db, {
          ...target,
          id: "target_other",
          organizationId: "org_other",
        }),
      { code: "INVALID_RELATION" },
    );
    assert.throws(
      () =>
        store.saveTarget(db, {
          ...target,
          id: "target_other",
          applicationId: "app_other",
        }),
      { code: "INVALID_RELATION" },
    );
    assert.throws(
      () =>
        store.saveSource(db, {
          ...source,
          id: "source_other",
          organizationId: "org_other",
        }),
      { code: "INVALID_RELATION" },
    );
    assert.throws(() =>
      db
        .prepare("INSERT INTO config_snapshots VALUES(?,?,?,?,?,?,?)")
        .run(
          "org_demo",
          "snapshot_bad",
          "app_other",
          target.id,
          source.id,
          snapshot.digest,
          "{}",
        ),
    );
    assert.throws(() =>
      db
        .prepare("INSERT INTO snapshot_references VALUES(?,?,?,?,?,?)")
        .run(
          "org_other",
          snapshot.id,
          "API_KEY",
          "SECRET",
          "resource_demo",
          "version_one",
        ),
    );
    assert.throws(
      () =>
        store.createRelease(db, {
          id: "release_bad",
          organizationId: "org_other",
          applicationId: "app_demo",
          sourceRevisionId: source.id,
          version: "1",
          createdBy: "user_demo",
        }),
      { code: "INVALID_RELATION" },
    );
    assert.throws(
      () =>
        store.createRelease(db, {
          id: "release_bad",
          organizationId: "org_demo",
          applicationId: "app_other",
          sourceRevisionId: source.id,
          version: "1",
          createdBy: "user_demo",
        }),
      { code: "INVALID_RELATION" },
    );
  } finally {
    db.close();
  }
});

test("independent: stable provenance updates and deletes are blocked at SQL layer", async () => {
  const { db } = await setup();
  try {
    for (const table of [
      "platform_targets",
      "source_revisions",
      "config_snapshots",
      "releases",
    ]) {
      assert.throws(() => db.exec(`UPDATE ${table} SET data='{}'`));
      assert.throws(() => db.exec(`DELETE FROM ${table}`));
    }
  } finally {
    db.close();
  }
});

test("independent: REPLACE guards hold for every immutable table on fresh, reopened, and worker connections", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Worker } = await import("node:worker_threads");
  const dir = mkdtempSync(join(tmpdir(), "flora-review-replace-"));
  const path = join(dir, "review.db");
  const tables = [
    "platform_targets",
    "source_revisions",
    "config_snapshots",
    "snapshot_references",
    "releases",
    "job_attempts",
    "artifacts",
    "audit_events",
  ];
  try {
    let db = store.openDatabase(path);
    store.migrate(db);
    store.insertCatalog(db, catalog);
    store.saveTarget(db, target);
    store.saveSource(db, source);
    const snapshot = await config.resolveSnapshot({
      target,
      source,
      entries: [
        {
          ...entries[0]!,
          binding: {
            kind: "SECRET",
            organizationId: "org_demo",
            resourceId: "secret_demo",
            versionId: "version_one",
          },
        },
      ],
    });
    await store.saveSnapshot(db, snapshot);
    store.createRelease(db, {
      id: "release_demo",
      organizationId: "org_demo",
      applicationId: "app_demo",
      sourceRevisionId: "source_demo",
      version: "1",
      createdBy: "user_demo",
    });
    db.prepare(
      "INSERT INTO jobs(org_id,id,release_id,target_id,source_id,snapshot_id,kind,idempotency_key,request_digest,request_data,status) VALUES(?,?,?,?,?,?,'build','key_one','digest','{}','running')",
    ).run(
      "org_demo",
      "job_demo",
      "release_demo",
      target.id,
      source.id,
      snapshot.id,
    );
    db.exec(
      "INSERT INTO job_attempts(org_id,id,job_id,runner_id,fence,expires_at,lease_duration,status,result_digest) VALUES('org_demo','attempt_demo','job_demo','runner_original',1,10000,5000,'success','original')",
    );
    db.prepare("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
      "org_demo",
      "artifact_demo",
      "job_demo",
      "attempt_demo",
      "release_demo",
      target.id,
      source.id,
      snapshot.id,
      "d".repeat(64),
      1,
      "{}",
    );
    db.exec(
      "INSERT INTO audit_events(sequence,org_id,job_id,actor_id,action,at) VALUES(1,'org_demo','job_demo','user_demo','completed',1000)",
    );
    const initial = tables.map((t) =>
      JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()),
    );
    for (let pass = 0; pass < 2; pass++) {
      assert.equal(
        (
          db.prepare("PRAGMA recursive_triggers").get() as {
            recursive_triggers: number;
          }
        ).recursive_triggers,
        1,
      );
      for (const [i, t] of tables.entries()) {
        assert.throws(
          () => db.exec(`INSERT OR REPLACE INTO ${t} SELECT * FROM ${t}`),
          /immutable (record|attempt)/,
        );
        assert.equal(
          JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()),
          initial[i],
        );
      }
      db.close();
      if (pass === 0) db = store.openDatabase(path);
    }
    const outcome = await new Promise<{ pragma: number; blocked: string[] }>(
      (resolve, reject) => {
        const worker = new Worker(
          `const{parentPort,workerData}=require('node:worker_threads');(async()=>{const{openDatabase}=await import('@app-ops/db');const db=openDatabase(workerData.path);const blocked=[];for(const t of workerData.tables){try{db.exec('INSERT OR REPLACE INTO '+t+' SELECT * FROM '+t);}catch(e){if(/immutable (record|attempt)/.test(e.message))blocked.push(t);else throw e;}}const pragma=db.prepare('PRAGMA recursive_triggers').get().recursive_triggers;db.close();parentPort.postMessage({pragma,blocked});})().catch(e=>{throw e;});`,
          { eval: true, workerData: { path, tables } },
        );
        worker.once("message", resolve);
        worker.once("error", reject);
      },
    );
    assert.equal(outcome.pragma, 1);
    assert.deepEqual(outcome.blocked, tables);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
