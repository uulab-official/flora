import type {OrgStorage} from './types.js';
/** Additive only: no existing authority, credential, workflow or journal rows. */
export function createOrgSchema(storage:OrgStorage):void {
 storage.sql.exec(`
 CREATE TABLE IF NOT EXISTS flora_org_state (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),id TEXT NOT NULL UNIQUE,owner_id TEXT NOT NULL,db_identity TEXT NOT NULL,origin TEXT NOT NULL,
 owner_email TEXT NOT NULL,display_name TEXT NOT NULL,schema_version INTEGER NOT NULL CHECK(schema_version=1),min_protocol INTEGER NOT NULL CHECK(min_protocol>=1),
 mode TEXT NOT NULL CHECK(mode IN('owner_only','preparing','active','paused')),revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 org_access_epoch INTEGER NOT NULL CHECK(org_access_epoch BETWEEN 1 AND 9007199254740991),metadata_bytes INTEGER NOT NULL DEFAULT 0 CHECK(metadata_bytes>=0),
 audit_bytes INTEGER NOT NULL DEFAULT 0 CHECK(audit_bytes>=0),safety_bytes INTEGER NOT NULL DEFAULT 0 CHECK(safety_bytes>=0));
 CREATE TABLE IF NOT EXISTS flora_org_users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,
 auth_source TEXT NOT NULL CHECK(auth_source IN('legacy_owner','member')),status TEXT NOT NULL CHECK(status IN('active','disabled')),auth_epoch INTEGER NOT NULL CHECK(auth_epoch BETWEEN 1 AND 9007199254740991));
 CREATE UNIQUE INDEX IF NOT EXISTS flora_org_single_owner ON flora_org_users(auth_source) WHERE auth_source='legacy_owner';
 CREATE TABLE IF NOT EXISTS flora_org_passwords(user_id TEXT PRIMARY KEY,verifier TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS flora_org_password_member_only BEFORE INSERT ON flora_org_passwords BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM flora_org_users WHERE id=NEW.user_id AND auth_source='member') THEN RAISE(ABORT,'org member password required') END; END;
 CREATE TRIGGER IF NOT EXISTS flora_org_password_update_member_only BEFORE UPDATE ON flora_org_passwords BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM flora_org_users WHERE id=NEW.user_id AND auth_source='member') THEN RAISE(ABORT,'org member password required') END; END;
 CREATE TABLE IF NOT EXISTS flora_org_memberships(id TEXT PRIMARY KEY,org_id TEXT NOT NULL,user_id TEXT NOT NULL UNIQUE,
 role TEXT NOT NULL CHECK(role IN('owner','admin','deployer','viewer')),status TEXT NOT NULL CHECK(status IN('active','disabled')),revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991));
 CREATE UNIQUE INDEX IF NOT EXISTS flora_org_protected_owner ON flora_org_memberships(role) WHERE role='owner';
 CREATE TABLE IF NOT EXISTS flora_org_app_access(membership_id TEXT NOT NULL,app_id TEXT NOT NULL,active INTEGER NOT NULL CHECK(active IN(0,1)),PRIMARY KEY(membership_id,app_id));
 CREATE TABLE IF NOT EXISTS flora_org_sessions(sequence INTEGER PRIMARY KEY AUTOINCREMENT,session_hash TEXT NOT NULL UNIQUE,csrf_hash TEXT NOT NULL,
 user_id TEXT NOT NULL,membership_id TEXT NOT NULL,auth_epoch INTEGER NOT NULL,owner_epoch INTEGER NOT NULL,expires_at INTEGER NOT NULL,reauth_until INTEGER NOT NULL DEFAULT 0);
 CREATE INDEX IF NOT EXISTS flora_org_sessions_user ON flora_org_sessions(user_id,sequence);
 CREATE TABLE IF NOT EXISTS flora_org_invites(id TEXT PRIMARY KEY,nonce_hash TEXT NOT NULL UNIQUE,email TEXT NOT NULL,purpose TEXT NOT NULL CHECK(purpose IN('invite','reset','reactivate')),
 target_user_id TEXT,auth_epoch INTEGER,membership_revision INTEGER,user_status TEXT,membership_status TEXT,issuer_id TEXT NOT NULL,owner_epoch INTEGER NOT NULL,
 purpose_generation INTEGER NOT NULL,role TEXT,app_ids TEXT,expires_at INTEGER NOT NULL,consumed_at INTEGER,revoked_at INTEGER,created_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS flora_org_invites_target ON flora_org_invites(email,purpose,purpose_generation);
 CREATE TABLE IF NOT EXISTS flora_org_runner_access(kind TEXT NOT NULL CHECK(kind IN('ota','native')),runner_id TEXT NOT NULL,org_id TEXT NOT NULL,app_ids TEXT NOT NULL,platforms TEXT NOT NULL,
 owner_mode TEXT NOT NULL CHECK(owner_mode IN('organization','personal')),issuer_id TEXT NOT NULL,approver_id TEXT,sponsor_id TEXT,sponsor_auth_epoch INTEGER,sponsor_revision INTEGER,
 org_access_epoch INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN('pending','ready','revoked','unknown')),operation_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(kind,runner_id));
 CREATE TABLE IF NOT EXISTS flora_org_runner_requests(id TEXT PRIMARY KEY,app_id TEXT NOT NULL,kind TEXT NOT NULL,name TEXT NOT NULL,platforms TEXT NOT NULL,
 requester_id TEXT NOT NULL,requester_auth_epoch INTEGER NOT NULL,requester_revision INTEGER NOT NULL,approver_id TEXT,approver_auth_epoch INTEGER,approver_revision INTEGER,
 org_access_epoch INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN('pending','approved','issuing','claimed','revoked','unknown')),revision INTEGER NOT NULL,
 requested_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,claim_expires_at INTEGER,runner_id TEXT,operation_id TEXT);
 CREATE INDEX IF NOT EXISTS flora_org_requests_app ON flora_org_runner_requests(app_id,id);
 CREATE TABLE IF NOT EXISTS flora_org_audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL,phase TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL,safety INTEGER NOT NULL CHECK(safety IN(0,1)));
 CREATE INDEX IF NOT EXISTS flora_org_audit_operation ON flora_org_audit(operation_id,sequence);
 CREATE TABLE IF NOT EXISTS flora_org_auth_budget(bucket TEXT PRIMARY KEY,attempt_window INTEGER NOT NULL,attempts INTEGER NOT NULL,kdf_window INTEGER NOT NULL,kdfs INTEGER NOT NULL);
 `);
 storage.sql.exec('CREATE INDEX IF NOT EXISTS flora_org_requests_operation ON flora_org_runner_requests(operation_id)');
 for(const table of ['flora_org_runner_access','flora_org_runner_requests'])
  if(!storage.sql.exec<{name:string}>('PRAGMA table_info('+table+')').toArray().some(c=>c.name==='owner_epoch'))
   storage.sql.exec('ALTER TABLE '+table+' ADD COLUMN owner_epoch INTEGER NOT NULL DEFAULT 0');
 // This column belongs to the new organization table, never the legacy sessions.
 if(!storage.sql.exec<{name:string}>('PRAGMA table_info(flora_org_state)').toArray().some(c=>c.name==='owner_reauth'))
  storage.sql.exec("ALTER TABLE flora_org_state ADD COLUMN owner_reauth TEXT NOT NULL DEFAULT '{}'");
}
