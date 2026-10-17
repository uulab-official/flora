import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
      5,
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


test("upgrades a 0001-only database and verifies every migration checksum", () => {
  const first = readFileSync(new URL("../migrations/0001_foundation.sql", import.meta.url), "utf8");
  for (const badVersion of [1, 2, 3, 4, 5]) {
    const db = store.openDatabase(":memory:");
    try {
      db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL) STRICT");
      db.exec(first);
      db.prepare("INSERT INTO schema_migrations VALUES(1,?)").run(createHash("sha256").update(first).digest("hex"));
      store.migrate(db);
      assert.equal((db.prepare("SELECT count(*) n FROM schema_migrations").get() as { n: number }).n, 5);
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='dashboard_server_owner'").get());
      db.prepare("UPDATE schema_migrations SET checksum='bad' WHERE version=?").run(badVersion);
      assert.throws(() => store.migrate(db), { code: "MIGRATION_MISMATCH" });
    } finally { db.close(); }
  }
});

test("migration failure rolls back all new schema and rejects noncontiguous versions", () => {
  const db = store.openDatabase(":memory:");
  try {
    db.exec("CREATE TABLE inventory_snapshots(id TEXT)");
    assert.throws(() => store.migrate(db), { code: "CONFLICT" });
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='organizations'").get(), undefined);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='schema_migrations'").get(), undefined);
    db.exec("DROP TABLE inventory_snapshots; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL) STRICT; INSERT INTO schema_migrations VALUES(2,'x')");
    assert.throws(() => store.migrate(db), { code: "MIGRATION_MISMATCH" });
  } finally { db.close(); }
});

for (const version of [1, 2, 3, 4]) {
  test(`version ${version} upgrade preserves every original row and legacy receipt identity`, async () => {
    const db = store.openDatabase(":memory:");
    try {
      db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL) STRICT");
      for (const name of ["0001_foundation.sql", "0002_dogfood.sql", "0003_multi_app.sql", "0004_operations.sql"].slice(0,version)) {
        const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
        db.exec(sql); db.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(Number(name.slice(0,4)), createHash("sha256").update(sql).digest("hex"));
      }
      store.insertCatalog(db, catalog); store.saveTarget(db, target); store.saveSource(db, source);
      const originalSnapshot = await resolveSnapshot({ target, source, entries: [] }); await store.saveSnapshot(db, originalSnapshot);
      let snapshotId = "", baselineId = "";
      if (version >= 2) {
        const { parseSourceBundle, parseBaselineBundle, assessReport, CONFIG_RUNTIME_SMOKE_V1 } = await import("@app-ops/dogfood");
        const { canonicalJson } = await import("@app-ops/config");
        const { bundleBytes, syntheticSourceBundle, syntheticBaseline, DOGFOOD_IMPORTED_AT: now } = await import("../../../tests/dogfood-fixtures.ts");
        const legacySource = { ...syntheticSourceBundle(), repository: { ...syntheticSourceBundle().repository, id: "r".repeat(300), fullName: "n".repeat(300) }, rootDirectory: "apps/" + "r".repeat(1100) };
        const snapshot = await parseSourceBundle(bundleBytes(legacySource), now); snapshotId = snapshot.id;
        if (version >= 3) store.registerApplication(db, { name: "n".repeat(256), repositoryId: snapshot.repository.id, rootDirectory: snapshot.rootDirectory }, now);
        db.prepare("INSERT INTO inventory_snapshots VALUES(?,?,?,?,?,?,?)").run(snapshot.id,snapshot.digest,snapshot.repository.id,snapshot.rootDirectory,snapshot.commitSha,now,canonicalJson(snapshot));
        const evidence = await parseBaselineBundle(bundleBytes(syntheticBaseline(snapshot)), snapshot);
        const assessment = assessReport(evidence, CONFIG_RUNTIME_SMOKE_V1); baselineId = "legacy_baseline";
        db.prepare(`INSERT INTO verification_records(id,snapshot_id,source_digest,profile_id,evidence_kind,evidence_origin,state,code,request_kind,request_key,fence,created_at,updated_at,evidence,assessment)
          VALUES(?,?,?,?,'development-baseline','operator-import',?,?,'baseline-import',?,0,?,?,?,?)`)
          .run(baselineId,snapshot.id,snapshot.digest,evidence.profileId,assessment.status,assessment.code,evidence.sourceDigest+":"+evidence.attemptKey,now,now,canonicalJson(evidence),canonicalJson(assessment));
        store.saveHeadObservation(db,{ repositoryId: snapshot.repository.id,rootDirectory: snapshot.rootDirectory,headCommitSha:snapshot.commitSha,observedAt:snapshot.fetchedAt,evidenceOrigin:"operator-import" });
        db.prepare(`INSERT INTO verification_records(id,snapshot_id,source_digest,profile_id,evidence_kind,evidence_origin,state,request_kind,request_key,fence,created_at,updated_at)
          VALUES('legacy_run',?,?,'config-runtime-smoke-v1','isolated-runner-result','flora-request','queued','run-request','same-key',0,?,?)`).run(snapshot.id,snapshot.digest,now,now);
        db.prepare("INSERT INTO verification_attempts VALUES('legacy_attempt','legacy_run','runner',1,?,30000,'running',?,?)").run(now+30000,now,now);
        db.prepare("UPDATE verification_records SET state='running',evidence_origin='flora-execution',attempt_id='legacy_attempt',fence=1,lease_until=? WHERE id='legacy_run'").run(now+30000);
        db.prepare("UPDATE verification_attempts SET state='blocked' WHERE id='legacy_attempt'").run();
        db.prepare("UPDATE verification_records SET state='blocked',code='RUNNER_UNAVAILABLE',lease_until=NULL WHERE id='legacy_run'").run();
      }
      if (version >= 3) {
        const app = store.listApplications(db)[0]!;
        store.updateApplicationSettings(db, app.id, { expectedVersion: 0, values: { PUBLIC_NAME: "old-value" } }, Date.now());
        db.prepare("INSERT INTO application_request_keys VALUES(?,?,?)").run(app.id,"same-key","legacy_run");
      }
      if (version === 4) {
        const app = store.getApplication(db, store.listApplications(db)[0]!.id)!;
        const ops = store.createSqliteDogfoodStore(db).operations!;
        const connection = await ops.saveGitHubConnection(app.id,{ expectedVersion:0,installationId:1,owner:"example",repository:"legacy",ref:"main" },1000);
        const detection = await ops.saveGitHubDetection({ id:"github_legacy",appId:app.id,connection,rootDirectory:app.rootDirectory,commitSha:"a".repeat(40),framework:"expo",expoVersion:"57",reactNativeVersion:null,configSource:"app.json",runtimeVersion:"1",platforms:["ios"],updatesEnabled:true,updatesUrl:"https://updates.example/updates/"+app.id,reasons:[],detectedAt:1000 });
        const { prepareOTAAsset } = await import("@app-ops/dogfood");
        const bytes = new TextEncoder().encode("legacy-bundle");
        const asset = await ops.saveOTAAsset(await prepareOTAAsset(app.id,{key:"legacy_bundle",contentType:"application/javascript",fileExtension:".js"},bytes,1000),bytes);
        await ops.saveOTADeployment({ id:"11111111-1111-4111-8111-111111111111",appId:app.id,createdAt:1000,requestKey:"legacy_publication",detectionId:detection.id,commitSha:detection.commitSha,channel:"preview",runtimeVersion:"1",platform:"ios",launchAssetId:asset.id,assetIds:[],launchAsset:asset,assets:[] });
        store.createRelease(db,{id:"release_legacy",organizationId:"org_demo",applicationId:"app_demo",sourceRevisionId:"source_demo",version:"1",createdBy:"user_demo"});
        const job = await store.createJob(db,{organizationId:"org_demo",releaseId:"release_legacy",targetId:"target_demo",sourceRevisionId:"source_demo",snapshotId:originalSnapshot.id,kind:"build",idempotencyKey:"legacy_artifact",createdBy:"user_demo",requiredCapabilities:[]});
        const lease = store.claimJob(db,{organizationId:"org_demo",jobId:job.id,runnerId:"runner_demo",runnerOs:"darwin",capabilities:["ios","xcode"],now:1_000_000}); assert.ok(lease);
        const { proofOf } = await import("@app-ops/runner-protocol"); const proof = proofOf(lease,1_000_000); store.startJob(db,proof);
        const artifact = store.recordArtifact(db,{id:"artifact_legacy",organizationId:"org_demo",jobId:job.id,attemptId:lease.attemptId,releaseId:"release_legacy",targetId:"target_demo",sourceRevisionId:"source_demo",snapshotId:originalSnapshot.id,digest:"a".repeat(64),sizeBytes:2,mediaType:"application/json",storageKey:"simulation/"+"a".repeat(64)},proof);
        store.completeJob(db,{...proof,artifactId:artifact.id,resultDigest:artifact.digest});
      }
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name<>'schema_migrations' ORDER BY name").all() as { name: string }[]).map(r => r.name);
      const before = tables.map(name => db.prepare(`SELECT * FROM "${name}"`).all());
      const checksums = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      store.migrate(db); store.migrate(db);
      assert.deepEqual(tables.map(name => db.prepare(`SELECT * FROM "${name}"`).all()),before);
      assert.deepEqual(db.prepare("SELECT * FROM schema_migrations WHERE version<=? ORDER BY version").all(version),checksums);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
      if (version >= 2) {
        const port = store.createSqliteDogfoodStore(db);
        const application = (await port.applications!.getApplicationForSnapshot(snapshotId))!;
        assert.equal(application.settings.version,version >= 3 ? 1 : 0);
        assert.equal(application.repositoryId,"r".repeat(300));
        assert.equal(application.rootDirectory,"apps/"+"r".repeat(1100));
        assert.equal(application.name,"n".repeat(256));
        const receipt = await port.createVerification({ snapshotId,requestKey:"same-key",now: Date.now() });
        assert.equal(receipt.created,false); assert.equal(receipt.record.id,"legacy_run"); assert.equal(receipt.record.requestKey,"same-key");
        for (const id of [baselineId,"legacy_run"]) assert.throws(() => db.prepare("UPDATE verification_records SET state='queued' WHERE id=?").run(id));
        assert.throws(() => db.exec("DELETE FROM verification_attempts"));
        assert.throws(() => db.exec("INSERT OR REPLACE INTO verification_records SELECT * FROM verification_records"));
        assert.throws(() => db.exec("UPDATE inventory_snapshots SET data='{}'"));
      }
    } finally { db.close(); }
  });
}
