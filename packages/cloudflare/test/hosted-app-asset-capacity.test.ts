import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { D1Database } from "@cloudflare/workers-types";
import { canonicalJson } from "@app-ops/config";
import { prepareOTAAsset } from "@app-ops/dogfood";
import { createD1ImportStore } from "../dist/d1-import-store.js";
import { createTestRuntime } from "./runtime.ts";

const now=1_800_000_000_000, mib=1024*1024, migration="0008_hosted_app_asset_capacity_96mib.sql";
const config={ownerId:"owner",ownerEmail:"owner@example.invalid",origin:"https://flora.example.test",dbIdentity:"capacity",setup:null};
const histories=["inventory_snapshots","baseline_imports","source_head_observations","applications","application_settings","github_connections","github_detections","ota_assets","ota_asset_chunks","ota_deployments","ota_deployment_assets","automation_runners","automation_jobs","automation_transitions","automation_guards","automation_asset_refs","automation_policies","automation_publications"];
async function statements(name:string){const source=await readFile(new URL("../migrations/"+name,import.meta.url),"utf8");return Array.from(source.replace(/^--.*$/gm,"").matchAll(/\s*(CREATE TRIGGER\b[\s\S]*?\bEND\s*;|[^;]+;)/g),match=>match[1]!.trim());}
async function migrate(db:D1Database,name:string){await db.batch((await statements(name)).map(sql=>db.prepare(sql)));}
async function fixture(t:test.TestContext){
 const runtime=await createTestRuntime({entrypoint:new URL("./fixtures/runtime-entry.ts",import.meta.url)});t.after(()=>runtime.dispose());const db=runtime.d1 as unknown as D1Database;
 for(const name of ["0001_private_imports.sql","0002_multi_app.sql","0003_github_ota.sql","0004_automation.sql","0005_workspace_capacity_192mib.sql","0006_workspace_capacity_256mib.sql","0007_incremental_capacity_accounting.sql"])await migrate(db,name);
 await db.prepare("INSERT INTO flora_deployment VALUES(1,?,?,?)").bind(config.ownerId,config.origin,config.dbIdentity).run();
 const store=createD1ImportStore(db,config,()=>{}),ops=store.operations!;
 const a=await store.applications!.registerApplication({name:"Isso fixture",repositoryId:"github:fixture/isso",rootDirectory:"."},now);
 const b=await store.applications!.registerApplication({name:"Promise fixture",repositoryId:"github:fixture/promise",rootDirectory:"."},now);
 for(const app of [a,b]){
  await store.applications!.updateApplicationSettings(app.id,{expectedVersion:0,values:{APP_LABEL:app.name}},now);
  await ops.saveGitHubConnection(app.id,{expectedVersion:0,installationId:1,owner:"fixture",repository:app===a?"isso":"promise",ref:"main"},now);
  const bytes=new Uint8Array([1]);await ops.saveOTAAsset(await prepareOTAAsset(app.id,{key:"existing",contentType:"application/javascript",fileExtension:".js"},bytes,now),bytes);
 }
 return {db,store,ops,a,b};
}
const rows=async(db:D1Database,table:string)=>(await db.prepare("SELECT * FROM "+table+" ORDER BY rowid").all()).results;
const ledger=async(db:D1Database)=>(await db.prepare("SELECT * FROM flora_capacity_ledger ORDER BY table_name").all()).results;
const facts=async(db:D1Database)=>(await db.prepare("SELECT * FROM flora_capacity_facts ORDER BY sequence").all()).results;
const schema=async(db:D1Database)=>(await db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all<{type:string;name:string;sql:string}>()).results;
const total=async(db:D1Database,appId:string)=>(await db.prepare("SELECT coalesce(sum(byte_length),0) n FROM ota_assets WHERE owner_id=? AND app_id=?").bind(config.ownerId,appId).first<{n:number}>())!.n;

// Metadata is a legitimate upload staging row. Its payload is intentionally not
// uploaded here: this targets the database byte/count guard without allocating
// hundreds of MiB of fixture bundles. Publication completeness guards stay intact.
function stagedAsset(db:D1Database,appId:string,sequence:number,size:number){
 const hash=sequence.toString(16).padStart(64,"0"),contentType="application/javascript",chunkCount=Math.ceil(size/524288);
 const data=canonicalJson({id:"asset_"+hash,appId,digest:hash,hash,key:"capacity_"+sequence,contentType,fileExtension:".js",size,createdAt:now});
 const fields=[config.ownerId,appId,hash,size,contentType,chunkCount,data];
 return db.prepare("INSERT INTO ota_assets(owner_id,app_id,hash,byte_length,content_type,chunk_count,data,stored_bytes) VALUES(?,?,?,?,?,?,?,?)").bind(...fields,Buffer.byteLength(canonicalJson(fields)));
}
async function accounting(db:D1Database){
 const counters=(await db.prepare("SELECT snapshot_count,baseline_count,payload_bytes FROM flora_capacity").first())!;
 const tracked=await db.prepare("SELECT sum(payload_bytes) payload_bytes,sum(row_count) row_count FROM flora_capacity_ledger").first<{payload_bytes:number;row_count:number}>();
 assert.equal(counters.payload_bytes,tracked!.payload_bytes);
 assert.equal(tracked!.row_count,(await db.prepare("SELECT count(*) n FROM flora_capacity_facts").first<{n:number}>())!.n);
 for(const name of histories){const actual=await db.prepare("SELECT count(*) row_count,coalesce(sum(stored_bytes),0) payload_bytes FROM "+name).first();const recorded=await db.prepare("SELECT row_count,payload_bytes FROM flora_capacity_ledger WHERE table_name=?").bind(name).first();assert.deepEqual(recorded,actual,name);}
}

test("hosted 96 MiB app migration changes one trigger, preserves prior records/ledgers and retains asset/count/race guards",async t=>{
 const {db,ops,a,b}=await fixture(t);
 for(let i=0;i<4;i++)await stagedAsset(db,a.id,10+i,16*mib-(i===3?1:0)).run();
 assert.equal(await total(db,a.id),64*mib);
 await assert.rejects(stagedAsset(db,a.id,20,1).run(),/flora capacity exceeded/);
 const before=await Promise.all(histories.map(table=>rows(db,table))),capacityBefore=await rows(db,"flora_capacity"),factsBefore=await facts(db),ledgerBefore=await ledger(db),schemaBefore=await schema(db);
 await migrate(db,migration);
 for(const [index,table]of histories.entries())assert.deepEqual(await rows(db,table),before[index],table);
 assert.deepEqual(await rows(db,"flora_capacity"),capacityBefore);assert.deepEqual(await facts(db),factsBefore);assert.deepEqual(await ledger(db),ledgerBefore);
 const schemaAfter=await schema(db);assert.equal(schemaAfter.length,schemaBefore.length);
 for(const previous of schemaBefore){const actual=schemaAfter.find(row=>row.type===previous.type&&row.name===previous.name)!;assert.ok(actual,previous.name);if(previous.name!=="ota_app_capacity")assert.equal(actual.sql,previous.sql,previous.name);}
 const guard=schemaAfter.find(row=>row.name==="ota_app_capacity")!.sql;assert.match(guard,/>=128/);assert.match(guard,/>100663296/);assert.doesNotMatch(guard,/67108864/);
 await stagedAsset(db,a.id,21,16*mib).run();await stagedAsset(db,a.id,22,16*mib-1).run();assert.equal(await total(db,a.id),96*mib-1);
 const race=await Promise.allSettled([stagedAsset(db,a.id,23,1).run(),stagedAsset(db,a.id,24,1).run()]);assert.equal(race.filter(row=>row.status==="fulfilled").length,1);assert.equal(await total(db,a.id),96*mib);
 const filled=await ledger(db),fullFacts=await facts(db);await assert.rejects(stagedAsset(db,a.id,25,1).run(),/flora capacity exceeded/);assert.deepEqual(await ledger(db),filled);assert.deepEqual(await facts(db),fullFacts);
 await stagedAsset(db,b.id,26,16*mib).run();assert.equal(await total(db,b.id),16*mib+1);assert.equal(await total(db,a.id),96*mib);
 await assert.rejects(stagedAsset(db,b.id,27,16*mib+1).run(),/CHECK constraint failed/);
 for(let i=0;i<126;i++)await stagedAsset(db,b.id,100+i,1).run();
 assert.equal((await db.prepare("SELECT count(*) n FROM ota_assets WHERE app_id=?").bind(b.id).first<{n:number}>())!.n,128);
 const countFull=await ledger(db);await assert.rejects(stagedAsset(db,b.id,300,1).run(),/flora capacity exceeded/);assert.deepEqual(await ledger(db),countFull);
 await assert.rejects(db.prepare("UPDATE ota_assets SET byte_length=1 WHERE app_id=?").bind(a.id).run(),/immutable operations/);
 await assert.rejects(db.prepare("DELETE FROM ota_assets WHERE app_id=?").bind(a.id).run(),/immutable operations/);
 for(const app of [a,b]){const existing=(await ops.listOTAAssets(app.id)).find(asset=>asset.key==="existing")!;assert.deepEqual((await ops.getOTAAsset(app.id,existing.id))!.bytes,new Uint8Array([1]));}
 await accounting(db);assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results,[]);
});

test("96 MiB hosted app allowance retains the exact shared 256 MiB workspace ceiling and incremental accounting",async t=>{
 const {db,a,b}=await fixture(t);await migrate(db,migration);
 await stagedAsset(db,a.id,500,16*mib).run();await stagedAsset(db,b.id,501,16*mib).run();
 const data=canonicalJson({repositoryId:a.repositoryId,rootDirectory:a.rootDirectory,headCommitSha:"a".repeat(40),observedAt:now,evidenceOrigin:"operator-import",padding:""});
 const fields=[config.ownerId,a.repositoryId,a.rootDirectory,"000001767323045000000000",data],overhead=Buffer.byteLength(canonicalJson(fields));
 const insert=(size:number)=>db.prepare(`INSERT INTO source_head_observations(owner_id,repository_id,root_directory,observed_order,data,stored_bytes)
  SELECT ?,?,?,?,json_set(?,'$.padding',replace(hex(zeroblob((?-?)/2)),'00','xx')||substr('x',1,(?-?)%2)),?`).bind(...fields,size,overhead,size,overhead,size);
 const ceiling=256*mib,used=(await db.prepare("SELECT payload_bytes n FROM flora_capacity").first<{n:number}>())!.n;
 const count=Math.floor((ceiling-used)/524288);
 for(let i=0;i<count;i+=8)await db.batch(Array.from({length:Math.min(8,count-i)},()=>insert(524288)));
 const remaining=ceiling-(await db.prepare("SELECT payload_bytes n FROM flora_capacity").first<{n:number}>())!.n;assert.ok(remaining>=overhead&&remaining<524288);
 const race=await Promise.allSettled([insert(remaining).run(),insert(remaining).run()]);assert.equal(race.filter(row=>row.status==="fulfilled").length,1);
 assert.equal((await db.prepare("SELECT payload_bytes n FROM flora_capacity").first<{n:number}>())!.n,ceiling);
 const full=await ledger(db),witnesses=await facts(db);await assert.rejects(stagedAsset(db,b.id,502,1).run(),/flora capacity exceeded/);assert.deepEqual(await ledger(db),full);assert.deepEqual(await facts(db),witnesses);
 await assert.rejects(db.prepare("UPDATE flora_capacity SET payload_bytes=payload_bytes-1").run(),/invalid capacity accounting/);
 await accounting(db);
});
