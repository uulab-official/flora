import type { DurableObjectState } from "@cloudflare/workers-types";

// Synthetic harness fixture, not an authentication class or Runner implementation.
export class TestSqliteObject {
  private readonly ctx: DurableObjectState;
  constructor(ctx: DurableObjectState) { this.ctx = ctx; }
  async fetch(): Promise<Response> {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS fixture (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)");
    const row = this.ctx.storage.sql.exec<{ value: number }>(
      "INSERT INTO fixture(id,value) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET value=value+1 RETURNING value",
    ).one();
    return new Response(String(row.value));
  }
}
export default { fetch() { return new Response("synthetic runtime"); } };
