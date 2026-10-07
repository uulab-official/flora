CREATE TABLE inventory_snapshots(
  id TEXT PRIMARY KEY,
  digest TEXT NOT NULL UNIQUE,
  repository_id TEXT NOT NULL,
  root_directory TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  imported_at INTEGER NOT NULL CHECK(imported_at>=0),
  data TEXT NOT NULL CHECK(json_valid(data)),
  UNIQUE(id,digest),
  CHECK(json_extract(data,'$.id') IS id AND json_extract(data,'$.digest') IS digest
    AND json_extract(data,'$.repository.id') IS repository_id
    AND json_extract(data,'$.rootDirectory') IS root_directory
    AND json_extract(data,'$.commitSha') IS commit_sha)
) STRICT;
CREATE TABLE source_head_observations(
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id TEXT NOT NULL,
  root_directory TEXT NOT NULL,
  observed_order TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)),
  CHECK(json_extract(data,'$.repositoryId') IS repository_id AND json_extract(data,'$.rootDirectory') IS root_directory)
) STRICT;
CREATE TABLE verification_records(
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  profile_id TEXT NOT NULL CHECK(profile_id='config-runtime-smoke-v1'),
  evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('development-baseline','isolated-runner-result')),
  evidence_origin TEXT NOT NULL CHECK(evidence_origin IN ('operator-import','flora-request','flora-execution')),
  state TEXT NOT NULL CHECK(state IN ('queued','running','cancelling','timing_out','passed','failed','invalid','blocked','cancelled','interrupted')),
  code TEXT,
  cleanup_code TEXT CHECK(cleanup_code IS NULL OR cleanup_code='CLEANUP_UNCONFIRMED'),
  request_kind TEXT NOT NULL CHECK(request_kind IN ('baseline-import','run-request')),
  request_key TEXT NOT NULL,
  attempt_id TEXT,
  fence INTEGER NOT NULL CHECK(fence>=0),
  lease_until INTEGER,
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
  evidence TEXT CHECK(evidence IS NULL OR json_valid(evidence)),
  assessment TEXT CHECK(assessment IS NULL OR json_valid(assessment)),
  UNIQUE(request_kind,request_key),
  FOREIGN KEY(snapshot_id,source_digest) REFERENCES inventory_snapshots(id,digest),
  FOREIGN KEY(id,attempt_id) REFERENCES verification_attempts(record_id,id),
  CHECK((request_kind='baseline-import' AND evidence_kind='development-baseline' AND evidence_origin='operator-import'
      AND state IN ('passed','failed','invalid') AND evidence IS NOT NULL AND assessment IS NOT NULL AND attempt_id IS NULL AND fence=0 AND lease_until IS NULL)
    OR (request_kind='run-request' AND evidence_kind='isolated-runner-result' AND evidence_origin IN ('flora-request','flora-execution'))),
  CHECK(evidence IS NULL OR (json_extract(evidence,'$.sourceDigest') IS source_digest AND json_extract(evidence,'$.profileId') IS profile_id)),
  CHECK((state='running' AND lease_until IS NOT NULL AND attempt_id IS NOT NULL AND evidence_origin='flora-execution') OR (state<>'running' AND lease_until IS NULL)),
  CHECK((evidence IS NULL AND assessment IS NULL) OR (evidence IS NOT NULL AND assessment IS NOT NULL))
) STRICT;
CREATE TABLE verification_attempts(
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK(fence>0),
  expires_at INTEGER NOT NULL,
  lease_ms INTEGER NOT NULL CHECK(lease_ms BETWEEN 5000 AND 120000),
  state TEXT NOT NULL CHECK(state IN ('running','cancelling','timing_out','passed','failed','invalid','blocked','cancelled','interrupted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
  UNIQUE(record_id,fence),
  UNIQUE(record_id,id),
  FOREIGN KEY(record_id) REFERENCES verification_records(id)
) STRICT;
CREATE TABLE dashboard_server_owner(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  nonce TEXT NOT NULL,
  pid INTEGER NOT NULL CHECK(pid>0),
  host TEXT NOT NULL,
  acquired_at INTEGER NOT NULL CHECK(acquired_at>=0)
) STRICT;
CREATE INDEX dogfood_observations ON source_head_observations(repository_id,root_directory,observed_order,sequence);
CREATE INDEX dogfood_records ON verification_records(snapshot_id,created_at,id);
CREATE TRIGGER inventory_one_app BEFORE INSERT ON inventory_snapshots
  WHEN EXISTS(SELECT 1 FROM inventory_snapshots WHERE repository_id<>NEW.repository_id OR root_directory<>NEW.root_directory)
  BEGIN SELECT RAISE(ABORT,'one app only'); END;
CREATE TRIGGER inventory_update BEFORE UPDATE ON inventory_snapshots BEGIN SELECT RAISE(ABORT,'immutable inventory'); END;
CREATE TRIGGER inventory_delete BEFORE DELETE ON inventory_snapshots BEGIN SELECT RAISE(ABORT,'immutable inventory'); END;
CREATE TRIGGER observations_update BEFORE UPDATE ON source_head_observations BEGIN SELECT RAISE(ABORT,'append-only observations'); END;
CREATE TRIGGER observations_delete BEFORE DELETE ON source_head_observations BEGIN SELECT RAISE(ABORT,'append-only observations'); END;
CREATE TRIGGER observations_one_app BEFORE INSERT ON source_head_observations
  WHEN NOT EXISTS(SELECT 1 FROM inventory_snapshots WHERE repository_id=NEW.repository_id AND root_directory=NEW.root_directory)
  BEGIN SELECT RAISE(ABORT,'unknown app'); END;
CREATE TRIGGER verifications_terminal_update BEFORE UPDATE ON verification_records
  WHEN OLD.state IN ('passed','failed','invalid','blocked','cancelled','interrupted')
  BEGIN SELECT RAISE(ABORT,'immutable verification'); END;
CREATE TRIGGER verifications_delete BEFORE DELETE ON verification_records BEGIN SELECT RAISE(ABORT,'immutable verification'); END;
CREATE TRIGGER verifications_identity_update BEFORE UPDATE ON verification_records
  WHEN OLD.id IS NOT NEW.id OR OLD.snapshot_id IS NOT NEW.snapshot_id OR OLD.source_digest IS NOT NEW.source_digest
    OR OLD.profile_id IS NOT NEW.profile_id OR OLD.request_kind IS NOT NEW.request_kind OR OLD.request_key IS NOT NEW.request_key
    OR OLD.evidence_kind IS NOT NEW.evidence_kind OR OLD.created_at IS NOT NEW.created_at OR NEW.fence<OLD.fence
    OR NEW.updated_at<OLD.updated_at
  BEGIN SELECT RAISE(ABORT,'immutable verification identity'); END;
CREATE TRIGGER verification_attempts_terminal_update BEFORE UPDATE ON verification_attempts
  WHEN OLD.state IN ('passed','failed','invalid','blocked','cancelled','interrupted')
  BEGIN SELECT RAISE(ABORT,'immutable verification attempt'); END;
CREATE TRIGGER verification_attempts_delete BEFORE DELETE ON verification_attempts BEGIN SELECT RAISE(ABORT,'immutable verification attempt'); END;
CREATE TRIGGER verification_attempts_identity_update BEFORE UPDATE ON verification_attempts
  WHEN OLD.id IS NOT NEW.id OR OLD.record_id IS NOT NEW.record_id OR OLD.runner_id IS NOT NEW.runner_id
    OR OLD.fence IS NOT NEW.fence OR OLD.expires_at IS NOT NEW.expires_at OR OLD.lease_ms IS NOT NEW.lease_ms
    OR OLD.created_at IS NOT NEW.created_at OR NEW.updated_at<OLD.updated_at
  BEGIN SELECT RAISE(ABORT,'immutable verification attempt identity'); END;
