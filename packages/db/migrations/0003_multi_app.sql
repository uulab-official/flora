CREATE TABLE managed_applications(
  app_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  root_directory TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  settings_version INTEGER NOT NULL DEFAULT 0 CHECK(settings_version>=0),
  UNIQUE(repository_id,root_directory)
) STRICT;
CREATE TABLE application_settings_history(
  app_id TEXT NOT NULL REFERENCES managed_applications(app_id),
  version INTEGER NOT NULL CHECK(version>=0),
  values_json TEXT NOT NULL CHECK(json_valid(values_json) AND json_type(values_json)='object'),
  updated_at INTEGER NOT NULL CHECK(updated_at>=0),
  PRIMARY KEY(app_id,version)
) STRICT;
INSERT INTO managed_applications(app_id,name,repository_id,root_directory,created_at)
  SELECT 'app_'||lower(hex(randomblob(16))),substr(json_extract(data,'$.repository.fullName'),1,256),repository_id,root_directory,min(imported_at)
  FROM inventory_snapshots GROUP BY repository_id,root_directory;
INSERT INTO application_settings_history SELECT app_id,0,'{}',created_at FROM managed_applications;
DROP TRIGGER inventory_one_app;
CREATE TRIGGER inventory_registered_app BEFORE INSERT ON inventory_snapshots
  WHEN NOT EXISTS(SELECT 1 FROM managed_applications WHERE repository_id=NEW.repository_id AND root_directory=NEW.root_directory)
  BEGIN SELECT RAISE(ABORT,'unknown app'); END;
CREATE TRIGGER applications_capacity BEFORE INSERT ON managed_applications
  WHEN (SELECT count(*) FROM managed_applications)>=100
  BEGIN SELECT RAISE(ABORT,'application limit'); END;
CREATE TRIGGER applications_identity_update BEFORE UPDATE ON managed_applications
  WHEN OLD.app_id IS NOT NEW.app_id OR OLD.name IS NOT NEW.name OR OLD.repository_id IS NOT NEW.repository_id
    OR OLD.root_directory IS NOT NEW.root_directory OR OLD.created_at IS NOT NEW.created_at OR NEW.settings_version<>OLD.settings_version+1
    OR NOT EXISTS(SELECT 1 FROM application_settings_history WHERE app_id=NEW.app_id AND version=NEW.settings_version)
  BEGIN SELECT RAISE(ABORT,'immutable application identity'); END;
CREATE TRIGGER applications_delete BEFORE DELETE ON managed_applications BEGIN SELECT RAISE(ABORT,'immutable application'); END;
CREATE TRIGGER settings_history_update BEFORE UPDATE ON application_settings_history BEGIN SELECT RAISE(ABORT,'immutable settings'); END;
CREATE TRIGGER settings_history_delete BEFORE DELETE ON application_settings_history BEGIN SELECT RAISE(ABORT,'immutable settings'); END;
CREATE TRIGGER settings_history_append BEFORE INSERT ON application_settings_history
  WHEN NOT EXISTS(SELECT 1 FROM managed_applications WHERE app_id=NEW.app_id AND
    ((NEW.version=0 AND settings_version=0 AND NOT EXISTS(SELECT 1 FROM application_settings_history WHERE app_id=NEW.app_id))
     OR NEW.version=settings_version+1))
  BEGIN SELECT RAISE(ABORT,'invalid settings version'); END;
-- Preserve legacy verification rows and raw request keys exactly. New receipts use
-- opaque internal keys, while this append-only mapping holds public per-app keys.
CREATE TABLE application_request_keys(
  app_id TEXT NOT NULL REFERENCES managed_applications(app_id),
  request_key TEXT NOT NULL,
  record_id TEXT NOT NULL UNIQUE REFERENCES verification_records(id),
  PRIMARY KEY(app_id,request_key)
) STRICT;
INSERT INTO application_request_keys
  SELECT a.app_id,v.request_key,v.id FROM verification_records v
  JOIN inventory_snapshots s ON s.id=v.snapshot_id
  JOIN managed_applications a ON a.repository_id=s.repository_id AND a.root_directory=s.root_directory
  WHERE v.request_kind='run-request';
CREATE TRIGGER request_keys_binding BEFORE INSERT ON application_request_keys
  WHEN NOT EXISTS(SELECT 1 FROM verification_records v JOIN inventory_snapshots s ON s.id=v.snapshot_id
    JOIN managed_applications a ON a.repository_id=s.repository_id AND a.root_directory=s.root_directory
    WHERE v.id=NEW.record_id AND v.request_kind='run-request' AND a.app_id=NEW.app_id)
  BEGIN SELECT RAISE(ABORT,'invalid request binding'); END;
CREATE TRIGGER request_keys_update BEFORE UPDATE ON application_request_keys BEGIN SELECT RAISE(ABORT,'immutable request key'); END;
CREATE TRIGGER request_keys_delete BEFORE DELETE ON application_request_keys BEGIN SELECT RAISE(ABORT,'immutable request key'); END;
