import {freezePublicationTarget} from "./onboarding-model.js";
const fail=code=>{throw Error(code);};
async function fetchBytes(url,headers,maxBytes,fetch,signal){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
 const combined=AbortSignal.any([signal,controller.signal]);let reader;
 try{
  if(combined.aborted)fail("DOWNLOAD_CANCELLED");
  const response=await fetch(url,{method:"GET",headers,credentials:"omit",redirect:"error",signal:combined,cache:"no-store"});
  if(response.status!==200||response.redirected||response.url&&response.url!==url||!response.body)fail("DOWNLOAD_RESPONSE_INVALID");
  const length=response.headers.get("content-length");if(length&&(!/^\d+$/.test(length)||Number(length)>maxBytes))fail("DOWNLOAD_TOO_LARGE");
  reader=response.body.getReader();let size=0;const chunks=[];
  const abort=()=>{void reader.cancel().catch(()=>{});};combined.addEventListener("abort",abort,{once:true});
  try{
   while(true){if(combined.aborted)fail("DOWNLOAD_CANCELLED");const part=await reader.read();if(combined.aborted)fail("DOWNLOAD_CANCELLED");if(part.done)break;size+=part.value.byteLength;if(size>maxBytes)fail("DOWNLOAD_TOO_LARGE");chunks.push(part.value);}
  }finally{combined.removeEventListener("abort",abort);}
  if(length&&Number(length)!==size)fail("DOWNLOAD_RESPONSE_INVALID");
  const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}return bytes;
 }catch(error){
  if(signal.aborted)fail("DOWNLOAD_CANCELLED");if(controller.signal.aborted)fail("DOWNLOAD_TIMEOUT");
  if(["DOWNLOAD_TOO_LARGE","DOWNLOAD_RESPONSE_INVALID"].includes(error?.message))throw error;
  fail("DOWNLOAD_NETWORK_FAILED");
 }finally{clearTimeout(timer);if(reader)try{await reader.cancel();}catch{}}
}
export async function probeLaunchDownload(origin,input,platform,deploymentId,deps,signal){
 const target=freezePublicationTarget(input);
 let server;try{server=new URL(origin);}catch{fail("DOWNLOAD_TARGET_INVALID");}
 if(server.protocol!=="https:"||server.origin!==origin||!target.platforms.includes(platform)||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(deploymentId))fail("DOWNLOAD_TARGET_INVALID");
 const raw=await fetchBytes(origin+"/updates/"+target.appId,{Accept:"application/expo+json","expo-protocol-version":"1","expo-platform":platform,"expo-runtime-version":target.runtimeVersion,"expo-channel-name":target.channel},1048576,deps.fetch,signal);
 let manifest;try{manifest=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(raw));}catch{fail("DOWNLOAD_MANIFEST_INVALID");}
 const flora=manifest?.extra?.flora;
 if(manifest?.id!==deploymentId||manifest.runtimeVersion!==target.runtimeVersion||manifest.metadata?.channel!==target.channel||manifest.metadata?.appid!==target.appId||flora?.appId!==target.appId||flora.platform!==platform||flora.commitSha!==target.commitSha)fail("DOWNLOAD_MANIFEST_INVALID");
 const launch=manifest.launchAsset;let assetURL;try{assetURL=new URL(launch.url);}catch{fail("DOWNLOAD_ASSET_INVALID");}
 const prefix="/updates/"+target.appId+"/assets/",digest=assetURL.pathname.slice(prefix.length);
 if(assetURL.origin!==origin||assetURL.username||assetURL.password||assetURL.search||assetURL.hash||!assetURL.pathname.startsWith(prefix)||!/^[a-f0-9]{64}$/.test(digest)||assetURL.href!==launch.url||!/^[A-Za-z0-9_-]{43}$/.test(launch.hash??""))fail("DOWNLOAD_ASSET_INVALID");
 const bytes=await fetchBytes(assetURL.href,{},16777216,deps.fetch,signal);
 const sha=new Uint8Array(await deps.subtle.digest("SHA-256",bytes));
 const hex=[...sha].map(n=>n.toString(16).padStart(2,"0")).join(""),hash=btoa(String.fromCharCode(...sha)).replaceAll("+","-").replaceAll("/","_").replace(/=+$/g,"");
 if(hex!==digest||hash!==launch.hash)fail("DOWNLOAD_INTEGRITY_FAILED");
 return {kind:"web-download-hash",deploymentId,launchHash:hash,bytes:bytes.length};
}
