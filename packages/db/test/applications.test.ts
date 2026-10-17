import test from "node:test";
import assert from "node:assert/strict";
import * as api from "@app-ops/db";
import { parseSourceBundle } from "@app-ops/dogfood";
import { bundleBytes, syntheticSourceBundle, syntheticBaseline, DOGFOOD_IMPORTED_AT as now } from "../../../tests/dogfood-fixtures.ts";

test("registry isolates repositories and monorepo roots, settings, HEAD and request keys", async () => {
  const db = api.openDatabase(":memory:"); api.migrate(db);
  try {
    const port = api.createSqliteDogfoodStore(db), apps = port.applications!;
    const first = await apps.registerApplication({ name: "One", repositoryId: "repo_synthetic", rootDirectory: "apps/sample" }, now);
    assert.deepEqual(first.settings, { version: 0, values: {}, updatedAt: now });
    const sources = [syntheticSourceBundle(), { ...syntheticSourceBundle(), repository: { ...syntheticSourceBundle().repository, id: "repo_two" } }, { ...syntheticSourceBundle(), rootDirectory: "apps/second" }];
    const snapshots = [];
    for (const source of sources) snapshots.push(await port.saveInventory(await parseSourceBundle(bundleBytes(source), now)));
    assert.equal((await apps.listApplications()).length, 3);
    const second = (await apps.getApplicationForSnapshot(snapshots[1]!.id))!;
    assert.notEqual(first.id, second.id);
    assert.equal((await apps.getApplication(first.id))!.name, "One");
    await assert.rejects(apps.registerApplication({ name: "Renamed", repositoryId: first.repositoryId, rootDirectory: first.rootDirectory }, now), { code: "CONFLICT" });
    const updated = await apps.updateApplicationSettings(first.id, { expectedVersion: 0, values: { API_BASE: "https://one.example" } }, now + 1);
    assert.equal(updated.settings.version, 1);
    await assert.rejects(apps.updateApplicationSettings(first.id, { expectedVersion: 0, values: {} }, now + 2), { code: "CONFLICT" });
    assert.deepEqual((await apps.getApplication(second.id))!.settings.values, {});
    assert.equal(db.prepare("SELECT count(*) n FROM application_settings_history WHERE app_id=?").get(first.id)!.n, 2);
    assert.throws(() => db.exec("DELETE FROM application_settings_history"));
    for (const snapshot of snapshots) {
      const receipt = await port.createVerification({ snapshotId: snapshot.id, requestKey: "same-key", now });
      assert.equal(receipt.created, true); assert.equal(receipt.record.requestKey, "same-key");
      assert.equal((await port.createVerification({ snapshotId: snapshot.id, requestKey: "same-key", now })).created, false);
      await port.saveHeadObservation({ repositoryId: snapshot.repository.id, rootDirectory: snapshot.rootDirectory, headCommitSha: snapshot.commitSha, observedAt: snapshot.fetchedAt, evidenceOrigin: "operator-import" });
    }
    for (const snapshot of snapshots) {
      const baseline = await api.importBaseline(db, snapshot.id, bundleBytes(syntheticBaseline(snapshot)), now);
      assert.equal(baseline.snapshotId, snapshot.id); assert.equal(baseline.state, "passed");
    }
    const firstRun = (await port.listVerifications(snapshots[0]!.id)).find(r => r.requestKind === "run-request")!;
    const fence = await port.beginVerification({ recordId: firstRun.id, attemptId: "first-app-attempt", runnerId: "runner", now, leaseMs: 30000 });
    await port.finishVerification(fence, { state: "blocked", code: "RUNNER_UNAVAILABLE", evidence: null, assessment: null }, now);
    assert.equal((await port.listVerifications(snapshots[0]!.id)).length, 2);
    assert.equal((await port.listVerifications(snapshots[1]!.id)).find(r => r.requestKind === "run-request")!.state, "queued");
    assert.throws(() => db.prepare("INSERT INTO application_request_keys VALUES(?,?,?)").run(second.id,"wrong-app",firstRun.id));
    const next = await port.saveInventory(await parseSourceBundle(bundleBytes({ ...sources[0]!, commitSha: "b".repeat(40) }), now));
    await assert.rejects(port.createVerification({ snapshotId: next.id, requestKey: "same-key", now }), { code: "IDEMPOTENCY_CONFLICT" });
    await assert.rejects(api.importBaseline(db, snapshots[1]!.id, bundleBytes(syntheticBaseline(snapshots[0]!)), now));
    assert.equal((await port.getHeadObservation(next))!.headCommitSha, snapshots[0]!.commitSha);
    assert.equal((await port.getHeadObservation(snapshots[1]!))!.repositoryId, "repo_two");
  } finally { db.close(); }
});

test("registry bounds applications and validates public settings without partial writes", async () => {
  const db = api.openDatabase(":memory:"); api.migrate(db);
  try {
    const apps = api.createSqliteDogfoodStore(db).applications!;
    const app = await apps.registerApplication({ name: "App", repositoryId: "repo", rootDirectory: "." }, now);
    await assert.rejects(apps.registerApplication({ name: "Bad", repositoryId: "repo", rootDirectory: "../escape" }, now), { code: "INVALID_INPUT" });
    for (const values of [{ secret: "x" }, { KEY: "x".repeat(2049) }, Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`KEY_${i}`, "x"]))]) {
      await assert.rejects(apps.updateApplicationSettings(app.id, { expectedVersion: 0, values }, now), { code: "INVALID_INPUT" });
    }
    assert.equal((await apps.getApplication(app.id))!.settings.version, 0);
    for (let i = 1; i < 100; i++) await apps.registerApplication({ name: `App ${i}`, repositoryId: "repo", rootDirectory: `apps/app${i}` }, now);
    await assert.rejects(apps.registerApplication({ name: "Overflow", repositoryId: "repo", rootDirectory: "apps/overflow" }, now), { code: "CONFLICT" });
    assert.equal((await apps.listApplications()).length, 100);
    assert.deepEqual(await apps.registerApplication({ name: "App", repositoryId: "repo", rootDirectory: "." }, now + 1), app);
  } finally { db.close(); }
});
