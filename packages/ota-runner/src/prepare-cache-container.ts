/** Trusted package-data-only preparation entrypoint. No repository JS/config/script enters this container. */
import { cp, mkdir, readdir, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { invariant } from "./artifacts.js";
import { HOSTED_NODE_VERSION, HOSTED_NPM_VERSION, NPM_REGISTRY } from "./dependencies.js";
import { processEnvironment, trustedProcess, npmConfigurationEnvironment,diagnosticLine,diagnosticCode,ProcessFailure } from "./process.js";
let stage="configuration";
async function main(){
 invariant(process.versions.node===HOSTED_NODE_VERSION,"CONFIG_CHANGED");
 const manager=process.argv[2]??"npm";invariant(manager==="npm"||manager==="pnpm","CONFIG_CHANGED");const pnpm=manager==="pnpm",helper=pnpm?await import("./pnpm-dependencies.js"):undefined;
 const progress=(next:string)=>{stage=next;if(pnpm)process.stderr.write("FLORA_DIAGNOSTIC "+diagnosticLine(stage)+"\n");};
 const npm=join(dirname(process.execPath),manager),cache=pnpm?"/workspace/cache/pnpm":"/workspace/cache",configuration=npmConfigurationEnvironment(),env=processEnvironment({HOME:"/tmp",...configuration,npm_config_cache:cache,npm_config_registry:NPM_REGISTRY});
 progress("npm-version");invariant((await trustedProcess(npm,["--version"],{env,maxBytes:8192,diagnostics:"npm"})).trim()===(helper?helper.PC_PNPM_VERSION:HOSTED_NPM_VERSION),"CONFIG_CHANGED");
 progress("source-copy");
 await mkdir("/workspace/seed",{recursive:true});await cp("/seed","/workspace/seed",{recursive:true,dereference:false});
 progress("npm-install");await trustedProcess(npm,helper?helper.pnpmInstallArguments(false):["ci","--ignore-scripts","--no-audit","--no-fund","--registry="+NPM_REGISTRY,"--userconfig="+configuration.npm_config_userconfig,"--globalconfig="+configuration.npm_config_globalconfig,"--cache="+cache],{cwd:"/workspace/seed",env,timeoutMs:600000,maxBytes:2*1024*1024,diagnostics:helper?"pnpm":"npm"});
 // npm has exited without launching lifecycle scripts. Validate a static cache
 // before copying it to the sole writable host bind, never unbounded downloads.
 progress("cache-validate");if(helper)await helper.preparePnpmCacheForTransfer(cache,"/workspace/seed");let bytes=0,entries=0;async function walk(directory:string):Promise<void>{for(const entry of await readdir(directory,{withFileTypes:true})){invariant(++entries<=(pnpm?120000:12000));const path=join(directory,entry.name),stat=await lstat(path);invariant(!stat.isSymbolicLink());if(stat.isDirectory())await walk(path);else{invariant(stat.isFile()&&stat.nlink===1);bytes+=stat.size;invariant(bytes<=1024*1024*1024);}}}await walk(cache);
 progress("cache-copy");
 for(const entry of await readdir(cache))await cp(join(cache,entry),join("/dependency-cache",entry),{recursive:true,dereference:false});
 process.stdout.write("FLORA_DEPENDENCY_CACHE_READY\n");
}
void main().catch(error=>{process.stderr.write("FLORA_DIAGNOSTIC "+diagnosticLine(stage,diagnosticCode(error),error instanceof ProcessFailure?error.pnpmProgress:undefined)+"\n");process.exitCode=1;});
