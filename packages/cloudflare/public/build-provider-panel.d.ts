/** Read-only owner-scoped build provider chooser; external builds are not dispatched here. */
export interface BuildProviderChoice { id: string; title: string; mode: "local" | "workflow" | "external" }
export interface BuildProviderHelp { description: string; status: string; command: string; action: string }
export interface NativeBuildView {
  appId: string;
  runners: Array<{ appId: string; revokedAt: number | null; lastSeenAt?: number | null }>;
  jobs: Array<{ appId: string; platform: string; state: string; artifact?: { fileName: string; sha256: string } }>;
}
export interface NativeBuildSummary {
  appId: string;
  runnerCount: number;
  observedRunners: number;
  jobCount: number;
  latest: null | { platform: string; state: string; artifactName?: string; artifactSha256?: string };
}
export interface BuildOtaSummary { appId: string; total: number; ios: number; android: number }
export interface LinkedGithubBuild { appId: string; repository: string; commitSha: string; actionsUrl: string; verifyCommand: string }
export interface BuildProviderPanel {
  open(appId: string): void;
  clear(): void;
  setNativeView(appId: string, view: NativeBuildView): boolean;
  setOTAView(appId: string, view: { deployments: Array<{ appId: string; platform: string }> }): boolean;
  setGithubSource(appId: string, connection: unknown, commitSha: unknown): boolean;
  select(providerId: string): boolean;
  copy(): Promise<boolean>;
  copyVerifier(): Promise<boolean>;
  go(page: string): unknown;
  state(): { appId: string | null; selection: string; native: NativeBuildSummary | null; ota: BuildOtaSummary | null; github: LinkedGithubBuild | null };
}
export function linkedGithubBuild(appId: string, connection: unknown, commitSha: unknown): LinkedGithubBuild | null;
export function listBuildProviders(): BuildProviderChoice[];
export function buildProviderHelp(id: string): BuildProviderHelp | null;
export function summarizeNativeBuilds(appId: string, view: NativeBuildView): NativeBuildSummary;
export function summarizeOtaPublications(appId: string, view: { deployments: Array<{ appId: string; platform: string }> }): BuildOtaSummary;
/** The browser module uses the existing authenticated controller; env has the
 * owner console's document and an optional navigator.clipboard. */
export function createBuildProviderPanel(
  env: { document: { getElementById(id: string): any }; navigator?: { clipboard?: { writeText(text: string): Promise<void> } } },
  context: { active(): boolean; appId(): string | null; navigate(page: string, appId: string): unknown }
): BuildProviderPanel;
