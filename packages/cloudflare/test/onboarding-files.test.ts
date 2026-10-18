import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {parseFloraConfig} from "@app-ops/dogfood";
import {parseRunnerBinding} from "../../cli/dist/setup/contracts.js";
const {nativeConfiguration}=createRequire(import.meta.url)("../../ota-sdk/plugin/transforms.cjs");
const moduleURL=new URL("../public/onboarding-files.js",import.meta.url).href;
const certificate=readFileSync(new URL("../../ota-sdk/test/fixtures/plugin-public-cert.pem",import.meta.url),"utf8");
const input={appId:"app_a",origin:"https://flora.example.test",channel:"preview",runtimeVersion:"native-1",platforms:["ios","android"],bundler:"metro",entryFile:"index.js",nodeVersion:"24.19.0",packageManager:{name:"npm",version:"10.9.8"}};
const signing={appId:"app_a",keyId:"ota-key-1",certificate};
test("public_files_match_real_parsers_and_contain_no_secrets",async()=>{
 const {buildPublicFiles}=await import(moduleURL),files=buildPublicFiles(input,signing);
 const config=parseFloraConfig(JSON.parse(files.config));
 assert.equal(config.updatesUrl,"https://flora.example.test/updates/app_a");assert.deepEqual(config.platforms,["ios","android"]);
 assert.equal(nativeConfiguration({...JSON.parse(files.connection),disableExpoUpdates:true}).keyId,"ota-key-1");
 assert.deepEqual(Object.keys(JSON.parse(files.connection)).sort(),["appId","url","channel","runtimeVersion","certificate","keyId"].sort());
 for(const text of Object.values(files))assert.doesNotMatch(String(text),/PRIVATE KEY|runner_token|cookie/);
});
test("public_files_reject_wrong_app_missing_key_and_unsafe_draft_values",async()=>{
 const {buildPublicFiles}=await import(moduleURL);
 for(const bad of [{...input,token:"synthetic-secret"},{...input,origin:"http://flora.test"},{...input,entryFile:"../index.js"},{...input,nodeVersion:"24;sh"},{...input,platforms:["ios","ios"]},{...input,runtimeVersion:"r".repeat(129)},{...input,packageManager:{name:"npm",version:"10.9.8",token:"synthetic-secret"}}])assert.throws(()=>buildPublicFiles(bad,signing));
 for(const bad of [{...signing,appId:"app_b"},{...signing,keyId:""},{...signing,keyId:"invalid key"},{...signing,certificate:"-----BEGIN PRIVATE KEY-----"}])assert.throws(()=>buildPublicFiles(input,bad));
});
test("runner_binding_is_exactly_scoped_and_parser_compatible",async()=>{
 const {buildRunnerBinding}=await import(moduleURL),runner={id:"runner_11111111-1111-4111-8111-111111111111",appIds:["app_a"],revokedAt:null};
 assert.deepEqual(parseRunnerBinding(buildRunnerBinding(input.origin,input.appId,runner)),{schemaVersion:1,origin:input.origin,appId:"app_a",runnerId:runner.id});
 for(const bad of [{...runner,appIds:["app_b"]},{...runner,appIds:["app_a","app_b"]},{...runner,revokedAt:1}])assert.throws(()=>buildRunnerBinding(input.origin,input.appId,bad));
});
