-- No rows, asset bytes or capacity facts are rewritten. Normal publications
-- retain the current-connection rule. Operator rollback is authorized only by
-- an already committed artifact and an atomic comparison of the current head.
DROP TRIGGER ota_connection_current;
CREATE TRIGGER ota_connection_current BEFORE INSERT ON ota_deployments
WHEN json_type(NEW.data,'$.rollback') IS NULL AND NOT EXISTS(
  SELECT 1 FROM github_detections d JOIN github_connections c ON c.owner_id=d.owner_id AND c.app_id=d.app_id
  WHERE d.owner_id=NEW.owner_id AND d.app_id=NEW.app_id AND d.id=json_extract(NEW.data,'$.detectionId')
  AND c.version=(SELECT max(version) FROM github_connections WHERE owner_id=NEW.owner_id AND app_id=NEW.app_id)
  AND json_extract(d.data,'$.connection')=json(c.data)
) BEGIN SELECT RAISE(ABORT,'deployment provenance mismatch'); END;
CREATE TRIGGER ota_rollback_binding BEFORE INSERT ON ota_deployments
WHEN json_type(NEW.data,'$.rollback') IS NOT NULL AND (
  json_type(NEW.data,'$.rollback') IS NOT 'object'
  OR (SELECT count(*) FROM json_each(NEW.data,'$.rollback'))<>4
  OR json_type(NEW.data,'$.rollback.reason') IS NOT 'text'
  OR length(trim(json_extract(NEW.data,'$.rollback.reason'))) NOT BETWEEN 1 AND 500
  OR json_type(NEW.data,'$.rollback.requestedAt') IS NOT 'integer'
  OR json_extract(NEW.data,'$.rollback.requestedAt')<0
  OR json_extract(NEW.data,'$.rollback.requestedAt')>NEW.created_at
  OR NOT EXISTS(
    SELECT 1 FROM ota_deployments source JOIN ota_deployments target ON target.owner_id=source.owner_id AND target.app_id=source.app_id
    WHERE source.owner_id=NEW.owner_id AND source.app_id=NEW.app_id
    AND source.id=json_extract(NEW.data,'$.rollback.fromDeploymentId')
    AND target.id=json_extract(NEW.data,'$.rollback.targetDeploymentId')
    AND source.id=(SELECT id FROM ota_deployments WHERE owner_id=NEW.owner_id AND app_id=NEW.app_id AND channel=NEW.channel AND runtime_version=NEW.runtime_version AND platform=NEW.platform ORDER BY created_at DESC,rowid DESC LIMIT 1)
    AND target.created_at<source.created_at
    AND target.channel=NEW.channel AND target.runtime_version=NEW.runtime_version AND target.platform=NEW.platform
    AND source.channel=NEW.channel AND source.runtime_version=NEW.runtime_version AND source.platform=NEW.platform
    AND NEW.id<>source.id AND NEW.id<>target.id
    AND json_extract(target.data,'$.detectionId') IS json_extract(NEW.data,'$.detectionId')
    AND json_extract(target.data,'$.commitSha') IS json_extract(NEW.data,'$.commitSha')
    AND json_extract(target.data,'$.launchAssetId') IS json_extract(NEW.data,'$.launchAssetId')
    AND json_extract(target.data,'$.assetIds') IS json_extract(NEW.data,'$.assetIds')
    AND json_extract(target.data,'$.launchAsset') IS json_extract(NEW.data,'$.launchAsset')
    AND json_extract(target.data,'$.assets') IS json_extract(NEW.data,'$.assets')
  )
) BEGIN SELECT RAISE(ABORT,'rollback provenance mismatch'); END;
