export type NativePlatform = "ios" | "android";
export interface NativeLease {jobId:string;appId:string;platform:NativePlatform;runnerId:string;attemptId:string;credentialEpoch:number;fence:number;expiresAt:number}
export interface NativeJob {id:string;appId:string;platform:NativePlatform;commitSha:string;appIdentifier:string;teamId?:string;credentials:{kind:string;version:number}[];source:{owner:string;repository:string;ref:string;rootDirectory:string};state:string;configDigest:string}
export interface NativeArtifact {fileName:string;sha256:string;byteLength:number;appIdentifier:string;platform:NativePlatform;signerFingerprint:string;teamId?:string}
export interface NativeGrant {jobId:string;appId:string;platform:NativePlatform;commitSha:string;expiresAt:number;credentials:{kind:string;version:number;payload:{fileBase64:string;password?:string;keyAlias?:string;keyPassword?:string};metadata:Record<string,unknown>;fingerprint:string}[]}
export interface NativeClient {pending():Promise<string|null>;claim(jobId:string):Promise<{job:NativeJob;lease:NativeLease}>;heartbeat(lease:NativeLease,signal?:AbortSignal):Promise<NativeLease>;credentials(lease:NativeLease):Promise<NativeGrant>;complete(lease:NativeLease,artifact:NativeArtifact):Promise<NativeJob>;fail(lease:NativeLease,code:string):Promise<void>;presence():Promise<void>}
export class NativeHttpFailure extends Error {constructor(readonly status:number,readonly safeCode:"BUSY"|"NATIVE_REQUEST_REJECTED"="NATIVE_REQUEST_REJECTED"){super(safeCode);}}
export function nativeAssert(condition:unknown,code="NATIVE_RESPONSE_INVALID"):asserts condition {if(!condition)throw new Error(code);}
function lease(input:unknown):NativeLease {
 const v=input as NativeLease;nativeAssert(v&&typeof v==="object"&&["jobId","appId","runnerId","attemptId"].every(k=>typeof v[k as keyof NativeLease]==="string"&&/^[a-z][a-z0-9_-]{2,95}$/.test(String(v[k as keyof NativeLease])))&&(v.platform==="ios"||v.platform==="android")&&[v.credentialEpoch,v.fence,v.expiresAt].every(n=>Number.isSafeInteger(n)&&n>0));return structuredClone(v);
}
export function createNativeClient(options:{origin:string;token:string;appId:string;platform:NativePlatform;fetch?:typeof fetch}):NativeClient {
 const url=new URL(options.origin);nativeAssert(url.origin===options.origin&&(url.protocol==="https:"||url.protocol==="http:"&&["127.0.0.1","localhost","[::1]"].includes(url.hostname))&&!url.username&&!url.password,"INVALID_NATIVE_CONFIG");
 nativeAssert(/^native_runner_[a-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(options.token),"INVALID_NATIVE_CONFIG");const runnerId=options.token.split(".")[0]!;
 const bound=(input:unknown)=>{const v=lease(input);nativeAssert(v.appId===options.appId&&v.platform===options.platform&&v.runnerId===runnerId&&v.expiresAt>Date.now());return v;};
 async function call(action:string,body:unknown,active?:NativeLease,signal?:AbortSignal):Promise<unknown>{
  const startedAt=Date.now(),deadline=Math.min(startedAt+20000,active?.expiresAt??Infinity),leaseLimited=!!active&&active.expiresAt<=startedAt+20000;nativeAssert(deadline>Date.now(),"NATIVE_LEASE_EXPIRED");
  nativeAssert(!signal?.aborted,"NATIVE_CANCELLED");const timeout=AbortSignal.timeout(Math.max(1,deadline-Date.now())),requestSignal=signal?AbortSignal.any([timeout,signal]):timeout;
  // A monotonic deadline can fire before the wall clock reaches its integer timestamp.
  const failureCode=()=>signal?.aborted?"NATIVE_CANCELLED":active&&(Date.now()>=active.expiresAt||leaseLimited&&timeout.aborted)?"NATIVE_LEASE_EXPIRED":"NATIVE_TRANSPORT_UNAVAILABLE";let response:Response;try{response=await (options.fetch??fetch)(url.origin+"/api/native-runner/"+action,{method:"POST",redirect:"error",headers:{Authorization:"Bearer "+options.token,Origin:url.origin,"Content-Type":"application/json"},body:JSON.stringify(body),signal:requestSignal});}catch{throw new Error(failureCode());}
  nativeAssert(response.body,"NATIVE_RESPONSE_INVALID");const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  const cancel=()=>{void reader.cancel().catch(()=>{});};requestSignal.addEventListener("abort",cancel,{once:true});try{for(;;){nativeAssert(!requestSignal.aborted,failureCode());const part=await reader.read();if(part.done)break;bytes+=part.value.length;nativeAssert(bytes<=4*1024*1024);chunks.push(part.value);}nativeAssert(!requestSignal.aborted,failureCode());}catch(error){if(error instanceof Error&&["NATIVE_RESPONSE_INVALID","NATIVE_CANCELLED","NATIVE_LEASE_EXPIRED","NATIVE_TRANSPORT_UNAVAILABLE"].includes(error.message))throw error;throw new Error(failureCode());}finally{requestSignal.removeEventListener("abort",cancel);void reader.cancel().catch(()=>{});}
  if(!response.ok){let busy=false;try{busy=(JSON.parse(Buffer.concat(chunks).toString("utf8")) as {error?:unknown})?.error==="BUSY";}catch{}throw new NativeHttpFailure(response.status,busy?"BUSY":"NATIVE_REQUEST_REJECTED");}let value:unknown;try{value=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw new Error("NATIVE_RESPONSE_INVALID");}
  if(active)nativeAssert(Date.now()<deadline,failureCode());return value;
 }
 return {
  async pending(){const raw=await call("pending",{}) as {jobId:unknown};nativeAssert(raw&&typeof raw==="object"&&!Array.isArray(raw)&&Object.keys(raw).length===1&&Object.hasOwn(raw,"jobId")&&(raw.jobId===null||typeof raw.jobId==="string"&&/^native_job_[a-z0-9_-]{1,80}$/.test(raw.jobId)));return raw.jobId as string|null;},
  async claim(jobId){const raw=await call("claim",{jobId}) as {job:NativeJob;lease:NativeLease};const l=bound(raw.lease),j=raw.job;nativeAssert(j&&j.id===jobId&&j.id===l.jobId&&j.appId===l.appId&&j.platform===l.platform&&j.state==="leased"&&/^[a-f0-9]{40}$/.test(j.commitSha)&&Array.isArray(j.credentials)&&j.source&&typeof j.source.owner==="string"&&typeof j.source.repository==="string");return {job:j,lease:l};},
  async heartbeat(input,signal){const original=bound(input),next=bound(await call("heartbeat",{lease:original},original,signal));nativeAssert(["jobId","appId","platform","runnerId","attemptId","credentialEpoch","fence"].every(k=>next[k as keyof NativeLease]===original[k as keyof NativeLease]));return next;},
  async credentials(input){const l=bound(input),g=await call("credentials",{lease:l},l) as NativeGrant;nativeAssert(g&&g.jobId===l.jobId&&g.appId===l.appId&&g.platform===l.platform&&g.expiresAt>Date.now()&&g.expiresAt<=Date.now()+125000&&/^[a-f0-9]{40}$/.test(g.commitSha)&&Array.isArray(g.credentials));return g;},
  async complete(input,artifact){const l=bound(input),j=await call("complete",{lease:l,artifact},l) as NativeJob;nativeAssert(j&&j.id===l.jobId&&j.appId===l.appId&&j.platform===l.platform&&j.state==="succeeded");return j;},
  async fail(input,code){const l=bound(input);await call("fail",{lease:l,code},l);},
  async presence(){const v=await call("presence",{}) as {runnerId:string;lastSeenAt:number};nativeAssert(v&&v.runnerId===runnerId&&Number.isSafeInteger(v.lastSeenAt));},
 };
}
