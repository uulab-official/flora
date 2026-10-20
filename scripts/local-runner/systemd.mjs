import {constants} from 'node:fs';
import {access,lstat,open,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {privatePath,readConfig} from './supervisor.mjs';

const supervisorMain=fileURLToPath(new URL('./supervisor.mjs',import.meta.url));
const text=v=>typeof v==='string'&&v.length>0&&v.length<=8192&&!/[\x00-\x1f\x7f]/.test(v);
// systemd ExecStart supports specifiers even without a shell. The ':' prefix
// disables dollar expansion; '%' is separately escaped in all unit values.
const quote=v=>'"'+v.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%')+'"';
function validate(config,servicePath,supervisorPath){
 const paths=[servicePath,supervisorPath,config.runtimeDirectory,config.nodePath,config.runnerMain,config.limaHome,...(config.runnerConfigs??[])];
 if(!paths.every(p=>text(p)&&isAbsolute(p))||!text(config.path)||!config.path.split(':').every(p=>isAbsolute(p))||!text(config.dockerHost)||!/^unix:\/\/\//.test(config.dockerHost))throw Error('INVALID_SERVICE_CONFIG');
 if(config.vmStart!==undefined)throw Error('RUNNER_SERVICE_VM_START_UNSUPPORTED');
}
export function renderSystemdService(config,servicePath,supervisorPath=supervisorMain){
 validate(config,servicePath,supervisorPath);
 const env={PATH:config.path,LIMA_HOME:config.limaHome,DOCKER_HOST:config.dockerHost,TMPDIR:join(config.runtimeDirectory,'scratch')};
 return '[Unit]\nDescription=Flora OTA Runner\nStartLimitIntervalSec=300\nStartLimitBurst=3\n\n[Service]\nType=exec\n'+
  // WorkingDirectory is a path value, not a quoted word list. A trailing '/'
  // also prevents a literal final backslash becoming a line continuation.
  'WorkingDirectory='+config.runtimeDirectory.replaceAll('%','%%')+'/\n'+
  'ExecStart=:'+ [config.nodePath,supervisorPath,servicePath].map(quote).join(' ')+'\n'+
  Object.entries(env).map(([k,v])=>'Environment='+quote(k+'='+v)+'\n').join('')+
  'UnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT NODE_TLS_REJECT_UNAUTHORIZED NODE_EXTRA_CA_CERTS\n'+
  'UMask=0077\nNoNewPrivileges=true\nRestart=on-failure\nRestartSec=30s\nKillMode=mixed\nTimeoutStopSec=40s\nStandardOutput=null\nStandardError=null\n\n[Install]\nWantedBy=default.target\n';
}
async function publicExecutable(path,executable=false){
 const s=await lstat(path);
 if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o022)!==0||![0,process.getuid()].includes(s.uid)||await realpath(path)!==path)throw Error('RUNNER_SERVICE_EXECUTABLE_UNSAFE');
 for(let parent=dirname(path);;parent=dirname(parent)){
  const p=await lstat(parent),stickyRoot=p.uid===0&&(p.mode&0o1000)!==0;
  if(!p.isDirectory()||p.isSymbolicLink()||![0,process.getuid()].includes(p.uid)||((p.mode&0o022)!==0&&!stickyRoot))throw Error('RUNNER_SERVICE_EXECUTABLE_UNSAFE');
  if(dirname(parent)===parent)break;
 }
 await access(path,executable?constants.R_OK|constants.X_OK:constants.R_OK);
}
async function existingUnit(file,content){
 const before=await privatePath(file),handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const after=await handle.stat();if(before.ino!==after.ino||before.dev!==after.dev||after.size>65536||after.nlink!==1||after.uid!==process.getuid()||(after.mode&0o077)!==0)throw Error('PRIVATE_PATH_REQUIRED');if(await handle.readFile('utf8')!==content)throw Error('RUNNER_SERVICE_OUTPUT_CONFLICT');}finally{await handle.close();}
}
export async function generateSystemdService(servicePath){
 if(!['darwin','linux'].includes(process.platform)||typeof process.getuid!=='function'||process.getuid()===0)throw Error('RUNNER_SERVICE_HOST_UNSUPPORTED');
 if(!text(servicePath)||!isAbsolute(servicePath)||await realpath(servicePath)!==servicePath)throw Error('PRIVATE_PATH_REQUIRED');
 const config=await readConfig(servicePath),content=renderSystemdService(config,servicePath);
 await publicExecutable(servicePath);await publicExecutable(config.nodePath,true);await publicExecutable(config.runnerMain);await publicExecutable(supervisorMain);
 const unitName='flora-runner-'+createHash('sha256').update(servicePath).digest('hex').slice(0,12)+'.service',file=join(dirname(servicePath),unitName);
 let handle,state='created';
 try{handle=await open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}
 catch(error){if(error.code!=='EEXIST')throw error;await existingUnit(file,content);state='unchanged';}
 if(handle){try{await handle.writeFile(content);await handle.sync();}finally{await handle.close();}}
 return {manager:'systemd-user',state,file,unitName,installed:false,started:false};
}
