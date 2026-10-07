export function runDogfoodDemo(dbPath?: string): Promise<{
  mode: "synthetic-dogfood-demo";
  snapshotId: string;
  verificationId: string;
  baselineState: string;
  files: number;
  tests: number;
  evidenceOrigin: "operator-import";
  isolatedExecution: "not_run";
}>;
