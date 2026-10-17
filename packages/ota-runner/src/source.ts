import { lstat, open, realpath, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join, sep } from "node:path";
import { parseFloraConfig, automationDigest, isGitHubInstallationToken } from "@app-ops/dogfood";
import type { AutomationJob, AutomationSourceGrant } from "@app-ops/dogfood";
import { invariant, relativePath, sha256, readBoundedFile } from "./artifacts.js";
import { processEnvironment, trustedProcess } from "./process.js";
const gitEnvironment=()=>processEnvironment({GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_TERMINAL_PROMPT:"0",GIT_LFS_SKIP_SMUDGE:"1"});
const gitFlags=["-c","core.hooksPath=/dev/null","-c","protocol.file.allow=never","-c","protocol.ext.allow=never","-c","core.autocrlf=false","-c","http.followRedirects=false"];
async function git(root:string,args:string[],signal:AbortSignal,env=gitEnvironment()){return trustedProcess("git",[...gitFlags,...args],{cwd:root,env,signal,timeoutMs:300_000,maxBytes:2*1024*1024});}
export interface SourceCheckout {directory:string;root:string;sourceDigest:string}
export interface SourceProvider {checkout(job:AutomationJob,grant:AutomationSourceGrant,directory:string,signal:AbortSignal):Promise<SourceCheckout>}
/** Monitor the in-flight Git pack, rather than checking only after fetch completes.
 * A quota-backed work volume provides a hard disk cap; this polling guard can
 * overshoot by bytes written within one 100 ms interval. No credential logs. */
export async function withGitObjectBudget(directory:string,maxBytes:number,signal:AbortSignal,download:(signal:AbortSignal)=>Promise<void>):Promise<void>{
 const controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal]);let checking:Promise<void>|null=null,exceeded=false;
 async function check(){let bytes=0,count=0;async function walk(path:string):Promise<void>{let entries;try{entries=await readdir(path,{withFileTypes:true});}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}for(const entry of entries){invariant(++count<=12000,"SOURCE_UNAVAILABLE");const next=join(path,entry.name);let stat;try{stat=await lstat(next);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")continue;throw error;}invariant(!stat.isSymbolicLink(),"SOURCE_UNAVAILABLE");if(stat.isDirectory())await walk(next);else{invariant(stat.isFile(),"SOURCE_UNAVAILABLE");bytes+=stat.size;invariant(bytes<=maxBytes,"SOURCE_UNAVAILABLE");}}}await walk(join(directory,".git/objects"));}
 const tick=()=>{if(checking)return;checking=check().catch(()=>{exceeded=true;controller.abort();}).finally(()=>{checking=null;});};
 await check();const timer=setInterval(tick,100);
 try{await download(combined);await checking;await check();invariant(!exceeded,"SOURCE_UNAVAILABLE");}
 catch{throw new Error("SOURCE_UNAVAILABLE");}finally{clearInterval(timer);await checking;}
}
/** Verification never evaluates repository config or runs its hooks/scripts. */
export async function verifySourceCheckout(job:Pick<AutomationJob,"commitSha"|"rootDirectory"|"config">,directory:string,signal:AbortSignal):Promise<{root:string;sourceDigest:string}> {
 try {
  invariant(/^[a-f0-9]{40}$/.test(job.commitSha));invariant((await git(directory,["rev-parse","HEAD"],signal)).trim()===job.commitSha);
  invariant((await git(directory,["status","--porcelain=v1","--untracked-files=all"],signal)).trim()==="");
  const paths=(await git(directory,["ls-files","-z"],signal)).split("\0").filter(Boolean).sort();invariant(paths.length>0&&paths.length<=10000);
  const base=await realpath(directory),records:unknown[]=[];let size=0;
  for(const input of paths){const path=relativePath(input);let cursor=base;for(const part of path.split("/")){cursor=join(cursor,part);invariant(!(await lstat(cursor)).isSymbolicLink());}const file=await open(cursor,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await file.stat();invariant(stat.isFile()&&stat.nlink===1&&stat.size<=64*1024*1024);size+=stat.size;invariant(size<=64*1024*1024);const bytes=await file.readFile();invariant(bytes.length===stat.size);records.push([path,bytes.length,sha256(bytes)]);}finally{await file.close();}}
  const relative=job.rootDirectory==="."?"":relativePath(job.rootDirectory),root=await realpath(join(base,relative));invariant(root===base||root.startsWith(base+sep));
  const config=await readBoundedFile(root,"flora.config.json",131072);invariant(await automationDigest(parseFloraConfig(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(config))))===await automationDigest(job.config),"CONFIG_CHANGED");
  await readBoundedFile(root,job.config.entryFile,2*1024*1024);
  return {root,sourceDigest:sha256(JSON.stringify(records))};
 }catch(error){throw new Error(error instanceof Error&&error.message==="CONFIG_CHANGED"?"CONFIG_CHANGED":"SOURCE_UNAVAILABLE");}
}
export function createGitHubSourceProvider(options:{fetch?:typeof fetch}={}):SourceProvider {
 const request=options.fetch??fetch;
 return {async checkout(job,grant,directory,signal){
  try {
   invariant(grant.commitSha===job.commitSha&&grant.expiresAt>Date.now()&&grant.maxBytes>0&&grant.maxBytes<=64*1024*1024&&isGitHubInstallationToken(grant.token));
   const {owner,repository}=job.connection;invariant(/^[A-Za-z0-9-]{1,39}$/.test(owner)&&/^[A-Za-z0-9_.-]{1,100}$/.test(repository)&&![".",".."].includes(repository));
   const base=`https://api.github.com/repos/${owner}/${repository}`;
   invariant(grant.url===base+"/tarball/"+job.commitSha);
   // Bound the complete tracked tree before Git creates files; truncated/large trees fail closed.
   const response=await request(base+"/git/trees/"+job.commitSha+"?recursive=1",{redirect:"error",signal:AbortSignal.any([signal,AbortSignal.timeout(10000)]),headers:{Authorization:"Bearer "+grant.token,Accept:"application/vnd.github+json","User-Agent":"flora-ota-runner","X-GitHub-Api-Version":"2022-11-28"}});
   invariant(response.status===200&&response.body);const reader=response.body.getReader(),chunks:Uint8Array[]=[];let count=0;try{for(;;){const part=await reader.read();if(part.done)break;count+=part.value.length;invariant(count<=2*1024*1024);chunks.push(part.value);}}finally{void reader.cancel().catch(()=>{});}
   const tree=JSON.parse(Buffer.concat(chunks).toString("utf8")) as {truncated?:unknown;tree?:{type?:unknown;mode?:unknown;size?:unknown}[]};invariant(tree.truncated===false&&Array.isArray(tree.tree)&&tree.tree.length<=10000);
   let bytes=0;for(const item of tree.tree){invariant(item.type!=="commit"&&item.mode!=="120000");if(item.type==="blob"){invariant(typeof item.size==="number"&&Number.isSafeInteger(item.size)&&item.size>=0);bytes+=item.size;invariant(bytes<=grant.maxBytes);}}
   await git(directory,["init","--quiet"],signal);
   const environment={...gitEnvironment(),GIT_CONFIG_COUNT:"1",GIT_CONFIG_KEY_0:"http.https://github.com/.extraheader",GIT_CONFIG_VALUE_0:"AUTHORIZATION: basic "+Buffer.from("x-access-token:"+grant.token).toString("base64")};
   await withGitObjectBudget(directory,grant.maxBytes+8*1024*1024,signal,async fetchSignal=>{await git(directory,["fetch","--depth=1","--no-tags",`https://github.com/${owner}/${repository}.git`,job.commitSha],fetchSignal,environment);});
   await git(directory,["checkout","--detach","--force","FETCH_HEAD"],signal);
   return {directory,...await verifySourceCheckout(job,directory,signal)};
  }catch(error){throw new Error(error instanceof Error&&error.message==="CONFIG_CHANGED"?"CONFIG_CHANGED":"SOURCE_UNAVAILABLE");}
 }};
}
