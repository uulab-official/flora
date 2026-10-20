import type { DurableObjectState, DurableObjectNamespace, Request as BindingRequest } from '@cloudflare/workers-types';
import { OrgAudit } from '../../dist/org/audit.js';
import { OrgFailure } from '../../dist/org/types.js';
import { FloraAuth } from '../../dist/auth-do.js';
import type { FloraEnv } from '../../src/contracts.js';

/** Local-only SQL/failure controls. Never included by the production entry. */
export class OrgFixture {
  private authority: FloraAuth;
  private env: FloraEnv;
  constructor(private ctx: DurableObjectState, env: FloraEnv) {
    this.env = {...env, ASSETS: {fetch: async () => new Response('fixture')} as unknown as FloraEnv['ASSETS']};
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
      // Access only an actual production store instantiated by the real authority.
      const store = (this.authority as any).org;
      if (!store) return Response.json({error:'ORG_ACCESS_NOT_ACTIVE'}, {status:503});
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
