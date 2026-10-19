import fs from "node:fs/promises";
import {constants} from "node:fs";
import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {dirname,join,isAbsolute,relative,sep} from "node:path";
import {pathToFileURL,fileURLToPath} from "node:url";
import {homedir} from "node:os";
import {readRunnerConfig,createRunnerClient} from "@flora/runner";
import {parseRunnerBinding,requireSetup,strictObject,type PublicRunnerBinding,type SetupResult} from "./contracts.js";
import {createPrivateDirectory,readPrivateFile,writePrivateFile,verifyPrivateDirectory} from "./private-files.js";
import {resolveSetupRuntime,runBoundedTool,type SetupRuntime} from "./runtime.js";
import type {SetupIO} from "./terminal.js";
interface RunnerPaths {runnerPath:string;servicePath:string;bindingPath:string}
interface RunnerDeps {run:typeof runBoundedTool;fetch:typeof fetch;dockerHost:string|undefined;availableBytes:(path:string)=>Promise<bigint>}
const defaults=():RunnerDeps=>({run:runBoundedTool,fetch:fetch,dockerHost:process.env.DOCKER_HOST,availableBytes:async path=>{const s=await fs.statfs(path,{bigint:true});return s.bavail*s.bsize;}});
const sha=(b:Uint8Array)=>createHash("sha256").update(b).digest("hex");
const json=(v:unknown)=>Buffer.from(JSON.stringify(v,null,2)+"\n");
const fixedRoot=fileURLToPath(new URL("../../../../",import.meta.url));
const safePath=(v:string)=>isAbsolute(v)&&!/[\x00-\x1f\x7f,:]/.test(v);
async function publicFile(path:string):Promise<Buffer>{
 requireSetup(safePath(path)&&await fs.realpath(path)===path,"SETUP_PUBLIC_FILE_UNSAFE");const before=await fs.lstat(path);
 requireSetup(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.uid===process.getuid?.()&&before.size<=16384&&(before.mode&0o022)===0,"SETUP_PUBLIC_FILE_UNSAFE");
 const handle=await fs.open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const s=await handle.stat();requireSetup(s.ino===before.ino&&s.dev===before.dev&&s.size<=16384,"SETUP_PUBLIC_FILE_UNSAFE");const b=Buffer.alloc(16385),r=await handle.read(b,0,b.length,0);requireSetup(r.bytesRead<=16384,"SETUP_PUBLIC_FILE_UNSAFE");return b.subarray(0,r.bytesRead);}finally{await handle.close();}
}
function connectionMatches(bytes:Buffer,binding:PublicRunnerBinding){
 const c=strictObject(JSON.parse(bytes.toString("utf8")),["appId","url","channel","runtimeVersion","certificate","keyId"]);
 requireSetup(c.appId===binding.appId&&c.url===binding.origin+"/updates/"+binding.appId&&[c.channel,c.runtimeVersion,c.certificate,c.keyId].every(v=>typeof v==="string"&&v.length>0),"SETUP_RUNNER_APP_MISMATCH");
}
async function serviceReader(path:string,supervisorMain:string){
 const modulePath=pathToFileURL(supervisorMain).href,mod=await import(modulePath) as {readConfig:(p:string)=>Promise<Record<string,unknown>>};return mod.readConfig(path);
}
async function socketHost(value:string):Promise<string>{
 requireSetup(/^unix:\/\/\//.test(value)&&!/[\x00-\x20\x7f?#]/.test(value),"SETUP_LOCAL_DOCKER_REQUIRED");
 const path=value.slice(7);requireSetup(isAbsolute(path),"SETUP_LOCAL_DOCKER_REQUIRED");const actual=await fs.realpath(path),s=await fs.stat(actual);
 requireSetup(s.isSocket()&&(s.uid===process.getuid?.()||s.uid===0)&&!(s.mode&0o002),"SETUP_LOCAL_DOCKER_REQUIRED");await fs.access(actual,constants.R_OK|constants.W_OK);return "unix://"+actual;
}
async function ensureNewDirectory(directory:string,runtime:SetupRuntime,availableBytes:RunnerDeps["availableBytes"]){
 requireSetup(["darwin","linux"].includes(process.platform)&&typeof process.getuid==="function"&&process.getuid()>0&&safePath(directory),"SETUP_RUNNER_HOST_REQUIRED");
 const rel=relative(runtime.root,directory);requireSetup(rel===".."||rel.startsWith(".."+sep)||isAbsolute(rel),"SETUP_PRIVATE_DIRECTORY_OUTSIDE_CHECKOUT_REQUIRED");
 requireSetup(await fs.realpath(dirname(directory))===dirname(directory),"SETUP_PRIVATE_PATH_UNSAFE");
 try{await fs.lstat(directory);throw Error("SETUP_EXISTING_RUNNER_PRESERVED");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
 requireSetup(await availableBytes(dirname(directory))>=2147483648n,"SETUP_DISK_SPACE_LOW");
}
export async function configureRunner(input:PublicRunnerBinding,connectionFile:string,runtimeDirectory:string,io:SetupIO,runtime:SetupRuntime,signal:AbortSignal,injected:Partial<RunnerDeps>={}):Promise<RunnerPaths>{
 const binding=parseRunnerBinding(input),deps={...defaults(),...injected};signal.throwIfAborted();
 const connection=await publicFile(connectionFile);connectionMatches(connection,binding);await ensureNewDirectory(runtimeDirectory,runtime,deps.availableBytes);
 requireSetup(isAbsolute(runtime.dockerPath)&&safePath(runtime.nodePath)&&safePath(runtime.supervisorMain),"SETUP_DOCKER_REQUIRED");
 const run=(args:string[],cwd=dirname(runtimeDirectory),timeoutMs=30000)=>deps.run(runtime.dockerPath,args,{cwd,timeoutMs,maxBytes:65536,signal});
 const host=await socketHost(deps.dockerHost??(await run(["context","inspect","--format","{{.Endpoints.docker.Host}}"])).stdout.trim());
 const hostArgs=["--host",host];await run([...hostArgs,"version","--format","{{.Server.Version}}"]);
 const preparation=await io.choose("앱 의존성 준비 방식",["npm-registry","pnpm-registry"]);requireSetup(["npm-registry","pnpm-registry"].includes(preparation),"SETUP_DEPENDENCY_PATH_UNSUPPORTED");
 let image=await io.readPublic("검증된 Docker sha256 이미지 ID [빈 값: 고정 Flora 도구 이미지 빌드]");
 await createPrivateDirectory(runtimeDirectory);
 for(const name of ["scratch","work","recovery"])await createPrivateDirectory(join(runtimeDirectory,name));
 if(!image){
  if(!await io.confirm("공개 digest로 고정된 Node 도구 이미지를 새로 빌드합니다. 앱 코드·키는 이미지에 넣지 않습니다. 계속합니까?"))throw Error("SETUP_CANCELLED");
  const build=join(runtimeDirectory,"image-build");await createPrivateDirectory(build);
  await writePrivateFile(join(build,"Dockerfile"),await fs.readFile(join(runtime.root,preparation==="pnpm-registry"?"scripts/pc-pnpm-runner.Dockerfile":"scripts/github-runner.Dockerfile")));
  const iid=join(runtimeDirectory,"image.id");await run([...hostArgs,"build","--quiet","--iidfile",iid,"--file",join(build,"Dockerfile"),build],build,600000);
  // Docker writes only a public immutable ID. Retain it with private permissions.
  const s=await fs.lstat(iid);requireSetup(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid!()&&s.size<=128,"SETUP_IMAGE_INVALID");await fs.chmod(iid,0o600);image=(await readPrivateFile(iid,128)).toString().trim();
 }
 requireSetup(/^(?:[A-Za-z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/.test(image),"SETUP_IMAGE_INVALID");
 const inspected=(await run([...hostArgs,"image","inspect",image,"--format","{{.Id}}"])).stdout.trim();requireSetup(/^sha256:[a-f0-9]{64}$/.test(inspected),"SETUP_IMAGE_INVALID");
 // Use the local immutable ID even when the input was a registry digest.
 image=inspected;const isolated=[...hostArgs,"run","--rm","--pull=never","--network=none","--read-only","--cap-drop=ALL","--security-opt=no-new-privileges","--pids-limit=32","--memory=268435456",`--user=${process.getuid!()}:${process.getgid!()}`,image];
 requireSetup((await run([...isolated,"node","-p","process.versions.node"])).stdout.trim()==="24.19.0","SETUP_IMAGE_TOOLCHAIN_MISMATCH");
 requireSetup((await run([...isolated,preparation==="pnpm-registry"?"pnpm":"npm","--version"])).stdout.trim()===(preparation==="pnpm-registry"?"11.10.0":"10.9.8"),"SETUP_IMAGE_TOOLCHAIN_MISMATCH");
 const token=await io.readSecret("웹에서 한 번 표시한 앱 전용 Runner token: ",signal);requireSetup(token.split(".")[0]===binding.runnerId,"SETUP_RUNNER_ID_MISMATCH");
 const request:typeof fetch=(url,init)=>deps.fetch(url,{...init,signal:AbortSignal.any([signal,init?.signal??AbortSignal.timeout(10000)])});
 const client=createRunnerClient({origin:binding.origin,token,fetch:request});requireSetup((await client.presence!()).runnerId===binding.runnerId,"SETUP_RUNNER_ID_MISMATCH");signal.throwIfAborted();
 const runnerPath=join(runtimeDirectory,"runner.json"),servicePath=join(runtimeDirectory,"service.json"),bindingPath=join(runtimeDirectory,"runner-binding.json");
 const runner=json({origin:binding.origin,token,dockerImage:image,dockerNetwork:"none",resourceProfile:"github-hosted",dependencyPreparation:preparation,workDirectory:join(runtimeDirectory,"work"),recoveryDirectory:join(runtimeDirectory,"recovery")});
 const service=json({runtimeDirectory,nodePath:runtime.nodePath,runnerMain:join(runtime.root,"packages/ota-runner/dist/main.js"),runnerConfigs:[runnerPath],path:[dirname(runtime.dockerPath),dirname(runtime.nodePath),"/usr/bin","/bin","/usr/sbin","/sbin"].join(":"),limaHome:runtimeDirectory,dockerHost:host,pollIntervalMs:30000});
 await writePrivateFile(runnerPath,runner);await writePrivateFile(servicePath,service);await writePrivateFile(join(runtimeDirectory,"connection.json"),connection);
 await writePrivateFile(bindingPath,json({schemaVersion:1,binding,runnerDigest:sha(runner),serviceDigest:sha(service),connectionDigest:sha(connection)}));
 await readRunnerConfig(runnerPath);await serviceReader(servicePath,runtime.supervisorMain);
 io.notice("Runner 신원을 확인했습니다. 작업 성공 여부는 첫 OTA 게시 단계에서 별도로 확인합니다. 기본 30초·유휴 최대 5분 간격이며 기존 서비스는 변경하지 않았습니다.");return {runnerPath,servicePath,bindingPath};
}
export async function verifyRunnerBinding(paths:RunnerPaths,signal:AbortSignal,injected:Partial<RunnerDeps>={}):Promise<void>{
 signal.throwIfAborted();const dir=dirname(paths.bindingPath);requireSetup(paths.runnerPath===join(dir,"runner.json")&&paths.servicePath===join(dir,"service.json")&&paths.bindingPath===join(dir,"runner-binding.json"),"SETUP_RUNNER_PATH_MISMATCH");await verifyPrivateDirectory(dir);
 const record=strictObject(JSON.parse((await readPrivateFile(paths.bindingPath)).toString()),["schemaVersion","binding","runnerDigest","serviceDigest","connectionDigest"]);requireSetup(record.schemaVersion===1,"SETUP_RUNNER_BINDING_INVALID");const binding=parseRunnerBinding(record.binding);
 const runner=await readPrivateFile(paths.runnerPath),service=await readPrivateFile(paths.servicePath),connection=await readPrivateFile(join(dir,"connection.json"));requireSetup(record.runnerDigest===sha(runner)&&record.serviceDigest===sha(service)&&record.connectionDigest===sha(connection),"SETUP_RUNNER_CONFIG_CHANGED");connectionMatches(connection,binding);
 const config=await readRunnerConfig(paths.runnerPath);requireSetup(config.origin===binding.origin&&config.token.split(".")[0]===binding.runnerId,"SETUP_RUNNER_ID_MISMATCH");
 const c=JSON.parse(service.toString());requireSetup(c.runtimeDirectory===dir&&c.runnerConfigs.length===1&&c.runnerConfigs[0]===paths.runnerPath&&config.workDirectory===join(dir,"work")&&config.recoveryDirectory===join(dir,"recovery"),"SETUP_RUNNER_PATH_MISMATCH");
 await serviceReader(paths.servicePath,join(fixedRoot,"scripts/local-runner/supervisor.mjs"));await socketHost(c.dockerHost);const deps={...defaults(),...injected};
 const request:typeof fetch=(url,init)=>deps.fetch(url,{...init,signal:AbortSignal.any([signal,init?.signal??AbortSignal.timeout(10000)])});
 const result=await createRunnerClient({origin:binding.origin,token:config.token,fetch:request}).presence!();requireSetup(result.runnerId===binding.runnerId,"SETUP_RUNNER_ID_MISMATCH");signal.throwIfAborted();
}
export async function startConfiguredRunner(servicePath:string,signal:AbortSignal):Promise<number>{
 const dir=dirname(servicePath);await verifyRunnerBinding({runnerPath:join(dir,"runner.json"),servicePath,bindingPath:join(dir,"runner-binding.json")},signal);
 try{await fs.lstat(join(dir,"fatal-stop"));throw Error("SETUP_RUNNER_FATAL_STOP_PRESERVED");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
 const c=await serviceReader(servicePath,join(fixedRoot,"scripts/local-runner/supervisor.mjs"));
 return new Promise((resolve,reject)=>{
  const child=spawn(c.nodePath as string,[join(fixedRoot,"scripts/local-runner/supervisor.mjs"),servicePath],{cwd:dir,env:{HOME:process.env.HOME,PATH:c.path as string},shell:false,detached:true,stdio:"ignore"});let timer:ReturnType<typeof setTimeout>|undefined;
  const stop=()=>{if(!child.pid)return;try{process.kill(-child.pid,"SIGTERM");}catch{}timer??=setTimeout(()=>{try{process.kill(-child.pid!,"SIGKILL");}catch{}},30000);timer.unref();};
  signal.addEventListener("abort",stop,{once:true});if(signal.aborted)stop();
  const cleanup=()=>{clearTimeout(timer);signal.removeEventListener("abort",stop);};child.once("error",()=>{cleanup();reject(Error("SETUP_RUNNER_START_FAILED"));});child.once("close",code=>{cleanup();resolve(signal.aborted?130:code??1);});
 });
}
export async function setupRunner(io:SetupIO,signal:AbortSignal):Promise<SetupResult>{
 const runtime=await resolveSetupRuntime(fixedRoot),bindingPath=await io.readPublic("웹에서 받은 runner-binding.json 절대 경로"),connectionFile=await io.readPublic("같은 앱의 flora.connection.json 절대 경로");
 const binding=parseRunnerBinding(JSON.parse((await publicFile(bindingPath)).toString())),base=join(await fs.realpath(homedir()),".flora-runner-"+binding.appId+"-"+binding.runnerId.slice(7,15));
 const directory=await io.readPublic("새 private Runner 디렉터리 ["+base+"]")||base;
 const paths={runnerPath:join(directory,"runner.json"),servicePath:join(directory,"service.json"),bindingPath:join(directory,"runner-binding.json")};
 let existing=false;try{await fs.lstat(directory);existing=true;}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
 if(existing){
  const record=JSON.parse((await readPrivateFile(paths.bindingPath)).toString());
  requireSetup(JSON.stringify(parseRunnerBinding(record.binding))===JSON.stringify(binding)&&record.connectionDigest===sha(await publicFile(connectionFile)),"SETUP_RUNNER_APP_MISMATCH");
  await verifyRunnerBinding(paths,signal);io.notice("기존 앱 전용 Runner 설정을 변경 없이 다시 확인했습니다. 토큰을 재발급하지 않습니다.");
 }else await configureRunner(binding,connectionFile,directory,io,runtime,signal);
 io.notice("Runner 구성 완료: "+paths.servicePath+"\n이 단계는 자동 시작 서비스를 설치하지 않습니다. 기존 서비스·복구 저널은 보존됩니다.");
 if(!await io.confirm("지금 foreground Runner를 실행합니까? 이 터미널을 유지하고 Ctrl-C로 이 실행만 종료합니다"))return {state:"needs-operator",code:"SETUP_RUNNER_CONFIGURED"};
 const code=await startConfiguredRunner(paths.servicePath,signal);return {state:code===130?"cancelled":code===0?"ready":"needs-operator",code:code===130?"SETUP_CANCELLED":code===0?"SETUP_RUNNER_STOPPED":"SETUP_RUNNER_INSPECT_REQUIRED"};
}
