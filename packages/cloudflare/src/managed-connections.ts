import type { DurableObject } from "cloudflare:workers";
import { createGitHubAppJWT, importRSAPrivateKey, isGitHubInstallationToken } from "@app-ops/dogfood";
import type { GitHubAppCredentials, GitHubConnection } from "@app-ops/dogfood";
import type { AuthGrant, FloraConfig, FloraEnv } from "./contracts.js";
import { AuthFailure } from "./auth-state.js";
import type { ManagedSigningKey } from "./managed-signing.js";
type Storage = ConstructorParameters<typeof DurableObject>[0]["storage"];
type AppRecord = { app_id: string; slug: string; private_key: string; webhook_secret: string; created_at: number };
type StateRecord = { session_hash: string; epoch: number; expires_at: number };
const stateLifetime = 600_000;
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
async function stateHash(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuthFailure(502, "GITHUB_UNAVAILABLE");
  return value as Record<string, unknown>;
}
function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new AuthFailure(502, "GITHUB_UNAVAILABLE");
  return value;
}
function slug(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)) throw new AuthFailure(502, "GITHUB_UNAVAILABLE");
  return value;
}
/** Bounded fixed-origin requests; response bodies never enter errors or logs. */
async function github(path: string, token?: string, data?: Record<string, unknown>): Promise<unknown> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch("https://api.github.com" + path, { method: data === undefined ? "GET" : "POST", redirect: "manual", signal: controller.signal,
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "flora-managed-connection", ...(token ? { Authorization: "Bearer " + token } : {}), ...(data ? { "Content-Type": "application/json" } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}) });
    if (![200, 201].includes(response.status) || !response.body) throw new AuthFailure(response.status === 403 || response.status === 404 ? 403 : 502, response.status === 403 || response.status === 404 ? "GITHUB_PERMISSION_DENIED" : "GITHUB_UNAVAILABLE");
    reader = response.body.getReader(); let size = 0; const parts: Uint8Array[] = [];
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 1_048_576) throw new AuthFailure(502, "GITHUB_UNAVAILABLE"); parts.push(part.value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)) as unknown;
  } catch (error) { throw error instanceof AuthFailure ? error : new AuthFailure(502, "GITHUB_UNAVAILABLE"); }
  finally { clearTimeout(timer); void reader?.cancel().catch(() => {}); }
}

/** All secrets are confined to the same private owner DO as session authority.
 * This additive schema never mutates legacy auth or D1 application records. */
export class ManagedConnections {
  constructor(private readonly storage: Storage, private readonly env: FloraEnv) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS flora_managed_github (
      id INTEGER PRIMARY KEY CHECK(id=1), app_id TEXT NOT NULL, slug TEXT NOT NULL,
      private_key TEXT NOT NULL, webhook_secret TEXT NOT NULL, created_at INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS flora_github_manifest_state (
      state_hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL, epoch INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS flora_managed_signing (
      app_id TEXT PRIMARY KEY, key_id TEXT NOT NULL, private_key TEXT NOT NULL,
      certificate TEXT NOT NULL, created_at INTEGER NOT NULL
    )`);
  }
  private managed(): AppRecord | null { return this.storage.sql.exec<AppRecord>("SELECT * FROM flora_managed_github WHERE id=1").toArray()[0] ?? null; }
  credentials(): GitHubAppCredentials | undefined {
    const row = this.managed();
    return row ? { appId: row.app_id, privateKey: row.private_key } : this.env.FLORA_GITHUB_APP_ID && this.env.FLORA_GITHUB_PRIVATE_KEY ? { appId: this.env.FLORA_GITHUB_APP_ID, privateKey: this.env.FLORA_GITHUB_PRIVATE_KEY } : undefined;
  }
  webhookSecret(): string | undefined { return this.managed()?.webhook_secret ?? this.env.FLORA_GITHUB_WEBHOOK_SECRET; }
  status() {
    const managed = this.managed(), credentials = this.credentials();
    return { configured: Boolean(credentials), source: managed ? "managed" : credentials ? "environment" : null,
      appId: credentials?.appId ?? null, appSlug: managed?.slug ?? null,
      installationUrl: managed ? "https://github.com/apps/" + managed.slug + "/installations/new" : null };
  }
  async start(config: FloraConfig, grant: AuthGrant, organization: string | undefined, fence: () => void) {
    fence(); if (this.credentials()) throw new AuthFailure(409, "GITHUB_ALREADY_CONFIGURED");
    if (organization !== undefined && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(organization)) throw new AuthFailure(400, "INVALID_INPUT");
    const state = encode(crypto.getRandomValues(new Uint8Array(32))), hash = await stateHash(state), now = Date.now(); fence();
    this.storage.transactionSync(() => {
      this.storage.sql.exec("DELETE FROM flora_github_manifest_state WHERE expires_at<=? OR session_hash=?", now, grant.sessionHash);
      if (this.storage.sql.exec<{ total: number }>("SELECT count(*) AS total FROM flora_github_manifest_state").one().total >= 5) throw new AuthFailure(409, "BUSY");
      this.storage.sql.exec("INSERT INTO flora_github_manifest_state VALUES(?,?,?,?)", hash, grant.sessionHash, grant.epoch, Math.min(now + stateLifetime, grant.expiresAt));
    });
    return { action: "https://github.com/" + (organization ? "organizations/" + organization + "/settings/apps/new" : "settings/apps/new") + "?state=" + state,
      expiresAt: Math.min(now + stateLifetime, grant.expiresAt), manifest: {
        name: "Flora " + (config.workspaceName ?? "Workspace"), url: config.origin,
        description: "Self-hosted Flora GitHub repository and OTA management",
        hook_attributes: { url: config.origin + "/api/github/webhook", active: true },
        redirect_url: config.origin + "/github/app/callback", public: false,
        default_permissions: { contents: "read", metadata: "read" }, default_events: ["push"],
      } };
  }
  async complete(grant: AuthGrant, state: unknown, code: unknown, fence: () => void) {
    if (typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state) || typeof code !== "string" || !/^[A-Za-z0-9_-]{20,200}$/.test(code)) throw new AuthFailure(400, "INVALID_INPUT");
    const hash = await stateHash(state); fence();
    this.storage.transactionSync(() => {
      const row = this.storage.sql.exec<StateRecord>("SELECT session_hash,epoch,expires_at FROM flora_github_manifest_state WHERE state_hash=?", hash).toArray()[0];
      if (!row || row.session_hash !== grant.sessionHash || row.epoch !== grant.epoch || row.expires_at <= Date.now()) throw new AuthFailure(403, "GITHUB_STATE_INVALID");
      if (this.credentials()) throw new AuthFailure(409, "GITHUB_ALREADY_CONFIGURED");
      // Consume before external I/O, so concurrent callbacks cannot exchange twice.
      this.storage.sql.exec("DELETE FROM flora_github_manifest_state WHERE state_hash=?", hash);
    });
    const raw = record(await github("/app-manifests/" + code + "/conversions", undefined, {})); fence();
    const appId = String(positive(raw.id)), appSlug = slug(raw.slug);
    if (typeof raw.pem !== "string" || raw.pem.length > 16_384 || typeof raw.webhook_secret !== "string" || raw.webhook_secret.length < 20 || raw.webhook_secret.length > 256) throw new AuthFailure(502, "GITHUB_UNAVAILABLE");
    try { await importRSAPrivateKey(raw.pem); } catch { throw new AuthFailure(502, "GITHUB_UNAVAILABLE"); }
    fence(); if (this.credentials()) throw new AuthFailure(409, "GITHUB_ALREADY_CONFIGURED");
    this.storage.sql.exec("INSERT INTO flora_managed_github VALUES(1,?,?,?,?,?)", appId, appSlug, raw.pem, raw.webhook_secret, Date.now());
    this.storage.sql.exec("DELETE FROM flora_github_manifest_state");
    return this.status();
  }
  async installations(fence: () => void) {
    const credentials = this.credentials(); if (!credentials) throw new AuthFailure(503, "GITHUB_NOT_CONFIGURED");
    const jwt = await createGitHubAppJWT(credentials, Date.now()); fence();
    const raw = await github("/app/installations?per_page=100", jwt); fence();
    if (!Array.isArray(raw) || raw.length > 100) throw new AuthFailure(502, "GITHUB_UNAVAILABLE");
    return { items: raw.map(value => { const item = record(value), account = record(item.account); return { id: positive(item.id), account: slug(account.login), accountType: account.type === "Organization" || account.type === "User" ? account.type : null, repositorySelection: item.repository_selection === "all" ? "all" : "selected", suspended: item.suspended_at !== null && item.suspended_at !== undefined }; }), truncated: raw.length === 100 };
  }
  async repositories(installationId: number, page: number, fence: () => void) {
    const credentials = this.credentials(); if (!credentials) throw new AuthFailure(503, "GITHUB_NOT_CONFIGURED");
    const jwt = await createGitHubAppJWT(credentials, Date.now()); fence();
    const granted = record(await github(`/app/installations/${installationId}/access_tokens`, jwt, { permissions: { contents: "read" } })); fence();
    if (!isGitHubInstallationToken(granted.token)) throw new AuthFailure(502, "GITHUB_UNAVAILABLE");
    const raw = record(await github(`/installation/repositories?per_page=100&page=${page}`, granted.token)); fence();
    if (!Array.isArray(raw.repositories) || raw.repositories.length > 100) throw new AuthFailure(502, "GITHUB_UNAVAILABLE");
    return { installationId, items: raw.repositories.map(value => { const item = record(value), owner = record(item.owner);
      if (typeof item.name !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(item.name) || typeof item.default_branch !== "string" || item.default_branch.length === 0 || item.default_branch.length > 256 || /[\u0000-\u001f\u007f]/.test(item.default_branch)) throw new AuthFailure(502, "GITHUB_UNAVAILABLE");
      return { id: positive(item.id), owner: slug(owner.login), repository: item.name, private: item.private === true, defaultBranch: item.default_branch };
    }), nextCursor: raw.repositories.length === 100 && page < 1000 ? String(page + 1) : null };
  }
  async repositoryIdentity(connection: GitHubConnection, fence: () => void) {
    const credentials = this.credentials(); if (!credentials) throw new AuthFailure(503, "GITHUB_NOT_CONFIGURED");
    const jwt = await createGitHubAppJWT(credentials, Date.now()); fence();
    const granted = record(await github(`/app/installations/${connection.installationId}/access_tokens`, jwt, { repositories: [connection.repository], permissions: { contents: "read" } })); fence();
    if (!isGitHubInstallationToken(granted.token)) throw new AuthFailure(502, "GITHUB_UNAVAILABLE");
    const raw = record(await github(`/repos/${encodeURIComponent(connection.owner)}/${encodeURIComponent(connection.repository)}`, granted.token)), owner = record(raw.owner); fence();
    if (typeof raw.full_name !== "string" || raw.full_name.toLowerCase() !== (connection.owner + "/" + connection.repository).toLowerCase()) throw new AuthFailure(502, "GITHUB_UNAVAILABLE");
    return { repositoryId: String(positive(raw.id)), repositoryOwnerId: String(positive(owner.id)) };
  }
  async branchHead(connection: GitHubConnection, fence: () => void): Promise<string> {
    const credentials = this.credentials(); if (!credentials) throw new AuthFailure(503, "GITHUB_NOT_CONFIGURED");
    const jwt = await createGitHubAppJWT(credentials, Date.now()); fence();
    const granted = record(await github(`/app/installations/${connection.installationId}/access_tokens`, jwt, { repositories: [connection.repository], permissions: { contents: "read" } })); fence();
    if (!isGitHubInstallationToken(granted.token)) throw new AuthFailure(502, "GITHUB_UNAVAILABLE");
    const raw = record(await github(`/repos/${encodeURIComponent(connection.owner)}/${encodeURIComponent(connection.repository)}/commits/${encodeURIComponent(connection.ref)}`, granted.token)); fence();
    if (typeof raw.sha !== "string" || !/^[a-f0-9]{40}$/.test(raw.sha)) throw new AuthFailure(502, "GITHUB_UNAVAILABLE");
    return raw.sha;
  }
  signingKey(appId: string): ManagedSigningKey | null {
    const row = this.storage.sql.exec<{ app_id: string; key_id: string; private_key: string; certificate: string; created_at: number }>("SELECT * FROM flora_managed_signing WHERE app_id=?", appId).toArray()[0];
    return row ? { appId: row.app_id, keyId: row.key_id, privateKey: row.private_key, certificate: row.certificate, createdAt: row.created_at } : null;
  }
  saveSigningKey(key: ManagedSigningKey, fence: () => void): ManagedSigningKey {
    fence(); this.storage.sql.exec("INSERT INTO flora_managed_signing VALUES(?,?,?,?,?) ON CONFLICT(app_id) DO NOTHING", key.appId, key.keyId, key.privateKey, key.certificate, key.createdAt);
    return this.signingKey(key.appId)!;
  }
}
