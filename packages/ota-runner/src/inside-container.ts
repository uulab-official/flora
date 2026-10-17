/** Trusted entrypoint mounted read-only. This file never runs on the daemon host. */
import { cp, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { readExport, encodeExport, invariant,CONTAINER_EXPORT_DIRECTORY } from "./artifacts.js";
import { processEnvironment, trustedProcess,npmConfigurationEnvironment,diagnosticLine,diagnosticCode,ProcessFailure } from "./process.js";
import { readExpoConnection, exportExpoProject } from "./expo.js";
import type { AutomationConfigSnapshot } from "@app-ops/dogfood";
let stage="configuration";
async function main(){
 let input="";for await(const chunk of process.stdin){input+=chunk.toString();invariant(Buffer.byteLength(input)<=16384);}const job=JSON.parse(input) as {appId:string;channel:string;platform:"ios"|"android";commitSha:string;rootDirectory:string;config:AutomationConfigSnapshot;dependencyCache?:boolean;offline?:boolean;dependencyPreparation?:"pnpm-registry"};
 const progress=(next:string)=>{stage=next;if(job.dependencyPreparation==="pnpm-registry")process.stderr.write("FLORA_DIAGNOSTIC "+diagnosticLine(stage)+"\n");};
 invariant(job.config.toolchain.nodeVersion===process.versions.node,"CONFIG_CHANGED");
 progress("source-copy");await mkdir("/workspace/source",{recursive:true});await cp("/source","/workspace/source",{recursive:true,dereference:false,filter:path=>!path.split(sep).includes(".git")});
 const root=await realpath(join("/workspace/source",job.rootDirectory));invariant(root==="/workspace/source"||root.startsWith("/workspace/source/"));
 progress("configuration");const connection=job.config.bundler==="expo"?await readExpoConnection(root):undefined;
 const manager=job.config.toolchain.packageManager,name=manager.name, executable=join(dirname(process.execPath),name),env=processEnvironment({HOME:"/tmp",EXPO_NO_TELEMETRY:"1",EXPO_NO_DOTENV:"1",EXPO_OFFLINE:"1",npm_config_cache:"/workspace/cache/npm",...npmConfigurationEnvironment()});
 progress("npm-version");const version=(await trustedProcess(executable,["--version"],{cwd:root,env,maxBytes:8192,...(name==="npm"?{diagnostics:"npm" as const}:{})})).trim();invariant(version===manager.version,"CONFIG_CHANGED");
 const pnpm=job.dependencyPreparation==="pnpm-registry";invariant(!pnpm||name==="pnpm"&&manager.version==="11.10.0"&&job.offline&&job.dependencyCache,"CONFIG_CHANGED");
 const pnpmHelper=pnpm?await import("./pnpm-dependencies.js"):undefined,installRoot=pnpmHelper?await pnpmHelper.pnpmInstallRoot("/workspace/source",job.rootDirectory):root;
 const lock=name==="npm"?"package-lock.json":name==="pnpm"?"pnpm-lock.yaml":"yarn.lock";invariant((await stat(join(installRoot,lock))).isFile());
 // Optional digest-pinned image includes an offline registry cache; absence never switches to host execution.
 progress("cache-copy");if(job.dependencyCache){await mkdir("/workspace/cache",{recursive:true});if(pnpmHelper)await pnpmHelper.copyPnpmCacheForCompilation("/dependency-cache","/workspace/cache/pnpm");else await cp("/dependency-cache","/workspace/cache/npm",{recursive:true,dereference:false});}
 else await cp("/opt/flora/cache","/workspace/cache",{recursive:true}).catch(()=>{});
 const install=name==="npm"?["ci","--no-audit","--no-fund",...(job.offline?["--offline"]:[])]:name==="pnpm"?pnpmHelper?pnpmHelper.pnpmInstallArguments(true):["install","--frozen-lockfile","--store-dir","/workspace/cache/pnpm",...(job.offline?["--offline"]:[])]:Number(manager.version.split(".")[0])>=2?["install","--immutable"]:["install","--frozen-lockfile",...(job.offline?["--offline"]:[])];
 progress("npm-install");await trustedProcess(executable,install,{cwd:installRoot,env,timeoutMs:600000,maxBytes:1024*1024,...(pnpmHelper?{diagnostics:"pnpm" as const}:name==="npm"?{diagnostics:"npm" as const}:{})});
 progress("exporter");
 if(job.config.bundler==="expo"){
  await exportExpoProject(root,CONTAINER_EXPORT_DIRECTORY,job,env,connection);
 }else{
  await trustedProcess(process.execPath,["/runner/scripts/metro-export.mjs",root,job.config.entryFile,job.platform,CONTAINER_EXPORT_DIRECTORY],{cwd:root,env,timeoutMs:300000,maxBytes:1024*1024});
 }
 progress("artifact-read");const exported=await readExport(CONTAINER_EXPORT_DIRECTORY,{platform:job.platform,runtimeVersion:job.config.runtimeVersion,commitSha:job.commitSha});process.stdout.write(encodeExport(exported));
}
void main().catch(error=>{const child=error instanceof ProcessFailure?error.containerDiagnostic:undefined;process.stderr.write("FLORA_DIAGNOSTIC "+diagnosticLine(child?.stage??stage,child?.code??diagnosticCode(error),child?.pnpmProgress??(error instanceof ProcessFailure?error.pnpmProgress:undefined))+"\n");process.exitCode=1;});
