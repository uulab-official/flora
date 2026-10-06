import test from "node:test";
import assert from "node:assert/strict";
import * as store from "@app-ops/db";
import { sha256 } from "@app-ops/config";
import { proofOf } from "@app-ops/runner-protocol";
import { setup } from "./support.ts";
test("artifact provenance and timeline join the same release target source snapshot", async () => {
  const { db, snapshot } = await setup();
  try {
    const j = await store.createJob(db, {
      organizationId: "org_demo",
      releaseId: "release_demo",
      targetId: "target_demo",
      sourceRevisionId: "source_demo",
      snapshotId: snapshot.id,
      kind: "build",
      idempotencyKey: "artifact_test",
      createdBy: "user_demo",
      requiredCapabilities: [],
    });
    const lease = store.claimJob(db, {
      organizationId: "org_demo",
      jobId: j.id,
      runnerId: "runner_demo",
      runnerOs: "darwin",
      capabilities: ["ios", "xcode"],
      now: 1_000_000,
    });
    assert.ok(lease);
    const proof = proofOf(lease, 1_000_000);
    store.startJob(db, proof);
    const digest = await sha256("{}");
    const artifact = {
      id: "artifact_demo",
      organizationId: "org_demo",
      jobId: j.id,
      attemptId: lease.attemptId,
      releaseId: "release_demo",
      targetId: "target_demo",
      sourceRevisionId: "source_demo",
      snapshotId: snapshot.id,
      digest,
      sizeBytes: 2,
      mediaType: "application/json",
      storageKey: "simulation/" + digest,
    };
    const count = store.listEvents(db, "org_demo", j.id).length;
    for (const change of [
      { sourceRevisionId: "wrong_source" },
      { targetId: "wrong_target" },
      { snapshotId: "wrong_snapshot" },
    ])
      assert.throws(
        () => store.recordArtifact(db, { ...artifact, ...change }, proof),
        { code: "INVALID_RELATION" },
      );
    assert.throws(
      () => store.recordArtifact(db, { ...artifact, sizeBytes: -1 }, proof),
      { code: "INVALID_INPUT" },
    );
    assert.equal(store.listEvents(db, "org_demo", j.id).length, count);
    assert.equal(store.recordArtifact(db, artifact, proof).digest, digest);
    store.recordArtifact(db, artifact, proof);
    assert.equal(store.listEvents(db, "org_demo", j.id).length, count + 1);
    assert.throws(
      () => store.recordArtifact(db, { ...artifact, sizeBytes: 3 }, proof),
      { code: "CONFLICT" },
    );
    store.completeJob(db, {
      ...proof,
      artifactId: artifact.id,
      resultDigest: digest,
    });
    const summary = store.getReleaseSummary(db, "org_demo", "release_demo");
    assert.equal(
      summary.jobs[0]?.sourceRevisionId,
      summary.release.sourceRevisionId,
    );
    assert.equal(summary.artifacts[0]?.snapshotId, snapshot.id);
    assert.equal(summary.jobs[0]?.status, "success");
    assert.ok(
      summary.events.every(
        (e, i, a) => i === 0 || e.sequence > a[i - 1]!.sequence,
      ),
    );
    assert.throws(
      () => store.getReleaseSummary(db, "org_other", "release_demo"),
      { code: "NOT_FOUND" },
    );
    assert.throws(
      () => store.recordArtifact(db, artifact, { ...proof, now: 2_000_000 }),
      { code: "LEASE_STALE" },
    );
  } finally {
    db.close();
  }
});
