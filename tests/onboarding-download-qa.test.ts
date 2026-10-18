import test from "node:test";
import assert from "node:assert/strict";
import {createHash,sign} from "node:crypto";
import {createManagedSigningKey} from "../packages/cloudflare/dist/managed-signing.js";
const moduleURL=new URL("../scripts/onboarding-download-qa.mjs",import.meta.url).href;
async function fixture(){
 const key=await createManagedSigningKey("app_qa",Date.now()),bytes=Buffer.from("real bounded fixture bytes"),digest=createHash("sha256").update(bytes).digest("hex"),origin="https://qa.example.com",id="11111111-1111-4111-8111-111111111111";
 const connection={appId:"app_qa",url:origin+"/updates/app_qa",channel:"qa",runtimeVersion:"1",certificate:key.certificate,keyId:key.keyId};
 const target={appId:"app_qa",commitSha:"a".repeat(40),channel:"qa",runtimeVersion:"1",platforms:["ios"],deployments:{ios:id}};
 const asset={url:connection.url+"/assets/"+digest,hash:Buffer.from(digest,"hex").toString("base64url"),key:"bundle",contentType:"application/javascript"};
 let manifest={id,runtimeVersion:"1",metadata:{channel:"qa"},extra:{flora:{appId:"app_qa",commitSha:target.commitSha,platform:"ios"}},launchAsset:asset,assets:[{...asset,key:"second"}]};let mode="ok",requests=0;
 const request=async(url:string,init:RequestInit)=>{requests++;assert.equal(init.method,"GET");assert.equal(init.credentials,"omit");assert.equal(init.redirect,"error");assert.ok(!new Headers(init.headers).has("authorization"));
 if(url===connection.url){const raw=Buffer.from(JSON.stringify(manifest)),signature=sign("RSA-SHA256",raw,key.privateKey).toString("base64");return new Response(raw,{headers:{"Content-Type":"application/json",...(mode==="unsigned"?{}:{"expo-signature":`sig="${mode==="bad-signature"?Buffer.alloc(256).toString("base64"):signature}", keyid="${mode==="wrong-key"?"other":key.keyId}", alg="rsa-v1_5-sha256"`})}});}
 if(mode==="network")throw Error("synthetic-private-network-error");if(mode==="oversize")return new Response(new Uint8Array(16777217));if(mode==="corrupt")return new Response("changed");return new Response(bytes);};
 return {connection,target,request,requests:()=>requests,setMode:(value:string)=>{mode=value;},setManifest:(v:typeof manifest)=>{manifest=v;},manifest};
}
test("download_qa_requires_expected_signer_and_all_bounded_assets",async()=>{
 const {verifyDownloads}=await import(moduleURL),f=await fixture(),result=await verifyDownloads(f.connection,f.target,{fetch:f.request});assert.equal(result.evidence,"signed-public-download");assert.equal(result.platforms.length,1);assert.equal(result.platforms[0].assetCount,2);assert.equal(f.requests(),3);assert.ok(!JSON.stringify(result).includes("PRIVATE KEY"));
 for(const mode of ["unsigned","wrong-key","bad-signature","network","oversize","corrupt"]){const g=await fixture();g.setMode(mode);await assert.rejects(verifyDownloads(g.connection,g.target,{fetch:g.request}));}
 const g=await fixture();g.setManifest({...g.manifest,extra:{flora:{...g.manifest.extra.flora,appId:"other_app"}}});await assert.rejects(verifyDownloads(g.connection,g.target,{fetch:g.request}));assert.equal(g.requests(),1);
 const h=await fixture();h.setManifest({...h.manifest,assets:Array.from({length:65},()=>h.manifest.launchAsset)});await assert.rejects(verifyDownloads(h.connection,h.target,{fetch:h.request}));assert.equal(h.requests(),1);
});
test("public_receipt_tool_rejects_credentials_and_unbounded_or_unknown_fields",async()=>{
 const url=new URL("../scripts/onboarding-qa.mjs",import.meta.url).href,{validateReceipts}=await import(url);
 const value={schemaVersion:1,evidence:"fixture",apps:[{appId:"app_qa",commitSha:"a".repeat(40),publications:[{platform:"ios",jobId:"automation_11111111-1111-4111-8111-111111111111",deploymentId:"11111111-1111-4111-8111-111111111111",assetHashes:["a".repeat(64)]}]}],preservation:{sourceHash:"b".repeat(64),unchanged:true},queries:{count:4,rowsRead:7,writes:0}};
 assert.deepEqual(validateReceipts(value),value);for(const bad of [{...value,token:"synthetic"},{...value,apps:[{...value.apps[0],cookie:"synthetic"}]},{...value,queries:{count:Infinity,rowsRead:1,writes:0}}])assert.throws(()=>validateReceipts(bad));
});
