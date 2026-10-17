CREATE TABLE automation_runners(
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
  credential_epoch INTEGER NOT NULL CHECK(credential_epoch>0),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  revoked_at INTEGER CHECK(revoked_at IS NULL OR revoked_at>=created_at),
  data TEXT NOT NULL CHECK(json_valid(data) AND json_extract(data,'$.id') IS id AND json_extract(data,'$.tokenHash') IS token_hash
    AND json_extract(data,'$.credentialEpoch') IS credential_epoch AND json_extract(data,'$.revokedAt') IS revoked_at)
) STRICT;
CREATE TABLE automation_runner_scopes(
  runner_id TEXT NOT NULL REFERENCES automation_runners(id),
  app_id TEXT NOT NULL REFERENCES managed_applications(app_id),
  PRIMARY KEY(runner_id,app_id)
) STRICT;
CREATE TABLE automation_jobs(
  app_id TEXT NOT NULL REFERENCES managed_applications(app_id),
  id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','leased','cancel_requested','succeeded','failed','cancelled')),
  attempt_count INTEGER NOT NULL CHECK(attempt_count BETWEEN 0 AND 3),
  fence INTEGER NOT NULL CHECK(fence=attempt_count),
  attempt_id TEXT,
  lease_until INTEGER,
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
  data TEXT NOT NULL CHECK(json_valid(data) AND json_extract(data,'$.appId') IS app_id AND json_extract(data,'$.id') IS id
    AND json_extract(data,'$.requestKey') IS request_key AND json_extract(data,'$.state') IS state AND json_extract(data,'$.attemptCount') IS attempt_count
    AND json_extract(data,'$.lease.attemptId') IS attempt_id AND json_extract(data,'$.lease.expiresAt') IS lease_until
    AND json_extract(data,'$.createdAt') IS created_at AND json_extract(data,'$.updatedAt') IS updated_at),
  PRIMARY KEY(app_id,id),
  UNIQUE(app_id,request_key),
  FOREIGN KEY(app_id,id,attempt_id) REFERENCES automation_attempts(app_id,job_id,id),
  CHECK((state IN ('leased','cancel_requested') AND attempt_id IS NOT NULL AND lease_until IS NOT NULL
      AND json_extract(data,'$.lease.fence') IS fence)
    OR (state NOT IN ('leased','cancel_requested') AND attempt_id IS NULL AND lease_until IS NULL))
) STRICT;
CREATE TABLE automation_attempts(
  app_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  id TEXT NOT NULL,
  runner_id TEXT NOT NULL REFERENCES automation_runners(id),
  credential_epoch INTEGER NOT NULL CHECK(credential_epoch>0),
  fence INTEGER NOT NULL CHECK(fence BETWEEN 1 AND 3),
  claimed_at INTEGER NOT NULL CHECK(claimed_at>=0),
  expires_at INTEGER NOT NULL CHECK(expires_at>claimed_at AND expires_at<=claimed_at+1200000),
  ended_at INTEGER CHECK(ended_at IS NULL OR ended_at>=claimed_at),
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('succeeded','failed','expired','cancelled')),
  data TEXT NOT NULL CHECK(json_valid(data) AND json_extract(data,'$.id') IS id AND json_extract(data,'$.jobId') IS job_id
    AND json_extract(data,'$.runnerId') IS runner_id AND json_extract(data,'$.credentialEpoch') IS credential_epoch AND json_extract(data,'$.fence') IS fence
    AND json_extract(data,'$.claimedAt') IS claimed_at AND json_extract(data,'$.expiresAt') IS expires_at
    AND json_extract(data,'$.endedAt') IS ended_at AND json_extract(data,'$.outcome') IS outcome),
  PRIMARY KEY(app_id,job_id,id),
  UNIQUE(app_id,job_id,fence),
  FOREIGN KEY(app_id,job_id) REFERENCES automation_jobs(app_id,id),
  CHECK((ended_at IS NULL AND outcome IS NULL) OR (ended_at IS NOT NULL AND outcome IS NOT NULL))
) STRICT;
CREATE TABLE automation_events(
  app_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>0),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  data TEXT NOT NULL CHECK(json_valid(data) AND json_extract(data,'$.jobId') IS job_id AND json_extract(data,'$.sequence') IS sequence AND json_extract(data,'$.createdAt') IS created_at),
  PRIMARY KEY(app_id,job_id,sequence),
  FOREIGN KEY(app_id,job_id) REFERENCES automation_jobs(app_id,id)
) STRICT;
CREATE TABLE automation_uploaded_assets(
  app_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  PRIMARY KEY(app_id,job_id,attempt_id,asset_id),
  FOREIGN KEY(app_id,job_id,attempt_id) REFERENCES automation_attempts(app_id,job_id,id),
  FOREIGN KEY(app_id,asset_id) REFERENCES ota_assets(app_id,id)
) STRICT;
CREATE TABLE automation_export_receipts(
  app_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data) AND json_extract(data,'$.jobId') IS job_id AND json_extract(data,'$.attemptId') IS attempt_id),
  PRIMARY KEY(app_id,job_id),
  UNIQUE(app_id,deployment_id),
  FOREIGN KEY(app_id,job_id,attempt_id) REFERENCES automation_attempts(app_id,job_id,id),
  FOREIGN KEY(app_id,deployment_id) REFERENCES ota_deployments(app_id,id)
) STRICT;
CREATE INDEX automation_claim_queue ON automation_jobs(state,created_at);
CREATE INDEX automation_expiry ON automation_jobs(state,lease_until);
CREATE TRIGGER automation_runner_capacity BEFORE INSERT ON automation_runners
  WHEN (SELECT count(*) FROM automation_runners)>=100 BEGIN SELECT RAISE(ABORT,'runner limit'); END;
CREATE TRIGGER automation_runner_identity BEFORE UPDATE ON automation_runners
  WHEN OLD.id IS NOT NEW.id OR OLD.token_hash IS NOT NEW.token_hash OR OLD.created_at IS NOT NEW.created_at
    OR json_extract(OLD.data,'$.name') IS NOT json_extract(NEW.data,'$.name') OR json_extract(OLD.data,'$.appIds') IS NOT json_extract(NEW.data,'$.appIds')
    OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.credential_epoch<>OLD.credential_epoch+1
  BEGIN SELECT RAISE(ABORT,'immutable runner identity'); END;
CREATE TRIGGER automation_runner_delete BEFORE DELETE ON automation_runners BEGIN SELECT RAISE(ABORT,'immutable runner'); END;
CREATE TRIGGER automation_scope_binding BEFORE INSERT ON automation_runner_scopes
  WHEN NOT EXISTS(SELECT 1 FROM automation_runners r,json_each(r.data,'$.appIds') a WHERE r.id=NEW.runner_id AND a.value=NEW.app_id)
  BEGIN SELECT RAISE(ABORT,'invalid runner scope'); END;
CREATE TRIGGER automation_scope_update BEFORE UPDATE ON automation_runner_scopes BEGIN SELECT RAISE(ABORT,'immutable runner scope'); END;
CREATE TRIGGER automation_scope_delete BEFORE DELETE ON automation_runner_scopes BEGIN SELECT RAISE(ABORT,'immutable runner scope'); END;
CREATE TRIGGER automation_job_capacity BEFORE INSERT ON automation_jobs
  WHEN NEW.state<>'queued' OR NEW.attempt_count<>0 OR (SELECT count(*) FROM automation_jobs)>=1000
    OR (SELECT count(*) FROM automation_jobs WHERE state IN ('queued','leased','cancel_requested'))>=100
    OR (SELECT count(*) FROM automation_jobs WHERE app_id=NEW.app_id AND state IN ('queued','leased','cancel_requested'))>=10
  BEGIN SELECT RAISE(ABORT,'automation job limit'); END;
CREATE TRIGGER automation_job_terminal BEFORE UPDATE ON automation_jobs WHEN OLD.state IN ('succeeded','failed','cancelled')
  BEGIN SELECT RAISE(ABORT,'immutable terminal job'); END;
CREATE TRIGGER automation_job_identity BEFORE UPDATE ON automation_jobs
  WHEN OLD.app_id IS NOT NEW.app_id OR OLD.id IS NOT NEW.id OR OLD.request_key IS NOT NEW.request_key OR OLD.input_digest IS NOT NEW.input_digest
    OR OLD.created_at IS NOT NEW.created_at OR NEW.updated_at<OLD.updated_at OR NEW.fence<OLD.fence
    OR json_extract(OLD.data,'$.config') IS NOT json_extract(NEW.data,'$.config') OR json_extract(OLD.data,'$.configDigest') IS NOT json_extract(NEW.data,'$.configDigest')
    OR json_extract(OLD.data,'$.toolchainDigest') IS NOT json_extract(NEW.data,'$.toolchainDigest') OR json_extract(OLD.data,'$.detection') IS NOT json_extract(NEW.data,'$.detection')
    OR json_extract(OLD.data,'$.connection') IS NOT json_extract(NEW.data,'$.connection') OR json_extract(OLD.data,'$.rootDirectory') IS NOT json_extract(NEW.data,'$.rootDirectory')
    OR json_extract(OLD.data,'$.commitSha') IS NOT json_extract(NEW.data,'$.commitSha') OR json_extract(OLD.data,'$.detectionId') IS NOT json_extract(NEW.data,'$.detectionId')
    OR json_extract(OLD.data,'$.channel') IS NOT json_extract(NEW.data,'$.channel') OR json_extract(OLD.data,'$.runtimeVersion') IS NOT json_extract(NEW.data,'$.runtimeVersion')
    OR json_extract(OLD.data,'$.platform') IS NOT json_extract(NEW.data,'$.platform')
  BEGIN SELECT RAISE(ABORT,'immutable job input'); END;
CREATE TRIGGER automation_job_delete BEFORE DELETE ON automation_jobs BEGIN SELECT RAISE(ABORT,'immutable automation job'); END;
CREATE TRIGGER automation_attempt_terminal BEFORE UPDATE ON automation_attempts WHEN OLD.outcome IS NOT NULL
  BEGIN SELECT RAISE(ABORT,'immutable terminal attempt'); END;
CREATE TRIGGER automation_attempt_identity BEFORE UPDATE ON automation_attempts
  WHEN OLD.app_id IS NOT NEW.app_id OR OLD.job_id IS NOT NEW.job_id OR OLD.id IS NOT NEW.id OR OLD.runner_id IS NOT NEW.runner_id
    OR OLD.credential_epoch IS NOT NEW.credential_epoch OR OLD.fence IS NOT NEW.fence OR OLD.claimed_at IS NOT NEW.claimed_at OR NEW.expires_at<OLD.expires_at
  BEGIN SELECT RAISE(ABORT,'immutable attempt identity'); END;
CREATE TRIGGER automation_attempt_delete BEFORE DELETE ON automation_attempts BEGIN SELECT RAISE(ABORT,'immutable attempt'); END;
CREATE TRIGGER automation_event_update BEFORE UPDATE ON automation_events BEGIN SELECT RAISE(ABORT,'append-only event'); END;
CREATE TRIGGER automation_event_delete BEFORE DELETE ON automation_events BEGIN SELECT RAISE(ABORT,'append-only event'); END;
CREATE TRIGGER automation_uploaded_asset_update BEFORE UPDATE ON automation_uploaded_assets BEGIN SELECT RAISE(ABORT,'immutable upload provenance'); END;
CREATE TRIGGER automation_uploaded_asset_delete BEFORE DELETE ON automation_uploaded_assets BEGIN SELECT RAISE(ABORT,'immutable upload provenance'); END;
CREATE TRIGGER automation_receipt_update BEFORE UPDATE ON automation_export_receipts BEGIN SELECT RAISE(ABORT,'immutable export receipt'); END;
CREATE TRIGGER automation_receipt_delete BEFORE DELETE ON automation_export_receipts BEGIN SELECT RAISE(ABORT,'immutable export receipt'); END;
CREATE TABLE automation_policy_history(
  app_id TEXT NOT NULL REFERENCES managed_applications(app_id),
  version INTEGER NOT NULL CHECK(version>0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=0),
  data TEXT NOT NULL CHECK(json_valid(data) AND json_extract(data,'$.appId') IS app_id
    AND json_extract(data,'$.version') IS version AND json_extract(data,'$.updatedAt') IS updated_at),
  PRIMARY KEY(app_id,version)
) STRICT;
CREATE TRIGGER automation_policy_append BEFORE INSERT ON automation_policy_history
  WHEN NEW.version<>coalesce((SELECT max(version)+1 FROM automation_policy_history WHERE app_id=NEW.app_id),1)
    OR NEW.updated_at<coalesce((SELECT max(updated_at) FROM automation_policy_history WHERE app_id=NEW.app_id),0)
  BEGIN SELECT RAISE(ABORT,'invalid policy version'); END;
CREATE TRIGGER automation_policy_update BEFORE UPDATE ON automation_policy_history BEGIN SELECT RAISE(ABORT,'immutable policy history'); END;
CREATE TRIGGER automation_policy_delete BEFORE DELETE ON automation_policy_history BEGIN SELECT RAISE(ABORT,'immutable policy history'); END;
CREATE TRIGGER automation_event_append BEFORE INSERT ON automation_events
  WHEN NEW.sequence<>coalesce((SELECT max(sequence)+1 FROM automation_events WHERE app_id=NEW.app_id AND job_id=NEW.job_id),1)
    OR NEW.sequence>1000 OR NEW.created_at<coalesce((SELECT max(created_at) FROM automation_events WHERE app_id=NEW.app_id AND job_id=NEW.job_id),0)
  BEGIN SELECT RAISE(ABORT,'invalid event sequence'); END;
