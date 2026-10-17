import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, realpath, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import * as module from "../dist/index.js";
import {createGitHubSourceProvider} from "../dist/index.js";
import type {AutomationJob} from "@app-ops/dogfood";
const api = module as unknown as {verifySourceCheckout(job:unknown,path:string,signal:AbortSignal):Promise<{root:string;sourceDigest:string}>};
const config={schemaVersion:1,bundler:"metro",entryFile:"index.js",toolchain:{nodeVersion:"24.19.0",packageManager:{name:"npm",version:"11.11.1"}},runtimeVersion:"native-1",platforms:["ios"],updatesUrl:"https://updates.example.test/updates/app_one"};
async function repository(t:test.TestContext){const root=await mkdtemp(join(tmpdir(),"flora-git-"));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(join(root,"index.js"),"globalThis.one=1;\n");await writeFile(join(root,"flora.config.json"),JSON.stringify({schemaVersion:1,ota:{runtimeVersion:config.runtimeVersion,platforms:config.platforms,url:config.updatesUrl},export:{bundler:config.bundler,entryFile:config.entryFile,nodeVersion:config.toolchain.nodeVersion,packageManager:config.toolchain.packageManager}}));for(const args of [["init","-q"],["add","."],["-c","user.email=fixture@example.invalid","-c","user.name=Fixture","commit","-qm","fixture"]])execFileSync("git",args,{cwd:root,env:{PATH:"/usr/bin:/bin",GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null"}});return {root,sha:execFileSync("git",["rev-parse","HEAD"],{cwd:root}).toString().trim()};}
test("checkout provenance binds exact Git HEAD, clean tracked bytes and checked-in config",async t=>{const {root,sha}=await repository(t);const source=await api.verifySourceCheckout({commitSha:sha,rootDirectory:".",config},root,new AbortController().signal);assert.equal(source.root,await realpath(root));assert.match(source.sourceDigest,/^[a-f0-9]{64}$/);await writeFile(join(root,"index.js"),"changed");await assert.rejects(api.verifySourceCheckout({commitSha:sha,rootDirectory:".",config},root,new AbortController().signal));});
test("another app commit or runtime snapshot cannot be substituted",async t=>{const {root,sha}=await repository(t);await assert.rejects(api.verifySourceCheckout({commitSha:"a".repeat(40),rootDirectory:".",config},root,new AbortController().signal));await assert.rejects(api.verifySourceCheckout({commitSha:sha,rootDirectory:".",config:{...config,runtimeVersion:"different"}},root,new AbortController().signal));});
test("GitHub source refuses arbitrary origins and oversized tracked trees before Git download",async t=>{
 const root=await mkdtemp(join(tmpdir(),"flora-source-preflight-"));t.after(()=>rm(root,{recursive:true,force:true}));let calls=0;const provider=createGitHubSourceProvider({fetch:async(input,options)=>{calls++;assert.equal(input,"https://api.github.com/repos/example/app/git/trees/"+"a".repeat(40)+"?recursive=1");assert.equal(options!.redirect,"error");return Response.json({truncated:false,tree:[{type:"blob",mode:"100644",size:65*1024*1024}]});}}),job={commitSha:"a".repeat(40),connection:{owner:"example",repository:"app"}} as AutomationJob,grant={url:"https://api.github.com/repos/example/app/tarball/"+job.commitSha,token:"synthetic_source",commitSha:job.commitSha,expiresAt:Date.now()+120000,maxBytes:64*1024*1024};
 await assert.rejects(provider.checkout(job,{...grant,url:"http://127.0.0.1/private"},root,new AbortController().signal),/SOURCE_UNAVAILABLE/);assert.equal(calls,0);await assert.rejects(provider.checkout(job,grant,root,new AbortController().signal),/SOURCE_UNAVAILABLE/);assert.equal(calls,1);await assert.rejects(lstat(join(root,".git")));
});
test("GitHub source admits legacy and stateless bearer tokens but rejects injection before provider or Git access",async t=>{
 const root=await mkdtemp(join(tmpdir(),"flora-source-tokens-"));t.after(()=>rm(root,{recursive:true,force:true}));
 let calls=0,currentToken="";const provider=createGitHubSourceProvider({fetch:async(_input,options)=>{calls++;assert.equal(new Headers(options!.headers).get("Authorization"),"Bearer "+currentToken);return Response.json({truncated:true,tree:[]});}});
 const job={commitSha:"a".repeat(40),connection:{owner:"example",repository:"app"}} as AutomationJob,grant={url:"https://api.github.com/repos/example/app/tarball/"+job.commitSha,token:"",commitSha:job.commitSha,expiresAt:Date.now()+120000,maxBytes:64*1024*1024};
 const stateless="ghs_5283312_eyJhbGciOiJSUzI1NiJ9."+"syntheticpayload".repeat(60)+"."+"syntheticsignature".repeat(20);assert.ok(stateless.length>512);
 for(const token of ["ghs_legacy1234567890",stateless,"opaque._~+/-==","a".repeat(4096)]){currentToken=token;const before=calls;await assert.rejects(provider.checkout(job,{...grant,token},root,new AbortController().signal),/SOURCE_UNAVAILABLE/);assert.equal(calls,before+1,"valid token must reach bounded GitHub tree preflight");}
 const before=calls;for(const token of ["","ghs space","ghs\r\nX-Injected: yes","ghs\tvalue","a".repeat(4097)])await assert.rejects(provider.checkout(job,{...grant,token},root,new AbortController().signal),/SOURCE_UNAVAILABLE/);
 assert.equal(calls,before);await assert.rejects(lstat(join(root,".git")));
});
