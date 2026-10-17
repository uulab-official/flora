import test from "node:test";
import assert from "node:assert/strict";
import { createTestRuntime } from "./runtime.ts";
async function fixture(t:test.TestContext){const r=await createTestRuntime({entrypoint:new URL("./fixtures/r2-assets-entry.mjs",import.meta.url),durableObjects:{TEST:"TestR2"},r2Buckets:{BUCKET:"test-assets"}});t.after(()=>r.dispose());const call=async(body:Record<string,unknown>)=>{const response=await r.fetch("https://flora.example.test",{method:"POST",body:JSON.stringify(body)});return {status:response.status,data:await response.json() as any};};return {r,call};}
test("R2 immutable conditional writes verify bytes, reuse matching objects and isolate owner/app scopes",async t=>{
 const {call}=await fixture(t),first=await call({action:"put"});assert.equal(first.status,200,JSON.stringify(first.data));assert.match(first.data.proof.objectKey,/^ota\/v1\/[a-f0-9]{64}\/app_isso\/[a-f0-9]{64}$/);
 const replay=await call({action:"put"});assert.equal(replay.status,200);assert.deepEqual(replay.data.proof,first.data.proof);
 assert.deepEqual((await call({action:"get",proof:first.data.proof})).data,{bytes:Array(8).fill(1)});
 assert.equal((await call({action:"get",failure:"infrequent",proof:first.data.proof})).status,503);
 assert.equal((await call({action:"get",appId:"app_promise",proof:first.data.proof})).status,503);assert.equal((await call({action:"get",owner:"other",proof:first.data.proof})).status,503);
 assert.equal((await call({action:"put",key:"other-key"})).status,503);const stats=(await call({action:"stats"})).data;assert.equal(stats.objectCount,1);assert.equal(stats.reservedBytes,8);
});
test("R2 failed and ambiguous operations consume durable budget; orphan retry verifies before returning proof",async t=>{
 const {call}=await fixture(t);assert.equal((await call({action:"put",failure:"after-put"})).status,503);let stats=(await call({action:"stats"})).data;assert.equal(stats.objectCount,1);assert.equal(stats.reservedBytes,8);assert.equal(stats.classA,4);assert.equal(stats.calls.put,1);
 const retry=await call({action:"put"});assert.equal(retry.status,200);assert.equal((await call({action:"get",failure:"get",proof:retry.data.proof})).status,503);stats=(await call({action:"stats"})).data;assert.equal(stats.calls.put,2);assert.equal(stats.calls.get,2);assert.equal(stats.classB,8);assert.ok(!JSON.stringify(stats).includes("private-canary"));
});
test("R2 budget is atomic across concurrent reservations and resets monthly operations without releasing storage",async t=>{
 const {call}=await fixture(t),results=await Promise.all(Array.from({length:6},(_,value)=>call({action:"put",value})));assert.equal(results.filter(result=>result.status===200).length,4);let stats=(await call({action:"stats"})).data;assert.equal(stats.objectCount,4);assert.equal(stats.reservedBytes,32);assert.equal(stats.calls.put,4);
 assert.equal((await call({action:"put",value:10})).status,503);assert.equal((await call({action:"put",value:10,now:Date.UTC(2026,10,1)})).status,503);stats=(await call({action:"stats",now:Date.UTC(2026,10,1)})).data;assert.equal(stats.objectCount,4);assert.equal(stats.reservedBytes,32);
});
test("R2 operation ceilings renew monthly, storage survives helper reconstruction, and unused credits are never restored",async t=>{
 const {call}=await fixture(t);const saved=await call({action:"put"});assert.equal(saved.status,200);
 const old=(await call({action:"stats"})).data;assert.equal(old.classA,4);assert.equal(old.objectCount,1);
 await call({action:"restart"});assert.equal((await call({action:"put"})).data.error,"R2_FREE_OPERATION_LIMIT");assert.equal((await call({action:"stats"})).data.calls.put,1);
 const next=Date.UTC(2026,10,1),retry=await call({action:"put",now:next});assert.equal(retry.status,200);assert.deepEqual(retry.data.proof,saved.data.proof);
 const current=(await call({action:"stats",now:next})).data;assert.equal(current.classA,4);assert.equal(current.classB,8);assert.equal(current.objectCount,1);assert.equal(current.reservedBytes,8);assert.equal(current.calls.put,2);
});
test("R2 rejects missing proof, corrupt object metadata/body and authority changes across asynchronous boundaries",async t=>{
 const r=await createTestRuntime({entrypoint:new URL("./fixtures/r2-assets-entry.mjs",import.meta.url),durableObjects:{TEST:"TestR2"},r2Buckets:{BUCKET:"test-assets"},bindings:{LARGE_QUOTA:true}});t.after(()=>r.dispose());
 const call=async(body:Record<string,unknown>)=>{const response=await r.fetch("https://flora.example.test",{method:"POST",body:JSON.stringify(body)});return {status:response.status,data:await response.json() as any};};
 const saved=await call({action:"put"});assert.equal(saved.status,200);const proof=saved.data.proof;
 const before=(await call({action:"stats"})).data.calls;assert.equal((await call({action:"get"})).status,503);assert.deepEqual((await call({action:"stats"})).data.calls,before);
 for(const failure of ["checksum","version","truncated","oversize","corrupt-body","missing","get-fence","body-fence"]){const result=await call({action:"get",failure,proof});assert.equal(result.status,503,failure);assert.ok(!JSON.stringify(result.data).includes("private-canary"));}
 assert.ok((await call({action:"stats"})).data.calls.cancel>=3,"metadata and authority rejection must cancel the unconsumed R2 body");
 assert.equal((await call({action:"put",value:2,failure:"sync-fence"})).data.error,"AUTHORITY_CHANGED");assert.equal((await call({action:"stats"})).data.calls.put,1);
 assert.equal((await call({action:"put",value:3,failure:"put-fence"})).data.error,"AUTHORITY_CHANGED");assert.equal((await call({action:"stats"})).data.calls.put,2);
 const recovered=await call({action:"put",value:3});assert.equal(recovered.status,200);assert.deepEqual((await call({action:"get",value:3,proof:recovered.data.proof})).data.bytes,Array(8).fill(3));
});
test("R2 reserves the new UTC month before a call when durable sync crosses the month boundary",async t=>{
 const {call}=await fixture(t),saved=await call({action:"put",failure:"sync-rollover"});assert.equal(saved.status,200);
 const old=(await call({action:"stats"})).data,next=(await call({action:"stats",now:Date.UTC(2026,10,1)})).data;
 assert.equal(old.classA,4);assert.equal(next.classA,4);assert.equal(next.calls.put,1);assert.equal(next.reservedBytes,8);assert.equal(next.objectCount,1);
});
test("R2 permits only two in-flight verified reads and releases admission after success or rejection",async t=>{
 const {call}=await fixture(t),saved=await call({action:"put"}),proof=saved.data.proof;
 await call({action:"hold"});const first=call({action:"get",proof}),second=call({action:"get",proof});
 for(let attempts=0;;attempts++){const stats=(await call({action:"stats"})).data;if(stats.held===2)break;assert.ok(attempts<100);await new Promise(resolve=>setTimeout(resolve,5));}
 const before=(await call({action:"stats"})).data.calls;assert.equal((await call({action:"get",proof})).data.error,"R2_BUSY");assert.deepEqual((await call({action:"stats"})).data.calls,before);
 await call({action:"release"});assert.equal((await first).status,200);assert.equal((await second).status,200);
 assert.equal((await call({action:"get",failure:"checksum",proof})).status,503);assert.equal((await call({action:"get",proof})).status,200);
});
