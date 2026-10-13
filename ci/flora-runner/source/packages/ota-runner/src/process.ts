import { spawn } from "node:child_process";
import { delimiter, isAbsolute } from "node:path";
export function processEnvironment(extra: Record<string,string> = {}): Record<string,string> {
 const path = (process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(delimiter).filter(isAbsolute).join(delimiter);
 return { PATH:path, LANG:"C.UTF-8", CI:"1", ...extra };
}
export async function trustedProcess(executable: string, args: readonly string[], options: {cwd?:string;env?:Record<string,string>;signal?:AbortSignal;timeoutMs?:number;maxBytes?:number;input?:string} = {}): Promise<string> {
 const controller = new AbortController(), timeout=setTimeout(()=>controller.abort(),options.timeoutMs ?? 60_000);
 const cancel=()=>controller.abort(); options.signal?.addEventListener("abort",cancel,{once:true}); if(options.signal?.aborted)controller.abort();
 let child:ReturnType<typeof spawn>|undefined;
 try {
  return await new Promise<string>((resolve,reject)=>{
   let size=0, failed=false, finished=false; const parts:Buffer[]=[];
   const kill=()=>{if(child?.pid){try {if(process.platform!=="win32")process.kill(-child.pid,"SIGKILL");else child.kill("SIGKILL");}catch{}}};
   // Drain the child close event before returning to a caller that removes its
   // source directory or verifies Docker cleanup. SIGKILL alone is not an exit.
   const fail=()=>{if(!finished&&!failed){failed=true;kill();}};
   child=spawn(executable,[...args],{...(options.cwd?{cwd:options.cwd}:{}),env:options.env ?? processEnvironment(),stdio:["pipe","pipe","pipe"],detached:process.platform!=="win32",windowsHide:true});
   controller.signal.addEventListener("abort",fail,{once:true});
   const append=(part:Buffer,stdout:boolean)=>{if(failed)return;size+=part.length;if(size>(options.maxBytes??1024*1024)){fail();return;}if(stdout)parts.push(part);};
   child.stdout!.on("data",part=>append(part,true));child.stderr!.on("data",part=>append(part,false)); child.on("error",fail);
   child.on("close",code=>{controller.signal.removeEventListener("abort",fail);if(!finished){finished=true;if(code===0&&!failed&&!controller.signal.aborted)resolve(Buffer.concat(parts).toString("utf8"));else reject(new Error("EXECUTION_FAILED"));}});
   child.stdin!.on("error",()=>{});child.stdin!.end(options.input ?? ""); if(controller.signal.aborted)fail();
  });
 } finally {clearTimeout(timeout);options.signal?.removeEventListener("abort",cancel);}
}
