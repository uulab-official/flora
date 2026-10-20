import test from 'node:test';
import assert from 'node:assert/strict';
import {createOrgFixture} from './org-fixtures.ts';
import {createTestRuntime} from './runtime.ts';

test('organization accepts existing deployment identifiers at the full legacy boundary',async t=>{
 const ownerId='.'+'o'.repeat(255),dbIdentity=':'+'d'.repeat(255);
 const h=await createOrgFixture(t,{FLORA_OWNER_ID:ownerId,FLORA_DB_IDENTITY:dbIdentity});
 const before=await h.snapshot();const response=await h.control({action:'bootstrap'});assert.equal(response.status,200);const state=await response.json()as any;assert.equal(state.ownerId,ownerId);assert.equal(state.dbIdentity,dbIdentity);assert.deepEqual(await h.snapshot(),before);
});
test('Runner gate accepts legacy storage identifiers without admitting invalid identifiers',async t=>{
 const runtime=await createTestRuntime({entrypoint:new URL('./fixtures/runtime-entry.ts',import.meta.url)});t.after(()=>runtime.dispose());const {RunnerGate}=await import('../dist/org/runner-gate.js');
 assert.doesNotThrow(()=>new RunnerGate(runtime.d1 as any,':'+ 'o'.repeat(255)));
 for(const invalid of ['', 'o'.repeat(257),'with/slash','with space','with\ncontrol'])assert.throws(()=>new RunnerGate(runtime.d1 as any,invalid));
});
