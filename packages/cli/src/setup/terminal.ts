import type { ReadStream } from "node:tty";
import type { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import type { SetupResult } from "./contracts.js";
export interface SetupIO {
  notice(message:string):void;
  choose(label:string,choices:readonly string[]):Promise<string>;
  readPublic(label:string):Promise<string>;
  readSecret(label:string,signal:AbortSignal):Promise<string>;
  confirm(summary:string):Promise<boolean>;
  report(result:SetupResult):void;
}
/** The caller validates token syntax. Preserve spaces; remove line framing only. */
export function readSecret(input:ReadStream,output:Writable,label:string,signal:AbortSignal):Promise<string>{
  return new Promise((resolve,reject)=>{
    if(!input.isTTY || typeof input.setRawMode!=="function" || signal.aborted){reject(new Error("SETUP_SECRET_TTY_REQUIRED"));return;}
    const raw=input.isRaw===true,paused=input.readableFlowing!==true;let bytes=Buffer.alloc(0),done=false;
    const finish=(code:string|null,value="")=>{
      if(done)return;done=true;
      input.off("data",data);input.off("end",end);input.off("close",end);input.off("error",end);signal.removeEventListener("abort",abort);
      try{input.setRawMode(raw);if(paused)input.pause();output.write("\n");}catch{code="SETUP_TTY_RESTORE_FAILED";}
      bytes.fill(0);bytes=Buffer.alloc(0);
      if(code)reject(new Error(code));else resolve(value);
    };
    const end=()=>finish("SETUP_CANCELLED"),abort=()=>finish("SETUP_CANCELLED");
    const data=(chunk:Buffer|string)=>{
      bytes=Buffer.concat([bytes,Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)]);
      if(bytes.length>4096){finish("SETUP_SECRET_TOO_LONG");return;}
      if(bytes.includes(3)||bytes.includes(4)){finish("SETUP_CANCELLED");return;}
      const line=bytes.findIndex(b=>b===10||b===13);
      if(line>=0){
        const tail=bytes.subarray(line).toString("utf8");
        if(!["\n","\r","\r\n"].includes(tail)){finish("SETUP_SECRET_INVALID_FRAMING");return;}
        finish(null,bytes.subarray(0,line).toString("utf8"));
      }
    };
    try{
      input.setRawMode(true);input.on("data",data);input.once("end",end);input.once("close",end);input.once("error",end);signal.addEventListener("abort",abort,{once:true});
      output.write(label);input.resume();
    }catch{finish("SETUP_TTY_FAILED");}
  });
}
export function createSetupIO(output:Writable=process.stdout):SetupIO{
  const readPublic=async(label:string)=>{
    if(!process.stdin.isTTY)throw new Error("SETUP_TTY_REQUIRED");
    const rl=createInterface({input:process.stdin,output,terminal:true});
    try{return await rl.question(label+": ");}finally{rl.close();}
  };
  return {
    readPublic,
    notice:message=>{output.write(message+"\n");},
    async choose(label,choices){const selected=await readPublic(label+" ["+choices.join(" / ")+"]");if(!choices.includes(selected))throw new Error("SETUP_CHOICE_INVALID");return selected;},
    readSecret:(label,signal)=>readSecret(process.stdin,output,label,signal),
    confirm:async summary=>(await readPublic(summary+" [yes/no]"))==="yes",
    report:result=>{output.write(JSON.stringify(result)+"\n");},
  };
}
