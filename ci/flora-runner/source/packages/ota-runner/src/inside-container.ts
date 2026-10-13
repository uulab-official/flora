/** Trusted entrypoint mounted read-only. This file never runs on the daemon host. */
import { cp, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { readExport, encodeExport, invariant } from "./artifacts.js";
import { processEnvironment, trustedProcess,npmConfigurationEnvironment,diagnosticLine,diagnosticCode } from "./process.js";
import { readExpoConnection, exportExpoProject } from "./expo.js";
import type { AutomationConfigSnapshot } from "@app-ops/dogfood";
let stage="configuration";
async function main(){
 let input="";for await(const chunk of process.stdin){input+=chunk.toString();invariant(Buffer.byteLength(input)<=16384);}const job=JSON.parse(input) as {appId:string;channel:string;platform:"ios"|"android";commitSha:string;rootDirectory:string;config:AutomationConfigSnapshot;dependencyCache?:boolean;offline?:boolean};
 invariant(job.config.toolchain.nodeVersion===process.versions.node,"CONFIG_CHANGED");
 stage="source-copy";await mkdir("/workspace/source",{recursive:true});await cp("/source","/workspace/source",{recursive:true,dereference:false,filter:path=>!path.split(sep).includes(".git")});
 const root=await realpath(join("/workspace/source",job.rootDirectory));invariant(root==="/workspace/source"||root.startsWith("/workspace/source/"));
 stage="configuration";const connection=job.config.bundler==="expo"?await readExpoConnection(root):undefined;
 const manager=job.config.toolchain.packageManager,name=manager.name, executable=join(dirname(process.execPath),name),env=processEnvironment({HOME:"/tmp",EXPO_NO_TELEMETRY:"1",EXPO_NO_DOTENV:"1",EXPO_OFFLINE:"1",npm_config_cache:"/workspace/cache/npm",...npmConfigurationEnvironment()});
 stage="npm-version";const version=(await trustedProcess(executable,["--version"],{cwd:root,env,maxBytes:8192,...(name==="npm"?{diagnostics:"npm" as const}:{})})).trim();invariant(version===manager.version,"CONFIG_CHANGED");
 const lock=name==="npm"?"package-lock.json":name==="pnpm"?"pnpm-lock.yaml":"yarn.lock";invariant((await stat(join(root,lock))).isFile());
 // Optional digest-pinned image includes an offline registry cache; absence never switches to host execution.
 stage="cache-copy";if(job.dependencyCache){await mkdir("/workspace/cache",{recursive:true});await cp("/dependency-cache","/workspace/cache/npm",{recursive:true,dereference:false});}
 else await cp("/opt/flora/cache","/workspace/cache",{recursive:true}).catch(()=>{});
 const install=name==="npm"?["ci","--no-audit","--no-fund",...(job.offline?["--offline"]:[])]:name==="pnpm"?["install","--frozen-lockfile","--store-dir","/workspace/cache/pnpm",...(job.offline?["--offline"]:[])]:Number(manager.version.split(".")[0])>=2?["install","--immutable"]:["install","--frozen-lockfile",...(job.offline?["--offline"]:[])];
 stage="npm-install";await trustedProcess(executable,install,{cwd:root,env,timeoutMs:600000,maxBytes:1024*1024,...(name==="npm"?{diagnostics:"npm" as const}:{})});
 stage="exporter";
 if(job.config.bundler==="expo"){
  await exportExpoProject(root,"/output",job,env,connection);
 }else{
  await trustedProcess(process.execPath,["/runner/scripts/metro-export.mjs",root,job.config.entryFile,job.platform,"/output"],{cwd:root,env,timeoutMs:300000,maxBytes:1024*1024});
 }
 stage="artifact-read";const exported=await readExport("/output",{platform:job.platform,runtimeVersion:job.config.runtimeVersion,commitSha:job.commitSha});process.stdout.write(encodeExport(exported));
}
void main().catch(error=>{process.stderr.write("FLORA_DIAGNOSTIC "+diagnosticLine(stage,diagnosticCode(error))+"\n");process.exitCode=1;});
