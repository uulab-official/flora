import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir, availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("test runner bounds concurrency before spawning and preserves test failure status", async t => {
  const directory = await mkdtemp(join(tmpdir(), "flora-test-runner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runner = fileURLToPath(new URL("./test.mjs", import.meta.url));
  const fixture = join(directory, "fixture.test.ts"), preload = join(directory, "capture.mjs");
  await writeFile(fixture, "throw new Error('fixture must not execute in the argument test');\n");
  await writeFile(preload, `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
childProcess.spawnSync = (executable, args, options) => {
  writeFileSync(process.env.FLORA_TEST_CAPTURE, JSON.stringify({ executable, args, stdio: options.stdio }));
  return { status: Number(process.env.FLORA_TEST_CHILD_STATUS ?? 0) };
};
syncBuiltinESMExports();\n`);
  let sequence = 0;
  for (const configured of [undefined, "1", "2", "3", "4", "", "0", "5", "-1", "2.5", "2junk", " 2", "NaN"]) {
    const capture = join(directory, `${sequence++}.json`);
    const env = { ...process.env, FLORA_TEST_CAPTURE: capture, FLORA_TEST_CHILD_STATUS: "7" };
    delete env.FLORA_TEST_CONCURRENCY;
    if (configured !== undefined) env.FLORA_TEST_CONCURRENCY = configured;
    const result = spawnSync(process.execPath, ["--import", preload, runner, fixture], { env, encoding: "utf8" });
    assert.equal(result.error, undefined);
    if (configured === undefined || /^[1-4]$/.test(configured)) {
      assert.equal(result.status, 7, "Child test failure must remain a failure");
      const recorded = JSON.parse(await readFile(capture, "utf8"));
      assert.equal(recorded.executable, process.execPath);
      assert.deepEqual(recorded.args, ["--test", `--test-concurrency=${Math.min(Number(configured ?? 2), availableParallelism())}`, fixture]);
      assert.equal(recorded.stdio, "inherit");
    } else {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /FLORA_TEST_CONCURRENCY must be an integer from 1 to 4/);
      await assert.rejects(access(capture), { code: "ENOENT" });
    }
  }
});
