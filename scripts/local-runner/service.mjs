#!/usr/bin/env node
import {mkdir,writeFile,lstat,readFile,unlink,chmod} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {readConfig,privatePath,fatalStatus} from './supervisor.mjs';
export const label='kr.co.uulab.flora-runner';
const escape=v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function plist(c,configPath,supervisorPath){return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${label}</string>\n<key>ProgramArguments</key><array>${[c.nodePath,supervisorPath,configPath].map(v=>'<string>'+escape(v)+'</string>').join('')}</array>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>30</integer>\n<key>ExitTimeOut</key><integer>40</integer>\n<key>WorkingDirectory</key><string>${escape(c.runtimeDirectory)}</string>\n<key>EnvironmentVariables</key><dict>${Object.entries({PATH:c.path,LIMA_HOME:c.limaHome,DOCKER_HOST:c.dockerHost,TMPDIR:join(c.runtimeDirectory,'scratch'),HOME:process.env.HOME}).map(([k,v])=>`<key>${k}</key><string>${escape(v)}</string>`).join('')}</dict>\n</dict></plist>\n`;}
export function parseLaunchStatus(result){
 if(result.status!==0)return result.status===113?{state:'stopped',loaded:false}:{state:'unknown',loaded:false,code:'SERVICE_STATUS_UNAVAILABLE'};
 if(typeof result.stdout!=='string'||Buffer.byteLength(result.stdout)>262144)return {state:'unknown',loaded:true,code:'SERVICE_STATUS_UNAVAILABLE'};
 let depth=0,state,pid,invalid=false;
 for(const line of result.stdout.split('\n')){if(depth===1){const match=line.match(/^\s*(state|pid) = (.*?)\s*$/);if(match){if(match[1]==='state'){if(state!==undefined)invalid=true;state=match[2];}else{if(pid!==undefined)invalid=true;pid=/^[1-9][0-9]{0,9}$/.test(match[2])?Number(match[2]):null;}}}if(line.trim().endsWith('{'))depth++;if(line.trim()==='}')depth--;if(depth<0)invalid=true;}
 if(!invalid&&depth===0&&state==='running'&&Number.isSafeInteger(pid)&&pid>0&&pid<=2147483647)return {state:'running',loaded:true,pid};
 if(!invalid&&depth===0&&['not running','waiting','exited'].includes(state)&&pid===undefined)return {state:'loaded-idle',loaded:true};
 return {state:'unknown',loaded:true,code:'SERVICE_STATUS_UNAVAILABLE'};
}
export async function lifecycle(action,{home=process.env.HOME,uid=process.getuid(),exec=(args)=>spawnSync('/bin/launchctl',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000,maxBuffer:262144}),configPath,supervisorPath=join(dirname(fileURLToPath(import.meta.url)),'supervisor.mjs')}={}){
 const target=`gui/${uid}/${label}`,domain=`gui/${uid}`,path=join(home,'Library','LaunchAgents',label+'.plist'),runtime=join(home,'.flora','pc-runner-uulab');
 if(action==='install'){
  if(dirname(configPath)!==runtime)throw Error('INVALID_SERVICE_RUNTIME');await privatePath(runtime,true);await mkdir(join(runtime,'scratch'),{mode:0o700,recursive:true});const c=await readConfig(configPath);if(c.runtimeDirectory!==runtime)throw Error('INVALID_SERVICE_RUNTIME');await privatePath(dirname(supervisorPath),true);await privatePath(supervisorPath);await mkdir(dirname(path),{recursive:true});try{const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.uid!==uid)throw Error('SERVICE_FILE_UNSAFE');const previous=await readFile(path,'utf8');if(!previous.includes(`<key>Label</key><string>${label}</string>`))throw Error('SERVICE_FILE_UNOWNED');}catch(e){if(e.code!=='ENOENT')throw e;}await writeFile(path,plist(c,configPath,supervisorPath),{mode:0o600});await chmod(path,0o600);return {state:'installed'};
 }
 if(action==='status'){let status;try{status=parseLaunchStatus(exec(['print',target]));}catch{status={state:'unknown',loaded:false,code:'SERVICE_STATUS_UNAVAILABLE'};}const marker=await fatalStatus(runtime);return marker.fatal?{state:'fatal-stop',loaded:status.loaded,...(status.pid?{pid:status.pid}:{}),code:marker.code}:status;}
 if(!['start','stop'].includes(action))throw Error('INVALID_SERVICE_ACTION');await privatePath(runtime,true);await privatePath(path);
 if(action==='stop'){const r=exec(['bootout',target]);if(r.status!==0&&exec(['print',target]).status===0)throw Error('SERVICE_STOP_FAILED');return {state:'stopped'};}
 const fatal=join(runtime,'fatal-stop');try{await privatePath(fatal);await unlink(fatal);}catch(e){if(e.code!=='ENOENT')throw e;}
 if(exec(['print',target]).status!==0&&exec(['bootstrap',domain,path]).status!==0)throw Error('SERVICE_START_FAILED');if(exec(['kickstart',target]).status!==0)throw Error('SERVICE_START_FAILED');return {state:'started'};
}
async function main(){const [action,path]=process.argv.slice(2);if(process.argv.length>4)throw Error('INVALID_SERVICE_ACTION');const r=await lifecycle(action,{...(path?{configPath:resolve(path)}:{})});console.log(JSON.stringify(r));}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])main().catch(e=>{const safe=new Set(['PRIVATE_PATH_REQUIRED','INVALID_SERVICE_CONFIG','INVALID_SERVICE_RUNTIME','SERVICE_FILE_UNSAFE','SERVICE_FILE_UNOWNED','SERVICE_STOP_FAILED','SERVICE_START_FAILED','INVALID_SERVICE_ACTION']);console.error(safe.has(e.message)?e.message:'SERVICE_FAILED');process.exitCode=1;});
