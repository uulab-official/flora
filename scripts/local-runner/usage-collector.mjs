import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import https from 'node:https';
import {Resolver} from 'node:dns/promises';
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {privatePath,wait} from './supervisor.mjs';
export const accountId='1302e647c709ce0cc8b4d64938772cb9';
export const reporterId='runner_00d53b73-f3f5-4757-85d5-9695a6a26302';
export const providerUrl='https://api.cloudflare.com/client/v4/graphql',reportUrl='https://flora.uulab.co.kr/api/runner/usage',intervalMs=600000;
const execute=promisify(execFile),currentDay=now=>new Date(now).toISOString().slice(0,10);
const count=n=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
const fail=code=>{throw Error(code);};
const safeCodes=new Set(['USAGE_AUTH_UNAVAILABLE','USAGE_PROVIDER_UNAVAILABLE','USAGE_PROVIDER_INVALID','USAGE_REPORT_REJECTED','USAGE_CONFIGURATION_INVALID','USAGE_DAY_CHANGED','USAGE_CANCELLED']);
export function credentialEnvironment(){return {HOME:process.env.HOME,PATH:process.env.PATH,CLOUDFLARE_AUTH_USE_KEYRING:'true',WRANGLER_SEND_METRICS:'false',WRANGLER_WRITE_LOGS:'false'};}
export function budgetQuery(day){if(!/^\d{4}-\d{2}-\d{2}$/.test(day))fail('USAGE_PROVIDER_INVALID');return{query:'query Budget($account:string!,$day:Date!){viewer{accounts(filter:{accountTag:$account}){d1AnalyticsAdaptiveGroups(limit:100,filter:{date_geq:$day,date_leq:$day}){sum{rowsRead rowsWritten}dimensions{date}}}}}',variables:{account:accountId,day}};}
export function aggregateUsage(data,day,observedAt){
 const accounts=data?.data?.viewer?.accounts;
 if(data?.errors?.length||!Array.isArray(accounts)||accounts.length!==1)fail('USAGE_PROVIDER_INVALID');
 const groups=accounts[0]?.d1AnalyticsAdaptiveGroups;
 if(!Array.isArray(groups)||!groups.length||groups.length>100)fail('USAGE_PROVIDER_INVALID');
 let rowsRead=0,rowsWritten=0;
 for(const group of groups){if(group?.dimensions?.date!==day||!count(group.sum?.rowsRead)||!count(group.sum?.rowsWritten))fail('USAGE_PROVIDER_INVALID');rowsRead+=group.sum.rowsRead;rowsWritten+=group.sum.rowsWritten;}
 if(!count(rowsRead)||!count(rowsWritten)||!count(observedAt))fail('USAGE_PROVIDER_INVALID');
 return{day,observedAt,rowsRead,rowsWritten};
}
export async function privateRunnerToken(runtimeDirectory){
 if(runtimeDirectory!==join(process.env.HOME,'.flora','pc-runner-uulab'))fail('USAGE_CONFIGURATION_INVALID');
 await privatePath(runtimeDirectory,true);const path=join(runtimeDirectory,'isso.json'),before=await privatePath(path);
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const after=await file.stat();if(after.ino!==before.ino||after.dev!==before.dev||after.nlink!==1||after.uid!==process.getuid()||(after.mode&0o077)!==0||after.size>16384)fail('USAGE_CONFIGURATION_INVALID');
 const config=JSON.parse(await file.readFile('utf8'));if(config.origin!=='https://flora.uulab.co.kr'||typeof config.token!=='string'||config.token.split('.')[0]!==reporterId||config.token.length>1024)fail('USAGE_CONFIGURATION_INVALID');return config.token;
 }finally{await file.close();}
}
export async function wranglerCredential(nodePath,wranglerPath,signal){
 try{const {stdout}=await execute(nodePath,[wranglerPath,'auth','token','--json'],{env:credentialEnvironment(),encoding:'utf8',timeout:20000,maxBuffer:65536,signal});
 const value=JSON.parse(stdout);if(!['oauth','api_token'].includes(value.type)||typeof value.token!=='string'||value.token.length<16||value.token.length>16384||/[\r\n]/.test(value.token))fail('USAGE_AUTH_UNAVAILABLE');return value.token;
 }catch{fail('USAGE_AUTH_UNAVAILABLE');}
}
export async function postFixed(url,token,body,signal){
 if(![providerUrl,reportUrl].includes(url)||typeof token!=='string'||/[\r\n]/.test(token))fail('USAGE_CONFIGURATION_INVALID');
 const parsed=new URL(url),resolver=new Resolver({timeout:5000,tries:1});resolver.setServers(['1.1.1.1']);
 let addresses;try{addresses=await resolver.resolve4(parsed.hostname);}catch{fail('USAGE_PROVIDER_UNAVAILABLE');}
 if(signal?.aborted)fail('USAGE_CANCELLED');
 const text=JSON.stringify(body);
 return await new Promise((resolve,reject)=>{
  let done=false,request,timer;const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(Error('USAGE_PROVIDER_UNAVAILABLE')):resolve(result);};
  const abort=()=>{request?.destroy();finish(Error('USAGE_CANCELLED'));};
  request=https.request(url,{method:'POST',lookup:(_host,options,callback)=>callback(null,options.all?[{address:addresses[0],family:4}]:addresses[0],4),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Content-Length':Buffer.byteLength(text)}},response=>{
   let bytes=0,chunks=[];response.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536){request.destroy();finish(Error('USAGE_PROVIDER_INVALID'));}else chunks.push(chunk);});
   response.on('error',()=>finish(Error('USAGE_PROVIDER_UNAVAILABLE')));response.on('end',()=>{if(done)return;try{finish(null,{status:response.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch{finish(Error('USAGE_PROVIDER_INVALID'));}});
  });
  timer=setTimeout(()=>{request.destroy();finish(Error('USAGE_PROVIDER_UNAVAILABLE'));},20000);request.on('error',()=>finish(Error('USAGE_PROVIDER_UNAVAILABLE')));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();else request.end(text);
 });
}
export async function collectUsage(options,{runnerToken=privateRunnerToken,credential=wranglerCredential,post=postFixed,now=Date.now}={}){
 const observedAt=now(),day=currentDay(observedAt);const runner=await runnerToken(options.runtimeDirectory);
 const provider=await credential(options.nodePath,options.wranglerPath,options.signal);
 const response=await post(providerUrl,provider,budgetQuery(day),options.signal);
 if(response?.status!==200)fail('USAGE_PROVIDER_UNAVAILABLE');const report=aggregateUsage(response.body,day,observedAt);
 if(currentDay(now())!==day)fail('USAGE_DAY_CHANGED');
 const saved=await post(reportUrl,runner,report,options.signal);
 if(saved?.status!==200||saved.body?.recorded!==true)fail('USAGE_REPORT_REJECTED');
 return{state:'recorded',...report};
}
export function parseArguments(args){const options={once:false};const fields={'--runtime-directory':'runtimeDirectory','--wrangler-path':'wranglerPath','--node-path':'nodePath'};for(let i=0;i<args.length;i++){if(args[i]==='--once'){if(options.once)fail('USAGE_CONFIGURATION_INVALID');options.once=true;continue;}const key=fields[args[i]],value=args[++i];if(!key||options[key]!==undefined||!value?.startsWith('/')||/[\r\n]/.test(value))fail('USAGE_CONFIGURATION_INVALID');options[key]=value;}if(['runtimeDirectory','wranglerPath','nodePath'].some(k=>!options[k]))fail('USAGE_CONFIGURATION_INVALID');return options;}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const signal=new AbortController();process.once('SIGTERM',()=>signal.abort());process.once('SIGINT',()=>signal.abort());
 try{const options=parseArguments(process.argv.slice(2));do{try{console.log(JSON.stringify(await collectUsage({...options,signal:signal.signal})));}catch(e){console.log(JSON.stringify({state:'unavailable',code:safeCodes.has(e.message)?e.message:'USAGE_PROVIDER_UNAVAILABLE'}));if(options.once)process.exitCode=1;}if(options.once||signal.signal.aborted)break;await wait(intervalMs,signal.signal);}while(!signal.signal.aborted);}catch{console.error('USAGE_CONFIGURATION_INVALID');process.exitCode=1;}
}
