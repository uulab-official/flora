import type { D1Database, DurableObjectNamespace, Fetcher } from "@cloudflare/workers-types";
import type { Freshness, HeadObservation, ImportStore, InventorySnapshot, VerificationProfile, VerificationRecord } from "@app-ops/dogfood";

export interface SetupWindow {
  digest: string;
  issuedAt: number;
  expiresAt: number;
  generation: number;
  purpose: "enroll" | "recover";
}
export interface FloraConfig {
  origin: string;
  ownerId: string;
  ownerEmail: string;
  dbIdentity: string;
  setup: SetupWindow | null;
}
export interface FloraEnv {
  FLORA_ORIGIN: string;
  FLORA_OWNER_ID: string;
  FLORA_OWNER_EMAIL: string;
  FLORA_DB_IDENTITY: string;
  FLORA_SETUP?: SetupWindow;
  FLORA_DB: D1Database;
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
  pageInventory(cursor: string | null): Promise<Page<SnapshotSummary>>;
  pageBaselines(snapshotId: string, cursor: string | null): Promise<Page<BaselineSummary>>;
  getSafeLog(recordId: string): Promise<SafeLog | null>;
}
export type HostedStore = ImportStore & HostedReadStore;
export interface HostedState {
  snapshots: Page<SnapshotSummary>;
  selected: InventorySnapshot | null;
  history: Page<BaselineSummary>;
  headObservation: HeadObservation | null;
  freshness: Freshness;
  profile: VerificationProfile;
  runner: "unavailable";
}
