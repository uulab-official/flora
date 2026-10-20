import type { DurableObjectState, DurableObjectNamespace, Request as BindingRequest } from '@cloudflare/workers-types';
import { OrgAudit } from '../../dist/org/audit.js';
import { OrgFailure } from '../../dist/org/types.js';
import { FloraAuth } from '../../dist/auth-do.js';
import type { FloraEnv } from '../../src/contracts.js';

/** Local-only SQL/failure controls. Never included by the production entry. */
export class OrgFixture {
  private authority: FloraAuth;
  private env: FloraEnv;
  private heldFence: (()=>void)|undefined;
  private grant: import("../../src/contracts.js").AuthGrant|undefined;
  private pointQueries=0;
  constructor(private ctx: DurableObjectState, env: FloraEnv) {
    this.env = {...env, ASSETS: {fetch: async () => new Response('fixture')} as unknown as FloraEnv['ASSETS']};
    const exec=ctx.storage.sql.exec.bind(ctx.storage.sql);
    ctx.storage.sql.exec=((query:string,...args:any[])=>{if(/FROM flora_org_(?:users|memberships|app_access|sessions)\b/.test(query))this.pointQueries++;return exec(query,...args);}) as typeof ctx.storage.sql.exec;
    this.authority = new FloraAuth(ctx, this.env);
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path !== '/__test/control') return this.authority.fetch(request);
    const body = await request.json() as any;
    await this.authority.fetch(new Request(this.env.FLORA_ORIGIN + '/api/auth/session'));
    try {
      if (body.action === 'sql') return Response.json(this.ctx.storage.sql.exec(body.sql, ...(body.args ?? [])).toArray());
      if (body.action === 'restart') {
        Object.assign(this.env, body.env ?? {}); this.authority = new FloraAuth(this.ctx, this.env);
        await this.authority.fetch(new Request(this.env.FLORA_ORIGIN + '/api/auth/session'));
      }
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
