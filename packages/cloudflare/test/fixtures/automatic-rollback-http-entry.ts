import type { DurableObjectState } from "@cloudflare/workers-types";
import type { FloraEnv } from "../../src/contracts.js";
import { HttpFailure } from "../../dist/http.js";
import hosted, { OperationsHistoryFixture } from "./operations-history-entry.js";

/** Test-only access to the actual wrapped authority's alarm and durable schedule. */
export class AutomaticRollbackHTTPFixture extends OperationsHistoryFixture {
 private readonly autoStats:{getAlarm:number;setAlarm:number;failNextSetAlarm:boolean};
 constructor(private readonly autoCtx:DurableObjectState,env:FloraEnv){
  const stats={getAlarm:0,setAlarm:0,failNextSetAlarm:false};
  const getAlarm=autoCtx.storage.getAlarm.bind(autoCtx.storage),setAlarm=autoCtx.storage.setAlarm.bind(autoCtx.storage);
  autoCtx.storage.getAlarm=((...args:Parameters<typeof getAlarm>)=>{stats.getAlarm++;return getAlarm(...args);}) as typeof autoCtx.storage.getAlarm;
  autoCtx.storage.setAlarm=((...args:Parameters<typeof setAlarm>)=>{stats.setAlarm++;if(stats.failNextSetAlarm){stats.failNextSetAlarm=false;throw new HttpFailure(503,"SYNTHETIC_ALARM_UNAVAILABLE");}return setAlarm(...args);}) as typeof autoCtx.storage.setAlarm;
  super(autoCtx,env);this.autoStats=stats;
 }
 async alarm():Promise<void>{await (this as unknown as {authority:{alarm():Promise<void>}}).authority.alarm();}
 override async fetch(request:Request):Promise<Response>{
  if(new URL(request.url).pathname==="/__test/auto-alarm"){
   const input=await request.json() as {run?:boolean;reset?:boolean;clear?:boolean;failNextSetAlarm?:boolean};
   if(input.failNextSetAlarm)this.autoStats.failNextSetAlarm=true;
   if(input.clear)await this.autoCtx.storage.deleteAlarm();
   if(input.run)await this.alarm();
   const alarm=await this.autoCtx.storage.getAlarm(),stats={...this.autoStats};
   if(input.reset){this.autoStats.getAlarm=0;this.autoStats.setAlarm=0;}
   return Response.json({...stats,alarm});
  }
  return super.fetch(request);
 }
}
export default hosted;
