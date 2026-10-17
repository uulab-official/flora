import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { UsageCache } from "../dist/usage-cache.js";

test("usage cache preserves last measurements without inventing zero, accepts corrections and isolates configured account", () => {
  const db = new DatabaseSync(":memory:");
  const storage = { sql: { exec(query: string, ...args: unknown[]) { const stmt = db.prepare(query); const rows = stmt.columns().length ? stmt.all(...args as any[]) : (stmt.run(...args as any[]), []); return {toArray:()=>rows}; } } };
  const cache = new UsageCache(storage as any), now = Date.UTC(2026,9,15,1), account = "a".repeat(32);
  assert.equal(cache.snapshot(account,now).status,"pending");
  assert.equal(cache.snapshot(undefined,now).status,"unconfigured");
  assert.equal(cache.snapshot(account,now).rowsRead,null);
  const input = {day:"2026-10-15",observedAt:now,rowsRead:120000,rowsWritten:14000};
  cache.record(account,input,now);
  assert.equal(cache.snapshot(account,now).status,"ready");
  assert.equal(cache.snapshot(account,now).rowsRead,120000);
  assert.equal(cache.snapshot("b".repeat(32),now).rowsRead,null);
  assert.equal(cache.snapshot(account,now+600001).status,"stale");
  assert.equal(cache.snapshot(account,now+86400000).status,"stale");
  assert.equal(cache.snapshot(account,now+86400000).day,"2026-10-15");
  // Adaptive provider metrics may correct an earlier estimate downwards.
  cache.record(account,{...input,observedAt:now+601000,rowsRead:119900},now+601000);
  assert.equal(cache.snapshot(account,now+601000).rowsRead,119900);
  assert.throws(()=>cache.record(account,input,now+601001));
  for(const invalid of [{...input,day:"2026-10-14"},{...input,observedAt:now+1},{...input,rowsRead:-1},{...input,rowsRead:null},{...input,rowsWritten:0.5},{...input,accountId:account},{...input,url:"https://bad.invalid"}]) assert.throws(()=>cache.record(account,invalid,now));
  assert.equal(cache.snapshot(account,now+601000).rowsRead,119900);
  db.close();
});
