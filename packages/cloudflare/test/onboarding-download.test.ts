import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
const path=new URL("../public/onboarding-download.js",import.meta.url).href;
const origin="https://flora.example.test",id="11111111-1111-4111-8111-111111111111",target={appId:"app_a",commitSha:"a".repeat(40),channel:"preview",runtimeVersion:"native-1",platforms:["ios","android"]};
const bytes=new TextEncoder().encode("bundle bytes, never executed"),digest=createHash("sha256").update(bytes).digest("hex"),url=origin+"/updates/app_a/assets/"+digest;
const manifest={id,runtimeVersion:"native-1",metadata:{channel:"preview",appid:"app_a"},extra:{flora:{appId:"app_a",platform:"ios",commitSha:"a".repeat(40)}},launchAsset:{hash:Buffer.from(digest,"hex").toString("base64url"),url}};
function fetcher(manifestValue:unknown=manifest,asset:BodyInit=bytes as BodyInit){const calls:{url:string;init:RequestInit}[]=[];return {calls,fetch:async(u:string,init:RequestInit)=>{calls.push({url:u,init});return new Response(calls.length===1?JSON.stringify(manifestValue):asset,{headers:{"Content-Type":calls.length===1?"application/expo+json":"application/javascript"}});}};}
test("download_is_bounded_and_not_device_evidence",async()=>{
 const {probeLaunchDownload}=await import(path),transport=fetcher();const result=await probeLaunchDownload(origin,target,"ios",id,{fetch:transport.fetch,subtle:crypto.subtle},new AbortController().signal);
 assert.deepEqual(result,{kind:"web-download-hash",deploymentId:id,launchHash:manifest.launchAsset.hash,bytes:bytes.length});assert.equal(transport.calls.length,2);
 for(const c of transport.calls){assert.equal(c.init.credentials,"omit");assert.equal(c.init.redirect,"error");assert.equal(c.init.method,"GET");}
 assert.equal(new Headers(transport.calls[0]!.init.headers).get("expo-runtime-version"),"native-1");
});
test("foreign_redirect_oversize_hash_and_network_failures_are_not_success_or_automatic_retry",async()=>{
 const {probeLaunchDownload}=await import(path);
 for(const altered of [{...manifest,id:"22222222-2222-4222-8222-222222222222"},{...manifest,launchAsset:{...manifest.launchAsset,url:"https://attacker.test/bundle"}},{...manifest,metadata:{...manifest.metadata,channel:"production"}},{...manifest,extra:{flora:{...manifest.extra.flora,appId:"app_b"}}}]){
  const f=fetcher(altered);await assert.rejects(probeLaunchDownload(origin,target,"ios",id,{fetch:f.fetch,subtle:crypto.subtle},new AbortController().signal));assert.equal(f.calls.length,1);
 }
 const truncated=fetcher(manifest,bytes.subarray(0,3) as BodyInit);await assert.rejects(probeLaunchDownload(origin,target,"ios",id,{fetch:truncated.fetch,subtle:crypto.subtle},new AbortController().signal),/DOWNLOAD_INTEGRITY_FAILED/);assert.equal(truncated.calls.length,2);
 const oversized=fetcher({...manifest,padding:"x".repeat(1048576)});await assert.rejects(probeLaunchDownload(origin,target,"ios",id,{fetch:oversized.fetch,subtle:crypto.subtle},new AbortController().signal),/DOWNLOAD_TOO_LARGE/);
 let attempts=0;await assert.rejects(probeLaunchDownload(origin,target,"ios",id,{fetch:async()=>{attempts++;throw Error("synthetic-private-error");},subtle:crypto.subtle},new AbortController().signal),e=>e instanceof Error&&!e.message.includes("synthetic-private-error"));assert.equal(attempts,1);
 const control=new AbortController();control.abort();const aborted=fetcher();await assert.rejects(probeLaunchDownload(origin,target,"ios",id,{fetch:aborted.fetch,subtle:crypto.subtle},control.signal));assert.equal(aborted.calls.length,0);
});
