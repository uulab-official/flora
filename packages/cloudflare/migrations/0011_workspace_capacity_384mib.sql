-- Hosted D1 only. Prerequisite: complete 0001-0010 migrations.
-- Execute this ENTIRE file in ONE migration transaction, never isolated statements.
-- Raise only the shared canonical-payload ceiling from 320 to 384 MiB.
-- Physical database usage additionally includes indexes/accounting; retain free
-- D1 headroom and inspect actual size before applying. This is a bounded ceiling.
-- Rebuild only the one counter row and eighteen incremental ledger rows because
-- their CHECK constraints include the ceiling. Copy every value unchanged.
-- Never recalculate, repair, delete or rewrite source/history/facts/keys.
-- Restore the same 45 dependent triggers, changing only 18 admission ceilings.
-- Constant-cost ledger integrity, immutable history, manual rollback provenance,
-- app96MiB/count128, per-asset16MiB and witness/fact ceilings remain unchanged.
-- Validate prerequisites and existing accounting before dropping either table.
CREATE TABLE flora_capacity_384mib_check(assertion INTEGER NOT NULL CHECK(assertion=1)) STRICT;
INSERT INTO flora_capacity_384mib_check SELECT CASE WHEN
  (SELECT count(*) FROM flora_capacity)=1
  AND (SELECT count(*) FROM flora_capacity_ledger)=18
  AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='flora_capacity' AND sql LIKE '%payload_bytes BETWEEN 0 AND 335544320%')
  AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='flora_capacity_ledger' AND sql LIKE '%payload_bytes BETWEEN 0 AND 335544320%')
  AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='capacity_facts_table_sequence')
  AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='ota_rollback_binding' AND sql LIKE '%rollback provenance mismatch%')
  AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='ota_connection_current' AND sql LIKE '%json_type(NEW.data,%rollback%')
  AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='capacity_integrity' AND sql LIKE '%flora_capacity_ledger%' AND sql NOT LIKE '%FROM inventory_snapshots%')
  AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='ota_app_capacity' AND sql LIKE '%>100663296%' AND sql LIKE '%>=128%')
  THEN 1 ELSE 0 END;
-- This no-op validates the existing aggregate with the current constant-cost
-- integrity trigger. Any mismatch aborts instead of changing recorded usage.
UPDATE flora_capacity SET snapshot_count=snapshot_count,baseline_count=baseline_count,payload_bytes=payload_bytes;
CREATE TABLE flora_capacity_384mib (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  snapshot_count INTEGER NOT NULL CHECK(snapshot_count BETWEEN 0 AND 100),
  baseline_count INTEGER NOT NULL CHECK(baseline_count BETWEEN 0 AND 500),
  payload_bytes INTEGER NOT NULL CHECK(payload_bytes BETWEEN 0 AND 402653184)
) STRICT;
CREATE TABLE flora_capacity_ledger_384mib (
  table_name TEXT PRIMARY KEY CHECK(table_name IN('inventory_snapshots','baseline_imports','source_head_observations','applications','application_settings','github_connections','github_detections','ota_assets','ota_asset_chunks','ota_deployments','ota_deployment_assets','automation_runners','automation_jobs','automation_transitions','automation_guards','automation_asset_refs','automation_policies','automation_publications')),
  row_count INTEGER NOT NULL CHECK(row_count BETWEEN 0 AND 262144),
  payload_bytes INTEGER NOT NULL CHECK(payload_bytes BETWEEN 0 AND 402653184),
  witness_bytes INTEGER NOT NULL CHECK(witness_bytes BETWEEN 0 AND 33554432),
  last_sequence INTEGER,
  CHECK((row_count=0 AND payload_bytes=0 AND witness_bytes=0 AND last_sequence IS NULL) OR (row_count>0 AND last_sequence IS NOT NULL AND last_sequence>0))
) STRICT, WITHOUT ROWID;
INSERT INTO flora_capacity_384mib(singleton,snapshot_count,baseline_count,payload_bytes) SELECT singleton,snapshot_count,baseline_count,payload_bytes FROM flora_capacity;
INSERT INTO flora_capacity_ledger_384mib(table_name,row_count,payload_bytes,witness_bytes,last_sequence) SELECT table_name,row_count,payload_bytes,witness_bytes,last_sequence FROM flora_capacity_ledger;
DROP TRIGGER application_account;
DROP TRIGGER application_capacity;
DROP TRIGGER automation_asset_refs_account;
DROP TRIGGER automation_asset_refs_capacity;
DROP TRIGGER automation_guards_account;
DROP TRIGGER automation_guards_capacity;
DROP TRIGGER automation_jobs_account;
DROP TRIGGER automation_jobs_capacity;
DROP TRIGGER automation_policies_account;
DROP TRIGGER automation_policies_capacity;
DROP TRIGGER automation_publications_account;
DROP TRIGGER automation_publications_capacity;
DROP TRIGGER automation_runners_account;
DROP TRIGGER automation_runners_capacity;
DROP TRIGGER automation_transitions_account;
DROP TRIGGER automation_transitions_capacity;
DROP TRIGGER baseline_account;
DROP TRIGGER baseline_capacity;
DROP TRIGGER capacity_delete;
DROP TRIGGER capacity_facts_account;
DROP TRIGGER capacity_facts_capacity;
DROP TRIGGER capacity_integrity;
DROP TRIGGER capacity_ledger_advance;
DROP TRIGGER capacity_ledger_delete;
DROP TRIGGER capacity_ledger_identity;
DROP TRIGGER capacity_ledger_insert;
DROP TRIGGER capacity_replace;
DROP TRIGGER github_connections_account;
DROP TRIGGER github_connections_capacity;
DROP TRIGGER github_detections_account;
DROP TRIGGER github_detections_capacity;
DROP TRIGGER head_account;
DROP TRIGGER head_capacity;
DROP TRIGGER inventory_account;
DROP TRIGGER inventory_capacity;
DROP TRIGGER ota_asset_chunks_account;
DROP TRIGGER ota_asset_chunks_capacity;
DROP TRIGGER ota_assets_account;
DROP TRIGGER ota_assets_capacity;
DROP TRIGGER ota_deployment_assets_account;
DROP TRIGGER ota_deployment_assets_capacity;
DROP TRIGGER ota_deployments_account;
DROP TRIGGER ota_deployments_capacity;
DROP TRIGGER settings_account;
DROP TRIGGER settings_capacity;
DROP TABLE flora_capacity;
DROP TABLE flora_capacity_ledger;
ALTER TABLE flora_capacity_384mib RENAME TO flora_capacity;
ALTER TABLE flora_capacity_ledger_384mib RENAME TO flora_capacity_ledger;
CREATE TRIGGER application_account AFTER INSERT ON applications BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('applications',json_array(NEW.owner_id,NEW.id),NEW.stored_bytes,length(CAST(json_array('applications',json_array(NEW.owner_id,NEW.id)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
CREATE TRIGGER application_capacity BEFORE INSERT ON applications
  WHEN NEW.stored_bytes=0 OR (SELECT count(*) FROM applications)>=100 OR NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=402653184)
  BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER automation_asset_refs_account AFTER INSERT ON automation_asset_refs BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('automation_asset_refs',json_array(NEW.owner_id,NEW.app_id,NEW.job_id,NEW.attempt_id,NEW.asset_hash),NEW.stored_bytes,length(CAST(json_array('automation_asset_refs',json_array(NEW.owner_id,NEW.app_id,NEW.job_id,NEW.attempt_id,NEW.asset_hash)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
CREATE TRIGGER automation_asset_refs_capacity BEFORE INSERT ON automation_asset_refs WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=402653184) BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER automation_guards_account AFTER INSERT ON automation_guards BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('automation_guards',json_array(NEW.owner_id,NEW.app_id,NEW.id),NEW.stored_bytes,length(CAST(json_array('automation_guards',json_array(NEW.owner_id,NEW.app_id,NEW.id)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
CREATE TRIGGER automation_guards_capacity BEFORE INSERT ON automation_guards WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=402653184) BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER automation_jobs_account AFTER INSERT ON automation_jobs BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('automation_jobs',json_array(NEW.owner_id,NEW.app_id,NEW.id),NEW.stored_bytes,length(CAST(json_array('automation_jobs',json_array(NEW.owner_id,NEW.app_id,NEW.id)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
CREATE TRIGGER automation_jobs_capacity BEFORE INSERT ON automation_jobs WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=402653184) BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER automation_policies_account AFTER INSERT ON automation_policies BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('automation_policies',json_array(NEW.owner_id,NEW.app_id,NEW.version),NEW.stored_bytes,length(CAST(json_array('automation_policies',json_array(NEW.owner_id,NEW.app_id,NEW.version)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
CREATE TRIGGER automation_policies_capacity BEFORE INSERT ON automation_policies WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=402653184) BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER automation_publications_account AFTER INSERT ON automation_publications BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('automation_publications',json_array(NEW.owner_id,NEW.app_id,NEW.job_id),NEW.stored_bytes,length(CAST(json_array('automation_publications',json_array(NEW.owner_id,NEW.app_id,NEW.job_id)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
CREATE TRIGGER automation_publications_capacity BEFORE INSERT ON automation_publications WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=402653184) BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER automation_runners_account AFTER INSERT ON automation_runners BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('automation_runners',json_array(NEW.owner_id,NEW.id,NEW.version),NEW.stored_bytes,length(CAST(json_array('automation_runners',json_array(NEW.owner_id,NEW.id,NEW.version)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
CREATE TRIGGER automation_runners_capacity BEFORE INSERT ON automation_runners WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=402653184) BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER automation_transitions_account AFTER INSERT ON automation_transitions BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('automation_transitions',json_array(NEW.owner_id,NEW.app_id,NEW.job_id,NEW.version),NEW.stored_bytes,length(CAST(json_array('automation_transitions',json_array(NEW.owner_id,NEW.app_id,NEW.job_id,NEW.version)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
CREATE TRIGGER automation_transitions_capacity BEFORE INSERT ON automation_transitions WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=402653184) BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER baseline_account AFTER INSERT ON baseline_imports BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('baseline_imports',json_array(NEW.owner_id,NEW.id),NEW.stored_bytes,length(CAST(json_array('baseline_imports',json_array(NEW.owner_id,NEW.id)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET baseline_count=baseline_count+1,payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
CREATE TRIGGER baseline_capacity BEFORE INSERT ON baseline_imports
  WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE singleton=1 AND baseline_count<500 AND payload_bytes+NEW.stored_bytes<=402653184)
  BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER capacity_delete BEFORE DELETE ON flora_capacity BEGIN SELECT RAISE(ABORT,'immutable capacity'); END;
CREATE TRIGGER capacity_facts_account AFTER INSERT ON flora_capacity_facts BEGIN
  UPDATE flora_capacity_ledger SET row_count=row_count+1,payload_bytes=payload_bytes+NEW.stored_bytes,witness_bytes=witness_bytes+NEW.witness_bytes,last_sequence=NEW.sequence WHERE table_name=NEW.table_name;
END;
CREATE TRIGGER capacity_facts_capacity BEFORE INSERT ON flora_capacity_facts
  WHEN NOT EXISTS(SELECT 1 FROM (SELECT sum(row_count) n,sum(witness_bytes) bytes FROM flora_capacity_ledger) WHERE n<262144 AND bytes+NEW.witness_bytes<=33554432)
  BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER capacity_integrity BEFORE UPDATE ON flora_capacity
  WHEN NEW.singleton<>1
    OR NEW.snapshot_count IS NOT (SELECT row_count FROM flora_capacity_ledger WHERE table_name='inventory_snapshots')
    OR NEW.baseline_count IS NOT (SELECT row_count FROM flora_capacity_ledger WHERE table_name='baseline_imports')
    OR NOT EXISTS(SELECT 1 FROM (SELECT count(*) n,sum(payload_bytes) payload,sum(witness_bytes) witness,sum(row_count) facts FROM flora_capacity_ledger) WHERE n=18 AND payload=NEW.payload_bytes AND witness<=33554432 AND facts<=262144)
  BEGIN SELECT RAISE(ABORT,'invalid capacity accounting'); END;
CREATE TRIGGER capacity_ledger_advance BEFORE UPDATE ON flora_capacity_ledger
  WHEN NEW.row_count<>OLD.row_count+1
    OR NEW.last_sequence IS NULL
    OR (OLD.last_sequence IS NOT NULL AND NEW.last_sequence<=OLD.last_sequence)
    OR NEW.last_sequence IS NOT (SELECT sequence FROM flora_capacity_facts WHERE table_name=OLD.table_name ORDER BY sequence DESC LIMIT 1)
    OR NOT EXISTS(SELECT 1 FROM flora_capacity_facts WHERE sequence=NEW.last_sequence AND table_name=OLD.table_name AND NEW.payload_bytes=OLD.payload_bytes+stored_bytes AND NEW.witness_bytes=OLD.witness_bytes+witness_bytes)
  BEGIN SELECT RAISE(ABORT,'invalid capacity ledger'); END;
CREATE TRIGGER capacity_ledger_delete BEFORE DELETE ON flora_capacity_ledger BEGIN SELECT RAISE(ABORT,'immutable capacity ledger'); END;
CREATE TRIGGER capacity_ledger_identity BEFORE UPDATE ON flora_capacity_ledger WHEN NEW.table_name IS NOT OLD.table_name BEGIN SELECT RAISE(ABORT,'immutable capacity ledger'); END;
CREATE TRIGGER capacity_ledger_insert BEFORE INSERT ON flora_capacity_ledger BEGIN SELECT RAISE(ABORT,'immutable capacity ledger'); END;
CREATE TRIGGER capacity_replace BEFORE INSERT ON flora_capacity WHEN EXISTS(SELECT 1 FROM flora_capacity)
  BEGIN SELECT RAISE(ABORT,'immutable capacity'); END;
CREATE TRIGGER github_connections_account AFTER INSERT ON github_connections BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('github_connections',json_array(NEW.owner_id,NEW.app_id,NEW.version),NEW.stored_bytes,length(CAST(json_array('github_connections',json_array(NEW.owner_id,NEW.app_id,NEW.version)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
CREATE TRIGGER github_connections_capacity BEFORE INSERT ON github_connections WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=402653184) BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER github_detections_account AFTER INSERT ON github_detections BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('github_detections',json_array(NEW.owner_id,NEW.app_id,NEW.id),NEW.stored_bytes,length(CAST(json_array('github_detections',json_array(NEW.owner_id,NEW.app_id,NEW.id)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
CREATE TRIGGER github_detections_capacity BEFORE INSERT ON github_detections WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=402653184) BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER head_account AFTER INSERT ON source_head_observations BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('source_head_observations',json_array(NEW.owner_id,NEW.sequence),NEW.stored_bytes,length(CAST(json_array('source_head_observations',json_array(NEW.owner_id,NEW.sequence)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
CREATE TRIGGER head_capacity BEFORE INSERT ON source_head_observations
  WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE singleton=1 AND payload_bytes+NEW.stored_bytes<=402653184)
  BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER inventory_account AFTER INSERT ON inventory_snapshots BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('inventory_snapshots',json_array(NEW.owner_id,NEW.id),NEW.stored_bytes,length(CAST(json_array('inventory_snapshots',json_array(NEW.owner_id,NEW.id)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET snapshot_count=snapshot_count+1,payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
CREATE TRIGGER inventory_capacity BEFORE INSERT ON inventory_snapshots
  WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE singleton=1 AND snapshot_count<100 AND payload_bytes+NEW.stored_bytes<=402653184)
  BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER ota_asset_chunks_account AFTER INSERT ON ota_asset_chunks BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('ota_asset_chunks',json_array(NEW.owner_id,NEW.app_id,NEW.hash,NEW.chunk_index),NEW.stored_bytes,length(CAST(json_array('ota_asset_chunks',json_array(NEW.owner_id,NEW.app_id,NEW.hash,NEW.chunk_index)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
CREATE TRIGGER ota_asset_chunks_capacity BEFORE INSERT ON ota_asset_chunks WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=402653184) BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER ota_assets_account AFTER INSERT ON ota_assets BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('ota_assets',json_array(NEW.owner_id,NEW.app_id,NEW.hash),NEW.stored_bytes,length(CAST(json_array('ota_assets',json_array(NEW.owner_id,NEW.app_id,NEW.hash)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
CREATE TRIGGER ota_assets_capacity BEFORE INSERT ON ota_assets WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=402653184) BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER ota_deployment_assets_account AFTER INSERT ON ota_deployment_assets BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('ota_deployment_assets',json_array(NEW.owner_id,NEW.app_id,NEW.deployment_id,NEW.hash),NEW.stored_bytes,length(CAST(json_array('ota_deployment_assets',json_array(NEW.owner_id,NEW.app_id,NEW.deployment_id,NEW.hash)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
CREATE TRIGGER ota_deployment_assets_capacity BEFORE INSERT ON ota_deployment_assets WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=402653184) BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER ota_deployments_account AFTER INSERT ON ota_deployments BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('ota_deployments',json_array(NEW.owner_id,NEW.app_id,NEW.id),NEW.stored_bytes,length(CAST(json_array('ota_deployments',json_array(NEW.owner_id,NEW.app_id,NEW.id)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
CREATE TRIGGER ota_deployments_capacity BEFORE INSERT ON ota_deployments WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=402653184) BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER settings_account AFTER INSERT ON application_settings BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('application_settings',json_array(NEW.owner_id,NEW.app_id,NEW.version),NEW.stored_bytes,length(CAST(json_array('application_settings',json_array(NEW.owner_id,NEW.app_id,NEW.version)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
CREATE TRIGGER settings_capacity BEFORE INSERT ON application_settings
  WHEN NEW.stored_bytes=0 OR NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=402653184)
  BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
-- Validate the restored incremental counter guard without scanning source tables.
UPDATE flora_capacity SET snapshot_count=snapshot_count,baseline_count=baseline_count,payload_bytes=payload_bytes;
DROP TABLE flora_capacity_384mib_check;
