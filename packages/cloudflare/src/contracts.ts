import type { D1Database, DurableObjectNamespace, Fetcher, R2Bucket } from "@cloudflare/workers-types";
import type { Freshness, HeadObservation, ImportStore, InventorySnapshot, VerificationProfile, VerificationRecord } from "@app-ops/dogfood";
import type { ApplicationSummary, ManagedApplication } from "@app-ops/dogfood";

export interface SetupWindow {
  digest: string;
  issuedAt: number;
  expiresAt: number;
  generation: number;
  purpose: "enroll" | "recover";
}
export interface FloraConfig {
  orgLimits?: import("./org/types.js").OrgLimits;
  workspaceName?: string;
  passwordMinimum?: 12 | 15;
  origin: string;
  ownerId: string;
  ownerEmail: string;
  dbIdentity: string;
  setup: SetupWindow | null;
}
export interface FloraEnv {
  FLORA_ORG_METADATA_BYTES?: string;
  FLORA_ORG_AUDIT_BYTES?: string;
  /** Display-only analytics reporter; not used to enforce quotas. */
  FLORA_USAGE_REPORTER_ID?: string;
  FLORA_CLOUDFLARE_ACCOUNT_ID?: string;
  /** Operator key ring; exclusively a Worker Secret, never a public var. */
  FLORA_VAULT_KEYS?: string;
  FLORA_WORKSPACE_NAME?: string;
  FLORA_PASSWORD_MIN_LENGTH?: string;
  FLORA_GITHUB_WEBHOOK_SECRET?: string;
  FLORA_GITHUB_APP_ID?: string;
  FLORA_GITHUB_PRIVATE_KEY?: string;
  FLORA_OTA_SIGNING_PRIVATE_KEY?: string;
  FLORA_OTA_SIGNING_KEY_ID?: string;
  FLORA_ORIGIN: string;
  FLORA_OWNER_ID: string;
  FLORA_OWNER_EMAIL: string;
  FLORA_DB_IDENTITY: string;
  FLORA_SETUP?: SetupWindow;
  FLORA_DB: D1Database;
  /** Private, binding-only Standard storage. Never exposed as a public URL. */
  FLORA_OTA_ASSETS?: R2Bucket;
  FLORA_OTA_ASSET_STORAGE?: string;
  FLORA_OTA_ASSET_REPOSITORY?: string;
  FLORA_OTA_ASSET_REPOSITORY_ID?: string;
  FLORA_OTA_ASSET_INSTALLATION_ID?: string;
  FLORA_AUTH: DurableObjectNamespace;
  ASSETS: Fetcher;
}

/** Internal authority only. Never construct a grant from an HTTP caller's data. */
export interface AuthGrant {
  ownerId: string;
  sessionHash: string;
  epoch: number;
  expiresAt: number;
}
export interface Page<T> { items: T[]; nextCursor: string | null }
export type SnapshotSummary = Pick<InventorySnapshot, "id" | "digest" | "commitSha" | "importedAt">;
export type BaselineSummary = Pick<VerificationRecord, "id" | "snapshotId" | "state" | "code" | "createdAt" | "assessment"> & {
  platform: "linux" | "darwin" | "win32";
  node: string;
  exitCode: number | null;
  evidenceDigest: string;
  logTruncated: boolean;
};
export interface SafeLog { id: string; safeLog: string; logTruncated: boolean }
export interface HostedReadStore {
  pageInventory(cursor: string | null, appId?: string): Promise<Page<SnapshotSummary>>;
  pageBaselines(snapshotId: string, cursor: string | null, appId?: string): Promise<Page<BaselineSummary>>;
  getSafeLog(recordId: string, appId?: string): Promise<SafeLog | null>;
}
export type HostedStore = ImportStore & HostedReadStore;
export interface HostedState {
  applications?: ApplicationSummary[];
  selectedApplication?: ManagedApplication | null;
  snapshots: Page<SnapshotSummary>;
  selected: InventorySnapshot | null;
  history: Page<BaselineSummary>;
  headObservation: HeadObservation | null;
  freshness: Freshness;
  profile: VerificationProfile;
  runner: "unavailable";
}
