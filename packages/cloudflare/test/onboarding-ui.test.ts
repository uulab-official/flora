import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {parseAdminPath,adminPath} from "../public/admin-routes.js";
import {routeRequest} from "../dist/http.js";
const model=new URL("../public/onboarding-model.js",import.meta.url).href;
const wizard=new URL("../public/onboarding.js",import.meta.url).href;
test("onboarding_is_private_canonical_route",()=>{
 assert.deepEqual(parseAdminPath("/onboarding"),{page:"onboarding",appId:null,path:"/onboarding"});
 assert.equal(adminPath("onboarding"),"/onboarding");
 assert.equal(routeRequest(new Request("https://flora.test/onboarding")).kind,"private-asset");
 for(const suffix of ["/","?state=done","?appId=app_a"])assert.throws(()=>routeRequest(new Request("https://flora.test/onboarding"+suffix)));
 for(const path of ["/onboarding.js","/onboarding.css","/onboarding-model.js"])assert.equal(routeRequest(new Request("https://flora.test"+path)).kind,"private-asset");
});
test("wizard_uses_current_evidence_not_saved_completion_or_foreign_app",async()=>{
 const {deriveOnboardingState}=await import(model);
 const input={authenticated:true,appId:"app_a",connection:{configured:true},operations:null,automation:null,target:null};
 let state=deriveOnboardingState(input);
 assert.equal(state.steps.find((s:{id:string})=>s.id==="owner").status,"verified");
 assert.notEqual(state.steps.find((s:{id:string})=>s.id==="sdk").status,"verified");
 state=deriveOnboardingState({...input,authenticated:false,automation:{runners:[{appIds:["app_b"],revokedAt:null,presence:{status:"online",lastSeenAt:1}}]}});
 assert.ok(state.steps.every((s:{status:string})=>s.status!=="verified"));
});
class Node {
 textContent="";hidden=false;disabled=false;value="";className="";children:Node[]=[];attrs=new Map<string,string>();listeners=new Map<string,(e?:unknown)=>unknown>();
 append(...children:Node[]){this.children.push(...children);}replaceChildren(...children:Node[]){this.textContent="";this.children=children;}
 setAttribute(k:string,v:string){this.attrs.set(k,v);}addEventListener(k:string,cb:(e?:unknown)=>unknown){this.listeners.set(k,cb);}focus(){}remove(){}
 get text():string{return this.textContent+this.children.map(n=>n.text).join("");}
}
function document(){const nodes=new Map<string,Node>();return {nodes,hidden:false,createElement:()=>new Node(),getElementById(id:string){if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id)!;}};}
test("late_response_cannot_revive_old_app_or_session_and_leave_cancels_reads",async()=>{
 const {createOnboarding}=await import(wizard);const doc=document();let active=true,reads=0,release!:(v:unknown)=>void;
 const connection=new Promise(r=>{release=r;});
 const input={authenticated:true,appId:null,connection:null,operations:null,automation:null,target:null};
 const ctx={api:async()=>{reads++;return connection;},isCurrent:()=>active,getSnapshot:()=>input,refreshData:async()=>{},setActiveJobPolling:()=>{},navigate:()=>{}};
 const panel=createOnboarding({document:doc},ctx);const pending=panel.enter(null);active=false;panel.leave();release({configured:true});await pending;
 assert.equal(reads,1);assert.equal(doc.getElementById("onboarding-content").text,"");
});
test("wizard_keyboard_and_narrow_layout_has_one_current_step",async()=>{
 const {createOnboarding}=await import(wizard);const doc=document();
 const panel=createOnboarding({document:doc},{api:async()=>({configured:false}),isCurrent:()=>true,getSnapshot:()=>({authenticated:true,appId:null,connection:null,operations:null,automation:null,target:null}),refreshData:async()=>{},setActiveJobPolling:()=>{},navigate:()=>{}});
 await panel.enter(null);
 const nav=doc.getElementById("onboarding-steps");assert.equal(nav.children.length,5);
 assert.ok(nav.children.every(n=>n.attrs.get("type")==="button"));
 assert.ok(doc.getElementById("onboarding-content").text.includes("GitHub"));
 panel.leave();
});
test("enroll_only_redirects_to_fixed_wizard",async()=>{
 const {startAuth}=await import(new URL("../public/auth.js",import.meta.url).href);
 for(const purpose of ["enroll","recover"]){
  const doc=document(),destinations:string[]=[];
  const client=startAuth({document:doc,location:{pathname:"/setup",replace:(p:string)=>destinations.push(p)},now:()=>100,fetch:async()=>({ok:true,json:async()=>({csrfToken:"test",expiresAt:1000})})});
  for(const [id,value]of Object.entries({email:"owner@example.test",password:"valid long password",confirmation:"valid long password",token:"a".repeat(43),"setup-mode":purpose}))doc.getElementById(id).value=value;
  await client.submit();assert.deepEqual(destinations,[purpose==="enroll"?"/onboarding":"/"]);
 }
});
test("sdk_is_verified_only_for_current_app_source_config",async()=>{
 const {deriveOnboardingState}=await import(model);
 const connection={appId:"app_a",version:1,installationId:1,owner:"org",repository:"app",ref:"main",connectedAt:1};
 const config={schemaVersion:1,bundler:"metro",entryFile:"index.js",toolchain:{nodeVersion:"24.19.0",packageManager:{name:"npm",version:"10.9.8"}},runtimeVersion:"native-1",platforms:["ios","android"],updatesUrl:"https://flora.test/updates/app_a"};
 const detection={id:"detection_a",appId:"app_a",connection,rootDirectory:".",detectedAt:2,configSource:"flora.config.json",updatesEnabled:true,updatesUrl:config.updatesUrl,runtimeVersion:config.runtimeVersion,automationConfig:config};
 const input={authenticated:true,appId:"app_a",connection:{configured:true},operations:{connection,detections:[detection],assets:[],deployments:[]},automation:null,target:null};
 assert.equal(deriveOnboardingState(input).steps.find((s:{id:string})=>s.id==="sdk").status,"verified");
 for(const bad of [{...detection,appId:"app_b"},{...detection,automationConfig:{...config,updatesUrl:"https://flora.test/updates/app_b"}},{...detection,connection:{...connection,version:2}}])assert.notEqual(deriveOnboardingState({...input,operations:{...input.operations,detections:[bad]}}).steps.find((s:{id:string})=>s.id==="sdk").status,"verified");
});
