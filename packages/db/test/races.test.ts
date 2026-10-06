import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createJob, getJob, claimJob, startJob } from "@app-ops/db";
import { proofOf } from "@app-ops/runner-protocol";
import { setup } from "./support.ts";
async function race(
  path: string,
  operations: { operation: string; input: unknown }[],
) {
  const barrier = new SharedArrayBuffer(8),
    state = new Int32Array(barrier);
  const workers = operations.map(
    (o) =>
      new Worker(new URL("./fixtures/claim-worker.ts", import.meta.url), {
        workerData: { path, barrier, ...o },
      }),
  );
  const results = workers.map(
    (w) =>
      new Promise<{ value?: unknown; error?: string }>((resolve, reject) => {
        w.once("message", resolve);
        w.once("error", reject);
        w.once("exit", (code) => {
          if (code !== 0) reject(Error("worker exited"));
        });
      }),
  );
  const limit = Date.now() + 10_000;
  while (Atomics.load(state, 0) < 2) {
    if (Date.now() > limit) {
      await Promise.all(workers.map((w) => w.terminate()));
      throw Error("barrier timeout");
    }
    await delay(1);
  }
  Atomics.store(state, 1, 1);
  Atomics.notify(state, 1, 2);
  return Promise.all(results);
}
test("twenty actual two-connection races grant exactly one lease", async () => {
  const dir = mkdtempSync(join(tmpdir(), "platform-race-"));
  try {
    const path = join(dir, "state.db");
    const { db, snapshot } = await setup(path);
    try {
      for (let i = 0; i < 20; i++) {
        const j = await createJob(db, {
          organizationId: "org_demo",
          releaseId: "release_demo",
          targetId: "target_demo",
          sourceRevisionId: "source_demo",
          snapshotId: snapshot.id,
          kind: "build",
          idempotencyKey: "race_" + i,
          createdBy: "user_demo",
          requiredCapabilities: [],
        });
        const input = {
          organizationId: "org_demo",
          jobId: j.id,
          runnerId: "runner_one",
          runnerOs: "darwin",
          capabilities: ["ios", "xcode"],
          now: 1_000_000,
        };
        const results = await race(path, [
          { operation: "claim", input },
          { operation: "claim", input: { ...input, runnerId: "runner_two" } },
        ]);
        assert.equal(
          results.filter((r) => r.value !== null && r.value !== undefined)
            .length,
          1,
        );
        assert.ok(results.every((r) => !r.error));
        assert.equal(getJob(db, "org_demo", j.id).attemptCount, 1);
      }
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});
test("cancel and complete race commits one terminal outcome", async () => {
  const dir = mkdtempSync(join(tmpdir(), "platform-terminal-"));
  try {
    const path = join(dir, "state.db");
    const { db, snapshot } = await setup(path);
    try {
      const j = await createJob(db, {
        organizationId: "org_demo",
        releaseId: "release_demo",
        targetId: "target_demo",
        sourceRevisionId: "source_demo",
        snapshotId: snapshot.id,
        kind: "build",
        idempotencyKey: "terminal_race",
        createdBy: "user_demo",
        requiredCapabilities: [],
      });
      const l = claimJob(db, {
        organizationId: "org_demo",
        jobId: j.id,
        runnerId: "runner_one",
        runnerOs: "darwin",
        capabilities: ["ios", "xcode"],
        now: 1_000_000,
      });
      assert.ok(l);
      const proof = proofOf(l, 1_000_000);
      startJob(db, proof);
      db.prepare("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
        "org_demo",
        "artifact_race",
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
      const results = await race(path, [
        {
          operation: "complete",
          input: {
            ...proof,
            artifactId: "artifact_race",
            resultDigest: "c".repeat(64),
          },
        },
        {
          operation: "cancel",
          input: {
            organizationId: "org_demo",
            jobId: j.id,
            actorId: "user_demo",
            reason: "test",
            now: 1_000_000,
            authorization: {
              organizationId: "org_demo",
              actorId: "user_demo",
              actions: ["job.cancel"],
            },
          },
        },
      ]);
      assert.equal(results.filter((r) => r.value !== undefined).length, 1);
      assert.ok(
        ["success", "cancelled"].includes(getJob(db, "org_demo", j.id).status),
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});
