import type { D1Database } from "@cloudflare/workers-types";
import type { FloraConfig } from "./contracts.js";
import type { OTAVerificationSummary } from "./ota-verification.js";
import { sdkRollbackChainProjection } from "./sdk-telemetry.js";
import type { SDKTelemetrySummary, SDKRollbackLineage, SDKRollbackChain } from "./sdk-telemetry.js";
import type { OTARollbackMetadata } from "@app-ops/dogfood";

export type ProjectRunnerStatus = "unregistered" | "unseen" | "online" | "offline" | "revoked";
export interface ProjectDeploymentSummary { id: string; channel: string; runtimeVersion: string; createdAt: number; commitSha: string; verification?: OTAVerificationSummary; telemetry?: SDKTelemetrySummary; rollback?:OTARollbackMetadata;rollbackIssue?:{deploymentId:string;telemetry:SDKTelemetrySummary|null;depth?:number}|null }
export interface ProjectSummary {
  id: string; name: string; createdAt: number; repositoryId: string; rootDirectory: string;
  truncated: { repositoryId: boolean; rootDirectory: boolean };
  github: null | { owner: string; repository: string; ref: string; version: number; truncated: { owner: boolean; repository: boolean; ref: boolean } };
  ota: { ios: ProjectDeploymentSummary | null; android: ProjectDeploymentSummary | null };
  automation: null | { enabled: boolean; channel: string; platforms: ("ios" | "android")[]; updatedAt: number };
  runner: { status: ProjectRunnerStatus; registeredCount: number; activeCount: number; onlineCount: number; lastSeenAt: number | null };
}
export interface ProjectList { projects: ProjectSummary[]; observedAt: number; /** Internal server-only verified facts; stripped by the HTTP response. */ rollbackLineages?:SDKRollbackLineage[] }
interface RunnerProjection { id: string; app_ids: string; revoked_at: number | null }
interface ProjectRow { id: string; name: string; created_at: number; repository_id: string; root_directory: string; repository_truncated: number; root_truncated: number; github: string | null; ios: string | null; android: string | null; ios_lineage?:string|null;android_lineage?:string|null; policy: string | null }
type Projection = { rows: ProjectRow[]; runners: RunnerProjection[] };
type CacheValue = { projection: Projection } | { failure: unknown };
/** Per-owner DO memory only. Cache facts, never grants or live Runner presence. */
export class ProjectSummaryCache {
  private entry: { identity: string; observedAt: number; value: CacheValue } | undefined;
  private version = Symbol();
  get revision(): symbol { return this.version; }
  invalidate(): void { this.entry=undefined; this.version=Symbol(); }
  private identity(config: FloraConfig): string { return JSON.stringify([config.ownerId,config.origin,config.dbIdentity]); }
  read(config: FloraConfig,now: number): CacheValue | undefined {
    const entry=this.entry;
    return entry && entry.identity===this.identity(config) && now>=entry.observedAt && now-entry.observedAt<60000 ? entry.value : undefined;
  }
  retain(config: FloraConfig,now: number,revision: symbol,value: CacheValue): void {
    // An awaited read admitted before a mutation cannot refill its old cache.
    if (revision===this.version) this.entry={identity:this.identity(config),observedAt:now,value};
  }
}
const deployment = (alias: string) => `CASE WHEN ${alias}.id IS NULL THEN NULL ELSE json_object('id',${alias}.id,'channel',${alias}.channel,'runtimeVersion',${alias}.runtime_version,'createdAt',${alias}.created_at,'commitSha',json_extract(${alias}.data,'$.commitSha')) END`;

/** Read-only owner projection. Fixed bounded query count; no credentials, assets, logs or provider calls. */
export async function listProjectSummaries(db: D1Database, config: FloraConfig, fence: () => void, observedAt: number,
  presence: ReadonlyMap<string, number>, cache?: ProjectSummaryCache): Promise<ProjectList> {
  fence();
  const identity = await db.prepare("SELECT owner_id,origin,db_identity FROM flora_deployment WHERE singleton=1").first<{ owner_id: string; origin: string; db_identity: string }>();
  fence();
  if (!identity || identity.owner_id !== config.ownerId || identity.origin !== config.origin || identity.db_identity !== config.dbIdentity) throw new Error("PROJECT_STORE_IDENTITY_MISMATCH");
  const revision=cache?.revision, cached=cache?.read(config,observedAt);
  if (cached && "failure" in cached) throw cached.failure;
  let projection: Projection;
  if (cached && "projection" in cached) projection=cached.projection;
  else {
  try {
  const results = await db.batch([
    db.prepare(`SELECT a.id,a.name,a.created_at,substr(a.repository_id,1,256) repository_id,substr(a.root_directory,1,256) root_directory,
      length(a.repository_id)>256 repository_truncated,length(a.root_directory)>256 root_truncated,
      CASE WHEN c.app_id IS NULL THEN NULL ELSE json_object('owner',substr(json_extract(c.data,'$.owner'),1,256),'repository',substr(json_extract(c.data,'$.repository'),1,256),'ref',substr(json_extract(c.data,'$.ref'),1,256),'version',c.version,
        'truncated',json_object('owner',length(json_extract(c.data,'$.owner'))>256,'repository',length(json_extract(c.data,'$.repository'))>256,'ref',length(json_extract(c.data,'$.ref'))>256)) END github,
      ${deployment("i")} ios,${deployment("d")} android,
      CASE WHEN json_type(i.data,'$.rollback') IS NOT NULL THEN ${sdkRollbackChainProjection("i")} ELSE NULL END ios_lineage,
      CASE WHEN json_type(d.data,'$.rollback') IS NOT NULL THEN ${sdkRollbackChainProjection("d")} ELSE NULL END android_lineage,
      CASE WHEN p.app_id IS NULL THEN NULL ELSE json_object('enabled',json_extract(p.data,'$.enabled'),'channel',json_extract(p.data,'$.channel'),'platforms',json(COALESCE(json_extract(p.data,'$.platforms'),json_array(json_extract(p.data,'$.platform')))),'updatedAt',json_extract(p.data,'$.updatedAt')) END policy
      FROM applications a
      LEFT JOIN github_connections c ON c.owner_id=a.owner_id AND c.app_id=a.id AND c.version=(SELECT max(version) FROM github_connections WHERE owner_id=a.owner_id AND app_id=a.id)
      LEFT JOIN ota_deployments i ON i.owner_id=a.owner_id AND i.app_id=a.id AND i.id=(SELECT id FROM ota_deployments WHERE owner_id=a.owner_id AND app_id=a.id AND platform='ios' ORDER BY created_at DESC,rowid DESC LIMIT 1)
      LEFT JOIN ota_deployments d ON d.owner_id=a.owner_id AND d.app_id=a.id AND d.id=(SELECT id FROM ota_deployments WHERE owner_id=a.owner_id AND app_id=a.id AND platform='android' ORDER BY created_at DESC,rowid DESC LIMIT 1)
      LEFT JOIN automation_policies p ON p.owner_id=a.owner_id AND p.app_id=a.id AND p.version=(SELECT max(version) FROM automation_policies WHERE owner_id=a.owner_id AND app_id=a.id)
      WHERE a.owner_id=? ORDER BY a.created_at DESC,a.id DESC LIMIT 100`).bind(config.ownerId),
    db.prepare(`SELECT r.id,json_extract(r.data,'$.appIds') app_ids,json_extract(r.data,'$.revokedAt') revoked_at FROM automation_runners r
      WHERE r.owner_id=? AND r.version=(SELECT max(version) FROM automation_runners WHERE owner_id=r.owner_id AND id=r.id) ORDER BY r.id LIMIT 100`).bind(config.ownerId),
  ]);
  fence();
  if (results.length !== 2 || results.some(result => !result.success || !Array.isArray(result.results))) throw new Error("PROJECT_STORE_UNAVAILABLE");
  projection={rows:results[0]!.results as unknown as ProjectRow[],runners:results[1]!.results as unknown as RunnerProjection[]};
  if (cache && revision) cache.retain(config,observedAt,revision,{projection});
  } catch (error) {
    fence(); // Never cache a revoked session or authority failure.
    if (cache && revision) cache.retain(config,observedAt,revision,{failure:error});
    throw error;
  }
  }
  fence();
  const runners=projection.runners;
  const rollbackLineages:SDKRollbackLineage[]=[];
  const projects = projection.rows.map(row => {
    const selected = runners.filter(runner => (JSON.parse(runner.app_ids) as string[]).includes(row.id));
    const live = selected.filter(runner => runner.revoked_at === null);
    const seen = (runner: RunnerProjection) => { const value = presence.get(runner.id); return value !== undefined && Number.isSafeInteger(value) && value > 0 && value <= observedAt && observedAt - value <= 7 * 86400000 ? value : null; };
    const online = live.filter(runner => { const last = seen(runner); return last !== null && observedAt - last <= 120000; });
    const times = live.map(seen).filter((value): value is number => value !== null);
    const status: ProjectRunnerStatus = !selected.length ? "unregistered" : !live.length ? "revoked" : online.length ? "online" : times.length ? "offline" : "unseen";
    const github = row.github ? JSON.parse(row.github) as NonNullable<ProjectSummary["github"]> : null;
    if (github) for (const key of ["owner", "repository", "ref"] as const) github.truncated[key] = Boolean(github.truncated[key]);
    const automation = row.policy ? JSON.parse(row.policy) as NonNullable<ProjectSummary["automation"]> : null;
    if (automation) automation.enabled = Boolean(automation.enabled);
    const ota={ios:row.ios?JSON.parse(row.ios) as ProjectDeploymentSummary:null,android:row.android?JSON.parse(row.android) as ProjectDeploymentSummary:null};
    for(const platform of ["ios","android"] as const){
      const value=row[platform+"_lineage" as "ios_lineage"|"android_lineage"],selected=ota[platform];
      if(value&&selected){const chain=JSON.parse(value) as SDKRollbackChain,lineage=chain.facts.find(fact=>fact.id===selected.id);rollbackLineages.push(...chain.facts);selected.rollbackIssue=null;if(lineage){selected.rollback={fromDeploymentId:lineage.fromDeploymentId,targetDeploymentId:lineage.targetDeploymentId,reason:lineage.reason,requestedAt:lineage.requestedAt};if(chain.rootId)selected.rollbackIssue={deploymentId:chain.rootId,telemetry:null,...(chain.depth>1?{depth:chain.depth}:{})};}}
    }
    return { id: row.id, name: row.name, createdAt: row.created_at, repositoryId: row.repository_id, rootDirectory: row.root_directory,
      truncated: { repositoryId: Boolean(row.repository_truncated), rootDirectory: Boolean(row.root_truncated) }, github,
      ota, automation,
      runner: { status, registeredCount: selected.length, activeCount: live.length, onlineCount: online.length, lastSeenAt: times.length ? Math.max(...times) : null } };
  });
  // Prefixes overlap when the same immutable facts serve multiple projections.
  // Keep the established store cap independent of the 400 telemetry target cap.
  const uniqueLineages=[...new Map(rollbackLineages.map(value=>[JSON.stringify([value.appId,value.id]),value])).values()];
  return { projects, observedAt, ...(uniqueLineages.length?{rollbackLineages:uniqueLineages}:{}) };
}
