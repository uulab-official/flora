-- Additive issuance controls only. No gate is activated by this schema migration.
CREATE TABLE flora_org_runner_gate (
 owner_id TEXT PRIMARY KEY, generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
 operation_id TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('blocked','ledger_only')),
 protocol INTEGER NOT NULL CHECK(protocol=1), UNIQUE(owner_id,generation)
) STRICT;
CREATE TABLE flora_org_runner_reservations (
 owner_id TEXT NOT NULL, runner_id TEXT NOT NULL, operation_id TEXT NOT NULL,
 app_ids TEXT NOT NULL CHECK(json_valid(app_ids) AND json_type(app_ids)='array' AND json_array_length(app_ids) BETWEEN 1 AND 100),
 generation INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>0), consumed_at INTEGER,
 PRIMARY KEY(owner_id,runner_id), UNIQUE(owner_id,operation_id),
 FOREIGN KEY(owner_id,generation) REFERENCES flora_org_runner_gate(owner_id,generation),
 CHECK(consumed_at IS NULL OR consumed_at>0),
 CHECK(length(CAST(json_array(owner_id,runner_id,operation_id,app_ids,generation,expires_at,consumed_at) AS BLOB))<=2048)
) STRICT;
CREATE INDEX flora_org_runner_pending ON flora_org_runner_reservations(owner_id,expires_at,runner_id) WHERE consumed_at IS NULL;
CREATE TRIGGER flora_org_gate_owner BEFORE INSERT ON flora_org_runner_gate WHEN NOT EXISTS(SELECT 1 FROM flora_deployment WHERE owner_id=NEW.owner_id) BEGIN SELECT RAISE(ABORT,'org runner owner mismatch'); END;
CREATE TRIGGER flora_org_gate_update BEFORE UPDATE ON flora_org_runner_gate WHEN NEW.owner_id<>OLD.owner_id OR NEW.generation<>OLD.generation OR NEW.operation_id<>OLD.operation_id OR NEW.protocol<>OLD.protocol OR OLD.phase='ledger_only' AND NEW.phase<>'ledger_only' BEGIN SELECT RAISE(ABORT,'org runner permanent gate'); END;
CREATE TRIGGER flora_org_gate_delete BEFORE DELETE ON flora_org_runner_gate BEGIN SELECT RAISE(ABORT,'org runner permanent gate'); END;
CREATE TRIGGER flora_org_gate_replace BEFORE INSERT ON flora_org_runner_gate WHEN EXISTS(SELECT 1 FROM flora_org_runner_gate WHERE owner_id=NEW.owner_id) BEGIN SELECT RAISE(ABORT,'org runner permanent gate'); END;
CREATE TRIGGER flora_org_reservation_capacity BEFORE INSERT ON flora_org_runner_reservations WHEN (SELECT count(*) FROM flora_org_runner_reservations WHERE owner_id=NEW.owner_id AND consumed_at IS NULL AND expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))>=100 BEGIN SELECT RAISE(ABORT,'org runner reservation capacity'); END;
CREATE TRIGGER flora_org_reservation_update BEFORE UPDATE ON flora_org_runner_reservations WHEN NEW.owner_id<>OLD.owner_id OR NEW.runner_id<>OLD.runner_id OR NEW.operation_id<>OLD.operation_id OR NEW.app_ids<>OLD.app_ids OR NEW.generation<>OLD.generation OR NEW.expires_at<>OLD.expires_at OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL BEGIN SELECT RAISE(ABORT,'org runner immutable reservation'); END;
CREATE TRIGGER flora_org_reservation_delete BEFORE DELETE ON flora_org_runner_reservations WHEN OLD.consumed_at IS NOT NULL OR OLD.expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) BEGIN SELECT RAISE(ABORT,'org runner immutable reservation'); END;
CREATE TRIGGER flora_org_reservation_replace BEFORE INSERT ON flora_org_runner_reservations WHEN EXISTS(SELECT 1 FROM flora_org_runner_reservations WHERE owner_id=NEW.owner_id AND (runner_id=NEW.runner_id OR operation_id=NEW.operation_id)) BEGIN SELECT RAISE(ABORT,'org runner immutable reservation'); END;
CREATE TRIGGER flora_org_runner_first_insert BEFORE INSERT ON automation_runners WHEN NEW.version=1 AND EXISTS(SELECT 1 FROM flora_org_runner_gate WHERE owner_id=NEW.owner_id)
BEGIN
 SELECT RAISE(ABORT,'org runner issuance blocked') WHERE NOT EXISTS(
  SELECT 1 FROM flora_org_runner_gate g JOIN flora_org_runner_reservations r ON r.owner_id=g.owner_id AND r.generation=g.generation
  WHERE g.owner_id=NEW.owner_id AND g.phase='ledger_only' AND g.protocol=1 AND r.runner_id=NEW.id AND r.consumed_at IS NULL
  AND r.expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  AND json_type(NEW.data,'$.appIds')='array' AND json_array_length(NEW.data,'$.appIds')=json_array_length(r.app_ids)
  AND r.app_ids=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(NEW.data,'$.appIds') ORDER BY value))
 );
 UPDATE flora_org_runner_reservations SET consumed_at=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) WHERE owner_id=NEW.owner_id AND runner_id=NEW.id AND consumed_at IS NULL;
END;
