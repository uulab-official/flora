import { createHash } from "node:crypto";
import type { SourceBundleV1, SourceFileInput } from "@app-ops/dogfood";

// Synthetic data only. Keep these independent of the production parser/profile.
export const DOGFOOD_FETCHED_AT = "2026-01-02T03:04:05.000Z";
export const DOGFOOD_IMPORTED_AT = Date.parse("2026-01-02T03:05:00.000Z");
export const DOGFOOD_TEST_FILES = [
  "tests/config/runtime.test.ts",
  "tests/config/experience-runtime.test.ts",
] as const;

export function sourceFile(path: string, content: string | Uint8Array): SourceFileInput {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  return {
    path,
    gitBlobSha: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentBase64: bytes.toString("base64"),
  };
}

export function syntheticRegistry(count = 11) {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [
    i === 0 ? "sample/~one" : `sample-${i + 1}`,
    {
      productType: "synthetic-demo",
      app: { name: `Sample App ${i + 1}`, package: `invalid.example.sample${i + 1}` },
      ignored: { adsMode: "fixture-only", privateNote: "do-not-export" },
    },
  ]));
}

export function syntheticSourceBundle(): SourceBundleV1 {
  return {
    schemaVersion: 1,
    repository: { id: "repo_synthetic", fullName: "example/synthetic-app", visibility: "private" },
    commitSha: "a".repeat(40),
    rootDirectory: "apps/sample",
    fetchedAt: DOGFOOD_FETCHED_AT,
    selectedFlavor: "sample/~one",
    files: [
      sourceFile("package.json", JSON.stringify({
        name: "synthetic-app", version: "1.2.3", engines: { node: ">=24.19.0 <25" },
        scripts: { postinstall: "this must never be executed" },
        dependencies: { vitest: "not-the-resolved-version" },
      })),
      sourceFile("package-lock.json", JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "synthetic-app", version: "1.2.3" },
          "node_modules/vitest": { version: "4.0.0" },
          "node_modules/vite": { version: "7.0.0" },
          "node_modules/expo": { version: "54.0.0" },
          "node_modules/react-native": { version: "0.81.0" },
        },
      })),
      sourceFile("flavors/config.json", JSON.stringify(syntheticRegistry())),
      sourceFile("src/core/config/runtime.ts", "export const synthetic = true;\n"),
      sourceFile("src/core/experience/runtime.ts", "export const synthetic = true;\n"),
      sourceFile("src/core/experience/types.ts", "export type Synthetic = string;\n"),
      sourceFile("config/experience-contract.json", '{"synthetic":true}\n'),
      sourceFile("vitest.config.mts", "export default {};\n"),
      sourceFile("tsconfig.json", '{"compilerOptions":{"strict":true}}\n'),
      ...DOGFOOD_TEST_FILES.map((path) => sourceFile(path, "// Synthetic hash-only test source.\n")),
    ],
  };
}

export function bundleBytes(bundle: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(bundle));
}

export function replaceSourceFile(bundle: SourceBundleV1, path: string, content: string | Uint8Array): SourceBundleV1 {
  return { ...bundle, files: bundle.files.map((file) => file.path === path ? sourceFile(path, content) : file) };
}

export function syntheticReport() {
  const start = Date.parse("2026-01-02T03:06:00.000Z");
  return {
    numTotalTestSuites: 4, numPassedTestSuites: 4, numFailedTestSuites: 0,
    numPendingTestSuites: 0, numTotalTests: 4, numPassedTests: 4,
    numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
    startTime: start, success: true,
    testResults: DOGFOOD_TEST_FILES.map((file, i) => ({
      name: `/work/sample/${file}`, status: "passed", startTime: start + i * 100,
      endTime: start + 500 + i * 100,
      assertionResults: [0, 1].map((n) => ({
        ancestorTitles: ["synthetic"], title: `case ${n}`, fullName: `synthetic case ${n}`,
        status: "passed", duration: 10, failureMessages: [],
      })),
    })),
  };
}

export function withReport<T extends { reportBase64: string; reportSha256: string }>(bundle: T, report: unknown): T {
  const bytes = Buffer.from(typeof report === "string" ? report : JSON.stringify(report));
  return { ...bundle, reportBase64: bytes.toString("base64"), reportSha256: createHash("sha256").update(bytes).digest("hex") };
}

export function syntheticBaseline(snapshot: import("@app-ops/dogfood").InventorySnapshot) {
  const hashes = Object.fromEntries(snapshot.files.map((file) => [file.path, file.sha256]));
  return withReport({
    schemaVersion: 1 as const, sourceDigest: snapshot.digest, commitSha: snapshot.commitSha,
    profileId: "config-runtime-smoke-v1" as const, attemptKey: "synthetic-attempt-1",
    platform: "linux" as "linux" | "darwin" | "win32", architecture: "x64" as const,
    sourceRoot: "/work/sample", reportPath: "/results/vitest.json",
    argv: ["node", "./node_modules/vitest/vitest.mjs", "run", ...DOGFOOD_TEST_FILES,
      "--maxWorkers=1", "--reporter=json", "--outputFile=/results/vitest.json"],
    runtime: { node: "24.19.0", npm: "11.11.0", vitest: "4.0.0", vite: "7.0.0" },
    startedAt: "2026-01-02T03:06:00.000Z", finishedAt: "2026-01-02T03:06:01.000Z",
    durationMs: 1000, exitCode: 0 as number | null,
    reportBase64: "", reportSha256: "", sourceHashesBefore: { ...hashes }, sourceHashesAfter: { ...hashes },
    log: "synthetic result\n",
  }, syntheticReport());
}

// Contract-only providers. Never exported by a product package or selectable by a user.
export function verifiedSyntheticCapabilities(providerId = "synthetic-provider"): import("@app-ops/runner-protocol").CapabilityReport {
  return {
    providerId, os: "linux", capabilities: ["node"], reasons: [],
    checks: { toolchain: "passed", filesystem: "passed", network: "passed", cpu: "passed",
      resources: "passed", processTreeCancel: "passed", outputBoundary: "passed", cleanup: "passed" },
  };
}

export function syntheticVerificationProvider(overrides: Partial<import("@app-ops/runner-protocol").VerificationProvider> = {}): import("@app-ops/runner-protocol").VerificationProvider {
  const id = overrides.id ?? "synthetic-provider";
  return {
    id,
    preflight: async () => verifiedSyntheticCapabilities(id),
    run: async input => syntheticProviderResult(input),
    cancel: async () => confirmedSyntheticCleanup(),
    ...overrides,
  };
}

export function confirmedSyntheticCleanup(): import("@app-ops/runner-protocol").CleanupReport {
  return { processTreeStopped: true, workspaceRemoved: true, outputBoundaryEnforced: true };
}

export async function syntheticProviderResult(input: import("@app-ops/runner-protocol").RunInput): Promise<import("@app-ops/runner-protocol").ProviderResult> {
  const { parseBaselineBundle } = await import("@app-ops/dogfood");
  return {
    evidence: await parseBaselineBundle(bundleBytes({ ...syntheticBaseline(input.snapshot), attemptKey: input.fence.attemptId }), input.snapshot),
    cleanup: confirmedSyntheticCleanup(),
  };
}
