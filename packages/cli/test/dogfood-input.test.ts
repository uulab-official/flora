import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DomainError } from "@app-ops/core";
import { parseSourceBundle } from "@app-ops/dogfood";
import { readDogfoodInputFile } from "../src/dogfood-input.ts";
import { readInputFile, decodeWorkflow } from "../src/config-command.ts";
import { runCli } from "@app-ops/cli";
import { bundleBytes, replaceSourceFile, syntheticSourceBundle, DOGFOOD_IMPORTED_AT } from "../../../tests/dogfood-fixtures.ts";

const limit = 2 * 1024 * 1024;

test("dogfood input size is independent of both legacy workflow limits", async () => {
  const directory = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "dogfood-input-"));
  try {
    const bundle = replaceSourceFile(syntheticSourceBundle(), "src/core/config/runtime.ts", "//" + "x".repeat(900_000) + "\n");
    const bytes = bundleBytes(bundle);
    assert.ok(bytes.length > 1024 * 1024 && bytes.length < limit);
    const path = join(directory, "source.json"); await fs.writeFile(path, bytes);
    const read = await readDogfoodInputFile(path);
    assert.deepEqual(read, Buffer.from(bytes));
    assert.equal((await parseSourceBundle(read, DOGFOOD_IMPORTED_AT)).files.length, 11);
    await assert.rejects(readInputFile(path), { code: "INVALID_INPUT" });
    assert.throws(() => decodeWorkflow(bytes), { code: "INVALID_INPUT" });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("dogfood reader accepts the exact two MiB boundary", async () => {
  const directory = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "dogfood-boundary-"));
  try {
    const path = join(directory, "boundary.json"), bytes = Buffer.alloc(limit, 32);
    await fs.writeFile(path, bytes);
    assert.deepEqual(await readDogfoodInputFile(path), bytes);
    await fs.writeFile(path, Buffer.alloc(0));
    assert.equal((await readDogfoodInputFile(path)).length, 0);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("oversize input stops after the one byte sentinel and closes its file", async t => {
  const directory = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "dogfood-sentinel-"));
  try {
    const path = join(directory, "large.json"); await fs.writeFile(path, Buffer.alloc(limit * 4, 32));
    const open = fs.open.bind(fs);
    let bytesRead = 0, closed = false;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args), read = file.read.bind(file), close = file.close.bind(file);
      t.mock.method(file, "read", async (buffer: Buffer, offset: number, length: number, position: number | null) => {
        assert.ok(bytesRead + length <= limit + 1, "never request bytes beyond the sentinel");
        // Short reads must also respect the cumulative bound.
        const result = await read(buffer, offset, Math.min(length, 7_919), position);
        bytesRead += result.bytesRead; return result;
      });
      t.mock.method(file, "close", async () => { closed = true; await close(); });
      return file;
    });
    await assert.rejects(readDogfoodInputFile(path), { code: "INPUT_TOO_LARGE", message: "INPUT_TOO_LARGE" });
    assert.equal(bytesRead, limit + 1); assert.equal(closed, true);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("dogfood reader rejects directories with a safe error", async () => {
  const directory = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "dogfood-not-file-"));
  try { await assert.rejects(readDogfoodInputFile(directory), { code: "INVALID_INPUT", message: "INVALID_INPUT" }); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("safe dogfood errors retain only their codes in existing CLI error handling", async () => {
  for (const code of ["PRIVATE_STORE_UNSAFE", "STORE_IN_USE", "INPUT_TOO_LARGE"] as const) {
    let stdout = "", stderr = "";
    assert.equal(await runCli(["config", "validate", "--file", "synthetic-private-path"], {
      stdout: text => { stdout += text; }, stderr: text => { stderr += text; },
      readFile: async () => { throw new DomainError(code); },
    }), 1);
    assert.equal(stdout, ""); assert.equal(stderr, JSON.stringify({ error: code }) + "\n");
  }
});
