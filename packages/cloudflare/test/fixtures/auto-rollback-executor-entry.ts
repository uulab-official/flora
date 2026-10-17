import type { D1Database, DurableObjectNamespace, DurableObjectState, Request as BindingRequest } from "@cloudflare/workers-types";
import { createOperationsService } from "@app-ops/dogfood";
import type { OperationsStore } from "@app-ops/dogfood";
import { AutoRollbackStore } from "../../dist/auto-rollback.js";
import { executeAutoRollback } from "../../dist/auto-rollback-executor.js";
import { createD1ImportStore } from "../../dist/d1-import-store.js";
import { createD1OperationsStore } from "../../dist/operations-store.js";
import { HttpFailure } from "../../dist/http.js";

const config = { ownerId: "owner_a", ownerEmail: "owner@example.invalid", origin: "https://rollback.example.test", dbIdentity: "fixture", setup: null };
interface Env { AUTO: DurableObjectNamespace; FLORA_DB: D1Database }
export class AutoRollbackExecutorFixture {
  private auto: AutoRollbackStore;
  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) { this.auto = new AutoRollbackStore(ctx.storage); }
  async fetch(request: Request): Promise<Response> {
    const command = await request.json() as any;
    const now = command.now ?? 1_800_000_000_010;
    try {
      if (command.op === "queue") {
        const { appId, source, target } = command;
        for (const hash of ["anonymous_installation", ...Array.from({ length: 4 }, (_, index) => "healthy_" + index)]) this.auto.setInstallation("owner_a", appId, hash, true, source.createdAt - 1);
        this.auto.save("owner_a", appId, { expectedVersion: 0, enabled: true, failureRatePercent: command.small ? 100 : 20, minInstallations: command.small ? 1 : 5, windowMinutes: 30, channel: source.channel, targets: { ios: target.id, android: target.id } }, source.createdAt - 1);
        const observation = { ownerId: "owner_a", appId, deploymentId: source.id, platform: source.platform, channel: source.channel, runtimeVersion: source.runtimeVersion, publishedAt: source.createdAt, isRollback: false };
        if (!command.small) for (let index = 0; index < 4; index++) this.ctx.storage.transactionSync(() => this.auto.observe({ ...observation, installationHash: "healthy_" + index, events: [{ type: "launch_confirmed", observedAt: now }] }, now));
        const events = command.small ? [{ type: "activation_requested", observedAt: source.createdAt }, { type: "rolled_back", observedAt: now, stage: "launch", code: "UNCONFIRMED_LAUNCH" }] : [{ type: "failed", observedAt: now, stage: "launch", code: "UNCONFIRMED_LAUNCH" }];
        const result = this.ctx.storage.transactionSync(() => this.auto.observe({ ...observation, installationHash: "anonymous_installation", events }, now));
        return Response.json(this.auto.get("owner_a", appId).decisions.find(value => value.id === result.decisionId));
      }
      if (command.op === "report") return Response.json(this.ctx.storage.transactionSync(() => this.auto.observe(command.input, now)));
      if (command.op === "get") return Response.json(this.auto.get("owner_a", command.appId));
      if (command.op === "disable") {
        const policy = this.auto.get("owner_a", command.appId).policy!;
        const { appId: _, version, updatedAt: __, ...settings } = policy;
        return Response.json(this.auto.save("owner_a", command.appId, { ...settings, enabled: false, expectedVersion: version }, now));
      }
      if (command.op === "execute") {
        const plain = createD1ImportStore(this.env.FLORA_DB, config, () => {});
        const result = await executeAutoRollback({
          autoRollback: this.auto, decisionId: command.id, now: () => now,
          readReceipt: async claim => {
            if (command.receiptUnavailable) throw new Error("SYNTHETIC_READ_UNAVAILABLE");
            const receipt = await plain.operations!.getOTADeploymentForRequest(claim.appId, claim.requestKey);
            if (receipt && command.receiptScopeMismatch) return { ...receipt, runtimeVersion: "unrelated-runtime" };
            return receipt;
          },
          isHealthy: () => command.unhealthy !== true,
          createOperations: (claim, guard) => {
            let changed = false;
            const store = createD1OperationsStore(this.env.FLORA_DB, config.ownerId, plain.applications!, async () => guard(), guard);
            const wrapped = new Proxy(store, { get: (target, key) => {
              if (key === "getOTADeployment") return async (...args: Parameters<OperationsStore["getOTADeployment"]>) => {
                const deployment = await target.getOTADeployment(...args);
                if ((command.recoverDuringRead || command.reenterDuringRead || command.capacityDuringRead) && !changed) {
                  changed = true;
                  const observation = { ownerId: claim.ownerId, appId: claim.appId, deploymentId: claim.sourceDeploymentId, platform: claim.platform, channel: claim.channel, runtimeVersion: claim.runtimeVersion, publishedAt: claim.publishedAt, isRollback: false, installationHash: "anonymous_installation" };
                  if (command.capacityDuringRead) this.ctx.storage.sql.exec("UPDATE flora_auto_rollback_meta SET value=20000 WHERE key='installations'");
                  this.ctx.storage.transactionSync(() => this.auto.observe({ ...observation, ...(command.capacityDuringRead ? { installationHash: "healthy_0" } : {}), events: [{ type: "launch_confirmed", observedAt: now + 1 }] }, now));
                  if (command.reenterDuringRead) this.ctx.storage.transactionSync(() => this.auto.observe({ ...observation, events: [{ type: "activation_requested", observedAt: now + 2 }, { type: "rolled_back", observedAt: now + 3, stage: "launch", code: "UNCONFIRMED_LAUNCH" }] }, now));
                }
                if (command.disableDuringRead && !changed) {
                  changed = true;
                  const policy = this.auto.get(claim.ownerId, claim.appId).policy!;
                  const { appId: _, version, updatedAt: __, ...settings } = policy;
                  this.auto.save(claim.ownerId, claim.appId, { ...settings, enabled: false, expectedVersion: version }, now);
                }
                if (deployment?.id === claim.sourceDeploymentId && command.sourceScopeMismatch) return { ...deployment, channel: "unrelated" };
                if (deployment?.id === claim.sourceDeploymentId && command.sourceIsRollback) return { ...deployment, rollback: { fromDeploymentId: claim.sourceDeploymentId, targetDeploymentId: claim.targetDeploymentId, reason: "Prior rollback", requestedAt: now } };
                return deployment;
              };
              if (key === "saveOTARollback") return async (...args: Parameters<OperationsStore["saveOTARollback"]>) => {
                if (command.disableBeforeUncertainWrite) {
                  const policy = this.auto.get(claim.ownerId, claim.appId).policy!;
                  const { appId: _, version, updatedAt: __, ...settings } = policy;
                  this.auto.save(claim.ownerId, claim.appId, { ...settings, enabled: false, expectedVersion: version }, now);
                  throw new Error("SYNTHETIC_UNCERTAIN_WRITE_AFTER_DISABLE");
                }
                if (command.unavailableBeforeCommit) throw new Error("SYNTHETIC_NETWORK_UNAVAILABLE");
                const saved = await target.saveOTARollback(...args);
                if (command.throwAfterCommit) throw new Error("SYNTHETIC_LOST_COMMIT_RESPONSE");
                return saved;
              };
              const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
            } });
            return { store: wrapped, operations: createOperationsService({ applications: plain.applications!, operations: wrapped }, undefined, () => now, { publicOrigin: config.origin }) };
          },
        });
        return Response.json(result);
      }
      return new Response(null, { status: 404 });
    } catch (error) { return Response.json({ code: error instanceof HttpFailure ? error.code : "INVALID_INPUT" }, { status: error instanceof HttpFailure ? error.status : 400 }); }
  }
}
export default { async fetch(request: BindingRequest, env: Env) { return env.AUTO.get(env.AUTO.idFromName("test")).fetch(request); } };
