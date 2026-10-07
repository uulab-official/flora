import { DomainError, ensure, object } from "@app-ops/core";
import { CONFIG_RUNTIME_SMOKE_V1, deriveFreshness } from "@app-ops/dogfood";
import type { HeadObservation } from "@app-ops/dogfood";
import { createImportService } from "@app-ops/dashboard/import-service";
import type { HostedState, HostedStore } from "./contracts.js";
import { HttpFailure, json, parseJson, readBody, routeRequest, secureResponse } from "./http.js";

/** Runs only in the owner DO, with an authority-fenced store. */
export async function handleHostedApi(request: Request, store: HostedStore, now: () => number): Promise<Response> {
  const route = routeRequest(request), url = new URL(request.url);
  if (route.kind !== "hosted") throw new HttpFailure(404, "NOT_FOUND");
  if (route.path === "/api/state") {
    const snapshots = await store.pageInventory(url.searchParams.get("snapshotCursor"));
    const requestedId = url.searchParams.get("snapshotId");
    const newest = requestedId === null && url.searchParams.has("snapshotCursor") ? await store.pageInventory(null) : snapshots;
    const selectedId = requestedId ?? newest.items[0]?.id ?? null;
    const selected = selectedId === null ? null : await store.getInventory(selectedId);
    ensure(selectedId === null || selected, "NOT_FOUND");
    if (!selected && url.searchParams.has("historyCursor")) throw new HttpFailure(400, "INVALID_INPUT");
    const [history, headObservation] = selected ? await Promise.all([
      store.pageBaselines(selected.id, url.searchParams.get("historyCursor")), store.getHeadObservation(selected),
    ]) : [{ items: [], nextCursor: null }, null];
    const state: HostedState = { snapshots, selected, history, headObservation, freshness: selected ? deriveFreshness(selected, headObservation) : "freshness_unknown", profile: CONFIG_RUNTIME_SMOKE_V1, runner: "unavailable" };
    return json(state);
  }
  const log = /^\/api\/baselines\/([a-z][a-z0-9_-]{2,95})\/log$/.exec(route.path);
  if (log) {
    const value = await store.getSafeLog(log[1]!); ensure(value, "NOT_FOUND");
    return json(value);
  }
  const bytes = await readBody(request, route.limit), imports = createImportService(store, now);
  if (route.path === "/api/sources") return json(await imports.importSource(bytes), 201);
  if (route.path === "/api/baselines") return json(await imports.importBaseline(url.searchParams.get("snapshotId")!, bytes), 201);
  const body = object(parseJson(bytes), ["repositoryId", "rootDirectory", "headCommitSha", "observedAt", "evidenceOrigin"]);
  ensure(body.evidenceOrigin === "operator-import");
  await imports.importHead(body as unknown as HeadObservation);
  return secureResponse(new Response(null, { status: 204 }));
}
export function hostedFailure(error: unknown): Response {
  if (error instanceof HttpFailure) return json({ error: error.code }, error.status);
  if (error instanceof DomainError) {
    if (["CONFLICT", "IDEMPOTENCY_CONFLICT"].includes(error.code)) return json({ error: error.code }, 409);
    if (error.code === "INPUT_TOO_LARGE") return json({ error: error.code }, 413);
    if (error.code === "NOT_FOUND") return json({ error: error.code }, 404);
    if (error.code === "INVALID_INPUT") return json({ error: error.code }, 400);
  }
  return json({ error: "DEPENDENCY_UNAVAILABLE" }, 503);
}
