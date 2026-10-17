import type { DurableObjectNamespace, DurableObjectState, Request as BindingRequest } from "@cloudflare/workers-types";
import { AutoRollbackStore } from "../../dist/auto-rollback.js";
import { HttpFailure } from "../../dist/http.js";

interface Env { AUTO: DurableObjectNamespace }
export class AutoRollbackFixture {
  private store: AutoRollbackStore;
  constructor(private readonly ctx: DurableObjectState) { this.store = new AutoRollbackStore(ctx.storage); }
  async fetch(request: Request): Promise<Response> {
    const command = await request.json() as any;
    const now = command.now ?? 1_800_000_000_000;
    try {
      let result: unknown;
      switch (command.op) {
        case "get": result = this.store.get(command.ownerId ?? "owner_a", command.appId ?? "application_first"); break;
        case "save": result = this.store.save(command.ownerId ?? "owner_a", command.appId ?? "application_first", command.input, now); break;
        case "authorize": result = this.store.setInstallation(command.ownerId ?? "owner_a", command.appId ?? "application_first", command.input.hash, command.input.enabled, now); break;
        case "observe": result = this.ctx.storage.transactionSync(() => {
          const value = this.store.observe(command.input, now);
          if (command.abort) throw new HttpFailure(409, "TEST_ABORT");
          return value;
        }); break;
        case "pending": result = this.store.pending(now, command.limit); break;
        case "next": result = this.store.nextPendingAt(); break;
        case "claim": result = this.store.claim(command.id, now); break;
        case "current": result = this.store.isCurrent(command.id, command.claimVersion, now); break;
        case "invalidation": result = this.store.invalidationReason(command.id, command.claimVersion, now); break;
        case "succeed": result = this.store.succeed(command.id, command.deploymentId, now, command.claimVersion); break;
        case "fail": result = this.store.fail(command.id, command.code, now, command.claimVersion, command.retryAt); break;
        case "skip": result = this.store.skip(command.id, command.code, now, command.claimVersion); break;
        case "annotations": result = Object.fromEntries(this.store.annotations(command.ownerId ?? "owner_a", command.appId ?? "application_first", command.input)); break;
        case "restart": this.store = new AutoRollbackStore(this.ctx.storage); result = { ok: true }; break;
        case "debug": result = this.ctx.storage.sql.exec(command.sql).toArray(); break;
        default: return new Response(null, { status: 404 });
      }
      return Response.json(result);
    } catch (error) {
      return Response.json({ code: error instanceof HttpFailure ? error.code : "INVALID_INPUT" }, { status: error instanceof HttpFailure ? error.status : 400 });
    }
  }
}
export default { async fetch(request: BindingRequest, env: Env) { return env.AUTO.get(env.AUTO.idFromName("test")).fetch(request); } };
