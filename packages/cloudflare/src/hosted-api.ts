import { DomainError, ensure, object } from "@app-ops/core";
import { applicationId, CONFIG_RUNTIME_SMOKE_V1, deriveFreshness, parseApplicationRegistration, parseSettingsUpdate } from "@app-ops/dogfood";
import type { HeadObservation } from "@app-ops/dogfood";
import { createImportService } from "@app-ops/dashboard/import-service";
import { managementRoute, dispatchManagement } from "@app-ops/dashboard/operations-http";
import { automationManagementRoute, dispatchAutomationManagement, AutomationHttpFailure } from "@app-ops/dashboard/automation-http";
import { createOperationsService, createAutomationService } from "@app-ops/dogfood";
import type { GitHubResolver, AutomationSourceProvider } from "@app-ops/dogfood";
import type { HostedState, HostedStore } from "./contracts.js";
import { HttpFailure, json, parseJson, readBody, routeRequest, secureResponse } from "./http.js";
import { d1FailureCode } from "./d1-failure.js";

/** Runs only in the owner DO, with an authority-fenced store. */
export async function handleHostedApi(request: Request, store: HostedStore, now: () => number, github?: GitHubResolver, source?: AutomationSourceProvider): Promise<Response> {
  const route = routeRequest(request), url = new URL(request.url);
  if (route.kind !== "hosted") throw new HttpFailure(404, "NOT_FOUND");
  const automation = automationManagementRoute(route.path);
  if (automation) {
    ensure(store.applications && store.operations && store.automation, "PROVIDER_UNSUPPORTED");
    const operations = createOperationsService({ applications: store.applications, operations: store.operations }, github, now, { publicOrigin: url.origin });
    const service = createAutomationService({ applications: store.applications, operations: store.operations, automation: store.automation }, {
      now, publicOrigin: url.origin, ...(source ? { source } : {}), maxWebhookTargets: 1,
      detectCommit: (app, sha) => operations.detectCommit(app, sha),
      detectPushCommit: (app, sha) => operations.detectCommit(app, sha, { requireCurrentRef: true }),
    });
    const value = request.method === "GET" ? null : parseJson(await readBody(request, route.limit));
    return json(await dispatchAutomationManagement(automation, value, service), ["enroll", "queue"].includes(automation.action) ? 201 : 200);
  }
  const management = managementRoute(route.path);
  if (management) {
    ensure(store.applications && store.operations, "PROVIDER_UNSUPPORTED");
    const operations = createOperationsService({ applications: store.applications, operations: store.operations }, github, now, { publicOrigin: url.origin });
    const data = request.method === "GET" ? null : await readBody(request, route.limit, management.binary);
    return json(await dispatchManagement(management, url, data === null || management.binary ? data : parseJson(data), operations), request.method === "POST" ? 201 : 200);
  }
  const requestedAppId = url.searchParams.get("appId") ?? undefined;
  if (route.path === "/api/apps") {
    ensure(store.applications, "PROVIDER_UNSUPPORTED");
    return request.method === "GET" ? json(await store.applications.listApplications())
      : json(await store.applications.registerApplication(parseApplicationRegistration(parseJson(await readBody(request, route.limit))), now()), 201);
  }
  const settings = /^\/api\/apps\/([a-z][a-z0-9_-]{2,95})\/settings$/.exec(route.path);
  if (settings) {
    ensure(store.applications, "PROVIDER_UNSUPPORTED");
    return json(await store.applications.updateApplicationSettings(applicationId(settings[1]), parseSettingsUpdate(parseJson(await readBody(request, route.limit))), now()));
  }
  if (route.path === "/api/state") {
    const requestedId = url.searchParams.get("snapshotId");
    let selectedApplication = requestedAppId ? await store.applications?.getApplication(applicationId(requestedAppId)) : null;
    ensure(requestedAppId === undefined || selectedApplication, "NOT_FOUND");
    if (!selectedApplication && store.applications) {
      const latestId = requestedId ?? (await store.pageInventory(null)).items[0]?.id;
      if (latestId) selectedApplication = await store.applications.getApplicationForSnapshot(latestId);
    }
    const appId = selectedApplication?.id;
    const snapshots = await store.pageInventory(url.searchParams.get("snapshotCursor"), appId);
    const newest = requestedId === null && url.searchParams.has("snapshotCursor") ? await store.pageInventory(null, appId) : snapshots;
    const selectedId = requestedId ?? newest.items[0]?.id ?? null;
    const selected = selectedId === null ? null : await store.getInventory(selectedId);
    ensure(selectedId === null || selected, "NOT_FOUND");
    if (selected && selectedApplication) ensure(selected.repository.id === selectedApplication.repositoryId && selected.rootDirectory === selectedApplication.rootDirectory, "NOT_FOUND");
    if (!selected && url.searchParams.has("historyCursor")) throw new HttpFailure(400, "INVALID_INPUT");
    const [history, headObservation] = selected ? await Promise.all([
      store.pageBaselines(selected.id, url.searchParams.get("historyCursor"), appId), store.getHeadObservation(selected),
    ]) : [{ items: [], nextCursor: null }, null];
    const state: HostedState = { ...(store.applications ? { applications: await store.applications.listApplications(), selectedApplication: selectedApplication ?? null } : {}), snapshots, selected, history, headObservation, freshness: selected ? deriveFreshness(selected, headObservation) : "freshness_unknown", profile: CONFIG_RUNTIME_SMOKE_V1, runner: "unavailable" };
    return json(state);
  }
  const log = /^\/api\/baselines\/([a-z][a-z0-9_-]{2,95})\/log$/.exec(route.path);
  if (log) {
    const value = await store.getSafeLog(log[1]!, requestedAppId); ensure(value, "NOT_FOUND");
    return json(value);
  }
  const bytes = await readBody(request, route.limit), imports = createImportService(store, now);
  if (route.path === "/api/sources") return json(await imports.importSource(bytes, requestedAppId), 201);
  if (route.path === "/api/baselines") return json(await imports.importBaseline(url.searchParams.get("snapshotId")!, bytes, requestedAppId), 201);
  const body = object(parseJson(bytes), ["repositoryId", "rootDirectory", "headCommitSha", "observedAt", "evidenceOrigin"]);
  ensure(body.evidenceOrigin === "operator-import");
  await imports.importHead(body as unknown as HeadObservation, requestedAppId);
  return secureResponse(new Response(null, { status: 204 }));
}
export function hostedFailure(error: unknown): Response {
  if (error instanceof HttpFailure || error instanceof AutomationHttpFailure) return json({ error: error.code }, error.status);
  if (error instanceof DomainError) {
    if (["CONFLICT", "CONFIG_CONFLICT", "LEASE_STALE", "INVALID_TRANSITION", "IDEMPOTENCY_CONFLICT"].includes(error.code)) return json({ error: error.code }, 409);
    if (["PERMISSION_DENIED", "GITHUB_ACCESS_DENIED"].includes(error.code)) return json({ error: error.code }, 403);
    if (error.code === "INPUT_TOO_LARGE") return json({ error: error.code }, 413);
    if (["NOT_FOUND", "GITHUB_REPOSITORY_UNAVAILABLE", "GITHUB_REF_NOT_FOUND"].includes(error.code)) return json({ error: error.code }, 404);
    if (error.code === "GITHUB_APP_UNSUPPORTED") return json({ error: error.code }, 422);
    if (error.code === "INVALID_INPUT") return json({ error: error.code }, 400);
    if (["PROVIDER_UNCONFIGURED", "PROVIDER_UNSUPPORTED"].includes(error.code)) return json({ error: error.code }, 503);
  }
  return json({ error: d1FailureCode(error) ?? "DEPENDENCY_UNAVAILABLE" }, 503);
}
