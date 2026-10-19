export interface ProjectApplication { id: string; name: string; repositoryId?: string; rootDirectory?: string; createdAt?: number }
export interface ProjectPublication { rollback?: { fromDeploymentId: string; targetDeploymentId: string; reason: string; requestedAt: number }; rollbackIssue?: { deploymentId: string; telemetry: SdkTelemetry | null; depth?: number } | null; appId?: string; platform?: "ios" | "android"; id: string; channel: string; runtimeVersion: string; createdAt: number; commitSha: string; verification?: ProjectVerification | null; telemetry?: SdkTelemetry | null }
export interface ProjectSummary extends ProjectApplication {
  github: null | { owner: string; repository: string; ref: string; version: number };
  ota: { ios: ProjectPublication | null; android: ProjectPublication | null };
  automation: null | { enabled: boolean; channel: string; platforms: string[]; updatedAt: number };
  runner: { status: "unregistered" | "unseen" | "online" | "offline" | "revoked" | "unknown"; registeredCount: number; activeCount: number; onlineCount: number; lastSeenAt: number | null };
}
export interface ViewOptions { status?: "loading" | "ready" | "error"; targetId?: string; error?: string; now?: number; observedAt?: number; branding?: Readonly<Record<string, string>> }
export function renderProjectRows(document: Document, state: { applications?: ProjectApplication[]; selectedApplication?: ProjectApplication | null }, summaries: ProjectSummary[] | { projects: ProjectSummary[]; observedAt: number } | null, options?: ViewOptions): void;
export function technicalDetails(document: Document, entries: Array<[string, unknown]>, label?: string): HTMLDetailsElement;
export function renderOperationalOverview(document: Document, app: ProjectApplication | null, inputs?: { summary?: ProjectSummary | null; operations?: any; automation?: any; detection?: any; status?: ViewOptions["status"]; now?: number; observedAt?: number; branding?: Readonly<Record<string, string>> }): void;
export function renderCompactOtaHistory(document: Document, appId: string, deployments: any[] | null, options?: ViewOptions): void;
export function renderCompactAutomationJobs(document: Document, appId: string, state: any, options?: ViewOptions): void;

export interface ProjectVerification { source: "operator-verification"; environment: "android-emulator" | "ios-simulator" | "physical-device"; observedAt: number; applied: boolean; restarted: boolean; signatureVerified: boolean; assetsVerified: boolean; receiptDigest: string; appId?: string; deploymentId?: string }
export interface WorkspaceUsage { status: "ready" | "stale" | "unconfigured" | "error" | "pending"; source: "cloudflare-graphql"; scope: "account"; day: string | null; rowsRead: number | null; rowsWritten: number | null; readLimit: 5000000; writeLimit: 100000; resetAt: number | null; observedAt: number | null; freshUntil: number | null; collectedBy?: "pc-runner"; verification?: "authenticated-reporter" }
export interface WorkspaceResult { projects: ProjectSummary[]; observedAt: number; usage?: WorkspaceUsage | null }
export function renderWorkspaceStatus(document: Document, result: WorkspaceResult | null, options?: ViewOptions): void;

export interface SdkTelemetry { source: "sdk-self-report"; observedInstallations: number; downloadedInstallations: number; appliedInstallations: number; restartedInstallations: number; failedInstallations: number; rolledBackInstallations: number; recoveredInstallations?: number; issueResolution?: { unresolvedInstallations: number; resolvedInstallations: number; rollbackResolvedInstallations?: number; unknownInstallations: number }; applicationRate: number | null; lastReportedAt: number; environments: { physicalDevice: number; androidEmulator: number; iosSimulator: number; unknown: number }; failures: Array<{ stage: "check" | "download" | "activation" | "launch"; code: string; installations: number; lastReportedAt: number }> }
export function isValidSdkTelemetry(value: unknown, platform: string): boolean;

export function isValidSdkIssueResolution(value: unknown): boolean;
