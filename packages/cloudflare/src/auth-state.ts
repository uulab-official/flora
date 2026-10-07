import type { DurableObject } from "cloudflare:workers";
type AuthStorage = ConstructorParameters<typeof DurableObject>[0]["storage"];
import type { AuthGrant, FloraConfig, SetupWindow } from "./contracts.js";
import type { PasswordVerifierV1 } from "./auth/password.js";

export class AuthFailure extends Error {
  constructor(readonly status: number, readonly code: string, readonly retryAfter?: number) { super(code); }
}

type Meta = {
  owner_id: string; owner_email: string; origin: string; db_identity: string;
  verifier: string | null; epoch: number; setup_generation: number; setup_json: string | null; setup_closed: number;
};
type Session = { session_hash: string; csrf_hash: string; epoch: number; expires_at: number };
type Budget = { attempt_window: number; attempts: number; kdf_window: number; kdfs: number };
export interface NewSession { sessionHash: string; csrfHash: string; expiresAt: number }

const attemptPeriod = 900_000, kdfPeriod = 3_600_000;
const windowStart = (now: number, width: number) => Math.floor(now / width) * width;
const setupKey = (setup: SetupWindow) => JSON.stringify(setup);

/** Only authentication metadata lives here. Application imports belong to D1.
 *
 * Restore gate: take public authentication offline before restoring storage.
 * The external deployment ledger must retain the highest issued generation.
 * Reopen only a verified backup retaining its claimed-owner marker, invalidate
 * every session, and provision a strictly newer recover-only generation.
 * Pre-enrollment/unknown backups stay offline; rollback is not automatically safe.
 */
export class AuthState {
  constructor(private readonly storage: AuthStorage, config: FloraConfig) {
    storage.transactionSync(() => {
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS flora_auth_meta (
        id INTEGER PRIMARY KEY CHECK (id=1), owner_id TEXT NOT NULL, owner_email TEXT NOT NULL,
        origin TEXT NOT NULL, db_identity TEXT NOT NULL, verifier TEXT,
        epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch>=0 AND epoch<=9007199254740991),
        setup_generation INTEGER NOT NULL DEFAULT 0 CHECK (setup_generation>=0 AND setup_generation<=9007199254740991),
        setup_json TEXT, setup_closed INTEGER NOT NULL DEFAULT 1 CHECK (setup_closed IN (0,1))
      );
      CREATE TABLE IF NOT EXISTS flora_auth_sessions (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        session_hash TEXT NOT NULL UNIQUE CHECK (length(session_hash)=64),
        csrf_hash TEXT NOT NULL CHECK (length(csrf_hash)=64),
        epoch INTEGER NOT NULL CHECK (epoch>0), expires_at INTEGER NOT NULL CHECK (expires_at>0)
      );
      CREATE TABLE IF NOT EXISTS flora_auth_budget (
        id INTEGER PRIMARY KEY CHECK (id=1), attempt_window INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
        kdf_window INTEGER NOT NULL DEFAULT 0, kdfs INTEGER NOT NULL DEFAULT 0 CHECK (kdfs BETWEEN 0 AND 60)
      )`);
      storage.sql.exec("INSERT INTO flora_auth_meta(id,owner_id,owner_email,origin,db_identity) VALUES(1,?,?,?,?) ON CONFLICT(id) DO NOTHING", config.ownerId, config.ownerEmail, config.origin, config.dbIdentity);
      storage.sql.exec("INSERT INTO flora_auth_budget(id) VALUES(1) ON CONFLICT(id) DO NOTHING");
      this.synchronize(config, Date.now());
    });
  }

  private meta(): Meta { return this.storage.sql.exec<Meta>("SELECT * FROM flora_auth_meta WHERE id=1").one(); }

  synchronize(config: FloraConfig, now: number): void {
    this.storage.transactionSync(() => {
      const row = this.meta();
      if (row.owner_id !== config.ownerId || row.owner_email !== config.ownerEmail || row.origin !== config.origin || row.db_identity !== config.dbIdentity) throw new AuthFailure(503, "AUTH_UNAVAILABLE");
      const setup = config.setup;
      if (setup && setup.generation > row.setup_generation) {
        const closed = now >= setup.expiresAt || (row.verifier === null ? setup.purpose !== "enroll" : setup.purpose !== "recover");
        this.storage.sql.exec("UPDATE flora_auth_meta SET setup_generation=?,setup_json=?,setup_closed=? WHERE id=1", setup.generation, setupKey(setup), Number(closed));
      } else if (setup && setup.generation === row.setup_generation && row.setup_json !== setupKey(setup)) {
        // A mutated generation poisons that window permanently, including when
        // an old deployment later brings back the original configuration.
        this.storage.sql.exec("UPDATE flora_auth_meta SET setup_closed=1 WHERE id=1");
      }
      const current = this.meta();
      if (!current.setup_closed && current.setup_json !== null && now >= (JSON.parse(current.setup_json) as SetupWindow).expiresAt) {
        this.storage.sql.exec("UPDATE flora_auth_meta SET setup_closed=1 WHERE id=1");
      }
    });
  }

  owner(): { epoch: number; verifier: PasswordVerifierV1 | null } {
    const row = this.meta();
    return { epoch: row.epoch, verifier: row.verifier === null ? null : JSON.parse(row.verifier) as PasswordVerifierV1 };
  }

  requireSetup(config: FloraConfig, purpose: SetupWindow["purpose"], digest: string, now: number): SetupWindow {
    const row = this.meta(), setup = config.setup;
    if (!setup || row.setup_closed || row.setup_generation !== setup.generation || row.setup_json !== setupKey(setup)
      || setup.purpose !== purpose || setup.digest !== digest || now < setup.issuedAt || now >= setup.expiresAt
      || (purpose === "enroll" ? row.verifier !== null : row.verifier === null)) throw new AuthFailure(403, "SETUP_UNAVAILABLE");
    return setup;
  }

  reserve(now: number, kdf: boolean): void {
    this.storage.transactionSync(() => {
      const row = this.storage.sql.exec<Budget>("SELECT * FROM flora_auth_budget WHERE id=1").one();
      const attemptWindow = Math.max(row.attempt_window, windowStart(now, attemptPeriod));
      const kdfWindow = Math.max(row.kdf_window, windowStart(now, kdfPeriod));
      const attempts = attemptWindow === row.attempt_window ? row.attempts : 0;
      const kdfs = kdfWindow === row.kdf_window ? row.kdfs : 0;
      const waits: number[] = [];
      if (attempts >= 5) waits.push(Math.min(900, Math.max(1, Math.ceil((attemptWindow + attemptPeriod - now) / 1000))));
      if (kdf && kdfs >= 60) waits.push(Math.min(3600, Math.max(1, Math.ceil((kdfWindow + kdfPeriod - now) / 1000))));
      if (waits.length) throw new AuthFailure(429, "RATE_LIMITED", Math.max(...waits));
      this.storage.sql.exec("UPDATE flora_auth_budget SET attempt_window=?,attempts=?,kdf_window=?,kdfs=? WHERE id=1", attemptWindow, attempts + 1, kdfWindow, kdfs + Number(kdf));
    });
  }

  private insertSession(session: NewSession, epoch: number, now: number): void {
    this.storage.sql.exec("DELETE FROM flora_auth_sessions WHERE expires_at<=? OR epoch<>?", now, epoch);
    this.storage.sql.exec("INSERT INTO flora_auth_sessions(session_hash,csrf_hash,epoch,expires_at) VALUES(?,?,?,?)", session.sessionHash, session.csrfHash, epoch, session.expiresAt);
    this.storage.sql.exec("DELETE FROM flora_auth_sessions WHERE sequence NOT IN (SELECT sequence FROM flora_auth_sessions ORDER BY sequence DESC LIMIT 5)");
  }

  claim(config: FloraConfig, setup: SetupWindow, digest: string, verifier: PasswordVerifierV1, session: NewSession, now: number): void {
    this.storage.transactionSync(() => {
      const current = this.requireSetup(config, setup.purpose, digest, now);
      if (setupKey(current) !== setupKey(setup)) throw new AuthFailure(403, "SETUP_UNAVAILABLE");
      const epoch = this.meta().epoch + 1;
      if (!Number.isSafeInteger(epoch)) throw new AuthFailure(503, "AUTH_UNAVAILABLE");
      this.storage.sql.exec("UPDATE flora_auth_meta SET verifier=?,epoch=?,setup_closed=1 WHERE id=1", JSON.stringify(verifier), epoch);
      this.storage.sql.exec("DELETE FROM flora_auth_sessions");
      this.insertSession(session, epoch, now);
    });
  }

  login(expectedEpoch: number, session: NewSession, now: number): void {
    this.storage.transactionSync(() => {
      const owner = this.meta();
      if (owner.epoch !== expectedEpoch || owner.verifier === null) throw new AuthFailure(401, "UNAUTHENTICATED");
      this.insertSession(session, owner.epoch, now);
    });
  }

  session(sessionHash: string, now: number): Session {
    const row = this.storage.sql.exec<Session>("SELECT session_hash,csrf_hash,epoch,expires_at FROM flora_auth_sessions WHERE session_hash=?", sessionHash).toArray()[0];
    const owner = this.meta();
    if (!row || row.expires_at <= now || row.epoch !== owner.epoch || owner.verifier === null) throw new AuthFailure(401, "UNAUTHENTICATED");
    return row;
  }

  assertCurrent(grant: AuthGrant, now: number): void {
    const session = this.session(grant.sessionHash, now), owner = this.meta();
    if (owner.owner_id !== grant.ownerId || session.epoch !== grant.epoch || session.expires_at !== grant.expiresAt) throw new AuthFailure(401, "UNAUTHENTICATED");
  }

  logout(grant: AuthGrant, now: number): void {
    this.storage.transactionSync(() => {
      this.assertCurrent(grant, now);
      this.storage.sql.exec("DELETE FROM flora_auth_sessions WHERE session_hash=?", grant.sessionHash);
    });
  }
}
