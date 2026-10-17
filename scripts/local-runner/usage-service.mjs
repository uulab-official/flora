import {spawnSync} from 'node:child_process';
import {mkdir,writeFile,lstat,chmod} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {privatePath} from './supervisor.mjs';
export const usageLabel='kr.co.uulab.flora-usage';
const xml=v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function usagePlist({nodePath,collectorPath,runtimeDirectory,wranglerPath,home,path}) {
  for(const value of [nodePath,collectorPath,runtimeDirectory,wranglerPath,home]) if(typeof value!=='string'||!value.startsWith('/')||/[\r\n]/.test(value))throw Error('INVALID_USAGE_SERVICE');
  if(typeof path!=='string'||/[\r\n]/.test(path))throw Error('INVALID_USAGE_SERVICE');
  const args=[nodePath,collectorPath,'--runtime-directory',runtimeDirectory,'--wrangler-path',wranglerPath,'--node-path',nodePath];
  const environment={HOME:home,PATH:path,CLOUDFLARE_AUTH_USE_KEYRING:'true',WRANGLER_SEND_METRICS:'false',WRANGLER_WRITE_LOGS:'false'};
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${usageLabel}</string><key>ProgramArguments</key><array>${args.map(a=>`<string>${xml(a)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>60</integer><key>ExitTimeOut</key><integer>25</integer><key>WorkingDirectory</key><string>${xml(runtimeDirectory)}</string><key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([k,v])=>`<key>${k}</key><string>${xml(v)}</string>`).join('')}</dict></dict></plist>\n`;
}
export async function installUsageService(options) {
  if(options.runtimeDirectory!==join(options.home,'.flora','pc-runner-uulab')||dirname(options.collectorPath)!==join(options.runtimeDirectory,'bin'))throw Error('INVALID_USAGE_SERVICE');
  await privatePath(options.runtimeDirectory,true);await privatePath(options.collectorPath);
  const path=join(options.home,'Library','LaunchAgents',usageLabel+'.plist');
  try{const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||s.nlink!==1)throw Error('UNSAFE_USAGE_SERVICE');}catch(e){if(e.code!=='ENOENT')throw e;}
  await mkdir(dirname(path),{recursive:true});await writeFile(path,usagePlist(options),{mode:0o600});await chmod(path,0o600);
  return path;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const [action,nodePath,wranglerPath]=process.argv.slice(2),home=process.env.HOME,runtimeDirectory=join(home,'.flora','pc-runner-uulab'),target=`gui/${process.getuid()}/${usageLabel}`;
    const run=args=>spawnSync('/bin/launchctl',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000,maxBuffer:65536});
    if(action==='install'){await installUsageService({nodePath,wranglerPath,home,runtimeDirectory,collectorPath:join(runtimeDirectory,'bin','usage-collector.mjs'),path:process.env.PATH});console.log(JSON.stringify({state:'installed'}));}
    else if(action==='start'){if(run(['print',target]).status!==0&&run(['bootstrap',`gui/${process.getuid()}`,join(home,'Library','LaunchAgents',usageLabel+'.plist')]).status!==0)throw Error('USAGE_START_FAILED');if(run(['kickstart',target]).status!==0)throw Error('USAGE_START_FAILED');console.log(JSON.stringify({state:'started'}));}
    else if(action==='status'){const r=run(['print',target]);const m=r.stdout?.match(/^\s*pid = ([0-9]+)$/m);console.log(JSON.stringify({state:r.status===0&&m?'running':'stopped',...(m?{pid:Number(m[1])}:{})}));}
    else throw Error('INVALID_USAGE_SERVICE');
  }catch{console.error('USAGE_SERVICE_FAILED');process.exitCode=1;}
}
