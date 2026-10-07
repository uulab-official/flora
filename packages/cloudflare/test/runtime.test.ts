import test from "node:test";
import assert from "node:assert/strict";
import { createTestRuntime } from "./runtime.ts";

test("runtime_provides_isolated_d1_and_sqlite_durable_objects", async t => {
  const options = { entrypoint: new URL("./fixtures/runtime-entry.ts", import.meta.url), durableObjects: { FLORA_AUTH: "TestSqliteObject" } };
  const first = await createTestRuntime(options);
  t.after(() => first.dispose());
  const second = await createTestRuntime(options);
  t.after(() => second.dispose());
  await first.d1.exec("CREATE TABLE fixture (value TEXT NOT NULL); INSERT INTO fixture VALUES ('synthetic')");
  assert.deepEqual(await first.d1.prepare("SELECT value FROM fixture").first(), { value: "synthetic" });
  await assert.rejects(second.d1.prepare("SELECT value FROM fixture").first(), /no such table/);
  const namespace = await first.namespace("FLORA_AUTH");
  const object = namespace.get(namespace.idFromName("flora-owner-v1"));
  assert.equal(await (await object.fetch("https://flora.example.com/")).text(), "1");
  assert.equal(await (await object.fetch("https://flora.example.com/")).text(), "2");
  const isolated = await second.namespace("FLORA_AUTH");
  assert.equal(await (await isolated.get(isolated.idFromName("flora-owner-v1")).fetch("https://flora.example.com/")).text(), "1");
  assert.equal(await (await first.fetch("https://flora.example.com/")).text(), "synthetic runtime");
});
