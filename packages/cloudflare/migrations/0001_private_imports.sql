-- No identity is provisioned here. Seed it only in the separately authorized deployment step.
PRAGMA foreign_keys=ON;
CREATE TABLE flora_deployment (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  owner_id TEXT NOT NULL UNIQUE CHECK(length(owner_id) BETWEEN 1 AND 256),
  origin TEXT NOT NULL CHECK(length(origin) BETWEEN 1 AND 2048),
  db_identity TEXT NOT NULL CHECK(length(db_identity) BETWEEN 1 AND 256)
) STRICT;
CREATE TABLE flora_capacity (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  snapshot_count INTEGER NOT NULL CHECK(snapshot_count BETWEEN 0 AND 100),
  baseline_count INTEGER NOT NULL CHECK(baseline_count BETWEEN 0 AND 500),
  payload_bytes INTEGER NOT NULL CHECK(payload_bytes BETWEEN 0 AND 134217728)
) STRICT;
INSERT INTO flora_capacity VALUES(1,0,0,0);
-- stored_bytes counts canonical JSON of the ordered application column values, including
-- serialized JSON and summary/log duplicates. Accounting columns and generated sequence are excluded.
CREATE TABLE inventory_snapshots (
  owner_id TEXT NOT NULL REFERENCES flora_deployment(owner_id),
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 96),
  digest TEXT NOT NULL CHECK(length(digest)=64 AND digest NOT GLOB '*[^a-f0-9]*'),
  repository_id TEXT NOT NULL,
  root_directory TEXT NOT NULL,
  commit_sha TEXT NOT NULL CHECK(length(commit_sha) IN (40,64) AND commit_sha NOT GLOB '*[^a-f0-9]*'),
  imported_at INTEGER NOT NULL CHECK(imported_at BETWEEN 0 AND 9007199254740991),
  data TEXT NOT NULL CHECK(json_valid(data)),
  stored_bytes INTEGER NOT NULL CHECK(stored_bytes BETWEEN 1 AND 524288),
  UNIQUE(owner_id,digest), UNIQUE(owner_id,id,digest),
  CHECK(json_extract(data,'$.id') IS id AND json_extract(data,'$.digest') IS digest
    AND json_extract(data,'$.repository.id') IS repository_id AND json_extract(data,'$.rootDirectory') IS root_directory
    AND json_extract(data,'$.commitSha') IS commit_sha AND json_extract(data,'$.importedAt') IS imported_at
    AND json_extract(data,'$.evidenceOrigin') IS 'operator-import' AND json_extract(data,'$.connection') IS 'one-shot-source-snapshot'),
  CHECK(stored_bytes=length(CAST(json_array(owner_id,id,digest,repository_id,root_directory,commit_sha,imported_at,data) AS BLOB))),
  CHECK(length(CAST(data AS BLOB))<=524288)
) STRICT;
CREATE TABLE source_head_observations (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL REFERENCES flora_deployment(owner_id),
  repository_id TEXT NOT NULL,
  root_directory TEXT NOT NULL,
  observed_order TEXT NOT NULL CHECK(length(observed_order)=24 AND observed_order NOT GLOB '*[^0-9]*'),
  data TEXT NOT NULL CHECK(json_valid(data)),
  stored_bytes INTEGER NOT NULL CHECK(stored_bytes BETWEEN 1 AND 524288),
  CHECK(json_extract(data,'$.repositoryId') IS repository_id AND json_extract(data,'$.rootDirectory') IS root_directory
    AND json_extract(data,'$.evidenceOrigin') IS 'operator-import'),
  CHECK(length(json_extract(data,'$.headCommitSha')) IN (40,64) AND json_extract(data,'$.headCommitSha') NOT GLOB '*[^a-f0-9]*'),
  CHECK(stored_bytes=length(CAST(json_array(owner_id,repository_id,root_directory,observed_order,data) AS BLOB))),
  CHECK(length(CAST(data AS BLOB))<=524288)
) STRICT;
CREATE TABLE baseline_imports (
  owner_id TEXT NOT NULL REFERENCES flora_deployment(owner_id),
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 96),
  snapshot_id TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  request_key TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
  state TEXT NOT NULL CHECK(state IN ('passed','failed','invalid')),
  code TEXT NOT NULL CHECK(length(code) BETWEEN 1 AND 96 AND code NOT GLOB '*[^A-Z0-9_]*'),
  platform TEXT NOT NULL CHECK(platform IN ('linux','darwin','win32')),
  node TEXT NOT NULL CHECK(node='24.19.0'),
  exit_code INTEGER CHECK(exit_code IS NULL OR exit_code BETWEEN 0 AND 255),
  evidence_digest TEXT NOT NULL CHECK(length(evidence_digest)=64 AND evidence_digest NOT GLOB '*[^a-f0-9]*'),
  log_truncated INTEGER NOT NULL CHECK(log_truncated IN (0,1)),
  assessment TEXT NOT NULL CHECK(json_valid(assessment)),
  safe_log TEXT NOT NULL CHECK(length(CAST(safe_log AS BLOB))<=65536),
  evidence TEXT NOT NULL CHECK(json_valid(evidence)),
  stored_bytes INTEGER NOT NULL CHECK(stored_bytes BETWEEN 1 AND 524288),
  UNIQUE(owner_id,request_key),
  FOREIGN KEY(owner_id,snapshot_id,source_digest) REFERENCES inventory_snapshots(owner_id,id,digest),
  CHECK(request_key IS source_digest||':'||json_extract(evidence,'$.attemptKey')
    AND json_extract(evidence,'$.profileId') IS 'config-runtime-smoke-v1'
    AND json_extract(evidence,'$.sourceDigest') IS source_digest AND json_extract(evidence,'$.evidenceDigest') IS evidence_digest
    AND json_extract(evidence,'$.platform') IS platform AND json_extract(evidence,'$.runtime.node') IS node
    AND json_extract(evidence,'$.exitCode') IS exit_code AND json_extract(evidence,'$.logTruncated') IS log_truncated
    AND json_extract(evidence,'$.safeLog') IS safe_log AND json_extract(evidence,'$.log') IS safe_log
    AND json_extract(assessment,'$.status') IS state AND json_extract(assessment,'$.code') IS code
    AND json_extract(assessment,'$.reportDigest') IS json_extract(evidence,'$.reportSha256')),
  CHECK(stored_bytes=length(CAST(json_array(owner_id,id,snapshot_id,source_digest,request_key,created_at,state,code,platform,node,exit_code,evidence_digest,log_truncated,assessment,safe_log,evidence) AS BLOB))),
  CHECK(length(CAST(evidence AS BLOB))+length(CAST(assessment AS BLOB))+length(CAST(safe_log AS BLOB))<=524288)
) STRICT;
CREATE INDEX inventory_pages ON inventory_snapshots(owner_id,imported_at DESC,id DESC);
CREATE INDEX baseline_pages ON baseline_imports(owner_id,snapshot_id,created_at DESC,id DESC);
CREATE INDEX head_latest ON source_head_observations(owner_id,repository_id,root_directory,observed_order DESC,sequence DESC);
CREATE TRIGGER deployment_update BEFORE UPDATE ON flora_deployment BEGIN SELECT RAISE(ABORT,'immutable deployment'); END;
CREATE TRIGGER deployment_delete BEFORE DELETE ON flora_deployment BEGIN SELECT RAISE(ABORT,'immutable deployment'); END;
CREATE TRIGGER capacity_delete BEFORE DELETE ON flora_capacity BEGIN SELECT RAISE(ABORT,'immutable capacity'); END;
CREATE TRIGGER capacity_integrity BEFORE UPDATE ON flora_capacity WHEN NEW.singleton<>1
  OR NEW.snapshot_count<>(SELECT count(*) FROM inventory_snapshots)
  OR NEW.baseline_count<>(SELECT count(*) FROM baseline_imports)
  OR NEW.payload_bytes<>(SELECT coalesce(sum(stored_bytes),0) FROM inventory_snapshots)+(SELECT coalesce(sum(stored_bytes),0) FROM baseline_imports)+(SELECT coalesce(sum(stored_bytes),0) FROM source_head_observations)
  BEGIN SELECT RAISE(ABORT,'invalid capacity accounting'); END;
CREATE TRIGGER inventory_one_app BEFORE INSERT ON inventory_snapshots
  WHEN EXISTS(SELECT 1 FROM inventory_snapshots WHERE owner_id<>NEW.owner_id OR repository_id<>NEW.repository_id OR root_directory<>NEW.root_directory)
  BEGIN SELECT RAISE(ABORT,'one app only'); END;
CREATE TRIGGER observations_one_app BEFORE INSERT ON source_head_observations
  WHEN NOT EXISTS(SELECT 1 FROM inventory_snapshots WHERE owner_id=NEW.owner_id AND repository_id=NEW.repository_id AND root_directory=NEW.root_directory)
  BEGIN SELECT RAISE(ABORT,'unknown app'); END;
CREATE TRIGGER baseline_source_binding BEFORE INSERT ON baseline_imports
  WHEN NOT EXISTS(SELECT 1 FROM inventory_snapshots WHERE owner_id=NEW.owner_id AND id=NEW.snapshot_id AND digest=NEW.source_digest AND commit_sha=json_extract(NEW.evidence,'$.commitSha'))
  BEGIN SELECT RAISE(ABORT,'baseline source mismatch'); END;
CREATE TRIGGER inventory_capacity BEFORE INSERT ON inventory_snapshots
  WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE singleton=1 AND snapshot_count<100 AND payload_bytes+NEW.stored_bytes<=134217728)
  BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER baseline_capacity BEFORE INSERT ON baseline_imports
  WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE singleton=1 AND baseline_count<500 AND payload_bytes+NEW.stored_bytes<=134217728)
  BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER head_capacity BEFORE INSERT ON source_head_observations
  WHEN NOT EXISTS(SELECT 1 FROM flora_capacity WHERE singleton=1 AND payload_bytes+NEW.stored_bytes<=134217728)
  BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
CREATE TRIGGER inventory_account AFTER INSERT ON inventory_snapshots
  BEGIN UPDATE flora_capacity SET snapshot_count=snapshot_count+1,payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1; END;
CREATE TRIGGER baseline_account AFTER INSERT ON baseline_imports
  BEGIN UPDATE flora_capacity SET baseline_count=baseline_count+1,payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1; END;
CREATE TRIGGER head_account AFTER INSERT ON source_head_observations
  BEGIN UPDATE flora_capacity SET payload_bytes=payload_bytes+NEW.stored_bytes WHERE singleton=1; END;
CREATE TRIGGER inventory_update BEFORE UPDATE ON inventory_snapshots BEGIN SELECT RAISE(ABORT,'immutable inventory'); END;
CREATE TRIGGER inventory_delete BEFORE DELETE ON inventory_snapshots BEGIN SELECT RAISE(ABORT,'immutable inventory'); END;
CREATE TRIGGER baseline_update BEFORE UPDATE ON baseline_imports BEGIN SELECT RAISE(ABORT,'immutable baseline'); END;
CREATE TRIGGER baseline_delete BEFORE DELETE ON baseline_imports BEGIN SELECT RAISE(ABORT,'immutable baseline'); END;
CREATE TRIGGER head_update BEFORE UPDATE ON source_head_observations BEGIN SELECT RAISE(ABORT,'immutable head'); END;
CREATE TRIGGER head_delete BEFORE DELETE ON source_head_observations BEGIN SELECT RAISE(ABORT,'immutable head'); END;
-- SQLite REPLACE may skip delete triggers. Reject colliding inserts explicitly as well.
CREATE TRIGGER deployment_replace BEFORE INSERT ON flora_deployment WHEN EXISTS(SELECT 1 FROM flora_deployment)
  BEGIN SELECT RAISE(ABORT,'immutable deployment'); END;
CREATE TRIGGER capacity_replace BEFORE INSERT ON flora_capacity WHEN EXISTS(SELECT 1 FROM flora_capacity)
  BEGIN SELECT RAISE(ABORT,'immutable capacity'); END;
CREATE TRIGGER inventory_replace BEFORE INSERT ON inventory_snapshots
  WHEN EXISTS(SELECT 1 FROM inventory_snapshots WHERE id=NEW.id OR (owner_id=NEW.owner_id AND digest=NEW.digest))
  BEGIN SELECT RAISE(ABORT,'immutable inventory'); END;
CREATE TRIGGER baseline_replace BEFORE INSERT ON baseline_imports
  WHEN EXISTS(SELECT 1 FROM baseline_imports WHERE id=NEW.id OR (owner_id=NEW.owner_id AND request_key=NEW.request_key))
  BEGIN SELECT RAISE(ABORT,'immutable baseline'); END;
CREATE TRIGGER head_replace BEFORE INSERT ON source_head_observations
  WHEN EXISTS(SELECT 1 FROM source_head_observations WHERE sequence=NEW.sequence)
  BEGIN SELECT RAISE(ABORT,'immutable head'); END;
