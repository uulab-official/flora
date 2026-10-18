import fs from "node:fs/promises";
import { resolve,join,isAbsolute,dirname } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { requireSetup } from "./contracts.js";
export interface SetupRuntime {root:string;nodePath:string;wranglerEntry:string;dockerPath:string;supervisorMain:string}
export async function resolveSetupRuntime(root:string):Promise<SetupRuntime>{
  requireSetup(process.versions.node==="24.19.0" && isAbsolute(root),"SETUP_TOOLCHAIN_REQUIRED");
  const canonical=await fs.realpath(root),req=createRequire(join(canonical,"packages/cloudflare/package.json"));
  const pkgPath=req.resolve("wrangler/package.json"),pkg=JSON.parse(await fs.readFile(pkgPath,"utf8"));
  requireSetup(pkg.version==="4.148.0","SETUP_WRANGLER_VERSION_REQUIRED");
  const supervisorMain=join(canonical,"scripts/local-runner/supervisor.mjs");await fs.access(supervisorMain);
  let dockerPath="";
  for(const directory of (process.env.PATH??"").split(":")){
    if(!isAbsolute(directory))continue;
    try{const candidate=await fs.realpath(join(directory,"docker"));await fs.access(candidate,fs.constants.X_OK);dockerPath=candidate;break;}catch{}
  }
  // Resolve provider mode without requiring Docker. Runner mode rejects this absence.
  return {root:canonical,nodePath:await fs.realpath(process.execPath),wranglerEntry:resolve(dirname(pkgPath),"bin/wrangler.js"),dockerPath,supervisorMain};
}
export function runBoundedTool(executable:string,args:readonly string[],options:{cwd:string;timeoutMs:number;maxBytes:number;signal:AbortSignal}):Promise<{exitCode:number;stdout:string}>{
  return new Promise((resolve,reject)=>{
    if(!isAbsolute(executable)||!isAbsolute(options.cwd)||options.signal.aborted||!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1||!Number.isSafeInteger(options.maxBytes)||options.maxBytes<1){reject(new Error("SETUP_TOOL_INVALID"));return;}
    const env:NodeJS.ProcessEnv={WRANGLER_SEND_METRICS:"false"};
    for(const key of ["PATH","HOME","XDG_CONFIG_HOME","XDG_CACHE_HOME","TMPDIR","LANG","LC_ALL"]){const value=process.env[key];if(value!==undefined)env[key]=value;}
    const child=spawn(executable,[...args],{cwd:options.cwd,env,shell:false,detached:process.platform!=="win32",stdio:["ignore","pipe","pipe"]});
    let bytes=0,output="",finished=false;let timer:ReturnType<typeof setTimeout>;
    const stop=(code:string)=>{
      if(finished)return;
      try{if(process.platform!=="win32"&&child.pid)process.kill(-child.pid,"SIGKILL");else child.kill("SIGKILL");}catch{}
      finish(code);
    };
    const abort=()=>stop("SETUP_CANCELLED");
    const finish=(error:string|null)=>{if(finished)return;finished=true;clearTimeout(timer);options.signal.removeEventListener("abort",abort);if(error){output="";reject(new Error(error));}else resolve({exitCode:0,stdout:output});};
    timer=setTimeout(()=>stop("SETUP_TOOL_TIMEOUT"),options.timeoutMs);options.signal.addEventListener("abort",abort,{once:true});
    const collect=(chunk:Buffer,stdout:boolean)=>{if(finished)return;bytes+=chunk.length;if(bytes>options.maxBytes){stop("SETUP_TOOL_OUTPUT_LIMIT");return;}if(stdout)output+=chunk.toString("utf8");};
    child.stdout.on("data",(b:Buffer)=>collect(b,true));child.stderr.on("data",(b:Buffer)=>collect(b,false));
    child.once("error",()=>finish("SETUP_TOOL_UNAVAILABLE"));child.once("close",code=>finish(code===0?null:"SETUP_TOOL_FAILED"));
  });
}
