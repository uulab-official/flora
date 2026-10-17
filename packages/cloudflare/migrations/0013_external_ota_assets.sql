-- Additive external binary completion proofs. Apply this ENTIRE file atomically after
-- 0012. No legacy metadata, chunks, history, facts, ledger or keys are rewritten.
-- Existing 18-table accounting still charges ota_assets metadata. Proofs have
-- their own hard physical bound: 4096 immutable rows, <=2048 charged bytes each.
CREATE TABLE flora_external_assets_check(assertion INTEGER NOT NULL CHECK(assertion=1)) STRICT;
INSERT INTO flora_external_assets_check SELECT CASE WHEN
 EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='ota_app_capacity' AND sql LIKE '%>134217728%' AND sql LIKE '%>=128%')
 AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='flora_capacity' AND sql LIKE '%payload_bytes BETWEEN 0 AND 402653184%')
 AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='ota_asset_complete' AND sql LIKE '%incomplete asset%')
 AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='ota_rollback_binding') THEN 1 ELSE 0 END;
CREATE TABLE ota_external_assets (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK(sequence BETWEEN 1 AND 4096),
 owner_id TEXT NOT NULL, app_id TEXT NOT NULL,
 hash TEXT NOT NULL CHECK(length(hash)=64 AND hash NOT GLOB '*[^a-f0-9]*'),
 object_key TEXT NOT NULL CHECK((length(object_key)=137+length(app_id) AND substr(object_key,1,7)='ota/v1/' AND substr(object_key,8,64) NOT GLOB '*[^a-f0-9]*' AND substr(object_key,72,1)='/' AND substr(object_key,73,length(app_id))=app_id AND substr(object_key,73+length(app_id),1)='/') OR (length(object_key)=148+length(app_id) AND substr(object_key,1,18)='github-release/v1/' AND substr(object_key,19,64) NOT GLOB '*[^a-f0-9]*' AND substr(object_key,83,1)='/' AND substr(object_key,84,length(app_id))=app_id AND substr(object_key,84+length(app_id),1)='/')) CHECK(substr(object_key,-64)=hash),
 byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 16777216),
 object_version TEXT NOT NULL CHECK(length(object_version) BETWEEN 1 AND 768),
 etag TEXT NOT NULL CHECK(length(etag) BETWEEN 1 AND 128),
 stored_bytes INTEGER NOT NULL CHECK(stored_bytes BETWEEN 1 AND 2048),
 UNIQUE(owner_id,app_id,hash), FOREIGN KEY(owner_id,app_id) REFERENCES applications(owner_id,id),
 CHECK(stored_bytes=length(CAST(json_array(owner_id,app_id,hash,object_key,byte_length,object_version,etag) AS BLOB)))
) STRICT;
CREATE TRIGGER ota_external_assets_update BEFORE UPDATE ON ota_external_assets BEGIN SELECT RAISE(ABORT,'immutable external asset proof'); END;
CREATE TRIGGER ota_external_assets_delete BEFORE DELETE ON ota_external_assets BEGIN SELECT RAISE(ABORT,'immutable external asset proof'); END;
CREATE TRIGGER ota_external_assets_replace BEFORE INSERT ON ota_external_assets
 WHEN EXISTS(SELECT 1 FROM ota_external_assets WHERE sequence=NEW.sequence OR (owner_id=NEW.owner_id AND app_id=NEW.app_id AND hash=NEW.hash))
 BEGIN SELECT RAISE(ABORT,'immutable external asset proof'); END;
CREATE TRIGGER ota_external_assets_no_legacy BEFORE INSERT ON ota_external_assets
 WHEN EXISTS(SELECT 1 FROM ota_assets WHERE owner_id=NEW.owner_id AND app_id=NEW.app_id AND hash=NEW.hash)
 BEGIN SELECT RAISE(ABORT,'legacy asset storage is immutable'); END;
-- After this migration every NEW binary requires a server-verified external proof.
-- An absent/failed binding can never silently fall back to new D1 chunk writes.
CREATE TRIGGER ota_external_asset_required BEFORE INSERT ON ota_assets
 WHEN NOT EXISTS(SELECT 1 FROM ota_external_assets WHERE owner_id=NEW.owner_id AND app_id=NEW.app_id AND hash=NEW.hash AND byte_length=NEW.byte_length)
 BEGIN SELECT RAISE(ABORT,'external asset proof required'); END;
CREATE TRIGGER ota_external_chunk_forbidden BEFORE INSERT ON ota_asset_chunks
 WHEN EXISTS(SELECT 1 FROM ota_external_assets WHERE owner_id=NEW.owner_id AND app_id=NEW.app_id AND hash=NEW.hash)
 BEGIN SELECT RAISE(ABORT,'external asset binary forbidden'); END;
DROP TRIGGER ota_app_capacity;
CREATE TRIGGER ota_app_capacity BEFORE INSERT ON ota_assets
 WHEN NOT EXISTS(SELECT 1 FROM ota_external_assets WHERE owner_id=NEW.owner_id AND app_id=NEW.app_id AND hash=NEW.hash AND byte_length=NEW.byte_length)
 AND ((SELECT count(*) FROM ota_assets WHERE owner_id=NEW.owner_id AND app_id=NEW.app_id)>=128 OR (SELECT coalesce(sum(byte_length),0) FROM ota_assets WHERE owner_id=NEW.owner_id AND app_id=NEW.app_id)+NEW.byte_length>134217728)
 BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
DROP TRIGGER ota_asset_complete;
CREATE TRIGGER ota_asset_complete BEFORE INSERT ON ota_deployment_assets
 WHEN NOT EXISTS(SELECT 1 FROM ota_assets a WHERE a.owner_id=NEW.owner_id AND a.app_id=NEW.app_id AND a.hash=NEW.hash
 AND ((EXISTS(SELECT 1 FROM ota_external_assets r WHERE r.owner_id=a.owner_id AND r.app_id=a.app_id AND r.hash=a.hash AND r.byte_length=a.byte_length))
 OR (NOT EXISTS(SELECT 1 FROM ota_external_assets r WHERE r.owner_id=a.owner_id AND r.app_id=a.app_id AND r.hash=a.hash)
 AND a.chunk_count=(SELECT count(*) FROM ota_asset_chunks c WHERE c.owner_id=a.owner_id AND c.app_id=a.app_id AND c.hash=a.hash)
 AND a.byte_length=(SELECT coalesce(sum(byte_length),0) FROM ota_asset_chunks c WHERE c.owner_id=a.owner_id AND c.app_id=a.app_id AND c.hash=a.hash))))
 BEGIN SELECT RAISE(ABORT,'incomplete asset'); END;
DROP TABLE flora_external_assets_check;
