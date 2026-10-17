-- Stable incremental workspace accounting. Prerequisite: complete 0001-0006.
-- Execute this ENTIRE file in ONE migration transaction, never isolated statements.
-- Existing source/history rows, charged counters, 256 MiB payload ceiling and all
-- existing authority/lease/provenance/application guards remain unchanged.
-- A minimal immutable fact identifies each source row by its canonical logical PK.
-- Its explicit INTEGER PRIMARY KEY AUTOINCREMENT is stable across SQLite VACUUM;
-- neither the witness nor the aggregate persists a hidden source rowid.
-- Accounting metadata is separately bounded: 16 KiB key, 32 MiB canonical witness
-- payload, 262144 witnesses. It contains no source JSON, assets, tokens or keys.
-- The indexed legacy -1 preflight runs before any schema changes. SQLite's
-- BEFORE INSERT auto-rowid is unspecified (currently -1); AFTER INSERT rejects
-- any new actual -1 rowid so this conservative collision-check invariant holds.
UPDATE flora_capacity SET singleton=CASE WHEN NOT EXISTS(SELECT 1 FROM inventory_snapshots WHERE rowid=-1) AND NOT EXISTS(SELECT 1 FROM baseline_imports WHERE rowid=-1) AND NOT EXISTS(SELECT 1 FROM source_head_observations WHERE rowid=-1) AND NOT EXISTS(SELECT 1 FROM applications WHERE rowid=-1) AND NOT EXISTS(SELECT 1 FROM application_settings WHERE rowid=-1) AND NOT EXISTS(SELECT 1 FROM github_connections WHERE rowid=-1) AND NOT EXISTS(SELECT 1 FROM github_detections WHERE rowid=-1) AND NOT EXISTS(SELECT 1 FROM ota_assets WHERE rowid=-1) AND NOT EXISTS(SELECT 1 FROM ota_asset_chunks WHERE rowid=-1) AND NOT EXISTS(SELECT 1 FROM ota_deployments WHERE rowid=-1) AND NOT EXISTS(SELECT 1 FROM ota_deployment_assets WHERE rowid=-1) AND NOT EXISTS(SELECT 1 FROM automation_runners WHERE rowid=-1) AND NOT EXISTS(SELECT 1 FROM automation_jobs WHERE rowid=-1) AND NOT EXISTS(SELECT 1 FROM automation_transitions WHERE rowid=-1) AND NOT EXISTS(SELECT 1 FROM automation_guards WHERE rowid=-1) AND NOT EXISTS(SELECT 1 FROM automation_asset_refs WHERE rowid=-1) AND NOT EXISTS(SELECT 1 FROM automation_policies WHERE rowid=-1) AND NOT EXISTS(SELECT 1 FROM automation_publications WHERE rowid=-1) THEN singleton ELSE 0 END,snapshot_count=snapshot_count,baseline_count=baseline_count,payload_bytes=payload_bytes;
CREATE TABLE flora_capacity_ledger_check (assertion INTEGER NOT NULL CHECK(assertion=1)) STRICT;
INSERT INTO flora_capacity_ledger_check SELECT CASE WHEN (SELECT count(*) FROM flora_capacity)=1 AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='flora_capacity' AND sql LIKE '%payload_bytes BETWEEN 0 AND 268435456%') THEN 1 ELSE 0 END;
CREATE TABLE flora_capacity_facts (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK(sequence>0),
  table_name TEXT NOT NULL CHECK(table_name IN('inventory_snapshots','baseline_imports','source_head_observations','applications','application_settings','github_connections','github_detections','ota_assets','ota_asset_chunks','ota_deployments','ota_deployment_assets','automation_runners','automation_jobs','automation_transitions','automation_guards','automation_asset_refs','automation_policies','automation_publications')),
  record_key TEXT NOT NULL CHECK(json_valid(record_key) AND json_type(record_key)='array' AND length(CAST(record_key AS BLOB)) BETWEEN 1 AND 16384),
  stored_bytes INTEGER NOT NULL CHECK(stored_bytes BETWEEN 0 AND 1048576),
  witness_bytes INTEGER NOT NULL CHECK(witness_bytes BETWEEN 1 AND 65536 AND witness_bytes=length(CAST(json_array(table_name,record_key||'',stored_bytes) AS BLOB))),
  UNIQUE(table_name,record_key)
) STRICT;
CREATE INDEX capacity_facts_table_sequence ON flora_capacity_facts(table_name,sequence DESC);
INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) SELECT 'inventory_snapshots',json_array(owner_id,id),stored_bytes,length(CAST(json_array('inventory_snapshots',json_array(owner_id,id)||'',stored_bytes) AS BLOB)) FROM inventory_snapshots;
INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) SELECT 'baseline_imports',json_array(owner_id,id),stored_bytes,length(CAST(json_array('baseline_imports',json_array(owner_id,id)||'',stored_bytes) AS BLOB)) FROM baseline_imports;
INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) SELECT 'source_head_observations',json_array(owner_id,sequence),stored_bytes,length(CAST(json_array('source_head_observations',json_array(owner_id,sequence)||'',stored_bytes) AS BLOB)) FROM source_head_observations;
INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) SELECT 'applications',json_array(owner_id,id),stored_bytes,length(CAST(json_array('applications',json_array(owner_id,id)||'',stored_bytes) AS BLOB)) FROM applications;
INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) SELECT 'application_settings',json_array(owner_id,app_id,version),stored_bytes,length(CAST(json_array('application_settings',json_array(owner_id,app_id,version)||'',stored_bytes) AS BLOB)) FROM application_settings;
INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) SELECT 'github_connections',json_array(owner_id,app_id,version),stored_bytes,length(CAST(json_array('github_connections',json_array(owner_id,app_id,version)||'',stored_bytes) AS BLOB)) FROM github_connections;
INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) SELECT 'github_detections',json_array(owner_id,app_id,id),stored_bytes,length(CAST(json_array('github_detections',json_array(owner_id,app_id,id)||'',stored_bytes) AS BLOB)) FROM github_detections;
INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) SELECT 'ota_assets',json_array(owner_id,app_id,hash),stored_bytes,length(CAST(json_array('ota_assets',json_array(owner_id,app_id,hash)||'',stored_bytes) AS BLOB)) FROM ota_assets;
INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) SELECT 'ota_asset_chunks',json_array(owner_id,app_id,hash,chunk_index),stored_bytes,length(CAST(json_array('ota_asset_chunks',json_array(owner_id,app_id,hash,chunk_index)||'',stored_bytes) AS BLOB)) FROM ota_asset_chunks;
INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) SELECT 'ota_deployments',json_array(owner_id,app_id,id),stored_bytes,length(CAST(json_array('ota_deployments',json_array(owner_id,app_id,id)||'',stored_bytes) AS BLOB)) FROM ota_deployments;
INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) SELECT 'ota_deployment_assets',json_array(owner_id,app_id,deployment_id,hash),stored_bytes,length(CAST(json_array('ota_deployment_assets',json_array(owner_id,app_id,deployment_id,hash)||'',stored_bytes) AS BLOB)) FROM ota_deployment_assets;
INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) SELECT 'automation_runners',json_array(owner_id,id,version),stored_bytes,length(CAST(json_array('automation_runners',json_array(owner_id,id,version)||'',stored_bytes) AS BLOB)) FROM automation_runners;
INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) SELECT 'automation_jobs',json_array(owner_id,app_id,id),stored_bytes,length(CAST(json_array('automation_jobs',json_array(owner_id,app_id,id)||'',stored_bytes) AS BLOB)) FROM automation_jobs;
INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) SELECT 'automation_transitions',json_array(owner_id,app_id,job_id,version),stored_bytes,length(CAST(json_array('automation_transitions',json_array(owner_id,app_id,job_id,version)||'',stored_bytes) AS BLOB)) FROM automation_transitions;
INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) SELECT 'automation_guards',json_array(owner_id,app_id,id),stored_bytes,length(CAST(json_array('automation_guards',json_array(owner_id,app_id,id)||'',stored_bytes) AS BLOB)) FROM automation_guards;
INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) SELECT 'automation_asset_refs',json_array(owner_id,app_id,job_id,attempt_id,asset_hash),stored_bytes,length(CAST(json_array('automation_asset_refs',json_array(owner_id,app_id,job_id,attempt_id,asset_hash)||'',stored_bytes) AS BLOB)) FROM automation_asset_refs;
INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) SELECT 'automation_policies',json_array(owner_id,app_id,version),stored_bytes,length(CAST(json_array('automation_policies',json_array(owner_id,app_id,version)||'',stored_bytes) AS BLOB)) FROM automation_policies;
INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) SELECT 'automation_publications',json_array(owner_id,app_id,job_id),stored_bytes,length(CAST(json_array('automation_publications',json_array(owner_id,app_id,job_id)||'',stored_bytes) AS BLOB)) FROM automation_publications;
CREATE TABLE flora_capacity_ledger (
  table_name TEXT PRIMARY KEY CHECK(table_name IN('inventory_snapshots','baseline_imports','source_head_observations','applications','application_settings','github_connections','github_detections','ota_assets','ota_asset_chunks','ota_deployments','ota_deployment_assets','automation_runners','automation_jobs','automation_transitions','automation_guards','automation_asset_refs','automation_policies','automation_publications')),
  row_count INTEGER NOT NULL CHECK(row_count BETWEEN 0 AND 262144),
  payload_bytes INTEGER NOT NULL CHECK(payload_bytes BETWEEN 0 AND 268435456),
  witness_bytes INTEGER NOT NULL CHECK(witness_bytes BETWEEN 0 AND 33554432),
  last_sequence INTEGER,
  CHECK((row_count=0 AND payload_bytes=0 AND witness_bytes=0 AND last_sequence IS NULL) OR (row_count>0 AND last_sequence IS NOT NULL AND last_sequence>0))
) STRICT, WITHOUT ROWID;
INSERT INTO flora_capacity_ledger SELECT 'inventory_snapshots',count(*),coalesce(sum(stored_bytes),0),coalesce(sum(witness_bytes),0),max(sequence) FROM flora_capacity_facts WHERE table_name='inventory_snapshots';
INSERT INTO flora_capacity_ledger SELECT 'baseline_imports',count(*),coalesce(sum(stored_bytes),0),coalesce(sum(witness_bytes),0),max(sequence) FROM flora_capacity_facts WHERE table_name='baseline_imports';
INSERT INTO flora_capacity_ledger SELECT 'source_head_observations',count(*),coalesce(sum(stored_bytes),0),coalesce(sum(witness_bytes),0),max(sequence) FROM flora_capacity_facts WHERE table_name='source_head_observations';
INSERT INTO flora_capacity_ledger SELECT 'applications',count(*),coalesce(sum(stored_bytes),0),coalesce(sum(witness_bytes),0),max(sequence) FROM flora_capacity_facts WHERE table_name='applications';
INSERT INTO flora_capacity_ledger SELECT 'application_settings',count(*),coalesce(sum(stored_bytes),0),coalesce(sum(witness_bytes),0),max(sequence) FROM flora_capacity_facts WHERE table_name='application_settings';
INSERT INTO flora_capacity_ledger SELECT 'github_connections',count(*),coalesce(sum(stored_bytes),0),coalesce(sum(witness_bytes),0),max(sequence) FROM flora_capacity_facts WHERE table_name='github_connections';
INSERT INTO flora_capacity_ledger SELECT 'github_detections',count(*),coalesce(sum(stored_bytes),0),coalesce(sum(witness_bytes),0),max(sequence) FROM flora_capacity_facts WHERE table_name='github_detections';
INSERT INTO flora_capacity_ledger SELECT 'ota_assets',count(*),coalesce(sum(stored_bytes),0),coalesce(sum(witness_bytes),0),max(sequence) FROM flora_capacity_facts WHERE table_name='ota_assets';
INSERT INTO flora_capacity_ledger SELECT 'ota_asset_chunks',count(*),coalesce(sum(stored_bytes),0),coalesce(sum(witness_bytes),0),max(sequence) FROM flora_capacity_facts WHERE table_name='ota_asset_chunks';
INSERT INTO flora_capacity_ledger SELECT 'ota_deployments',count(*),coalesce(sum(stored_bytes),0),coalesce(sum(witness_bytes),0),max(sequence) FROM flora_capacity_facts WHERE table_name='ota_deployments';
INSERT INTO flora_capacity_ledger SELECT 'ota_deployment_assets',count(*),coalesce(sum(stored_bytes),0),coalesce(sum(witness_bytes),0),max(sequence) FROM flora_capacity_facts WHERE table_name='ota_deployment_assets';
INSERT INTO flora_capacity_ledger SELECT 'automation_runners',count(*),coalesce(sum(stored_bytes),0),coalesce(sum(witness_bytes),0),max(sequence) FROM flora_capacity_facts WHERE table_name='automation_runners';
INSERT INTO flora_capacity_ledger SELECT 'automation_jobs',count(*),coalesce(sum(stored_bytes),0),coalesce(sum(witness_bytes),0),max(sequence) FROM flora_capacity_facts WHERE table_name='automation_jobs';
INSERT INTO flora_capacity_ledger SELECT 'automation_transitions',count(*),coalesce(sum(stored_bytes),0),coalesce(sum(witness_bytes),0),max(sequence) FROM flora_capacity_facts WHERE table_name='automation_transitions';
INSERT INTO flora_capacity_ledger SELECT 'automation_guards',count(*),coalesce(sum(stored_bytes),0),coalesce(sum(witness_bytes),0),max(sequence) FROM flora_capacity_facts WHERE table_name='automation_guards';
INSERT INTO flora_capacity_ledger SELECT 'automation_asset_refs',count(*),coalesce(sum(stored_bytes),0),coalesce(sum(witness_bytes),0),max(sequence) FROM flora_capacity_facts WHERE table_name='automation_asset_refs';
INSERT INTO flora_capacity_ledger SELECT 'automation_policies',count(*),coalesce(sum(stored_bytes),0),coalesce(sum(witness_bytes),0),max(sequence) FROM flora_capacity_facts WHERE table_name='automation_policies';
INSERT INTO flora_capacity_ledger SELECT 'automation_publications',count(*),coalesce(sum(stored_bytes),0),coalesce(sum(witness_bytes),0),max(sequence) FROM flora_capacity_facts WHERE table_name='automation_publications';
CREATE TRIGGER capacity_ledger_insert BEFORE INSERT ON flora_capacity_ledger BEGIN SELECT RAISE(ABORT,'immutable capacity ledger'); END;
CREATE TRIGGER capacity_ledger_delete BEFORE DELETE ON flora_capacity_ledger BEGIN SELECT RAISE(ABORT,'immutable capacity ledger'); END;
CREATE TRIGGER capacity_ledger_identity BEFORE UPDATE ON flora_capacity_ledger WHEN NEW.table_name IS NOT OLD.table_name BEGIN SELECT RAISE(ABORT,'immutable capacity ledger'); END;
CREATE TRIGGER capacity_facts_update BEFORE UPDATE ON flora_capacity_facts BEGIN SELECT RAISE(ABORT,'immutable capacity fact'); END;
CREATE TRIGGER capacity_facts_delete BEFORE DELETE ON flora_capacity_facts BEGIN SELECT RAISE(ABORT,'immutable capacity fact'); END;
CREATE TRIGGER capacity_facts_replace BEFORE INSERT ON flora_capacity_facts WHEN EXISTS(SELECT 1 FROM flora_capacity_facts WHERE sequence=NEW.sequence OR (table_name=NEW.table_name AND record_key=NEW.record_key)) BEGIN SELECT RAISE(ABORT,'immutable capacity fact'); END;
CREATE TRIGGER capacity_facts_capacity BEFORE INSERT ON flora_capacity_facts
  WHEN NOT EXISTS(SELECT 1 FROM (SELECT sum(row_count) n,sum(witness_bytes) bytes FROM flora_capacity_ledger) WHERE n<262144 AND bytes+NEW.witness_bytes<=33554432)
  BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
-- A canonical PK must equal json_array(actual source PK), not merely decode to
-- equivalent values. Whitespace or 1.0 instead of 1 cannot create a second fact.
-- Source lookup uses each existing PK/unique index. A fact cannot be fabricated
-- for a missing source, different bytes, owner/app or an already-accounted PK.
CREATE TRIGGER capacity_facts_inventory_snapshots BEFORE INSERT ON flora_capacity_facts
  WHEN NEW.table_name='inventory_snapshots' AND NOT EXISTS(SELECT 1 FROM inventory_snapshots WHERE owner_id=json_extract(NEW.record_key,'$[0]') AND id=json_extract(NEW.record_key,'$[1]') AND NEW.record_key IS json_array(owner_id,id) AND NEW.stored_bytes IS stored_bytes)
  BEGIN SELECT RAISE(ABORT,'invalid capacity fact'); END;
CREATE TRIGGER capacity_facts_baseline_imports BEFORE INSERT ON flora_capacity_facts
  WHEN NEW.table_name='baseline_imports' AND NOT EXISTS(SELECT 1 FROM baseline_imports WHERE owner_id=json_extract(NEW.record_key,'$[0]') AND id=json_extract(NEW.record_key,'$[1]') AND NEW.record_key IS json_array(owner_id,id) AND NEW.stored_bytes IS stored_bytes)
  BEGIN SELECT RAISE(ABORT,'invalid capacity fact'); END;
CREATE TRIGGER capacity_facts_source_head_observations BEFORE INSERT ON flora_capacity_facts
  WHEN NEW.table_name='source_head_observations' AND NOT EXISTS(SELECT 1 FROM source_head_observations WHERE owner_id=json_extract(NEW.record_key,'$[0]') AND sequence=json_extract(NEW.record_key,'$[1]') AND NEW.record_key IS json_array(owner_id,sequence) AND NEW.stored_bytes IS stored_bytes)
  BEGIN SELECT RAISE(ABORT,'invalid capacity fact'); END;
CREATE TRIGGER capacity_facts_applications BEFORE INSERT ON flora_capacity_facts
  WHEN NEW.table_name='applications' AND NOT EXISTS(SELECT 1 FROM applications WHERE owner_id=json_extract(NEW.record_key,'$[0]') AND id=json_extract(NEW.record_key,'$[1]') AND NEW.record_key IS json_array(owner_id,id) AND NEW.stored_bytes IS stored_bytes)
  BEGIN SELECT RAISE(ABORT,'invalid capacity fact'); END;
CREATE TRIGGER capacity_facts_application_settings BEFORE INSERT ON flora_capacity_facts
  WHEN NEW.table_name='application_settings' AND NOT EXISTS(SELECT 1 FROM application_settings WHERE owner_id=json_extract(NEW.record_key,'$[0]') AND app_id=json_extract(NEW.record_key,'$[1]') AND version=json_extract(NEW.record_key,'$[2]') AND NEW.record_key IS json_array(owner_id,app_id,version) AND NEW.stored_bytes IS stored_bytes)
  BEGIN SELECT RAISE(ABORT,'invalid capacity fact'); END;
CREATE TRIGGER capacity_facts_github_connections BEFORE INSERT ON flora_capacity_facts
  WHEN NEW.table_name='github_connections' AND NOT EXISTS(SELECT 1 FROM github_connections WHERE owner_id=json_extract(NEW.record_key,'$[0]') AND app_id=json_extract(NEW.record_key,'$[1]') AND version=json_extract(NEW.record_key,'$[2]') AND NEW.record_key IS json_array(owner_id,app_id,version) AND NEW.stored_bytes IS stored_bytes)
  BEGIN SELECT RAISE(ABORT,'invalid capacity fact'); END;
CREATE TRIGGER capacity_facts_github_detections BEFORE INSERT ON flora_capacity_facts
  WHEN NEW.table_name='github_detections' AND NOT EXISTS(SELECT 1 FROM github_detections WHERE owner_id=json_extract(NEW.record_key,'$[0]') AND app_id=json_extract(NEW.record_key,'$[1]') AND id=json_extract(NEW.record_key,'$[2]') AND NEW.record_key IS json_array(owner_id,app_id,id) AND NEW.stored_bytes IS stored_bytes)
  BEGIN SELECT RAISE(ABORT,'invalid capacity fact'); END;
CREATE TRIGGER capacity_facts_ota_assets BEFORE INSERT ON flora_capacity_facts
  WHEN NEW.table_name='ota_assets' AND NOT EXISTS(SELECT 1 FROM ota_assets WHERE owner_id=json_extract(NEW.record_key,'$[0]') AND app_id=json_extract(NEW.record_key,'$[1]') AND hash=json_extract(NEW.record_key,'$[2]') AND NEW.record_key IS json_array(owner_id,app_id,hash) AND NEW.stored_bytes IS stored_bytes)
  BEGIN SELECT RAISE(ABORT,'invalid capacity fact'); END;
CREATE TRIGGER capacity_facts_ota_asset_chunks BEFORE INSERT ON flora_capacity_facts
  WHEN NEW.table_name='ota_asset_chunks' AND NOT EXISTS(SELECT 1 FROM ota_asset_chunks WHERE owner_id=json_extract(NEW.record_key,'$[0]') AND app_id=json_extract(NEW.record_key,'$[1]') AND hash=json_extract(NEW.record_key,'$[2]') AND chunk_index=json_extract(NEW.record_key,'$[3]') AND NEW.record_key IS json_array(owner_id,app_id,hash,chunk_index) AND NEW.stored_bytes IS stored_bytes)
  BEGIN SELECT RAISE(ABORT,'invalid capacity fact'); END;
CREATE TRIGGER capacity_facts_ota_deployments BEFORE INSERT ON flora_capacity_facts
  WHEN NEW.table_name='ota_deployments' AND NOT EXISTS(SELECT 1 FROM ota_deployments WHERE owner_id=json_extract(NEW.record_key,'$[0]') AND app_id=json_extract(NEW.record_key,'$[1]') AND id=json_extract(NEW.record_key,'$[2]') AND NEW.record_key IS json_array(owner_id,app_id,id) AND NEW.stored_bytes IS stored_bytes)
  BEGIN SELECT RAISE(ABORT,'invalid capacity fact'); END;
CREATE TRIGGER capacity_facts_ota_deployment_assets BEFORE INSERT ON flora_capacity_facts
  WHEN NEW.table_name='ota_deployment_assets' AND NOT EXISTS(SELECT 1 FROM ota_deployment_assets WHERE owner_id=json_extract(NEW.record_key,'$[0]') AND app_id=json_extract(NEW.record_key,'$[1]') AND deployment_id=json_extract(NEW.record_key,'$[2]') AND hash=json_extract(NEW.record_key,'$[3]') AND NEW.record_key IS json_array(owner_id,app_id,deployment_id,hash) AND NEW.stored_bytes IS stored_bytes)
  BEGIN SELECT RAISE(ABORT,'invalid capacity fact'); END;
CREATE TRIGGER capacity_facts_automation_runners BEFORE INSERT ON flora_capacity_facts
  WHEN NEW.table_name='automation_runners' AND NOT EXISTS(SELECT 1 FROM automation_runners WHERE owner_id=json_extract(NEW.record_key,'$[0]') AND id=json_extract(NEW.record_key,'$[1]') AND version=json_extract(NEW.record_key,'$[2]') AND NEW.record_key IS json_array(owner_id,id,version) AND NEW.stored_bytes IS stored_bytes)
  BEGIN SELECT RAISE(ABORT,'invalid capacity fact'); END;
CREATE TRIGGER capacity_facts_automation_jobs BEFORE INSERT ON flora_capacity_facts
  WHEN NEW.table_name='automation_jobs' AND NOT EXISTS(SELECT 1 FROM automation_jobs WHERE owner_id=json_extract(NEW.record_key,'$[0]') AND app_id=json_extract(NEW.record_key,'$[1]') AND id=json_extract(NEW.record_key,'$[2]') AND NEW.record_key IS json_array(owner_id,app_id,id) AND NEW.stored_bytes IS stored_bytes)
  BEGIN SELECT RAISE(ABORT,'invalid capacity fact'); END;
CREATE TRIGGER capacity_facts_automation_transitions BEFORE INSERT ON flora_capacity_facts
  WHEN NEW.table_name='automation_transitions' AND NOT EXISTS(SELECT 1 FROM automation_transitions WHERE owner_id=json_extract(NEW.record_key,'$[0]') AND app_id=json_extract(NEW.record_key,'$[1]') AND job_id=json_extract(NEW.record_key,'$[2]') AND version=json_extract(NEW.record_key,'$[3]') AND NEW.record_key IS json_array(owner_id,app_id,job_id,version) AND NEW.stored_bytes IS stored_bytes)
  BEGIN SELECT RAISE(ABORT,'invalid capacity fact'); END;
CREATE TRIGGER capacity_facts_automation_guards BEFORE INSERT ON flora_capacity_facts
  WHEN NEW.table_name='automation_guards' AND NOT EXISTS(SELECT 1 FROM automation_guards WHERE owner_id=json_extract(NEW.record_key,'$[0]') AND app_id=json_extract(NEW.record_key,'$[1]') AND id=json_extract(NEW.record_key,'$[2]') AND NEW.record_key IS json_array(owner_id,app_id,id) AND NEW.stored_bytes IS stored_bytes)
  BEGIN SELECT RAISE(ABORT,'invalid capacity fact'); END;
CREATE TRIGGER capacity_facts_automation_asset_refs BEFORE INSERT ON flora_capacity_facts
  WHEN NEW.table_name='automation_asset_refs' AND NOT EXISTS(SELECT 1 FROM automation_asset_refs WHERE owner_id=json_extract(NEW.record_key,'$[0]') AND app_id=json_extract(NEW.record_key,'$[1]') AND job_id=json_extract(NEW.record_key,'$[2]') AND attempt_id=json_extract(NEW.record_key,'$[3]') AND asset_hash=json_extract(NEW.record_key,'$[4]') AND NEW.record_key IS json_array(owner_id,app_id,job_id,attempt_id,asset_hash) AND NEW.stored_bytes IS stored_bytes)
  BEGIN SELECT RAISE(ABORT,'invalid capacity fact'); END;
CREATE TRIGGER capacity_facts_automation_policies BEFORE INSERT ON flora_capacity_facts
  WHEN NEW.table_name='automation_policies' AND NOT EXISTS(SELECT 1 FROM automation_policies WHERE owner_id=json_extract(NEW.record_key,'$[0]') AND app_id=json_extract(NEW.record_key,'$[1]') AND version=json_extract(NEW.record_key,'$[2]') AND NEW.record_key IS json_array(owner_id,app_id,version) AND NEW.stored_bytes IS stored_bytes)
  BEGIN SELECT RAISE(ABORT,'invalid capacity fact'); END;
CREATE TRIGGER capacity_facts_automation_publications BEFORE INSERT ON flora_capacity_facts
  WHEN NEW.table_name='automation_publications' AND NOT EXISTS(SELECT 1 FROM automation_publications WHERE owner_id=json_extract(NEW.record_key,'$[0]') AND app_id=json_extract(NEW.record_key,'$[1]') AND job_id=json_extract(NEW.record_key,'$[2]') AND NEW.record_key IS json_array(owner_id,app_id,job_id) AND NEW.stored_bytes IS stored_bytes)
  BEGIN SELECT RAISE(ABORT,'invalid capacity fact'); END;
-- The exact latest immutable fact advances its table aggregate once. A direct
-- aggregate edit cannot invent an unaccounted fact or replay a sealed sequence.
CREATE TRIGGER capacity_ledger_advance BEFORE UPDATE ON flora_capacity_ledger
  WHEN NEW.row_count<>OLD.row_count+1
    OR NEW.last_sequence IS NULL
    OR (OLD.last_sequence IS NOT NULL AND NEW.last_sequence<=OLD.last_sequence)
    OR NEW.last_sequence IS NOT (SELECT sequence FROM flora_capacity_facts WHERE table_name=OLD.table_name ORDER BY sequence DESC LIMIT 1)
    OR NOT EXISTS(SELECT 1 FROM flora_capacity_facts WHERE sequence=NEW.last_sequence AND table_name=OLD.table_name AND NEW.payload_bytes=OLD.payload_bytes+stored_bytes AND NEW.witness_bytes=OLD.witness_bytes+witness_bytes)
  BEGIN SELECT RAISE(ABORT,'invalid capacity ledger'); END;
CREATE TRIGGER capacity_facts_account AFTER INSERT ON flora_capacity_facts BEGIN
  UPDATE flora_capacity_ledger SET row_count=row_count+1,payload_bytes=payload_bytes+NEW.stored_bytes,witness_bytes=witness_bytes+NEW.witness_bytes,last_sequence=NEW.sequence WHERE table_name=NEW.table_name;
END;
DROP TRIGGER capacity_integrity;
CREATE TRIGGER capacity_integrity BEFORE UPDATE ON flora_capacity
  WHEN NEW.singleton<>1
    OR NEW.snapshot_count IS NOT (SELECT row_count FROM flora_capacity_ledger WHERE table_name='inventory_snapshots')
    OR NEW.baseline_count IS NOT (SELECT row_count FROM flora_capacity_ledger WHERE table_name='baseline_imports')
    OR NOT EXISTS(SELECT 1 FROM (SELECT count(*) n,sum(payload_bytes) payload,sum(witness_bytes) witness,sum(row_count) facts FROM flora_capacity_ledger) WHERE n=18 AND payload=NEW.payload_bytes AND witness<=33554432 AND facts<=262144)
  BEGIN SELECT RAISE(ABORT,'invalid capacity accounting'); END;
-- Reject explicit hidden-rowid REPLACE collisions as well as existing logical
-- key collisions. No source rowid is stored or used by the witness/cache.
CREATE TRIGGER capacity_source_rowid_inventory_snapshots BEFORE INSERT ON inventory_snapshots
  WHEN EXISTS(SELECT 1 FROM inventory_snapshots WHERE rowid=NEW.rowid)
  BEGIN SELECT RAISE(ABORT,'immutable capacity source rowid'); END;
DROP TRIGGER inventory_account;
CREATE TRIGGER inventory_account AFTER INSERT ON inventory_snapshots BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('inventory_snapshots',json_array(NEW.owner_id,NEW.id),NEW.stored_bytes,length(CAST(json_array('inventory_snapshots',json_array(NEW.owner_id,NEW.id)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET snapshot_count=snapshot_count+1,payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
-- Reject explicit hidden-rowid REPLACE collisions as well as existing logical
-- key collisions. No source rowid is stored or used by the witness/cache.
CREATE TRIGGER capacity_source_rowid_baseline_imports BEFORE INSERT ON baseline_imports
  WHEN EXISTS(SELECT 1 FROM baseline_imports WHERE rowid=NEW.rowid)
  BEGIN SELECT RAISE(ABORT,'immutable capacity source rowid'); END;
DROP TRIGGER baseline_account;
CREATE TRIGGER baseline_account AFTER INSERT ON baseline_imports BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('baseline_imports',json_array(NEW.owner_id,NEW.id),NEW.stored_bytes,length(CAST(json_array('baseline_imports',json_array(NEW.owner_id,NEW.id)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET baseline_count=baseline_count+1,payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
-- Reject explicit hidden-rowid REPLACE collisions as well as existing logical
-- key collisions. No source rowid is stored or used by the witness/cache.
CREATE TRIGGER capacity_source_rowid_source_head_observations BEFORE INSERT ON source_head_observations
  WHEN EXISTS(SELECT 1 FROM source_head_observations WHERE rowid=NEW.rowid)
  BEGIN SELECT RAISE(ABORT,'immutable capacity source rowid'); END;
DROP TRIGGER head_account;
CREATE TRIGGER head_account AFTER INSERT ON source_head_observations BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('source_head_observations',json_array(NEW.owner_id,NEW.sequence),NEW.stored_bytes,length(CAST(json_array('source_head_observations',json_array(NEW.owner_id,NEW.sequence)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
-- Reject explicit hidden-rowid REPLACE collisions as well as existing logical
-- key collisions. No source rowid is stored or used by the witness/cache.
CREATE TRIGGER capacity_source_rowid_applications BEFORE INSERT ON applications
  WHEN EXISTS(SELECT 1 FROM applications WHERE rowid=NEW.rowid)
  BEGIN SELECT RAISE(ABORT,'immutable capacity source rowid'); END;
DROP TRIGGER application_account;
CREATE TRIGGER application_account AFTER INSERT ON applications BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('applications',json_array(NEW.owner_id,NEW.id),NEW.stored_bytes,length(CAST(json_array('applications',json_array(NEW.owner_id,NEW.id)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
-- Reject explicit hidden-rowid REPLACE collisions as well as existing logical
-- key collisions. No source rowid is stored or used by the witness/cache.
CREATE TRIGGER capacity_source_rowid_application_settings BEFORE INSERT ON application_settings
  WHEN EXISTS(SELECT 1 FROM application_settings WHERE rowid=NEW.rowid)
  BEGIN SELECT RAISE(ABORT,'immutable capacity source rowid'); END;
DROP TRIGGER settings_account;
CREATE TRIGGER settings_account AFTER INSERT ON application_settings BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('application_settings',json_array(NEW.owner_id,NEW.app_id,NEW.version),NEW.stored_bytes,length(CAST(json_array('application_settings',json_array(NEW.owner_id,NEW.app_id,NEW.version)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
-- Reject explicit hidden-rowid REPLACE collisions as well as existing logical
-- key collisions. No source rowid is stored or used by the witness/cache.
CREATE TRIGGER capacity_source_rowid_github_connections BEFORE INSERT ON github_connections
  WHEN EXISTS(SELECT 1 FROM github_connections WHERE rowid=NEW.rowid)
  BEGIN SELECT RAISE(ABORT,'immutable capacity source rowid'); END;
DROP TRIGGER github_connections_account;
CREATE TRIGGER github_connections_account AFTER INSERT ON github_connections BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('github_connections',json_array(NEW.owner_id,NEW.app_id,NEW.version),NEW.stored_bytes,length(CAST(json_array('github_connections',json_array(NEW.owner_id,NEW.app_id,NEW.version)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
-- Reject explicit hidden-rowid REPLACE collisions as well as existing logical
-- key collisions. No source rowid is stored or used by the witness/cache.
CREATE TRIGGER capacity_source_rowid_github_detections BEFORE INSERT ON github_detections
  WHEN EXISTS(SELECT 1 FROM github_detections WHERE rowid=NEW.rowid)
  BEGIN SELECT RAISE(ABORT,'immutable capacity source rowid'); END;
DROP TRIGGER github_detections_account;
CREATE TRIGGER github_detections_account AFTER INSERT ON github_detections BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('github_detections',json_array(NEW.owner_id,NEW.app_id,NEW.id),NEW.stored_bytes,length(CAST(json_array('github_detections',json_array(NEW.owner_id,NEW.app_id,NEW.id)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
-- Reject explicit hidden-rowid REPLACE collisions as well as existing logical
-- key collisions. No source rowid is stored or used by the witness/cache.
CREATE TRIGGER capacity_source_rowid_ota_assets BEFORE INSERT ON ota_assets
  WHEN EXISTS(SELECT 1 FROM ota_assets WHERE rowid=NEW.rowid)
  BEGIN SELECT RAISE(ABORT,'immutable capacity source rowid'); END;
DROP TRIGGER ota_assets_account;
CREATE TRIGGER ota_assets_account AFTER INSERT ON ota_assets BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('ota_assets',json_array(NEW.owner_id,NEW.app_id,NEW.hash),NEW.stored_bytes,length(CAST(json_array('ota_assets',json_array(NEW.owner_id,NEW.app_id,NEW.hash)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
-- Reject explicit hidden-rowid REPLACE collisions as well as existing logical
-- key collisions. No source rowid is stored or used by the witness/cache.
CREATE TRIGGER capacity_source_rowid_ota_asset_chunks BEFORE INSERT ON ota_asset_chunks
  WHEN EXISTS(SELECT 1 FROM ota_asset_chunks WHERE rowid=NEW.rowid)
  BEGIN SELECT RAISE(ABORT,'immutable capacity source rowid'); END;
DROP TRIGGER ota_asset_chunks_account;
CREATE TRIGGER ota_asset_chunks_account AFTER INSERT ON ota_asset_chunks BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('ota_asset_chunks',json_array(NEW.owner_id,NEW.app_id,NEW.hash,NEW.chunk_index),NEW.stored_bytes,length(CAST(json_array('ota_asset_chunks',json_array(NEW.owner_id,NEW.app_id,NEW.hash,NEW.chunk_index)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
-- Reject explicit hidden-rowid REPLACE collisions as well as existing logical
-- key collisions. No source rowid is stored or used by the witness/cache.
CREATE TRIGGER capacity_source_rowid_ota_deployments BEFORE INSERT ON ota_deployments
  WHEN EXISTS(SELECT 1 FROM ota_deployments WHERE rowid=NEW.rowid)
  BEGIN SELECT RAISE(ABORT,'immutable capacity source rowid'); END;
DROP TRIGGER ota_deployments_account;
CREATE TRIGGER ota_deployments_account AFTER INSERT ON ota_deployments BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('ota_deployments',json_array(NEW.owner_id,NEW.app_id,NEW.id),NEW.stored_bytes,length(CAST(json_array('ota_deployments',json_array(NEW.owner_id,NEW.app_id,NEW.id)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
-- Reject explicit hidden-rowid REPLACE collisions as well as existing logical
-- key collisions. No source rowid is stored or used by the witness/cache.
CREATE TRIGGER capacity_source_rowid_ota_deployment_assets BEFORE INSERT ON ota_deployment_assets
  WHEN EXISTS(SELECT 1 FROM ota_deployment_assets WHERE rowid=NEW.rowid)
  BEGIN SELECT RAISE(ABORT,'immutable capacity source rowid'); END;
DROP TRIGGER ota_deployment_assets_account;
CREATE TRIGGER ota_deployment_assets_account AFTER INSERT ON ota_deployment_assets BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('ota_deployment_assets',json_array(NEW.owner_id,NEW.app_id,NEW.deployment_id,NEW.hash),NEW.stored_bytes,length(CAST(json_array('ota_deployment_assets',json_array(NEW.owner_id,NEW.app_id,NEW.deployment_id,NEW.hash)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
-- Reject explicit hidden-rowid REPLACE collisions as well as existing logical
-- key collisions. No source rowid is stored or used by the witness/cache.
CREATE TRIGGER capacity_source_rowid_automation_runners BEFORE INSERT ON automation_runners
  WHEN EXISTS(SELECT 1 FROM automation_runners WHERE rowid=NEW.rowid)
  BEGIN SELECT RAISE(ABORT,'immutable capacity source rowid'); END;
DROP TRIGGER automation_runners_account;
CREATE TRIGGER automation_runners_account AFTER INSERT ON automation_runners BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('automation_runners',json_array(NEW.owner_id,NEW.id,NEW.version),NEW.stored_bytes,length(CAST(json_array('automation_runners',json_array(NEW.owner_id,NEW.id,NEW.version)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
-- Reject explicit hidden-rowid REPLACE collisions as well as existing logical
-- key collisions. No source rowid is stored or used by the witness/cache.
CREATE TRIGGER capacity_source_rowid_automation_jobs BEFORE INSERT ON automation_jobs
  WHEN EXISTS(SELECT 1 FROM automation_jobs WHERE rowid=NEW.rowid)
  BEGIN SELECT RAISE(ABORT,'immutable capacity source rowid'); END;
DROP TRIGGER automation_jobs_account;
CREATE TRIGGER automation_jobs_account AFTER INSERT ON automation_jobs BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('automation_jobs',json_array(NEW.owner_id,NEW.app_id,NEW.id),NEW.stored_bytes,length(CAST(json_array('automation_jobs',json_array(NEW.owner_id,NEW.app_id,NEW.id)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
-- Reject explicit hidden-rowid REPLACE collisions as well as existing logical
-- key collisions. No source rowid is stored or used by the witness/cache.
CREATE TRIGGER capacity_source_rowid_automation_transitions BEFORE INSERT ON automation_transitions
  WHEN EXISTS(SELECT 1 FROM automation_transitions WHERE rowid=NEW.rowid)
  BEGIN SELECT RAISE(ABORT,'immutable capacity source rowid'); END;
DROP TRIGGER automation_transitions_account;
CREATE TRIGGER automation_transitions_account AFTER INSERT ON automation_transitions BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('automation_transitions',json_array(NEW.owner_id,NEW.app_id,NEW.job_id,NEW.version),NEW.stored_bytes,length(CAST(json_array('automation_transitions',json_array(NEW.owner_id,NEW.app_id,NEW.job_id,NEW.version)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
-- Reject explicit hidden-rowid REPLACE collisions as well as existing logical
-- key collisions. No source rowid is stored or used by the witness/cache.
CREATE TRIGGER capacity_source_rowid_automation_guards BEFORE INSERT ON automation_guards
  WHEN EXISTS(SELECT 1 FROM automation_guards WHERE rowid=NEW.rowid)
  BEGIN SELECT RAISE(ABORT,'immutable capacity source rowid'); END;
DROP TRIGGER automation_guards_account;
CREATE TRIGGER automation_guards_account AFTER INSERT ON automation_guards BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('automation_guards',json_array(NEW.owner_id,NEW.app_id,NEW.id),NEW.stored_bytes,length(CAST(json_array('automation_guards',json_array(NEW.owner_id,NEW.app_id,NEW.id)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
-- Reject explicit hidden-rowid REPLACE collisions as well as existing logical
-- key collisions. No source rowid is stored or used by the witness/cache.
CREATE TRIGGER capacity_source_rowid_automation_asset_refs BEFORE INSERT ON automation_asset_refs
  WHEN EXISTS(SELECT 1 FROM automation_asset_refs WHERE rowid=NEW.rowid)
  BEGIN SELECT RAISE(ABORT,'immutable capacity source rowid'); END;
DROP TRIGGER automation_asset_refs_account;
CREATE TRIGGER automation_asset_refs_account AFTER INSERT ON automation_asset_refs BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('automation_asset_refs',json_array(NEW.owner_id,NEW.app_id,NEW.job_id,NEW.attempt_id,NEW.asset_hash),NEW.stored_bytes,length(CAST(json_array('automation_asset_refs',json_array(NEW.owner_id,NEW.app_id,NEW.job_id,NEW.attempt_id,NEW.asset_hash)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
-- Reject explicit hidden-rowid REPLACE collisions as well as existing logical
-- key collisions. No source rowid is stored or used by the witness/cache.
CREATE TRIGGER capacity_source_rowid_automation_policies BEFORE INSERT ON automation_policies
  WHEN EXISTS(SELECT 1 FROM automation_policies WHERE rowid=NEW.rowid)
  BEGIN SELECT RAISE(ABORT,'immutable capacity source rowid'); END;
DROP TRIGGER automation_policies_account;
CREATE TRIGGER automation_policies_account AFTER INSERT ON automation_policies BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('automation_policies',json_array(NEW.owner_id,NEW.app_id,NEW.version),NEW.stored_bytes,length(CAST(json_array('automation_policies',json_array(NEW.owner_id,NEW.app_id,NEW.version)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
-- Reject explicit hidden-rowid REPLACE collisions as well as existing logical
-- key collisions. No source rowid is stored or used by the witness/cache.
CREATE TRIGGER capacity_source_rowid_automation_publications BEFORE INSERT ON automation_publications
  WHEN EXISTS(SELECT 1 FROM automation_publications WHERE rowid=NEW.rowid)
  BEGIN SELECT RAISE(ABORT,'immutable capacity source rowid'); END;
DROP TRIGGER automation_publications_account;
CREATE TRIGGER automation_publications_account AFTER INSERT ON automation_publications BEGIN
  SELECT RAISE(ABORT,'unsupported capacity source rowid') WHERE NEW.rowid=-1;
  INSERT INTO flora_capacity_facts(table_name,record_key,stored_bytes,witness_bytes) VALUES('automation_publications',json_array(NEW.owner_id,NEW.app_id,NEW.job_id),NEW.stored_bytes,length(CAST(json_array('automation_publications',json_array(NEW.owner_id,NEW.app_id,NEW.job_id)||'',NEW.stored_bytes) AS BLOB)));
  UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1;
END;
-- Final one-time full source/fact audit. Any mismatch rolls back everything.
INSERT INTO flora_capacity_ledger_check SELECT CASE WHEN (SELECT count(*) FROM flora_capacity_ledger)=18
  AND EXISTS(SELECT 1 FROM flora_capacity_ledger WHERE table_name='inventory_snapshots' AND row_count=(SELECT count(*) FROM inventory_snapshots) AND payload_bytes=(SELECT coalesce(sum(stored_bytes),0) FROM inventory_snapshots) AND witness_bytes=(SELECT coalesce(sum(witness_bytes),0) FROM flora_capacity_facts WHERE table_name='inventory_snapshots') AND last_sequence IS (SELECT max(sequence) FROM flora_capacity_facts WHERE table_name='inventory_snapshots'))
  AND NOT EXISTS(SELECT 1 FROM flora_capacity_facts f WHERE f.table_name='inventory_snapshots' AND NOT EXISTS(SELECT 1 FROM inventory_snapshots s WHERE s.owner_id=json_extract(f.record_key,'$[0]') AND s.id=json_extract(f.record_key,'$[1]') AND f.record_key IS json_array(s.owner_id,s.id) AND f.stored_bytes IS s.stored_bytes))
  AND EXISTS(SELECT 1 FROM flora_capacity_ledger WHERE table_name='baseline_imports' AND row_count=(SELECT count(*) FROM baseline_imports) AND payload_bytes=(SELECT coalesce(sum(stored_bytes),0) FROM baseline_imports) AND witness_bytes=(SELECT coalesce(sum(witness_bytes),0) FROM flora_capacity_facts WHERE table_name='baseline_imports') AND last_sequence IS (SELECT max(sequence) FROM flora_capacity_facts WHERE table_name='baseline_imports'))
  AND NOT EXISTS(SELECT 1 FROM flora_capacity_facts f WHERE f.table_name='baseline_imports' AND NOT EXISTS(SELECT 1 FROM baseline_imports s WHERE s.owner_id=json_extract(f.record_key,'$[0]') AND s.id=json_extract(f.record_key,'$[1]') AND f.record_key IS json_array(s.owner_id,s.id) AND f.stored_bytes IS s.stored_bytes))
  AND EXISTS(SELECT 1 FROM flora_capacity_ledger WHERE table_name='source_head_observations' AND row_count=(SELECT count(*) FROM source_head_observations) AND payload_bytes=(SELECT coalesce(sum(stored_bytes),0) FROM source_head_observations) AND witness_bytes=(SELECT coalesce(sum(witness_bytes),0) FROM flora_capacity_facts WHERE table_name='source_head_observations') AND last_sequence IS (SELECT max(sequence) FROM flora_capacity_facts WHERE table_name='source_head_observations'))
  AND NOT EXISTS(SELECT 1 FROM flora_capacity_facts f WHERE f.table_name='source_head_observations' AND NOT EXISTS(SELECT 1 FROM source_head_observations s WHERE s.owner_id=json_extract(f.record_key,'$[0]') AND s.sequence=json_extract(f.record_key,'$[1]') AND f.record_key IS json_array(s.owner_id,s.sequence) AND f.stored_bytes IS s.stored_bytes))
  AND EXISTS(SELECT 1 FROM flora_capacity_ledger WHERE table_name='applications' AND row_count=(SELECT count(*) FROM applications) AND payload_bytes=(SELECT coalesce(sum(stored_bytes),0) FROM applications) AND witness_bytes=(SELECT coalesce(sum(witness_bytes),0) FROM flora_capacity_facts WHERE table_name='applications') AND last_sequence IS (SELECT max(sequence) FROM flora_capacity_facts WHERE table_name='applications'))
  AND NOT EXISTS(SELECT 1 FROM flora_capacity_facts f WHERE f.table_name='applications' AND NOT EXISTS(SELECT 1 FROM applications s WHERE s.owner_id=json_extract(f.record_key,'$[0]') AND s.id=json_extract(f.record_key,'$[1]') AND f.record_key IS json_array(s.owner_id,s.id) AND f.stored_bytes IS s.stored_bytes))
  AND EXISTS(SELECT 1 FROM flora_capacity_ledger WHERE table_name='application_settings' AND row_count=(SELECT count(*) FROM application_settings) AND payload_bytes=(SELECT coalesce(sum(stored_bytes),0) FROM application_settings) AND witness_bytes=(SELECT coalesce(sum(witness_bytes),0) FROM flora_capacity_facts WHERE table_name='application_settings') AND last_sequence IS (SELECT max(sequence) FROM flora_capacity_facts WHERE table_name='application_settings'))
  AND NOT EXISTS(SELECT 1 FROM flora_capacity_facts f WHERE f.table_name='application_settings' AND NOT EXISTS(SELECT 1 FROM application_settings s WHERE s.owner_id=json_extract(f.record_key,'$[0]') AND s.app_id=json_extract(f.record_key,'$[1]') AND s.version=json_extract(f.record_key,'$[2]') AND f.record_key IS json_array(s.owner_id,s.app_id,s.version) AND f.stored_bytes IS s.stored_bytes))
  AND EXISTS(SELECT 1 FROM flora_capacity_ledger WHERE table_name='github_connections' AND row_count=(SELECT count(*) FROM github_connections) AND payload_bytes=(SELECT coalesce(sum(stored_bytes),0) FROM github_connections) AND witness_bytes=(SELECT coalesce(sum(witness_bytes),0) FROM flora_capacity_facts WHERE table_name='github_connections') AND last_sequence IS (SELECT max(sequence) FROM flora_capacity_facts WHERE table_name='github_connections'))
  AND NOT EXISTS(SELECT 1 FROM flora_capacity_facts f WHERE f.table_name='github_connections' AND NOT EXISTS(SELECT 1 FROM github_connections s WHERE s.owner_id=json_extract(f.record_key,'$[0]') AND s.app_id=json_extract(f.record_key,'$[1]') AND s.version=json_extract(f.record_key,'$[2]') AND f.record_key IS json_array(s.owner_id,s.app_id,s.version) AND f.stored_bytes IS s.stored_bytes))
  AND EXISTS(SELECT 1 FROM flora_capacity_ledger WHERE table_name='github_detections' AND row_count=(SELECT count(*) FROM github_detections) AND payload_bytes=(SELECT coalesce(sum(stored_bytes),0) FROM github_detections) AND witness_bytes=(SELECT coalesce(sum(witness_bytes),0) FROM flora_capacity_facts WHERE table_name='github_detections') AND last_sequence IS (SELECT max(sequence) FROM flora_capacity_facts WHERE table_name='github_detections'))
  AND NOT EXISTS(SELECT 1 FROM flora_capacity_facts f WHERE f.table_name='github_detections' AND NOT EXISTS(SELECT 1 FROM github_detections s WHERE s.owner_id=json_extract(f.record_key,'$[0]') AND s.app_id=json_extract(f.record_key,'$[1]') AND s.id=json_extract(f.record_key,'$[2]') AND f.record_key IS json_array(s.owner_id,s.app_id,s.id) AND f.stored_bytes IS s.stored_bytes))
  AND EXISTS(SELECT 1 FROM flora_capacity_ledger WHERE table_name='ota_assets' AND row_count=(SELECT count(*) FROM ota_assets) AND payload_bytes=(SELECT coalesce(sum(stored_bytes),0) FROM ota_assets) AND witness_bytes=(SELECT coalesce(sum(witness_bytes),0) FROM flora_capacity_facts WHERE table_name='ota_assets') AND last_sequence IS (SELECT max(sequence) FROM flora_capacity_facts WHERE table_name='ota_assets'))
  AND NOT EXISTS(SELECT 1 FROM flora_capacity_facts f WHERE f.table_name='ota_assets' AND NOT EXISTS(SELECT 1 FROM ota_assets s WHERE s.owner_id=json_extract(f.record_key,'$[0]') AND s.app_id=json_extract(f.record_key,'$[1]') AND s.hash=json_extract(f.record_key,'$[2]') AND f.record_key IS json_array(s.owner_id,s.app_id,s.hash) AND f.stored_bytes IS s.stored_bytes))
  AND EXISTS(SELECT 1 FROM flora_capacity_ledger WHERE table_name='ota_asset_chunks' AND row_count=(SELECT count(*) FROM ota_asset_chunks) AND payload_bytes=(SELECT coalesce(sum(stored_bytes),0) FROM ota_asset_chunks) AND witness_bytes=(SELECT coalesce(sum(witness_bytes),0) FROM flora_capacity_facts WHERE table_name='ota_asset_chunks') AND last_sequence IS (SELECT max(sequence) FROM flora_capacity_facts WHERE table_name='ota_asset_chunks'))
  AND NOT EXISTS(SELECT 1 FROM flora_capacity_facts f WHERE f.table_name='ota_asset_chunks' AND NOT EXISTS(SELECT 1 FROM ota_asset_chunks s WHERE s.owner_id=json_extract(f.record_key,'$[0]') AND s.app_id=json_extract(f.record_key,'$[1]') AND s.hash=json_extract(f.record_key,'$[2]') AND s.chunk_index=json_extract(f.record_key,'$[3]') AND f.record_key IS json_array(s.owner_id,s.app_id,s.hash,s.chunk_index) AND f.stored_bytes IS s.stored_bytes))
  AND EXISTS(SELECT 1 FROM flora_capacity_ledger WHERE table_name='ota_deployments' AND row_count=(SELECT count(*) FROM ota_deployments) AND payload_bytes=(SELECT coalesce(sum(stored_bytes),0) FROM ota_deployments) AND witness_bytes=(SELECT coalesce(sum(witness_bytes),0) FROM flora_capacity_facts WHERE table_name='ota_deployments') AND last_sequence IS (SELECT max(sequence) FROM flora_capacity_facts WHERE table_name='ota_deployments'))
  AND NOT EXISTS(SELECT 1 FROM flora_capacity_facts f WHERE f.table_name='ota_deployments' AND NOT EXISTS(SELECT 1 FROM ota_deployments s WHERE s.owner_id=json_extract(f.record_key,'$[0]') AND s.app_id=json_extract(f.record_key,'$[1]') AND s.id=json_extract(f.record_key,'$[2]') AND f.record_key IS json_array(s.owner_id,s.app_id,s.id) AND f.stored_bytes IS s.stored_bytes))
  AND EXISTS(SELECT 1 FROM flora_capacity_ledger WHERE table_name='ota_deployment_assets' AND row_count=(SELECT count(*) FROM ota_deployment_assets) AND payload_bytes=(SELECT coalesce(sum(stored_bytes),0) FROM ota_deployment_assets) AND witness_bytes=(SELECT coalesce(sum(witness_bytes),0) FROM flora_capacity_facts WHERE table_name='ota_deployment_assets') AND last_sequence IS (SELECT max(sequence) FROM flora_capacity_facts WHERE table_name='ota_deployment_assets'))
  AND NOT EXISTS(SELECT 1 FROM flora_capacity_facts f WHERE f.table_name='ota_deployment_assets' AND NOT EXISTS(SELECT 1 FROM ota_deployment_assets s WHERE s.owner_id=json_extract(f.record_key,'$[0]') AND s.app_id=json_extract(f.record_key,'$[1]') AND s.deployment_id=json_extract(f.record_key,'$[2]') AND s.hash=json_extract(f.record_key,'$[3]') AND f.record_key IS json_array(s.owner_id,s.app_id,s.deployment_id,s.hash) AND f.stored_bytes IS s.stored_bytes))
  AND EXISTS(SELECT 1 FROM flora_capacity_ledger WHERE table_name='automation_runners' AND row_count=(SELECT count(*) FROM automation_runners) AND payload_bytes=(SELECT coalesce(sum(stored_bytes),0) FROM automation_runners) AND witness_bytes=(SELECT coalesce(sum(witness_bytes),0) FROM flora_capacity_facts WHERE table_name='automation_runners') AND last_sequence IS (SELECT max(sequence) FROM flora_capacity_facts WHERE table_name='automation_runners'))
  AND NOT EXISTS(SELECT 1 FROM flora_capacity_facts f WHERE f.table_name='automation_runners' AND NOT EXISTS(SELECT 1 FROM automation_runners s WHERE s.owner_id=json_extract(f.record_key,'$[0]') AND s.id=json_extract(f.record_key,'$[1]') AND s.version=json_extract(f.record_key,'$[2]') AND f.record_key IS json_array(s.owner_id,s.id,s.version) AND f.stored_bytes IS s.stored_bytes))
  AND EXISTS(SELECT 1 FROM flora_capacity_ledger WHERE table_name='automation_jobs' AND row_count=(SELECT count(*) FROM automation_jobs) AND payload_bytes=(SELECT coalesce(sum(stored_bytes),0) FROM automation_jobs) AND witness_bytes=(SELECT coalesce(sum(witness_bytes),0) FROM flora_capacity_facts WHERE table_name='automation_jobs') AND last_sequence IS (SELECT max(sequence) FROM flora_capacity_facts WHERE table_name='automation_jobs'))
  AND NOT EXISTS(SELECT 1 FROM flora_capacity_facts f WHERE f.table_name='automation_jobs' AND NOT EXISTS(SELECT 1 FROM automation_jobs s WHERE s.owner_id=json_extract(f.record_key,'$[0]') AND s.app_id=json_extract(f.record_key,'$[1]') AND s.id=json_extract(f.record_key,'$[2]') AND f.record_key IS json_array(s.owner_id,s.app_id,s.id) AND f.stored_bytes IS s.stored_bytes))
  AND EXISTS(SELECT 1 FROM flora_capacity_ledger WHERE table_name='automation_transitions' AND row_count=(SELECT count(*) FROM automation_transitions) AND payload_bytes=(SELECT coalesce(sum(stored_bytes),0) FROM automation_transitions) AND witness_bytes=(SELECT coalesce(sum(witness_bytes),0) FROM flora_capacity_facts WHERE table_name='automation_transitions') AND last_sequence IS (SELECT max(sequence) FROM flora_capacity_facts WHERE table_name='automation_transitions'))
  AND NOT EXISTS(SELECT 1 FROM flora_capacity_facts f WHERE f.table_name='automation_transitions' AND NOT EXISTS(SELECT 1 FROM automation_transitions s WHERE s.owner_id=json_extract(f.record_key,'$[0]') AND s.app_id=json_extract(f.record_key,'$[1]') AND s.job_id=json_extract(f.record_key,'$[2]') AND s.version=json_extract(f.record_key,'$[3]') AND f.record_key IS json_array(s.owner_id,s.app_id,s.job_id,s.version) AND f.stored_bytes IS s.stored_bytes))
  AND EXISTS(SELECT 1 FROM flora_capacity_ledger WHERE table_name='automation_guards' AND row_count=(SELECT count(*) FROM automation_guards) AND payload_bytes=(SELECT coalesce(sum(stored_bytes),0) FROM automation_guards) AND witness_bytes=(SELECT coalesce(sum(witness_bytes),0) FROM flora_capacity_facts WHERE table_name='automation_guards') AND last_sequence IS (SELECT max(sequence) FROM flora_capacity_facts WHERE table_name='automation_guards'))
  AND NOT EXISTS(SELECT 1 FROM flora_capacity_facts f WHERE f.table_name='automation_guards' AND NOT EXISTS(SELECT 1 FROM automation_guards s WHERE s.owner_id=json_extract(f.record_key,'$[0]') AND s.app_id=json_extract(f.record_key,'$[1]') AND s.id=json_extract(f.record_key,'$[2]') AND f.record_key IS json_array(s.owner_id,s.app_id,s.id) AND f.stored_bytes IS s.stored_bytes))
  AND EXISTS(SELECT 1 FROM flora_capacity_ledger WHERE table_name='automation_asset_refs' AND row_count=(SELECT count(*) FROM automation_asset_refs) AND payload_bytes=(SELECT coalesce(sum(stored_bytes),0) FROM automation_asset_refs) AND witness_bytes=(SELECT coalesce(sum(witness_bytes),0) FROM flora_capacity_facts WHERE table_name='automation_asset_refs') AND last_sequence IS (SELECT max(sequence) FROM flora_capacity_facts WHERE table_name='automation_asset_refs'))
  AND NOT EXISTS(SELECT 1 FROM flora_capacity_facts f WHERE f.table_name='automation_asset_refs' AND NOT EXISTS(SELECT 1 FROM automation_asset_refs s WHERE s.owner_id=json_extract(f.record_key,'$[0]') AND s.app_id=json_extract(f.record_key,'$[1]') AND s.job_id=json_extract(f.record_key,'$[2]') AND s.attempt_id=json_extract(f.record_key,'$[3]') AND s.asset_hash=json_extract(f.record_key,'$[4]') AND f.record_key IS json_array(s.owner_id,s.app_id,s.job_id,s.attempt_id,s.asset_hash) AND f.stored_bytes IS s.stored_bytes))
  AND EXISTS(SELECT 1 FROM flora_capacity_ledger WHERE table_name='automation_policies' AND row_count=(SELECT count(*) FROM automation_policies) AND payload_bytes=(SELECT coalesce(sum(stored_bytes),0) FROM automation_policies) AND witness_bytes=(SELECT coalesce(sum(witness_bytes),0) FROM flora_capacity_facts WHERE table_name='automation_policies') AND last_sequence IS (SELECT max(sequence) FROM flora_capacity_facts WHERE table_name='automation_policies'))
  AND NOT EXISTS(SELECT 1 FROM flora_capacity_facts f WHERE f.table_name='automation_policies' AND NOT EXISTS(SELECT 1 FROM automation_policies s WHERE s.owner_id=json_extract(f.record_key,'$[0]') AND s.app_id=json_extract(f.record_key,'$[1]') AND s.version=json_extract(f.record_key,'$[2]') AND f.record_key IS json_array(s.owner_id,s.app_id,s.version) AND f.stored_bytes IS s.stored_bytes))
  AND EXISTS(SELECT 1 FROM flora_capacity_ledger WHERE table_name='automation_publications' AND row_count=(SELECT count(*) FROM automation_publications) AND payload_bytes=(SELECT coalesce(sum(stored_bytes),0) FROM automation_publications) AND witness_bytes=(SELECT coalesce(sum(witness_bytes),0) FROM flora_capacity_facts WHERE table_name='automation_publications') AND last_sequence IS (SELECT max(sequence) FROM flora_capacity_facts WHERE table_name='automation_publications'))
  AND NOT EXISTS(SELECT 1 FROM flora_capacity_facts f WHERE f.table_name='automation_publications' AND NOT EXISTS(SELECT 1 FROM automation_publications s WHERE s.owner_id=json_extract(f.record_key,'$[0]') AND s.app_id=json_extract(f.record_key,'$[1]') AND s.job_id=json_extract(f.record_key,'$[2]') AND f.record_key IS json_array(s.owner_id,s.app_id,s.job_id) AND f.stored_bytes IS s.stored_bytes)) THEN 1 ELSE 0 END;
UPDATE flora_capacity SET snapshot_count=snapshot_count,baseline_count=baseline_count,payload_bytes=payload_bytes;
DROP TABLE flora_capacity_ledger_check;
