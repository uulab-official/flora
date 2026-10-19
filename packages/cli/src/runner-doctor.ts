import {constants} from 'node:fs';
import type {Stats} from 'node:fs';
import {lstat,open,opendir,realpath,statfs,access} from 'node:fs/promises';
import {dirname,isAbsolute,join} from 'node:path';
import {request} from 'node:http';
import {readRunnerConfig} from '@flora/runner';

export interface RunnerDoctorIssue {check:string;code:string;message:string;remediation:string;runnerIndex?:number}
export interface RunnerDoctorReport {
  readOnly:true;serverOnlineVerified:false;ready:boolean;issues:RunnerDoctorIssue[];
  checks:{serviceConfig:'valid'|'invalid';docker:'available'|'unavailable'|'timeout'|'unverified';disk:'sufficient'|'low'|'unavailable'|'unverified';fatalStop:'absent'|'present'|'unknown'|'unverified';runners:Array<{runnerIndex:number;config:'valid'|'invalid';recovery:'clear'|'pending'|'unknown'|'unverified'}>};
}
interface Probes {availableBytes?:(path:string)=>Promise<bigint>;dockerPing?:(socketPath:string,signal:AbortSignal)=>Promise<boolean>}
interface Service {runtimeDirectory:string;runnerConfigs:string[];dockerHost:string}
const privateMode=(s:Stats)=>(s.mode&0o077)===0&&typeof process.getuid==='function'&&s.uid===process.getuid();
const safePath=(p:unknown):p is string=>typeof p==='string'&&isAbsolute(p)&&!/[\x00-\x1f\x7f]/.test(p);
async function privateDirectory(path:string){const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink()||!privateMode(s)||await realpath(path)!==path)throw Error('PRIVATE_PATH_REQUIRED');return s;}
async function privateJSON(path:string):Promise<Record<string,unknown>>{
  if(!safePath(path))throw Error('PRIVATE_PATH_REQUIRED');await privateDirectory(dirname(path));
  const before=await lstat(path);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||!privateMode(before)||before.size>16384)throw Error('PRIVATE_PATH_REQUIRED');
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const after=await handle.stat();if(after.ino!==before.ino||after.dev!==before.dev||!after.isFile()||after.nlink!==1||!privateMode(after)||after.size>16384)throw Error('PRIVATE_PATH_REQUIRED');
    const bytes=Buffer.alloc(16385);let length=0;while(length<bytes.length){const r=await handle.read(bytes,length,bytes.length-length,null);if(!r.bytesRead)break;length+=r.bytesRead;}if(length>16384)throw Error('PRIVATE_PATH_REQUIRED');
    const value:unknown=JSON.parse(bytes.subarray(0,length).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_CONFIG');return value as Record<string,unknown>;
  }finally{await handle.close();}
}
async function serviceConfig(path:string):Promise<Service>{
  const c=await privateJSON(path),keys=['runtimeDirectory','nodePath','runnerMain','runnerConfigs','path','limaHome','dockerHost','pollIntervalMs','vmStart'];
  if(Object.keys(c).some(k=>!keys.includes(k))||![c.runtimeDirectory,c.nodePath,c.runnerMain,c.limaHome].every(safePath)||c.runtimeDirectory!==dirname(path)||typeof c.path!=='string'||/[\x00-\x1f\x7f]/.test(c.path)||typeof c.dockerHost!=='string'||!/^unix:\/\/\//.test(c.dockerHost)||/[\x00-\x20\x7f?#]/.test(c.dockerHost)||!Array.isArray(c.runnerConfigs)||c.runnerConfigs.length<1||c.runnerConfigs.length>10||new Set(c.runnerConfigs).size!==c.runnerConfigs.length||!c.runnerConfigs.every(p=>safePath(p)&&dirname(p)===c.runtimeDirectory)||!Number.isInteger(c.pollIntervalMs)||Number(c.pollIntervalMs)<10000||Number(c.pollIntervalMs)>300000)throw Error('INVALID_SERVICE_CONFIG');
  if(c.vmStart!==undefined&&(!Array.isArray(c.vmStart)||c.vmStart.length!==4||!safePath(c.vmStart[0])||c.vmStart[1]!=='start'||typeof c.vmStart[2]!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(c.vmStart[2])||c.vmStart[3]!=='-y'))throw Error('INVALID_SERVICE_CONFIG');
  await privateDirectory(join(c.runtimeDirectory as string,'scratch'));return c as unknown as Service;
}
/** Direct Unix HTTP only: no CLI, config-selected executable, DNS, redirects or proxy. */
function dockerPing(socketPath:string,signal:AbortSignal):Promise<boolean>{return new Promise(resolve=>{
  let settled=false;const finish=(value:boolean)=>{if(settled)return;settled=true;signal.removeEventListener('abort',stop);resolve(value);};
  const req=request({socketPath,path:'/_ping',method:'GET',agent:false},res=>{
    const chunks:Buffer[]=[];let size=0;
    res.on('data',(b:Buffer)=>{size+=b.length;if(size>16){finish(false);res.destroy();req.destroy();}else chunks.push(b);});
    res.on('end',()=>finish(res.statusCode===200&&Buffer.concat(chunks).toString('utf8')==='OK'));res.on('error',()=>finish(false));res.on('aborted',()=>finish(false));
  });
  const stop=()=>{finish(false);req.destroy();};req.on('error',()=>finish(false));signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();else req.end();
});}
async function socketPath(host:string):Promise<string>{
  const path=await realpath(host.slice(7)),s=await lstat(path);
  if(!s.isSocket()||s.isSymbolicLink()||(s.uid!==process.getuid?.()&&s.uid!==0)||(s.mode&0o002)!==0)throw Error('UNSAFE_DOCKER_SOCKET');
  await access(path,constants.R_OK|constants.W_OK);return path;
}
async function recoveryStatus(path:string):Promise<'clear'|'pending'|'unknown'>{
  try{await lstat(path);}catch(error){return (error as NodeJS.ErrnoException).code==='ENOENT'?'clear':'unknown';}
  try{const stat=await privateDirectory(path);if((stat.mode&0o777)!==0o700)throw Error('PRIVATE_RECOVERY_DIRECTORY_REQUIRED');const directory=await opendir(path,{bufferSize:32});let count=0,pending=false,unknown=false;
    try{for await(const entry of directory){if(++count>256){unknown=true;break;}if(!entry.name.endsWith('.json')){unknown=true;continue;}pending=true;const s=await lstat(join(path,entry.name));if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||!privateMode(s))unknown=true;}}finally{await directory.close().catch(()=>{});}
    return unknown?'unknown':pending?'pending':'clear';
  }catch{return 'unknown';}
}
/** Reads local state only. Remote presence, service execution and native builds remain unverified. */
export async function inspectRunnerService(servicePath:string,probes:Probes={}):Promise<RunnerDoctorReport>{
  const report:RunnerDoctorReport={readOnly:true,serverOnlineVerified:false,ready:false,issues:[],checks:{serviceConfig:'invalid',docker:'unverified',disk:'unverified',fatalStop:'unverified',runners:[]}};
  const issue=(check:string,code:string,message:string,remediation:string,runnerIndex?:number)=>report.issues.push({check,code,message,remediation,...(runnerIndex===undefined?{}:{runnerIndex})});
  let c:Service;
  try{c=await serviceConfig(servicePath);report.checks.serviceConfig='valid';}catch{issue('serviceConfig','RUNNER_SERVICE_INVALID','Private Runner service configuration could not be verified.','Inspect the selected service file, private directory permissions and service settings locally.');return report;}
  try{await lstat(join(c.runtimeDirectory,'fatal-stop'));report.checks.fatalStop='present';}catch(error){report.checks.fatalStop=(error as NodeJS.ErrnoException).code==='ENOENT'?'absent':'unknown';}
  if(report.checks.fatalStop!=='absent')issue('fatalStop',report.checks.fatalStop==='present'?'RUNNER_FATAL_STOP_PRESENT':'RUNNER_FATAL_STOP_UNKNOWN','Runner fatal-stop state requires local inspection.','Inspect the supervisor failure and preserve recovery journals before explicit operator recovery.');
  for(const [runnerIndex,path] of c.runnerConfigs.entries()){
    const result:RunnerDoctorReport['checks']['runners'][number]={runnerIndex,config:'invalid',recovery:'unverified'};report.checks.runners.push(result);
    try{await privateJSON(path);
      // The bounded 16 KiB preflight reuses the current fixed Runner validator.
      // Its second read is not an atomic snapshot under same-user concurrent writes.
      // Client construction creates closures without Flora/GitHub requests or Docker.
      const config=await readRunnerConfig(path);result.config='valid';result.recovery=await recoveryStatus(config.recoveryDirectory??join(dirname(path),'recovery'));
    }catch{issue('runnerConfig','RUNNER_CONFIG_INVALID','Private per-app Runner configuration could not be verified.','Inspect this indexed Runner configuration and its private permissions locally.',runnerIndex);continue;}
    if(result.recovery!=='clear')issue('recovery',result.recovery==='pending'?'RUNNER_RECOVERY_PENDING':'RUNNER_RECOVERY_UNKNOWN','Runner publication recovery requires local inspection.','Preserve journals and use explicit publication reconciliation after inspecting the local state.',runnerIndex);
  }
  try{const available=probes.availableBytes??(async(path:string)=>{const s=await statfs(path,{bigint:true});if(s.bavail<0n||s.bsize<=0n)throw Error('DISK_UNKNOWN');return s.bavail*s.bsize;});
    report.checks.disk='sufficient';for(const path of [c.runtimeDirectory,join(c.runtimeDirectory,'scratch')]){const bytes=await available(path);if(typeof bytes!=='bigint'||bytes<0n)throw Error('DISK_UNKNOWN');if(bytes<2147483648n)report.checks.disk='low';}
  }catch{report.checks.disk='unavailable';}
  if(report.checks.disk!=='sufficient')issue('disk',report.checks.disk==='low'?'RUNNER_DISK_LOW':'RUNNER_DISK_UNAVAILABLE','Runner free disk capacity is insufficient or unverified.','Verify at least 2 GiB free on the runtime and scratch filesystems without deleting recovery data.');
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try{const path=await socketPath(c.dockerHost);const deadline=new Promise<'timeout'>(resolve=>{timer=setTimeout(()=>{resolve('timeout');controller.abort();},2000);});
    const outcome=await Promise.race([Promise.resolve().then(()=>(probes.dockerPing??dockerPing)(path,controller.signal)).then(value=>value===true?'available' as const:'unavailable' as const,()=> 'unavailable' as const),deadline]);report.checks.docker=outcome;
  }catch{report.checks.docker='unavailable';}finally{clearTimeout(timer);controller.abort();}
  if(report.checks.docker!=='available')issue('docker',report.checks.docker==='timeout'?'RUNNER_DOCKER_TIMEOUT':'RUNNER_DOCKER_UNAVAILABLE','Local Docker daemon connectivity could not be verified.','Inspect the local Unix socket and Docker daemon manually; this command does not start services.');
  report.ready=report.issues.length===0;return report;
}
