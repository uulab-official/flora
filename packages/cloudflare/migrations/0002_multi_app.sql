-- Existing immutable facts and capacity counters remain unchanged. Migration-derived
-- registry metadata has zero charge; all newly supplied registry/settings payloads are charged.
CREATE TABLE applications (
  owner_id TEXT NOT NULL REFERENCES flora_deployment(owner_id),
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 96),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 256),
  repository_id TEXT NOT NULL CHECK(length(repository_id) BETWEEN 1 AND 4096),
  root_directory TEXT NOT NULL CHECK(length(root_directory) BETWEEN 1 AND 4096),
  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
  stored_bytes INTEGER NOT NULL CHECK(stored_bytes BETWEEN 0 AND 524288),
  UNIQUE(owner_id,repository_id,root_directory), UNIQUE(owner_id,id),
  CHECK(stored_bytes=0 OR stored_bytes=length(CAST(json_array(owner_id,id,name,repository_id,root_directory,created_at) AS BLOB)))
) STRICT;
CREATE TABLE application_settings (
  owner_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version BETWEEN 0 AND 9007199254740991),
  values_json TEXT NOT NULL CHECK(json_valid(values_json) AND json_type(values_json)='object' AND length(CAST(values_json AS BLOB))<=8192),
  updated_at INTEGER NOT NULL CHECK(updated_at BETWEEN 0 AND 9007199254740991),
  stored_bytes INTEGER NOT NULL CHECK(stored_bytes BETWEEN 0 AND 524288),
  PRIMARY KEY(owner_id,app_id,version),
  FOREIGN KEY(owner_id,app_id) REFERENCES applications(owner_id,id),
  CHECK(stored_bytes=0 OR stored_bytes=length(CAST(json_array(owner_id,app_id,version,values_json,updated_at) AS BLOB)))
) STRICT;
INSERT INTO applications(owner_id,id,name,repository_id,root_directory,created_at,stored_bytes)
  SELECT owner_id,'application_'||digest,substr(repository_id,1,256),repository_id,root_directory,imported_at,0
  FROM inventory_snapshots WHERE id=(SELECT id FROM inventory_snapshots ORDER BY imported_at,id LIMIT 1);
INSERT INTO application_settings SELECT owner_id,id,0,'{}',created_at,0 FROM applications;
DROP TRIGGER inventory_one_app;
DROP TRIGGER observations_one_app;
DROP TRIGGER capacity_integrity;
CREATE TRIGGER capacity_integrity BEFORE UPDATE ON flora_capacity WHEN NEW.singleton<>1
  OR NEW.snapshot_count<>(SELECT count(*) FROM inventory_snapshots)
  OR NEW.baseline_count<>(SELECT count(*) FROM baseline_imports)
  OR NEW.payload_bytes<>(SELECT coalesce(sum(stored_bytes),0) FROM inventory_snapshots)+(SELECT coalesce(sum(stored_bytes),0) FROM baseline_imports)+(SELECT coalesce(sum(stored_bytes),0) FROM source_head_observations)+(SELECT coalesce(sum(stored_bytes),0) FROM applications)+(SELECT coalesce(sum(stored_bytes),0) FROM application_settings)
  BEGIN SELECT RAISE(ABORT,'invalid capacity accounting'); END;
CREATE TRIGGER inventory_registered BEFORE INSERT ON inventory_snapshots
  WHEN NOT EXISTS(SELECT 1 FROM applications WHERE owner_id=NEW.owner_id AND repository_id=NEW.repository_id AND root_directory=NEW.root_directory)
  BEGIN SELECT RAISE(ABORT,'unknown app'); END;
CREATE TRIGGER observations_registered BEFORE INSERT ON source_head_observations
  WHEN NOT EXISTS(SELECT 1 FROM applications WHERE owner_id=NEW.owner_id AND repository_id=NEW.repository_id AND root_directory=NEW.root_directory)
  BEGIN SELECT RAISE(ABORT,'unknown app'); END;
CREATE TRIGGER application_capacity BEFORE INSERT ON applications
  WHEN NEW.stored_bytes=0 OR (SELECT count(*) FROM applications)>=100 OR NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=134217728)
  BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER settings_capacity BEFORE INSERT ON application_settings
  WHEN NEW.stored_bytes=0 OR NOT EXISTS(SELECT 1 FROM flora_capacity WHERE payload_bytes+NEW.stored_bytes<=134217728)
  BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER settings_sequence BEFORE INSERT ON application_settings
  WHEN NEW.version<>coalesce((SELECT max(version)+1 FROM application_settings WHERE owner_id=NEW.owner_id AND app_id=NEW.app_id),0)
  BEGIN SELECT RAISE(ABORT,'settings version conflict'); END;
CREATE TRIGGER application_account AFTER INSERT ON applications BEGIN UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1; END;
CREATE TRIGGER settings_account AFTER INSERT ON application_settings BEGIN UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1; END;
CREATE TRIGGER application_update BEFORE UPDATE ON applications BEGIN SELECT RAISE(ABORT,'immutable application'); END;
CREATE TRIGGER application_delete BEFORE DELETE ON applications BEGIN SELECT RAISE(ABORT,'immutable application'); END;
CREATE TRIGGER settings_update BEFORE UPDATE ON application_settings BEGIN SELECT RAISE(ABORT,'immutable settings'); END;
CREATE TRIGGER settings_delete BEFORE DELETE ON application_settings BEGIN SELECT RAISE(ABORT,'immutable settings'); END;
CREATE TRIGGER application_replace BEFORE INSERT ON applications
  WHEN EXISTS(SELECT 1 FROM applications WHERE id=NEW.id OR (owner_id=NEW.owner_id AND repository_id=NEW.repository_id AND root_directory=NEW.root_directory))
  BEGIN SELECT RAISE(ABORT,'immutable application'); END;
CREATE TRIGGER settings_replace BEFORE INSERT ON application_settings
  WHEN EXISTS(SELECT 1 FROM application_settings WHERE owner_id=NEW.owner_id AND app_id=NEW.app_id AND version=NEW.version)
  BEGIN SELECT RAISE(ABORT,'immutable settings'); END;
CREATE INDEX inventory_app_pages ON inventory_snapshots(owner_id,repository_id,root_directory,imported_at DESC,id DESC);
