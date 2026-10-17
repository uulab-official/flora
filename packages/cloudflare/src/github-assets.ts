import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { canonicalJson } from "@app-ops/config";
import { assertOTAAssetBytes, automationDigest, createGitHubAppJWT, isGitHubInstallationToken, parseOTAAsset } from "@app-ops/dogfood";
import type { GitHubAppCredentials, OTAAsset } from "@app-ops/dogfood";
import type { FloraConfig } from "./contracts.js";
import type { ExternalAssetProof, ExternalAssetUploadContext, ExternalOTAAssets } from "./external-assets.js";
import { HttpFailure } from "./http.js";

type Storage=Pick<DurableObjectStorage,"sql"|"transactionSync"|"sync">;
interface Reference {schemaVersion:1;releaseId:number;assetId:number}
interface Locator {repository:string;repositoryId:number;installationId:number;releaseId:number;assetId:number;tag:string}
interface Options {repository:string;repositoryId?:number;installationId:number;credentials:()=>GitHubAppCredentials|undefined;fetch?:typeof fetch;now?:()=>number;callsPerHour?:number;timeoutMs?:number}
const api="https://api.github.com",binaryHost="release-assets.githubusercontent.com",utf8=new TextEncoder();
const positive=(value:unknown):value is number=>typeof value==="number"&&Number.isSafeInteger(value)&&value>0;
const repository=(value:unknown):value is string=>typeof value==="string"&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value);
function check(condition:unknown,code="GITHUB_ASSET_INTEGRITY",status=503):asserts condition{if(!condition)throw new HttpFailure(status,code);}
function record(value:unknown):Record<string,unknown>{check(value&&typeof value==="object"&&!Array.isArray(value));return value as Record<string,unknown>;}
function exact(value:Record<string,unknown>,keys:string[]){check(Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)));}
export function parseGitHubAssetReference(value:string):Reference{
 try{check(value.length<=1024&&/^[A-Za-z0-9_-]+$/.test(value));const normalized=value.replaceAll("-","+").replaceAll("_","/"),bytes=Uint8Array.from(atob(normalized+"=".repeat((4-normalized.length%4)%4)),c=>c.charCodeAt(0)),text=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes),raw=record(JSON.parse(text));exact(raw,["schemaVersion","releaseId","assetId"]);check(raw.schemaVersion===1&&positive(raw.releaseId)&&positive(raw.assetId)&&canonicalJson(raw)===text&&btoa(String.fromCharCode(...bytes)).replaceAll("+","-").replaceAll("/","_").replace(/=+$/,"")===value);return raw as unknown as Reference;}
 catch{throw new HttpFailure(400,"ASSET_REFERENCE_INVALID");}
}
function locator(value:string):Locator{
 check(typeof value==="string"&&utf8.encode(value).length<=768);let raw:Record<string,unknown>;try{raw=record(JSON.parse(value));}catch{throw new HttpFailure(503,"GITHUB_ASSET_INTEGRITY");}
 exact(raw,["repository","repositoryId","installationId","releaseId","assetId","tag"]);check(repository(raw.repository)&&positive(raw.repositoryId)&&positive(raw.installationId)&&positive(raw.releaseId)&&positive(raw.assetId)&&typeof raw.tag==="string"&&/^flora-ota-v1-[a-f0-9]{64}$/.test(raw.tag)&&canonicalJson(raw)===value);return raw as unknown as Locator;
}
function assetIdentity(asset:OTAAsset){return {digest:asset.digest,hash:asset.hash,key:asset.key,contentType:asset.contentType,fileExtension:asset.fileExtension,size:asset.size};}
export function githubAssetReleaseBody(origin:string,asset:OTAAsset,context:ExternalAssetUploadContext){
 check(context.job.appId===asset.appId&&context.lease.appId===asset.appId&&context.lease.jobId===context.job.id);
 return {schemaVersion:1,origin,appId:asset.appId,jobId:context.job.id,attemptId:context.lease.attemptId,commitSha:context.job.commitSha,platform:context.job.platform,asset:assetIdentity(asset)};
}
async function bounded<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
 if(signal.aborted)throw new HttpFailure(503,"GITHUB_ASSET_UNAVAILABLE");let stop:()=>void=()=>{};
 const expired=new Promise<never>((_,reject)=>{stop=()=>reject(new HttpFailure(503,"GITHUB_ASSET_UNAVAILABLE"));signal.addEventListener("abort",stop,{once:true});});
 try{return await Promise.race([promise,expired]);}finally{signal.removeEventListener("abort",stop);}
}

/** Read-only GitHub App verifier. Writes remain in the trusted PC controller;
 * every provider call prepays a durable block, including failed/unknown calls. */
export class GitHubReleaseOTAAssets {
 private credit={hour:"",left:0};private active=0;
 private cooldownUntil=0;
 private readonly tokens=new Map<string,{token:string;expiresAt:number}>();
 private readonly clock:()=>number;private readonly limit:number;
 constructor(private readonly storage:Storage,private readonly options:Options){
  check(repository(options.repository)&&positive(options.installationId)&&(options.repositoryId===undefined||positive(options.repositoryId)),"GITHUB_ASSET_UNAVAILABLE");
  this.clock=options.now??Date.now;this.limit=options.callsPerHour??3000;check(positive(this.limit)&&this.limit<=3000&&(options.timeoutMs===undefined||positive(options.timeoutMs)&&options.timeoutMs<=15000),"GITHUB_ASSET_UNAVAILABLE");
  storage.sql.exec("CREATE TABLE IF NOT EXISTS flora_github_asset_budget(singleton INTEGER PRIMARY KEY CHECK(singleton=1),hour TEXT NOT NULL,reserved_calls INTEGER NOT NULL CHECK(reserved_calls BETWEEN 0 AND 3000))");
  storage.sql.exec("CREATE TABLE IF NOT EXISTS flora_github_asset_cooldown(singleton INTEGER PRIMARY KEY CHECK(singleton=1),until_ms INTEGER NOT NULL CHECK(until_ms BETWEEN 0 AND 9007199254740991))");
  this.cooldownUntil=storage.sql.exec<{until_ms:number}>("SELECT until_ms FROM flora_github_asset_cooldown WHERE singleton=1").toArray()[0]?.until_ms??0;
 }
 stats(){const row=this.storage.sql.exec<{hour:string;reserved_calls:number}>("SELECT hour,reserved_calls FROM flora_github_asset_budget WHERE singleton=1").toArray()[0];return {hour:row?.hour??null,reservedCalls:row?.reserved_calls??0,cooldownUntil:this.cooldownUntil};}
 private async reserve(fence:()=>void){
  for(let attempt=0;attempt<2;attempt++){
   fence();check(this.clock()>=this.cooldownUntil,"GITHUB_ASSET_RATE_LIMIT",429);const hour=new Date(this.clock()).toISOString().slice(0,13);
   if(this.credit.hour===hour&&this.credit.left>0)this.credit.left--;
   else{
    const count=this.storage.transactionSync(()=>{const row=this.storage.sql.exec<{hour:string;reserved_calls:number}>("SELECT hour,reserved_calls FROM flora_github_asset_budget WHERE singleton=1").toArray()[0];check(!row||hour>=row.hour,"GITHUB_ASSET_RATE_LIMIT",429);const used=row?.hour===hour?row.reserved_calls:0,block=Math.min(32,this.limit-used);check(block>0,"GITHUB_ASSET_RATE_LIMIT",429);this.storage.sql.exec("INSERT INTO flora_github_asset_budget VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET hour=excluded.hour,reserved_calls=excluded.reserved_calls",hour,used+block);return block;});this.credit={hour,left:count-1};
   }
   await this.storage.sync();fence();if(hour===new Date(this.clock()).toISOString().slice(0,13))return;
  }
  throw new HttpFailure(503,"GITHUB_ASSET_UNAVAILABLE");
 }
 scope(config:Pick<FloraConfig,"ownerId"|"origin"|"dbIdentity">,fence:()=>void,context?:()=>ExternalAssetUploadContext|undefined):ExternalOTAAssets{
  const facts=async(input:OTAAsset)=>{const asset=parseOTAAsset(input),scope=await automationDigest([config.ownerId,config.origin,config.dbIdentity]);fence();return {asset,objectKey:`github-release/v1/${scope}/${asset.appId}/${asset.digest}`};};
  const work=async<T>(action:(signal:AbortSignal)=>Promise<T>)=>{check(this.active<2,"GITHUB_ASSET_BUSY",429);this.active++;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.options.timeoutMs??15000);try{return await action(controller.signal);}finally{clearTimeout(timer);this.active--;}};
  const request=async(url:string,signal:AbortSignal,headers:Record<string,string>,body?:unknown)=>{
   await this.reserve(fence);let response:Response;
   try{response=await bounded((this.options.fetch??fetch)(url,{method:body===undefined?"GET":"POST",redirect:"manual",signal,headers:{"User-Agent":"flora-ota-assets","X-GitHub-Api-Version":"2026-03-10",...headers,...(body===undefined?{}:{"Content-Type":"application/json"})},...(body===undefined?{}:{body:canonicalJson(body)})}),signal);}catch(error){if(error instanceof HttpFailure)throw error;throw new HttpFailure(503,"GITHUB_ASSET_UNAVAILABLE");}
   try{
    fence();check(!signal.aborted,"GITHUB_ASSET_UNAVAILABLE");
    if(response.status===429||response.status===403){
     const retry=response.headers.get("Retry-After"),reset=response.headers.get("X-RateLimit-Reset"),now=this.clock(),seconds=retry&&/^[0-9]{1,8}$/.test(retry)?Number(retry):response.headers.get("X-RateLimit-Remaining")==="0"&&reset&&/^[0-9]{1,16}$/.test(reset)?Math.ceil((Number(reset)*1000-now)/1000):60;
     this.cooldownUntil=Math.max(this.cooldownUntil,now+Math.max(1,Math.min(3600,seconds))*1000);
     this.storage.sql.exec("INSERT INTO flora_github_asset_cooldown VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET until_ms=max(until_ms,excluded.until_ms)",this.cooldownUntil);await this.storage.sync();fence();throw new HttpFailure(429,"GITHUB_ASSET_RATE_LIMIT");
    }
    return response;
   }catch(error){await response.body?.cancel().catch(()=>{});throw error;}
  };
  const bytes=async(response:Response,signal:AbortSignal,size:number,exactSize:boolean)=>{
   check(response.body,"GITHUB_ASSET_UNAVAILABLE");const reader=response.body.getReader(),result=new Uint8Array(size);let length=0;
   try{for(;;){let part:ReadableStreamReadResult<Uint8Array>;try{part=await bounded(reader.read(),signal);}catch{throw new HttpFailure(503,"GITHUB_ASSET_UNAVAILABLE");}if(part.done)break;check(length+part.value.length<=size);result.set(part.value,length);length+=part.value.length;}check(!exactSize||length===size);fence();return exactSize?result:result.slice(0,length);}finally{await reader.cancel().catch(()=>{});}
  };
  const json=async(path:string,token:string,signal:AbortSignal,body?:unknown)=>{
   const response=await request(api+path,signal,{Accept:"application/vnd.github+json",Authorization:"Bearer "+token},body);
   if(![200,201].includes(response.status)){await response.body?.cancel().catch(()=>{});throw new HttpFailure(response.status===429?429:503,response.status===429?"GITHUB_ASSET_RATE_LIMIT":"GITHUB_ASSET_UNAVAILABLE");}
   const raw=await bytes(response,signal,1048576,false);try{return record(JSON.parse(new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(raw)));}catch{throw new HttpFailure(503,"GITHUB_ASSET_INTEGRITY");}
  };
  const token=async(repo:string,installation:number,signal:AbortSignal)=>{
   const cacheKey=installation+":"+repo,prior=this.tokens.get(cacheKey);if(prior&&prior.expiresAt>this.clock()+60000){fence();return prior.token;}
   const credentials=this.options.credentials();check(credentials,"GITHUB_ASSET_UNAVAILABLE");const jwt=await createGitHubAppJWT(credentials,this.clock());fence();
   const grant=await json(`/app/installations/${installation}/access_tokens`,jwt,signal,{repositories:[repo.split("/")[1]],permissions:{contents:"read"}});check(isGitHubInstallationToken(grant.token)&&typeof grant.expires_at==="string");const expiresAt=Date.parse(grant.expires_at);check(Number.isFinite(expiresAt)&&expiresAt>this.clock()+60000&&expiresAt<=this.clock()+3660000);
   if(this.tokens.size>=16)this.tokens.delete(this.tokens.keys().next().value!);this.tokens.set(cacheKey,{token:grant.token,expiresAt});return grant.token;
  };
  const verify=async(asset:OTAAsset,pinned:Locator,signal:AbortSignal,expectedBody?:string)=>{
   const authorization=await token(pinned.repository,pinned.installationId,signal),base="/repos/"+pinned.repository;
   const repo=await json(base,authorization,signal);check(repo.id===pinned.repositoryId&&repo.private===true&&typeof repo.full_name==="string"&&repo.full_name.toLowerCase()===pinned.repository.toLowerCase());
   const release=await json(base+"/releases/"+pinned.releaseId,authorization,signal);check(release.id===pinned.releaseId&&release.draft===false&&release.prerelease===true&&release.tag_name===pinned.tag&&typeof release.body==="string"&&utf8.encode(release.body).length<=8192&&Array.isArray(release.assets)&&release.assets.length===1);
   let body:Record<string,unknown>;try{body=record(JSON.parse(release.body));}catch{throw new HttpFailure(503,"GITHUB_ASSET_INTEGRITY");}exact(body,["schemaVersion","origin","appId","jobId","attemptId","commitSha","platform","asset"]);
   check(canonicalJson(body)===release.body&&(!expectedBody||release.body===expectedBody)&&"flora-ota-v1-"+await automationDigest(body)===pinned.tag&&body.schemaVersion===1&&body.origin===config.origin&&body.appId===asset.appId&&canonicalJson(body.asset)===canonicalJson(assetIdentity(asset))&&typeof body.jobId==="string"&&/^[a-z][a-z0-9_-]{2,95}$/.test(body.jobId)&&typeof body.attemptId==="string"&&/^[a-z][a-z0-9_-]{2,95}$/.test(body.attemptId)&&typeof body.commitSha==="string"&&/^[a-f0-9]{40}$/.test(body.commitSha)&&(body.platform==="ios"||body.platform==="android"));
   const metadata=record(release.assets[0]);check(metadata.id===pinned.assetId&&metadata.name==="flora-"+asset.digest+".bin"&&metadata.state==="uploaded"&&metadata.size===asset.size&&metadata.content_type==="application/octet-stream"&&metadata.digest==="sha256:"+asset.digest);
   let response=await request(api+base+"/releases/assets/"+pinned.assetId,signal,{Accept:"application/octet-stream",Authorization:"Bearer "+authorization});
   if(response.status===302){const location=response.headers.get("Location");await response.body?.cancel().catch(()=>{});let target:URL|undefined;try{target=new URL(location??"");}catch{}check(target&&target.protocol==="https:"&&target.hostname===binaryHost&&target.port===""&&!target.username&&!target.password&&!target.hash&&target.pathname.startsWith("/github-production-release-asset/"));response=await request(target.href,signal,{Accept:"application/octet-stream"});}
   if(response.status!==200){await response.body?.cancel().catch(()=>{});throw new HttpFailure(503,"GITHUB_ASSET_UNAVAILABLE");}
   const encoding=response.headers.get("Content-Encoding"),length=response.headers.get("Content-Length");
   if(!(encoding===null||encoding==="identity")||length!==null&&(!/^[0-9]{1,10}$/.test(length)||Number(length)!==asset.size)){await response.body?.cancel().catch(()=>{});throw new HttpFailure(503,"GITHUB_ASSET_INTEGRITY");}
   const content=await bytes(response,signal,asset.size,true);await assertOTAAssetBytes(asset,content);fence();return content;
  };
  return {
   put:async(input,content)=>{const current=context?.();if(!current||current.reference===null)throw new HttpFailure(428,"ASSET_STORAGE_REFERENCE_REQUIRED");const ref=parseGitHubAssetReference(current.reference),expected=await facts(input);await assertOTAAssetBytes(expected.asset,content);const body=githubAssetReleaseBody(config.origin,expected.asset,current),tag="flora-ota-v1-"+await automationDigest(body);
    return work(async signal=>{let repositoryId=this.options.repositoryId;if(repositoryId===undefined){const authorization=await token(this.options.repository,this.options.installationId,signal),repo=await json("/repos/"+this.options.repository,authorization,signal);check(positive(repo.id));repositoryId=repo.id;}const pinned:Locator={repository:this.options.repository,repositoryId,installationId:this.options.installationId,releaseId:ref.releaseId,assetId:ref.assetId,tag};check(utf8.encode(canonicalJson(pinned)).length<=768);await verify(expected.asset,pinned,signal,canonicalJson(body));return {objectKey:expected.objectKey,size:expected.asset.size,digest:expected.asset.digest,version:canonicalJson(pinned),etag:expected.asset.digest};});},
   get:async(input,proof)=>{const expected=await facts(input);check(proof&&proof.objectKey===expected.objectKey&&proof.size===expected.asset.size&&proof.digest===expected.asset.digest&&proof.etag===expected.asset.digest);const pinned=locator(proof.version);return work(signal=>verify(expected.asset,pinned,signal));},
  };
 }
}
