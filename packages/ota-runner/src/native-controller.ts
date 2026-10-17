import {chmod,copyFile,lstat,mkdir,mkdtemp,open,readFile,readdir,realpath,rename,rm,stat,writeFile} from "node:fs/promises";
import {constants,readFileSync,realpathSync,statSync} from "node:fs";
import {delimiter,dirname,isAbsolute,join,relative,resolve} from "node:path";
import {createHash} from "node:crypto";
import {homedir,tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";
import {ProcessFailure,trustedProcess,processEnvironment} from "./process.js";
import {NativeHttpFailure,nativeAssert} from "./native-client.js";
import type {NativeArtifact,NativeClient,NativeGrant,NativeJob,NativeLease,NativePlatform} from "./native-client.js";
import {NativeSigningFailure,signAndroidApk,signIOSApp} from "./native-signing.js";
export interface NativeConfig {
 origin:string;token:string;appId:string;platform:NativePlatform;sourceDirectory:string;artifactDirectory:string;expectedCertificateSha256:string;
 tools:{git:string;xcodebuild?:string;ditto?:string;openssl?:string;security?:string;plutil?:string;codesign?:string;keytool?:string;aapt2?:string;apksigner?:string;zipalign?:string};
 buildEnvironment?:Record<string,string>;ios?:{workspace:string;scheme:string;appName:string;entitlementsFile?:string};android?:{directory:string;apkPath:string};
 credentialDirectories?:string[];
 privateConfigPath?:string;
 pythonRuntimeDirectory?:string;
 privateCompilerLogDirectory?:string;
 publicConfigDirectory?:string;
}
export async function readNativeConfig(path:string):Promise<NativeConfig>{
 nativeAssert(isAbsolute(path)&&await realpath(path)===path,"INVALID_NATIVE_CONFIG");const parent=await lstat(dirname(path));nativeAssert(parent.isDirectory()&&!parent.isSymbolicLink()&&(parent.mode&0o777)===0o700&&parent.uid===process.getuid?.(),"INVALID_NATIVE_CONFIG");
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=await file.stat();nativeAssert(s.isFile()&&(s.mode&0o777)===0o600&&s.uid===process.getuid?.()&&s.size<=65536,"INVALID_NATIVE_CONFIG");const c=JSON.parse(await file.readFile("utf8")) as NativeConfig;validateNativeConfig(c);const tools=Object.fromEntries(await Promise.all(Object.entries(c.tools).map(async([key,value])=>[key,await realpath(value)]))) as NativeConfig["tools"];const pythonRuntimeDirectory=(await trustedProcess("/usr/bin/python3",["-I","-S","-c","import sys; print(sys.prefix)"],{env:processEnvironment(),maxBytes:4096})).trim();nativeAssert(isAbsolute(pythonRuntimeDirectory),"ISOLATION_UNAVAILABLE");return {...c,tools,privateConfigPath:path,pythonRuntimeDirectory:await realpath(pythonRuntimeDirectory)};}finally{await file.close();}
}
export function validateNativeConfig(c:NativeConfig):void {
 nativeAssert(c&&typeof c==="object"&&(c.platform==="ios"||c.platform==="android")&&isAbsolute(c.sourceDirectory)&&isAbsolute(c.artifactDirectory)&&/^[a-f0-9]{64}$/.test(c.expectedCertificateSha256)&&c.tools&&isAbsolute(c.tools.git),"INVALID_NATIVE_CONFIG");
 nativeAssert(Object.values(c.tools).every(v=>typeof v==="string"&&isAbsolute(v)),"INVALID_NATIVE_CONFIG");
 nativeAssert(!c.credentialDirectories||Array.isArray(c.credentialDirectories)&&c.credentialDirectories.every(isAbsolute),"INVALID_NATIVE_CONFIG");
 nativeAssert(!c.privateCompilerLogDirectory||isAbsolute(c.privateCompilerLogDirectory),"INVALID_NATIVE_CONFIG");
 nativeAssert(!c.publicConfigDirectory||isAbsolute(c.publicConfigDirectory),"INVALID_NATIVE_CONFIG");
 nativeAssert(!c.buildEnvironment||Object.entries(c.buildEnvironment).every(([k,v])=>["PATH","JAVA_HOME","ANDROID_HOME","ANDROID_SDK_ROOT","HOME","GRADLE_USER_HOME","DEVELOPER_DIR","NODE_BINARY"].includes(k)&&typeof v==="string"&&!/[\r\n\0]/.test(v)),"INVALID_NATIVE_CONFIG");
 if(c.platform==="ios")nativeAssert(c.ios&&c.tools.xcodebuild&&c.tools.ditto&&/^[A-Za-z0-9_.-]+$/.test(c.ios.scheme)&&/^[A-Za-z0-9_.-]+\.app$/.test(c.ios.appName),"INVALID_NATIVE_CONFIG");
 else nativeAssert(c.android&&c.tools.apksigner&&c.tools.aapt2&&c.tools.zipalign&&c.tools.keytool,"INVALID_NATIVE_CONFIG");
}
export function nativeCompilerSandbox(config:NativeConfig,compileToolsDirectory?:string):string {
 const home=homedir(),homes=[...new Set([home,...(config.buildEnvironment?.HOME?[config.buildEnvironment.HOME]:[])])];nativeAssert(homes.every(isAbsolute),"INVALID_NATIVE_CONFIG");
 const authRoots=[".expo",".expo-staging",".expo-local",".ssh",".codex",".config",".aws",".azure",".kube",".npmrc",".netrc",".git-credentials",".docker",".gem/credentials",".gradle/gradle.properties"],originalRoots=nativeOriginalRoots(config),denied=[config.artifactDirectory,...homes.flatMap(home=>authRoots.map(path=>join(home,path))),join(home,"Library/Application Support/Flora"),join(home,"Library/Keychains"),join(home,"Documents/workspace/uulab/.credentials"),join(config.sourceDirectory,"credentials"),...(config.credentialDirectories??[]),...originalRoots,...(config.privateCompilerLogDirectory?[config.privateCompilerLogDirectory]:[])];
 const compileAncestors:string[]=[];if(compileToolsDirectory){let ancestor=canonicalBoundary(dirname(compileToolsDirectory));for(;;){compileAncestors.push(ancestor);const parent=dirname(ancestor);if(parent===ancestor)break;ancestor=parent;}}
 const sensitiveAncestors=new Set<string>();for(const boundary of [...denied,...Object.values(config.tools),...(config.privateConfigPath?[config.privateConfigPath]:[])]){let ancestor=dirname(canonicalBoundary(boundary));for(;;){sensitiveAncestors.add(ancestor);const parent=dirname(ancestor);if(parent===ancestor)break;ancestor=parent;}}
 const quote=(v:string)=>JSON.stringify(v);return "(version 1)\n(allow default)\n"+
  (compileToolsDirectory?`(deny file-write* (subpath ${quote(canonicalBoundary(compileToolsDirectory))}))\n`+compileAncestors.map(path=>`(deny file-write-unlink (literal ${quote(path)}))`).join("\n")+"\n":"")+
  [...sensitiveAncestors].map(path=>`(deny file-write-unlink (literal ${quote(path)}))`).join("\n")+"\n"+
  nativeGitDirectories(config.sourceDirectory).map(path=>`(deny file-write* (subpath ${quote(path)}))`).join("\n")+"\n"+
  (config.pythonRuntimeDirectory?`(deny file-write* (subpath ${quote(canonicalBoundary(config.pythonRuntimeDirectory))}))\n`:"")+
  (config.publicConfigDirectory?`(deny file-write* (subpath ${quote(canonicalBoundary(config.publicConfigDirectory))}))\n`:"")+
  [...new Set([...Object.values(config.tools).flatMap(path=>{const actual=realpathSync(path),app=actual.indexOf(".app/");return [dirname(actual),...(app>=0?[actual.slice(0,app+4)]:[])];}),...((config.buildEnvironment?.PATH??"")+delimiter+(process.env.PATH??"")).split(delimiter).filter(isAbsolute).map(path=>{try{return realpathSync(path);}catch{return path;}}),...(config.buildEnvironment?.JAVA_HOME?[canonicalBoundary(config.buildEnvironment.JAVA_HOME)]:[]),...(config.buildEnvironment?.NODE_BINARY?[canonicalBoundary(dirname(dirname(config.buildEnvironment.NODE_BINARY)))]:[])])].map(path=>`(deny file-write* (subpath ${quote(path)}))`).join("\n")+"\n"+
  [...new Set(denied.flatMap(path=>[path,canonicalBoundary(path)]))].map(path=>`(deny file-read* file-write* (subpath ${quote(path)}))`).join("\n")+"\n"+
  '(deny file-read* file-write* (regex #".*/[.]flora(/.*)?$"))\n'+
  '(deny file-read* file-write* (regex #".*/[.]credentials(/.*)?$"))\n'+
  '(deny file-read* file-write* (regex #".*/credentials[.]json$"))\n'+
  '(deny file-read* file-write* (regex #".*[.](p12|p8|jks|keystore|mobileprovision)$"))\n'+
  `(deny file-write* (subpath ${quote(dirname(fileURLToPath(import.meta.url)))}))\n`+
  Object.values(config.tools).map(path=>`(deny file-write* (literal ${quote(path)}))`).join("\n")+"\n"+
  (config.privateConfigPath?`(deny file-read* file-write* (literal ${quote(config.privateConfigPath)}))\n`:"")+
  '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc") (global-name "com.apple.securityd"))\n'+
  '(deny appleevent-send)\n(deny job-creation)\n(deny process-info*)\n(allow process-info* (target self))\n';
}
function nativeOriginalRoots(config:NativeConfig):string[]{
 const insideRoot=(root:string,path:string)=>{const relation=relative(root,canonicalBoundary(path));return relation===""||!relation.startsWith("..")&&!isAbsolute(relation);};
 return [...new Set((config.credentialDirectories??[]).map(path=>{const root=dirname(canonicalBoundary(path));nativeAssert(root!=="/"&&root!==canonicalBoundary(homedir())&&![config.sourceDirectory,config.artifactDirectory,dirname(fileURLToPath(import.meta.url)),...(config.publicConfigDirectory?[config.publicConfigDirectory]:[])].some(path=>insideRoot(root,path)),"INVALID_NATIVE_CONFIG");return root;}))];
}
function canonicalBoundary(path:string):string {try{return realpathSync(path);}catch{const parent=dirname(path);nativeAssert(parent!==path,"INVALID_NATIVE_CONFIG");return join(canonicalBoundary(parent),path.slice(parent.length).replace(/^[/\\]+/,""));}}
function nativeGitDirectories(source:string):string[]{const paths=[join(source,".git")];try{let git=paths[0]!;if(statSync(git).isFile()){const text=readFileSync(git,"utf8");nativeAssert(text.length<=4096&&/^gitdir: [^\r\n]+\n?$/.test(text),"NATIVE_SOURCE_INVALID");git=resolve(source,text.slice(8).trim());}git=realpathSync(git);paths.push(git);try{const common=readFileSync(join(git,"commondir"),"utf8").trim();nativeAssert(common.length<=4096&&!/[\r\n\0]/.test(common),"NATIVE_SOURCE_INVALID");paths.push(realpathSync(resolve(git,common)));}catch{}}catch{}return paths;}
export async function privateCompilerProcess(executable:string,args:string[],logFile:string,options:NonNullable<Parameters<typeof trustedProcess>[2]>):Promise<string>{
 const parent=dirname(logFile);await mkdir(parent,{recursive:true,mode:0o700});const ps=await lstat(parent);nativeAssert(await realpath(parent)===parent&&ps.isDirectory()&&!ps.isSymbolicLink()&&(ps.mode&0o777)===0o700&&ps.uid===process.getuid?.(),"INVALID_NATIVE_CONFIG");
 const log=await open(logFile,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600),controller=new AbortController();let bytes=0,reason="NATIVE_COMPILER_FAILED",writing=Promise.resolve();
 const stop=()=>{reason="NATIVE_CANCELLED";controller.abort();};options.signal?.addEventListener("abort",stop,{once:true});if(options.signal?.aborted)stop();const timer=setTimeout(()=>{reason="NATIVE_COMPILER_TIMEOUT";controller.abort();},options.timeoutMs??60000);
 try{await new Promise<void>((resolve,reject)=>{const child=spawn(executable,args,{...(options.cwd?{cwd:options.cwd}:{}),env:options.env??processEnvironment(),stdio:["ignore","pipe","pipe"],detached:true});
  const kill=()=>{if(child.pid)try{process.kill(-child.pid,"SIGKILL");}catch{}};controller.signal.addEventListener("abort",kill,{once:true});if(controller.signal.aborted)kill();
  const capture=(part:Buffer)=>{bytes+=part.length;if(bytes>(options.maxBytes??64*1024*1024)){reason="NATIVE_COMPILER_OUTPUT_LIMIT";controller.abort();return;}const data=Buffer.from(part);writing=writing.then(async()=>{let offset=0;while(offset<data.length){const part=await log.write(data,offset,data.length-offset);nativeAssert(part.bytesWritten>0,"NATIVE_COMPILER_LOG_FAILED");offset+=part.bytesWritten;}}).catch(()=>{reason="NATIVE_COMPILER_LOG_FAILED";controller.abort();});};child.stdout.on("data",capture);child.stderr.on("data",capture);child.on("error",()=>{reason="NATIVE_COMPILER_SPAWN_FAILED";controller.abort();});child.on("close",code=>{controller.signal.removeEventListener("abort",kill);if(code===0&&!controller.signal.aborted)resolve();else reject(new Error(reason));});});await writing;nativeAssert(!controller.signal.aborted,reason);return "";}
 finally{clearTimeout(timer);options.signal?.removeEventListener("abort",stop);try{await writing;await log.sync();}finally{await log.close();}}
}
async function compilerProcess(config:NativeConfig,directory:string,executable:string,args:string[],options:Parameters<typeof trustedProcess>[2],logFile?:string,compileToolsDirectory?:string):Promise<string>{
 nativeAssert(process.platform==="darwin","ISOLATION_UNAVAILABLE");const sandbox="/usr/bin/sandbox-exec";try{nativeAssert((await stat(sandbox)).isFile(),"ISOLATION_UNAVAILABLE");}catch{throw new Error("ISOLATION_UNAVAILABLE");}
 const profile=join(directory,"compiler.sb");await writeFile(profile,nativeCompilerSandbox(config,compileToolsDirectory),{mode:0o600});
 try{await trustedProcess(sandbox,["-f",profile,"/usr/bin/true"],{cwd:options?.cwd??directory,env:processEnvironment(),...(options?.signal?{signal:options.signal}:{}),timeoutMs:10000});}catch{throw new Error("ISOLATION_UNAVAILABLE");}
 return logFile?privateCompilerProcess(sandbox,["-f",profile,executable,...args],logFile,options??{}):trustedProcess(sandbox,["-f",profile,executable,...args],options);
}
async function inside(root:string,path:string):Promise<string>{const p=resolve(root,path);nativeAssert(relative(root,p)!==""&&!relative(root,p).startsWith("..")&&!isAbsolute(relative(root,p)),"NATIVE_SOURCE_INVALID");const actual=await realpath(p);nativeAssert(actual===p,"NATIVE_SOURCE_INVALID");return p;}
export async function verifyNativeSource(config:NativeConfig,job:NativeJob,signal?:AbortSignal):Promise<string>{
 const source=await realpath(config.sourceDirectory),s=await stat(source);nativeAssert(source===config.sourceDirectory&&s.isDirectory()&&s.uid===process.getuid?.(),"NATIVE_SOURCE_INVALID");
 const scratch=await realpath(await mkdtemp(join(tmpdir(),"flora-native-source-")));await chmod(scratch,0o700);
 const run=(args:string[])=>compilerProcess(config,scratch,config.tools.git,["--no-optional-locks","-c","core.fsmonitor=false","-c","core.hooksPath=/dev/null",...args],{cwd:source,env:processEnvironment({GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null"}),...(signal?{signal}:{})});
 try{nativeAssert((await run(["rev-parse","HEAD"])).trim()===job.commitSha,"NATIVE_SOURCE_MISMATCH");
  const origin=(await run(["remote","get-url","origin"])).trim(),repo=job.source.owner+"/"+job.source.repository;
  nativeAssert(origin===`https://github.com/${repo}.git`||origin===`https://github.com/${repo}`||origin===`git@github.com:${repo}.git`,"NATIVE_SOURCE_MISMATCH");
  nativeAssert((await run(["status","--porcelain","--untracked-files=no","--ignore-submodules=all"])).trim()==="","NATIVE_SOURCE_DIRTY");
  nativeAssert(job.source.rootDirectory==="."||typeof job.source.rootDirectory==="string"&&!isAbsolute(job.source.rootDirectory)&&!job.source.rootDirectory.split(/[\\/]/).includes(".."),"NATIVE_SOURCE_INVALID");
  return job.source.rootDirectory==="."?source:inside(source,job.source.rootDirectory);
 }finally{await rm(scratch,{recursive:true,force:true});}
}
export const nativeAndroidUnsignedInit="gradle.beforeProject { p -> p.pluginManager.withPlugin('com.android.application') { p.extensions.getByName('androidComponents').finalizeDsl { android -> def unsigned = { item -> def setter = item.class.methods.find { it.name == 'setSigningConfig' && it.parameterTypes.length == 1 && it.parameterTypes[0].name == 'com.android.build.api.dsl.ApkSigningConfig' }; if (setter == null) throw new GradleException('FLORA_UNSIGNED_DSL_UNSUPPORTED'); setter.invoke(item, [null] as Object[]) }; android.buildTypes.configureEach(unsigned); android.productFlavors.configureEach(unsigned); unsigned(android.defaultConfig) } } }\n";
const nativeSwiftPMFlag="-IDEPackageSupportDisableManifestSandbox=YES",nativeSwiftMacroFlags="OTHER_SWIFT_FLAGS=$(inherited) -disable-sandbox";
export async function prepareNativeIOSTools(config:NativeConfig,directory:string):Promise<{directory:string;startup:string}>{
 nativeAssert(config.platform==="ios"&&config.tools.xcodebuild&&await realpath(directory)===directory,"INVALID_NATIVE_CONFIG");const root=await lstat(directory);nativeAssert(root.isDirectory()&&!root.isSymbolicLink()&&(root.mode&0o777)===0o700&&root.uid===process.getuid?.(),"INVALID_NATIVE_CONFIG");
 const tool=await realpath(config.tools.xcodebuild);nativeAssert(tool===config.tools.xcodebuild&&isAbsolute(tool),"INVALID_NATIVE_CONFIG");const tools=join(directory,"tools"),startup=join(tools,"bash-startup.sh");await mkdir(tools,{mode:0o700});
 const shellQuote=(value:string)=>"'"+value.replace(/'/g,"'\\''")+"'";
 await writeFile(join(tools,"xcodebuild"),"#!/bin/sh\nexec "+shellQuote(tool)+" "+shellQuote(nativeSwiftPMFlag)+' "$@" CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO '+shellQuote(nativeSwiftMacroFlags)+"\n",{mode:0o700,flag:"wx"});await writeFile(startup,"export PATH="+shellQuote(tools)+':"$PATH"\n',{mode:0o600,flag:"wx"});return {directory:tools,startup};
}
export async function compileNativeUnsigned(config:NativeConfig,job:NativeJob,directory:string,signal:AbortSignal):Promise<string>{
 const source=await verifyNativeSource(config,job,signal),expoHome=join(directory,"expo-home");await mkdir(expoHome,{mode:0o700});const home=await lstat(expoHome);nativeAssert(await realpath(expoHome)===expoHome&&home.isDirectory()&&!home.isSymbolicLink()&&(home.mode&0o777)===0o700&&home.uid===process.getuid?.()&&(await readdir(expoHome)).length===0,"INVALID_NATIVE_CONFIG");
 const env=processEnvironment({...config.buildEnvironment,...(config.publicConfigDirectory?{UULAB_CREDENTIALS_DIR:config.publicConfigDirectory}:{}),__UNSAFE_EXPO_HOME_DIRECTORY:expoHome,EXPO_NO_TELEMETRY:"1",EXPO_NO_TELEMETRY_DETACH:"1"});
 if(config.publicConfigDirectory){const s=await lstat(config.publicConfigDirectory);nativeAssert(await realpath(config.publicConfigDirectory)===config.publicConfigDirectory&&s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.getuid?.(),"INVALID_NATIVE_CONFIG");}
 nativeAssert(/^[a-z][a-z0-9_-]{2,95}$/.test(job.id),"NATIVE_ARTIFACT_INVALID");const log=config.privateCompilerLogDirectory?join(config.privateCompilerLogDirectory,job.id+".log"):undefined;
 if(job.platform==="android"){
  const android=await inside(source,config.android!.directory),gradlew=await inside(android,"gradlew"),init=join(directory,"unsigned.gradle");
  await writeFile(init,nativeAndroidUnsignedInit,{mode:0o600});
  await compilerProcess(config,directory,gradlew,["--no-daemon","--max-workers=2","--rerun-tasks","--init-script",init,":app:assembleRelease"],{cwd:android,env,signal,timeoutMs:45*60*1000,maxBytes:64*1024*1024},log);
  const artifact=await inside(android,config.android!.apkPath),dest=join(directory,"unsigned.apk");await copyFile(artifact,dest);await chmod(dest,0o600);return dest;
 }
 const workspace=await inside(source,config.ios!.workspace),derived=join(directory,"derived"),tools=await prepareNativeIOSTools(config,directory);
 await compilerProcess(config,directory,config.tools.xcodebuild!,[nativeSwiftPMFlag,"-workspace",workspace,"-scheme",config.ios!.scheme,"-configuration","Release","-sdk","iphoneos","-destination","generic/platform=iOS","-derivedDataPath",derived,"-jobs","2","CODE_SIGNING_ALLOWED=NO","CODE_SIGNING_REQUIRED=NO",nativeSwiftMacroFlags,"build"],{cwd:source,env:{...env,BASH_ENV:tools.startup},signal,timeoutMs:60*60*1000,maxBytes:64*1024*1024},log,tools.directory);
 return inside(derived,join("Build/Products/Release-iphoneos",config.ios!.appName));
}
export async function readNativeEntitlements(config:NativeConfig,source:string,signal?:AbortSignal):Promise<{sha256:string;values:Record<string,unknown>}>{
 const name=config.ios?.entitlementsFile??"ios/app/app.entitlements";nativeAssert(!isAbsolute(name)&&!name.split(/[\\/]/).includes("..")&&name.endsWith(".entitlements"),"NATIVE_ENTITLEMENTS_INVALID");const path=await inside(source,name),before=await lstat(path);nativeAssert(before.isFile()&&!before.isSymbolicLink()&&before.size<=65536,"NATIVE_ENTITLEMENTS_INVALID");
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let data:Buffer;try{const s=await file.stat();nativeAssert(s.ino===before.ino&&s.dev===before.dev&&s.size===before.size,"NATIVE_ENTITLEMENTS_INVALID");const chunks:Buffer[]=[];let bytes=0;for(;;){const buffer=Buffer.alloc(4096),part=await file.read(buffer);if(!part.bytesRead)break;bytes+=part.bytesRead;nativeAssert(bytes<=65536,"NATIVE_ENTITLEMENTS_INVALID");chunks.push(buffer.subarray(0,part.bytesRead));}data=Buffer.concat(chunks);const after=await file.stat();nativeAssert(after.size===s.size&&after.mtimeMs===s.mtimeMs&&data.length===s.size,"NATIVE_ENTITLEMENTS_INVALID");}finally{await file.close();}
 const tool=config.tools.plutil??"/usr/bin/plutil",text=await trustedProcess(tool,["-convert","json","-o","-","--","-"],{input:data.toString("utf8"),env:processEnvironment(),...(signal?{signal}:{}),maxBytes:65536});let values:unknown;try{values=JSON.parse(text);}catch{throw new Error("NATIVE_ENTITLEMENTS_INVALID");}nativeAssert(values&&typeof values==="object"&&!Array.isArray(values),"NATIVE_ENTITLEMENTS_INVALID");return {sha256:createHash("sha256").update(data).digest("hex"),values:values as Record<string,unknown>};
}
export function verifyNativeGrant(job:NativeJob,grant:NativeGrant):void {
 nativeAssert(grant.appId===job.appId&&grant.jobId===job.id&&grant.platform===job.platform&&grant.commitSha===job.commitSha&&grant.expiresAt>Date.now(),"NATIVE_GRANT_INVALID");
 nativeAssert(grant.credentials.length===job.credentials.length&&new Set(grant.credentials.map(c=>c.kind)).size===job.credentials.length&&grant.credentials.every(c=>job.credentials.some(p=>p.kind===c.kind&&p.version===c.version)&&typeof c.payload?.fileBase64==="string"&&c.payload.fileBase64.length<=1500000),"NATIVE_GRANT_INVALID");
 const allowed=job.platform==="ios"?["ios_distribution","ios_provisioning"]:["android_keystore"];nativeAssert(grant.credentials.length===allowed.length&&grant.credentials.every(c=>allowed.includes(c.kind)),"NATIVE_GRANT_INVALID");
}
export async function nativeUnsignedDigest(path:string):Promise<string>{
 const hash=createHash("sha256");let total=0,entries=0;
 const visit=async(current:string,name:string):Promise<void>=>{const s=await lstat(current);nativeAssert(!s.isSymbolicLink()&&(s.isFile()||s.isDirectory())&&++entries<=10000,"NATIVE_ARTIFACT_INVALID");hash.update(JSON.stringify([name,s.isDirectory()?"directory":"file",s.mode&0o777])+"\n");if(s.isDirectory()){for(const child of (await readdir(current)).sort())await visit(join(current,child),join(name,child));}else{total+=s.size;nativeAssert(total<=512*1024*1024,"NATIVE_ARTIFACT_INVALID");const fd=await open(current,constants.O_RDONLY|constants.O_NOFOLLOW);try{const fs=await fd.stat();nativeAssert(fs.ino===s.ino&&fs.dev===s.dev&&fs.size===s.size,"NATIVE_ARTIFACT_INVALID");const buffer=Buffer.alloc(65536);for(;;){const read=await fd.read(buffer);if(!read.bytesRead)break;hash.update(buffer.subarray(0,read.bytesRead));}}finally{await fd.close();}}};
 await visit(path,"product");return hash.digest("hex");
}
const freezeProgram=String.raw`
import os,sys,stat
root,rel,dest,device,inode=sys.argv[1:]
DIRECTORY=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
def directory(path):
 fd=os.open('/',DIRECTORY)
 try:
  for part in path.split('/'):
   if not part: continue
   if part in ('.','..'): raise ValueError('path')
   nextfd=os.open(part,DIRECTORY,dir_fd=fd);os.close(fd);fd=nextfd
  return fd
 except:
  os.close(fd);raise
source=directory(root);target=directory(dest)
identity=os.fstat(source)
if identity.st_dev!=int(device) or identity.st_ino!=int(inode):raise ValueError('identity')
parts=rel.split('/')
if any(p in ('','..','.') for p in parts):raise ValueError('path')
for part in parts[:-1]:
 nextfd=os.open(part,DIRECTORY,dir_fd=source);os.close(source);source=nextfd
count=0;total=0
def copy(parent,name,output,outname,depth=0):
 global count,total
 count+=1
 if count>20000 or depth>64:raise ValueError('capacity')
 before=os.stat(name,dir_fd=parent,follow_symlinks=False)
 if stat.S_ISDIR(before.st_mode):
  fd=os.open(name,DIRECTORY,dir_fd=parent);actual=os.fstat(fd)
  if actual.st_ino!=before.st_ino or actual.st_dev!=before.st_dev:raise ValueError('identity')
  os.mkdir(outname,0o700,dir_fd=output);dst=os.open(outname,DIRECTORY,dir_fd=output)
  try:
   for child in sorted(os.listdir(fd)):copy(fd,child,dst,child,depth+1)
  finally:os.close(fd);os.close(dst)
 elif stat.S_ISREG(before.st_mode):
  fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=parent);actual=os.fstat(fd)
  if actual.st_ino!=before.st_ino or actual.st_dev!=before.st_dev or actual.st_size!=before.st_size:raise ValueError('identity')
  total+=actual.st_size
  if total>1073741824:raise ValueError('capacity')
  dst=os.open(outname,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o700 if actual.st_mode&0o111 else 0o600,dir_fd=output)
  try:
   length=0
   while True:
    chunk=os.read(fd,65536)
    if not chunk:break
    length+=len(chunk)
    if length>actual.st_size:raise ValueError('changed')
    position=0
    while position<len(chunk):position+=os.write(dst,chunk[position:])
   after=os.fstat(fd)
   if length!=actual.st_size or after.st_size!=actual.st_size or after.st_mtime_ns!=actual.st_mtime_ns or after.st_ctime_ns!=actual.st_ctime_ns:raise ValueError('changed')
  finally:os.close(fd);os.close(dst)
 else:raise ValueError('type')
try:copy(source,parts[-1],target,'product')
finally:os.close(source);os.close(target)
`;
export async function freezeNativeUnsigned(root:string,relativePath:string,destination:string,signal?:AbortSignal):Promise<string>{
 const s=await lstat(root);nativeAssert(s.isDirectory()&&!s.isSymbolicLink()&&await realpath(root)===root,"NATIVE_ARTIFACT_INVALID");await mkdir(destination,{mode:0o700});
 await trustedProcess("/usr/bin/python3",["-I","-S","-c",freezeProgram,root,relativePath,destination,String(s.dev),String(s.ino)],{env:processEnvironment(),...(signal?{signal}:{}),timeoutMs:120000,maxBytes:1024});return join(destination,"product");
}
async function sign(config:NativeConfig,job:NativeJob,grant:NativeGrant,unsigned:string,directory:string,signal:AbortSignal,requestedEntitlements?:Record<string,unknown>):Promise<NativeArtifact>{
 const common={jobId:job.id,appId:job.appId,applicationId:job.appIdentifier,expectedCertificateSha256:config.expectedCertificateSha256,temporaryRoot:directory,signal};
 let signed:string,signerFingerprint:string;
 if(job.platform==="android"){
  const payload=grant.credentials[0]!.payload;nativeAssert(typeof payload.password==="string"&&typeof payload.keyAlias==="string","NATIVE_GRANT_INVALID");signed=join(directory,"signed.apk");
  const receipt=await signAndroidApk({...common,credential:{...payload,password:payload.password,keyAlias:payload.keyAlias},unsignedApk:unsigned,outputApk:signed,tools:config.tools});signerFingerprint=receipt.certificateSha256;
 }else{
  const certificate=grant.credentials.find(c=>c.kind==="ios_distribution")!.payload,profile=grant.credentials.find(c=>c.kind==="ios_provisioning")!.payload;nativeAssert(typeof certificate.password==="string"&&job.teamId,"NATIVE_GRANT_INVALID");
  const payload=join(directory,"Payload");await mkdir(payload,{mode:0o700});const outputApp=join(payload,config.ios!.appName);
  const receipt=await signIOSApp({...common,teamId:job.teamId,certificate:{fileBase64:certificate.fileBase64,password:certificate.password},provisioning:{fileBase64:profile.fileBase64},unsignedApp:unsigned,outputApp,tools:config.tools,...(requestedEntitlements?{requestedEntitlements}: {})});signerFingerprint=receipt.certificateSha256;signed=join(directory,"signed.ipa");
  await trustedProcess(config.tools.ditto!,["-c","-k","--sequesterRsrc","--keepParent",payload,signed],{env:processEnvironment(),signal,timeoutMs:120000,maxBytes:1024*1024});
 }
 const size=await lstat(signed);nativeAssert(size.isFile()&&!size.isSymbolicLink()&&size.size>0&&size.size<=512*1024*1024,"NATIVE_ARTIFACT_INVALID");const bytes=await readFile(signed);
 const fileName=job.id+(job.platform==="ios"?".ipa":".apk");await chmod(signed,0o600);
 return {fileName,sha256:createHash("sha256").update(bytes).digest("hex"),byteLength:bytes.length,appIdentifier:job.appIdentifier,platform:job.platform,signerFingerprint,...(job.teamId?{teamId:job.teamId}:{})};
}
function nativeTransient(error:unknown):boolean{return error instanceof NativeHttpFailure&&(error.status>=500||error.status===429||error.status===409&&error.safeCode==="BUSY")||error instanceof Error&&error.message==="NATIVE_TRANSPORT_UNAVAILABLE";}
export async function renewNativeLease(client:NativeClient,lease:NativeLease,signal:AbortSignal):Promise<NativeLease>{
 for(let attempt=0;;attempt++){
  nativeAssert(!signal.aborted,"NATIVE_CANCELLED");const remaining=lease.expiresAt-Date.now();nativeAssert(remaining>0,"NATIVE_LEASE_EXPIRED");const request=new AbortController(),abort=()=>request.abort(),timer=setTimeout(abort,Math.min(20000,remaining));signal.addEventListener("abort",abort,{once:true});let rejectAbort:((error:Error)=>void)|undefined;const cancelled=()=>rejectAbort?.(new Error(signal.aborted?"NATIVE_CANCELLED":Date.now()>=lease.expiresAt?"NATIVE_LEASE_EXPIRED":"NATIVE_TRANSPORT_UNAVAILABLE"));request.signal.addEventListener("abort",cancelled,{once:true});
  try{const result=await Promise.race([client.heartbeat(lease,request.signal),new Promise<never>((_resolve,reject)=>{rejectAbort=reject;if(request.signal.aborted)cancelled();})]);nativeAssert(!signal.aborted,"NATIVE_CANCELLED");nativeAssert(Date.now()<lease.expiresAt&&result.expiresAt>Date.now(),"NATIVE_LEASE_EXPIRED");return result;}
  catch(error){nativeAssert(!signal.aborted,"NATIVE_CANCELLED");if(attempt>=2||!nativeTransient(error))throw error;const delay=250*(attempt+1);nativeAssert(lease.expiresAt-Date.now()>delay,"NATIVE_LEASE_EXPIRED");await nativePause(delay,signal);}
  finally{clearTimeout(timer);signal.removeEventListener("abort",abort);request.signal.removeEventListener("abort",cancelled);}
 }
}
export interface NativeRunDependencies {compile?:typeof compileNativeUnsigned;sign?:typeof sign;heartbeatMs?:number;signal?:AbortSignal;diagnostics?:boolean}
export function nativeFailureDiagnostic(error:unknown,phase:string):{diagnostic:true;stage:string;code:string;operation?:string}{
 const stages=["native-work-directory","native-heartbeat","native-claim","native-source-verify","native-entitlements-read","native-compile","native-product-freeze","native-source-recheck","native-credential-grant","native-sign","native-completion"],codes=["NATIVE_SOURCE_MISMATCH","NATIVE_SOURCE_DIRTY","NATIVE_SOURCE_INVALID","NATIVE_RESPONSE_INVALID","NATIVE_REQUEST_REJECTED","NATIVE_TRANSPORT_UNAVAILABLE","NATIVE_LEASE_EXPIRED","INVALID_NATIVE_CONFIG","ISOLATION_UNAVAILABLE","EXECUTION_FAILED","PROCESS_CANCELLED","PROCESS_TIMEOUT","PROCESS_OUTPUT_LIMIT","PROCESS_SPAWN_FAILED","NATIVE_ENTITLEMENTS_INVALID","NATIVE_ENTITLEMENTS_CHANGED","NATIVE_ARTIFACT_INVALID","NATIVE_CANCELLED","NATIVE_COMPILER_FAILED","NATIVE_COMPILER_TIMEOUT","BUSY","SIGNING_CREDENTIAL_INVALID","SIGNING_IDENTITY_INVALID","SIGNING_PROFILE_INVALID","SIGNING_ENTITLEMENTS_INVALID","SIGNING_ARTIFACT_INVALID","SIGNING_PATH_INVALID","SIGNING_TOOL_FAILED","SIGNING_CANCELLED","SIGNING_CLEANUP_UNCONFIRMED","SIGNING_FAILED"],filesystemCodes=["ENOENT","EACCES","EPERM","EROFS","EEXIST","ENOSPC","EMFILE","ENFILE","ENAMETOOLONG"];
 const candidate=error instanceof ProcessFailure?error.safeCode:error instanceof Error?error.message:"",fs=error&&typeof error==="object"&&"code" in error&&typeof error.code==="string"&&filesystemCodes.includes(error.code)?error.code:null;return {diagnostic:true,stage:stages.includes(phase)?phase:"native-execution",code:codes.includes(candidate)?candidate:fs??"NATIVE_BUILD_FAILED",...(phase==="native-sign"&&error instanceof NativeSigningFailure?{operation:new NativeSigningFailure(error.message,error.operation).operation}:{})};
}
export async function runNativeJob(config:NativeConfig,client:NativeClient,jobId:string,deps:NativeRunDependencies={}):Promise<NativeArtifact>{
 nativeAssert(!deps.signal?.aborted,"NATIVE_CANCELLED");
 validateNativeConfig(config);const root=config.artifactDirectory;await mkdir(root,{recursive:true,mode:0o700});const rs=await lstat(root);nativeAssert(await realpath(root)===root&&rs.isDirectory()&&!rs.isSymbolicLink()&&(rs.mode&0o777)===0o700&&rs.uid===process.getuid?.(),"INVALID_NATIVE_CONFIG");
 nativeAssert(!deps.signal?.aborted,"NATIVE_CANCELLED");if(deps.diagnostics)process.stdout.write(JSON.stringify({diagnostic:true,stage:"native-claim"})+"\n");let claim:Awaited<ReturnType<NativeClient["claim"]>>;try{claim=await client.claim(jobId);}catch(error){if(deps.diagnostics)process.stdout.write(JSON.stringify(nativeFailureDiagnostic(error,"native-claim"))+"\n");throw error;}const job=claim.job;nativeAssert(job.appId===config.appId&&job.platform===config.platform,"NATIVE_JOB_MISMATCH");let lease=claim.lease;
 const controller=new AbortController(),abort=()=>controller.abort();deps.signal?.addEventListener("abort",abort,{once:true});if(deps.signal?.aborted)abort();
 let pending=Promise.resolve(),heartbeatError=false,heartbeatRunning=false,completionStarted=false,preserveDirectory=false;const timer=setInterval(()=>{if(heartbeatRunning||controller.signal.aborted)return;heartbeatRunning=true;pending=pending.then(async()=>{if(controller.signal.aborted)return;try{lease=await renewNativeLease(client,lease,controller.signal);}catch(error){if(deps.diagnostics)process.stdout.write(JSON.stringify({...nativeFailureDiagnostic(error,"native-heartbeat"),...(error instanceof NativeHttpFailure?{status:error.status}:{})})+"\n");heartbeatError=true;controller.abort();}}).finally(()=>{heartbeatRunning=false;});},deps.heartbeatMs??15000);timer.unref();
 let directory:string,compileDirectory:string;try{directory=await mkdtemp(join(root,".native-"));await chmod(directory,0o700);compileDirectory=await realpath(await mkdtemp(join(tmpdir(),"flora-native-compile-")));await chmod(compileDirectory,0o700);}catch(error){if(deps.diagnostics)process.stdout.write(JSON.stringify(nativeFailureDiagnostic(error,"native-work-directory"))+"\n");clearInterval(timer);controller.abort();await pending;deps.signal?.removeEventListener("abort",abort);throw new Error("NATIVE_BUILD_FAILED");}
 let phase="native-source-verify";try{
  const diagnostic=(stage:string)=>{if(deps.diagnostics)process.stdout.write(JSON.stringify({diagnostic:true,stage})+"\n");};
  diagnostic("native-source-verify");const source=await verifyNativeSource(config,job,controller.signal);phase="native-entitlements-read";const entitlements=job.platform==="ios"?await readNativeEntitlements(config,source,controller.signal):undefined;phase="native-compile";diagnostic("native-compile-start");let unsigned=await (deps.compile??compileNativeUnsigned)(config,job,compileDirectory,controller.signal);diagnostic("native-compile-complete");
  phase="native-product-freeze";const unsignedRelative=relative(compileDirectory,unsigned);nativeAssert(unsignedRelative&&!unsignedRelative.startsWith("..")&&!isAbsolute(unsignedRelative),"NATIVE_ARTIFACT_INVALID");unsigned=await freezeNativeUnsigned(compileDirectory,unsignedRelative,join(directory,"compiled"),controller.signal);const unsignedDigest=await nativeUnsignedDigest(unsigned);
  phase="native-source-recheck";nativeAssert(!controller.signal.aborted,"NATIVE_CANCELLED");await pending;await verifyNativeSource(config,job,controller.signal);if(entitlements){const after=await readNativeEntitlements(config,source,controller.signal);nativeAssert(after.sha256===entitlements.sha256,"NATIVE_ENTITLEMENTS_CHANGED");await writeFile(join(directory,"source-entitlements.json"),JSON.stringify(entitlements)+"\n",{mode:0o600});}
  phase="native-credential-grant";diagnostic("native-credential-grant");const grant=await client.credentials(lease);let grantDeadline:ReturnType<typeof setTimeout>|undefined;
  let artifact:NativeArtifact;try{verifyNativeGrant(job,grant);nativeAssert(!controller.signal.aborted,"NATIVE_CANCELLED");nativeAssert(await nativeUnsignedDigest(unsigned)===unsignedDigest,"NATIVE_ARTIFACT_INVALID");grantDeadline=setTimeout(()=>controller.abort(),Math.max(1,grant.expiresAt-Date.now()));phase="native-sign";diagnostic("native-sign-start");artifact=await (deps.sign??sign)(config,job,grant,unsigned,directory,controller.signal,entitlements?.values);nativeAssert(await nativeUnsignedDigest(unsigned)===unsignedDigest,"NATIVE_ARTIFACT_INVALID");diagnostic("native-sign-complete");}finally{if(grantDeadline)clearTimeout(grantDeadline);for(const item of grant.credentials){if(item.payload&&typeof item.payload==="object"){item.payload.fileBase64="";if(item.payload.password)item.payload.password="";if(item.payload.keyPassword)item.payload.keyPassword="";}}}
  const receiptPath=join(root,artifact.fileName+".receipt.json"),receipt={jobId:job.id,appId:job.appId,commitSha:job.commitSha,...artifact,...(entitlements?{sourceEntitlements:entitlements}:{})};
  await writeFile(receiptPath,JSON.stringify({...receipt,completionConfirmed:false},null,2)+"\n",{mode:0o600});
  phase="native-completion";clearInterval(timer);await pending;nativeAssert(!controller.signal.aborted,"NATIVE_CANCELLED");lease=await renewNativeLease(client,lease,controller.signal);completionStarted=true;diagnostic("native-completion-start");await client.complete(lease,artifact);
  await rename(join(directory,job.platform==="ios"?"signed.ipa":"signed.apk"),join(root,artifact.fileName));
  await writeFile(receiptPath,JSON.stringify({...receipt,completionConfirmed:true},null,2)+"\n",{mode:0o600});return artifact;
 }catch(error){
  if(deps.diagnostics)process.stdout.write(JSON.stringify(nativeFailureDiagnostic(error,phase))+"\n");
  if(completionStarted){const staged=join(directory,job.platform==="ios"?"signed.ipa":"signed.apk");try{const s=await lstat(staged);if(s.isFile()&&!s.isSymbolicLink()&&s.size>0&&s.size<=512*1024*1024){const quarantine=join(root,".pending");await mkdir(quarantine,{mode:0o700,recursive:true});const qs=await lstat(quarantine);nativeAssert(qs.isDirectory()&&!qs.isSymbolicLink()&&(qs.mode&0o777)===0o700&&qs.uid===process.getuid?.(),"NATIVE_ARTIFACT_INVALID");const name=job.id+"."+lease.attemptId+(job.platform==="ios"?".ipa":".apk");await rename(staged,join(quarantine,name));await chmod(join(quarantine,name),0o600);await writeFile(join(quarantine,name+".lease.json"),JSON.stringify({lease,jobId:job.id,appId:job.appId,commitSha:job.commitSha,completionConfirmed:false})+"\n",{mode:0o600});}}catch{preserveDirectory=true;}}
  if(!completionStarted)await rm(join(root,job.id+(job.platform==="ios"?".ipa":".apk")+".receipt.json"),{force:true});
  if(!completionStarted&&!heartbeatError&&!controller.signal.aborted){try{await client.fail(lease,error instanceof Error&&error.message==="NATIVE_CANCELLED"?"CANCELLED":"NATIVE_BUILD_FAILED");}catch{}}throw new Error(completionStarted?"NATIVE_COMPLETION_UNKNOWN":controller.signal.aborted||error instanceof Error&&error.message==="NATIVE_CANCELLED"?"NATIVE_CANCELLED":error instanceof Error&&error.message==="ISOLATION_UNAVAILABLE"?"ISOLATION_UNAVAILABLE":"NATIVE_BUILD_FAILED");}
 finally{clearInterval(timer);controller.abort();await pending;deps.signal?.removeEventListener("abort",abort);if(!preserveDirectory)await rm(directory,{recursive:true,force:true});await rm(compileDirectory,{recursive:true,force:true});}
}
export interface NativeDaemonEntry {config:NativeConfig;client:NativeClient}
export interface NativeDaemonOptions {signal?:AbortSignal;pollMs?:number;presenceMs?:number;diagnostics?:boolean;runJob?:typeof runNativeJob;pause?:(milliseconds:number,signal?:AbortSignal)=>Promise<void>}
export async function assertNativeReconciled(config:NativeConfig):Promise<void>{
 let names:string[];try{names=await readdir(config.artifactDirectory);}catch(error){if(error&&typeof error==="object"&&"code" in error&&error.code==="ENOENT")return;throw new Error("NATIVE_COMPLETION_RECONCILIATION_REQUIRED");}
 const root=await lstat(config.artifactDirectory);nativeAssert(await realpath(config.artifactDirectory)===config.artifactDirectory&&root.isDirectory()&&!root.isSymbolicLink()&&(root.mode&0o777)===0o700&&root.uid===process.getuid?.(),"INVALID_NATIVE_CONFIG");
 if(names.includes(".pending")){const path=join(config.artifactDirectory,".pending"),s=await lstat(path);nativeAssert(s.isDirectory()&&!s.isSymbolicLink()&&(await readdir(path)).length===0,"NATIVE_COMPLETION_RECONCILIATION_REQUIRED");}
 for(const name of names.filter(n=>/^native_job_[a-z0-9_-]+\.(?:ipa|apk|aab)\.receipt\.json$/.test(n))){const path=join(config.artifactDirectory,name),file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=await file.stat();nativeAssert(s.isFile()&&s.size<=131072,"NATIVE_COMPLETION_RECONCILIATION_REQUIRED");let value:unknown;try{value=JSON.parse(await file.readFile("utf8"));}catch{throw new Error("NATIVE_COMPLETION_RECONCILIATION_REQUIRED");}nativeAssert(value&&typeof value==="object"&&(value as {completionConfirmed?:unknown}).completionConfirmed===true,"NATIVE_COMPLETION_RECONCILIATION_REQUIRED");}finally{await file.close();}}
}
async function nativePause(milliseconds:number,signal?:AbortSignal):Promise<void>{if(signal?.aborted)return;await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);signal?.removeEventListener("abort",done);resolve();},timer=setTimeout(done,milliseconds);signal?.addEventListener("abort",done,{once:true});if(signal?.aborted)done();});}
export async function runNativeDaemon(entries:NativeDaemonEntry[],options:NativeDaemonOptions={}):Promise<void>{
 nativeAssert(entries.length>0&&entries.length<=32&&[options.pollMs,options.presenceMs].every(ms=>ms===undefined||Number.isSafeInteger(ms)&&ms>0&&ms<=3600000),"INVALID_NATIVE_CONFIG");nativeAssert(new Set(entries.map(e=>e.config.origin+"/"+e.config.appId+"/"+e.config.platform)).size===entries.length,"INVALID_NATIVE_CONFIG");const slots=entries.map(entry=>({...entry,disabled:false})),pause=options.pause??nativePause;
 const report=(state:string,slot:NativeDaemonEntry,code?:string,jobId?:string)=>{if(options.diagnostics)process.stdout.write(JSON.stringify({state,appId:slot.config.appId,platform:slot.config.platform,...(code?{code}:{}),...(jobId?{jobId}:{})})+"\n");};
 const transient=nativeTransient;
 const disabled=(error:unknown)=>error instanceof NativeHttpFailure?error.status===401||error.status===403:error instanceof Error&&error.message==="NATIVE_RESPONSE_INVALID";
 async function bounded<T>(action:()=>Promise<T>):Promise<T>{for(let attempt=0;;attempt++){if(options.signal?.aborted)throw new Error("NATIVE_CANCELLED");try{return await action();}catch(error){if(attempt>=2||!transient(error))throw error;await pause(250*(attempt+1),options.signal);}}}
 for(const slot of slots){validateNativeConfig(slot.config);await assertNativeReconciled(slot.config);}
 let presence=Promise.resolve(),presenceRunning=false,presenceFailure:unknown;
 const updatePresence=()=>{if(presenceRunning||options.signal?.aborted)return;presenceRunning=true;presence=(async()=>{for(const slot of slots){if(slot.disabled||options.signal?.aborted)continue;try{await bounded(()=>slot.client.presence());}catch(error){if(disabled(error)&&!options.signal?.aborted){slot.disabled=true;report("native_runner_disabled",slot,"NATIVE_REQUEST_REJECTED");}else if(!options.signal?.aborted)report("native_runner_retry_exhausted",slot,"NATIVE_TRANSPORT_UNAVAILABLE");}}})().catch(error=>{presenceFailure=error;}).finally(()=>{presenceRunning=false;});};
 updatePresence();await presence;const timer=setInterval(updatePresence,options.presenceMs??60000);timer.unref();let cursor=0;
 try{while(!options.signal?.aborted){if(presenceFailure)throw new Error("NATIVE_DAEMON_UNAVAILABLE");nativeAssert(slots.some(slot=>!slot.disabled),"NATIVE_RUNNERS_DISABLED");let built=false;
  for(let checked=0;checked<slots.length&&!options.signal?.aborted;checked++){const index=cursor,slot=slots[index]!;cursor=(cursor+1)%slots.length;if(slot.disabled)continue;for(const entry of slots)await assertNativeReconciled(entry.config);let jobId:string|null;
   try{jobId=await bounded(()=>slot.client.pending());}catch(error){if(options.signal?.aborted)break;if(disabled(error)){slot.disabled=true;report("native_runner_disabled",slot,"NATIVE_REQUEST_REJECTED");}else report("native_runner_retry_exhausted",slot,"NATIVE_TRANSPORT_UNAVAILABLE");continue;}
   if(options.signal?.aborted)break;if(!jobId)continue;for(const entry of slots)await assertNativeReconciled(entry.config);if(options.signal?.aborted)break;report("native_job_started",slot,undefined,jobId);built=true;
   try{await (options.runJob??runNativeJob)(slot.config,slot.client,jobId,{...(options.signal?{signal:options.signal}:{}),diagnostics:options.diagnostics??false});report("native_job_succeeded",slot,undefined,jobId);}
   catch(error){if(error instanceof Error&&error.message==="NATIVE_COMPLETION_UNKNOWN"){report("native_completion_unknown",slot,"NATIVE_COMPLETION_UNKNOWN",jobId);throw error;}if(options.signal?.aborted)break;built=false;report("native_job_failed",slot,error instanceof Error&&error.message==="NATIVE_CANCELLED"?"NATIVE_CANCELLED":error instanceof Error&&error.message==="ISOLATION_UNAVAILABLE"?"ISOLATION_UNAVAILABLE":"NATIVE_BUILD_FAILED",jobId);}
   if(built)break;
  }
  if(!built&&!options.signal?.aborted)await pause(options.pollMs??60000,options.signal);
 }}finally{clearInterval(timer);await presence;}
}
