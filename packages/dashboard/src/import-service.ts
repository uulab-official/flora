import { ensure } from "@app-ops/core";
import { assessReport, CONFIG_RUNTIME_SMOKE_V1, parseBaselineBundle, parseSourceBundle } from "@app-ops/dogfood";
import type { HeadObservation, ImportStore, InventorySnapshot, VerificationRecord } from "@app-ops/dogfood";

export interface ImportService {
  importSource(bytes: Uint8Array): Promise<InventorySnapshot>;
  importBaseline(snapshotId: string, bytes: Uint8Array): Promise<VerificationRecord>;
  importHead(observation: HeadObservation): Promise<void>;
}

/** Portable original-envelope import. The caller owns admission and storage. */
export function createImportService(store: ImportStore, now: () => number): ImportService {
  return {
    async importSource(bytes) {
      return store.saveInventory(await parseSourceBundle(bytes, now()));
    },
    async importBaseline(snapshotId, bytes) {
      ensure(bytes instanceof Uint8Array && bytes.length <= 2 * 1024 * 1024);
      const owned = Uint8Array.from(bytes);
      const snapshot = await store.getInventory(snapshotId); ensure(snapshot, "NOT_FOUND");
      const evidence = await parseBaselineBundle(owned, snapshot);
      return store.persistBaseline({ snapshotId, evidence, assessment: assessReport(evidence, CONFIG_RUNTIME_SMOKE_V1), now: now() });
    },
    async importHead(observation) { await store.saveHeadObservation(observation); },
  };
}
