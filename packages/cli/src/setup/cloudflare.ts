import {createHash,randomUUID} from "node:crypto";
import {join,isAbsolute,relative} from "node:path";
import {canonicalJson} from "@app-ops/config";
import {parseJournal,requireSetup,strictObject,type ResourcePlan,type ProviderSnapshot} from "./contracts.js";
import {readPrivateFile,writePrivateFile,verifyPrivateDirectory} from "./private-files.js";
import {runBoundedTool,type SetupRuntime} from "./runtime.js";

export interface SetupProvider {
 inspect(plan:ResourcePlan,signal:AbortSignal):Promise<ProviderSnapshot>;
 createDatabase(plan:ResourcePlan,signal:AbortSignal):Promise<{databaseId:string;databaseName:string}>;
 migrate(plan:ResourcePlan,databaseId:string,signal:AbortSignal):Promise<void>;
 readIdentity(plan:ResourcePlan,databaseId:string,signal:AbortSignal):Promise<null|{ownerId:string;origin:string;dbIdentity:string}>;
 insertIdentity(plan:ResourcePlan,databaseId:string,signal:AbortSignal):Promise<void>;
 deploy(plan:ResourcePlan,configPath:string,expected:ProviderSnapshot|null,signal:AbortSignal):Promise<ProviderSnapshot>;
 probeHTTPS(plan:ResourcePlan,signal:AbortSignal):Promise<void>;
}
interface ProviderDeps {run:typeof runBoundedTool;fetch:(url:string,init:RequestInit)=>Promise<Response>}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hash=(v:unknown)=>createHash("sha256").update(canonicalJson(v)).digest("hex");
const error=(code:string):never=>{throw new Error(code);};
function planValue(plan:ResourcePlan):ResourcePlan{return parseJournal({schemaVersion:1,plan,stage:"planned",receipts:[],setup:null}).plan;}
function record(input:unknown):Record<string,unknown>{requireSetup(!!input&&typeof input==="object"&&!Array.isArray(input),"SETUP_PROVIDER_RESPONSE_INVALID");return input as Record<string,unknown>;}
function array(input:unknown,max=100):unknown[]{requireSetup(Array.isArray(input)&&input.length<=max,"SETUP_PROVIDER_RESPONSE_INVALID");return input;}
function json(text:string):unknown{try{return JSON.parse(text);}catch{return error("SETUP_PROVIDER_RESPONSE_INVALID");}}

/** Parse only a complete generated JSON binding, never an arbitrary UUID in a log. */
export function parseCreatedDatabase(stdout:string,expectedName:string):{databaseId:string;databaseName:string}{
 requireSetup(Buffer.byteLength(stdout)<=65536,"SETUP_PROVIDER_RESPONSE_INVALID");
 const start=stdout.indexOf('{');requireSetup(start>=0,"SETUP_PROVIDER_RESPONSE_INVALID");
 let depth=0,quoted=false,escaped=false,end=-1;
 for(let i=start;i<stdout.length;i++){
  const c=stdout[i];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
  if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){end=i+1;break;}
 }
 requireSetup(end>start && (stdout.match(/"database_id"\s*:/g)??[]).length===1,"SETUP_PROVIDER_RESPONSE_INVALID");
 const root=record(json(stdout.slice(start,end))),entries=array(root.d1_databases,1),binding=record(entries[0]);
 requireSetup(entries.length===1&&binding.binding==="FLORA_DB"&&binding.database_name===expectedName&&typeof binding.database_id==="string"&&uuid.test(binding.database_id),"SETUP_PROVIDER_RESPONSE_INVALID");
 return {databaseId:binding.database_id,databaseName:expectedName};
}
function deploymentVersion(stdout:string):string{
 const values=[...stdout.matchAll(/^Current Version ID:\s*([a-f0-9-]{36})\s*$/gm)];
 requireSetup(values.length===1&&uuid.test(values[0]![1]!),"SETUP_PROVIDER_RESPONSE_INVALID");return values[0]![1]!;
}
export function createSetupConfig(plan:ResourcePlan,databaseId:string,root:string):Record<string,unknown>{
 planValue(plan);requireSetup(uuid.test(databaseId)&&isAbsolute(root),"SETUP_CONFIG_INVALID");
 return {name:plan.workerName,account_id:plan.accountId,main:join(root,"packages/cloudflare/dist/hosted/worker.js"),compatibility_date:"2026-10-07",compatibility_flags:["nodejs_compat"],workers_dev:false,preview_urls:false,
  assets:{directory:join(root,"packages/cloudflare/dist/hosted/public"),binding:"ASSETS",run_worker_first:true,html_handling:"none",not_found_handling:"none"},
  durable_objects:{bindings:[{name:"FLORA_AUTH",class_name:"FloraAuth"}]},migrations:[{tag:"v1",new_sqlite_classes:["FloraAuth"]}],
  routes:[{pattern:plan.hostname,zone_id:plan.zoneId,custom_domain:true}],
  d1_databases:[{binding:"FLORA_DB",database_name:plan.databaseName,database_id:databaseId,migrations_dir:join(root,"packages/cloudflare/migrations")}],
  vars:{FLORA_ORIGIN:plan.origin,FLORA_OWNER_ID:plan.ownerId,FLORA_OWNER_EMAIL:plan.ownerEmail,FLORA_DB_IDENTITY:plan.dbIdentity}};
}

/** Credentials stay in this closure. Only fixed GETs to api.cloudflare.com use them. */
export function createWranglerProvider(runtime:SetupRuntime,directory:string,injected:Partial<ProviderDeps>={}):SetupProvider{
 const deps:ProviderDeps={run:injected.run??runBoundedTool,fetch:injected.fetch??((url,init)=>fetch(url,init))};
 let credential:{value:string;at:number}|null=null;
 async function checkedDirectory(){await verifyPrivateDirectory(directory);const rel=relative(runtime.root,directory);requireSetup(rel.startsWith("..")||isAbsolute(rel),"SETUP_PRIVATE_DIRECTORY_OUTSIDE_CHECKOUT_REQUIRED");}
 async function run(args:readonly string[],signal:AbortSignal,maxBytes=65536){
  await checkedDirectory();return deps.run(runtime.nodePath,[runtime.wranglerEntry,...args],{cwd:directory,timeoutMs:120000,maxBytes,signal});
 }
 async function credentialValue(signal:AbortSignal):Promise<string>{
  if(credential && Date.now()-credential.at<60000)return credential.value;
  const output=await run(["auth","token","--json"],signal,4096);
  try{const v=strictObject(json(output.stdout),["type","token"]);requireSetup((v.type==="oauth"||v.type==="api_token")&&typeof v.token==="string"&&/^[A-Za-z0-9._-]{16,2048}$/.test(v.token),"SETUP_PROVIDER_AUTH_REQUIRED");credential={value:v.token,at:Date.now()};return v.token;}
  catch{return error("SETUP_PROVIDER_AUTH_REQUIRED");}
 }
 async function get(path:string,signal:AbortSignal,missing=false):Promise<unknown>{
  // Call sites generate every path after strict ResourcePlan validation.
  requireSetup(/^\/(?:accounts\/[a-f0-9]{32}(?:\/|$)|zones\/[a-f0-9]{32}(?:\/|$))/.test(path)&&!/[\r\n#]/.test(path),"SETUP_PROVIDER_PATH_INVALID");
  const token=await credentialValue(signal),timeout=AbortSignal.timeout(15000),combined=AbortSignal.any([signal,timeout]);
  try{
   const response=await deps.fetch("https://api.cloudflare.com/client/v4"+path,{method:"GET",headers:{Authorization:"Bearer "+token,Accept:"application/json"},redirect:"error",credentials:"omit",signal:combined});
   requireSetup(!response.redirected,"SETUP_PROVIDER_RESPONSE_INVALID");
   if(response.status===401||response.status===403)return error("SETUP_PROVIDER_ACCESS_DENIED");
   if(response.status===429)return error("SETUP_PROVIDER_QUOTA_OR_RATE_LIMIT");
   requireSetup(response.body,"SETUP_PROVIDER_RESPONSE_INVALID");
   const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
   try{while(true){const item=await reader.read();if(item.done)break;length+=item.value.byteLength;requireSetup(length<=1048576,"SETUP_PROVIDER_RESPONSE_INVALID");chunks.push(item.value);}}
   finally{await reader.cancel();}
   const body=record(json(Buffer.concat(chunks).toString("utf8")));
   if(missing&&response.status===404&&Array.isArray(body.errors)&&body.errors.length===1&&record(body.errors[0]).code===10007)return null;
   requireSetup(response.ok&&body.success===true,"SETUP_PROVIDER_UNAVAILABLE");
   if(body.result_info){const info=record(body.result_info);requireSetup(info.total_pages===undefined||Number(info.total_pages)<=1,"SETUP_PROVIDER_RESULT_TRUNCATED");}
   return body.result;
  }catch(e){const code=e instanceof Error?e.message:"";if(/^SETUP_PROVIDER_[A-Z_]+$/.test(code))throw e;return error(signal.aborted?"SETUP_CANCELLED":"SETUP_PROVIDER_UNAVAILABLE");}
 }
 async function inspectRaw(input:ResourcePlan,signal:AbortSignal){
  const p=planValue(input),base="/accounts/"+p.accountId,script=base+"/workers/scripts/"+p.workerName;
  const account=record(await get(base,signal));requireSetup(account.id===p.accountId,"SETUP_PROVIDER_ACCOUNT_MISMATCH");
  const zone=record(await get("/zones/"+p.zoneId,signal));requireSetup(zone.id===p.zoneId&&record(zone.account).id===p.accountId&&typeof zone.name==="string"&&(p.hostname===zone.name||p.hostname.endsWith("."+zone.name))&&zone.status==="active","SETUP_PROVIDER_DOMAIN_MISMATCH");
  const databases=array(await get(base+"/d1/database?name="+p.databaseName+"&per_page=100&page=1",signal)).map(record).filter(v=>v.name===p.databaseName);
  requireSetup(databases.length<=1,"SETUP_PROVIDER_RESPONSE_INVALID");const databaseId=databases[0]?.uuid??null;requireSetup(databaseId===null||typeof databaseId==="string"&&uuid.test(databaseId),"SETUP_PROVIDER_RESPONSE_INVALID");
  const domains=array(await get(base+"/workers/domains?hostname="+p.hostname,signal)).map(record);
  requireSetup(domains.every(d=>d.hostname===p.hostname&&d.service===p.workerName&&d.zone_id===p.zoneId),"SETUP_PROVIDER_HOSTNAME_IN_USE");
  const routes=array(await get("/zones/"+p.zoneId+"/workers/routes",signal),1000).map(record);
  const related=routes.filter(r=>{
   requireSetup(typeof r.pattern==="string","SETUP_PROVIDER_RESPONSE_INVALID");
   const pattern=r.pattern.replace(/^https?:\/\//,"").split("/")[0]!;
   return r.script===p.workerName||new RegExp("^"+pattern.split("*").map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join(".*")+"$").test(p.hostname);
  });
  requireSetup(related.every(r=>r.script===p.workerName),"SETUP_PROVIDER_HOSTNAME_IN_USE");
  const dns=array(await get("/zones/"+p.zoneId+"/dns_records?name="+p.hostname+"&per_page=100&page=1",signal));
  const rawSettings=await get(script+"/settings",signal,true);
  if(rawSettings===null){requireSetup(domains.length===0&&related.length===0&&dns.length===0,"SETUP_PROVIDER_HOSTNAME_IN_USE");return {snapshot:{accountId:p.accountId,workerName:p.workerName,databaseId,namespaceId:null,deploymentId:null,configFingerprint:null,routeFingerprint:hash({domains,related,dns})} satisfies ProviderSnapshot,versionId:null,settings:null,hostnameBound:false};}
  const settings=record(rawSettings),bindings=array(settings.bindings,100).map(record);
  const db=bindings.filter(b=>b.name==="FLORA_DB"&&b.type==="d1"),namespace=bindings.filter(b=>b.name==="FLORA_AUTH"&&b.type==="durable_object_namespace");
  requireSetup(db.length===1&&db[0]!.id===databaseId&&namespace.length===1&&namespace[0]!.class_name==="FloraAuth"&&(namespace[0]!.script_name===undefined||namespace[0]!.script_name===p.workerName)&&typeof namespace[0]!.namespace_id==="string"&&/^(?:[a-f0-9]{32}|[a-f0-9-]{36})$/.test(namespace[0]!.namespace_id),"SETUP_PROVIDER_BINDING_MISMATCH");
  for(const [name,value]of Object.entries({FLORA_ORIGIN:p.origin,FLORA_OWNER_ID:p.ownerId,FLORA_OWNER_EMAIL:p.ownerEmail,FLORA_DB_IDENTITY:p.dbIdentity}))requireSetup(bindings.some(b=>b.name===name&&b.type==="plain_text"&&b.text===value),"SETUP_PROVIDER_BINDING_MISMATCH");
  const deployments=record(await get(script+"/deployments",signal)),active=record(array(deployments.deployments,100)[0]),versions=array(active.versions,1),version=record(versions[0]);
  requireSetup(typeof active.id==="string"&&uuid.test(active.id)&&versions.length===1&&version.percentage===100&&typeof version.version_id==="string"&&uuid.test(version.version_id),"SETUP_PROVIDER_DEPLOYMENT_MISMATCH");
  return {snapshot:{accountId:p.accountId,workerName:p.workerName,databaseId,namespaceId:namespace[0]!.namespace_id,deploymentId:active.id,configFingerprint:hash({settings,versionId:version.version_id}),routeFingerprint:hash({domains,related,dns})} satisfies ProviderSnapshot,versionId:version.version_id,settings,hostnameBound:domains.length===1};
 }
 async function config(p:ResourcePlan,databaseId:string|null,signal:AbortSignal){
  signal.throwIfAborted();const path=join(directory,"wrangler-"+randomUUID()+".json");
  const value=databaseId?createSetupConfig(p,databaseId,runtime.root):{name:p.workerName,account_id:p.accountId,workers_dev:false,preview_urls:false};
  await writePrivateFile(path,Buffer.from(JSON.stringify(value)+"\n"));return path;
 }
 async function requireDatabase(p:ResourcePlan,id:string,signal:AbortSignal){requireSetup(uuid.test(id),"SETUP_PROVIDER_DATABASE_MISMATCH");const current=await inspectRaw(p,signal);requireSetup(current.snapshot.databaseId===id,"SETUP_PROVIDER_DATABASE_MISMATCH");return current;}
 async function identity(p:ResourcePlan,id:string,signal:AbortSignal){
  await requireDatabase(p,id,signal);const configPath=await config(p,id,signal),sqlPath=join(directory,"identity-read-"+randomUUID()+".sql");
  await writePrivateFile(sqlPath,Buffer.from("SELECT owner_id,origin,db_identity FROM flora_deployment WHERE singleton=1;\n"));
  const output=await run(["d1","execute","FLORA_DB","--remote","--json","--file",sqlPath,"--config",configPath],signal);
  const result=array(json(output.stdout),1);requireSetup(result.length===1,"SETUP_PROVIDER_RESPONSE_INVALID");const rows=array(record(result[0]).results,1);
  if(!rows.length)return null;const row=record(rows[0]);requireSetup(typeof row.owner_id==="string"&&typeof row.origin==="string"&&typeof row.db_identity==="string","SETUP_PROVIDER_RESPONSE_INVALID");return {ownerId:row.owner_id,origin:row.origin,dbIdentity:row.db_identity};
 }
 return {
  async inspect(p,signal){return (await inspectRaw(p,signal)).snapshot;},
  async createDatabase(p,signal){
   planValue(p);const before=await inspectRaw(p,signal);requireSetup(!before.snapshot.databaseId&&!before.snapshot.deploymentId,"SETUP_PROVIDER_RESOURCE_EXISTS");
   const path=await config(p,null,signal);let output;
   try{output=await run(["d1","create",p.databaseName,"--binding","FLORA_DB","--update-config=false","--config",path],signal);}catch{return error("SETUP_PROVIDER_CREATE_UNKNOWN");}
   const receipt=parseCreatedDatabase(output.stdout,p.databaseName),after=await inspectRaw(p,signal);requireSetup(after.snapshot.databaseId===receipt.databaseId&&!after.snapshot.deploymentId,"SETUP_PROVIDER_CREATE_UNKNOWN");return receipt;
  },
  async migrate(p,id,signal){await requireDatabase(p,id,signal);const path=await config(p,id,signal);await run(["d1","migrations","list","FLORA_DB","--remote","--config",path],signal);await run(["d1","migrations","apply","FLORA_DB","--remote","--config",path],signal);},
  readIdentity:identity,
  async insertIdentity(p,id,signal){
   const found=await identity(p,id,signal);requireSetup(found===null,"SETUP_PROVIDER_IDENTITY_EXISTS");const path=await config(p,id,signal),sqlPath=join(directory,"identity-insert-"+randomUUID()+".sql"),literal=(s:string)=>"'"+s.replaceAll("'","''")+"'";
   await writePrivateFile(sqlPath,Buffer.from(`INSERT INTO flora_deployment(singleton,owner_id,origin,db_identity) VALUES(1,${literal(p.ownerId)},${literal(p.origin)},${literal(p.dbIdentity)});\n`));
   await run(["d1","execute","FLORA_DB","--remote","--json","--file",sqlPath,"--config",path],signal);
   const after=await identity(p,id,signal);requireSetup(after&&after.ownerId===p.ownerId&&after.origin===p.origin&&after.dbIdentity===p.dbIdentity,"SETUP_PROVIDER_IDENTITY_MISMATCH");
  },
  async deploy(p,path,expected,signal){
   planValue(p);const raw=record(json((await readPrivateFile(path)).toString("utf8"))),databases=array(raw.d1_databases,1),db=record(databases[0]);requireSetup(typeof db.database_id==="string","SETUP_CONFIG_INVALID");
   const wanted=createSetupConfig(p,db.database_id,runtime.root),actualVars=record(raw.vars),wantedVars=record(wanted.vars);const setup=actualVars.FLORA_SETUP;
   if(setup!==undefined){const approved=parseJournal({schemaVersion:1,plan:p,stage:"setup-issued",receipts:[],setup}).setup;requireSetup(approved,"SETUP_CONFIG_INVALID");wantedVars.FLORA_SETUP=approved;}
   requireSetup(canonicalJson(raw)===canonicalJson(wanted),"SETUP_CONFIG_INVALID");
   // Build and dry-run before the final drift check; these may take time.
   await deps.run(runtime.nodePath,[join(runtime.root,"scripts/build-cloudflare.mjs"),"--deployment-config",path],{cwd:runtime.root,timeoutMs:120000,maxBytes:65536,signal});
   await run(["deploy","--dry-run","--config",path],signal);
   const before=await inspectRaw(p,signal);requireSetup(before.snapshot.databaseId===db.database_id,"SETUP_PROVIDER_DATABASE_MISMATCH");
   if(expected)requireSetup(canonicalJson(before.snapshot)===canonicalJson(expected),"SETUP_PROVIDER_DRIFT");else requireSetup(before.snapshot.deploymentId===null,"SETUP_PROVIDER_RESOURCE_EXISTS");
   const output=await run(["deploy","--config",path],signal),versionId=deploymentVersion(output.stdout),after=await inspectRaw(p,signal);
   requireSetup(after.versionId===versionId&&after.snapshot.databaseId===db.database_id&&after.snapshot.namespaceId!==null&&after.hostnameBound,"SETUP_PROVIDER_DEPLOY_UNKNOWN");return after.snapshot;
  },
  async probeHTTPS(p,signal){
   planValue(p);const current=await inspectRaw(p,signal);requireSetup(current.hostnameBound,"SETUP_HTTPS_NOT_READY");
   for(const [path,status]of [["/login",200],["/api/state",401]] as const){
    const response=await deps.fetch(p.origin+path,{method:"GET",redirect:"error",credentials:"omit",signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
    requireSetup(response.status===status&&!response.redirected,"SETUP_HTTPS_NOT_READY");if(response.body)await response.body.cancel();
   }
  },
 };
}
