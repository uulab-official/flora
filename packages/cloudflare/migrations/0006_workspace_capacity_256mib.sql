-- Expands the bounded workspace canonical-payload budget from 192 to 256 MiB.
-- Apply the complete file as one D1 migration transaction. No data/history table
-- is rebuilt or deleted; the single counter row is copied without recalculation.
-- SQLite CHECK constraints require rebuilding only the flora_capacity table.
-- All 39 dependent triggers are restored. Only the 18 workspace admission
-- thresholds change; row limits, immutable bindings and per-app caps stay intact.
CREATE TABLE flora_capacity_256mib (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  snapshot_count INTEGER NOT NULL CHECK(snapshot_count BETWEEN 0 AND 100),
  baseline_count INTEGER NOT NULL CHECK(baseline_count BETWEEN 0 AND 500),
  payload_bytes INTEGER NOT NULL CHECK(payload_bytes BETWEEN 0 AND 268435456)
) STRICT;
INSERT INTO flora_capacity_256mib(singleton,snapshot_count,baseline_count,payload_bytes)
  SELECT singleton,snapshot_count,baseline_count,payload_bytes FROM flora_capacity;
DROP TRIGGER capacity_delete;
DROP TRIGGER capacity_integrity;
DROP TRIGGER inventory_capacity;
DROP TRIGGER baseline_capacity;
DROP TRIGGER head_capacity;
DROP TRIGGER inventory_account;
DROP TRIGGER baseline_account;
DROP TRIGGER head_account;
DROP TRIGGER capacity_replace;
DROP TRIGGER application_capacity;
DROP TRIGGER settings_capacity;
DROP TRIGGER application_account;
DROP TRIGGER settings_account;
DROP TRIGGER github_connections_capacity;
DROP TRIGGER github_connections_account;
DROP TRIGGER github_detections_capacity;
DROP TRIGGER github_detections_account;
DROP TRIGGER ota_assets_capacity;
DROP TRIGGER ota_assets_account;
DROP TRIGGER ota_asset_chunks_capacity;
DROP TRIGGER ota_asset_chunks_account;
DROP TRIGGER ota_deployments_capacity;
DROP TRIGGER ota_deployments_account;
DROP TRIGGER ota_deployment_assets_capacity;
DROP TRIGGER ota_deployment_assets_account;
DROP TRIGGER automation_runners_capacity;
DROP TRIGGER automation_runners_account;
DROP TRIGGER automation_jobs_capacity;
DROP TRIGGER automation_jobs_account;
DROP TRIGGER automation_transitions_capacity;
DROP TRIGGER automation_transitions_account;
DROP TRIGGER automation_guards_capacity;
DROP TRIGGER automation_guards_account;
DROP TRIGGER automation_asset_refs_capacity;
DROP TRIGGER automation_asset_refs_account;
DROP TRIGGER automation_policies_capacity;
DROP TRIGGER automation_policies_account;
DROP TRIGGER automation_publications_capacity;
DROP TRIGGER automation_publications_account;
DROP TABLE flora_capacity;
ALTER TABLE flora_capacity_256mib RENAME TO flora_capacity;
CREATE TRIGGER capacity_delete BEFORE DELETE ON flora_capacity BEGIN SELECT RAISE(ABORT,'immutable capacity'); END;
CREATE TRIGGER capacity_integrity BEFORE UPDATE ON flora_capacity WHEN NEW.singleton<>1 OR NEW.snapshot_count<>(SELECT count(*) FROM inventory_snapshots) OR NEW.baseline_count<>(SELECT count(*) FROM baseline_imports) OR NEW.payload_bytes<>(SELECT coalesce(sum(stored_bytes),0) FROM inventory_snapshots)+(SELECT coalesce(sum(stored_bytes),0) FROM baseline_imports)+(SELECT coalesce(sum(stored_bytes),0) FROM source_head_observations)+(SELECT coalesce(sum(stored_bytes),0) FROM applications)+(SELECT coalesce(sum(stored_bytes),0) FROM application_settings)+(SELECT coalesce(sum(stored_bytes),0) FROM github_connections)+(SELECT coalesce(sum(stored_bytes),0) FROM github_detections)+(SELECT coalesce(sum(stored_bytes),0) FROM ota_assets)+(SELECT coalesce(sum(stored_bytes),0) FROM ota_asset_chunks)+(SELECT coalesce(sum(stored_bytes),0) FROM ota_deployments)+(SELECT coalesce(sum(stored_bytes),0) FROM ota_deployment_assets)+(SELECT coalesce(sum(stored_bytes),0) FROM automation_runners)+(SELECT coalesce(sum(stored_bytes),0) FROM automation_jobs)+(SELECT coalesce(sum(stored_bytes),0) FROM automation_transitions)+(SELECT coalesce(sum(stored_bytes),0) FROM automation_guards)+(SELECT coalesce(sum(stored_bytes),0) FROM automation_asset_refs)+(SELECT coalesce(sum(stored_bytes),0) FROM automation_policies)+(SELECT coalesce(sum(stored_bytes),0) FROM automation_publications) BEGIN SELECT RAISE(ABORT,'invalid capacity accounting'); END;
CREATE TRIGGER inventory_capacity BEFORE INSERT ON inventory_snapshots
  WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE singleton=1 AND snapshot_count<100 AND payload_bytes+NEW.stored_bytes<=268435456)
  BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER baseline_capacity BEFORE INSERT ON baseline_imports
  WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE singleton=1 AND baseline_count<500 AND payload_bytes+NEW.stored_bytes<=268435456)
  BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER head_capacity BEFORE INSERT ON source_head_observations
  WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE singleton=1 AND payload_bytes+NEW.stored_bytes<=268435456)
  BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER inventory_account AFTER INSERT ON inventory_snapshots
  BEGIN UPDATE flora_capacity SET snapshot_count=snapshot_count+1,payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1; END;
CREATE TRIGGER baseline_account AFTER INSERT ON baseline_imports
  BEGIN UPDATE flora_capacity SET baseline_count=baseline_count+1,payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1; END;
CREATE TRIGGER head_account AFTER INSERT ON source_head_observations
  BEGIN UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1; END;
CREATE TRIGGER capacity_replace BEFORE INSERT ON flora_capacity WHEN EXISTS(SELECT 1 FROM flora_capacity)
  BEGIN SELECT RAISE(ABORT,'immutable capacity'); END;
CREATE TRIGGER application_capacity BEFORE INSERT ON applications
  WHEN NEW.stored_bytes=0 OR (SELECT count(*) FROM applications)>=100 OR NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=268435456)
  BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER settings_capacity BEFORE INSERT ON application_settings
  WHEN NEW.stored_bytes=0 OR NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=268435456)
  BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER application_account AFTER INSERT ON applications BEGIN UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1; END;
CREATE TRIGGER settings_account AFTER INSERT ON application_settings BEGIN UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1; END;
CREATE TRIGGER github_connections_capacity BEFORE INSERT ON github_connections WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=268435456) BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER github_connections_account AFTER INSERT ON github_connections BEGIN UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1; END;
CREATE TRIGGER github_detections_capacity BEFORE INSERT ON github_detections WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=268435456) BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER github_detections_account AFTER INSERT ON github_detections BEGIN UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1; END;
CREATE TRIGGER ota_assets_capacity BEFORE INSERT ON ota_assets WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=268435456) BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER ota_assets_account AFTER INSERT ON ota_assets BEGIN UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1; END;
CREATE TRIGGER ota_asset_chunks_capacity BEFORE INSERT ON ota_asset_chunks WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=268435456) BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER ota_asset_chunks_account AFTER INSERT ON ota_asset_chunks BEGIN UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1; END;
CREATE TRIGGER ota_deployments_capacity BEFORE INSERT ON ota_deployments WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=268435456) BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER ota_deployments_account AFTER INSERT ON ota_deployments BEGIN UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1; END;
CREATE TRIGGER ota_deployment_assets_capacity BEFORE INSERT ON ota_deployment_assets WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=268435456) BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER ota_deployment_assets_account AFTER INSERT ON ota_deployment_assets BEGIN UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1; END;
CREATE TRIGGER automation_runners_capacity BEFORE INSERT ON automation_runners WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=268435456) BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER automation_runners_account AFTER INSERT ON automation_runners BEGIN UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1; END;
CREATE TRIGGER automation_jobs_capacity BEFORE INSERT ON automation_jobs WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=268435456) BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER automation_jobs_account AFTER INSERT ON automation_jobs BEGIN UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1; END;
CREATE TRIGGER automation_transitions_capacity BEFORE INSERT ON automation_transitions WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=268435456) BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER automation_transitions_account AFTER INSERT ON automation_transitions BEGIN UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1; END;
CREATE TRIGGER automation_guards_capacity BEFORE INSERT ON automation_guards WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=268435456) BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER automation_guards_account AFTER INSERT ON automation_guards BEGIN UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1; END;
CREATE TRIGGER automation_asset_refs_capacity BEFORE INSERT ON automation_asset_refs WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=268435456) BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER automation_asset_refs_account AFTER INSERT ON automation_asset_refs BEGIN UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1; END;
CREATE TRIGGER automation_policies_capacity BEFORE INSERT ON automation_policies WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=268435456) BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER automation_policies_account AFTER INSERT ON automation_policies BEGIN UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1; END;
CREATE TRIGGER automation_publications_capacity BEFORE INSERT ON automation_publications WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=268435456) BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER automation_publications_account AFTER INSERT ON automation_publications BEGIN UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1; END;
-- Re-run the unchanged accounting-integrity guard against all existing rows.
-- Any mismatch aborts the entire migration rather than repairing the counter.
UPDATE flora_capacity SET snapshot_count=snapshot_count,baseline_count=baseline_count,payload_bytes=payload_bytes;
