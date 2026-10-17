import type { DurableObject } from "cloudflare:workers";
import { HttpFailure } from "./http.js";

type Storage = ConstructorParameters<typeof DurableObject>[0]["storage"];
export interface WorkspaceUsage {
  status: "ready" | "stale" | "unconfigured" | "pending";
  source: "cloudflare-graphql";
  scope: "account";
  collectedBy: "pc-runner";
  verification: "authenticated-reporter";
  day: string | null; rowsRead: number | null; rowsWritten: number | null;
  readLimit: 5000000; writeLimit: 100000;
  resetAt: number | null; observedAt: number | null; freshUntil: number | null;
}
interface Measurement {day:string;observedAt:number;rowsRead:number;rowsWritten:number}
const dayOf = (now:number) => new Date(now).toISOString().slice(0,10);
const fields = ["day","observedAt","rowsRead","rowsWritten"];
const safeCount = (n:unknown): n is number => typeof n==="number" && Number.isSafeInteger(n) && n>=0;
/** Display-only account analytics. Authentication is enforced by the caller.
 * No Cloudflare credential, per-app private data or quota enforcement lives here. */
export class UsageCache {
  constructor(private readonly storage:Storage) {
    storage.sql.exec("CREATE TABLE IF NOT EXISTS flora_usage_cache(account_id TEXT PRIMARY KEY,received_at INTEGER NOT NULL,data TEXT NOT NULL)");
  }
  record(account:string,input:unknown,now:number):void {
    if (!/^[a-f0-9]{32}$/.test(account) || !input || typeof input!=="object" || Array.isArray(input)) throw new HttpFailure(400,"INVALID_USAGE_REPORT");
    const value=input as Record<string,unknown>;
    if (Object.keys(value).length!==fields.length || Object.keys(value).some(k=>!fields.includes(k)) || value.day!==dayOf(now)
      || !safeCount(value.observedAt) || value.observedAt>now || now-value.observedAt>300000 || !safeCount(value.rowsRead) || !safeCount(value.rowsWritten)) throw new HttpFailure(400,"INVALID_USAGE_REPORT");
    const previous=this.storage.sql.exec<{data:string}>("SELECT data FROM flora_usage_cache WHERE account_id=?",account).toArray()[0];
    if(previous){const old=JSON.parse(previous.data) as Measurement;if(old.observedAt>=value.observedAt)throw new HttpFailure(409,"USAGE_REPORT_OUTDATED");}
    this.storage.sql.exec("INSERT INTO flora_usage_cache(account_id,received_at,data) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET received_at=excluded.received_at,data=excluded.data",account,now,JSON.stringify(value));
  }
  snapshot(account:string|undefined,now:number):WorkspaceUsage {
    const base:WorkspaceUsage={status:account?"pending":"unconfigured",source:"cloudflare-graphql",scope:"account",collectedBy:"pc-runner",verification:"authenticated-reporter",day:null,rowsRead:null,rowsWritten:null,readLimit:5000000,writeLimit:100000,resetAt:null,observedAt:null,freshUntil:null};
    if(!account)return base;
    const row=this.storage.sql.exec<{data:string;received_at:number}>("SELECT data,received_at FROM flora_usage_cache WHERE account_id=?",account).toArray()[0];
    if(!row)return base;
    const value=JSON.parse(row.data) as Measurement;
    return {...base,...value,status:value.day===dayOf(now)&&now>=value.observedAt&&now-row.received_at<=600000?"ready":"stale",resetAt:Date.parse(value.day+"T00:00:00Z")+86400000,freshUntil:row.received_at+600000};
  }
}
