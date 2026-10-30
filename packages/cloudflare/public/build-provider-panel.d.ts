/** Read-only owner-scoped build provider chooser; external builds are not dispatched here. */
export interface BuildProviderChoice { id: string; title: string; mode: "local" | "workflow" | "external" }
export interface BuildProviderHelp { description: string; status: string; command: string; action: string }
export interface NativeBuildView {
  appId: string;
  runners: Array<{ appId: string; revokedAt: number | null; lastSeenAt?: number | null }>;
  jobs: Array<{ appId: string; platform: "ios" | "android"; state: string; artifact?: { fileName: string; sha256: string } }>;
}
export interface NativeBuildSummary {
  appId: string;
  runnerCount: number;
  observedRunners: number;
  jobCount: number;
  latest: null | { platform: string; state: string; artifactName?: string; artifactSha256?: string };
}
export interface BuildProviderPanel {
  open(appId: string): void;
  clear(): void;
  setNativeView(appId: string, view: NativeBuildView): boolean;
  select(providerId: string): boolean;
  copy(): Promise<boolean>;
  go(page: string): unknown;
  state(): { appId: string | null; selection: string; native: NativeBuildSummary | null };
}
export function listBuildProviders(): BuildProviderChoice[];
export function buildProviderHelp(id: string): BuildProviderHelp | null;
export function summarizeNativeBuilds(appId: string, view: NativeBuildView): NativeBuildSummary;
/** The browser module uses the existing authenticated controller; env has the
 * owner console's document and an optional navigator.clipboard. */
export function createBuildProviderPanel(
  env: { document: { getElementById(id: string): any }; navigator?: { clipboard?: { writeText(text: string): Promise<void> } } },
  context: { active(): boolean; appId(): string | null; navigate(page: string, appId: string): unknown }
): BuildProviderPanel;
