import type { DurableObjectState, DurableObjectNamespace, Request as BindingRequest } from '@cloudflare/workers-types';
import { OrgAudit } from '../../dist/org/audit.js';
import { OrgFailure } from '../../dist/org/types.js';
import { FloraAuth } from '../../dist/auth-do.js';
import type { FloraEnv } from '../../src/contracts.js';

let clock:number|null=null;const realNow=Date.now.bind(Date);Date.now=()=>clock??realNow();

/** Local-only SQL/failure controls. Never included by the production entry. */
export class OrgFixture {
  private authority: FloraAuth;
  private env: FloraEnv;
  private heldFence: (()=>void)|undefined;
  private grant: import("../../src/contracts.js").AuthGrant|undefined;
  private syncHoldAt=0;
  private syncCalls=0;
  private syncHeld=false;
  private syncRelease:(()=>void)|undefined;
  private vaultReturnMethod:string|null=null;
  private vaultReturnHeld=false;
  private vaultReturnRelease:(()=>void)|undefined;
  private vaultPatched=new WeakSet<object>();
  private nativeReturnHold=false;
  private nativeReturnHeld=false;
  private nativeReturnRelease:(()=>void)|undefined;
  private nativePatched=new WeakSet<object>();
  private readyFailure=false;
  private loseOtaResponse=false;
  private patchedAccess=new WeakSet<object>();
  private positiveReads=0;
  private pointQueries=0;
  private dbGate:'read'|'batch-after'|null=null;
  private dbHeld=false;
  private dbRelease:(()=>void)|undefined;
  private batches=0;
  private queries:string[]=[];
  private holdHash=false;
  private hashesUntilHold=1;
  private releaseHeavy:(()=>void)|undefined;
  private hashHeld=false;
  private releaseHash:(()=>void)|undefined;
  constructor(private ctx: DurableObjectState, env: FloraEnv) {
    this.env = {...env, ASSETS: {fetch: async () => new Response('fixture')} as unknown as FloraEnv['ASSETS']};
    const sync=ctx.storage.sync.bind(ctx.storage);
    ctx.storage.sync=async()=>{await sync();if(this.syncHoldAt&&++this.syncCalls===this.syncHoldAt){this.syncHoldAt=0;this.syncHeld=true;await new Promise<void>(resolve=>{this.syncRelease=resolve;});}};
    const db=env.FLORA_DB;
    const pause=async(kind:'read'|'batch-after')=>{if(this.dbGate!==kind)return;this.dbGate=null;this.dbHeld=true;await new Promise<void>(resolve=>{this.dbRelease=resolve;});};
    const sqlByStatement=new WeakMap<object,string>();
    const statement=(value:any,sql:string):any=>{
      const proxy=new Proxy(value,{get:(target,key)=>{
        if(key==='bind')return (...args:any[])=>statement(target.bind(...args),sql);
        const method=target[key];if(typeof method!=='function')return method;
        return async(...args:any[])=>{const result=await method.apply(target,args);if(key==='first'||key==='all')await pause('read');return result;};
      }});sqlByStatement.set(proxy,sql);return proxy;
    };
    this.env.FLORA_DB=new Proxy(db,{get:(target,key)=>{
      if(key==='prepare')return (sql:string)=>{this.queries.push(sql);return statement(target.prepare(sql),sql);};
      if(key==='batch')return async(values:any[])=>{this.batches++;const result=await target.batch(values);if(this.loseOtaResponse&&values.some(v=>/^\s*INSERT INTO automation_runners\b/i.test(sqlByStatement.get(v)??''))){this.loseOtaResponse=false;throw new Error('Synthetic committed response loss');}await pause('batch-after');return result;};
      const value=(target as any)[key];return typeof value==='function'?value.bind(target):value;
    }});
    const exec=ctx.storage.sql.exec.bind(ctx.storage.sql);
    ctx.storage.sql.exec=((query:string,...args:any[])=>{if(/FROM flora_org_runner_access\b/.test(query))this.positiveReads++;if(/FROM flora_org_(?:users|memberships|app_access|sessions)\b/.test(query))this.pointQueries++;return exec(query,...args);}) as typeof ctx.storage.sql.exec;
    const digest=crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest=((...args:Parameters<typeof digest>)=>{if(this.holdHash&&--this.hashesUntilHold<=0){this.holdHash=false;this.hashHeld=true;return new Promise<void>(resolve=>{this.releaseHash=resolve;}).then(()=>digest(...args));}return digest(...args);}) as typeof crypto.subtle.digest;
    this.authority = new FloraAuth(ctx, this.env);
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if(path==='/__test/unread-public-accept'){
      let reads=0;const body=new ReadableStream<Uint8Array>({pull(controller){reads++;controller.error(new Error('Unexpected body read'));}},{highWaterMark:0});
      const response=await this.authority.fetch(new Request(this.env.FLORA_ORIGIN+'/api/auth/member/accept',{method:'POST',headers:{Origin:this.env.FLORA_ORIGIN,'Content-Type':'application/json'},body}));return Response.json({status:response.status,reads});
    }
    if (path !== '/__test/control') return this.authority.fetch(request);
    const body = await request.json() as any;
    if(body.now!==undefined)clock=body.now;
    if(body.action==='positive-reads'){const reads=this.positiveReads;this.positiveReads=0;return Response.json({reads});}
    if(body.action==='sync-hold'){this.syncHoldAt=body.at;this.syncCalls=0;return Response.json({ok:true});}
    if(body.action==='sync-state')return Response.json({held:this.syncHeld});
    if(body.action==='sync-release'){this.syncRelease?.();this.syncRelease=undefined;this.syncHeld=false;return Response.json({ok:true});}
    if(body.action==='vault-return-hold')this.vaultReturnMethod=body.method;
    if(body.action==='vault-return-state')return Response.json({held:this.vaultReturnHeld});
    if(body.action==='vault-return-release'){this.vaultReturnRelease?.();this.vaultReturnRelease=undefined;this.vaultReturnHeld=false;return Response.json({ok:true});}
    if(body.action==='native-return-hold')this.nativeReturnHold=true;
    if(body.action==='native-return-state')return Response.json({held:this.nativeReturnHeld});
    if(body.action==='native-return-release'){this.nativeReturnRelease?.();this.nativeReturnRelease=undefined;this.nativeReturnHeld=false;return Response.json({ok:true});}
    if(body.action==='runner-ready-failure')this.readyFailure=body.enabled;
    if(body.action==='runner-ota-response-loss')this.loseOtaResponse=body.enabled;
    if(body.action==='db-gate'){this.dbGate=body.kind;this.batches=0;this.queries=[];return Response.json({ok:true});}
    if(body.action==='db-state')return Response.json({held:this.dbHeld,batches:this.batches,queries:this.queries});
    if(body.action==='db-release'){this.dbRelease?.();this.dbRelease=undefined;this.dbHeld=false;return Response.json({ok:true});}
    if(body.heavy==='take')this.releaseHeavy=this.authority.tryHeavy('kdf')??undefined;
    if(body.heavy==='release'){this.releaseHeavy?.();this.releaseHeavy=undefined;}
    if(body.holdHash||body.holdHashAt){this.holdHash=true;this.hashesUntilHold=body.holdHashAt??1;}
    if(body.action==='hash-state')return Response.json({held:this.hashHeld});
    if(body.action==='release-hash'){this.releaseHash?.();this.releaseHash=undefined;this.hashHeld=false;return Response.json({ok:true});}
    await this.authority.fetch(new Request(this.env.FLORA_ORIGIN + '/api/auth/session'));
    try {
      if (body.action === 'sql') return Response.json(this.ctx.storage.sql.exec(body.sql, ...(body.args ?? [])).toArray());
      if (body.action === 'restart') {
        Object.assign(this.env, body.env ?? {}); this.authority = new FloraAuth(this.ctx, this.env);
        await this.authority.fetch(new Request(this.env.FLORA_ORIGIN + '/api/auth/session'));
      }
      const vault=(this.authority as any).vault;if(vault&&!this.vaultPatched.has(vault)){for(const method of ['list','import','disable']){const original=vault[method].bind(vault);vault[method]=async(...args:any[])=>{const value=await original(...args);if(this.vaultReturnMethod===method){this.vaultReturnMethod=null;this.vaultReturnHeld=true;await new Promise<void>(resolve=>{this.vaultReturnRelease=resolve;});}return value;};}this.vaultPatched.add(vault);}
      const native=(this.authority as any).native;if(native&&!this.nativePatched.has(native)){const original=native.credentials.bind(native);native.credentials=async(...args:any[])=>{const value=await original(...args);if(this.nativeReturnHold){this.nativeReturnHold=false;this.nativeReturnHeld=true;await new Promise<void>(resolve=>{this.nativeReturnRelease=resolve;});}return value;};this.nativePatched.add(native);}
      const access=(this.authority as any).runnerAccess;
      if(access&&!this.patchedAccess.has(access)){const finish=access.finishNative.bind(access);access.finishNative=(...args:any[])=>{if(this.readyFailure)throw new OrgFailure(503,'SYNTHETIC_PROOF_FAILURE');return finish(...args);};this.patchedAccess.add(access);}
      if(body.action==='runner-service'){if(!access)throw new OrgFailure(503,'ORG_ACCESS_NOT_ACTIVE');access.assertService(body.ref,body.appId,body.platform,clock??realNow());return Response.json({ok:true});}
      if(body.action==='capture-management-grant'){this.pointQueries=0;const queries=this.queries.length;this.grant=await this.authority.requireSession(new Request(this.env.FLORA_ORIGIN+body.path,{headers:body.headers}));return Response.json({pointQueries:this.pointQueries,d1Reads:this.queries.length-queries});}
      if(body.action==='capture-grant'){this.grant=await this.authority.requireSession(new Request(this.env.FLORA_ORIGIN+'/api/auth/session',{headers:body.headers}));return Response.json({ok:true});}
      if(body.action==='assert-grant'){this.authority.assertCurrent(body.forged?{...this.grant!}:this.grant!);return Response.json({ok:true});}
      // Access only an actual production store instantiated by the real authority.
      const store = (this.authority as any).org;
      if (!store) return Response.json({error:'ORG_ACCESS_NOT_ACTIVE'}, {status:503});
      if(body.action==='policy'||body.action==='policy-page'||body.action==='capture-fence'||body.action==='run-fence'){
        const policy=(this.authority as any).orgPolicy;if(!policy)throw new OrgFailure(503,'ORG_ACCESS_NOT_ACTIVE');
        this.pointQueries=0;
        if(body.action==='policy-page')return Response.json(policy.visibleApps(body.actor,body.cursor??null,body.limit??25));
        if(body.action==='capture-fence'){this.heldFence=policy.fence(body.actor,body.capability,body.appId);return Response.json({ok:true});}
        if(body.action==='run-fence'){await Promise.resolve();this.heldFence!();this.ctx.storage.sql.exec("INSERT INTO fixture_policy_writes VALUES('succeeded')");}
        else policy.require(body.actor,body.capability,body.appId,body.now??Date.now());
        return Response.json({ok:true,pointQueries:this.pointQueries});
      }
      if (body.action === 'bootstrap') return Response.json(store.bootstrap(body.owner ?? {epoch:0,claimed:false}, body.now ?? 1_800_000_000_000));
      if(body.action==='audit-raw'){store.atomic(()=>store.appendAudit('synthetic-event','completed',body.data,1_800_000_000_000,body.safety===true));return Response.json({ok:true});}
      if (body.action === 'audit-begin') return Response.json(new OrgAudit(this.ctx.storage,store).begin(body.input,1_800_000_000_000,()=>{if(body.revoked)throw new OrgFailure(403,'MEMBERSHIP_CHANGED')}));
      if (body.action === 'audit-settle') {new OrgAudit(this.ctx.storage,store).settle(body.id,body.state,body.refs??{},1_800_000_000_000);return Response.json({ok:true});}
      if (body.action === 'access') { store.setAccess(body.actor, body.userId, body.input, body.now ?? 1_800_000_000_000); return Response.json({ok:true}); }
      return Response.json(store.state());
    } catch (error) {
      const failure = error as {status?:number;code?:string};
      return Response.json({error:failure.code ?? 'ORG_ACCESS_NOT_ACTIVE'}, {status:failure.status ?? 503});
    }
  }
}
export default {fetch(request:Request,env:FloraEnv & {TEST_ORG:DurableObjectNamespace}) {
  return env.FLORA_AUTH.get(env.FLORA_AUTH.idFromName('synthetic-org')).fetch(request as unknown as BindingRequest);
}};
