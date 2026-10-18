import fs from "node:fs/promises";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {homedir} from "node:os";
import {createHash,randomBytes,randomUUID} from "node:crypto";
import {canonicalJson} from "@app-ops/config";
import {parseJournal,requireSetup,setupOrigin,type SetupJournal,type ResourcePlan,type SetupResult,type ActionReceipt,type ProviderSnapshot} from "./contracts.js";
import {createJournal,readJournal,readPrivateFile,writePrivateFile,replaceJournal,withSetupLock} from "./private-files.js";
import {createSetupConfig,createWranglerProvider,type SetupProvider} from "./cloudflare.js";
import {resolveSetupRuntime,type SetupRuntime} from "./runtime.js";
import type {SetupIO} from "./terminal.js";
import type {SetupCommandDeps} from "../setup-command.js";
const root=fileURLToPath(new URL("../../../../",import.meta.url));
const digest=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
function receipt(action:string,state:ActionReceipt["state"],resourceId:string|null=null,observedFingerprint:string|null=null):ActionReceipt{return {action,state,resourceId,expectedFingerprint:null,observedFingerprint};}
async function exists(path:string){try{await fs.lstat(path);return true;}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return false;throw e;}}
async function sourceFingerprint():Promise<string>{
 const files=["packages/cloudflare/dist/hosted/worker.js",...(await fs.readdir(join(root,"packages/cloudflare/public"))).filter(n=>/\.(?:js|css|html|svg|png)$/.test(n)).map(n=>"packages/cloudflare/public/"+n),...(await fs.readdir(join(root,"packages/cloudflare/migrations"))).filter(n=>/^\d{4}_[a-z0-9_]+\.sql$/.test(n)).map(n=>"packages/cloudflare/migrations/"+n)];
 const hash=createHash("sha256");for(const name of files.sort()){hash.update(name+"\0");hash.update(await fs.readFile(join(root,name)));}return hash.digest("hex");
}
async function save(path:string,current:SetupJournal,next:SetupJournal):Promise<SetupJournal>{
 const bytes=await readPrivateFile(path);requireSetup(canonicalJson(parseJournal(JSON.parse(bytes.toString("utf8"))))===canonicalJson(current),"SETUP_LOCAL_DRIFT");
 const parsed=parseJournal(next);await replaceJournal(path,digest(bytes),parsed);return parsed;
}
function database(j:SetupJournal):string{const value=j.receipts.find(r=>r.action==="create-db"&&r.state==="confirmed")?.resourceId;requireSetup(value,"SETUP_DATABASE_RECEIPT_REQUIRED");return value;}
function expectedSnapshot(j:SetupJournal):ProviderSnapshot|null{
 const actions=["initial-deploy","setup-deploy","setup-remove"],last=j.receipts.findLast(r=>actions.includes(r.action)&&r.state==="confirmed");if(!last)return null;
 const route=j.receipts.find(r=>r.action===last.action+"-route"&&r.state==="confirmed");requireSetup(last.resourceId&&last.observedFingerprint&&route?.resourceId&&route.observedFingerprint,"SETUP_DEPLOYMENT_RECEIPT_REQUIRED");
 return {accountId:j.plan.accountId,workerName:j.plan.workerName,databaseId:database(j),namespaceId:route.resourceId,deploymentId:last.resourceId,configFingerprint:last.observedFingerprint,routeFingerprint:route.observedFingerprint};
}
function deploymentReceipts(action:string,snapshot:ProviderSnapshot,p:ResourcePlan,id:string):ActionReceipt[]{
 requireSetup(snapshot.accountId===p.accountId&&snapshot.workerName===p.workerName&&snapshot.databaseId===id&&snapshot.namespaceId&&snapshot.deploymentId&&snapshot.configFingerprint&&snapshot.routeFingerprint,"SETUP_PROVIDER_RECEIPT_INVALID");
 return [receipt(action,"confirmed",snapshot.deploymentId,snapshot.configFingerprint),receipt(action+"-route","confirmed",snapshot.namespaceId,snapshot.routeFingerprint)];
}
export function renderPrivateConfig(plan:ResourcePlan,databaseId:string,sourceRoot:string):Record<string,unknown>{return createSetupConfig(plan,databaseId,sourceRoot);}
async function configFile(path:string,j:SetupJournal,setup=false):Promise<string>{
 const file=join(dirname(path),setup?"setup-config.json":"config-"+randomUUID()+".json"),config=renderPrivateConfig(j.plan,database(j),root);
 if(setup){requireSetup(j.setup,"SETUP_ISSUANCE_REQUIRED");(config.vars as Record<string,unknown>).FLORA_SETUP=j.setup;}
 if(setup&&await exists(file))return file;
 await writePrivateFile(file,Buffer.from(JSON.stringify(config,null,2)+"\n"));return file;
}
async function assertSource(j:SetupJournal){requireSetup(j.receipts.find(r=>r.action==="install-source"&&r.state==="confirmed")?.observedFingerprint===await sourceFingerprint(),"SETUP_SOURCE_CHANGED");}
async function issueUnlocked(path:string,now:number):Promise<{approvalFile:string;configPath:string}>{
 let j=await readJournal(path);await assertSource(j);
 requireSetup(j.stage==="https-ready"&&j.setup===null&&!j.receipts.some(r=>r.action==="setup-issue")&&Number.isSafeInteger(now)&&now>=0,"SETUP_FIRST_ISSUANCE_UNAVAILABLE");
 j=await save(path,j,{...j,receipts:[...j.receipts,receipt("setup-issue","pending")]});
 const bytes=randomBytes(32),approvalFile=join(dirname(path),"approval-code.txt");
 try{await writePrivateFile(approvalFile,Buffer.from(bytes.toString("base64url")+"\n"));
  const setup={digest:digest(bytes),issuedAt:now,expiresAt:now+600000,generation:1 as const,purpose:"enroll" as const};
  j=await save(path,j,{...j,stage:"setup-issued",setup,receipts:j.receipts.map(r=>r.action==="setup-issue"?receipt("setup-issue","confirmed"):r)});
 }finally{bytes.fill(0);}
 return {approvalFile,configPath:await configFile(path,j,true)};
}
export async function issueFirstSetup(path:string,now:number):Promise<{approvalFile:string;configPath:string}>{return withSetupLock(dirname(path),()=>issueUnlocked(path,now));}
export async function inspectSetup(path:string):Promise<SetupJournal>{return readJournal(path);}
async function continueInstallation(path:string,provider:SetupProvider,io:SetupIO,signal:AbortSignal):Promise<SetupResult>{
 return withSetupLock(dirname(path),async()=>{
  let j=await readJournal(path);
  if(j.receipts.some(r=>r.state!=="confirmed"))return {state:"unknown",code:"SETUP_PENDING_REQUIRES_RECONCILIATION"};
  try{
   await assertSource(j);signal.throwIfAborted();
   if(j.stage==="setup-removed")return {state:"ready",code:"SETUP_CLOSED_OPERATOR_ACKNOWLEDGED"};
   requireSetup(j.receipts.some(r=>r.action==="operator-free-scope"&&r.state==="confirmed"),"SETUP_FREE_SCOPE_CONFIRMATION_REQUIRED");
   async function action<T>(name:string,execute:()=>Promise<T>,complete:(value:T,current:SetupJournal)=>SetupJournal){
    signal.throwIfAborted();j=await save(path,j,{...j,receipts:[...j.receipts,receipt(name,"pending")]});
    const value=await execute();j=await save(path,j,complete(value,j));
   }
   const confirmed=(current:SetupJournal,name:string)=>current.receipts.filter(r=>r.action!==name);
   if(j.stage==="planned"){
    const existing=await provider.inspect(j.plan,signal);requireSetup(existing.accountId===j.plan.accountId&&existing.workerName===j.plan.workerName&&existing.databaseId===null&&existing.deploymentId===null,"SETUP_EXISTING_RESOURCE_REJECTED");
    await action("create-db",()=>provider.createDatabase(j.plan,signal),(r,current)=>{requireSetup(r.databaseName===current.plan.databaseName,"SETUP_PROVIDER_RECEIPT_INVALID");return {...current,stage:"database-created",receipts:[...confirmed(current,"create-db"),receipt("create-db","confirmed",r.databaseId)]};});
   }
   if(j.stage==="database-created")await action("migrate",()=>provider.migrate(j.plan,database(j),signal),(_,current)=>({...current,stage:"schema-ready",receipts:[...confirmed(current,"migrate"),receipt("migrate","confirmed")]}));
   if(j.stage==="schema-ready"){
    if(!j.receipts.some(r=>r.action==="identity"&&r.state==="confirmed")){
     requireSetup(await provider.readIdentity(j.plan,database(j),signal)===null,"SETUP_IDENTITY_ALREADY_EXISTS");
     await action("identity",()=>provider.insertIdentity(j.plan,database(j),signal),(_,current)=>({...current,receipts:[...confirmed(current,"identity"),receipt("identity","confirmed")]}));
    }
    await action("initial-deploy",async()=>provider.deploy(j.plan,await configFile(path,j),null,signal),(snapshot,current)=>({...current,stage:"server-locked",receipts:[...confirmed(current,"initial-deploy"),...deploymentReceipts("initial-deploy",snapshot,current.plan,database(current))]}));
   }
   if(j.stage==="server-locked"){
    const expected=expectedSnapshot(j);requireSetup(canonicalJson(await provider.inspect(j.plan,signal))===canonicalJson(expected),"SETUP_PROVIDER_DRIFT");
    await provider.probeHTTPS(j.plan,signal);j=await save(path,j,{...j,stage:"https-ready",receipts:[...j.receipts,receipt("https-ready","confirmed")]});
   }
   if(j.stage==="https-ready"){await issueUnlocked(path,Date.now());j=await readJournal(path);}
   if(j.stage==="setup-issued"){
    requireSetup(j.setup&&Date.now()<j.setup.expiresAt,"SETUP_WINDOW_EXPIRED");await assertSource(j);
    const expected=expectedSnapshot(j);
    await action("setup-deploy",async()=>provider.deploy(j.plan,await configFile(path,j,true),expected,signal),(snapshot,current)=>({...current,stage:"setup-deployed",receipts:[...confirmed(current,"setup-deploy"),...deploymentReceipts("setup-deploy",snapshot,current.plan,database(current))]}));
   }
   if(j.stage==="setup-deployed"){
    io.notice(`관리자 등록: ${j.plan.origin}/setup\n승인 코드는 PC의 private 파일에서 확인하세요: ${join(dirname(path),"approval-code.txt")}\n비밀번호는 HTTPS 화면에만 입력하세요. 이미 등록했다면 새 비밀번호로 로그인부터 확인하세요.`);
    if(!await io.confirm("위 사이트에서 관리자 등록 후 로그인을 확인했습니까? 확인하면 최초 승인 창만 닫습니다"))return {state:"needs-operator",code:"SETUP_OWNER_CONFIRMATION_REQUIRED"};
    j=await save(path,j,{...j,stage:"operator-confirmed",receipts:[...j.receipts,receipt("operator-confirmed","confirmed")]});
   }
   if(j.stage==="operator-confirmed"){
    await assertSource(j);const expected=expectedSnapshot(j);
    await action("setup-remove",async()=>provider.deploy(j.plan,await configFile(path,j),expected,signal),(snapshot,current)=>({...current,stage:"setup-removed",receipts:[...confirmed(current,"setup-remove"),...deploymentReceipts("setup-remove",snapshot,current.plan,database(current))]}));
   }
   io.notice("웹 설치 마법사: "+j.plan.origin+"/onboarding");return {state:"ready",code:"SETUP_CLOSED_OPERATOR_ACKNOWLEDGED"};
  }catch(e){
   const current=await readJournal(path);const unknown=current.receipts.some(r=>r.state!=="confirmed");
   const cancelled=signal.aborted||(e instanceof Error&&e.message==="SETUP_CANCELLED");
   if(!cancelled&&!unknown&&e instanceof Error&&e.message==="SETUP_PROVIDER_DNS_READ_REQUIRED"){
    io.notice(`Cloudflare가 ${j.plan.hostname}의 DNS 레코드 조회를 거절했습니다. 현재 인증의 해당 zone DNS 읽기 권한을 확인하세요. hostname 충돌 검증을 생략하거나 권한을 자동 확대하지 않습니다. 인증을 준비한 뒤 같은 설치 원장으로 재개하세요.`);
    return {state:"needs-operator",code:"SETUP_PROVIDER_DNS_READ_REQUIRED"};
   }
   io.notice(unknown?"요청 결과 확인이 필요합니다. 같은 변경 요청을 재전송하지 않았습니다. 설치 원장과 provider 자원을 확인하세요.":"준비를 확인하지 못했습니다. Cloudflare 로그인·조회 권한·무료 사용량·DNS/TLS와 고정 소스를 확인한 뒤 같은 원장으로 재개하세요.");
   return {state:cancelled?"cancelled":unknown?"unknown":"needs-operator",code:cancelled?"SETUP_CANCELLED":unknown?"SETUP_OPERATION_UNCONFIRMED":"SETUP_PREREQUISITE_UNVERIFIED"};
  }
 });
}
export async function provisionNew(plan:ResourcePlan,path:string,provider:SetupProvider,io:SetupIO,signal:AbortSignal):Promise<SetupResult>{
 plan=parseJournal({schemaVersion:1,plan,stage:"planned",receipts:[],setup:null}).plan;
 if(await exists(path)||await exists(dirname(path))&&(await fs.readdir(dirname(path))).length>0)return {state:"needs-operator",code:"SETUP_EXISTING_PATH_USE_RESUME"};
 signal.throwIfAborted();
 if(!await io.confirm(`새 전용 자원만 생성합니다: account ${plan.accountId}, Worker ${plan.workerName}, D1 ${plan.databaseName}, HTTPS ${plan.origin}, owner ${plan.ownerEmail}. 공식 Cloudflare 대시보드에서 무료 플랜·현재 사용량·여유를 확인했습니까? 유료 전환은 하지 않습니다`))return {state:"cancelled",code:"SETUP_CANCELLED"};
 const fingerprint=await sourceFingerprint();
 await createJournal(path,{schemaVersion:1,plan,stage:"planned",receipts:[receipt("operator-free-scope","confirmed"),receipt("install-source","confirmed",null,fingerprint)],setup:null});
 return continueInstallation(path,provider,io,signal);
}
export async function resumeProvision(path:string,provider:SetupProvider,io:SetupIO,signal:AbortSignal):Promise<SetupResult>{return continueInstallation(path,provider,io,signal);}
export async function connectExisting(io:SetupIO,signal:AbortSignal):Promise<SetupResult>{
 signal.throwIfAborted();const origin=setupOrigin(await io.readPublic("기존 Flora HTTPS origin"));
 io.notice("기존 로그인으로 이어갑니다: "+origin+"/login?returnTo=%2Fonboarding");return {state:"needs-operator",code:"SETUP_CONTINUE_EXISTING_LOGIN"};
}
function interactiveProvider(runtime:SetupRuntime,directory:string,io:SetupIO):SetupProvider{
 return createWranglerProvider(runtime,directory,{readDNSCredential:async(scope,signal)=>{
  io.notice(`현재 인증으로 ${scope.hostname}의 DNS 조회가 거절됐습니다. zone ${scope.zoneId}에만 DNS 읽기를 허용한 별도 토큰을 입력하세요. 메모리에서 해당 zone DNS GET에만 사용하며 파일·환경변수·배포 명령에는 전달하지 않습니다. 빈 입력은 안전하게 중단합니다.`);
  return io.readSecret("별도 DNS 읽기 전용 토큰: ",signal);
 }});
}
export function createProvisionHandlers():Pick<SetupCommandDeps,"newInstall"|"existing"|"resume"|"inspect">{
 return {
  existing:connectExisting,
  async newInstall(io,signal){
   const runtime=await resolveSetupRuntime(root),installationId=randomUUID(),suffix=installationId.slice(0,8);
   io.notice("Cloudflare 대시보드에서 계정 ID와 기존 도메인의 zone ID를 확인하세요. 인증값은 입력하지 않습니다. 새 자원 이름은 아래 기본 이름에 고유 접미사를 붙입니다.");
   const accountId=(await io.readPublic("Cloudflare account ID")).trim(),zoneId=(await io.readPublic("도메인 zone ID")).trim(),origin=setupOrigin((await io.readPublic("새 Flora HTTPS origin")).trim()),workerBase=(await io.readPublic("새 Worker 기본 이름 [flora]")).trim()||"flora",databaseBase=(await io.readPublic("새 D1 기본 이름 [flora]")).trim()||"flora",ownerEmail=(await io.readPublic("최초 소유자 이메일")).trim();
   const defaultDirectory=join(await fs.realpath(homedir()),".flora-setup-"+installationId),directory=await io.readPublic("새 private 설치 디렉터리 ["+defaultDirectory+"]")||defaultDirectory;
   const plan:ResourcePlan={installationId,accountId,zoneId,origin,hostname:new URL(origin).hostname,workerName:workerBase+"-"+suffix,databaseName:databaseBase+"-"+suffix,ownerEmail,ownerId:"owner_"+randomUUID(),dbIdentity:randomUUID()};
   return provisionNew(plan,join(directory,"journal.json"),interactiveProvider(runtime,directory,io),io,signal);
  },
  async resume(path,io,signal){const runtime=await resolveSetupRuntime(root);return resumeProvision(path,interactiveProvider(runtime,dirname(path),io),io,signal);},
  async inspect(path){const j=await inspectSetup(path);return {state:"needs-operator",code:"SETUP_LOCAL_INSPECTION",details:{installationId:j.plan.installationId,stage:j.stage,origin:j.plan.origin,workerName:j.plan.workerName,databaseId:j.receipts.find(r=>r.action==="create-db"&&r.state==="confirmed")?.resourceId??null,pendingActions:j.receipts.filter(r=>r.state!=="confirmed").map(r=>r.action)}};},
 };
}
