/** Trusted npm-only preparation entrypoint. No repository JS/config/script enters this container. */
import { cp, mkdir, readdir, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { invariant } from "./artifacts.js";
import { HOSTED_NODE_VERSION, HOSTED_NPM_VERSION, NPM_REGISTRY } from "./dependencies.js";
import { processEnvironment, trustedProcess, npmConfigurationEnvironment,diagnosticLine,diagnosticCode } from "./process.js";
let stage="configuration";
async function main(){
 invariant(process.versions.node===HOSTED_NODE_VERSION,"CONFIG_CHANGED");
 const npm=join(dirname(process.execPath),"npm"),cache="/workspace/cache",configuration=npmConfigurationEnvironment(),env=processEnvironment({HOME:"/tmp",...configuration,npm_config_cache:cache,npm_config_registry:NPM_REGISTRY});
 stage="npm-version";invariant((await trustedProcess(npm,["--version"],{env,maxBytes:8192,diagnostics:"npm"})).trim()===HOSTED_NPM_VERSION,"CONFIG_CHANGED");
 stage="source-copy";
 await mkdir("/workspace/seed",{recursive:true});await cp("/seed","/workspace/seed",{recursive:true,dereference:false});
 stage="npm-install";await trustedProcess(npm,["ci","--ignore-scripts","--no-audit","--no-fund","--registry="+NPM_REGISTRY,"--userconfig="+configuration.npm_config_userconfig,"--globalconfig="+configuration.npm_config_globalconfig,"--cache="+cache],{cwd:"/workspace/seed",env,timeoutMs:600000,maxBytes:2*1024*1024,diagnostics:"npm"});
 // npm has exited without launching lifecycle scripts. Validate a static cache
 // before copying it to the sole writable host bind, never unbounded downloads.
 stage="cache-validate";let bytes=0,entries=0;async function walk(directory:string):Promise<void>{for(const entry of await readdir(directory,{withFileTypes:true})){invariant(++entries<=12000);const path=join(directory,entry.name),stat=await lstat(path);invariant(!stat.isSymbolicLink());if(stat.isDirectory())await walk(path);else{invariant(stat.isFile()&&stat.nlink===1);bytes+=stat.size;invariant(bytes<=1024*1024*1024);}}}await walk(cache);
 stage="cache-copy";
 for(const entry of await readdir(cache))await cp(join(cache,entry),join("/dependency-cache",entry),{recursive:true,dereference:false});
 process.stdout.write("FLORA_DEPENDENCY_CACHE_READY\n");
}
void main().catch(error=>{process.stderr.write("FLORA_DIAGNOSTIC "+diagnosticLine(stage,diagnosticCode(error))+"\n");process.exitCode=1;});
