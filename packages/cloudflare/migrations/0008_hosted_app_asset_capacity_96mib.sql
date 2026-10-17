-- Hosted D1 only. Prerequisite: complete 0001-0007 migrations.
-- Execute this ENTIRE file in ONE migration transaction. Replace only the
-- app-local raw asset byte guard: 64 MiB -> 96 MiB. Existing rows, accounting
-- facts/ledger, 256 MiB workspace payload ceiling, 128-asset count, 16 MiB
-- per-asset ceiling, chunk completeness and publication guards stay unchanged.
DROP TRIGGER ota_app_capacity;
CREATE TRIGGER ota_app_capacity BEFORE INSERT ON ota_assets
  WHEN (SELECT count(*) FROM ota_assets WHERE owner_id=NEW.owner_id AND app_id=NEW.app_id)>=128
    OR (SELECT coalesce(sum(byte_length),0) FROM ota_assets WHERE owner_id=NEW.owner_id AND app_id=NEW.app_id)+NEW.byte_length>100663296
  BEGIN SELECT RAISE(ABORT,'flora capacity exceeded'); END;
