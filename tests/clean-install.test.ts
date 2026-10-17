import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  requireLockfile,
  snapshotFiles,
  assertUnchanged,
} from "../scripts/clean-install.mjs";
import * as cleanInstall from "../scripts/clean-install.mjs";

function checkWorkspace(root: string, files: string[]) {
  const check = Reflect.get(cleanInstall, "requireWorkspaceSources");
  assert.equal(typeof check, "function", "clean installation must reject missing tracked workspace sources before downloading");
  check(root, files);
}
function workspaceFixture() {
  const root = mkdtempSync(join(tmpdir(), "flora-clean-workspace-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { "@flora/runner": "workspace:*" } }));
  for (const directory of ["ota-runner", "dogfood"]) mkdirSync(join(root, "packages", directory), { recursive: true });
  writeFileSync(join(root, "packages/ota-runner/package.json"), JSON.stringify({ name: "@flora/runner", dependencies: { "@app-ops/dogfood": "workspace:*" } }));
  writeFileSync(join(root, "packages/dogfood/package.json"), JSON.stringify({ name: "@app-ops/dogfood" }));
  return root;
}
test("clean installation rejects a workspace package present only in the untracked working tree", () => {
  const root = workspaceFixture();
  try {
    assert.throws(() => checkWorkspace(root, ["package.json"]), { message: "WORKSPACE_SOURCE_INCOMPLETE" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("clean installation also rejects an untracked transitive workspace dependency", () => {
  const root = workspaceFixture();
  try {
    assert.throws(() => checkWorkspace(root, ["package.json", "packages/ota-runner/package.json"]), { message: "WORKSPACE_SOURCE_INCOMPLETE" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("a complete tracked workspace passes the preflight without modifying its manifests", () => {
  const root = workspaceFixture();
  try {
    const files = ["package.json", "packages/ota-runner/package.json", "packages/dogfood/package.json"];
    const before = snapshotFiles(root, files);
    checkWorkspace(root, files);
    assertUnchanged(root, before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
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
