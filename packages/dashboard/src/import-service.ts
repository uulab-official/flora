import { ensure } from "@app-ops/core";
import { applicationId, assessReport, CONFIG_RUNTIME_SMOKE_V1, parseBaselineBundle, parseSourceBundle } from "@app-ops/dogfood";
import type { HeadObservation, ImportStore, InventorySnapshot, VerificationRecord } from "@app-ops/dogfood";

export interface ImportService {
  importSource(bytes: Uint8Array, appId?: string): Promise<InventorySnapshot>;
  importBaseline(snapshotId: string, bytes: Uint8Array, appId?: string): Promise<VerificationRecord>;
  importHead(observation: HeadObservation, appId?: string): Promise<void>;
}

export async function assertApplicationSource(store: ImportStore, appId: string | undefined, source: { repository: { id: string }; rootDirectory: string }): Promise<void> {
  if (appId === undefined) return;
  const app = await store.applications?.getApplication(applicationId(appId));
  ensure(app && app.repositoryId === source.repository.id && app.rootDirectory === source.rootDirectory, "NOT_FOUND");
}

/** Portable original-envelope import. The caller owns admission and storage. */
export function createImportService(store: ImportStore, now: () => number): ImportService {
  return {
    async importSource(bytes, appId) {
      const snapshot = await parseSourceBundle(bytes, now());
      await assertApplicationSource(store, appId, snapshot);
      return store.saveInventory(snapshot);
    },
    async importBaseline(snapshotId, bytes, appId) {
      ensure(bytes instanceof Uint8Array && bytes.length <= 2 * 1024 * 1024);
      const owned = Uint8Array.from(bytes);
      const snapshot = await store.getInventory(snapshotId); ensure(snapshot, "NOT_FOUND");
      await assertApplicationSource(store, appId, snapshot);
      const evidence = await parseBaselineBundle(owned, snapshot);
      return store.persistBaseline({ snapshotId, evidence, assessment: assessReport(evidence, CONFIG_RUNTIME_SMOKE_V1), now: now() });
    },
    async importHead(observation, appId) {
      await assertApplicationSource(store, appId, { repository: { id: observation.repositoryId }, rootDirectory: observation.rootDirectory });
      await store.saveHeadObservation(observation);
    },
  };
}
