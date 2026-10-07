import type { DashboardState } from "@app-ops/dashboard/service";
import type { SourceBundleV1, BaselineBundleV1, VerificationRecord } from "@app-ops/dogfood";
export function createQaHarness(): Promise<{ origin: string; bootstrapUrl: string; source(second?: boolean): SourceBundleV1; state(): Promise<DashboardState>; baseline(): Promise<BaselineBundleV1>; seedQueued(): Promise<VerificationRecord>; close(): Promise<void> }>;
