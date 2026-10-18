import {setupRunner} from "./setup/runner.js";
import {createProvisionHandlers} from "./setup/provision.js";
import { isAbsolute } from "node:path";
import type { SetupResult } from "./setup/contracts.js";
import { createSetupIO, type SetupIO } from "./setup/terminal.js";
export interface SetupCommandDeps {
  newInstall(io:SetupIO,signal:AbortSignal):Promise<SetupResult>;
  existing(io:SetupIO,signal:AbortSignal):Promise<SetupResult>;
  runner(io:SetupIO,signal:AbortSignal):Promise<SetupResult>;
  resume(path:string,io:SetupIO,signal:AbortSignal):Promise<SetupResult>;
  renew(path:string,io:SetupIO,signal:AbortSignal):Promise<SetupResult>;
  inspect(path:string,io:SetupIO,signal:AbortSignal):Promise<SetupResult>;
}
export async function runSetupCommand(argv:readonly string[],io:SetupIO=createSetupIO(),deps:SetupCommandDeps={...createProvisionHandlers(),runner:setupRunner}):Promise<number>{
  const controller=new AbortController(),cancel=()=>controller.abort();process.once("SIGINT",cancel);
  try{
    let result:SetupResult;
    if(argv.length===0){const mode=await io.choose("Flora setup",["new","existing","runner"]);if(!["new","existing","runner"].includes(mode))throw Error("SETUP_CHOICE_INVALID");result=await deps[mode==="new"?"newInstall":mode as "existing"|"runner"](io,controller.signal);}
    else if(argv.length===1&&argv[0]==="runner")result=await deps.runner(io,controller.signal);
    else if(argv.length===2&&argv[0]==="--resume"&&argv[1]&&isAbsolute(argv[1]))result=await deps.resume(argv[1],io,controller.signal);
    else if(argv.length===3&&argv[0]==="renew"&&argv[1]==="--state"&&argv[2]&&isAbsolute(argv[2]))result=await deps.renew(argv[2],io,controller.signal);
    else if(argv.length===4&&argv[0]==="inspect"&&argv[1]==="--state"&&argv[2]&&isAbsolute(argv[2])&&argv[3]==="--json")result=await deps.inspect(argv[2],io,controller.signal);
    else {io.report({state:"needs-operator",code:"SETUP_USAGE_ERROR"});return 2;}
    io.report(result);return result.state==="cancelled"?130:result.state==="unknown"?1:0;
  }catch(error){const cancelled=controller.signal.aborted||(error instanceof Error && error.message==="SETUP_CANCELLED");io.report({state:cancelled?"cancelled":"needs-operator",code:cancelled?"SETUP_CANCELLED":"SETUP_OPERATION_FAILED"});return cancelled?130:1;}
  finally{process.off("SIGINT",cancel);}
}
