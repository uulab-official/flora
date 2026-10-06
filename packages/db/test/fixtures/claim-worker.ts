import { parentPort, workerData } from "node:worker_threads";
import { openDatabase, claimJob, cancelJob, completeJob } from "@app-ops/db";
const { path, barrier, input, operation } = workerData;
const db = openDatabase(path);
const signal = new Int32Array(barrier);
Atomics.add(signal, 0, 1);
Atomics.notify(signal, 0);
Atomics.wait(signal, 1, 0, 10_000);
try {
  const value =
    operation === "cancel"
      ? cancelJob(db, input)
      : operation === "complete"
        ? completeJob(db, input)
        : claimJob(db, input);
  parentPort?.postMessage({ value });
} catch (e) {
  parentPort?.postMessage({
    error: e instanceof Error && "code" in e ? e.code : "UNKNOWN",
  });
} finally {
  db.close();
}
