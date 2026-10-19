#!/usr/bin/env node
import {lstat,writeFile,rename,open} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {isAbsolute,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkHealth} from './health.mjs';
const fixedStages=new Set(['execution','source-verified','configuration','source-copy','npm-version','npm-install','cache-validate','cache-copy','exporter','expo-config','expo-export','artifact-read','runner-initialization','runner-execution','claim','source','compiler','artifact-validation','asset-upload','receipt','heartbeat','publication-heartbeat','recovery-journal','checkpoint-save','finalize','publication-verification','recovery-cleanup','checkpoint-clear','failure-report']);
const fixedCodes=new Set(['AUTH_REJECTED','CONFIGURATION_REJECTED','CONFIG_CONFLICT','LEASE_STALE','PUBLICATION_RECONCILIATION_REQUIRED','INVALID_RUNNER_CONFIG','PUBLICATION_REJECTED','EXPORT_FAILED','SOURCE_REJECTED','ARTIFACT_REJECTED','BUSY','RUNNER_FAILED','INVALID_ARTIFACT','INVALID_SIGNATURE','TRANSPORT_FAILED','UNAUTHENTICATED','FORBIDDEN','RUNNER_REVOKED','PERMISSION_DENIED','RUNNER_REQUEST_REJECTED','RUNNER_TRANSPORT_UNAVAILABLE','RUNNER_RESPONSE_INVALID','RUNNER_STOPPED','CONFIG_CHANGED','IDEMPOTENCY_CONFLICT','INVALID_RECOVERY_JOURNAL','ISOLATION_UNAVAILABLE','DOCKER_DAEMON_UNAVAILABLE','ISOLATION_CLEANUP_UNCONFIRMED','RECOVERY_JOURNAL_UNAVAILABLE','RECOVERY_CLEANUP_UNCONFIRMED','RECOVERY_CHECKPOINT_UNAVAILABLE','PUBLICATION_RESULT_UNCONFIRMED','SOURCE_UNAVAILABLE','ARTIFACT_INVALID','CANCELLED','LEASE_EXPIRED','CHILD_STREAM_FAILED','DISK_SPACE_LOW','DISK_SPACE_UNAVAILABLE','D1_DAILY_READ_LIMIT','D1_DAILY_WRITE_LIMIT']);
for(const code of ['CONFLICT','INVALID_TRANSITION'])fixedCodes.add(code);
// Mirror the trusted compiler's fixed diagnostic vocabulary (process.ts).
// Compiler causes are informational; they never become authority/control codes.
const compilerChildStages=['configuration','source-copy','npm-version','npm-install','cache-validate','cache-copy','exporter','expo-config','expo-export','artifact-read'];
const compilerStages=new Set(['execution','source-verified','dependency-seed','dependency-preparation','compiler','artifact-verified',...compilerChildStages,...compilerChildStages.map(stage=>'dependency-preparation-'+stage),...compilerChildStages.map(stage=>'compiler-'+stage)]);
const compilerNpmCodes=['ERESOLVE','EINTEGRITY','ENOTCACHED','ELOCKVERIFY','EUSAGE','ENOENT','EACCES','ECONNRESET','ETIMEDOUT','ENOSPC','ENOMEM','EBADENGINE','EUNSUPPORTEDPROTOCOL','E401','E403','E404','E500','ENETUNREACH'];
const compilerCodes=new Set(['EXECUTION_FAILED','CONFIG_CHANGED','ARTIFACT_INVALID','SOURCE_UNAVAILABLE','ISOLATION_UNAVAILABLE','DEPENDENCY_CACHE_INVALID','PROCESS_TIMEOUT','PROCESS_CANCELLED','PROCESS_OUTPUT_LIMIT','PROCESS_SPAWN_FAILED','NPM_CONFIG_DUPLICATE','EXPO_EXECUTION_DENIED','EXPO_MODULE_MISSING','EXPO_WORKER_LIMIT','EXPO_OUTPUT_BUSY','PNPM_TIMEOUT_IMPORTING','PNPM_TIMEOUT_AFTER_IMPORT','ERR_PNPM_META_FETCH_FAIL','ERR_PNPM_NO_OFFLINE_TARBALL','ERR_PNPM_NO_OFFLINE_META','ERR_PNPM_TARBALL_INTEGRITY','ERR_PNPM_LOCKFILE_CONFIG_MISMATCH','ERR_PNPM_OUTDATED_LOCKFILE','ERR_PNPM_PATCH_NOT_APPLIED','ERR_PNPM_FROZEN_STORE_NEEDS_BUILD','ERR_PNPM_FROZEN_STORE_INCOMPLETE',...compilerNpmCodes.map(code=>'NPM_'+code)]);
for(const stage of compilerStages)fixedStages.add(stage);
export function sanitizedLine(line){
 try{const v=JSON.parse(line);if(v.state==='presence'){if(Object.keys(v).length!==3||!/^runner_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v.runnerId)||!Number.isSafeInteger(v.lastSeenAt)||v.lastSeenAt<=0||v.lastSeenAt>8640000000000000)return null;return {state:'presence',runnerId:v.runnerId,lastSeenAt:v.lastSeenAt};}if(v.diagnostic===true){const r={diagnostic:true};if(fixedStages.has(v.stage))r.stage=v.stage;if(fixedCodes.has(v.code))r.code=v.code;else if(compilerStages.has(v.stage)&&compilerCodes.has(v.code))r.compilerCode=v.code;if(Number.isInteger(v.httpStatus)&&v.httpStatus>=100&&v.httpStatus<=599)r.httpStatus=v.httpStatus;return r;}
 if(!['empty','succeeded','failed','interrupted','publication_unknown'].includes(v.state))return null;
 const r={state:v.state};for(const key of ['jobId','deploymentId'])if(typeof v[key]==='string'&&(key==='deploymentId'?/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/:/^automation_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/).test(v[key]))r[key]=v[key];if(['ios','android'].includes(v.platform))r.platform=v.platform;if(fixedCodes.has(v.code))r.code=v.code;return r;
 }catch{return fixedCodes.has(line.trim())?{code:line.trim()}:null;}
}
export async function privatePath(path,directory=false){const s=await lstat(path);if(s.isSymbolicLink()|| (directory?!s.isDirectory():!s.isFile()||s.nlink!==1)||s.uid!==process.getuid()||(s.mode&0o077)!==0)throw Error('PRIVATE_PATH_REQUIRED');return s;}
async function readPrivate(path){const before=await privatePath(path);const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const after=await f.stat();if(before.ino!==after.ino||before.dev!==after.dev||after.nlink!==1||after.uid!==process.getuid()||(after.mode&0o077)!==0||after.size>16384)throw Error('PRIVATE_PATH_REQUIRED');return await f.readFile('utf8');}finally{await f.close();}}
export async function readConfig(path){await privatePath(dirname(path),true);const s=await privatePath(path);if(s.size>16384)throw Error('INVALID_SERVICE_CONFIG');const c=JSON.parse(await readPrivate(path));const keys=['runtimeDirectory','nodePath','runnerMain','runnerConfigs','path','limaHome','dockerHost','pollIntervalMs','vmStart'];if(Object.keys(c).some(k=>!keys.includes(k))||![c.runtimeDirectory,c.nodePath,c.runnerMain,c.limaHome].every(p=>typeof p==='string'&&isAbsolute(p)&&!/[\r\n]/.test(p))||typeof c.path!=='string'||/[\r\n]/.test(c.path)||typeof c.dockerHost!=='string'||!/^unix:\/\/\//.test(c.dockerHost)||/[\r\n]/.test(c.dockerHost)||!Array.isArray(c.runnerConfigs)||c.runnerConfigs.length<1||c.runnerConfigs.length>10||new Set(c.runnerConfigs).size!==c.runnerConfigs.length||!c.runnerConfigs.every(p=>typeof p==='string'&&isAbsolute(p)&&dirname(p)===c.runtimeDirectory)||!Number.isInteger(c.pollIntervalMs)||c.pollIntervalMs<10000||c.pollIntervalMs>300000)throw Error('INVALID_SERVICE_CONFIG');if(dirname(path)!==c.runtimeDirectory)throw Error('INVALID_SERVICE_CONFIG');await privatePath(c.runtimeDirectory,true);await privatePath(join(c.runtimeDirectory,'scratch'),true);for(const p of c.runnerConfigs)await privatePath(p);if(c.vmStart!==undefined&&(!Array.isArray(c.vmStart)||c.vmStart.length!==4||!isAbsolute(c.vmStart[0])||c.vmStart[1]!=='start'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(c.vmStart[2])||c.vmStart[3]!=='-y'))throw Error('INVALID_SERVICE_CONFIG');return c;}
export async function boundedLog(path,event){const line=JSON.stringify({time:new Date().toISOString(),...event})+'\n';try{const s=await privatePath(path);if(s.size+Buffer.byteLength(line)>1048576)await rename(path,path+'.previous');}catch(e){if(e.code!=='ENOENT')throw e;}const f=await open(path,constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW,0o600);try{const s=await f.stat();if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o077)!==0)throw Error('PRIVATE_PATH_REQUIRED');await f.writeFile(line);}finally{await f.close();}}
export function runChild(command,args,env,signal){return new Promise(resolve=>{const child=spawn(command,args,{env,stdio:['ignore','pipe','pipe'],detached:true});let bytes=0,partial=['',''],records=[],timer,overflow=false;const stop=()=>{if(timer)return;child.kill('SIGTERM');timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},30000);timer.unref();};signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();const consume=(i,b)=>{bytes+=b.length;if(bytes>262144){overflow=true;stop();return;}partial[i]+=b.toString('utf8');const lines=partial[i].split('\n');partial[i]=lines.pop();for(const l of lines){const r=sanitizedLine(l);if(r)records.push(r);}};child.stdout.on('data',b=>consume(0,b));child.stderr.on('data',b=>consume(1,b));const streamFailure=()=>{records.push({code:'CHILD_STREAM_FAILED'});stop();};child.stdout.on('error',streamFailure);child.stderr.on('error',streamFailure);let finished=false;const finish=code=>{if(finished)return;finished=true;clearTimeout(timer);signal.removeEventListener('abort',stop);for(const p of partial){const r=sanitizedLine(p);if(r)records.push(r);}resolve({exitCode:code,records,overflow});};child.once('error',()=>finish(-1));child.once('close',code=>finish(code));});}
export function wait(ms,signal){return new Promise(r=>{const t=setTimeout(done,ms);function done(){clearTimeout(t);signal.removeEventListener('abort',done);r();}signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();});}
const transportCodes=new Set(['RUNNER_TRANSPORT_UNAVAILABLE','TRANSPORT_FAILED']);
const recoverableCodes=new Set([...transportCodes,'RUNNER_REQUEST_REJECTED','BUSY']);
function recoverableDiagnostic(record){
 const status=record.httpStatus;
 if(!recoverableCodes.has(record.code))return false;
 if(status===undefined||status===0)return transportCodes.has(record.code);
 if(!Number.isInteger(status))return false;
 return status===429||status>=500&&status<=599||status===409&&record.code==='BUSY';
}
/**
 * A whole CLI restart is safe only before claim returned a lease: no source,
 * exporter, asset, publication or recovery diagnostic/outcome may be present.
 * Reconciliation errors without an explicit claim stage remain fatal. Never
 * reinterpret a lost finalization reply as permission to re-export or publish.
 */
export function recoverableClaimFailure(result){
 if(result?.exitCode!==1||result.overflow||!Array.isArray(result.records)||!result.records.length)return false;
 const diagnostics=result.records.filter(record=>record?.diagnostic===true);
 if(!diagnostics.length||diagnostics.some(record=>record.stage!=='claim'||!recoverableDiagnostic(record)))return false;
 const confirmedCodes=new Set(diagnostics.map(record=>record.code));
 return result.records.every(record=>record&&typeof record==='object'&&!record.state&&
  (record.diagnostic===true?Object.keys(record).every(key=>['diagnostic','stage','code','httpStatus'].includes(key)):
   Object.keys(record).length===1&&confirmedCodes.has(record.code)));
}
function recoverablePreclaimIsolationFailure(result){
 if(result?.exitCode!==1||result.overflow||!Array.isArray(result.records)||!result.records.length)return false;
 let confirmed=false;
 for(const record of result.records){
  if(!record||typeof record!=='object'||record.code!=='DOCKER_DAEMON_UNAVAILABLE')return false;
  if(record.diagnostic===true){if(record.stage!=='runner-initialization'||Object.keys(record).some(key=>!['diagnostic','stage','code'].includes(key)))return false;confirmed=true;}
  else if(Object.keys(record).length!==1)return false;
 }
 return confirmed;
}
function recoverablePresenceFailure(result,deadlineExpired=false){
 // Presence is read-only. Its own supervisor deadline may terminate a child
 // after the exact transient diagnostic was drained but before Node exits1.
 // This exception never applies to claims, publication or recovery outcomes.
 const retryableExit=result?.exitCode===1||deadlineExpired&&(result?.exitCode===0||result?.exitCode===null);
 if(!retryableExit||result.overflow||!Array.isArray(result.records)||!result.records.length)return false;
 const confirmedCodes=new Set(result.records.filter(record=>recoverableDiagnostic(record)).map(record=>record.code));
 return result.records.every(record=>record&&typeof record==='object'&&!record.state&&
  (!record.stage||record.stage==='runner-execution')&&
  Object.keys(record).every(key=>['diagnostic','stage','code','httpStatus'].includes(key))&&
  (record.httpStatus!==undefined||record.diagnostic===true?recoverableDiagnostic(record):transportCodes.has(record.code)||confirmedCodes.has(record.code)));
}
const dailyQuotaCodes=new Set(['D1_DAILY_READ_LIMIT','D1_DAILY_WRITE_LIMIT']);
export function dailyQuotaFailure(result,stage){
 if(result?.exitCode!==1||result.overflow||!Array.isArray(result.records)||!result.records.length)return false;
 const diagnostics=result.records.filter(record=>record?.diagnostic===true);
 if(!diagnostics.length||diagnostics.some(record=>record.stage!==stage||record.httpStatus!==503||!dailyQuotaCodes.has(record.code)||Object.keys(record).some(key=>!['diagnostic','stage','code','httpStatus'].includes(key))))return false;
 const codes=new Set(diagnostics.map(record=>record.code));
 return result.records.every(record=>record&&typeof record==='object'&&!record.state&&(record.diagnostic===true||Object.keys(record).length===1&&codes.has(record.code)));
}
const utcReset=now=>Math.floor(now/86400000)*86400000+86400000;
export async function presenceLoop(c,{run=runChild,pause=wait,signal,env,log,stop,timeoutMs=30000,now=Date.now,quota={until:0}}){
 while(!signal.aborted){
  if(quota.until>now()){await pause(quota.until-now(),signal);continue;}
  for(let i=0;i<c.runnerConfigs.length&&!signal.aborted;i++){
   if(quota.until>now())break;
   for(let attempt=0;attempt<3&&!signal.aborted;attempt++){
    if(quota.until>now())break;
    const request=new AbortController(),abort=()=>request.abort();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();let timedOut=false;const timer=setTimeout(()=>{timedOut=true;request.abort();},timeoutMs);
    let result;try{result=await run(c.nodePath,[c.runnerMain,'--config',c.runnerConfigs[i],'--presence'],env,request.signal);}finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
    if(signal.aborted)return;
    // A cancelled presence may finish after the supervisor's own deadline.
    // It proves no work/lease/publication: retry boundedly, without recording
    // success. Only one exact sanitized presence is allowed in this exception.
    const latePresence=timedOut&&!result.overflow&&[0,1,null].includes(result.exitCode)&&result.records.length===1&&
     Object.keys(result.records[0]).length===3&&sanitizedLine(JSON.stringify(result.records[0]))?.state==='presence';
    if(latePresence)await log({event:'presence-deadline-expired',appIndex:i,exitCode:result.exitCode});
    else for(const r of result.records)await log({event:'presence',appIndex:i,...r});
    if(dailyQuotaFailure(result,'runner-execution')){quota.until=Math.max(quota.until,utcReset(now()));await log({event:'quota-cooldown',appIndex:i,until:quota.until});break;}
    const valid=result.exitCode===0&&!result.overflow&&!timedOut&&result.records.some(r=>r.state==='presence')&&!result.records.some(r=>r.code||r.httpStatus>=400);
    if(valid)break;
    const timedOutExit=timedOut&&(result.exitCode===0||result.exitCode===1||result.exitCode===null);
    const transient=latePresence||timedOutExit&&result.records.length===0||recoverablePresenceFailure(result,timedOut);
    if(transient&&!result.overflow){
     if(attempt<2){await pause(5000,signal);continue;}
     // No successful presence is invented: the server's lastSeenAt can expire.
     // Keep the process alive through transport outages; claim still checks
     // live authority, and health still prevents work without isolation.
     await log({event:'presence-unavailable',appIndex:i});break;
    }
    await stop('presence-fatal-stop',i);return;
   }
  }
  if(quota.until<=now())await pause(60000,signal);
 }
}
export async function supervise(c,{run=runChild,pause=wait,signal,presence=true,presenceRun=run,presencePause=wait,presenceTimeoutMs=30000,now=Date.now,health=checkHealth,log=event=>boundedLog(join(c.runtimeDirectory,'runner.log'),event),fatal=()=>writeFile(join(c.runtimeDirectory,'fatal-stop'), 'Manual inspection required. Recovery journals preserved.\n',{mode:0o600,flag:'wx'})}={}){
 const controller=new AbortController(),abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();const activeSignal=controller.signal;
 const env={PATH:c.path,HOME:process.env.HOME,LIMA_HOME:c.limaHome,DOCKER_HOST:c.dockerHost,TMPDIR:join(c.runtimeDirectory,'scratch'),LANG:'en_US.UTF-8'};
 const quota={until:0};
 let failed=false,logTail=Promise.resolve();const emit=event=>{logTail=logTail.catch(()=>{}).then(()=>log(event));return logTail;};
 const stop=async(event,appIndex)=>{if(failed)return;failed=true;controller.abort();try{await emit({event,...(appIndex===undefined?{}:{appIndex})});}finally{await fatal();}};
 const build=async()=>{
  if(c.vmStart&&!activeSignal.aborted){const v=await run(c.vmStart[0],c.vmStart.slice(1),env,activeSignal);if(activeSignal.aborted)return;if(v.exitCode!==0){await stop('vm-start-failed');return;}}
  const claimSpacingMs=Math.min(c.pollIntervalMs,Math.floor(300000/c.runnerConfigs.length));
  const claimBackoffSteps=c.runnerConfigs.map(()=>0),emptySteps=c.runnerConfigs.map(()=>0),nextEligibleAt=c.runnerConfigs.map(()=>0);
  let i=0;while(!activeSignal.aborted){
   if(quota.until>now()){await pause(quota.until-now(),activeSignal);continue;}
   const time=now();let next=-1;for(let offset=0;offset<c.runnerConfigs.length;offset++){const candidate=(i+offset)%c.runnerConfigs.length;if(nextEligibleAt[candidate]<=time){next=candidate;break;}}
   if(next<0){await pause(Math.min(c.pollIntervalMs,Math.max(1,Math.min(...nextEligibleAt)-time)),activeSignal);continue;}i=next;
   let ready;try{ready=await health(c,{env,signal:activeSignal});}catch{ready={ok:false,code:'DISK_SPACE_UNAVAILABLE'};}if(activeSignal.aborted)return;if(ready?.ok!==true){const code=['DISK_SPACE_LOW','DISK_SPACE_UNAVAILABLE','ISOLATION_UNAVAILABLE'].includes(ready?.code)?ready.code:'DISK_SPACE_UNAVAILABLE';await emit({event:'health',diagnostic:true,code});await pause(c.pollIntervalMs,activeSignal);continue;}if(quota.until>now())continue;const result=await run(c.nodePath,[c.runnerMain,'--config',c.runnerConfigs[i],'--once'],env,activeSignal);for(const r of result.records)await emit({appIndex:i,...r});if(activeSignal.aborted)return;
   if(dailyQuotaFailure(result,'claim')){quota.until=Math.max(quota.until,utcReset(now()));await emit({event:'quota-cooldown',appIndex:i,until:quota.until});i=(i+1)%c.runnerConfigs.length;continue;}
   const isolationUnavailable=recoverablePreclaimIsolationFailure(result);
   if(isolationUnavailable||recoverableClaimFailure(result)){
    const backoffStep=claimBackoffSteps[i]=Math.min(claimBackoffSteps[i]+1,6),retryDelayMs=Math.min(300000,c.pollIntervalMs*2**(backoffStep-1));
    await emit({event:isolationUnavailable?'isolation-retry':'claim-retry',appIndex:i,backoffStep,retryDelayMs});
    // Other apps retain their own backoff state and get the next serial turn.
    // The next --once uses the same private config and existing recovery gate.
    i=(i+1)%c.runnerConfigs.length;await pause(retryDelayMs,activeSignal);continue;
   }
   const outcome=result.records.findLast(r=>r.state);if(result.records.some(r=>r.httpStatus===401||r.httpStatus===403||r.httpStatus===409||r.code&&r.code!=='EXPORT_FAILED')||result.overflow||!outcome||!['empty','succeeded','failed'].includes(outcome.state)||result.exitCode!==0&&outcome.state!=='failed'||outcome.state==='failed'&&outcome.code!=='EXPORT_FAILED'){await stop('fatal-stop',i);return;}if(outcome.state==='empty'&&(Object.keys(outcome).some(key=>key!=='state')||result.records.filter(record=>record.state).length!==1||result.records.some(record=>record.diagnostic===true&&!['claim','runner-initialization'].includes(record.stage)||record.code||record.httpStatus>=400))){await stop('fatal-stop',i);return;}
   claimBackoffSteps[i]=0;
   if(outcome.state==='empty'){const step=emptySteps[i]=Math.min(emptySteps[i]+1,6);nextEligibleAt[i]=now()+Math.min(300000,c.pollIntervalMs*2**(step-1));}
   else{emptySteps[i]=0;nextEligibleAt[i]=now()+c.pollIntervalMs;}
   i=(i+1)%c.runnerConfigs.length;await pause(claimSpacingMs,activeSignal);}
 };
 const guard=async task=>{try{await task();}catch{controller.abort();try{await stop('supervisor-fatal-stop');}catch{}}};
 try{await Promise.all([guard(build),...(presence?[guard(()=>presenceLoop(c,{run:presenceRun,pause:presencePause,signal:activeSignal,env,log:emit,stop,timeoutMs:presenceTimeoutMs,now,quota}))]:[])]);await logTail;return failed?1:0;}finally{controller.abort();signal.removeEventListener('abort',abort);}
}

const serviceErrorCodes=new Set(['EACCES','EPERM','ENOSPC','EIO','EMFILE','ENFILE','ENOENT','EEXIST','EPIPE','ERR_STREAM_DESTROYED','ERR_STREAM_WRITE_AFTER_END','ERR_INVALID_ARG_TYPE','PRIVATE_PATH_REQUIRED','INVALID_SERVICE_CONFIG']);
const serviceStages=new Set(['service-config','service-runtime','process-exception','process-rejection']);
export function serviceFailureDiagnostic(error,stage){const candidate=error&&typeof error==='object'?(error.code??error.message):undefined;return {event:'service-fatal',stage:serviceStages.has(stage)?stage:'service-runtime',code:serviceErrorCodes.has(candidate)?candidate:'UNEXPECTED_SERVICE_FAILURE'};}
export async function fatalStatus(runtime){
 try{await privatePath(runtime,true);const text=await readPrivate(join(runtime,'fatal-stop')); if(text==='Manual inspection required. Recovery journals preserved.\n')return {fatal:true,code:'MANUAL_INSPECTION_REQUIRED'};const v=JSON.parse(text);if(Object.keys(v).length===3&&v.event==='service-fatal'&&serviceStages.has(v.stage)&&(serviceErrorCodes.has(v.code)||v.code==='UNEXPECTED_SERVICE_FAILURE'))return {fatal:true,code:v.code};return {fatal:true,code:'INVALID_FATAL_MARKER'};}catch(error){return error.code==='ENOENT'?{fatal:false}:{fatal:true,code:'INVALID_FATAL_MARKER'};}
}
export async function persistServiceFailure(runtime,diagnostic){
 await privatePath(runtime,true);const marker=join(runtime,'fatal-stop');
 try{const f=await open(marker,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await f.writeFile(JSON.stringify(diagnostic)+'\n');await f.sync();}finally{await f.close();}}catch(error){if(error.code!=='EEXIST')throw error;await privatePath(marker);}
 await boundedLog(join(runtime,'runner.log'),diagnostic);
}
export async function runService(configPath,{read=readConfig,supervisor=supervise,events=process,stderr=line=>process.stderr.write(line),persist=persistServiceFailure}={}){
 const controller=new AbortController();let config,phase='service-config',failureTask,failed=false;
 const report=(error,stage)=>{if(failureTask)return failureTask;failed=true;controller.abort();const diagnostic=serviceFailureDiagnostic(error,stage);failureTask=(async()=>{try{stderr(JSON.stringify(diagnostic)+'\n');}catch{}let runtime=config?.runtimeDirectory;if(!runtime&&typeof configPath==='string'&&isAbsolute(configPath)&&configPath.endsWith('/.flora/pc-runner-uulab/service.json'))runtime=dirname(configPath);if(runtime){try{await persist(runtime,diagnostic);}catch(persistError){try{stderr(JSON.stringify({event:'service-fatal-persistence-failed',code:serviceFailureDiagnostic(persistError,'service-runtime').code})+'\n');}catch{}}}})();return failureTask;};
 const stop=()=>controller.abort(),exception=error=>{void report(error,'process-exception');},rejection=error=>{void report(error,'process-rejection');};
 events.once('SIGTERM',stop);events.once('SIGINT',stop);events.on('uncaughtException',exception);events.on('unhandledRejection',rejection);
 try{if(!configPath)throw Error('INVALID_SERVICE_CONFIG');
  // A durable failure must halt launchd's unsuccessful-exit restart even when
  // the configuration that produced it is still invalid. Never clear it here.
  if(typeof configPath==='string'&&isAbsolute(configPath)&&configPath.endsWith('/.flora/pc-runner-uulab/service.json')){
   try{await lstat(join(dirname(configPath),'fatal-stop'));await privatePath(dirname(configPath),true);return 0;}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  config=await read(configPath);phase='service-runtime';if(failed){await failureTask;return 1;}try{await lstat(join(config.runtimeDirectory,'fatal-stop'));return 0;}catch(e){if(e.code!=='ENOENT')throw e;}const result=await supervisor(config,{signal:controller.signal});await failureTask;return failed?1:result;}catch(error){await report(error,phase);return 1;}finally{events.removeListener('SIGTERM',stop);events.removeListener('SIGINT',stop);events.removeListener('uncaughtException',exception);events.removeListener('unhandledRejection',rejection);}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){process.exitCode=await runService(process.argv[2]);}
