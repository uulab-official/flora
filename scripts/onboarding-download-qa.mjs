#!/usr/bin/env node
import {readFile,lstat,mkdir,writeFile,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {X509Certificate,verify,createHash} from 'node:crypto';
import {freezePublicationTarget} from '../packages/cloudflare/public/onboarding-model.js';
const check=(v)=>{if(!v)throw Error('ONBOARDING_DOWNLOAD_UNVERIFIED');};
const object=(v,keys)=>{check(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)));return v;};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
async function bytes(response,limit){
 check(response.status===200&&!response.redirected&&response.body);const length=response.headers.get('content-length');if(length!==null)check(/^[0-9]+$/.test(length)&&Number(length)<=limit);
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{while(true){const p=await reader.read();if(p.done)break;size+=p.value.length;check(size<=limit);chunks.push(p.value);}}finally{await reader.cancel();}return Buffer.concat(chunks);
}
export async function readPublicJSON(path){
 check(isAbsolute(path));const s=await lstat(path);check(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size<=16384);
 const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const current=await f.stat();check(current.ino===s.ino&&current.dev===s.dev&&current.size<=16384);const buffer=Buffer.alloc(16385),r=await f.read(buffer,0,buffer.length,0);check(r.bytesRead<=16384);return JSON.parse(buffer.subarray(0,r.bytesRead).toString('utf8'));}finally{await f.close();}
}
/** Public GETs only. This proves signed publication/download, never device adoption. */
export async function verifyDownloads(connection,input,{fetch:request=fetch,signal=new AbortController().signal}={}){
 object(connection,['appId','url','channel','runtimeVersion','certificate','keyId']);object(input,['appId','commitSha','channel','runtimeVersion','platforms','deployments']);
 const {deployments,...selection}=input,target=freezePublicationTarget(selection);object(deployments,[...target.platforms]);check(target.platforms.every(p=>typeof deployments[p]==='string'&&uuid.test(deployments[p])));
 const url=new URL(connection.url),origin=url.origin;
 check(url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&url.href===origin+'/updates/'+target.appId&&connection.appId===target.appId&&connection.channel===target.channel&&connection.runtimeVersion===target.runtimeVersion&&typeof connection.keyId==='string'&&/^[A-Za-z0-9._-]{1,128}$/.test(connection.keyId)&&typeof connection.certificate==='string'&&Buffer.byteLength(connection.certificate)<=16384&&connection.certificate.startsWith('-----BEGIN CERTIFICATE-----'));
 const certificate=new X509Certificate(connection.certificate),key=certificate.publicKey;check(key.asymmetricKeyType==='rsa'&&key.asymmetricKeyDetails.modulusLength>=2048);
 const now=Date.now();check(Date.parse(certificate.validFrom)<=now&&Date.parse(certificate.validTo)>now);
 const platforms=[];
 for(const platform of target.platforms){
  signal.throwIfAborted();let total=0;
  const get=async(address,limit,headers={})=>{const response=await request(address,{method:'GET',headers,credentials:'omit',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])});const data=await bytes(response,Math.min(limit,67108864-total));total+=data.length;check(total<=67108864);return {data,response};};
  const {data,response}=await get(connection.url,1048576,{'accept':'application/json','expo-protocol-version':'1','expo-platform':platform,'expo-runtime-version':target.runtimeVersion,'expo-channel-name':target.channel,'expo-expect-signature':`sig,keyid="${connection.keyId}",alg="rsa-v1_5-sha256"`});
  check(response.headers.get('content-type')?.split(';')[0].trim()==='application/json');
  const signature=response.headers.get('expo-signature'),match=signature?.match(/^sig="([A-Za-z0-9+/]+={0,2})",\s*keyid="([A-Za-z0-9._-]{1,128})",\s*alg="rsa-v1_5-sha256"$/);
  check(match&&match[2]===connection.keyId&&match[1].length<=4096);const signed=Buffer.from(match[1],'base64');check(signed.toString('base64')===match[1]&&verify('RSA-SHA256',data,key,signed));
  const manifest=JSON.parse(data.toString('utf8')),flora=manifest.extra?.flora;
  check(manifest.id===deployments[platform]&&manifest.runtimeVersion===target.runtimeVersion&&manifest.metadata?.channel===target.channel&&flora?.appId===target.appId&&flora.commitSha===target.commitSha&&flora.platform===platform&&Array.isArray(manifest.assets)&&manifest.assets.length<=64);
  const assets=[manifest.launchAsset,...manifest.assets],assetHashes=[];check(assets.length<=65);
  for(const asset of assets){
   check(asset&&typeof asset.url==='string'&&typeof asset.hash==='string');const a=new URL(asset.url),digest=a.pathname.slice(-64);
   check(a.origin===origin&&a.href===origin+'/updates/'+target.appId+'/assets/'+digest&&/^[a-f0-9]{64}$/.test(digest)&&asset.hash===Buffer.from(digest,'hex').toString('base64url'));
   const {data:payload}=await get(a.href,16777216);check(createHash('sha256').update(payload).digest('hex')===digest);assetHashes.push(digest);
  }
  platforms.push({platform,deploymentId:manifest.id,manifestHash:createHash('sha256').update(data).digest('hex'),assetCount:assets.length,assetHashes,bytes:total});
 }
 return {schemaVersion:1,evidence:'signed-public-download',appId:target.appId,commitSha:target.commitSha,channel:target.channel,runtimeVersion:target.runtimeVersion,platforms};
}
export async function main(args){
 check(args.length===6&&args[0]==='--connection'&&args[2]==='--target'&&args[4]==='--out'&&args.filter((_,i)=>i%2).every(isAbsolute));
 const connection=await readPublicJSON(args[1]),target=await readPublicJSON(args[3]);
 const result=await verifyDownloads(connection,target);await mkdir(args[5],{mode:0o700});await writeFile(join(args[5],'downloads.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(()=>{console.error('ONBOARDING_DOWNLOAD_UNVERIFIED');process.exitCode=1;});
