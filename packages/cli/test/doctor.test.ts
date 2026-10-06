import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolvePnpmEntry } from "../src/doctor.ts";
test("pnpm resolves a pinned JavaScript entry and rejects cmd wrappers", () => {
  const dir = mkdtempSync(join(tmpdir(), "platform-pnpm-"));
  try {
    mkdirSync(join(dir, "bin"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "pnpm", version: "11.19.0" }),
    );
    const js = join(dir, "bin", "pnpm.cjs"),
      cmd = join(dir, "pnpm.cmd");
    writeFileSync(js, "// fixture, never executed");
    writeFileSync(cmd, "echo do-not-execute");
    assert.equal(resolvePnpmEntry(js), realpathSync(js));
    assert.equal(resolvePnpmEntry(cmd), null);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "pnpm", version: "different" }),
    );
    assert.equal(resolvePnpmEntry(js), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
