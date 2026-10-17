CREATE TABLE github_connection_history(
  app_id TEXT NOT NULL REFERENCES managed_applications(app_id),
  version INTEGER NOT NULL CHECK(version>0),
  data TEXT NOT NULL CHECK(json_valid(data) AND json_extract(data,'$.appId') IS app_id AND json_extract(data,'$.version') IS version),
  PRIMARY KEY(app_id,version)
) STRICT;
CREATE TABLE github_detections(
  app_id TEXT NOT NULL REFERENCES managed_applications(app_id),
  id TEXT NOT NULL,
  connection_version INTEGER NOT NULL,
  detected_at INTEGER NOT NULL CHECK(detected_at>=0),
  data TEXT NOT NULL CHECK(json_valid(data) AND json_extract(data,'$.appId') IS app_id AND json_extract(data,'$.id') IS id
    AND json_extract(data,'$.connection.version') IS connection_version),
  PRIMARY KEY(app_id,id),
  FOREIGN KEY(app_id,connection_version) REFERENCES github_connection_history(app_id,version)
) STRICT;
CREATE TABLE ota_assets(
  app_id TEXT NOT NULL REFERENCES managed_applications(app_id),
  id TEXT NOT NULL,
  digest TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 16777216),
  bytes BLOB NOT NULL CHECK(length(bytes)=size),
  data TEXT NOT NULL CHECK(json_valid(data) AND json_extract(data,'$.appId') IS app_id AND json_extract(data,'$.id') IS id
    AND json_extract(data,'$.digest') IS digest AND json_extract(data,'$.size') IS size),
  PRIMARY KEY(app_id,id),
  UNIQUE(app_id,digest)
) STRICT;
CREATE TABLE ota_deployments(
  app_id TEXT NOT NULL REFERENCES managed_applications(app_id),
  id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  detection_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('ios','android')),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  data TEXT NOT NULL CHECK(json_valid(data) AND json_extract(data,'$.appId') IS app_id AND json_extract(data,'$.id') IS id
    AND json_extract(data,'$.requestKey') IS request_key AND json_extract(data,'$.detectionId') IS detection_id
    AND json_extract(data,'$.channel') IS channel AND json_extract(data,'$.runtimeVersion') IS runtime_version AND json_extract(data,'$.platform') IS platform),
  PRIMARY KEY(app_id,id),
  UNIQUE(app_id,request_key),
  FOREIGN KEY(app_id,detection_id) REFERENCES github_detections(app_id,id)
) STRICT;
CREATE TABLE ota_deployment_assets(
  app_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('launch','asset')),
  PRIMARY KEY(app_id,deployment_id,asset_id),
  FOREIGN KEY(app_id,deployment_id) REFERENCES ota_deployments(app_id,id),
  FOREIGN KEY(app_id,asset_id) REFERENCES ota_assets(app_id,id)
) STRICT;
CREATE INDEX ota_latest ON ota_deployments(app_id,channel,runtime_version,platform,created_at,id);
CREATE INDEX ota_published_assets ON ota_deployment_assets(app_id,asset_id);
CREATE TRIGGER connection_append BEFORE INSERT ON github_connection_history
  WHEN NEW.version<>coalesce((SELECT max(version)+1 FROM github_connection_history WHERE app_id=NEW.app_id),1)
  BEGIN SELECT RAISE(ABORT,'invalid connection version'); END;
CREATE TRIGGER detection_current_connection BEFORE INSERT ON github_detections
  WHEN NEW.connection_version<>(SELECT max(version) FROM github_connection_history WHERE app_id=NEW.app_id)
    OR json_extract(NEW.data,'$.rootDirectory') IS NOT (SELECT root_directory FROM managed_applications WHERE app_id=NEW.app_id)
    OR json_extract(NEW.data,'$.connection') IS NOT (SELECT json(data) FROM github_connection_history WHERE app_id=NEW.app_id AND version=NEW.connection_version)
  BEGIN SELECT RAISE(ABORT,'invalid detection binding'); END;
CREATE TRIGGER ota_asset_quota BEFORE INSERT ON ota_assets
  WHEN (SELECT count(*) FROM ota_assets WHERE app_id=NEW.app_id)>=128
    OR coalesce((SELECT sum(size) FROM ota_assets WHERE app_id=NEW.app_id),0)+NEW.size>67108864
  BEGIN SELECT RAISE(ABORT,'asset quota'); END;
CREATE TRIGGER github_connections_update BEFORE UPDATE ON github_connection_history BEGIN SELECT RAISE(ABORT,'immutable connection'); END;
CREATE TRIGGER github_connections_delete BEFORE DELETE ON github_connection_history BEGIN SELECT RAISE(ABORT,'immutable connection'); END;
CREATE TRIGGER github_detections_update BEFORE UPDATE ON github_detections BEGIN SELECT RAISE(ABORT,'immutable detection'); END;
CREATE TRIGGER github_detections_delete BEFORE DELETE ON github_detections BEGIN SELECT RAISE(ABORT,'immutable detection'); END;
CREATE TRIGGER ota_assets_update BEFORE UPDATE ON ota_assets BEGIN SELECT RAISE(ABORT,'immutable asset'); END;
CREATE TRIGGER ota_assets_delete BEFORE DELETE ON ota_assets BEGIN SELECT RAISE(ABORT,'immutable asset'); END;
CREATE TRIGGER ota_deployments_update BEFORE UPDATE ON ota_deployments BEGIN SELECT RAISE(ABORT,'immutable deployment'); END;
CREATE TRIGGER ota_deployments_delete BEFORE DELETE ON ota_deployments BEGIN SELECT RAISE(ABORT,'immutable deployment'); END;
CREATE TRIGGER ota_refs_update BEFORE UPDATE ON ota_deployment_assets BEGIN SELECT RAISE(ABORT,'immutable publication reference'); END;
CREATE TRIGGER ota_refs_delete BEFORE DELETE ON ota_deployment_assets BEGIN SELECT RAISE(ABORT,'immutable publication reference'); END;
CREATE TRIGGER ota_refs_declared BEFORE INSERT ON ota_deployment_assets
  WHEN NOT EXISTS(SELECT 1 FROM ota_deployments d WHERE d.app_id=NEW.app_id AND d.id=NEW.deployment_id
    AND ((NEW.role='launch' AND json_extract(d.data,'$.launchAssetId')=NEW.asset_id)
      OR (NEW.role='asset' AND EXISTS(SELECT 1 FROM json_each(d.data,'$.assetIds') WHERE value=NEW.asset_id))))
  BEGIN SELECT RAISE(ABORT,'undeclared publication reference'); END;
