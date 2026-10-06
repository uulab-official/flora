import test from "node:test";
import assert from "node:assert/strict";
import * as store from "@app-ops/db";
import { setup } from "./support.ts";
const now = 1_000_000;
export function request(snapshotId: string) {
  return {
    organizationId: "org_demo",
    releaseId: "release_demo",
    targetId: "target_demo",
    sourceRevisionId: "source_demo",
    snapshotId,
    kind: "build" as const,
    idempotencyKey: "request_demo",
    createdBy: "user_demo",
    requiredCapabilities: [],
  };
}
export const runner = {
  organizationId: "org_demo",
  runnerId: "runner_one",
  runnerOs: "darwin" as const,
  capabilities: ["ios", "xcode"] as const,
  now,
  leaseDurationMs: 30_000,
};
const proof = (
  l: {
    organizationId: string;
    jobId: string;
    runnerId: string;
    attemptId: string;
    fence: number;
  },
  time = now,
) => ({
  organizationId: l.organizationId,
  jobId: l.jobId,
  runnerId: l.runnerId,
  attemptId: l.attemptId,
  fence: l.fence,
  now: time,
});
test("idempotency distinguishes request payload and does not partially write", async () => {
  const { db, snapshot } = await setup();
  try {
    const j = await store.createJob(db, request(snapshot.id));
    assert.equal((await store.createJob(db, request(snapshot.id))).id, j.id);
    await assert.rejects(
      () =>
        store.createJob(db, {
          ...request(snapshot.id),
          targetId: "wrong_target",
        }),
      { code: "IDEMPOTENCY_CONFLICT" },
    );
    await assert.rejects(
      () =>
        store.createJob(db, {
          ...request(snapshot.id),
          idempotencyKey: "other_key",
          targetId: "wrong_target",
        }),
      { code: "INVALID_RELATION" },
    );
    assert.equal(store.listEvents(db, "org_demo", j.id).length, 1);
  } finally {
    db.close();
  }
});
test("claim leases fence expired runners and reject wrong capabilities", async () => {
  const { db, snapshot } = await setup();
  try {
    const j = await store.createJob(db, request(snapshot.id));
    assert.equal(
      store.claimJob(db, { ...runner, jobId: j.id, runnerOs: "linux" }),
      null,
    );
    const a = store.claimJob(db, { ...runner, jobId: j.id });
    assert.ok(a);
    assert.equal(store.claimJob(db, { ...runner, jobId: j.id }), null);
    store.startJob(db, proof(a));
    assert.throws(() => store.heartbeat(db, proof(a, now + 30_000)), {
      code: "LEASE_STALE",
    });
    assert.equal(store.recoverExpiredJobs(db, "org_demo", now + 30_000), 1);
    const b = store.claimJob(db, {
      ...runner,
      jobId: j.id,
      runnerId: "runner_two",
      now: now + 30_000,
    });
    assert.ok(b);
    assert.equal(b.fence, 2);
    assert.throws(() => store.startJob(db, proof(a, now + 30_000)), {
      code: "LEASE_STALE",
    });
    assert.throws(() =>
      db
        .prepare("update job_attempts set runner_id=? where id=?")
        .run("evil_runner", a.attemptId),
    );
  } finally {
    db.close();
  }
});
test("operator cancels offline lease independently and enforces authorization", async () => {
  const { db, snapshot } = await setup();
  try {
    const j = await store.createJob(db, request(snapshot.id));
    const a = store.claimJob(db, { ...runner, jobId: j.id });
    assert.ok(a);
    const input = {
      organizationId: "org_demo",
      jobId: j.id,
      actorId: "user_demo",
      reason: "stop",
      now: now + 99_000,
      authorization: {
        organizationId: "org_demo",
        actorId: "user_demo",
        actions: [] as string[],
      },
    };
    assert.throws(() => store.cancelJob(db, input), {
      code: "PERMISSION_DENIED",
    });
    assert.equal(
      store.cancelJob(db, {
        ...input,
        authorization: { ...input.authorization, actions: ["job.cancel"] },
      }).status,
      "cancelled",
    );
    assert.throws(() => store.startJob(db, proof(a)), { code: "LEASE_STALE" });
  } finally {
    db.close();
  }
});
test("unsafe expiry waits for reconciliation and build retries are bounded", async () => {
  const { db, snapshot } = await setup();
  try {
    const unsafe = await store.createJob(db, {
      ...request(snapshot.id),
      kind: "store_submit",
    });
    store.claimJob(db, { ...runner, jobId: unsafe.id });
    store.recoverExpiredJobs(db, "org_demo", now + 30_000);
    assert.equal(
      store.getJob(db, "org_demo", unsafe.id).waitingReason,
      "reconciliation_required",
    );
    assert.equal(
      store.claimJob(db, { ...runner, jobId: unsafe.id, now: now + 30_000 }),
      null,
    );
    const j = await store.createJob(db, {
      ...request(snapshot.id),
      idempotencyKey: "build_retry",
    });
    for (let n = 0; n < 3; n++) {
      assert.ok(
        store.claimJob(db, { ...runner, jobId: j.id, now: now + n * 30_000 }),
      );
      store.recoverExpiredJobs(db, "org_demo", now + (n + 1) * 30_000);
    }
    assert.equal(store.getJob(db, "org_demo", j.id).status, "expired");
  } finally {
    db.close();
  }
});
test("nonretryable failure is terminal and completed attempts cannot be deleted", async () => {
  const { db, snapshot } = await setup();
  try {
    const j = await store.createJob(db, request(snapshot.id));
    const l = store.claimJob(db, { ...runner, jobId: j.id });
    assert.ok(l);
    assert.equal(
      store.failJob(db, {
        ...proof(l),
        failureCode: "BUILD_FAILED",
        retryable: false,
      }).status,
      "failed",
    );
    assert.throws(() => db.exec("delete from job_attempts"));
    assert.throws(() => db.exec("update audit_events set action='modified'"));
  } finally {
    db.close();
  }
});
test("completion binds artifact and supports only identical terminal replay", async () => {
  const { db, snapshot } = await setup();
  try {
    const j = await store.createJob(db, request(snapshot.id));
    const l = store.claimJob(db, { ...runner, jobId: j.id });
    assert.ok(l);
    store.startJob(db, proof(l));
    const completion = {
      ...proof(l),
      artifactId: "artifact_demo",
      resultDigest: "c".repeat(64),
    };
    assert.throws(() => store.completeJob(db, completion), {
      code: "INVALID_RELATION",
    });
    db.prepare("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
      "org_demo",
      "artifact_demo",
      j.id,
      l.attemptId,
      "release_demo",
      "target_demo",
      "source_demo",
      snapshot.id,
      "c".repeat(64),
      2,
      "{}",
    );
    assert.throws(
      () =>
        store.completeJob(db, { ...completion, resultDigest: "d".repeat(64) }),
      { code: "INVALID_RELATION" },
    );
    assert.equal(store.completeJob(db, completion).status, "success");
    assert.throws(() =>
      db.exec("INSERT OR REPLACE INTO job_attempts SELECT * FROM job_attempts"),
    );
    assert.throws(() =>
      db.exec("INSERT OR REPLACE INTO artifacts SELECT * FROM artifacts"),
    );
    assert.throws(() =>
      db.exec("INSERT OR REPLACE INTO audit_events SELECT * FROM audit_events"),
    );
    const count = store.listEvents(db, "org_demo", j.id).length;
    assert.equal(
      store.completeJob(db, { ...completion, now: now + 99_000 }).status,
      "success",
    );
    assert.equal(store.listEvents(db, "org_demo", j.id).length, count);
    assert.throws(
      () =>
        store.completeJob(db, { ...completion, resultDigest: "d".repeat(64) }),
      { code: "CONFLICT" },
    );
  } finally {
    db.close();
  }
});
test("claim rejects original custom prototypes hidden keys and accessors without mutation", async () => {
  const { db, snapshot } = await setup();
  try {
    const job = await store.createJob(db, request(snapshot.id));
    const base = { ...runner, jobId: job.id };
    let invoked = 0;
    const custom = Object.setPrototypeOf({ ...base }, { unexpected: true });
    const hidden = Object.defineProperty({ ...base }, "privateField", {
      value: "not-for-storage",
      enumerable: false,
    });
    const getter = Object.defineProperty({ ...base }, "runnerId", {
      get() {
        invoked++;
        return "runner_one";
      },
      enumerable: true,
    });
    for (const bad of [custom, hidden, getter]) {
      assert.throws(() => store.claimJob(db, bad), { code: "INVALID_INPUT" });
      assert.equal(store.getJob(db, "org_demo", job.id).status, "queued");
      assert.equal(store.listEvents(db, "org_demo", job.id).length, 1);
      assert.equal(
        (
          db.prepare("select count(*) as n from job_attempts").get() as {
            n: number;
          }
        ).n,
        0,
      );
    }
    assert.equal(invoked, 0);
  } finally {
    db.close();
  }
});
