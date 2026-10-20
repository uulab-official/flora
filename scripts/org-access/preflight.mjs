import {readFile,mkdir,lstat,readdir,open,link,unlink,rmdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const failure=code=>new Error(code);
function checkpoint(value){
 if(!value||value.schemaVersion!==1||!['owner_only','preparing','active','paused'].includes(value.mode))throw failure('ORG_CHECKPOINT_INVALID');
 for(const key of ['organizationId','ownerId','dbIdentity','origin'])if(typeof value[key]!=='string'||value[key].length<1||value[key].length>2048)throw failure('ORG_CHECKPOINT_INVALID');
 for(const key of ['revision','orgAccessEpoch','minProtocol','auditSequence','generation'])if(!Number.isSafeInteger(value[key])||value[key]<(key==='auditSequence'||key==='generation'?0:1))throw failure('ORG_CHECKPOINT_INVALID');
 if(value.minProtocol!==1)throw failure('ORG_PROTOCOL_INCOMPATIBLE');
 return Object.fromEntries(['schemaVersion','organizationId','ownerId','dbIdentity','origin','minProtocol','revision','orgAccessEpoch','auditSequence','mode','generation'].map(k=>[k,value[k]]));
}
export async function recordOrgCheckpoint(directory,value){
 const next=checkpoint(value);if(!isAbsolute(directory))throw failure('ORG_CHECKPOINT_DIRECTORY');let locked=false,temp;
 try{
  try{await mkdir(directory,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
  const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o777)!==0o700)throw failure('ORG_CHECKPOINT_DIRECTORY');
  await mkdir(join(directory,'.lock'),{mode:0o700});locked=true;
  const files=await readdir(directory);if(files.length>10001)throw failure('ORG_CHECKPOINT_CAPACITY');
  for(const name of files){if(name==='.lock')continue;if(!/^[0-9]{16}-[a-f0-9]{64}\.json$/.test(name))throw failure('ORG_CHECKPOINT_INVALID');
   const path=join(directory,name),stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384||(stat.mode&0o777)!==0o600)throw failure('ORG_CHECKPOINT_INVALID');
   const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let old;try{old=checkpoint(JSON.parse(await handle.readFile('utf8')));}finally{await handle.close();}
   for(const key of ['organizationId','ownerId','dbIdentity','origin'])if(old[key]!==next[key])throw failure('ORG_CHECKPOINT_IDENTITY');
   for(const key of ['minProtocol','revision','orgAccessEpoch','auditSequence','generation'])if(next[key]<old[key])throw failure('ORG_CHECKPOINT_STALE');
   if(next.revision===old.revision&&JSON.stringify({...next,auditSequence:old.auditSequence})!==JSON.stringify(old))throw failure('ORG_CHECKPOINT_CONFLICT');
  }
  const data=JSON.stringify(next)+'\n',digest=createHash('sha256').update(data).digest('hex'),target=join(directory,String(next.revision).padStart(16,'0')+'-'+digest+'.json');
  try{const stat=await lstat(target);if(stat.isFile()&&!stat.isSymbolicLink())return;throw failure('ORG_CHECKPOINT_INVALID');}catch(e){if(e.code!=='ENOENT')throw e;}
  temp=join(directory,'.pending-'+randomUUID());const handle=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}
  await link(temp,target);await unlink(temp);temp=undefined;const dir=await open(directory,constants.O_RDONLY);try{await dir.sync();}finally{await dir.close();}
 }catch{throw failure('ORG_CHECKPOINT_UNAVAILABLE');}finally{if(temp)await unlink(temp).catch(()=>{});if(locked)await rmdir(join(directory,'.lock'));}
}
export async function checkOrgProtocol(input,deps={fetch:globalThis.fetch,readFile}){
 try{
  const url=new URL(input.origin);if(url.protocol!=='https:'||url.origin!==input.origin||url.username||url.password||!isAbsolute(input.artifactPath)||!isAbsolute(input.ledgerDirectory)||typeof input.sessionCookie!=='string'||!input.sessionCookie||Buffer.byteLength(input.sessionCookie)>16384||/[\r\n]/.test(input.sessionCookie))throw failure('ORG_PROTOCOL_INPUT');
  const raw=await deps.readFile(input.artifactPath,'utf8');if(Buffer.byteLength(raw)>16384)throw failure('ORG_PROTOCOL_ARTIFACT');const artifact=JSON.parse(raw);if(artifact.schemaVersion!==1||artifact.organizationAccess!==1)throw failure('ORG_PROTOCOL_INCOMPATIBLE');
  const response=await deps.fetch(input.origin+'/api/organization/access-migration',{method:'GET',redirect:'error',headers:{Cookie:input.sessionCookie,Accept:'application/json'},signal:AbortSignal.timeout(10000)});if(response.status!==200||response.redirected)throw failure('ORG_PROTOCOL_UNAVAILABLE');
  if(!response.body)throw failure('ORG_PROTOCOL_UNAVAILABLE');const reader=response.body.getReader();let size=0,text='';const decoder=new TextDecoder();try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>16384)throw failure('ORG_PROTOCOL_UNAVAILABLE');text+=decoder.decode(value,{stream:true});}}finally{await reader.cancel().catch(()=>{});}
  const current=checkpoint(JSON.parse(text).checkpoint);if(current.origin!==input.origin)throw failure('ORG_PROTOCOL_IDENTITY');await recordOrgCheckpoint(input.ledgerDirectory,current);return {ready:true,current:current.minProtocol,candidate:artifact.organizationAccess,checkpoint:current};
 }catch(error){throw failure(error instanceof Error&&/^ORG_(?:PROTOCOL|CHECKPOINT)_[A-Z_]+$/.test(error.message)?error.message:'ORG_PROTOCOL_UNAVAILABLE');}
}
async function main(){const args=process.argv.slice(2);if(args.length!==6||args[0]!=='--origin'||args[2]!=='--artifact'||args[4]!=='--ledger')throw failure('ORG_PROTOCOL_INPUT');let size=0,line='';for await(const chunk of process.stdin){size+=chunk.length;if(size>16384)throw failure('ORG_PROTOCOL_INPUT');line+=chunk;}if(line.trim().includes('\n'))throw failure('ORG_PROTOCOL_INPUT');let session;try{session=JSON.parse(line);}catch{throw failure('ORG_PROTOCOL_INPUT');}const result=await checkOrgProtocol({origin:args[1],artifactPath:args[3],ledgerDirectory:args[5],sessionCookie:session.sessionCookie});console.log(JSON.stringify({ready:true,current:result.current,candidate:result.candidate}));}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(/^ORG_[A-Z_]+$/.test(error.message)?error.message:'ORG_PROTOCOL_UNAVAILABLE');process.exitCode=1;});
