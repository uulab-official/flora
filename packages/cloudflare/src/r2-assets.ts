import type { DurableObjectStorage, R2Object, R2ObjectBody, R2PutOptions } from "@cloudflare/workers-types";
import { canonicalJson } from "@app-ops/config";
import { assertOTAAssetBytes, parseOTAAsset } from "@app-ops/dogfood";
import type { OTAAsset } from "@app-ops/dogfood";
import type { FloraConfig } from "./contracts.js";
import { HttpFailure } from "./http.js";

import type { ExternalAssetProof as R2AssetProof, ExternalOTAAssets } from "./external-assets.js";
export type { ExternalAssetProof as R2AssetProof, ExternalOTAAssets } from "./external-assets.js";
interface Bucket { put(key:string,bytes:Uint8Array,options:R2PutOptions):Promise<R2Object|null>; get(key:string):Promise<R2ObjectBody|null> }
type Storage=Pick<DurableObjectStorage,"sql"|"transactionSync"|"sync">;
interface Quota {storageBytes:number;objects:number;classA:number;classB:number}
const ceiling:Quota={storageBytes:8*1024**3,objects:4096,classA:100000,classB:1000000};
const month=(now:number)=>new Date(now).toISOString().slice(0,7);
const hex=(bytes:ArrayBuffer|Uint8Array)=>Array.from(new Uint8Array(bytes instanceof Uint8Array?bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength):bytes)).map(v=>v.toString(16).padStart(2,"0")).join("");
const sha=async(value:string|Uint8Array)=>hex(await crypto.subtle.digest("SHA-256",typeof value==="string"?new TextEncoder().encode(value):value));
function required(condition:unknown,code="R2_ASSET_INTEGRITY"):asserts condition{if(!condition)throw new HttpFailure(503,code);}

/** One instance in the existing owner DO. Reservations survive eviction,
 * recovery and owner/config changes. Unused prepaid credits are never refunded. */
export class R2OTAAssets {
 private readonly credits={a:{month:"",left:0},b:{month:"",left:0}};
 private activeReads=0;
 constructor(private readonly storage:Storage,private readonly bucket:Bucket,private readonly quota:Quota=ceiling){
  for(const key of Object.keys(ceiling) as (keyof Quota)[])required(Number.isSafeInteger(quota[key])&&quota[key]>0&&quota[key]<=ceiling[key],"R2_BUDGET_UNAVAILABLE");
  storage.sql.exec("CREATE TABLE IF NOT EXISTS flora_r2_storage(singleton INTEGER PRIMARY KEY CHECK(singleton=1),reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes BETWEEN 0 AND 8589934592),object_count INTEGER NOT NULL CHECK(object_count BETWEEN 0 AND 4096))");
  storage.sql.exec("INSERT OR IGNORE INTO flora_r2_storage VALUES(1,0,0)");
  storage.sql.exec("CREATE TABLE IF NOT EXISTS flora_r2_reservations(object_key TEXT PRIMARY KEY,byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 16777216))");
  storage.sql.exec("CREATE TABLE IF NOT EXISTS flora_r2_months(month TEXT PRIMARY KEY,class_a INTEGER NOT NULL CHECK(class_a BETWEEN 0 AND 100000),class_b INTEGER NOT NULL CHECK(class_b BETWEEN 0 AND 1000000))");
 }
 stats(now=Date.now()){
  const total=this.storage.sql.exec<{reserved_bytes:number;object_count:number}>("SELECT reserved_bytes,object_count FROM flora_r2_storage WHERE singleton=1").one();
  const row=this.storage.sql.exec<{class_a:number;class_b:number}>("SELECT class_a,class_b FROM flora_r2_months WHERE month=?",month(now)).toArray()[0];
  return {reservedBytes:total.reserved_bytes,objectCount:total.object_count,month:month(now),classA:row?.class_a??0,classB:row?.class_b??0};
 }
 private reserve(kind:"a"|"b",period:string,object?:{key:string;size:number}){
  const cache=this.credits[kind],credit=cache.month===period?cache.left:0;
  const added=this.storage.transactionSync(()=>{
   if(object){
    const prior=this.storage.sql.exec<{byte_length:number}>("SELECT byte_length FROM flora_r2_reservations WHERE object_key=?",object.key).toArray()[0];
    if(prior)required(prior.byte_length===object.size);
    else {
     const total=this.storage.sql.exec<{reserved_bytes:number;object_count:number}>("SELECT reserved_bytes,object_count FROM flora_r2_storage WHERE singleton=1").one();
     if(total.object_count>=this.quota.objects||total.reserved_bytes+object.size>this.quota.storageBytes)throw new HttpFailure(429,"R2_FREE_STORAGE_LIMIT");
     this.storage.sql.exec("INSERT INTO flora_r2_reservations VALUES(?,?)",object.key,object.size);
     this.storage.sql.exec("UPDATE flora_r2_storage SET reserved_bytes=reserved_bytes+?,object_count=object_count+1 WHERE singleton=1",object.size);
    }
   }
   if(credit>0)return 0;
   const row=this.storage.sql.exec<{class_a:number;class_b:number}>("SELECT class_a,class_b FROM flora_r2_months WHERE month=?",period).toArray()[0],used=kind==="a"?row?.class_a??0:row?.class_b??0,limit=kind==="a"?this.quota.classA:this.quota.classB;
   const block=Math.min(32,limit-used);if(block<=0)throw new HttpFailure(429,"R2_FREE_OPERATION_LIMIT");
   if(!row)this.storage.sql.exec("INSERT INTO flora_r2_months VALUES(?,0,0)",period);
   this.storage.sql.exec(kind==="a"?"UPDATE flora_r2_months SET class_a=class_a+? WHERE month=?":"UPDATE flora_r2_months SET class_b=class_b+? WHERE month=?",block,period);return block;
  });
  cache.month=period;cache.left=(credit||added)-1;
 }
 private async before(kind:"a"|"b",fence:()=>void,clock:()=>number,object?:{key:string;size:number}){
  for(let attempt=0;attempt<2;attempt++){
   fence();const period=month(clock());this.reserve(kind,period,object);await this.storage.sync();fence();if(period===month(clock()))return;
  }
  throw new HttpFailure(503,"R2_BUDGET_UNAVAILABLE");
 }
 scope(config:Pick<FloraConfig,"ownerId"|"origin"|"dbIdentity">,fence:()=>void,now?:number|(()=>number)):ExternalOTAAssets{
  const identity=canonicalJson([config.ownerId,config.origin,config.dbIdentity]),clock=typeof now==="function"?now:()=>now??Date.now();
  const facts=async(input:OTAAsset)=>{const asset=parseOTAAsset(input),scope=await sha(identity),objectKey=`ota/v1/${scope}/${asset.appId}/${asset.digest}`,metadata=await sha(canonicalJson([asset.appId,asset.digest,asset.hash,asset.key,asset.contentType,asset.fileExtension,asset.size]));return {asset,scope,objectKey,metadata};};
  const verify=(object:R2Object,expected:Awaited<ReturnType<typeof facts>>)=>{
   required(object.key===expected.objectKey&&object.size===expected.asset.size&&object.storageClass==="Standard"&&typeof object.version==="string"&&object.version.length>0&&object.version.length<=128&&typeof object.etag==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(object.etag));
   required(object.checksums?.sha256&&hex(object.checksums.sha256)===expected.asset.digest&&object.customMetadata?.scope===expected.scope&&object.customMetadata?.metadata===expected.metadata);
   return {objectKey:expected.objectKey,size:object.size,digest:expected.asset.digest,version:object.version,etag:object.etag};
  };
  const readObject=async(expected:Awaited<ReturnType<typeof facts>>,proof?:R2AssetProof)=>{
   if(proof)required(proof.objectKey===expected.objectKey&&proof.size===expected.asset.size&&proof.digest===expected.asset.digest&&typeof proof.version==="string"&&proof.version.length>0&&proof.version.length<=128&&typeof proof.etag==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(proof.etag));
   await this.before("b",fence,clock);let object:R2ObjectBody|null;
   try{object=await this.bucket.get(expected.objectKey);}catch{throw new HttpFailure(503,"R2_ASSET_UNAVAILABLE");}required(object,"R2_ASSET_MISSING");
   let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
   try{
    fence();const actual=verify(object,expected);if(proof)required(actual.version===proof.version&&actual.etag===proof.etag);
    reader=object.body.getReader();const bytes=new Uint8Array(expected.asset.size);let size=0;
    for(;;){let part:ReadableStreamReadResult<Uint8Array>;try{part=await reader.read();}catch{throw new HttpFailure(503,"R2_ASSET_UNAVAILABLE");}if(part.done)break;required(size+part.value.byteLength<=bytes.length);bytes.set(part.value,size);size+=part.value.byteLength;}
    required(size===expected.asset.size);
    required(await sha(bytes)===expected.asset.digest);fence();return {bytes,proof:actual};
   }finally{await(reader?reader.cancel():object.body.cancel()).catch(()=>{});}
  };
  const read=async(expected:Awaited<ReturnType<typeof facts>>,proof?:R2AssetProof)=>{
   if(this.activeReads>=2)throw new HttpFailure(429,"R2_BUSY");this.activeReads++;
   try{return await readObject(expected,proof);}finally{this.activeReads--;}
  };
  return {
   put:async(input,bytes)=>{
    const expected=await facts(input);await assertOTAAssetBytes(expected.asset,bytes);fence();await this.before("a",fence,clock,{key:expected.objectKey,size:bytes.length});let object:R2Object|null;
    try{object=await this.bucket.put(expected.objectKey,bytes,{onlyIf:{etagDoesNotMatch:"*"},sha256:expected.asset.digest,storageClass:"Standard",httpMetadata:{contentType:expected.asset.contentType},customMetadata:{scope:expected.scope,metadata:expected.metadata}});}catch{throw new HttpFailure(503,"R2_ASSET_UNAVAILABLE");}
    fence();return object?verify(object,expected):(await read(expected)).proof;
   },
   get:async(asset,proof)=>{required(proof&&typeof proof.objectKey==="string"&&typeof proof.version==="string"&&typeof proof.etag==="string");return(await read(await facts(asset),proof)).bytes;},
  };
 }
}
