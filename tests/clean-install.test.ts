import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  requireLockfile,
  snapshotFiles,
  assertUnchanged,
} from "../scripts/clean-install.mjs";
test("clean installer refuses a missing or empty lockfile", () => {
  const dir = mkdtempSync(join(tmpdir(), "platform-clean-test-"));
  try {
    assert.throws(() => requireLockfile(dir), { message: "LOCKFILE_REQUIRED" });
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    assert.throws(() => requireLockfile(dir), { message: "LOCKFILE_REQUIRED" });
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9");
    requireLockfile(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("clean installer detects file mutation rather than trusting frozen install", () => {
  const dir = mkdtempSync(join(tmpdir(), "platform-clean-test-"));
  try {
    writeFileSync(join(dir, "pnpm-lock.yaml"), "before");
    const snapshot = snapshotFiles(dir, ["pnpm-lock.yaml"]);
    assertUnchanged(dir, snapshot);
    writeFileSync(join(dir, "pnpm-lock.yaml"), "after");
    assert.throws(() => assertUnchanged(dir, snapshot), {
      message: "SOURCE_CHANGED",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
