#!/usr/bin/env node
/** Local macOS service for operator-approved native queues; no signing keys in plist. */
import {mkdir,lstat,readFile,writeFile,chmod,realpath} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {parseLaunchStatus} from './service.mjs';
export const label='kr.co.uulab.flora-native-runner';
const home='/Users/uulab',runtime=home+'/.flora/native-runner-uulab',node=home+'/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node';
const configs=['isso-android','isso-ios','promise-android','promise-ios'].map(slug=>join(runtime,slug+'.json'));
const plistPath=join(home,'Library/LaunchAgents',label+'.plist'),target='gui/'+process.getuid()+'/'+label;
const escape=v=>v.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function launch(args){return spawnSync('/bin/launchctl',args,{encoding:'utf8',timeout:10000,maxBuffer:262144,stdio:['ignore','pipe','pipe']});}
async function privatePath(path,directory=false){const s=await lstat(path);if(s.isSymbolicLink()||await realpath(path)!==path||s.uid!==process.getuid()||(s.mode&0o777)!==(directory?0o700:0o600)||(directory?!s.isDirectory():!s.isFile()))throw Error('PRIVATE_PATH_REQUIRED');}
async function main(){
 const [action]=process.argv.slice(2);if(process.argv.length!==3||!['install','start','stop','status'].includes(action))throw Error('INVALID_SERVICE_ACTION');
 if(action==='status'){console.log(JSON.stringify(parseLaunchStatus(launch(['print',target]))));return;}
 await privatePath(runtime,true);
 if(action==='install'){
  for(const path of configs)await privatePath(path);
  const bundle=join(runtime,'controller-'+randomUUID());await mkdir(bundle,{mode:0o700});
  const source=resolve(dirname(fileURLToPath(import.meta.url)),'../../packages/ota-runner/dist'),files=['native-main.js','native-controller.js','native-client.js','native-signing.js','process.js'],hashes={};
  for(const file of files){const bytes=await readFile(join(source,file));hashes[file]=createHash('sha256').update(bytes).digest('hex');await writeFile(join(bundle,file),bytes,{flag:'wx',mode:0o600});}
  await writeFile(join(bundle,'package.json'),JSON.stringify({type:'module',private:true})+'\n',{mode:0o600,flag:'wx'});
  await writeFile(join(bundle,'manifest.json'),JSON.stringify({files:hashes,installedAt:new Date().toISOString()},null,2)+'\n',{mode:0o600,flag:'wx'});
  const {readNativeConfig}=await import(join(bundle,'native-controller.js'));for(const path of configs)await readNativeConfig(path);
  const logs=join(runtime,'service-logs');await mkdir(logs,{mode:0o700,recursive:true});await privatePath(logs,true);
  for(const file of ['stdout.jsonl','stderr.jsonl']){const p=join(logs,file);try{await privatePath(p);}catch(e){if(e.code!=='ENOENT')throw e;await writeFile(p,'',{mode:0o600,flag:'wx'});}}
  await mkdir(dirname(plistPath),{recursive:true});try{const s=await lstat(plistPath);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||!(await readFile(plistPath,'utf8')).includes('<string>'+label+'</string>'))throw Error('SERVICE_FILE_UNOWNED');}catch(e){if(e.code!=='ENOENT')throw e;}
  const args=[node,join(bundle,'native-main.js'),'--daemon',...configs.flatMap(p=>['--config',p])];
  const xml='<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>'+label+'</string>\n<key>ProgramArguments</key><array>'+args.map(v=>'<string>'+escape(v)+'</string>').join('')+'</array>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><false/>\n<key>ThrottleInterval</key><integer>30</integer>\n<key>ExitTimeOut</key><integer>60</integer>\n<key>WorkingDirectory</key><string>'+escape(runtime)+'</string>\n<key>StandardOutPath</key><string>'+escape(join(logs,'stdout.jsonl'))+'</string>\n<key>StandardErrorPath</key><string>'+escape(join(logs,'stderr.jsonl'))+'</string>\n<key>EnvironmentVariables</key><dict><key>HOME</key><string>'+home+'</string><key>PATH</key><string>/Users/uulab/Library/Java/JavaVirtualMachines/jdk-17.0.20+8.jdk/Contents/Home/bin:/Users/uulab/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>\n</dict></plist>\n';
  await writeFile(plistPath,xml,{mode:0o600});await chmod(plistPath,0o600);
  console.log(JSON.stringify({state:'installed',label,bundle,configs:configs.length,runAtLoad:true,keepAlive:false,credentialsInPlist:false}));return;
 }
 await privatePath(plistPath);
 if(action==='stop'){const r=launch(['bootout',target]);if(r.status!==0&&launch(['print',target]).status===0)throw Error('SERVICE_STOP_FAILED');console.log(JSON.stringify({state:'stopped',label}));return;}
 if(launch(['print',target]).status!==0&&launch(['bootstrap','gui/'+process.getuid(),plistPath]).status!==0)throw Error('SERVICE_START_FAILED');
 if(launch(['kickstart',target]).status!==0)throw Error('SERVICE_START_FAILED');console.log(JSON.stringify({state:'started',label}));
}
main().catch(error=>{const codes=['PRIVATE_PATH_REQUIRED','INVALID_SERVICE_ACTION','SERVICE_FILE_UNOWNED','SERVICE_START_FAILED','SERVICE_STOP_FAILED'];console.error(JSON.stringify({state:'failed',code:codes.includes(error.message)?error.message:'NATIVE_SERVICE_FAILED'}));process.exitCode=1;});
