import { freeze } from "@app-ops/config";
import type { VerificationProfile } from "./types.js";

export const CONFIG_RUNTIME_SMOKE_V1: VerificationProfile = freeze({
  id: "config-runtime-smoke-v1",
  argv: [
    "node",
    "./node_modules/vitest/vitest.mjs",
    "run",
    "tests/config/runtime.test.ts",
    "tests/config/experience-runtime.test.ts",
    "--maxWorkers=1",
    "--reporter=json",
    "--outputFile=/results/vitest.json",
  ],
  files: [
    "tests/config/runtime.test.ts",
    "tests/config/experience-runtime.test.ts",
  ],
  expectedTests: 4,
  expectedTestsPerFile: 2,
  coverage:
    "Two configuration/runtime smoke test files and four tests; no build, signing, store, OTA, or isolation verification.",
});
