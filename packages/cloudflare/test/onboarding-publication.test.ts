import test from "node:test";
import assert from "node:assert/strict";
const path=new URL("../public/onboarding-model.js",import.meta.url).href;
const target={appId:"app_a",commitSha:"a".repeat(40),channel:"preview",runtimeVersion:"native-1",platforms:["ios","android"]};
const iosId="11111111-1111-4111-8111-111111111111",androidId="22222222-2222-4222-8222-222222222222";
const jobs=[{...target,id:"automation_ios",platform:"ios",state:"succeeded",deploymentId:iosId},{...target,id:"automation_android",platform:"android",state:"succeeded",deploymentId:androidId}];
const publication=(platform:string,id:string)=>({appId:"app_a",deploymentId:id,deployment:{id,platform,channel:"preview",runtimeVersion:"native-1",commitSha:"a".repeat(40),createdAt:1}});
test("only_ios_is_partial_for_both_and_every_selected_platform_needs_its_deployment",async()=>{
 const {evaluatePublications}=await import(path);
 assert.equal(evaluatePublications(target,jobs.slice(0,1),[publication("ios",iosId)]).status,"partial");
 assert.equal(evaluatePublications(target,jobs,[publication("ios",iosId),publication("android",androidId)]).status,"published");
 assert.equal(evaluatePublications(target,jobs,[]).status,"waiting");
});
test("old_sha_other_app_channel_runtime_or_missing_deployment_never_completes",async()=>{
 const {evaluatePublications}=await import(path),good=publication("ios",iosId);
 for(const bad of [{...good,appId:"app_b"},{...good,deploymentId:androidId},{...good,deployment:{...good.deployment,id:androidId}},{...good,deployment:{...good.deployment,commitSha:"b".repeat(40)}},{...good,deployment:{...good.deployment,channel:"production"}},{...good,deployment:{...good.deployment,runtimeVersion:"native-2"}}])assert.equal(evaluatePublications(target,jobs,[bad]).status,"waiting");
 for(const bad of [{...jobs[0],appId:"app_b"},{...jobs[0],state:"failed"},{...jobs[0],deploymentId:androidId}])assert.equal(evaluatePublications(target,[bad],[good]).status,"waiting");
});
test("ref_change_does_not_repin_target_and_invalid_targets_reject",async()=>{
 const {freezePublicationTarget}=await import(path),input={...target,platforms:[...target.platforms]},frozen=freezePublicationTarget(input);
 input.commitSha="b".repeat(40);input.platforms.pop();assert.equal(frozen.commitSha,"a".repeat(40));assert.deepEqual(frozen.platforms,["ios","android"]);assert.ok(Object.isFrozen(frozen)&&Object.isFrozen(frozen.platforms));
 for(const bad of [{...target,platforms:[]},{...target,platforms:["ios","ios"]},{...target,commitSha:"main"},{...target,token:"secret"},{...target,channel:123}])assert.throws(()=>freezePublicationTarget(bad));
});
