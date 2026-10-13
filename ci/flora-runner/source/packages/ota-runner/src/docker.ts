import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { decodeExport, invariant, readBoundedFile } from "./artifacts.js";
import type { ExportBundle } from "./artifacts.js";
import type { AutomationJob } from "@app-ops/dogfood";
import { trustedProcess } from "./process.js";
import { prepareNpmDependencySeed, HOSTED_NODE_VERSION, HOSTED_NPM_VERSION } from "./dependencies.js";
export interface ExportExecutor { execute(job:AutomationJob,source:string,signal:AbortSignal):Promise<ExportBundle> }
export interface DockerExecutor extends ExportExecutor { verify(signal?:AbortSignal):Promise<void> }
export type ResourceProfile="default"|"github-hosted";
export interface DockerExecutorOptions {image:string;network?:string;executable?:string;resourceProfile?:ResourceProfile;dependencyPreparation?:"npm-registry"}
function containerIdentity(){const uid=process.getuid?.(),gid=process.getgid?.();invariant(typeof uid==="number"&&uid>0&&typeof gid==="number"&&gid>=0,"ISOLATION_UNAVAILABLE");return {uid,gid};}
function path(input:string){invariant(input.startsWith("/")&&!/[\r\n,]/.test(input),"ISOLATION_UNAVAILABLE");return input;}
function boundedArguments(image:string,name:string,profile:ResourceProfile):string[]{
 invariant(/^(?:[A-Za-z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/.test(image),"ISOLATION_UNAVAILABLE");
 invariant(/^flora-[A-Za-z0-9_-]+$/.test(name)&&["default","github-hosted"].includes(profile),"ISOLATION_UNAVAILABLE");
 const {uid,gid}=containerIdentity(),owner=`uid=${uid},gid=${gid}`,hosted=profile==="github-hosted",memory=hosted?4294967296:1073741824,workspace=hosted?3221225472:805306368;
 return ["run","--rm","--pull=never","--name",name,"--init","--read-only","--cap-drop=ALL","--security-opt=no-new-privileges","--pids-limit=128",`--memory=${memory}`,`--memory-swap=${memory}`,"--cpus=2",`--user=${uid}:${gid}`,
  `--tmpfs=/workspace:rw,nosuid,nodev,size=${workspace},${owner}`,`--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=67108864,${owner}`,`--tmpfs=/output:rw,noexec,nosuid,nodev,size=68157440,${owner}`];
}
export function dockerArguments(image:string,name:string,source:string,runner:string,network="none",profile:ResourceProfile="default",cache?:string):string[]{
 invariant(network==="none"||/^[a-z][a-z0-9_-]{2,63}$/.test(network)&&!["host","bridge","default"].includes(network),"ISOLATION_UNAVAILABLE");
 return [...boundedArguments(image,name,profile),"--network="+network,"--mount",`type=bind,src=${path(source)},dst=/source,readonly`,"--mount",`type=bind,src=${path(runner)},dst=/runner,readonly`,
  ...(cache?["--mount",`type=bind,src=${path(cache)},dst=/dependency-cache,readonly`]:[]),"--interactive",image,"node","/runner/dist/inside-container.js"];
}
/** Online preparation contains no app source/config, scripts or credentials. This is not an egress firewall. */
export function dockerCacheArguments(image:string,name:string,seed:string,runner:string,cache:string,profile:ResourceProfile):string[]{
 invariant(profile==="github-hosted","ISOLATION_UNAVAILABLE");
 return [...boundedArguments(image,name,profile),"--network=bridge","--mount",`type=bind,src=${path(seed)},dst=/seed,readonly`,"--mount",`type=bind,src=${path(runner)},dst=/runner,readonly`,"--mount",`type=bind,src=${path(cache)},dst=/dependency-cache`,image,"node","/runner/dist/prepare-cache-container.js"];
}
async function confirmRemoved(docker:string,name:string){
 await trustedProcess(docker,["rm","--force","--volumes",name],{timeoutMs:10_000,maxBytes:8192}).catch(()=>{});
 try{const remaining=await trustedProcess(docker,["container","ls","--all","--filter",`name=^/${name}$`,"--format","{{.ID}}"],{timeoutMs:10_000,maxBytes:8192});invariant(remaining.trim()==="","ISOLATION_CLEANUP_UNCONFIRMED");}
 catch{throw new Error("ISOLATION_CLEANUP_UNCONFIRMED");}
}
/** No host execution fallback. Controller credentials never enter either container. */
export function createDockerExecutor(options:DockerExecutorOptions):DockerExecutor{
 const runner=resolve(fileURLToPath(new URL("..",import.meta.url))),docker=options.executable??"docker",profile=options.resourceProfile??"default";
 invariant(options.dependencyPreparation===undefined||options.dependencyPreparation==="npm-registry"&&profile==="github-hosted"&&(options.network===undefined||options.network==="none"),"ISOLATION_UNAVAILABLE");
 const verify=async(signal?:AbortSignal)=>{try{containerIdentity();dockerArguments(options.image,"flora-verify","/source","/runner",options.network,profile);await trustedProcess(docker,["version","--format","{{.Server.Version}}"],{...(signal?{signal}:{}),timeoutMs:10_000,maxBytes:8192});}catch{throw new Error("ISOLATION_UNAVAILABLE");}};
 return {verify,async execute(job,source,signal){
  await verify(signal);const name="flora-"+randomUUID(),helper=await mkdtemp(join(tmpdir(),"flora-helper-"));await chmod(helper,0o755);let launched=false,cache:string|undefined,preparation:string|undefined;
  try{
   await mkdir(join(helper,"dist"),{mode:0o755});await mkdir(join(helper,"scripts"),{mode:0o755});await writeFile(join(helper,"package.json"),'{"type":"module"}',{mode:0o444});
   for(const file of ["dist/artifacts.js","dist/process.js","dist/expo.js","dist/inside-container.js","dist/dependencies.js","dist/prepare-cache-container.js","scripts/metro-export.mjs"])await writeFile(join(helper,file),await readBoundedFile(runner,file,1024*1024),{mode:0o444});
   if(options.dependencyPreparation){
    invariant(job.config.toolchain.nodeVersion===HOSTED_NODE_VERSION&&job.config.toolchain.packageManager.name==="npm"&&job.config.toolchain.packageManager.version===HOSTED_NPM_VERSION,"CONFIG_CHANGED");
    preparation=await mkdtemp(join(tmpdir(),"flora-dependencies-"));cache=join(preparation,"cache");await mkdir(cache,{mode:0o700});const seed=join(preparation,"seed");await prepareNpmDependencySeed(source,job.rootDirectory,seed);
    const seedName="flora-seed-"+randomUUID();try{const result=await trustedProcess(docker,dockerCacheArguments(options.image,seedName,seed,helper,cache,profile),{signal,timeoutMs:660000,maxBytes:2*1024*1024});invariant(result==="FLORA_DEPENDENCY_CACHE_READY\n","DEPENDENCY_CACHE_INVALID");}finally{await confirmRemoved(docker,seedName);}
   }
   const args=dockerArguments(options.image,name,source,helper,options.network,profile,cache);launched=true;
   const output=await trustedProcess(docker,args,{signal,timeoutMs:900_000,maxBytes:96*1024*1024,input:JSON.stringify({appId:job.appId,channel:job.channel,platform:job.platform,commitSha:job.commitSha,rootDirectory:job.rootDirectory,config:job.config,dependencyCache:!!cache,offline:!!cache||(options.network??"none")==="none"})});
   return decodeExport(output,{platform:job.platform,runtimeVersion:job.runtimeVersion,commitSha:job.commitSha});
  }catch(error){const code=error instanceof Error?error.message:"EXPORT_FAILED";throw new Error(["ARTIFACT_INVALID","CONFIG_CHANGED","ISOLATION_CLEANUP_UNCONFIRMED"].includes(code)?code:"EXPORT_FAILED");}
  finally{try{if(launched)await confirmRemoved(docker,name);}finally{await rm(helper,{recursive:true,force:true});if(preparation)await rm(preparation,{recursive:true,force:true});}}
 }};
}
