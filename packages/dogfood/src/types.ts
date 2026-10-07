export interface SourceFileInput {
  path: string;
  gitBlobSha: string;
  sha256: string;
  contentBase64: string;
}

/** A one-time byte envelope, never a filesystem path or an execution request. */
export interface SourceBundleV1 {
  schemaVersion: 1;
  repository: { id: string; fullName: string; visibility: "private" | "public" };
  commitSha: string;
  rootDirectory: string;
  fetchedAt: string;
  selectedFlavor: string;
  files: SourceFileInput[];
}

export interface VerifiedSourceFile {
  path: string;
  gitBlobSha: string;
  sha256: string;
  byteLength: number;
}

export interface Fact<T> {
  value: T;
  provenance: {
    repositoryId: string;
    commitSha: string;
    fetchedAt: string;
    path: string;
    gitBlobSha: string;
    pointer: string;
  };
}

export interface FlavorFact {
  id: string;
  productType: Fact<string>;
  appName: Fact<string>;
  declaredPackage: Fact<string>;
}

export interface RuntimeFacts {
  appVersion: Fact<string> | null;
  nodeEngine: Fact<string> | null;
  lockfileVersion: Fact<number>;
  packageEntryCount: Fact<number>;
  versions: Record<"vitest" | "vite" | "expo" | "react-native", Fact<string> | null>;
  runtimeVersion: "not-evaluated";
  adsMode: "not-evaluated";
  otaDestination: "not-evaluated";
  installedBinaryIdentity: "not-inspected";
}

/** Hashes establish internal byte consistency, not remote or execution trust. */
export interface InventorySnapshot {
  id: string;
  digest: string;
  repository: SourceBundleV1["repository"];
  commitSha: string;
  rootDirectory: string;
  fetchedAt: string;
  importedAt: number;
  selectedFlavor: string;
  files: VerifiedSourceFile[];
  flavors: FlavorFact[];
  runtime: RuntimeFacts;
  evidenceOrigin: "operator-import";
  connection: "one-shot-source-snapshot";
}

export interface HeadObservation {
  repositoryId: string;
  rootDirectory: string;
  headCommitSha: string;
  observedAt: string;
  evidenceOrigin: "operator-import";
}

/** Present with the caller-owned observation's timestamp and imported origin. */
export type Freshness = "freshness_unknown" | "observed_current" | "stale";

export interface VerificationProfile {
  id: "config-runtime-smoke-v1";
  argv: readonly string[];
  files: readonly [string, string];
  expectedTests: 4;
  expectedTestsPerFile: 2;
  coverage: string;
}

export interface BaselineBundleV1 {
  schemaVersion: 1;
  sourceDigest: string;
  commitSha: string;
  profileId: "config-runtime-smoke-v1";
  attemptKey: string;
  platform: "linux" | "darwin" | "win32";
  architecture: "x64" | "arm64";
  sourceRoot: string;
  reportPath: string;
  argv: string[];
  runtime: { node: string; npm: string; vitest: string; vite: string };
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  reportBase64: string;
  reportSha256: string;
  sourceHashesBefore: Record<string, string>;
  sourceHashesAfter: Record<string, string>;
  log: string;
}

/** log and safeLog are display-safe; evidenceDigest binds the full original bytes. */
export interface BaselineEvidence extends BaselineBundleV1 {
  evidenceDigest: string;
  report: unknown;
  safeLog: string;
  logTruncated: boolean;
}
export interface ReportAssessment {
  status: "passed" | "failed" | "invalid";
  code: string;
  files: number;
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
  reportDigest: string;
}
export type VerificationState = "queued" | "running" | "cancelling" | "timing_out" | "passed" | "failed" | "invalid" | "blocked" | "cancelled" | "interrupted";
export interface VerificationRecord {
  id: string;
  snapshotId: string;
  sourceDigest: string;
  profileId: string;
  evidenceKind: "development-baseline" | "isolated-runner-result";
  evidenceOrigin: "operator-import" | "flora-request" | "flora-execution";
  state: VerificationState;
  code: string | null;
  cleanupCode: "CLEANUP_UNCONFIRMED" | null;
  requestKind: "baseline-import" | "run-request";
  requestKey: string;
  attemptId: string | null;
  fence: number;
  leaseUntil: number | null;
  createdAt: number;
  updatedAt: number;
  evidence: BaselineEvidence | null;
  assessment: ReportAssessment | null;
}
export interface VerificationFence {
  recordId: string;
  attemptId: string;
  runnerId: string;
  fence: number;
  expiresAt: number;
}
export interface VerificationCompletion {
  state: "passed" | "failed" | "invalid" | "blocked";
  code: string | null;
  evidence: BaselineEvidence | null;
  assessment: ReportAssessment | null;
}
export type VerificationCreation = Readonly<{ record: VerificationRecord; created: boolean }>;
export type PreparedBaselineImport = Readonly<{ snapshotId: string; evidence: BaselineEvidence; assessment: ReportAssessment; now: number }>;
export interface DogfoodStore {
  saveInventory(snapshot: InventorySnapshot): Promise<InventorySnapshot>;
  listInventory(): Promise<InventorySnapshot[]>;
  getInventory(snapshotId: string): Promise<InventorySnapshot | null>;
  saveHeadObservation(observation: HeadObservation): Promise<void>;
  getHeadObservation(snapshot: InventorySnapshot): Promise<HeadObservation | null>;
  persistBaseline(input: PreparedBaselineImport): Promise<VerificationRecord>;
  listVerifications(snapshotId: string): Promise<VerificationRecord[]>;
  getVerification(recordId: string): Promise<VerificationRecord | null>;
  createVerification(input: { snapshotId: string; requestKey: string; now: number }): Promise<VerificationCreation>;
  beginVerification(input: { recordId: string; attemptId: string; runnerId: string; now: number; leaseMs: number }): Promise<VerificationFence>;
  finishVerification(fence: VerificationFence, completion: VerificationCompletion, now: number): Promise<VerificationRecord>;
  blockVerification(recordId: string, code: string, now: number): Promise<VerificationRecord>;
  requestCancellation(recordId: string, now: number): Promise<VerificationRecord>;
  finishCancellation(recordId: string, cleanupConfirmed: boolean, now: number): Promise<VerificationRecord>;
  expireVerification(fence: VerificationFence, now: number): Promise<VerificationRecord>;
  finishTimeout(recordId: string, cleanupConfirmed: boolean, now: number): Promise<VerificationRecord>;
}

/** Import-only storage port; contains no selection or Runner lifecycle operations. */
export type ImportStore = Pick<DogfoodStore,
  "saveInventory" | "getInventory" | "saveHeadObservation" | "getHeadObservation" | "persistBaseline"
>;
