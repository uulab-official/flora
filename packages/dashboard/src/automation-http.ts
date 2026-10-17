import { id, object, ensure } from "@app-ops/core";
import { parseAutomationExportReceipt, parseAutomationFailureCode, parseAutomationLease, parseAutomationQueueInput, parseAutoPolicyUpdate, parseRunnerEnrollmentInput, parseOTAAssetUpload, otaPlatform, OTA_ASSET_MAX_BYTES } from "@app-ops/dogfood";
import type { AutomationClaimScope, AutomationLease, AutomationService, OTAPlatform } from "@app-ops/dogfood";

export class AutomationHttpFailure extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
export interface AutomationRoute { action: string; method: "GET" | "POST"; limit: number; query: string[]; binary: boolean; appId?: string; jobId?: string; runnerId?: string }
export function automationManagementRoute(path: string): AutomationRoute | null {
  const app = /^\/api\/apps\/([a-z][a-z0-9_-]{2,95})\/automation(?:\/(policy|jobs)(?:\/([a-z][a-z0-9_-]{2,95})(\/cancel)?)?)?$/.exec(path);
  if (app) {
    const action = app[2] === "policy" ? "policy" : app[3] ? app[4] ? "cancel" : "job" : app[2] === "jobs" ? "queue" : "state";
    if (app[2] === "policy" && app[3]) return null;
    return { action, appId: id(app[1]), ...(app[3] ? { jobId: id(app[3]) } : {}), method: ["state", "job"].includes(action) ? "GET" : "POST", limit: ["state", "job"].includes(action) ? 0 : 16384, query: [], binary: false };
  }
  const runner = /^\/api\/runners(?:\/([a-z][a-z0-9_-]{2,95})\/revoke)?$/.exec(path);
  return runner ? { action: runner[1] ? "revoke" : "enroll", ...(runner[1] ? { runnerId: id(runner[1]) } : {}), method: "POST", limit: 16384, query: [], binary: false } : null;
}
export function automationRunnerRoute(path: string): AutomationRoute | null {
  const match = /^\/api\/runner\/(claim|heartbeat|source|assets|finalize|fail|checkpoint-save|checkpoint-list|checkpoint-clear)$/.exec(path);
  return match ? { action: match[1]!, method: "POST", limit: match[1] === "assets" ? OTA_ASSET_MAX_BYTES : 65536, query: match[1] === "assets" ? ["key", "contentType", "fileExtension"] : [], binary: match[1] === "assets" } : null;
}
export async function dispatchAutomationManagement(route: AutomationRoute, data: unknown, service: AutomationService): Promise<unknown> {
  if (route.action === "state") return service.getState(route.appId!);
  if (route.action === "job") return service.getJob(route.appId!, route.jobId!);
  if (route.action === "queue") return service.queue(route.appId!, parseAutomationQueueInput(data));
  if (route.action === "policy") return service.updatePolicy(route.appId!, parseAutoPolicyUpdate(data));
  if (route.action === "enroll") return service.enrollRunner(parseRunnerEnrollmentInput(data));
  object(data, []);
  return route.action === "cancel" ? service.cancel(route.appId!, route.jobId!) : service.revokeRunner(route.runnerId!);
}
export function runnerToken(headers: Headers): string {
  const value = headers.get("Authorization");
  if (!value || value.length > 512 || !/^Bearer [A-Za-z0-9._-]+$/.test(value)) throw new AutomationHttpFailure(401, "UNAUTHENTICATED");
  return value.slice(7);
}
export function runnerUploadLease(headers: Headers): AutomationLease {
  const value = headers.get("X-Flora-Runner-Lease");
  ensure(value && value.length <= 2048 && /^[A-Za-z0-9_-]+$/.test(value));
  let raw: unknown;
  try {
    const text = value.replaceAll("-", "+").replaceAll("_", "/");
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(text + "=".repeat((4 - text.length % 4) % 4)), c => c.charCodeAt(0))));
  } catch { throw new AutomationHttpFailure(400, "INVALID_INPUT"); }
  return parseAutomationLease(raw);
}
/** The adapter calls authorizeRunner before consuming any machine request body. */
export async function dispatchAutomationRunner(route: AutomationRoute, url: URL, headers: Headers, data: unknown, service: AutomationService, admittedScope?: AutomationClaimScope & { platforms?: OTAPlatform[] }): Promise<unknown> {
  // Persistent CI checkpoints belong to the hosted owner DO authority.
  if (route.action.startsWith("checkpoint-")) throw new AutomationHttpFailure(404, "NOT_FOUND");
  const token = runnerToken(headers);
  if (route.action === "assets") {
    ensure(data instanceof Uint8Array);
    return service.uploadAsset(token, runnerUploadLease(headers), parseOTAAssetUpload(Object.fromEntries(route.query.map(key => [key, url.searchParams.get(key)]))), data);
  }
  if (route.action === "claim") {
    if (!admittedScope) { object(data, []); return service.claim(token); }
    const raw = object(data, data && typeof data === "object" && Object.hasOwn(data, "platform") ? ["platform"] : []);
    const requested = raw.platform === undefined ? undefined : otaPlatform(raw.platform);
    const allowed = admittedScope.platforms;
    const platform = requested ?? (allowed?.length === 1 ? allowed[0] : undefined);
    ensure(!allowed || platform !== undefined && allowed.includes(platform), "PERMISSION_DENIED");
    return service.claim(token, { appId: admittedScope.appId, commitSha: admittedScope.commitSha, ...(platform ? { platform } : {}) });
  }
  const names = route.action === "finalize" ? ["lease", "receipt"] : route.action === "fail" ? ["lease", "code"] : ["lease"];
  const raw = object(data, names), lease = parseAutomationLease(raw.lease);
  if (route.action === "heartbeat") return service.heartbeat(token, lease);
  if (route.action === "source") return service.source(token, lease);
  if (route.action === "fail") return service.fail(token, lease, parseAutomationFailureCode(raw.code));
  return service.finalize(token, lease, parseAutomationExportReceipt(raw.receipt));
}
