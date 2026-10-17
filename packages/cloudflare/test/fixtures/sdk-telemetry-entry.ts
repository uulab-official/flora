import type { D1Database, DurableObjectNamespace, DurableObjectState, Request as BindingRequest } from "@cloudflare/workers-types";
import type { FloraConfig } from "../../src/contracts.js";
import { SDKTelemetryStore } from "../../dist/sdk-telemetry.js";
import { HttpFailure } from "../../dist/http.js";

interface Env { FLORA_DB: D1Database; TELEMETRY: DurableObjectNamespace }
const config: FloraConfig = { origin:"https://telemetry.example.test",ownerId:"owner_a",ownerEmail:"owner@example.test",dbIdentity:"db_a",setup:null };
export class TelemetryFixture {
  private store: SDKTelemetryStore;
  private reads=0;
  private rowsRead=0;
  private observationFailure=false;
  constructor(private readonly ctx:DurableObjectState,private readonly env:Env) {this.store=new SDKTelemetryStore(ctx.storage); }
  async fetch(request:Request):Promise<Response> {
    const command=await request.json() as any;
    this.observationFailure=command.observationFailure===true;
    let fences=0; const fence=()=>{ if(++fences===command.failFenceAt)throw new HttpFailure(401,"SESSION_REVOKED"); };
    const active={...config,...command.config}; const now=command.now??1_800_000_000_000;
    const db=new Proxy(this.env.FLORA_DB,{get:(target,key)=>key==="prepare"?(sql:string)=>{this.reads++;const statement=target.prepare(sql);const measured=(bound:typeof statement):typeof statement=>new Proxy(bound,{get:(target,key)=>key==="bind"?(...args:any[])=>measured(target.bind(...args)):key==="first"?async(column?:string)=>{const result=await target.all<any>();this.rowsRead+=result.meta.rows_read??0;const row=result.results[0]??null;return column&&row?row[column]:row;}:key==="all"?async()=>{const result=await target.all();this.rowsRead+=result.meta.rows_read??0;return result;}:typeof Reflect.get(target,key,target)==="function"?Reflect.get(target,key,target).bind(target):Reflect.get(target,key,target)});return measured(statement);}:Reflect.get(target,key,target)});
    try {
      if(command.op==="observe"){
        this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS observation_fixture(data TEXT NOT NULL,received_at INTEGER NOT NULL)");
        this.store=new SDKTelemetryStore(this.ctx.storage,(observation,receivedAt)=>{
          this.ctx.storage.sql.exec("INSERT INTO observation_fixture(data,received_at) VALUES(?,?)",JSON.stringify(observation),receivedAt);
          if(this.observationFailure)throw new HttpFailure(503,"OBSERVATION_UNAVAILABLE");
        });return Response.json({ok:true});
      }
      if(command.op==="session")return Response.json(await this.store.session(db,active,command.appId??"application_first",command.input,fence,now,command.ip??"198.51.100.1"));
      if(command.op==="report")return Response.json(await this.store.report(active,command.appId??"application_first",command.input,fence,now,command.ip??"198.51.100.1"));
      if(command.op==="latest")return Response.json(Object.fromEntries(this.store.latest(active.ownerId,command.input,fence)));
      if(command.op==="detail")return Response.json(await (this.store as any).detail(db,active,command.appId??"application_first",command.deploymentId??"ba0ded11-d92f-4d64-b8e0-a98bc5693fee",command.cursor??null,command.installationRef??null,fence,now,command.eligibility===true?(hash:string)=>hash===command.allowedInstallationHash:undefined,command.filter??"all"));
      if(command.op==="journey")return Response.json(await (this.store as any).journey(db,active,command.appId??"application_first",command.deploymentId??"ba0ded11-d92f-4d64-b8e0-a98bc5693fee",command.installationRef,command.cursor??null,fence,now));
      if(command.op==="resolve")return Response.json({installationHash:await (this.store as any).resolveInstallation(db,active,command.appId??"application_first",command.deploymentId??"ba0ded11-d92f-4d64-b8e0-a98bc5693fee",command.installationRef,fence,now)});
      if(command.op==="sync")return Response.json(await this.store.synchronizeRollbackHistory(db,active,command.appId??"application_first",command.input,fence)??{ok:true});
      if(command.op==="restart"){this.store=new SDKTelemetryStore(this.ctx.storage);return Response.json({ok:true});}
      if(command.op==="debug")return Response.json({reads:this.reads,rowsRead:this.rowsRead,tables:this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'flora_sdk_%' ORDER BY name").toArray(),rows:this.ctx.storage.sql.exec(command.sql??"SELECT * FROM flora_sdk_telemetry_meta").toArray()});
      return new Response(null,{status:404});
    } catch(error) {return Response.json({code:error instanceof HttpFailure?error.code:"INVALID_INPUT"},{status:error instanceof HttpFailure?error.status:400});}
  }
}
export default {async fetch(request:BindingRequest,env:Env){return env.TELEMETRY.get(env.TELEMETRY.idFromName("test")).fetch(request);}};
