import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const workflow = read(".github/workflows/reusable-expo-build.yml");
const caller = read("examples/github-actions/private-expo-build.yml");
const helper = "examples/github-actions/flora-expo-build.mjs";

test("Flora reusable native build is called by a private repo, not triggered on Flora pushes", () => {
  assert.match(workflow, /on:\s*\n  workflow_call:/);
  assert.doesNotMatch(workflow, /pull_request_target:|^\s{2}push:|^\s{2}workflow_dispatch:/m);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow, /github\.event\.repository\.default_branch/);
  assert.match(workflow, /github\.ref_protected/);
  assert.match(workflow, /runs-on:.*inputs\.platform == 'ios'.*macos-latest.*ubuntu-latest/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /permissions:\s*\n  contents: read/);
});

test("dependencies are locked, scripts and paths are checked, artifacts stay on private caller", () => {
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /FLORA_BUILD_PATH_OUTSIDE_REPOSITORY/);
  assert.match(workflow, /FLORA_BUILD_SCRIPT_NOT_FOUND/);
  assert.match(workflow, /flora:build:/);
  assert.match(workflow, /Upload artifacts to the private caller's Actions run/);
  assert.match(workflow, /signingVerified: false/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.doesNotMatch(workflow, /secrets:\s*inherit|eas build|EXPO_TOKEN|persist-credentials: true/);
});

test("external GitHub actions are pinned to complete SHAs", () => {
  const matches = [...workflow.matchAll(/uses:\s+actions\/[^\s@]+@([^\s]+)/g)];
  assert.equal(matches.length, 4);
  for (const match of matches) assert.match(match[1]!, /^[a-f0-9]{40}$/);
});

test("sample caller is manual-only, scoped and requires pinning the reviewed Flora commit", () => {
  assert.match(caller, /workflow_dispatch:/);
  assert.doesNotMatch(caller, /pull_request_target:|secrets: inherit/);
  assert.match(caller, /uulab-official\/flora\/\.github\/workflows\/reusable-expo-build\.yml@FLORA_COMMIT_SHA/);
  assert.match(caller, /FLORA_IOS_P12_BASE64/);
});

test("example native builder rejects invalid targets and unsigned Android production before compilation", () => {
  const invalidCases: Array<[string, string, string]> = [
    ["web", "preview", "FLORA_TARGET_INVALID"],
    ["android", "staging", "FLORA_TARGET_INVALID"],
    ["android", "production", "FLORA_ANDROID_PRODUCTION_SIGNING_REQUIRED"],
  ];
  for (const [platform, profile, error] of invalidCases) {
    const run = spawnSync(process.execPath, [resolve(helper), platform], {
      encoding: "utf8", env: { ...process.env, FLORA_PROFILE: profile }
    });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, new RegExp(error));
  }
});
