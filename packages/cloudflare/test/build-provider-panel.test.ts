import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  listBuildProviders, buildProviderHelp, summarizeNativeBuilds, createBuildProviderPanel
} from "../public/build-provider-panel.js";

const html=readFileSync(new URL("../public/index.html", import.meta.url),"utf8");
const docIds=new Set([...html.matchAll(/id="([^"]+)"/g)].map(m=>m[1]));
class Element {
  value=""; hidden=false; disabled=false; textContent=""; attributes:Record<string,string>={}; listeners:Record<string,((event:any)=>unknown)[]>={}; open=false; focused=false;
  setAttribute(name:string,value:string){ this.attributes[name]=value; }
  getAttribute(name:string){ return this.attributes[name] ?? null; }
  removeAttribute(name:string){ delete this.attributes[name]; }
  addEventListener(event:string,fn:(event:any)=>unknown){ (this.listeners[event]??=[]).push(fn); }
  focus(){ this.focused=true; }
  async dispatch(name:string){for(const fn of this.listeners[name]??[])await fn({target:this});}
}
function setup() {
  const nodes=new Map<string,Element>();
  for (const id of docIds) nodes.set(id!,new Element());
  const node=(id:string)=>{assert.ok(nodes.has(id),id);return nodes.get(id)!;};
  const commands:string[]=[], navigated:string[]=[], calls:string[]=[];
  let appId="app_alpha",authenticated=true;
  let copier=(s:string)=>{commands.push(s);return Promise.resolve();};
  const panel=createBuildProviderPanel({
    document:{getElementById:node},navigator:{clipboard:{writeText:(s:string)=>copier(s)}}
  },{active:()=>authenticated,appId:()=>appId,navigate:(page:string,app:string)=>{navigated.push(page+":"+app); calls.push(page);}});
  return {node,panel,commands,navigated,calls,app:(value:string)=>{appId=value;},auth:(value:boolean)=>{authenticated=value;},clipboard:(fn:(s:string)=>Promise<void>)=>{copier=fn;}};
}
const appView=(appId:string)=>({
  appId,
  runners:[{id:"r1",appId,revokedAt:null,lastSeenAt:123456},{id:"r2",appId,revokedAt:null,lastSeenAt:null}],
  jobs:[{id:"j1",appId,platform:"android",state:"succeeded",artifact:{fileName:"signed.apk",sha256:"b".repeat(64)}}],
});

test("provider chooser is shipped with the hosted index and lists precisely the catalog's native build providers",async()=>{
  const ids=listBuildProviders().map(item=>item.id);
  assert.deepEqual(ids,["flora-pc-native","github-actions-native","expo-eas","codemagic","bitrise"]);
  assert.equal(ids.length,new Set(ids).size);
  assert.ok(ids.every(id=>html.includes('value="'+id+'"')));
  assert.ok([...docIds].includes("build-provider-select"));
  assert.equal(buildProviderHelp("__proto__"),null);
  assert.equal(buildProviderHelp("bogus"),null);
  const catalog=readFileSync(new URL("../../core/src/integration-providers.ts",import.meta.url),"utf8");
  for(const id of ids)assert.ok(catalog.includes('descriptor("'+id+'"'),id);
});

test("only the selected app's trusted native view contributes to the summary",()=>{
  const s=setup();
  assert.equal(s.node("build-provider-select").disabled,true);
  s.panel.open("app_alpha");
  const data=appView("app_alpha");
  assert.equal(s.node("build-provider-select").disabled,false);
  assert.equal(s.panel.setNativeView("app_alpha",data),true);
  assert.match(s.node("build-provider-summary").textContent,/Runner 2개/);
  assert.match(s.node("build-provider-summary").textContent,/연결 이력 1개 · 온라인 보장 아님/);
  assert.match(s.node("build-provider-summary").textContent,/signed\.apk/);
  assert.ok(!s.node("build-provider-summary").textContent.includes("http"));
  assert.equal(s.panel.setNativeView("app_beta",appView("app_beta")),false);
  assert.throws(()=>summarizeNativeBuilds("app_alpha",appView("app_beta")) ,/INVALID_BUILD_PROVIDER_SCOPE/);
  assert.throws(()=>summarizeNativeBuilds("app_alpha",{...appView("app_alpha"),jobs:[{...data.jobs[0]!,appId:"app_beta"}]}) ,/INVALID_BUILD_PROVIDER_SCOPE/);
  s.app("app_beta"); s.panel.open("app_beta");
  assert.equal(s.node("build-provider-summary").textContent.includes("signed.apk"),false);
  assert.equal(s.panel.state().native,null);
});

test("external providers display only inert, no-token local commands and never call a remote provider",async()=>{
  const s=setup();
  s.panel.open("app_alpha");
  for(const provider of ["github-actions-native","expo-eas","codemagic","bitrise"]) {
    assert.equal(s.panel.select(provider),true);
    assert.equal(s.node("build-provider-copy").disabled,false);
    const command=s.node("build-provider-command").textContent;
    assert.ok(command.includes(provider==="github-actions-native"?"uses:":"providers"),provider);
    assert.ok(!command.includes("--execute"));
    assert.ok(!/EXPO_TOKEN|CODEMAGIC_API_TOKEN|BITRISE_API_TOKEN|secret|Bearer /.test(command));
    assert.equal(s.node("build-provider-native").hidden,true);
    assert.equal(s.node("native-editor").hidden,true,"other provider must not leave the local submit form available");
    await s.panel.copy();
  }
  assert.equal(s.commands.length,4);
  assert.equal(s.calls.length,0,"the browser must not dispatch a remote build");
  assert.match(s.node("build-provider-state").textContent,/복사/);
  assert.equal(s.panel.select("__proto__"),false);
  assert.equal(s.panel.state().selection,"bitrise");
});

test("local form and OTA/Runner links work only for the authorized selected app",async()=>{
  const s=setup();
  assert.equal(s.panel.go("ota"),undefined);
  s.panel.open("app_alpha");
  s.panel.select("flora-pc-native");
  assert.equal(s.node("build-provider-native").hidden,false);
  assert.equal(s.node("native-editor").hidden,false);
  await s.node("build-provider-native").dispatch("click");
  assert.equal(s.node("native-editor").open,true);
  assert.equal(s.node("native-platform").focused,true);
  await s.node("build-provider-runners").dispatch("click");
  await s.node("build-provider-ota").dispatch("click");
  assert.deepEqual(s.navigated,["runners:app_alpha","ota:app_alpha"]);
  s.app("app_beta"); s.auth(false); s.panel.clear();
  assert.equal(s.node("build-provider-ota").disabled,true);
  assert.equal(s.node("build-provider-docs").getAttribute("href"),null);
  assert.equal(s.node("build-provider-command").textContent,"");
  assert.equal(s.panel.setNativeView("app_alpha",appView("app_alpha")),false);
  s.panel.go("ota");
  assert.equal(s.navigated.length,2);
});

test("stale clipboard completion cannot rewrite another app's state or leak previous job metadata",async()=>{
  const s=setup();s.panel.open("app_alpha");s.panel.select("expo-eas");
  let release!:()=>void;
  s.clipboard(async()=>new Promise<void>(resolve=>{release=resolve;}));
  const previous=s.panel.copy();
  s.app("app_beta");s.panel.open("app_beta");
  assert.equal(s.node("build-provider-state").textContent.includes("복사"),false);
  release();await previous;
  assert.equal(s.panel.state().appId,"app_beta");
  assert.equal(s.node("build-provider-state").textContent.includes("복사했습니다"),false);
});

test("invalid or foreign native job rows fail closed without clearing the user's selected provider",()=>{
  const s=setup();s.panel.open("app_alpha");
  const data=appView("app_alpha");
  assert.equal(s.panel.setNativeView("app_alpha",{...data,jobs:[{...data.jobs[0]!,state:"unknown"}]}),false);
  assert.match(s.node("build-provider-state").textContent,/다른 앱의 정보를 표시하지 않습니다/);
  s.panel.select("codemagic"); assert.equal(s.panel.state().selection,"codemagic");
  s.app("app_beta"); s.panel.open("app_beta");
  assert.equal(s.panel.state().selection,"flora-pc-native");
});
