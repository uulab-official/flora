import test from "node:test";
import assert from "node:assert/strict";
import { BuildJobLedger } from "./build-job-ledger.mjs";

const scope={appId:"app-a",jobId:"job-1"};
const key="a".repeat(32);
test("duplicate transition returns original receipt without applying twice",async()=>{
 const ledger=new BuildJobLedger(); ledger.create({...scope,status:"unconfigured",version:0});
 const args={scope,expectedVersion:0,event:{status:"authorized",idempotencyKey:key}};
 const first=await ledger.transition(args);
 const replay=await ledger.transition(args);
 assert.equal(first.version,1);
 assert.equal(replay.version,1);
 assert.equal(replay.replayed,true);
 assert.equal(ledger.get(scope).version,1);
 await assert.rejects(ledger.transition({...args,event:{status:"queued",idempotencyKey:key}}),/BUILD_IDEMPOTENCY_CONFLICT/);
});
test("concurrent version conflict, cross-app separation, and terminal state",async()=>{
 const ledger=new BuildJobLedger(); ledger.create({...scope,status:"unconfigured",version:0});
 ledger.create({appId:"app-b",jobId:"job-1",status:"unconfigured",version:0});
 const attempts=await Promise.allSettled([ledger.transition({scope,expectedVersion:0,event:{status:"authorized",idempotencyKey:"b".repeat(32)}}),ledger.transition({scope,expectedVersion:0,event:{status:"authorized",idempotencyKey:"c".repeat(32)}})]);
 assert.equal(attempts.filter(x=>x.status==="fulfilled").length,1);
 assert.match(attempts.find(x=>x.status==="rejected").reason.message,/BUILD_VERSION_CONFLICT/);
 assert.equal(ledger.get({appId:"app-b",jobId:"job-1"}).version,0);
 await assert.rejects(ledger.transition({scope,expectedVersion:1,event:{status:"succeeded",idempotencyKey:"d".repeat(32)}}),/BUILD_TRANSITION_DENIED/);
});
