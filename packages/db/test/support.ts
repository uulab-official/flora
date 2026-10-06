import * as store from "@app-ops/db";
import { resolveSnapshot } from "@app-ops/config";
import { catalog, target, source } from "../../../tests/fixtures.ts";
export async function setup(path = ":memory:") {
  const db = store.openDatabase(path);
  store.migrate(db);
  store.insertCatalog(db, catalog);
  store.saveTarget(db, target);
  store.saveSource(db, source);
  const snapshot = await resolveSnapshot({ target, source, entries: [] });
  await store.saveSnapshot(db, snapshot);
  store.createRelease(db, {
    id: "release_demo",
    organizationId: "org_demo",
    applicationId: "app_demo",
    sourceRevisionId: "source_demo",
    version: "1.0.0",
    createdBy: "user_demo",
  });
  return { db, snapshot };
}
