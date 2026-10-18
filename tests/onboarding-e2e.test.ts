import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createHash,randomBytes,randomUUID} from "node:crypto";
import {createTestRuntime} from "../packages/cloudflare/test/runtime.ts";
import {createD1ImportStore} from "../packages/cloudflare/dist/d1-import-store.js";
import type {OTADeployment} from "@app-ops/dogfood";
class Element {
 textContent="";hidden=false;disabled=false;value="";className="";children:Element[]=[];attrs=new Map<string,string>();listeners=new Map<string,()=>Promise<void>>();
 append(...n:Element[]){this.children.push(...n);}replaceChildren(...n:Element[]){this.textContent="";this.children=n;}setAttribute(k:string,v:string){this.attrs.set(k,v);}addEventListener(k:string,v:()=>Promise<void>){this.listeners.set(k,v);}focus(){}get text():string{return this.textContent+this.children.map(n=>n.text).join("");}
}
test("fresh_owner_to_both_platforms_with_two_scoped_apps",async t=>{
 const origin="https://qa.example.test",now=Date.now(),token=randomBytes(32),password=randomBytes(24).toString("base64url"),config={origin,ownerId:"qa-owner",ownerEmail:"qa@example.test",dbIdentity:"qa-db",setup:null};
 const r=await createTestRuntime({entrypoint:new URL("./fixtures/onboarding-entry.ts",import.meta.url),durableObjects:{FLORA_AUTH:"OnboardingAuth"},bindings:{FLORA_ORIGIN:origin,FLORA_OWNER_ID:config.ownerId,FLORA_OWNER_EMAIL:config.ownerEmail,FLORA_DB_IDENTITY:config.dbIdentity,FLORA_SETUP:{digest:createHash("sha256").update(token).digest("hex"),issuedAt:now,expiresAt:now+600000,generation:1,purpose:"enroll"}}});t.after(()=>r.dispose());
 for(const name of ["0001_private_imports.sql","0002_multi_app.sql","0003_github_ota.sql","0004_automation.sql"]){const sql=await readFile(new URL("../packages/cloudflare/migrations/"+name,import.meta.url),"utf8");await r.d1.exec(sql.replace(/^--.*$/gm,"").split(/;\s*(?=CREATE|INSERT|PRAGMA|$)/).filter(s=>s.trim()).map(s=>s.replace(/\s*\n\s*/g," ").trim()+";").join("\n"));}
 await r.d1.prepare("INSERT INTO flora_deployment VALUES(1,?,?,?)").bind(config.ownerId,origin,config.dbIdentity).run();assert.equal((await r.fetch(origin+"/onboarding",{redirect:"manual"})).status,302);
 const enrolled=await r.fetch(origin+"/api/auth/enroll",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({email:config.ownerEmail,password,confirmation:password,token:token.toString("base64url")})});assert.equal(enrolled.status,200,await enrolled.clone().text());
 const headers={Cookie:enrolled.headers.getSetCookie().map(c=>c.split(";",1)[0]).join("; "),Origin:origin,"Content-Type":"application/json","X-Flora-CSRF":(await enrolled.json() as {csrfToken:string}).csrfToken};
 const post=(path:string,data:unknown)=>r.fetch(origin+path,{method:"POST",headers,body:JSON.stringify(data)}),get=(path:string)=>r.fetch(origin+path,{headers});assert.equal((await get("/onboarding")).status,200);
 const store=createD1ImportStore(r.d1 as unknown as Parameters<typeof createD1ImportStore>[0],config,()=>{}),apps:string[]=[],signers:string[]=[],runnerTokens:string[]=[],allPublications:unknown[]=[];
 const filesURL=new URL("../packages/cloudflare/public/onboarding-files.js",import.meta.url).href,{buildPublicFiles,buildRunnerBinding}=await import(filesURL);
 const qaURL=new URL("../scripts/onboarding-download-qa.mjs",import.meta.url).href,{verifyDownloads}=await import(qaURL);
 for(const [index,repository]of ["first","second"].entries()){
  const registered=await post("/api/apps",{name:repository,repositoryId:"github:fixture/"+repository,rootDirectory:"."});assert.equal(registered.status,201);const {id:appId}=await registered.json() as {id:string};apps.push(appId);
  const signing=await post(`/api/apps/${appId}/signing-key`,{});assert.equal(signing.status,201);const key=await signing.json() as {appId:string;keyId:string;certificate:string};signers.push(key.keyId);
  const files=buildPublicFiles({appId,origin,channel:"qa",runtimeVersion:"1",platforms:["ios","android"],bundler:"metro",entryFile:"index.js",nodeVersion:"24.19.0",packageManager:{name:"npm",version:"10.9.8"}},{appId:key.appId,keyId:key.keyId,certificate:key.certificate});
  const enrolledRunner=await post("/api/runners",{name:repository,appIds:[appId]});assert.equal(enrolledRunner.status,201);const runner=await enrolledRunner.json() as any;runnerTokens.push(runner.token);assert.equal(buildRunnerBinding(origin,appId,runner.runner).runnerId,runner.runner.id);
  const presence=await r.fetch(origin+"/api/runner/presence",{method:"POST",headers:{Authorization:"Bearer "+runner.token,"Content-Type":"application/json"},body:"{}"});assert.equal(presence.status,200);
  // Explicit storage/source fixtures: these are not a real GitHub webhook or Docker export.
  const sha=(index?"b":"a").repeat(40),connection=await store.operations!.saveGitHubConnection(appId,{expectedVersion:0,installationId:index+1,owner:"fixture",repository,ref:"main"},now);
  const automationConfig={schemaVersion:1 as const,bundler:"metro" as const,entryFile:"index.js",toolchain:{nodeVersion:"24.19.0",packageManager:{name:"npm" as const,version:"10.9.8"}},runtimeVersion:"1",platforms:["ios" as const,"android" as const],updatesUrl:origin+"/updates/"+appId};
  const detection=await store.operations!.saveGitHubDetection({id:"detection_"+repository,appId,connection,rootDirectory:".",detectedAt:now,commitSha:sha,framework:"react-native",expoVersion:null,reactNativeVersion:"0.86.3",configSource:"flora.config.json",runtimeVersion:"1",platforms:["ios","android"],updatesEnabled:true,updatesUrl:automationConfig.updatesUrl,reasons:[],automationConfig});
  const deployments:Record<string,string>={},jobs:unknown[]=[],publications:unknown[]=[];
  for(const platform of ["ios","android"] as const){
   const bytes=Buffer.from(repository+platform),digest=createHash("sha256").update(bytes).digest("hex"),asset=await store.operations!.saveOTAAsset({id:"asset_"+digest,appId,digest,hash:Buffer.from(digest,"hex").toString("base64url"),key:"bundle",contentType:"application/javascript",fileExtension:".js",size:bytes.length,createdAt:now},bytes),id=randomUUID();deployments[platform]=id;
   const deployment:OTADeployment={id,appId,requestKey:platform,detectionId:detection.id,commitSha:sha,channel:"qa",runtimeVersion:"1",platform,launchAssetId:asset.id,assetIds:[],launchAsset:asset,assets:[],createdAt:now};await store.operations!.saveOTADeployment(deployment);
   const response=await get(`/api/apps/${appId}/ota/deployments/${id}/publication`);assert.equal(response.status,200);publications.push(await response.json());allPublications.push({appId,id});jobs.push({id:"automation_"+randomUUID(),appId,commitSha:sha,channel:"qa",runtimeVersion:"1",platform,state:"succeeded",deploymentId:id});
  }
  const target={appId,commitSha:sha,channel:"qa",runtimeVersion:"1",platforms:["ios","android"]},result=await verifyDownloads(JSON.parse(files.connection),{...target,deployments},{fetch:(url:string,init:RequestInit)=>r.fetch(url,init as Parameters<typeof r.fetch>[1])});assert.equal(result.platforms.length,2);
  const doc={hidden:false,nodes:new Map<string,Element>(),createElement:()=>new Element(),getElementById(id:string){if(!this.nodes.has(id))this.nodes.set(id,new Element());return this.nodes.get(id)!;}},wizardURL=new URL("../packages/cloudflare/public/onboarding.js",import.meta.url).href,{createOnboarding}=await import(wizardURL);
  const operations=await (await get(`/api/apps/${appId}/operations`)).json() as any,automation=await (await get(`/api/apps/${appId}/automation`)).json() as any;
  assert.equal(automation.runners.length,1);assert.deepEqual(automation.runners[0].appIds,[appId]);assert.equal(operations.deployments.length,2);
  const snapshot={authenticated:true,appId,operations,automation:{...automation,policy:{enabled:true,channel:"qa",platforms:["ios","android"]},jobs},target:null},panel=createOnboarding({document:doc,location:{origin}},{api:async(path:string)=>path==="/api/github/connection"?{configured:true}:get(path).then(v=>v.json()),isCurrent:()=>true,getSnapshot:()=>snapshot,refreshData:async()=>{},setActiveJobPolling:()=>{},navigate:()=>{}});
  await panel.enter(appId);await doc.getElementById("onboarding-steps").children[4]!.listeners.get("click")!();const descendants=(n:Element):Element[]=>[n,...n.children.flatMap(descendants)],pin=descendants(doc.getElementById("onboarding-content")).find(n=>n.attrs.get("id")==="onboarding-pin-target");assert.ok(pin);await pin.listeners.get("click")!();await panel.update();assert.equal((doc.getElementById("onboarding-content").text.match(/게시 확인/g)??[]).length,2);panel.leave();
 }
 assert.notEqual(signers[0],signers[1]);assert.notEqual(runnerTokens[0],runnerTokens[1]);for(const item of allPublications as {appId:string;id:string}[])assert.equal((await get(`/api/apps/${apps.find(id=>id!==item.appId)}/ota/deployments/${item.id}/publication`)).status,404);
 const provisionURL=new URL("../packages/cli/dist/setup/provision.js",import.meta.url).href,{connectExisting}=await import(provisionURL);
 await t.test("interrupted_existing_install_keeps_keys_and_history",async()=>{
  const state=await connectExisting({readPublic:async()=>origin,notice:()=>{},readSecret:async()=>assert.fail("no secret"),choose:async()=>"existing",confirm:async()=>false,report:()=>{}},new AbortController().signal);assert.equal(state.code,"SETUP_CONTINUE_EXISTING_LOGIN");
  for(const [index,appId]of apps.entries()){const response=await post(`/api/apps/${appId}/signing-key`,{});assert.equal(response.status,200);assert.equal((await response.json() as {keyId:string}).keyId,signers[index]);}
 });
 const before=(await r.d1.prepare("SELECT data FROM ota_deployments ORDER BY id").all()).results;await get(`/api/apps/${apps[0]}/operations`);await get(`/api/apps/${apps[1]}/automation`);assert.deepEqual((await r.d1.prepare("SELECT data FROM ota_deployments ORDER BY id").all()).results,before);
 t.diagnostic("Local workerd + D1 + real auth/signing/routes/controller: 2 scoped apps × 2 platforms. Source/export/job completion are explicit fixtures; no remote/device claim.");
});
