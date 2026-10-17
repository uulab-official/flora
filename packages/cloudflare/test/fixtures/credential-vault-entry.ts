import type { DurableObjectState, DurableObjectNamespace, Request as BindingRequest } from '@cloudflare/workers-types';
import { CredentialVault, CredentialVaultError } from '../../dist/credential-vault.js';

interface Env { TEST_VAULT: DurableObjectNamespace; FLORA_VAULT_KEYS?: string }
/** Isolated synthetic fixture. SQL inspection and arbitrary context never ship. */
export class CredentialVaultFixture {
  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}
  async fetch(request: Request): Promise<Response> {
    const body = await request.json() as any;
    const vault = new CredentialVault(this.ctx.storage, body.keyring === undefined ? this.env.FLORA_VAULT_KEYS : body.keyring,
      { ownerId: body.ownerId ?? 'synthetic-owner', dbIdentity: body.dbIdentity ?? 'synthetic-db' });
    if (body.action === 'sql') return Response.json(this.ctx.storage.sql.exec(body.sql, ...(body.args ?? [])).toArray());
    let checks = 0;
    const fence = () => { if (++checks === body.revokeAt) throw new Error('synthetic revoked'); };
    try {
      const result = body.action === 'list' ? await vault.list(body.appId, fence)
        : body.action === 'disable' ? await vault.disable(body.appId, body.kind, body.expectedVersion, 'owner@example.test', fence)
        : await vault.import(body.appId, body.input, 'owner@example.test', fence);
      return Response.json(result);
    } catch (error) {
      return Response.json({ error: error instanceof CredentialVaultError ? error.code : 'FIXTURE_REJECTED' },
        { status: error instanceof CredentialVaultError ? error.status : 401 });
    }
  }
}
export default { fetch(request: Request, env: Env) { return env.TEST_VAULT.get(env.TEST_VAULT.idFromName('synthetic-vault')).fetch(request as unknown as BindingRequest); } };
