/** Public metadata only. Secrets must never enter an installation journal. */
export type SetupMode = "new" | "existing" | "runner";
export type ProvisionStage = "planned" | "database-created" | "schema-ready" | "server-locked" | "https-ready" | "setup-issued" | "setup-deployed" | "operator-confirmed" | "setup-removed";
export type ActionState = "pending" | "confirmed" | "unknown";
export interface PublicRunnerBinding { schemaVersion: 1; origin: string; appId: string; runnerId: string }
export interface SetupResult { state: "ready" | "needs-operator" | "unknown" | "cancelled"; code: string; details?:{installationId:string;stage:ProvisionStage;origin:string;workerName:string;databaseId:string|null;pendingActions:string[]} }
export interface ResourcePlan {
  installationId: string; accountId: string; workerName: string; databaseName: string;
  hostname: string; zoneId: string; origin: string; ownerEmail: string; ownerId: string; dbIdentity: string;
}
export interface ProviderSnapshot {
  accountId: string; workerName: string; databaseId: string | null; namespaceId: string | null;
  deploymentId: string | null; configFingerprint: string | null; routeFingerprint: string | null;
}
export interface ActionReceipt { action: string; state: ActionState; expectedFingerprint: string | null; resourceId: string | null; observedFingerprint: string | null }
export interface SetupJournal {
  schemaVersion: 1; plan: ResourcePlan; stage: ProvisionStage; receipts: ActionReceipt[];
  setup: null | { digest: string; issuedAt: number; expiresAt: number; generation: 1; purpose: "enroll" };
}
export function requireSetup(condition: unknown, code = "SETUP_STATE_INVALID"): asserts condition {
  if (!condition) throw new Error(code);
}
export function strictObject(input: unknown, keys: readonly string[]): Record<string, unknown> {
  requireSetup(!!input && typeof input === "object" && !Array.isArray(input));
  const value = input as Record<string, unknown>;
  requireSetup(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key)));
  return value;
}
export function publicText(input: unknown, pattern: RegExp): string {
  requireSetup(typeof input === "string" && input.length <= 256 && pattern.test(input)); return input;
}
export function setupOrigin(input: unknown): string {
  const value = publicText(input, /^https:\/\/[^\s]+$/);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("SETUP_STATE_INVALID"); }
  requireSetup(url.origin === value && !url.username && !url.password && !url.port && /^[a-z0-9.-]+$/.test(url.hostname));
  return value;
}
const id = (value: unknown) => publicText(value, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const digest = (value: unknown) => publicText(value, /^[a-f0-9]{64}$/);
export function parseRunnerBinding(input: unknown): PublicRunnerBinding {
  const v = strictObject(input,["schemaVersion","origin","appId","runnerId"]);
  requireSetup(v.schemaVersion === 1);
  return {schemaVersion:1, origin:setupOrigin(v.origin), appId:id(v.appId), runnerId:publicText(v.runnerId,/^runner_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)};
}
export function parseJournal(input: unknown): SetupJournal {
  const v = strictObject(input,["schemaVersion","plan","stage","receipts","setup"]);
  requireSetup(v.schemaVersion === 1);
  const p = strictObject(v.plan,["installationId","accountId","workerName","databaseName","hostname","zoneId","origin","ownerEmail","ownerId","dbIdentity"]);
  const origin=setupOrigin(p.origin), hostname=publicText(p.hostname,/^[a-z0-9.-]{1,253}$/);
  requireSetup(new URL(origin).hostname === hostname);
  const plan:ResourcePlan={installationId:id(p.installationId),accountId:publicText(p.accountId,/^[a-f0-9]{32}$/),workerName:publicText(p.workerName,/^[a-z][a-z0-9-]{0,62}$/),databaseName:publicText(p.databaseName,/^[a-z][a-z0-9-]{0,62}$/),hostname,zoneId:publicText(p.zoneId,/^[a-f0-9]{32}$/),origin,ownerEmail:publicText(p.ownerEmail,/^[^\s@]+@[^\s@]+\.[^\s@]+$/),ownerId:id(p.ownerId),dbIdentity:publicText(p.dbIdentity,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)};
  const stages:ProvisionStage[]=["planned","database-created","schema-ready","server-locked","https-ready","setup-issued","setup-deployed","operator-confirmed","setup-removed"];
  requireSetup(stages.includes(v.stage as ProvisionStage) && Array.isArray(v.receipts) && v.receipts.length<=32);
  const receipts:ActionReceipt[]=v.receipts.map(input=>{
    const r=strictObject(input,["action","state","expectedFingerprint","resourceId","observedFingerprint"]);
    requireSetup(["pending","confirmed","unknown"].includes(String(r.state)));
    return {action:id(r.action),state:r.state as ActionState,expectedFingerprint:r.expectedFingerprint===null?null:digest(r.expectedFingerprint),resourceId:r.resourceId===null?null:id(r.resourceId),observedFingerprint:r.observedFingerprint===null?null:digest(r.observedFingerprint)};
  });
  let setup:SetupJournal["setup"]=null;
  if(v.setup!==null){
    const s=strictObject(v.setup,["digest","issuedAt","expiresAt","generation","purpose"]);
    requireSetup(s.generation===1 && s.purpose==="enroll" && Number.isSafeInteger(s.issuedAt) && Number.isSafeInteger(s.expiresAt) && (s.issuedAt as number)>=0 && (s.expiresAt as number)-(s.issuedAt as number)===600000);
    setup={digest:digest(s.digest),issuedAt:s.issuedAt as number,expiresAt:s.expiresAt as number,generation:1,purpose:"enroll"};
  }
  return {schemaVersion:1,plan,stage:v.stage as ProvisionStage,receipts,setup};
}
