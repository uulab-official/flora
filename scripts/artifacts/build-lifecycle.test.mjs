import test from "node:test";
import assert from "node:assert/strict";
import { nextBuildState, isTerminalBuildState } from "./build-lifecycle.mjs";
const scope = {appId:"app-one",jobId:"job-one"};
const key = "a".repeat(32);
const start = { ...scope, status:"unconfigured",version:0 };
const step = (state,status,more={}) => nextBuildState(state,{status,idempotencyKey:key,...more},scope);
test("state machine rejects unverified success and invalid shortcuts",()=>{
 assert.throws(()=>step(start,"succeeded"),/BUILD_TRANSITION_DENIED/);
 const authorized=step(start,"authorized"), queued=step(authorized,"queued"), running=step(queued,"running");
 assert.throws(()=>step(running,"succeeded"),/BUILD_ARTIFACT_NOT_VERIFIED/);
 assert.throws(()=>step(running,"succeeded",{artifactIntegrityVerified:true}),/BUILD_EXECUTION_NOT_VERIFIED/);
 const done=step(running,"succeeded",{artifactIntegrityVerified:true,executionVerified:true});
 assert.equal(done.version,4);
 assert.equal(done.signatureVerified,false);
 assert.equal(done.installVerified,false);
 assert.equal(isTerminalBuildState(done.status),true);
 assert.throws(()=>step(done,"running"),/BUILD_TRANSITION_DENIED/);
});
test("scope validation, cancellation and uncertain outcome",()=>{
 const authorized=step(start,"authorized"),queued=step(authorized,"queued");
 assert.throws(()=>nextBuildState(queued,{status:"running",idempotencyKey:key},{appId:"another",jobId:"job-one"}),/BUILD_SCOPE_MISMATCH/);
 const uncertain=step(queued,"unknown");
 const recovered=step(uncertain,"running");
 const cancelled=step(recovered,"cancelled");
 assert.equal(isTerminalBuildState(cancelled.status),true);
 assert.equal(cancelled.artifactIntegrityVerified,false);
 assert.throws(()=>nextBuildState(queued,{status:"running",idempotencyKey:"bad"},scope),/BUILD_IDEMPOTENCY_REQUIRED/);
});
