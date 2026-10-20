import { DurableObject } from "cloudflare:workers";
import { OrgPolicy } from "./org/policy.js";
import { OrgFailure } from "./org/types.js";
import type { OrgPrincipal, OrgAction } from "./org/types.js";
import { OrgStore } from "./org/store.js";
import { readConfig } from "./config.js";
import type { AuthGrant, FloraConfig, FloraEnv } from "./contracts.js";
import { createPasswordVerifier, verifyPassword } from "./auth/password.js";
import { AuthFailure, AuthState } from "./auth-state.js";
import { listProjectSummaries, ProjectSummaryCache } from "./project-summary.js";
import { OTAVerificationStore } from "./ota-verification.js";
import { UsageCache } from "./usage-cache.js";
import { SDKTelemetryStore } from "./sdk-telemetry.js";
import { AutoRollbackStore, parseAutoRollbackPolicyInput } from "./auto-rollback.js";
import { executeAutoRollback } from "./auto-rollback-executor.js";
import { createD1ImportStore } from "./d1-import-store.js";
import { R2OTAAssets } from "./r2-assets.js";
import { GitHubReleaseOTAAssets, parseGitHubAssetReference } from "./github-assets.js";
import type { ExternalOTAAssets, ExternalAssetUploadContext } from "./external-assets.js";
import { handleHostedApi, hostedFailure } from "./hosted-api.js";
import { HttpFailure, json, parseJson, readBody, routeRequest, secureResponse, telemetryDetailRoute, telemetryJourneyRoute, autoRollbackPolicyRoute, autoRollbackInstallationsRoute } from "./http.js";
import { createGitHubResolver, createGitHubAutomationSourceProvider, createAutomationService, createOperationsService, createRSAManifestSigner, parseAutomationLease, automationDigest, automationPolicyPlatforms, verifyGitHubWebhook, parseGitHubWebhook } from "@app-ops/dogfood";
import type { AutomationLease, GitHubPushEvent, RunnerEnrollment, OperationsState } from "@app-ops/dogfood";
import { ensure, id, object } from "@app-ops/core";
import { canonicalJson } from "@app-ops/config";
import { automationManagementRoute, automationRunnerRoute, dispatchAutomationRunner, runnerToken, runnerUploadLease } from "@app-ops/dashboard/automation-http";
import { dispatchUpdate, managementRoute } from "@app-ops/dashboard/operations-http";
import { ManagedConnections } from "./managed-connections.js";
import { createManagedSigningKey, publicSigningKey } from "./managed-signing.js";
import { ManagedCI, parseCIBindingUpdate, parseRunnerCheckpoint } from "./managed-ci.js";
import type { CISession } from "./managed-ci.js";
import { verifyGitHubCIJWT } from "./github-oidc.js";
import { CredentialVault, CredentialVaultError } from "./credential-vault.js";
import { CredentialValidationError, parseCredentialKind } from "./credential-validation.js";
import { NativeBuildStore } from "./native-build-store.js";
import { NativeBuildError, nativeObject, parseNativeJobInput, parseNativeLease } from "./native-types.js";

const sessionName = "__Host-flora_session", csrfName = "__Host-flora_csrf";
const cookieOptions = "; Secure; HttpOnly; SameSite=Strict; Path=/";
const maxBody = 8192, lifetime = 3_600_000;
const maxAuthBodies = 4;
const presenceWriteInterval = 60_000, presenceOnlineWindow = 120_000, presenceTTL = 7 * 86_400_000, maxPresenceEntries = 100;

function encode(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function decode(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const raw = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "="), character => character.charCodeAt(0));
  return raw.length === 32 && encode(raw) === value ? raw : null;
}
async function digest(bytes: Uint8Array): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, "0")).join("");
}
function cookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header || header.length > 4096) return null;
  const matches = header.split(";").map(value => value.trim()).filter(value => value.startsWith(name + "="));
  return matches.length === 1 ? matches[0]!.slice(name.length + 1) : null;
}
function validPassword(value: unknown, minimum: 12 | 15 = 15): value is string {
  if (typeof value !== "string" || value.length > 256 || new TextEncoder().encode(value).length > 1024) return false;
  let length = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff || ++length > 128) return false;
  }
  return length >= minimum;
}
function origin(request: Request, config: FloraConfig, machine = false): void {
  if (new URL(request.url).origin !== config.origin) throw new AuthFailure(403, "FORBIDDEN");
  if (!["GET", "HEAD"].includes(request.method) && (machine ? request.headers.has("Origin") && request.headers.get("Origin") !== config.origin : request.headers.get("Origin") !== config.origin)) throw new AuthFailure(403, "FORBIDDEN");
}

/** The sole owner authority. Instantiate through idFromName("flora-owner-v1"). */
export class FloraAuth extends DurableObject<FloraEnv> {
  private state: AuthState | undefined;
  private org: OrgStore | undefined;
  private orgPolicy: OrgPolicy | undefined;
  private readonly principals = new WeakMap<AuthGrant, OrgPrincipal>();
  private connections: ManagedConnections | undefined;
  private ci: ManagedCI | undefined;
  private vault: CredentialVault | undefined;
  private native: NativeBuildStore | undefined;
  private otaVerification: OTAVerificationStore | undefined;
  private usageCache: UsageCache | undefined;
  private sdkTelemetry: SDKTelemetryStore | undefined;
  private autoRollback: AutoRollbackStore | undefined;
  private assetBlobs: R2OTAAssets | undefined;
  private githubAssetBlobs: GitHubReleaseOTAAssets | undefined;
  private assetBlobsRequired = false;
  private publicAssetRead = false;
  private policyBodies = 0;
  private telemetryBodies=0;
  private readonly ready: Promise<void>;
  private heavy: "kdf" | "import" | null = null;
  private authBodies = 0;
  private automationBodies = 0;
  private nativeBodies = 0;
  private readonly pushIntents = new Map<string, symbol>();
  private readonly grants = new WeakSet<AuthGrant>();
  private readonly projectSummaryCache = new ProjectSummaryCache();

  constructor(ctx: ConstructorParameters<typeof DurableObject<FloraEnv>>[0], env: FloraEnv) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      try {
        this.state = new AuthState(ctx.storage, readConfig(env));
        try {
          this.org = new OrgStore(ctx.storage, readConfig(env), readConfig(env).orgLimits);
          const owner = this.state.owner(); this.org.bootstrap({epoch: owner.epoch, claimed: owner.verifier !== null}, Date.now());
          this.orgPolicy = new OrgPolicy(this.org);
        } catch { this.org = undefined; this.orgPolicy = undefined; /* Organization availability never replaces legacy Owner authority. */ }
        this.connections = new ManagedConnections(ctx.storage, env); this.ci = new ManagedCI(ctx.storage);
        ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS flora_runner_presence (runner_id TEXT PRIMARY KEY, last_seen_at INTEGER NOT NULL)");
        try { this.otaVerification = new OTAVerificationStore(ctx.storage); }
        catch { this.otaVerification = undefined; }
        try { this.usageCache = new UsageCache(ctx.storage); }
        catch { this.usageCache = undefined; }
        try { this.autoRollback = new AutoRollbackStore(ctx.storage); }
        catch { this.autoRollback = undefined; }
        this.assetBlobsRequired = !!env.FLORA_OTA_ASSETS || env.FLORA_OTA_ASSET_STORAGE === "github-releases" || ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name IN('flora_r2_storage','flora_github_asset_budget')").toArray().length > 0;
        try { if (env.FLORA_OTA_ASSETS) this.assetBlobs = new R2OTAAssets(ctx.storage, env.FLORA_OTA_ASSETS); }
        catch { this.assetBlobs = undefined; }
        try { if (env.FLORA_OTA_ASSET_STORAGE === "github-releases") this.githubAssetBlobs = new GitHubReleaseOTAAssets(ctx.storage, { repository: env.FLORA_OTA_ASSET_REPOSITORY!, installationId: Number(env.FLORA_OTA_ASSET_INSTALLATION_ID), ...(env.FLORA_OTA_ASSET_REPOSITORY_ID ? { repositoryId: Number(env.FLORA_OTA_ASSET_REPOSITORY_ID) } : {}), credentials: () => this.connections?.credentials() }); }
        catch { this.githubAssetBlobs = undefined; }
        try { this.sdkTelemetry = new SDKTelemetryStore(ctx.storage, (observation, now) => { this.autoRollback?.observe(observation, now); }); }
        catch { this.sdkTelemetry = undefined; }
        // Vault failure must not replace the existing GitHub/OTA authority.
        try { this.vault = new CredentialVault(ctx.storage, env.FLORA_VAULT_KEYS, readConfig(env)); }
        catch { this.vault = undefined; }
        try { if (this.vault) this.native = new NativeBuildStore(ctx.storage, this.vault); }
        catch { this.native = undefined; }
        // Resume durable intents after eviction without scanning D1 or app fleets.
        try { await this.scheduleAutoRollback(); } catch { /* Keep owner auth available; durable intents remain retryable. */ }
      }
      catch { this.state = undefined; this.connections = undefined; /* Unavailable until eviction/redeploy; never expose storage errors. */ }
    });
  }

  private async scheduleAutoRollback(): Promise<void> {
    const due = this.autoRollback?.nextPendingAt();
    if (due === undefined || due === null) return;
    const scheduled = await this.ctx.storage.getAlarm();
    const at = Math.max(Date.now() + 100, due);
    if (scheduled === null || scheduled > at) await this.ctx.storage.setAlarm(at);
  }

  private healthyRollbackTarget(ownerId: string, appId: string, deploymentId: string): boolean {
    const report = this.sdkTelemetry?.latest(ownerId, [{ appId, deploymentId }], () => {}).get(JSON.stringify([appId, deploymentId]));
    return !!report && report.appliedInstallations >= 1 && report.restartedInstallations >= 1
      && report.failedInstallations === 0 && report.rolledBackInstallations === 0;
  }

  /** Event-driven durable work only. No pending decision means no D1 access. */
  override async alarm(): Promise<void> {
    await this.ready;
    const automation = this.autoRollback;
    if (!automation) return;
    const pending = automation.pending(Date.now());
    if (!pending.length) { await this.scheduleAutoRollback(); return; }
    const release = this.tryHeavy("import");
    if (!release) { await this.ctx.storage.setAlarm(Date.now() + 5_000); return; }
    try {
      const config = this.config(), epoch = this.state!.owner().epoch;
      const identityFence = () => {
        const current = this.config(), owner = this.state!.owner();
        if (current.ownerId !== config.ownerId || current.origin !== config.origin || current.dbIdentity !== config.dbIdentity
          || owner.epoch !== epoch || owner.verifier === null) throw new HttpFailure(409, "AUTO_ROLLBACK_AUTHORITY_CHANGED");
      };
      for (const decision of pending) {
        if (decision.ownerId !== config.ownerId) { automation.skip(decision.id, "AUTO_ROLLBACK_AUTHORITY_CHANGED", Date.now()); continue; }
        await executeAutoRollback({
          autoRollback: automation, decisionId: decision.id, now: Date.now,
          readReceipt: async claim => {
            identityFence();
            const store = this.importStore(config, identityFence);
            ensure(store.operations, "PROVIDER_UNSUPPORTED");
            const receipt = await store.operations.getOTADeploymentForRequest(claim.appId, claim.requestKey);
            identityFence(); return receipt;
          },
          createOperations: (claim, guard) => {
            const fence = () => {
              identityFence(); guard();
              if (!this.healthyRollbackTarget(claim.ownerId, claim.appId, claim.targetDeploymentId)) throw new HttpFailure(409, "AUTO_ROLLBACK_TARGET_UNHEALTHY");
            };
            const store = this.importStore(config, fence);
            ensure(store.applications && store.operations, "PROVIDER_UNSUPPORTED");
            return { store: store.operations, operations: createOperationsService({ applications: store.applications, operations: store.operations }, undefined, Date.now, { publicOrigin: config.origin }) };
          },
          isHealthy: (ownerId, appId, deploymentId) => { identityFence(); return this.healthyRollbackTarget(ownerId, appId, deploymentId); },
        });
        this.projectSummaryCache.invalidate();
      }
    } finally { release(); await this.scheduleAutoRollback(); }
  }

  private config(): FloraConfig {
    if (!this.state) throw new AuthFailure(503, "AUTH_UNAVAILABLE");
    const config = readConfig(this.env);
    this.state.synchronize(config, Date.now());
    return config;
  }

  private importStore(config: FloraConfig, beforeCommit: () => void, readFence = beforeCommit, upload?: () => ExternalAssetUploadContext | undefined) {
    let external: ExternalOTAAssets | undefined;
    if (this.assetBlobsRequired) {
      const unavailable = async (): Promise<never> => { throw new HttpFailure(503, "ASSET_STORAGE_UNAVAILABLE"); };
      external = this.githubAssetBlobs?.scope(config, readFence, upload) ?? this.assetBlobs?.scope(config, readFence) ?? { put: unavailable, get: unavailable };
    }
    return createD1ImportStore(this.env.FLORA_DB, config, beforeCommit, external);
  }

  tryHeavy(kind: "kdf" | "import"): (() => void) | null {
    if (this.heavy !== null) return null;
    this.heavy = kind;
    let active = true;
    return () => { if (active) { active = false; this.heavy = null; } };
  }

  async requireSession(request: Request): Promise<AuthGrant> {
    await this.ready;
    try {
      const config = this.config();
      origin(request, config);
      const rawSession = decode(cookie(request, sessionName)), rawCsrf = decode(cookie(request, csrfName));
      if (!rawSession || !rawCsrf) throw new AuthFailure(401, "UNAUTHENTICATED");
      const sessionHash = await digest(rawSession), csrfHash = await digest(rawCsrf);
      const session = this.state!.session(sessionHash, Date.now());
      if (session.csrf_hash !== csrfHash) throw new AuthFailure(401, "UNAUTHENTICATED");
      if (!["GET", "HEAD"].includes(request.method) && request.headers.get("X-Flora-CSRF") !== encode(rawCsrf)) throw new AuthFailure(403, "FORBIDDEN");
      const grant = Object.freeze({ ownerId: config.ownerId, sessionHash, epoch: session.epoch, expiresAt: session.expires_at });
      this.grants.add(grant);
      // Preserve legacy Owner sessions even if the additive store is unavailable.
      // Member grants (added separately) never use this fallback.
      if (this.orgPolicy) {
        try {
          const principal = this.orgPolicy.resolveLegacy(grant, Date.now());
          this.principals.set(grant, principal);
        } catch {
          // This session was already verified by the original Owner authority.
          // Do not invent an organization identity or admit a member here.
          this.org = undefined; this.orgPolicy = undefined;
        }
      }
      return grant;
    } catch (error) { throw error instanceof AuthFailure ? error : error instanceof OrgFailure ? new AuthFailure(error.status, error.code) : new AuthFailure(503, "AUTH_UNAVAILABLE"); }
  }

  /** Synchronous fence immediately before each D1 submission, never after it. */
  assertCurrent(grant: AuthGrant): void {
    try {
      this.config();
      if (!this.grants.has(grant)) throw new AuthFailure(401, "UNAUTHENTICATED");
      this.state!.assertCurrent(grant, Date.now());
      const principal = this.principals.get(grant);
      if (principal) {
        if (!this.orgPolicy) throw new OrgFailure(503, "ORG_ACCESS_NOT_ACTIVE");
        this.orgPolicy.require(principal, "org.self", undefined, Date.now());
      }
    } catch (error) { throw error instanceof AuthFailure ? error : error instanceof OrgFailure ? new AuthFailure(error.status, error.code) : new AuthFailure(503, "AUTH_UNAVAILABLE"); }
  }

  requireCapability(grant: AuthGrant, action: OrgAction, appId?: string): () => void {
    const check = () => {
      this.assertCurrent(grant);
      const principal = this.principals.get(grant);
      if (!principal || !this.orgPolicy) throw new AuthFailure(503, "ORG_ACCESS_NOT_ACTIVE");
      try { this.orgPolicy.require(principal, action, appId, Date.now()); }
      catch (error) { if (error instanceof OrgFailure) throw new AuthFailure(error.status, error.code); throw error; }
    };
    check(); return check;
  }

  private async body(request: Request): Promise<Record<string, unknown>> {
    const value = parseJson(await readBody(request, maxBody));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuthFailure(400, "INVALID_REQUEST");
    return value as Record<string, unknown>;
  }

  /** Live reachability only. No credential, client scope, paths or build output is retained. */
  private runnerPresence(runnerId: string, revokedAt: number | null, now: number) {
    const row = this.ctx.storage.sql.exec<{ last_seen_at: number }>("SELECT last_seen_at FROM flora_runner_presence WHERE runner_id=?", id(runnerId)).toArray()[0];
    const lastSeenAt = row && Number.isSafeInteger(row.last_seen_at) && row.last_seen_at > 0 && row.last_seen_at <= now && now - row.last_seen_at <= presenceTTL ? row.last_seen_at : null;
    return { lastSeenAt, status: lastSeenAt === null ? "never_seen" : revokedAt === null && now - lastSeenAt <= presenceOnlineWindow ? "online" : "offline" };
  }

  private recordRunnerPresence(runnerId: string, now: number, fence: () => void): { runnerId: string; lastSeenAt: number } {
    id(runnerId);
    return this.ctx.storage.transactionSync(() => {
      fence();
      const prior = this.ctx.storage.sql.exec<{ last_seen_at: number }>("SELECT last_seen_at FROM flora_runner_presence WHERE runner_id=?", runnerId).toArray()[0];
      if (prior && Number.isSafeInteger(prior.last_seen_at) && prior.last_seen_at > 0 && prior.last_seen_at <= now && now - prior.last_seen_at < presenceWriteInterval) return { runnerId, lastSeenAt: prior.last_seen_at };
      this.ctx.storage.sql.exec("DELETE FROM flora_runner_presence WHERE last_seen_at<? OR last_seen_at>?", now - presenceTTL, now);
      const count = this.ctx.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM flora_runner_presence").one().count;
      const retained = prior && prior.last_seen_at >= now - presenceTTL && prior.last_seen_at <= now;
      if (!retained && count >= maxPresenceEntries) throw new AuthFailure(409, "PRESENCE_CAPACITY");
      this.ctx.storage.sql.exec("INSERT INTO flora_runner_presence VALUES(?,?) ON CONFLICT(runner_id) DO UPDATE SET last_seen_at=excluded.last_seen_at", runnerId, now);
      return { runnerId, lastSeenAt: now };
    });
  }

  private async newSession() {
    const session = crypto.getRandomValues(new Uint8Array(32)), csrf = crypto.getRandomValues(new Uint8Array(32));
    return { sessionToken: encode(session), csrfToken: encode(csrf), sessionHash: await digest(session), csrfHash: await digest(csrf), expiresAt: Date.now() + lifetime };
  }

  private async authenticate(request: Request, kind: "login" | "enroll" | "recover"): Promise<Response> {
    // Reject unread rather than queue passwords behind expensive work. Slow
    // public bodies use their own bounded pool, never the KDF/import lock.
    if (this.heavy !== null || this.authBodies >= maxAuthBodies) throw new AuthFailure(409, "BUSY", 1);
    this.authBodies++;
    const admissionState: { release: (() => void) | null } = { release: null };
    try {
      const input = await this.body(request), config = this.config();
      const keys = kind === "login" ? ["email", "password"] : ["email", "password", "token", "confirmation"];
      if (Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) throw new AuthFailure(400, "INVALID_REQUEST");
      if (kind !== "login" && input.confirmation !== input.password) throw new AuthFailure(400, "INVALID_REQUEST");
      let tokenDigest: string | undefined, setup: FloraConfig["setup"] = null;
      if (kind !== "login") {
        const token = decode(input.token);
        if (!token || input.email !== config.ownerEmail) throw new AuthFailure(403, "SETUP_UNAVAILABLE");
        tokenDigest = await digest(token);
        setup = this.state!.requireSetup(config, kind, tokenDigest, Date.now());
      }
      if (!validPassword(input.password, config.passwordMinimum)) throw new AuthFailure(kind === "login" ? 401 : 400, kind === "login" ? "UNAUTHENTICATED" : "INVALID_PASSWORD");
      const owner = this.state!.owner();
      const runnable = kind !== "login" || input.email === config.ownerEmail && owner.verifier !== null;
      if (!runnable) throw new AuthFailure(401, "UNAUTHENTICATED");
      // Another request may have acquired expensive work while this body or
      // setup digest was pending. Transfer immediately or reject; never await it.
      admissionState.release = this.tryHeavy("kdf");
      if (!admissionState.release) throw new AuthFailure(409, "BUSY", 1);
      this.state!.reserve(Date.now(), true);
      await this.ctx.storage.sync();
      if (kind === "login" && !await verifyPassword(input.password, owner.verifier!, config.passwordMinimum)) throw new AuthFailure(401, "UNAUTHENTICATED");
      const verifier = kind === "login" ? null : await createPasswordVerifier(input.password, config.passwordMinimum);
      const session = await this.newSession();
      const currentConfig = this.config(), now = Date.now();
      if ((currentConfig.passwordMinimum ?? 15) !== (config.passwordMinimum ?? 15)) throw new AuthFailure(503, "AUTH_UNAVAILABLE");
      if (kind === "login") this.state!.login(owner.epoch, session, now);
      else this.state!.claim(currentConfig, setup!, tokenDigest!, verifier!, session, now);
      const headers = new Headers();
      headers.append("Set-Cookie", sessionName + "=" + session.sessionToken + cookieOptions + "; Max-Age=3600");
      headers.append("Set-Cookie", csrfName + "=" + session.csrfToken + cookieOptions + "; Max-Age=3600");
      return json({ csrfToken: session.csrfToken, expiresAt: session.expiresAt }, 200, headers);
    } finally {
      admissionState.release?.();
      // Retain admission across parsing, setup validation, and lock transfer so
      // parsed password continuations are bounded too. Every error releases it.
      this.authBodies--;
    }
  }

  private async automationRequest(request: Request, kind: "runner" | "hook" | "ci-token"): Promise<Response> {
    if (this.automationBodies >= 4) throw new AuthFailure(409, "BUSY", 1);
    this.automationBodies++;
    const admissionState: { release: (() => void) | null } = { release: null };
    try {
      const asset = kind === "runner" && automationRunnerRoute(new URL(request.url).pathname)?.binary;
      const admission = () => {
        if (!asset) return;
        admissionState.release = this.tryHeavy("import");
        if (!admissionState.release) throw new AuthFailure(409, "BUSY", 1);
      };
      return await this.runAutomationRequest(request, kind, admission);
    } finally { admissionState.release?.(); this.automationBodies--; }
  }

  private async runAutomationRequest(request: Request, kind: "runner" | "hook" | "ci-token", admitBody: () => void): Promise<Response> {
    const config = this.config(), owner = this.state!.owner();
    if (owner.verifier === null) throw new AuthFailure(503, "AUTH_UNAVAILABLE");
    let deadline: number | null = null;
    let pushKey: string | null = null, pushIntent: symbol | null = null;
    let expectedPush: GitHubPushEvent | null = null;
    let ciSession: CISession | null = null;
    let assetUpload: ExternalAssetUploadContext | undefined;
    const fence = () => {
      const current = this.config();
      if (current.ownerId !== config.ownerId || current.origin !== config.origin || current.dbIdentity !== config.dbIdentity || this.state!.owner().epoch !== owner.epoch) throw new AuthFailure(403, "FORBIDDEN");
      ensure(deadline === null || Date.now() < deadline, "LEASE_STALE");
      ensure(pushKey === null || this.pushIntents.get(pushKey) === pushIntent, "CONFIG_CONFLICT");
      if (ciSession) this.ci!.assertSession(ciSession, owner.epoch, Date.now());
    };
    const store = this.importStore(config, fence, fence, () => assetUpload);
    ensure(store.applications && store.operations && store.automation, "PROVIDER_UNSUPPORTED");
    const credentials = this.connections!.credentials();
    const github = credentials ? createGitHubResolver({ credentials, onCurrentRefValidated: (connection, sha) => {
      ensure(expectedPush && pushKey !== null && pushIntent !== null && sha === expectedPush.commitSha
        && connection.installationId === expectedPush.installationId && connection.owner.toLowerCase() === expectedPush.owner.toLowerCase()
        && connection.repository.toLowerCase() === expectedPush.repository.toLowerCase() && connection.ref === expectedPush.ref, "CONFIG_CONFLICT");
      this.pushIntents.set(pushKey, pushIntent);
    } }) : undefined;
    const operations = createOperationsService({ applications: store.applications, operations: store.operations }, github, Date.now, { publicOrigin: config.origin });
    const service = createAutomationService({ applications: store.applications, operations: store.operations, automation: store.automation }, {
      now: Date.now, publicOrigin: config.origin, maxWebhookTargets: 1, ...(credentials ? { source: createGitHubAutomationSourceProvider({ credentials }) } : {}),
      detectCommit: (appId, sha) => operations.detectCommit(appId, sha),
      detectPushCommit: (appId, sha) => operations.detectCommit(appId, sha, { requireCurrentRef: true }),
    });
    if (kind === "runner" && new URL(request.url).pathname === "/api/runner/usage") {
      const reporter = this.env.FLORA_USAGE_REPORTER_ID, account = this.env.FLORA_CLOUDFLARE_ACCOUNT_ID;
      if (!reporter || !account || !/^[a-f0-9]{32}$/.test(account) || !this.usageCache) throw new AuthFailure(503,"USAGE_REPORT_UNAVAILABLE");
      const token=runnerToken(request.headers);
      if(token.split(".")[0]!==reporter)throw new AuthFailure(403,"FORBIDDEN");
      await service.authorizeRunner(token); fence();
      admitBody(); const input=await this.body(request);
      // Fresh credential authority, not a cached presence or a CI session.
      await service.authorizeRunner(token); fence();
      this.usageCache.record(account,input,Date.now());
      return json({recorded:true});
    }
    if (kind === "runner" && new URL(request.url).pathname === "/api/runner/presence") {
      // Authenticate before consuming the body. CI session tokens and arbitrary
      // app or Runner selectors never gain presence authority.
      const token = runnerToken(request.headers); await service.authorizeRunner(token);
      admitBody(); object(await this.body(request), []);
      const runnerId = token.split(".")[0]!, credential = await store.automation.getRunnerCredential(runnerId);
      ensure(credential && credential.id === runnerId && credential.revokedAt === null, "PERMISSION_DENIED");
      // Recheck the credential after the asynchronous body and credential read.
      await service.authorizeRunner(token); fence();
      return json(this.recordRunnerPresence(runnerId, Date.now(), fence));
    }
    if (kind === "ci-token") {
      const header = request.headers.get("Authorization");
      if (!header || header.length > 16_400 || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(header)) throw new AuthFailure(403, "CI_IDENTITY_REJECTED");
      const input = object(await this.body(request), ["appId"]), appId = id(input.appId), binding = this.ci!.binding(appId);
      if (!binding?.enabled) throw new AuthFailure(403, "CI_BINDING_REJECTED");
      this.ci!.assertBinding(binding, await store.operations.getGitHubConnection(appId));
      const identity = await verifyGitHubCIJWT(header.slice(7), binding, config.origin, Date.now()); fence();
      const connection = await store.operations.getGitHubConnection(appId); this.ci!.assertBinding(binding, connection); ensure(connection, "CONFIG_CONFLICT");
      // Sequence the verified identity before the asynchronous HEAD read. A late
      // old response cannot replace a newer admission, even across DO eviction.
      const sequence = this.ci!.reserveAdmission();
      const sha = await this.connections!.branchHead(connection, fence); if (sha !== identity.commitSha) throw new AuthFailure(403, "CI_COMMIT_SUPERSEDED");
      const token = this.ci!.credential(appId); ensure(token, "PERMISSION_DENIED"); await service.authorizeRunner(token);
      const runner = (await store.automation.listRunners(appId)).find(item => item.id === binding.runnerId); ensure(runner && runner.appIds.length === 1 && runner.appIds[0] === appId, "PERMISSION_DENIED");
      const platforms = [...automationPolicyPlatforms(await store.automation.getAutomationPolicy(appId))];
      return json(await this.ci!.issue(binding, identity, header.slice(7), runner, owner.epoch, Date.now(), sequence, fence, platforms), 201);
    }
    if (kind === "hook") {
      const webhookSecret = this.connections!.webhookSecret();
      ensure(webhookSecret, "PROVIDER_UNCONFIGURED");
      ensure(/^sha256=[a-f0-9]{64}$/.test(request.headers.get("X-Hub-Signature-256") ?? ""), "PERMISSION_DENIED");
      const bytes = await readBody(request, 131072);
      await verifyGitHubWebhook(bytes, request.headers.get("X-Hub-Signature-256"), webhookSecret);
      fence();
      const event = parseGitHubWebhook(bytes, request.headers);
      if (event) {
        pushKey = JSON.stringify([event.installationId, event.owner.toLowerCase(), event.repository.toLowerCase(), event.ref]);
        pushIntent = Symbol(); expectedPush = event;
      }
      try {
        const result = event ? await service.handleGitHubPush(event) : { jobs: [], ignored: 1 };
        const submittedKey = pushKey; pushKey = null;
        try { fence(); } finally { pushKey = submittedKey; }
        return json(result, 202);
      } finally { if (pushKey !== null && this.pushIntents.get(pushKey) === pushIntent) this.pushIntents.delete(pushKey); }
    }
    const route = automationRunnerRoute(new URL(request.url).pathname)!;
    const presentedToken = runnerToken(request.headers);
    ciSession = await this.ci!.session(presentedToken);
    let token = presentedToken;
    if (ciSession) {
      const binding = this.ci!.assertSession(ciSession, owner.epoch, Date.now());
      this.ci!.assertBinding(binding, await store.operations.getGitHubConnection(ciSession.appId));
      const privateToken = this.ci!.credential(ciSession.appId); ensure(privateToken, "PERMISSION_DENIED"); token = privateToken;
    }
    const headers = new Headers(request.headers); headers.set("Authorization", "Bearer " + token);
    const githubAssetMode = !!this.githubAssetBlobs;
    async function admit(lease: AutomationLease, allowCancel = false): Promise<void> {
      if (ciSession) ensure(lease.appId === ciSession.appId && lease.runnerId === ciSession.runnerId, "PERMISSION_DENIED");
      if (!allowCancel) await service.authorizeRunner(token, lease);
      const job = await store.automation!.getAutomationJob(lease.appId, lease.jobId);
      ensure(job?.lease && (job.state === "leased" || allowCancel && job.state === "cancel_requested")
        && job.lease.attemptId === lease.attemptId && job.lease.fence === lease.fence
        && job.lease.runnerId === lease.runnerId && job.lease.credentialEpoch === lease.credentialEpoch, "LEASE_STALE");
      if (ciSession) ensure(job.commitSha === ciSession.commitSha && (!ciSession.platforms || ciSession.platforms.includes(job.platform)), "PERMISSION_DENIED");
      deadline = job.lease.expiresAt;
      if (route.binary) {
        const reference = request.headers.get("X-Flora-Asset-Reference");
        if (reference !== null && githubAssetMode) parseGitHubAssetReference(reference);
        assetUpload = { job, lease, reference };
      }
    }
    await service.authorizeRunner(token);
    if (route.binary) await admit(runnerUploadLease(request.headers));
    fence();
    admitBody();
    const bytes = await readBody(request, route.limit, route.binary);
    const data = route.binary ? bytes : parseJson(bytes);
    if (route.action.startsWith("checkpoint-")) {
      if (!ciSession) throw new AuthFailure(403, "CI_SESSION_REQUIRED");
      if (route.action === "checkpoint-list") { object(data, []); fence(); return json({ checkpoints: this.ci!.checkpoints(ciSession) }); }
      if (route.action === "checkpoint-clear") {
        const keys = ["jobId", "attemptId", ...(data && typeof data === "object" && Object.hasOwn(data, "expectedDisposition") ? ["expectedDisposition"] : [])];
        const raw = object(data, keys), jobId = id(raw.jobId), attemptId = id(raw.attemptId), checkpoint = this.ci!.checkpoint(ciSession, jobId, attemptId);
        ensure(raw.expectedDisposition === undefined || raw.expectedDisposition === "stale");
        if (!checkpoint) { ensure(raw.expectedDisposition === undefined, "LEASE_STALE"); fence(); return json({ cleared: true, disposition: "absent", appId: ciSession.appId, jobId, attemptId, receiptDigest: null }); }
        let job = await store.automation.getAutomationJob(ciSession.appId, jobId); ensure(job, "LEASE_STALE");
        // Retire only this checkpoint's expired attempt; never expire a newer
        // attempt or erase an active uncertain publication on a client guess.
        if (job.lease?.attemptId === attemptId && job.lease.expiresAt <= Date.now()) job = await store.automation.expireAutomationJob(ciSession.appId, jobId, Date.now());
        const attempt = (await store.automation.listAutomationAttempts(ciSession.appId, jobId)).find(item => item.id === attemptId);
        ensure(attempt && attempt.runnerId === ciSession.runnerId && attempt.credentialEpoch === checkpoint.lease.credentialEpoch && attempt.fence === checkpoint.lease.fence && attempt.endedAt !== null, "LEASE_STALE");
        const committed = attempt.outcome === "succeeded";
        ensure(committed ? job.state === "succeeded" && canonicalJson(job.receipt) === canonicalJson(checkpoint.receipt) : ["failed", "expired", "cancelled"].includes(attempt.outcome ?? ""), "LEASE_STALE");
        ensure(raw.expectedDisposition === undefined || !committed, "LEASE_STALE");
        const receiptDigest = await automationDigest(checkpoint.receipt);
        this.ci!.clearCheckpoint(ciSession, jobId, attemptId, fence);
        return json({ cleared: true, disposition: committed ? "committed" : "stale", appId: ciSession.appId, jobId, attemptId, receiptDigest });
      }
      const checkpoint = parseRunnerCheckpoint(data); ensure(checkpoint.origin === config.origin, "INVALID_RELATION");
      await admit(checkpoint.lease); ensure(checkpoint.receipt.commitSha === ciSession.commitSha, "PERMISSION_DENIED");
      const job = await store.automation.getAutomationJob(checkpoint.lease.appId, checkpoint.lease.jobId);
      ensure(job && checkpoint.receipt.configDigest === job.configDigest && checkpoint.receipt.toolchainDigest === job.toolchainDigest, "INVALID_RELATION");
      this.ci!.saveCheckpoint(ciSession, checkpoint, fence); return json({ saved: true });
    }
    if (!route.binary && route.action !== "claim") {
      const names = route.action === "finalize" ? ["lease", "receipt"] : route.action === "fail" ? ["lease", "code"] : ["lease"];
      const raw = object(data, names), lease = parseAutomationLease(raw.lease);
      // Completed finalization retries are read-only and use the service's
      // original attempt/Runner checks; all live writes retain this deadline.
      const prior = route.action === "finalize" ? await store.automation.getAutomationJob(lease.appId, lease.jobId) : null;
      if (ciSession) {
        ensure(lease.appId === ciSession.appId && lease.runnerId === ciSession.runnerId, "PERMISSION_DENIED");
        if (prior?.state === "succeeded" && prior.commitSha !== ciSession.commitSha) {
          const checkpoint = this.ci!.checkpoint(ciSession, lease.jobId, lease.attemptId);
          ensure(checkpoint && canonicalJson(checkpoint.lease) === canonicalJson(lease) && canonicalJson(checkpoint.receipt) === canonicalJson(raw.receipt), "PERMISSION_DENIED");
        } else if (prior && prior.commitSha !== ciSession.commitSha) {
          const checkpoint = this.ci!.checkpoint(ciSession, lease.jobId, lease.attemptId);
          ensure(checkpoint && canonicalJson(checkpoint.lease) === canonicalJson(lease) && canonicalJson(checkpoint.receipt) === canonicalJson(raw.receipt), "PERMISSION_DENIED");
          // A valid new run can retire a fenced previous attempt through the
          // authoritative clear endpoint, but can never publish its old SHA.
          ensure(false, "LEASE_STALE");
        }
        if (route.action === "finalize" && prior?.state !== "succeeded") {
          const checkpoint = this.ci!.checkpoint(ciSession, lease.jobId, lease.attemptId);
          ensure(checkpoint && canonicalJson(checkpoint.lease) === canonicalJson(lease) && canonicalJson(checkpoint.receipt) === canonicalJson(raw.receipt), "PERMISSION_DENIED");
        }
      }
      if (prior?.state !== "succeeded") await admit(lease, route.action === "fail" && raw.code === "CANCELLED");
    }
    fence();
    const claimScope = ciSession ? { appId: ciSession.appId, commitSha: ciSession.commitSha, ...(ciSession.platforms ? { platforms: ciSession.platforms } : {}) } : undefined;
    if (route.action==="finalize") this.projectSummaryCache.invalidate();
    let result: unknown;
    try { result = await dispatchAutomationRunner(route, new URL(request.url), headers, data, service, claimScope); }
    finally { if (route.action==="finalize") this.projectSummaryCache.invalidate(); }
    // A successful heartbeat extends the deadline. Its submission was fenced
    // against the previous one; don't reject the committed response afterward.
    deadline = null; fence();
    return result === null ? secureResponse(new Response(null, { status: 204 })) : json(result, ["claim", "assets"].includes(route.action) ? 201 : 200);
  }

  override async fetch(request: Request): Promise<Response> {
    await this.ready;
    try {
      const route = routeRequest(request, true), path = new URL(request.url).pathname;
      origin(request, this.config(), route.kind === "runner" || route.kind === "hook" || route.kind === "ci-token" || route.kind === "native-runner" || route.kind === "sdk-telemetry");
      if (route.kind === "github-callback") {
        const url = new URL(request.url), state = url.searchParams.get("state"), code = url.searchParams.get("code");
        if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || !code || !/^[A-Za-z0-9_-]{20,200}$/.test(code)) throw new AuthFailure(400, "INVALID_INPUT");
        // Strict session cookies are intentionally absent on the GitHub redirect.
        // A same-origin, session + CSRF authenticated POST performs the exchange.
        // A server redirect chain can keep Strict cookies absent. Establish a
        // first-party document and require the owner to follow its own-origin
        // link, so the existing session policy does not need to be weakened.
        const target = "/#github-app-code=" + code + "&amp;github-app-state=" + state;
        return secureResponse(new Response(`<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>Flora · GitHub 연결 완료하기</title><link rel="stylesheet" href="/auth.css"></head>
<body class="github-callback-page">
<a class="skip" href="#auth-title">본문으로 이동</a>
<header class="auth-brand"><a class="brand" href="/" aria-label="Flora"><img src="/brand.png" width="28" height="28" alt=""><span>flora</span></a><span class="private-label">비공개 앱 작업실</span></header>
<main class="auth-shell">
<section class="auth-card github-callback-card" aria-labelledby="auth-title">
<div class="github-callback-mark" aria-hidden="true"><svg class="callback-icon"><use href="/icons.svg#icon-source"></use></svg></div>
<p class="eyebrow">GITHUB CONNECTION</p>
<h1 id="auth-title">GitHub 연결을 거의 마쳤어요</h1>
<p class="description">GitHub 앱이 등록되었습니다. Flora로 돌아가 연결을 완료한 뒤 관리할 저장소를 선택하세요.</p>
<ol class="github-callback-progress" aria-label="GitHub 연결 진행 상황"><li><svg class="callback-icon" aria-hidden="true"><use href="/icons.svg#icon-check"></use></svg><span>GitHub 등록 완료</span></li><li><span class="callback-step" aria-hidden="true">2</span><span>Flora 연결 대기</span></li></ol>
<a class="github-callback-cta" href="${target}">Flora에서 연결 완료<svg class="callback-icon" aria-hidden="true"><use href="/icons.svg#icon-arrow-right"></use></svg></a>
<p class="github-callback-note">연결 정보는 Flora에서 안전하게 보관합니다.</p>
</section>
<p class="auth-footer">Flora · 앱과 업데이트를 한곳에서</p>
</main>
</body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
      }
      if (route.kind === "sdk-telemetry") {
        if(!this.sdkTelemetry)throw new HttpFailure(503,"SDK_TELEMETRY_UNAVAILABLE");
        if(request.headers.has("Origin")&&request.headers.get("Origin")!==this.env.FLORA_ORIGIN)throw new HttpFailure(403,"FORBIDDEN");
        if(this.telemetryBodies>=4)throw new HttpFailure(429,"SDK_TELEMETRY_BUSY");
        this.telemetryBodies++;
        try {
          const config=this.config(),ownerEpoch=this.state!.owner()?.epoch;
          const fence=()=>{const current=this.config();if(current.ownerId!==config.ownerId||current.origin!==config.origin||current.dbIdentity!==config.dbIdentity||this.state!.owner()?.epoch!==ownerEpoch)throw new HttpFailure(403,"FORBIDDEN");};
          const input=parseJson(await readBody(request,route.limit));fence();
          const appId=route.path.split("/")[2]!, ip=request.headers.get("CF-Connecting-IP")??"unknown";
          const result=route.path.endsWith("/session")?await this.sdkTelemetry.session(this.env.FLORA_DB,config,appId,input,fence,Date.now(),ip):await this.sdkTelemetry.report(config,appId,input,fence,Date.now(),ip);
          // The SDK cannot receive its ACK until a queued intent has a durable
          // wake-up. A duplicate retry also repairs interrupted scheduling.
          if (!route.path.endsWith("/session")) await this.scheduleAutoRollback();
          fence();return json(result);
        } finally {this.telemetryBodies--;}
      }
      if (route.kind === "updates") {
        const assetRead = route.path.includes("/assets/");
        if (assetRead && this.publicAssetRead) {
          const response = json({ error: "BUSY" }, 429); response.headers.set("Retry-After", "1"); return response;
        }
        if (assetRead) this.publicAssetRead = true;
        try {
          const config = this.config(), appId = route.path.split("/")[2]!;
          const epoch = this.state!.owner().epoch;
          const readFence = () => {
            const current = this.config();
            if (current.ownerId !== config.ownerId || current.origin !== config.origin || current.dbIdentity !== config.dbIdentity || this.state!.owner().epoch !== epoch)
              throw new AuthFailure(403, "FORBIDDEN");
          };
          const store = this.importStore(config, () => { throw new AuthFailure(403, "FORBIDDEN"); }, readFence);
          ensure(store.applications && store.operations, "PROVIDER_UNSUPPORTED");
          const managed = this.connections!.signingKey(appId);
          const credentials = managed ?? (this.env.FLORA_OTA_SIGNING_PRIVATE_KEY && this.env.FLORA_OTA_SIGNING_KEY_ID
            ? { privateKey: this.env.FLORA_OTA_SIGNING_PRIVATE_KEY, keyId: this.env.FLORA_OTA_SIGNING_KEY_ID } : undefined);
          const signer = credentials ? createRSAManifestSigner(credentials) : undefined;
          const operations = createOperationsService({ applications: store.applications, operations: store.operations }, undefined, Date.now, { publicOrigin: config.origin, ...(signer ? { signer } : {}) });
          const response = secureResponse(await dispatchUpdate(request, operations, config.origin));
          if (response.status === 200 && route.path.includes("/assets/")) response.headers.set("Cache-Control", "public, max-age=31536000, immutable");
          return response;
        } catch (error) { return hostedFailure(error); }
        finally { if (assetRead) this.publicAssetRead = false; }
      }
      if (route.kind === "native-management") {
        const grant = await this.requireSession(request), fence = () => this.assertCurrent(grant);
        const expensive = request.method === "POST" && !path.endsWith("/cancel") && !path.endsWith("/revoke"), release = expensive ? this.tryHeavy("import") : null;
        if (expensive && !release) throw new AuthFailure(409, "BUSY", 1);
        try {
          const appId = path.split("/")[3]!, store = this.importStore(this.config(), fence);
          const app = await store.applications?.getApplication(appId); ensure(app && store.operations, "NOT_FOUND"); fence();
          if (!this.native) throw new AuthFailure(503, "VAULT_UNAVAILABLE");
          if (request.method === "GET") return json(this.native.list(appId, fence));
          const input = parseJson(await readBody(request, route.limit)); fence();
          if (path.endsWith("/runners")) return json(await this.native.enroll(appId, input, grant.epoch, fence), 201);
          if (path.endsWith("/jobs")) {
            const selected = parseNativeJobInput(input), connection = await store.operations.getGitHubConnection(appId); fence(); ensure(connection, "PROVIDER_UNCONFIGURED");
            const head = await this.connections!.branchHead(connection, fence); ensure(head === selected.commitSha, "CONFIG_CONFLICT");
            const current = await store.operations.getGitHubConnection(appId); fence(); ensure(current && canonicalJson(current) === canonicalJson(connection), "CONFIG_CONFLICT");
            const source = { owner: connection.owner, repository: connection.repository, ref: connection.ref, rootDirectory: app.rootDirectory,
              installationId: connection.installationId, connectionVersion: connection.version };
            return json(await this.native.enqueue(appId, selected, source, fence), 201);
          }
          nativeObject(input, []);
          const target = path.split("/")[6]!;
          if (path.endsWith("/cancel")) return json(this.native.cancel(appId, target, fence));
          if (path.endsWith("/revoke")) return json(this.native.revoke(appId, target, fence));
          throw new HttpFailure(404, "NOT_FOUND");
        } catch (error) {
          if (error instanceof AuthFailure || error instanceof HttpFailure) throw error;
          if (error instanceof NativeBuildError || error instanceof CredentialVaultError) return json({ error: error.code }, error.status);
          return hostedFailure(error);
        } finally { release?.(); }
      }
      if (route.kind === "native-runner") {
        if (this.nativeBodies >= 4) throw new AuthFailure(409, "BUSY", 1);
        this.nativeBodies++;
        const config = this.config(), ownerEpoch = this.state!.owner().epoch;
        const fence = () => { const current = this.config(); if (current.ownerId !== config.ownerId || current.origin !== config.origin || current.dbIdentity !== config.dbIdentity || this.state!.owner().epoch !== ownerEpoch) throw new AuthFailure(403, "FORBIDDEN"); };
        let release: (() => void) | null = null;
        try {
          if (!this.native) throw new AuthFailure(503, "VAULT_UNAVAILABLE");
          const authority = await this.native.authorize(runnerToken(request.headers), ownerEpoch, fence);
          if (path.endsWith("/credentials")) { release = this.tryHeavy("import"); if (!release) throw new AuthFailure(409, "BUSY", 1); }
          const input = parseJson(await readBody(request, route.limit)); fence();
          if (path.endsWith("/claim")) return json(this.native.claim(authority, input, fence), 201);
          if (path.endsWith("/pending")) { nativeObject(input, []); return json(this.native.pending(authority, fence)); }
          if (path.endsWith("/presence")) { nativeObject(input, []); return json(this.native.presence(authority, fence)); }
          const action = path.split("/")[3]!, raw = nativeObject(input, action === "complete" ? ["lease", "artifact"] : action === "fail" ? ["lease", "code"] : ["lease"]), lease = parseNativeLease(raw.lease);
          if (action === "heartbeat") return json(this.native.heartbeat(authority, lease, fence));
          if (action === "credentials") return json(await this.native.credentials(authority, lease, fence));
          if (action === "complete") return json(this.native.complete(authority, lease, raw.artifact, fence));
          if (action === "fail") return json(this.native.fail(authority, lease, raw.code, fence));
          throw new HttpFailure(404, "NOT_FOUND");
        } catch (error) {
          if (error instanceof AuthFailure || error instanceof HttpFailure) throw error;
          if (error instanceof NativeBuildError || error instanceof CredentialVaultError) return json({ error: error.code }, error.status);
          return hostedFailure(error);
        } finally { release?.(); this.nativeBodies--; }
      }
      if (route.kind === "credentials") {
        const grant = await this.requireSession(request), fence = () => this.assertCurrent(grant);
        const release = request.method === "POST" ? this.tryHeavy("import") : null;
        if (request.method === "POST" && !release) throw new AuthFailure(409, "BUSY", 1);
        try {
          const appId = route.path.split("/")[3]!;
          const store = this.importStore(this.config(), fence);
          ensure(store.applications && await store.applications.getApplication(appId), "NOT_FOUND"); fence();
          if (!this.vault) throw new AuthFailure(503, "VAULT_UNAVAILABLE");
          if (request.method === "GET") return json(await this.vault.list(appId, fence));
          const input = parseJson(await readBody(request, route.limit)); fence();
          if (route.path.endsWith("/disable")) {
            const value = object(input, ["kind", "expectedVersion"]);
            if (!Number.isSafeInteger(value.expectedVersion) || (value.expectedVersion as number) < 0) throw new AuthFailure(400, "INVALID_CREDENTIAL_INPUT");
            return json(await this.vault.disable(appId, parseCredentialKind(value.kind), value.expectedVersion as number, grant.ownerId, fence));
          }
          return json(await this.vault.import(appId, input, grant.ownerId, fence), 201);
        } catch (error) {
          if (error instanceof AuthFailure || error instanceof HttpFailure) throw error;
          if (error instanceof CredentialVaultError) return json({ error: error.code }, error.status);
          if (error instanceof CredentialValidationError) return json({ error: error.code }, 400);
          return hostedFailure(error);
        } finally { release?.(); }
      }
      if (route.kind === "connection") {
        const grant = await this.requireSession(request), fence = () => this.assertCurrent(grant);
        const release = request.method === "POST" ? this.tryHeavy("import") : null;
        if (request.method === "POST" && !release) throw new AuthFailure(409, "BUSY", 1);
        try {
          fence();
          if (path === "/api/github/connection") return json(this.connections!.status());
          if (path === "/api/github/installations") return json(await this.connections!.installations(fence));
          if (path === "/api/github/repositories") {
            const query = new URL(request.url).searchParams, id = query.get("installationId"), page = query.get("cursor") ?? "1";
            if (!id || !/^[1-9][0-9]{0,15}$/.test(id) || !Number.isSafeInteger(Number(id)) || !/^[1-9][0-9]{0,3}$/.test(page) || Number(page) > 1000) throw new AuthFailure(400, "INVALID_INPUT");
            return json(await this.connections!.repositories(Number(id), Number(page), fence));
          }
          const input = await this.body(request); fence();
          if (path === "/api/github/manifest/start") {
            if (Object.keys(input).some(key => key !== "organization") || input.organization !== undefined && typeof input.organization !== "string") throw new AuthFailure(400, "INVALID_INPUT");
            return json(await this.connections!.start(this.config(), grant, input.organization as string | undefined, fence));
          }
          if (path === "/api/github/manifest/complete") {
            if (Object.keys(input).length !== 2 || !Object.hasOwn(input, "state") || !Object.hasOwn(input, "code")) throw new AuthFailure(400, "INVALID_INPUT");
            return json(await this.connections!.complete(grant, input.state, input.code, fence));
          }
          const appId = /^\/api\/apps\/([a-z][a-z0-9_-]{2,95})\/signing-key$/.exec(path)![1]!;
          if (Object.keys(input).length !== 0) throw new AuthFailure(400, "INVALID_INPUT");
          const store = this.importStore(this.config(), fence);
          ensure(store.applications && await store.applications.getApplication(appId), "NOT_FOUND"); fence();
          const prior = this.connections!.signingKey(appId);
          const key = prior ?? this.connections!.saveSigningKey(await createManagedSigningKey(appId, Date.now()), fence);
          fence(); return json(publicSigningKey(key), prior ? 200 : 201);
        } catch (error) { if (error instanceof AuthFailure) throw error; return hostedFailure(error); }
        finally { release?.(); }
      }
      if (route.kind === "ci-binding") {
        const grant = await this.requireSession(request), fence = () => this.assertCurrent(grant), appId = path.split("/")[3]!;
        const release = request.method === "POST" ? this.tryHeavy("import") : null;
        if (request.method === "POST" && !release) throw new AuthFailure(409, "BUSY", 1);
        if (request.method==="POST") this.projectSummaryCache.invalidate();
        try {
          const update = request.method === "POST" ? parseCIBindingUpdate(await this.body(request)) : null;
          // Revocation remains available without GitHub or D1 availability.
          if (update && !update.enabled) return json({ binding: this.ci!.disable(appId, update, Date.now(), fence) });
          const config = this.config(), store = this.importStore(config, fence);
          ensure(store.applications && store.operations && store.automation && await store.applications.getApplication(appId), "NOT_FOUND");
          if (request.method === "GET") {
            fence();
            if (new URL(request.url).searchParams.get("resolve") !== "1") return json({ binding: this.ci!.binding(appId) });
            // Resolve only on explicit owner request, never during status polling.
            const connection = await store.operations.getGitHubConnection(appId);
            ensure(connection && /^[A-Za-z0-9_./-]+$/.test(connection.ref) && !connection.ref.startsWith("refs/")
              && !connection.ref.includes("..") && !connection.ref.includes("//") && !connection.ref.endsWith("/") && !connection.ref.endsWith(".lock"), "CONFIG_CONFLICT");
            const identity = await this.connections!.repositoryIdentity(connection, fence);
            const current = await store.operations.getGitHubConnection(appId);
            ensure(current && canonicalJson(current) === canonicalJson(connection), "CONFIG_CONFLICT"); fence();
            return json({ binding: this.ci!.binding(appId), identity: { appId, connectionVersion: connection.version, repository: connection.owner + "/" + connection.repository,
              ...identity, ref: "refs/heads/" + connection.ref } });
          }
          ensure(update); fence();
          const prior = this.ci!.binding(appId); ensure((prior?.version ?? 0) === update.expectedVersion, "CONFLICT");
          const connection = await store.operations.getGitHubConnection(appId); ensure(connection && "refs/heads/" + connection.ref === update.ref, "CONFIG_CONFLICT");
          const identity = await this.connections!.repositoryIdentity(connection, fence);
          ensure(identity.repositoryId === update.repositoryId && identity.repositoryOwnerId === update.repositoryOwnerId, "PERMISSION_DENIED");
          const service = createAutomationService({ applications: store.applications, operations: store.operations, automation: store.automation }, { publicOrigin: config.origin });
          let enrollment: RunnerEnrollment | null = null;
          const credential = prior ? await store.automation.getRunnerCredential(prior.runnerId) : null;
          if (!credential || credential.revokedAt !== null) enrollment = await service.enrollRunner({ name: "GitHub Actions CI", appIds: [appId] });
          fence(); const current = await store.operations.getGitHubConnection(appId); ensure(current && canonicalJson(current) === canonicalJson(connection), "CONFIG_CONFLICT");
          return json({ binding: this.ci!.configure(appId, update, connection, enrollment, Date.now(), fence) });
        } catch (error) { if (error instanceof AuthFailure) throw error; return hostedFailure(error); }
        finally { release?.(); if (request.method==="POST") this.projectSummaryCache.invalidate(); }
      }
      if (route.kind === "runner" || route.kind === "hook" || route.kind === "ci-token") {
        try { return await this.automationRequest(request, route.kind); }
        catch (error) { if (error instanceof AuthFailure) throw error; return hostedFailure(error); }
      }
      if (route.kind === "internal") {
        const grant = await this.requireSession(request); this.assertCurrent(grant);
        return secureResponse(new Response(null, { status: 204 }));
      }
      if (route.kind === "hosted") {
        const grant = await this.requireSession(request);
        const automationRoute = automationManagementRoute(route.path), action = automationRoute?.action;
        const expensive = request.method === "POST" && !autoRollbackPolicyRoute(path) && !autoRollbackInstallationsRoute(path) && !["cancel", "revoke"].includes(action ?? "");
        const release = expensive ? this.tryHeavy("import") : null;
        if (expensive && !release) throw new AuthFailure(409, "BUSY", 1);
        if (request.method==="POST") this.projectSummaryCache.invalidate();
        try {
          const installationAppId = autoRollbackInstallationsRoute(path);
          if (installationAppId) {
            if (!this.autoRollback || !this.sdkTelemetry) throw new HttpFailure(503, "AUTO_ROLLBACK_UNAVAILABLE");
            if (this.policyBodies >= 4) throw new HttpFailure(429, "AUTO_ROLLBACK_BUSY");
            this.policyBodies++;
            try {
              const input = object(await this.body(request), ["deploymentId", "installationRef", "enabled"]);
              if (typeof input.enabled !== "boolean") throw new HttpFailure(400, "INVALID_INPUT");
              const config = this.config(), fence = () => this.assertCurrent(grant);
              const installationHash = await this.sdkTelemetry.resolveInstallation(this.env.FLORA_DB, config, installationAppId, input.deploymentId as string, input.installationRef as string, fence, Date.now());
              fence();
              const state = this.autoRollback.setInstallation(grant.ownerId, installationAppId, installationHash, input.enabled, Date.now());
              return json({ enabled: input.enabled, eligibleInstallations: state.eligibleInstallations, policyVersion: state.policy?.version ?? null });
            } finally { this.policyBodies--; }
          }
          const policyAppId = autoRollbackPolicyRoute(path);
          if (policyAppId) {
            if (!this.autoRollback || !this.sdkTelemetry) throw new HttpFailure(503, "AUTO_ROLLBACK_UNAVAILABLE");
            if (this.policyBodies >= 4) throw new HttpFailure(429, "AUTO_ROLLBACK_BUSY");
            this.policyBodies++;
            try {
            const fence = () => this.assertCurrent(grant), config = this.config();
            const input = request.method === "POST" ? parseAutoRollbackPolicyInput(await this.body(request)) : null;
            fence();
            // Existing policy disable never waits for D1 or the publication lock.
            if (input && !input.enabled && this.autoRollback.get(grant.ownerId, policyAppId).policy) {
              return json(this.autoRollback.save(grant.ownerId, policyAppId, input, Date.now()));
            }
            const store = this.importStore(config, fence);
            const application = await store.applications?.getApplication(policyAppId);
            ensure(application && store.operations, "NOT_FOUND"); fence();
            if (request.method === "GET") return json(this.autoRollback.get(grant.ownerId, policyAppId));
            ensure(input); fence();
            for (const platform of ["ios", "android"] as const) {
              const targetId = input.targets[platform]; if (!targetId || !input.enabled) continue;
              const target = await store.operations.getOTADeployment(policyAppId, targetId); fence();
              if (!target || !this.healthyRollbackTarget(grant.ownerId, policyAppId, targetId)) throw new HttpFailure(409, "AUTO_ROLLBACK_TARGET_UNHEALTHY");
              if (target.appId !== policyAppId || target.platform !== platform || target.channel !== input.channel) throw new HttpFailure(409, "AUTO_ROLLBACK_TARGET_SCOPE_MISMATCH");
            }
            fence(); return json(this.autoRollback.save(grant.ownerId, policyAppId, input, Date.now()));
            } finally { this.policyBodies--; }
          }
          const telemetryJourney=telemetryJourneyRoute(path);
          if(telemetryJourney){
            if(!this.sdkTelemetry)throw new HttpFailure(503,"SDK_TELEMETRY_UNAVAILABLE");
            const result=await this.sdkTelemetry.journey(this.env.FLORA_DB,this.config(),telemetryJourney.appId,telemetryJourney.deploymentId,telemetryJourney.installationRef,new URL(request.url).searchParams.get("cursor"),()=>this.assertCurrent(grant),Date.now());
            this.assertCurrent(grant);return json(result);
          }
          const telemetryDetail=telemetryDetailRoute(path);
          if(telemetryDetail){
            if(!this.sdkTelemetry)throw new HttpFailure(503,"SDK_TELEMETRY_UNAVAILABLE");
            const result=await this.sdkTelemetry.detail(this.env.FLORA_DB,this.config(),telemetryDetail.appId,telemetryDetail.deploymentId,new URL(request.url).searchParams.get("cursor"),telemetryDetail.installationRef,()=>this.assertCurrent(grant),Date.now(),installationHash=>this.autoRollback?.isInstallationAllowed(grant.ownerId,telemetryDetail.appId,installationHash)??false,(new URL(request.url).searchParams.get("filter") ?? "all") as "all" | "issues" | "unresolved" | "resolved");
            this.assertCurrent(grant);
            const automaticRollback = this.autoRollback?.annotations(grant.ownerId, telemetryDetail.appId, [telemetryDetail.deploymentId]).get(telemetryDetail.deploymentId) ?? null;
            return json({ ...result, automaticRollback });
          }
          if (path.endsWith("/ota/verification")) {
            if (!this.otaVerification) throw new AuthFailure(503,"OTA_VERIFICATION_UNAVAILABLE");
            const input = await this.body(request); this.assertCurrent(grant);
            const result = await this.otaVerification.record(this.env.FLORA_DB,this.config(),path.split("/")[3]!,input,()=>this.assertCurrent(grant),Date.now());
            this.assertCurrent(grant);
            return json({verification:result.verification},result.created?201:200);
          }
          if (path === "/api/projects") {
            this.assertCurrent(grant);
            const presence = new Map(this.ctx.storage.sql.exec<{ runner_id: string; last_seen_at: number }>("SELECT runner_id,last_seen_at FROM flora_runner_presence ORDER BY runner_id LIMIT 100").toArray().map(row => [row.runner_id, row.last_seen_at]));
            const result = await listProjectSummaries(this.env.FLORA_DB, this.config(), () => this.assertCurrent(grant), Date.now(), presence, this.projectSummaryCache);
            if (this.otaVerification) {
              const targets = result.projects.flatMap(project=>[project.ota.ios,project.ota.android].filter(deployment=>deployment!==null).map(deployment=>({appId:project.id,deploymentId:deployment!.id})));
              const proofs = this.otaVerification.latest(grant.ownerId,targets,()=>this.assertCurrent(grant));
              for (const project of result.projects) for (const deployment of [project.ota.ios,project.ota.android]) if (deployment) {
                const proof = proofs.get(JSON.stringify([project.id,deployment.id])); if (proof) deployment.verification=proof;
              }
            }
            if(this.sdkTelemetry){
              this.sdkTelemetry.registerRollbackLineages(grant.ownerId,result.rollbackLineages??[],()=>this.assertCurrent(grant));
              const targets=result.projects.flatMap(project=>[project.ota.ios,project.ota.android].filter(d=>d!==null).flatMap(d=>[{appId:project.id,deploymentId:d!.id},...(d!.rollbackIssue?[{appId:project.id,deploymentId:d!.rollbackIssue.deploymentId}]:[])]));
              const telemetry=this.sdkTelemetry.latest(grant.ownerId,targets,()=>this.assertCurrent(grant));
              for(const project of result.projects)for(const deployment of[project.ota.ios,project.ota.android])if(deployment){const report=telemetry.get(JSON.stringify([project.id,deployment.id]));if(report)deployment.telemetry=report;if(deployment.rollbackIssue)deployment.rollbackIssue.telemetry=telemetry.get(JSON.stringify([project.id,deployment.rollbackIssue.deploymentId]))??null;}
            }
            this.assertCurrent(grant);
            const {rollbackLineages:_rollbackLineages,...publicResult}=result;
            return json({...publicResult,usage:this.usageCache?.snapshot(this.env.FLORA_USAGE_REPORTER_ID?this.env.FLORA_CLOUDFLARE_ACCOUNT_ID:undefined,Date.now())});
          }
          const store = this.importStore(this.config(), () => this.assertCurrent(grant));
          const credentials = this.connections!.credentials();
          const github = credentials ? createGitHubResolver({ credentials }) : undefined;
          const source = credentials ? createGitHubAutomationSourceProvider({ credentials }) : undefined;
          const response = await handleHostedApi(request, store, Date.now, github, source);
          this.assertCurrent(grant);
          const management = managementRoute(path);
          if (response.status === 200 && request.method === "GET" && management?.action === "operations") {
            const state = await response.json() as OperationsState;
            this.assertCurrent(grant);
            // Enrich only this authenticated app's existing bounded history. These
            // indexed DO summaries add no D1 reads or changes to published records.
            ensure(Array.isArray(state.deployments) && state.deployments.length <= 20
              && state.deployments.every(deployment => deployment.appId === management.appId), "CONFIG_CONFLICT");
            const targets = state.deployments.map(deployment => ({ appId: management.appId, deploymentId: deployment.id }));
            const fence = () => this.assertCurrent(grant);
            const proofs = this.otaVerification?.latest(grant.ownerId, targets, fence);
            await this.sdkTelemetry?.synchronizeRollbackHistory(this.env.FLORA_DB,this.config(),management.appId,state.deployments,fence);
            const reports = this.sdkTelemetry?.latest(grant.ownerId, targets, fence);
            const automatic = this.autoRollback?.annotations(grant.ownerId, management.appId, state.deployments.map(deployment => deployment.id));
            this.assertCurrent(grant);
            return json({ ...state, deployments: state.deployments.map(deployment => {
              const key = JSON.stringify([management.appId, deployment.id]);
              const verification = proofs?.get(key), telemetry = reports?.get(key);
              const automaticRollback = automatic?.get(deployment.id);
              return { ...deployment, ...(verification ? { verification } : {}), ...(telemetry ? { telemetry } : {}), ...(automaticRollback ? { automaticRollback } : {}) };
            }) });
          }
          if (response.status === 200 && action === "state") {
            const state = await response.json() as { runners: Array<{ id: string; revokedAt: number | null }> };
            this.assertCurrent(grant);
            return json({ ...state, runners: state.runners.map(runner => ({ ...runner, presence: this.runnerPresence(runner.id, runner.revokedAt, Date.now()) })) });
          }
          if (response.status === 200 && action === "revoke") this.ctx.storage.sql.exec("DELETE FROM flora_runner_presence WHERE runner_id=?", automationRoute!.runnerId!);
          return response;
        } catch (error) {
          if (error instanceof AuthFailure) throw error;
          return hostedFailure(error);
        } finally { release?.(); if (request.method==="POST") this.projectSummaryCache.invalidate(); }
      }
      if (request.method === "GET" && path === "/api/auth/session") {
        const grant = await this.requireSession(request);
        this.assertCurrent(grant);
        return json({ csrfToken: cookie(request, csrfName), expiresAt: grant.expiresAt, ...(this.config().workspaceName ? { workspaceName: this.config().workspaceName } : {}) });
      }
      if (request.method === "POST") {
        if (path === "/api/auth/login") return await this.authenticate(request, "login");
        if (path === "/api/auth/enroll") return await this.authenticate(request, "enroll");
        if (path === "/api/auth/recover") return await this.authenticate(request, "recover");
        if (path === "/api/auth/logout") {
          const grant = await this.requireSession(request);
          const input = await this.body(request);
          if (Object.keys(input).length !== 0) throw new AuthFailure(400, "INVALID_REQUEST");
          this.assertCurrent(grant);
          this.state!.logout(grant, Date.now());
          const headers = new Headers();
          for (const name of [sessionName, csrfName]) headers.append("Set-Cookie", name + "=" + cookieOptions + "; Max-Age=0");
          return json({ ok: true }, 200, headers);
        }
      }
      return json({ error: "NOT_FOUND" }, 404);
    } catch (error) {
      if (error instanceof HttpFailure) return json({ error: error.code }, error.status);
      const failure = error instanceof AuthFailure ? error : new AuthFailure(503, "AUTH_UNAVAILABLE");
      const headers = new Headers();
      if (failure.retryAfter !== undefined) headers.set("Retry-After", String(failure.retryAfter));
      return json({ error: failure.code }, failure.status, headers);
    }
  }
}
