-- Hosted D1 only. Prerequisite: complete 0001-0011 migrations.
-- Execute this ENTIRE file in ONE transaction, never isolated statements.
-- Raise only the app-local raw asset byte guard: 96 MiB -> 128 MiB.
-- Existing source/history/assets/counters/facts/ledgers/keys are not rewritten.
-- The shared canonical workspace ceiling remains 384 MiB, count stays 128 per
-- app, and the per-asset ceiling remains 16 MiB. Physical D1 usage is separate.
CREATE TABLE flora_app_asset_128mib_check(assertion INTEGER NOT NULL CHECK(assertion=1)) STRICT;
INSERT INTO flora_app_asset_128mib_check SELECT CASE WHEN
  (SELECT count(*) FROM flora_capacity)=1
  AND (SELECT count(*) FROM flora_capacity_ledger)=18
  AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='flora_capacity' AND sql LIKE '%payload_bytes BETWEEN 0 AND 402653184%')
  AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='flora_capacity_ledger' AND sql LIKE '%payload_bytes BETWEEN 0 AND 402653184%')
  AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='capacity_integrity' AND sql LIKE '%flora_capacity_ledger%')
  AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='ota_assets_capacity' AND tbl_name='ota_assets' AND sql LIKE '%<=402653184%')
  AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='ota_app_capacity' AND tbl_name='ota_assets' AND sql LIKE '%>100663296%' AND sql LIKE '%>=128%')
  THEN 1 ELSE 0 END;
DROP TRIGGER ota_app_capacity;
CREATE TRIGGER ota_app_capacity BEFORE INSERT ON ota_assets
  WHEN (SELECT count(*) FROM ota_assets WHERE owner_id=NEW.owner_id AND app_id=NEW.app_id)>=128
    OR (SELECT coalesce(sum(byte_length),0) FROM ota_assets WHERE owner_id=NEW.owner_id AND app_id=NEW.app_id)+NEW.byte_length>134217728
  BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
DROP TABLE flora_app_asset_128mib_check;
