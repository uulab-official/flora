import { spawn } from "node:child_process";
import { delimiter, isAbsolute, join } from "node:path";
const npmCodes=["ERESOLVE","EINTEGRITY","ENOTCACHED","ELOCKVERIFY","EUSAGE","ENOENT","EACCES","ECONNRESET","ETIMEDOUT","ENOSPC","ENOMEM","EBADENGINE","EUNSUPPORTEDPROTOCOL","E401","E403","E404","E500","ENETUNREACH"];
const pnpmCodes=["ERR_PNPM_META_FETCH_FAIL","ERR_PNPM_NO_OFFLINE_TARBALL","ERR_PNPM_NO_OFFLINE_META","ERR_PNPM_TARBALL_INTEGRITY","ERR_PNPM_LOCKFILE_CONFIG_MISMATCH","ERR_PNPM_OUTDATED_LOCKFILE","ERR_PNPM_PATCH_NOT_APPLIED","ERR_PNPM_FROZEN_STORE_NEEDS_BUILD","ERR_PNPM_FROZEN_STORE_INCOMPLETE"];
const safeCodes=new Set(["EXECUTION_FAILED","CONFIG_CHANGED","ARTIFACT_INVALID","SOURCE_UNAVAILABLE","ISOLATION_UNAVAILABLE","DEPENDENCY_CACHE_INVALID","PROCESS_TIMEOUT","PROCESS_CANCELLED","PROCESS_OUTPUT_LIMIT","PROCESS_SPAWN_FAILED","NPM_CONFIG_DUPLICATE","EXPO_EXECUTION_DENIED","EXPO_MODULE_MISSING","EXPO_WORKER_LIMIT","EXPO_OUTPUT_BUSY","PNPM_TIMEOUT_IMPORTING","PNPM_TIMEOUT_AFTER_IMPORT",...pnpmCodes,...npmCodes.map(code=>"NPM_"+code)]);
const childStages=["configuration","source-copy","npm-version","npm-install","cache-validate","cache-copy","exporter","expo-config","expo-export","artifact-read"];
const safeStages=new Set(["execution","source-verified","dependency-seed","dependency-preparation","compiler","artifact-verified",...childStages,...childStages.map(stage=>"dependency-preparation-"+stage),...childStages.map(stage=>"compiler-"+stage)]);
export interface PNPMProgress {resolved:number;reused:number;downloaded:number;added:number;done:boolean}
function validProgress(input:unknown):input is PNPMProgress{if(!input||typeof input!=="object"||Array.isArray(input))return false;const p=input as Record<string,unknown>;return Object.keys(p).length===5&&["resolved","reused","downloaded","added"].every(k=>Number.isInteger(p[k])&&(p[k] as number)>=0&&(p[k] as number)<=2500)&&typeof p.done==="boolean";}
function pnpmProgress(stdout:string):PNPMProgress|undefined{let found:PNPMProgress|undefined;for(const line of stdout.replace(/\x1b\[[0-9;]*m/g,"").split(/\r?\n/)){const m=/^Progress: resolved (\d{1,4}), reused (\d{1,4}), downloaded (\d{1,4}), added (\d{1,4})(, done)?$/.exec(line.trim());if(m){const p={resolved:Number(m[1]),reused:Number(m[2]),downloaded:Number(m[3]),added:Number(m[4]),done:!!m[5]};if(validProgress(p))found=p;}}return found;}
export interface SafeDiagnostic {diagnostic:true;stage:string;code?:string;pnpmProgress?:PNPMProgress}
export function diagnosticLine(stage:string,code?:string,progress?:PNPMProgress):string{return JSON.stringify({diagnostic:true,stage:safeStages.has(stage)?stage:"execution",...(code?{code:safeCodes.has(code)?code:"EXECUTION_FAILED"}:{}),...(progress&&validProgress(progress)?{pnpmProgress:progress}:{})});}
export function npmConfigurationEnvironment(directory="/runner/config"):Record<string,string>{return {npm_config_userconfig:join(directory,"npm-user.rc"),npm_config_globalconfig:join(directory,"npm-global.rc")};}
export class ProcessFailure extends Error{constructor(readonly safeCode:string,readonly containerDiagnostic?:SafeDiagnostic,readonly pnpmProgress?:PNPMProgress){super("EXECUTION_FAILED");}}
export function diagnosticCode(error:unknown):string{if(error instanceof ProcessFailure)return error.safeCode;const code=error instanceof Error?error.message:"EXECUTION_FAILED";return safeCodes.has(code)?code:"EXECUTION_FAILED";}
function childDiagnostic(stderr:string):SafeDiagnostic|undefined{
 let found:SafeDiagnostic|undefined;for(const line of stderr.split(/\r?\n/)){if(!line.startsWith("FLORA_DIAGNOSTIC ")||line.length>512)continue;try{const raw=JSON.parse(line.slice(17)) as Record<string,unknown>,keys=Object.keys(raw);if(raw.diagnostic!==true||typeof raw.stage!=="string"||!childStages.includes(raw.stage))continue;if(keys.length===2&&keys.includes("diagnostic")&&keys.includes("stage"))found={diagnostic:true,stage:raw.stage};else if(typeof raw.code==="string"&&safeCodes.has(raw.code)&&(keys.length===3||keys.length===4&&validProgress(raw.pnpmProgress)))found={diagnostic:true,stage:raw.stage,code:raw.code,...(validProgress(raw.pnpmProgress)?{pnpmProgress:raw.pnpmProgress}:{})};}catch{}}
 return found;
}
function failure(reason:string,stderr:string,diagnostics?:"npm"|"container"|"expo"|"pnpm",stdout=""):ProcessFailure{
 const code=reason==="timeout"?"PROCESS_TIMEOUT":reason==="cancelled"?"PROCESS_CANCELLED":reason==="output"?"PROCESS_OUTPUT_LIMIT":reason==="spawn"?"PROCESS_SPAWN_FAILED":"EXECUTION_FAILED";
 if(diagnostics==="pnpm"){const output=stderr+"\n"+stdout;if(reason==="timeout"){const progress=pnpmProgress(output);if(progress)return new ProcessFailure(progress.done?"PNPM_TIMEOUT_AFTER_IMPORT":"PNPM_TIMEOUT_IMPORTING",undefined,progress);}if(reason==="exit"){for(const code of pnpmCodes)if(new RegExp("\\b"+code+"\\b").test(output))return new ProcessFailure(code);}}
 if(diagnostics==="npm"&&reason==="exit"){
  if(/double-loading config [^\n]{1,256} as [^\n]{1,128} previously loaded as/.test(stderr))return new ProcessFailure("NPM_CONFIG_DUPLICATE");
  const match=/npm (?:error|ERR!) code ([A-Z][A-Z0-9_]{0,63})(?:\r?\n|$)/.exec(stderr);if(match&&npmCodes.includes(match[1]!))return new ProcessFailure("NPM_"+match[1]);
 }
 if(diagnostics==="expo"&&reason==="exit"){
  if(/\bEBUSY\b/.test(stderr))return new ProcessFailure("EXPO_OUTPUT_BUSY");
  if(/\bEACCES\b|failed to map segment from shared object/.test(stderr))return new ProcessFailure("EXPO_EXECUTION_DENIED");
  if(/Cannot find module|Failed to resolve plugin|\bMODULE_NOT_FOUND\b/.test(stderr))return new ProcessFailure("EXPO_MODULE_MISSING");
  if(/\bEAGAIN\b|ERR_WORKER_INIT_FAILED/.test(stderr))return new ProcessFailure("EXPO_WORKER_LIMIT");
 }
 return new ProcessFailure(code,diagnostics==="container"?childDiagnostic(stderr):undefined);
}
export function processEnvironment(extra: Record<string,string> = {}): Record<string,string> {
 const path = (process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(delimiter).filter(isAbsolute).join(delimiter);
 return { PATH:path, LANG:"C.UTF-8", CI:"1", ...extra };
}
export async function trustedProcess(executable: string, args: readonly string[], options: {cwd?:string;env?:Record<string,string>;signal?:AbortSignal;timeoutMs?:number;maxBytes?:number;input?:string;diagnostics?:"npm"|"container"|"expo"|"pnpm"} = {}): Promise<string> {
 let reason="exit";const controller = new AbortController(), timeout=setTimeout(()=>{reason="timeout";controller.abort();},options.timeoutMs ?? 60_000);
 const cancel=()=>{reason="cancelled";controller.abort();}; options.signal?.addEventListener("abort",cancel,{once:true}); if(options.signal?.aborted)cancel();
 let child:ReturnType<typeof spawn>|undefined;
 try {
  return await new Promise<string>((resolve,reject)=>{
   let size=0, failed=false, finished=false,stderr=""; const parts:Buffer[]=[];
   const kill=()=>{if(child?.pid){try {if(process.platform!=="win32")process.kill(-child.pid,"SIGKILL");else child.kill("SIGKILL");}catch{}}};
   // Drain the child close event before returning to a caller that removes its
   // source directory or verifies Docker cleanup. SIGKILL alone is not an exit.
   const fail=()=>{if(!finished&&!failed){failed=true;kill();}};
   child=spawn(executable,[...args],{...(options.cwd?{cwd:options.cwd}:{}),env:options.env ?? processEnvironment(),stdio:["pipe","pipe","pipe"],detached:process.platform!=="win32",windowsHide:true});
   controller.signal.addEventListener("abort",fail,{once:true});
   const append=(part:Buffer,stdout:boolean)=>{if(failed)return;size+=part.length;if(size>(options.maxBytes??1024*1024)){reason="output";fail();return;}if(stdout)parts.push(part);else if(options.diagnostics)stderr=(stderr+part.toString("utf8")).slice(-16384);};
   child.stdout!.on("data",part=>append(part,true));child.stderr!.on("data",part=>append(part,false)); child.on("error",()=>{reason="spawn";fail();});
   child.on("close",code=>{controller.signal.removeEventListener("abort",fail);if(!finished){finished=true;if(code===0&&!failed&&!controller.signal.aborted)resolve(Buffer.concat(parts).toString("utf8"));else reject(failure(reason,stderr,options.diagnostics,options.diagnostics==="pnpm"?Buffer.concat(parts).toString("utf8").slice(-65536):""));}});
   child.stdin!.on("error",()=>{});child.stdin!.end(options.input ?? ""); if(controller.signal.aborted)fail();
  });
 } finally {clearTimeout(timeout);options.signal?.removeEventListener("abort",cancel);}
}
