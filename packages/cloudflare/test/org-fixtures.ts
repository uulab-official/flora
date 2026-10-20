import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createTestRuntime} from './runtime.ts';
export const orgOrigin = 'https://organization.example.test';
export async function createOrgFixture(t:TestContext,bindings:Record<string,string>={}) {
  const runtime=await createTestRuntime({entrypoint:new URL('./fixtures/org-entry.ts',import.meta.url),durableObjects:{FLORA_AUTH:'OrgFixture'},bindings:{
    FLORA_ORIGIN:orgOrigin,FLORA_OWNER_ID:'synthetic-owner',FLORA_OWNER_EMAIL:'Owner@example.test',FLORA_DB_IDENTITY:'synthetic-db',...bindings}});
  t.after(()=>runtime.dispose());
  const control=(body:Record<string,unknown>)=>runtime.fetch(orgOrigin+'/__test/control',{method:'POST',body:JSON.stringify(body)});
  const sql=async(query:string,args:unknown[]=[])=>{const r=await control({action:'sql',sql:query,args});assert.equal(r.status,200);return await r.json() as any[];};
  const snapshot=async()=>{
    const tables=await sql("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'flora_org_%' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const rows:Record<string,unknown>={};
    for(const {name} of tables) {
      assert.match(name,/^[A-Za-z0-9_]+$/); rows[name]=await sql('SELECT * FROM "'+name+'" ORDER BY rowid');
    }
    return rows;
  };
  return {runtime,control,sql,snapshot};
}
