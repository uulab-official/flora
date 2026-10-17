import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { D1Database } from "@cloudflare/workers-types";
import { canonicalJson } from "@app-ops/config";
import { prepareOTAAsset } from "@app-ops/dogfood";
import { createD1ImportStore } from "../dist/d1-import-store.js";
import { createTestRuntime } from "./runtime.ts";

const now=1_800_000_000_000,mib=1024*1024,migration="0012_hosted_app_asset_capacity_128mib.sql";
const config={ownerId:"owner",ownerEmail:"owner@example.invalid",origin:"https://flora.example.test",dbIdentity:"capacity128",setup:null};
const histories=["flora_deployment","flora_capacity","inventory_snapshots","baseline_imports","source_head_observations","applications","application_settings","github_connections","github_detections","ota_assets","ota_asset_chunks","ota_deployments","ota_deployment_assets","automation_runners","automation_jobs","automation_transitions","automation_guards","automation_asset_refs","automation_policies","automation_publications"];
async function statements(name:string){const source=await readFile(new URL("../migrations/"+name,import.meta.url),"utf8");return Array.from(source.replace(/^--.*$/gm,"").matchAll(/\s*(CREATE TRIGGER\b[\s\S]*?\bEND\s*;|[^;]+;)/g),match=>match[1]!.trim());}
async function migrate(db:D1Database,name:string){await db.batch((await statements(name)).map(sql=>db.prepare(sql)));}
async function fixture(t:test.TestContext,workspace384=true){
 const runtime=await createTestRuntime({entrypoint:new URL("./fixtures/runtime-entry.ts",import.meta.url)});t.after(()=>runtime.dispose());const db=runtime.d1 as unknown as D1Database;
 for(const name of ["0001_private_imports.sql","0002_multi_app.sql","0003_github_ota.sql","0004_automation.sql","0005_workspace_capacity_192mib.sql","0006_workspace_capacity_256mib.sql","0007_incremental_capacity_accounting.sql","0008_hosted_app_asset_capacity_96mib.sql","0009_workspace_capacity_320mib.sql","0010_manual_ota_rollback.sql",...(workspace384?["0011_workspace_capacity_384mib.sql"]:[])])await migrate(db,name);
 await db.prepare("INSERT INTO flora_deployment VALUES(1,?,?,?)").bind(config.ownerId,config.origin,config.dbIdentity).run();
 const store=createD1ImportStore(db,config,()=>{}),ops=store.operations!,apps=[];
 for(const name of ["Isso","Promise","Reward"]){const app=await store.applications!.registerApplication({name:name+" fixture",repositoryId:"github:fixture/"+name.toLowerCase(),rootDirectory:"."},now);apps.push(app);
  await store.applications!.updateApplicationSettings(app.id,{expectedVersion:0,values:{APP_LABEL:app.name}},now);
  await ops.saveGitHubConnection(app.id,{expectedVersion:0,installationId:1,owner:"fixture",repository:name.toLowerCase(),ref:"main"},now);
  const bytes=new Uint8Array([1]);await ops.saveOTAAsset(await prepareOTAAsset(app.id,{key:"existing",contentType:"application/javascript",fileExtension:".js"},bytes,now),bytes);
 }
 return {db,store,ops,a:apps[0]!,b:apps[1]!,c:apps[2]!};
}
const rows=async(db:D1Database,table:string)=>(await db.prepare("SELECT * FROM "+table+" ORDER BY rowid").all()).results;
const ledger=async(db:D1Database)=>(await db.prepare("SELECT * FROM flora_capacity_ledger ORDER BY table_name").all()).results;
const facts=async(db:D1Database)=>(await db.prepare("SELECT * FROM flora_capacity_facts ORDER BY sequence").all()).results;
const schema=async(db:D1Database)=>(await db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all<{type:string;name:string;sql:string}>()).results;
const total=async(db:D1Database,appId:string)=>(await db.prepare("SELECT coalesce(sum(byte_length),0) n FROM ota_assets WHERE owner_id=? AND app_id=?").bind(config.ownerId,appId).first<{n:number}>())!.n;
async function snapshot(db:D1Database){return {histories:await Promise.all(histories.map(name=>rows(db,name))),ledger:await ledger(db),facts:await facts(db),sequence:await rows(db,"sqlite_sequence")};}

// Upload staging metadata is legal without chunks. This tests quota admission,
// not publication or byte download, without allocating 384 MiB of test data.
function stagedAsset(db:D1Database,appId:string,sequence:number,size:number){
 const hash=sequence.toString(16).padStart(64,"0"),contentType="application/javascript",chunkCount=Math.ceil(size/524288);
 const data=canonicalJson({id:"asset_"+hash,appId,digest:hash,hash,key:"capacity_"+sequence,contentType,fileExtension:".js",size,createdAt:now});
 const fields=[config.ownerId,appId,hash,size,contentType,chunkCount,data];
 return db.prepare("INSERT INTO ota_assets(owner_id,app_id,hash,byte_length,content_type,chunk_count,data,stored_bytes) VALUES(?,?,?,?,?,?,?,?)").bind(...fields,Buffer.byteLength(canonicalJson(fields)));
}
async function accounting(db:D1Database){
 const counters=(await db.prepare("SELECT payload_bytes FROM flora_capacity").first())!,tracked=await db.prepare("SELECT sum(payload_bytes) payload_bytes,sum(row_count) row_count FROM flora_capacity_ledger").first<{payload_bytes:number;row_count:number}>();
 assert.equal(counters.payload_bytes,tracked!.payload_bytes);assert.equal(tracked!.row_count,(await db.prepare("SELECT count(*) n FROM flora_capacity_facts").first<{n:number}>())!.n);
 for(const name of histories.slice(2)){const actual=await db.prepare("SELECT count(*) row_count,coalesce(sum(stored_bytes),0) payload_bytes FROM "+name).first();const recorded=await db.prepare("SELECT row_count,payload_bytes FROM flora_capacity_ledger WHERE table_name=?").bind(name).first();assert.deepEqual(recorded,actual,name);}
}

test("128 MiB app migration preserves three apps and all accounting while changing only the app admission trigger",async t=>{
 const {db,ops,a,b,c}=await fixture(t);
 for(let i=0;i<6;i++)await stagedAsset(db,a.id,10+i,16*mib-(i===5?1:0)).run();assert.equal(await total(db,a.id),96*mib);
 await assert.rejects(stagedAsset(db,a.id,20,1).run(),/flora capacity exceeded/);
 const before=await snapshot(db),schemaBefore=await schema(db);await migrate(db,migration);assert.deepEqual(await snapshot(db),before);
 const schemaAfter=await schema(db);assert.equal(schemaAfter.length,schemaBefore.length);let changed=0;
 for(const previous of schemaBefore){const actual=schemaAfter.find(row=>row.type===previous.type&&row.name===previous.name)!;assert.ok(actual,previous.name);if(actual.sql!==previous.sql){changed++;assert.equal(previous.name,"ota_app_capacity");}else assert.equal(actual.sql,previous.sql,previous.name);}
 assert.equal(changed,1);const guard=schemaAfter.find(row=>row.name==="ota_app_capacity")!.sql;assert.match(guard,/>=128/);assert.match(guard,/>134217728/);assert.doesNotMatch(guard,/100663296/);
 for(const name of ["flora_capacity","flora_capacity_ledger","ota_assets_capacity","ota_asset_chunks_capacity","ota_deployments_capacity"]){const sql=schemaAfter.find(row=>row.name===name)!.sql;assert.match(sql,/402653184/);}
 for(const app of [a,b,c]){const existing=(await ops.listOTAAssets(app.id)).find(asset=>asset.key==="existing")!;assert.deepEqual((await ops.getOTAAsset(app.id,existing.id))!.bytes,new Uint8Array([1]));assert.equal((await ops.getGitHubConnection(app.id))!.repository,app.repositoryId.split("/").at(-1));}
 const sealed=await snapshot(db),sealedSchema=await schema(db);await assert.rejects(migrate(db,migration),/CHECK constraint failed/);assert.deepEqual(await snapshot(db),sealed);assert.deepEqual(await schema(db),sealedSchema);
 await accounting(db);assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results,[]);
});

test("128 MiB raw boundary races safely and preserves count, file size and app isolation guards",async t=>{
 const {db,a,b,c}=await fixture(t);await migrate(db,migration);
 for(let i=0;i<8;i++)await stagedAsset(db,a.id,500+i,16*mib-(i===7?2:0)).run();assert.equal(await total(db,a.id),128*mib-1);
 const race=await Promise.allSettled([stagedAsset(db,a.id,600,1).run(),stagedAsset(db,a.id,601,1).run()]);assert.equal(race.filter(result=>result.status==="fulfilled").length,1);assert.equal(await total(db,a.id),128*mib);
 const full=await snapshot(db);await assert.rejects(stagedAsset(db,a.id,602,1).run(),/flora capacity exceeded/);assert.deepEqual(await snapshot(db),full);
 await stagedAsset(db,b.id,603,16*mib).run();assert.equal(await total(db,b.id),16*mib+1);assert.equal(await total(db,c.id),1);assert.equal(await total(db,a.id),128*mib);
 await assert.rejects(stagedAsset(db,b.id,604,16*mib+1).run(),/CHECK constraint failed/);
 for(let i=0;i<126;i++)await stagedAsset(db,b.id,700+i,1).run();assert.equal((await db.prepare("SELECT count(*) n FROM ota_assets WHERE app_id=?").bind(b.id).first<{n:number}>())!.n,128);
 const counted=await snapshot(db);await assert.rejects(stagedAsset(db,b.id,900,1).run(),/flora capacity exceeded/);assert.deepEqual(await snapshot(db),counted);
 await stagedAsset(db,c.id,901,1).run();assert.equal(await total(db,c.id),2);
 await assert.rejects(db.prepare("UPDATE ota_assets SET byte_length=1 WHERE app_id=?").bind(a.id).run(),/immutable operations/);await assert.rejects(db.prepare("DELETE FROM ota_assets WHERE app_id=?").bind(a.id).run(),/immutable operations/);
 await accounting(db);assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results,[]);
});

test("128 MiB app migration rejects missing or wrong app and workspace prerequisites atomically",async t=>{
 for(const missing of ["workspace384","app-guard","old-app-ceiling","old-app-count","workspace-admission"] as const){
  const {db}=await fixture(t,missing!=="workspace384");
  if(missing==="app-guard")await db.prepare("DROP TRIGGER ota_app_capacity").run();
  if(missing==="old-app-ceiling"){const sql=(await schema(db)).find(row=>row.name==="ota_app_capacity")!.sql;await db.prepare("DROP TRIGGER ota_app_capacity").run();await db.prepare(sql.replace("100663296","67108864")).run();}
  if(missing==="old-app-count"){const sql=(await schema(db)).find(row=>row.name==="ota_app_capacity")!.sql;await db.prepare("DROP TRIGGER ota_app_capacity").run();await db.prepare(sql.replace(">=128",">=129")).run();}
  if(missing==="workspace-admission"){const sql=(await schema(db)).find(row=>row.name==="ota_assets_capacity")!.sql;await db.prepare("DROP TRIGGER ota_assets_capacity").run();await db.prepare(sql.replace("402653184","335544320")).run();}
  const before=await snapshot(db),schemaBefore=await schema(db);await assert.rejects(migrate(db,migration),/CHECK constraint failed/);assert.deepEqual(await snapshot(db),before,missing);assert.deepEqual(await schema(db),schemaBefore,missing);
 }
});
