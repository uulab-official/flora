import {statfs} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
export const minimumFreeBytes=2n*1024n*1024n*1024n;
// No output from the daemon is retained: availability is determined by exit status only.
export function dockerAvailable(env,signal,{timeoutMs=10000,spawnProcess=spawn}={}){return new Promise(resolve=>{
 if(signal.aborted){resolve(false);return;}
 let child,finished=false,timer;
 const finish=value=>{if(finished)return;finished=true;clearTimeout(timer);signal.removeEventListener('abort',stop);resolve(value);};
 // Settle first: kill may emit close synchronously, throw, or never emit close.
 const stop=()=>{finish(false);try{child?.kill('SIGKILL');}catch{}try{child?.unref();}catch{}};
 const onError=()=>finish(false);
 const onClose=code=>{finish(code===0&&!signal.aborted);child.removeListener('error',onError);child.removeListener('close',onClose);};
 try{child=spawnProcess('docker',['info','--format','{{.ServerVersion}}'],{env,stdio:'ignore'});}catch{finish(false);return;}
 // Keep the safe error handler until close so late spawn/kill errors cannot escape.
 child.on('error',onError);child.once('close',onClose);
 signal.addEventListener('abort',stop,{once:true});timer=setTimeout(stop,timeoutMs);if(signal.aborted)stop();
 });}
export async function checkHealth(c,{env,signal,filesystem=statfs,docker=dockerAvailable}={}){
 for(const path of [c.runtimeDirectory,join(c.runtimeDirectory,'scratch')]){
  if(signal.aborted)return {ok:false,code:'DISK_SPACE_UNAVAILABLE'};
  try{const s=await filesystem(path,{bigint:true});if(typeof s.bavail!=='bigint'||typeof s.bsize!=='bigint'||s.bavail<0n||s.bsize<=0n)return {ok:false,code:'DISK_SPACE_UNAVAILABLE'};if(s.bavail*s.bsize<minimumFreeBytes)return {ok:false,code:'DISK_SPACE_LOW'};}catch{return {ok:false,code:'DISK_SPACE_UNAVAILABLE'};}
 }
 try{if(!await docker(env,signal))return {ok:false,code:'ISOLATION_UNAVAILABLE'};}catch{return {ok:false,code:'ISOLATION_UNAVAILABLE'};}
 return {ok:true};
}
