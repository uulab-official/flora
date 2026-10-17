#!/usr/bin/env node
import {readNativeConfig,runNativeDaemon,runNativeJob} from "./native-controller.js";
import {createNativeClient} from "./native-client.js";
const args=process.argv.slice(2),controller=new AbortController();process.once("SIGINT",()=>controller.abort());process.once("SIGTERM",()=>controller.abort());
try{
 const paths:string[]=[];let daemon=false,jobId:string|undefined;
 for(let index=0;index<args.length;index++){const arg=args[index];if(arg==="--config"&&args[index+1])paths.push(args[++index]!);else if(arg==="--daemon"&&!daemon)daemon=true;else if(arg==="--job"&&!jobId&&args[index+1])jobId=args[++index];else throw new Error("INVALID_NATIVE_CONFIG");}
 if(!paths.length||new Set(paths).size!==paths.length||daemon&&jobId||!daemon&&(paths.length!==1||!jobId||!/^[a-z][a-z0-9_-]{2,95}$/.test(jobId)))throw new Error("INVALID_NATIVE_CONFIG");
 const entries=[];for(const path of paths){const config=await readNativeConfig(path);entries.push({config,client:createNativeClient(config)});}
 if(daemon){await runNativeDaemon(entries,{signal:controller.signal,diagnostics:true});process.stdout.write(JSON.stringify({state:"stopped",code:"NATIVE_CANCELLED"})+"\n");}
 else{const {config,client}=entries[0]!;await client.presence();const artifact=await runNativeJob(config,client,jobId!,{signal:controller.signal,diagnostics:true});process.stdout.write(JSON.stringify({state:"succeeded",jobId,appId:config.appId,...artifact})+"\n");}
}catch(error){const code=error instanceof Error&&["NATIVE_COMPLETION_UNKNOWN","NATIVE_COMPLETION_RECONCILIATION_REQUIRED","NATIVE_RUNNERS_DISABLED","ISOLATION_UNAVAILABLE","INVALID_NATIVE_CONFIG","NATIVE_CANCELLED"].includes(error.message)?error.message:controller.signal.aborted?"NATIVE_CANCELLED":"NATIVE_BUILD_FAILED";process.stderr.write(JSON.stringify({state:code==="NATIVE_COMPLETION_UNKNOWN"?"completion_unknown":code==="NATIVE_COMPLETION_RECONCILIATION_REQUIRED"?"attention":"failed",code})+"\n");process.exitCode=1;}
