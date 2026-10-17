import type { DurableObjectState } from "@cloudflare/workers-types";
import type { FloraEnv } from "../../src/contracts.js";
import hosted, { HostedFixtureAuth } from "./hosted-entry.js";

/** Local-only observation of D1 statements and bounded DO summary targets. */
export class OperationsHistoryFixture extends HostedFixtureAuth {
  private readonly stats: { queries: string[]; targets: unknown[][] };
  constructor(ctx: DurableObjectState, env: FloraEnv) {
    const stats = { queries: [] as string[], targets: [] as unknown[][] };
    const sql = ctx.storage.sql, exec = sql.exec.bind(sql);
    sql.exec = ((query: string, ...args: (string | number | null | ArrayBuffer)[]) => {
      if (query.includes("json_each(?) t")) stats.targets.push(JSON.parse(String(args[0])));
      return exec(query, ...args);
    }) as typeof sql.exec;
    const db = new Proxy(env.FLORA_DB, { get(target, key) {
      if (key === "prepare") return (query: string) => { stats.queries.push(query); return target.prepare(query); };
      const member = Reflect.get(target, key);
      return typeof member === "function" ? member.bind(target) : member;
    } });
    super(ctx, { ...env, FLORA_DB: db });
    this.stats = stats;
  }
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/__test/history-stats") {
      const result = Response.json(this.stats);
      this.stats.queries.length = 0; this.stats.targets.length = 0;
      return result;
    }
    return super.fetch(request);
  }
}
export default hosted;
