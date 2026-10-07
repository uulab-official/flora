import { openDatabase, migrate, createSqliteDogfoodStore } from "@app-ops/db";
import { createBlockedProvider, createDogfoodService, startDashboard } from "@app-ops/dashboard";
import { syntheticSourceBundle, syntheticBaseline } from "../../tests/dogfood-fixtures.ts";

/** Test harness only: synthetic fixtures, in-memory store, and the blocked provider. */
export async function createQaHarness() {
  const db = openDatabase(":memory:"); migrate(db); const store = createSqliteDogfoodStore(db);
  const service = await createDogfoodService(store, [createBlockedProvider()], Date.now);
  let dashboard;
  try { dashboard = await startDashboard({ service }); }
  catch (error) { await service.close(); db.close(); throw error; }
  return {
    origin: dashboard.origin, bootstrapUrl: dashboard.bootstrapUrl,
    source(second = false) { const source = syntheticSourceBundle(); return second ? { ...source, commitSha: "b".repeat(40) } : source; },
    state() { return service.getState(); },
    async baseline() { const state = await service.getState(); const selected = state.snapshots.find(snapshot => snapshot.id === state.selectedSnapshotId); if (!selected) throw new Error("QA_SOURCE_REQUIRED"); return syntheticBaseline(selected); },
    async seedQueued() {
      const state = await service.getState(); if (!state.selectedSnapshotId) throw new Error("QA_SOURCE_REQUIRED");
      // A display/interaction fixture, never a provider launch or successful result.
      return (await store.createVerification({ snapshotId: state.selectedSnapshotId, requestKey: "synthetic-queued-display-only", now: Date.now() })).record;
    },
    async close() { await dashboard.close(); await service.close(); db.close(); },
  };
}
