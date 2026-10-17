import test from "node:test";
import assert from "node:assert/strict";
import { createTestRuntime } from "./runtime.ts";

test("local D1 acknowledges a single committed write after CPU work outlives the idle socket", { timeout: 30000 }, async t => {
  const runtime = await createTestRuntime({ entrypoint: new URL("./fixtures/runtime-entry.ts", import.meta.url) });
  t.after(() => runtime.dispose());
  const db = runtime.d1;
  await db.prepare("CREATE TABLE transport_once(id INTEGER PRIMARY KEY)").run();
  await db.prepare("SELECT count(*) n FROM transport_once").first();

  // Pinned workerd closes idle sockets after 5s. Like large synchronous D1
  // binding serialization, this prevents Node's idle-pool timers from running.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6500);

  const result = await db.prepare("INSERT INTO transport_once VALUES(1)").run();
  assert.equal(result.success, true);
  assert.equal(await db.prepare("SELECT count(*) n FROM transport_once").first("n"), 1);
  await assert.rejects(db.prepare("INSERT INTO transport_once VALUES(1)").run(), /UNIQUE constraint failed/);
  assert.equal(await db.prepare("SELECT count(*) n FROM transport_once").first("n"), 1);
});
