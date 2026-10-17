import {spawn} from "node:child_process";
import {constants} from "node:fs";
import {lstat,mkdir,open,readFile,readdir,realpath,rename,statfs} from "node:fs/promises";
import {dirname,isAbsolute,join} from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {automationDigest,parseAutomationJob,parseAutomationLease,parseOTAAssetUpload} from "@app-ops/dogfood";
import type {AutomationJob,AutomationLease,OTAAssetUpload} from "@app-ops/dogfood";
import {invariant,MAX_ASSET_BYTES,sha256} from "./artifacts.js";

export interface GitHubAssetStorage {provider:"github-releases";repository:"uulab-official/flora-ota-assets";ghPath:string;cacheDirectory:string}
export interface GitHubAssetReference {schemaVersion:1;releaseId:number;assetId:number}
export interface AssetPublisherInput {origin:string;job:AutomationJob;lease:AutomationLease;upload:OTAAssetUpload;bytes:Uint8Array}
export type AssetPublisher=(input:AssetPublisherInput)=>Promise<GitHubAssetReference>;
interface APIReply {status:number;body:unknown;retryAfter?:string}
interface APIRequest {method:"GET"|"POST"|"PATCH";path:string;body?:unknown;file?:string;signal:AbortSignal}
interface PublisherOptions {request?:(input:APIRequest)=>Promise<APIReply>;signal?:AbortSignal;now?:()=>number;pause?:(ms:number,signal:AbortSignal)=>Promise<void>}
type Phase="new"|"creating"|"created"|"uploading"|"uploaded"|"publishing"|"published";
interface Journal {schemaVersion:1;tag:string;body:string;phase:Phase;releaseId:number|null;assetId:number|null;cooldownUntil:number}
const fail="ASSET_STORAGE_UNAVAILABLE",conflict="ASSET_STORAGE_CONFLICT",capacity=20*1024**3;
class RateLimited extends Error {constructor(){super("ASSET_STORAGE_RATE_LIMITED");}}
const canonical=(input:unknown):string=>input===null||typeof input!=="object"?JSON.stringify(input):Array.isArray(input)?"["+input.map(canonical).join(",")+"]":"{"+Object.keys(input).sort().map(key=>JSON.stringify(key)+":"+canonical((input as Record<string,unknown>)[key])).join(",")+"}";
const identifier=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0;
const object=(value:unknown):Record<string,unknown>=>{invariant(value&&typeof value==="object"&&!Array.isArray(value),fail);return value as Record<string,unknown>;};
async function privateEntry(path:string,directory=false){const s=await lstat(path);invariant(!s.isSymbolicLink()&&(directory?s.isDirectory():s.isFile()&&s.nlink===1)&&(!process.getuid||s.uid===process.getuid())&&(s.mode&0o077)===0,fail);return s;}
export async function validateGitHubAssetStorage(input:unknown):Promise<GitHubAssetStorage>{
 const v=object(input);invariant(Object.keys(v).length===4&&v.provider==="github-releases"&&v.repository==="uulab-official/flora-ota-assets"&&[v.ghPath,v.cacheDirectory].every(p=>typeof p==="string"&&isAbsolute(p)&&!/[\u0000-\u001f\u007f,]/.test(p)),"INVALID_RUNNER_CONFIG");
 const c=v as unknown as GitHubAssetStorage,s=await lstat(c.ghPath);
 invariant(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&(s.mode&0o022)===0&&(s.mode&0o111)!==0&&(!process.getuid||s.uid===process.getuid()||s.uid===0),"INVALID_RUNNER_CONFIG");
 await privateEntry(c.cacheDirectory,true);invariant(await realpath(c.cacheDirectory)===c.cacheDirectory,"INVALID_RUNNER_CONFIG");return {...c};
}
async function atomic(path:string,value:unknown){const temporary=path+"."+randomUUID()+".tmp",f=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await f.writeFile(canonical(value)+"\n");await f.sync();}finally{await f.close();}await rename(temporary,path);const directory=await open(dirname(path),constants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}}
async function diskBudget(root:string,additional:number){const stat=await statfs(root,{bigint:true});invariant(stat.bavail*stat.bsize>=2n*1024n**3n+BigInt(additional),"ASSET_STORAGE_CAPACITY");let bytes=0,entries=0;
 for(const child of await readdir(root,{withFileTypes:true})){invariant(++entries<=100000,"ASSET_STORAGE_CAPACITY");const path=join(root,child.name);if(child.isDirectory()){await privateEntry(path,true);for(const name of await readdir(path)){invariant(++entries<=100000,"ASSET_STORAGE_CAPACITY");bytes+=(await privateEntry(join(path,name))).size;}}else bytes+=(await privateEntry(path)).size;invariant(bytes+additional<=capacity,"ASSET_STORAGE_CAPACITY");}
}
async function ghRequest(config:GitHubAssetStorage,input:APIRequest):Promise<APIReply>{
 const args=["api","--hostname","github.com","--include","--method",input.method,input.path,"--header","Accept: application/vnd.github+json","--header","X-GitHub-Api-Version: 2026-03-10"];
 if(input.file)args.push("--header","Content-Type: application/octet-stream","--input",input.file);else if(input.body!==undefined)args.push("--input","-");
 // Existing host gh login only. No GH_TOKEN/GITHUB_TOKEN or source/Runner token
 // is copied to the process or to Docker. Never retain gh stderr/API bodies.
 const env={HOME:process.env.HOME??"",PATH:process.env.PATH??"/usr/bin:/bin",LANG:"C.UTF-8",GH_HOST:"github.com",GH_PROMPT_DISABLED:"1",GH_PAGER:"cat",NO_COLOR:"1"};
 return new Promise((resolve,reject)=>{if(input.signal.aborted){reject(Error("LEASE_EXPIRED"));return;}let child:ReturnType<typeof spawn>,failed=false,size=0;const chunks:Buffer[]=[];
  try{child=spawn(config.ghPath,args,{env,stdio:["pipe","pipe","pipe"],detached:process.platform!=="win32"});}catch{reject(Error(fail));return;}
  const stop=()=>{failed=true;try{if(child.pid&&process.platform!=="win32")process.kill(-child.pid,"SIGKILL");else child.kill("SIGKILL");}catch{}};
  const timer=setTimeout(stop,30000);input.signal.addEventListener("abort",stop,{once:true});
  const append=(chunk:Buffer,keep:boolean)=>{size+=chunk.length;if(size>1048576){stop();return;}if(keep)chunks.push(chunk);};child.stdout!.on("data",chunk=>append(chunk,true));child.stderr!.on("data",chunk=>append(chunk,false));child.once("error",stop);
  child.once("close",code=>{clearTimeout(timer);input.signal.removeEventListener("abort",stop);if(input.signal.aborted)return reject(Error("LEASE_EXPIRED"));if(failed)return reject(Error(fail));
   const stdout=Buffer.concat(chunks).toString("utf8"),match=/^HTTP\/[\d.]+ ([1-5][0-9]{2})[^\r\n]*\r?\n/.exec(stdout),separator=stdout.search(/\r?\n\r?\n/);
   if(!match||separator<0||Number(match[1])<400&&code!==0)return reject(Error(fail));
   try{const body=JSON.parse(stdout.slice(separator).trim()),retryAfter=/^retry-after:\s*([^\r\n]*)$/im.exec(stdout.slice(0,separator))?.[1];resolve({status:Number(match[1]),body,...(retryAfter?{retryAfter}:{})});}catch{reject(Error(fail));}
  });child.stdin!.on("error",()=>{});child.stdin!.end(input.body===undefined?"":canonical(input.body));if(input.signal.aborted)stop();
 });
}
const wait=(ms:number,signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{const timer=setTimeout(done,ms);function done(){signal.removeEventListener("abort",stop);resolve();}function stop(){clearTimeout(timer);signal.removeEventListener("abort",stop);reject(Error("LEASE_EXPIRED"));}signal.addEventListener("abort",stop,{once:true});if(signal.aborted)stop();});

/** Host-only, immutable per-attempt storage; every uncertain mutation is read
 * back, never blindly replayed. The private journal survives controller restart.
 */
export function createGitHubReleasePublisher(config:GitHubAssetStorage,options:PublisherOptions={}):AssetPublisher {
 const specification={...config},request=options.request??(input=>ghRequest(specification,input)),now=options.now??Date.now,pause=options.pause??wait;let lastMutation=-Infinity,serial=Promise.resolve();
 return async input=>{
  input=structuredClone(input);
  let releaseLock!:()=>void;const previous=serial;serial=new Promise<void>(resolve=>{releaseLock=resolve;});await previous;
  try{
   const c=await validateGitHubAssetStorage(specification),job=parseAutomationJob(input.job),lease=parseAutomationLease(input.lease),upload=parseOTAAssetUpload(input.upload),bytes=new Uint8Array(input.bytes);
   const origin=new URL(input.origin);invariant(origin.origin===input.origin&&!origin.username&&!origin.password&&["https:","http:"].includes(origin.protocol),conflict);
   invariant(job.id===lease.jobId&&job.appId===lease.appId&&job.state==="leased"&&job.lease&&["jobId","appId","attemptId","runnerId","credentialEpoch","fence"].every(k=>job.lease![k as keyof AutomationLease]===lease[k as keyof AutomationLease]),conflict);
   invariant(await automationDigest(job.config)===job.configDigest&&await automationDigest(job.config.toolchain)===job.toolchainDigest,conflict);
   invariant(bytes.length>0&&bytes.length<=MAX_ASSET_BYTES,conflict);
   const digest=sha256(bytes),bodyObject={schemaVersion:1,origin:input.origin,appId:job.appId,jobId:job.id,attemptId:lease.attemptId,commitSha:job.commitSha,platform:job.platform,asset:{digest,hash:createHash("sha256").update(bytes).digest("base64url"),...upload,size:bytes.length}},body=canonical(bodyObject),tag="flora-ota-v1-"+await automationDigest(bodyObject),name="flora-"+digest+".bin",root=join(c.cacheDirectory,tag),file=join(root,"asset.bin"),journalPath=join(root,"state.json");
   const remaining=lease.expiresAt-now();invariant(remaining>0,"LEASE_EXPIRED");const signal=AbortSignal.any([AbortSignal.timeout(Math.min(remaining,120000)),...(options.signal?[options.signal]:[])]);
   const live=()=>invariant(!signal.aborted&&now()<lease.expiresAt,"LEASE_EXPIRED");live();
   const cooldownPath=join(c.cacheDirectory,"provider-cooldown.json");let cooldownUntil=0;
   try{const s=await privateEntry(cooldownPath);invariant(s.size<=1024,conflict);const record=object(JSON.parse(await readFile(cooldownPath,"utf8")));invariant(Object.keys(record).length===3&&record.schemaVersion===1&&record.repository===c.repository&&Number.isSafeInteger(record.until)&&Number(record.until)>=0,conflict);cooldownUntil=Number(record.until);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
   if(cooldownUntil>now())throw new RateLimited();
   const call=async(method:APIRequest["method"],path:string,payload?:unknown,assetFile?:string)=>{live();if(cooldownUntil>now())throw new RateLimited();if(method!=="GET"){const delay=Math.max(0,1050-(now()-lastMutation));if(delay)await pause(delay,signal);live();lastMutation=now();}for(let attempt=0;;attempt++){const response=await request({method,path,...(payload===undefined?{}:{body:payload}),...(assetFile?{file:assetFile}:{}),signal});invariant(Number.isInteger(response.status)&&response.status>=100&&response.status<=599,fail);
    if(response.status===403||response.status===429){const seconds=/^[0-9]{1,10}$/.test(response.retryAfter??"")?Number(response.retryAfter):Math.max(0,(Date.parse(response.retryAfter??"")-now())/1000);cooldownUntil=now()+Math.max(60,Number.isFinite(seconds)?seconds:60)*1000;await atomic(cooldownPath,{schemaVersion:1,repository:c.repository,until:cooldownUntil});state={...state,cooldownUntil};await atomic(journalPath,state);throw new RateLimited();}
    live();if(method!=="GET"||attempt>=2||response.status!==503||!/^\d$/.test(response.retryAfter??"")||Number(response.retryAfter)>5)return response;await pause(Number(response.retryAfter)*1000,signal);live();}};
   let state:Journal;
   try{await mkdir(root,{mode:0o700});await diskBudget(c.cacheDirectory,bytes.length+16384);const f=await open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}state={schemaVersion:1,tag,body,phase:"new",releaseId:null,assetId:null,cooldownUntil:0};await atomic(journalPath,state);}
   catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;await privateEntry(root,true);const stat=await privateEntry(file);invariant(stat.size===bytes.length&&sha256(await readFile(file))===digest,conflict);const s=await privateEntry(journalPath);invariant(s.size<=16384,conflict);state=JSON.parse(await readFile(journalPath,"utf8")) as Journal;invariant(Object.keys(state).length===7&&state.schemaVersion===1&&state.tag===tag&&state.body===body&&["new","creating","created","uploading","uploaded","publishing","published"].includes(state.phase)&&(state.releaseId===null||identifier(state.releaseId))&&(state.assetId===null||identifier(state.assetId))&&Number.isSafeInteger(state.cooldownUntil)&&state.cooldownUntil>=0,conflict);if(state.cooldownUntil>now())throw new RateLimited();}
   const save=async(phase:Phase,releaseId=state.releaseId,assetId=state.assetId)=>{state={...state,phase,releaseId,assetId};await atomic(journalPath,state);live();};
   const base="repos/"+c.repository;
   const repo=await call("GET",base);invariant(repo.status===200,fail);const repository=object(repo.body);invariant(repository.private===true&&repository.full_name===c.repository&&typeof repository.default_branch==="string",conflict);
   const validateRelease=(raw:unknown)=>{const r=object(raw);invariant(identifier(r.id)&&r.tag_name===tag&&r.body===body&&typeof r.draft==="boolean"&&r.prerelease===true&&Array.isArray(r.assets)&&r.assets.length<=1&&(!state.releaseId||r.id===state.releaseId),conflict);return r;};
   const find=async()=>{if(state.releaseId){const response=await call("GET",base+"/releases/"+state.releaseId);invariant(response.status===200,fail);return validateRelease(response.body);}const byTag=await call("GET",base+"/releases/tags/"+tag);if(byTag.status===200)return validateRelease(byTag.body);invariant(byTag.status===404,fail);const list=await call("GET",base+"/releases?per_page=100");invariant(list.status===200&&Array.isArray(list.body)&&list.body.length<=100,fail);const matches=(list.body as Record<string,unknown>[]).filter(r=>r.tag_name===tag);invariant(matches.length<=1,conflict);return matches[0]?validateRelease(matches[0]):null;};
   let release=await find();
   if(!release){invariant(state.phase==="new",fail);const head=await call("GET",base+"/commits/"+encodeURIComponent(repository.default_branch));const commit=object(head.body);invariant(head.status===200&&typeof commit.sha==="string"&&/^[a-f0-9]{40}$/.test(commit.sha),fail);await save("creating");
    try{const created=await call("POST",base+"/releases",{tag_name:tag,target_commitish:commit.sha,name:tag,body,draft:true,prerelease:true,make_latest:"false"});if(created.status===201)release=validateRelease(created.body);}catch(error){if(error instanceof RateLimited)throw error;live();}
    if(!release)release=await find();invariant(release,fail);await save("created",Number(release.id));
   }else if(!state.releaseId)await save(release.draft?"created":"published",Number(release.id));
   const validAsset=(raw:unknown)=>{const a=object(raw);invariant(identifier(a.id)&&a.name===name&&a.size===bytes.length&&a.digest==="sha256:"+digest&&a.state==="uploaded"&&a.content_type==="application/octet-stream"&&(!state.assetId||a.id===state.assetId),conflict);return a;};
   let asset=(release.assets as unknown[])[0];
   if(!asset){invariant(release.draft===true&&state.phase!=="uploading"&&state.phase!=="publishing"&&state.phase!=="published",fail);await save("uploading",Number(release.id));
    try{const uploaded=await call("POST","https://uploads.github.com/"+base+"/releases/"+release.id+"/assets?name="+name,undefined,file);if(uploaded.status===201)asset=validAsset(uploaded.body);}catch(error){if(error instanceof RateLimited)throw error;live();}
    release=(await find())!;invariant(release,fail);asset=(release.assets as unknown[])[0];invariant(asset,fail);
   }
   const verified=validAsset(asset);await save(release.draft?"uploaded":"published",Number(release.id),Number(verified.id));
   if(release.draft){await save("publishing");try{await call("PATCH",base+"/releases/"+release.id,{draft:false,prerelease:true,make_latest:"false"});}catch(error){if(error instanceof RateLimited)throw error;live();}release=(await find())!;invariant(release&&release.draft===false,fail);validAsset((release.assets as unknown[])[0]);await save("published");}
   live();return {schemaVersion:1,releaseId:Number(release.id),assetId:Number(verified.id)};
  }finally{releaseLock();}
 };
}
