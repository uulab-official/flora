import type { DurableObjectState, DurableObjectNamespace, Request as BindingRequest } from '@cloudflare/workers-types';
import { CredentialVault, CredentialVaultError } from '../../dist/credential-vault.js';
import { NativeBuildStore } from '../../dist/native-build-store.js';
import { NativeBuildError } from '../../dist/native-types.js';
interface Env { TEST_NATIVE: DurableObjectNamespace; FLORA_VAULT_KEYS: string }
export class NativeBuildFixture {
  constructor(private ctx: DurableObjectState, private env: Env) {}
  async fetch(request: Request): Promise<Response> {
    const body = await request.json() as any;
    const vault = new CredentialVault(this.ctx.storage, body.withoutKeys ? undefined : this.env.FLORA_VAULT_KEYS, { ownerId: 'synthetic-owner', dbIdentity: 'synthetic-db' });
    const store = new NativeBuildStore(this.ctx.storage, vault);
    if (body.action === 'sql') return Response.json(this.ctx.storage.sql.exec(body.sql, ...(body.args ?? [])).toArray());
    let checks = 0;
    const fence = () => {
      if (++checks === body.mutateAt) {
        if (body.mutation === 'cancel') store.cancel(body.appId, body.lease.jobId, () => {});
        if (body.mutation === 'revoke') store.revoke(body.appId, body.lease.runnerId, () => {});
        if (body.mutation === 'disable') this.ctx.storage.sql.exec('UPDATE flora_credential_bindings SET revision=revision+1,active_version=NULL WHERE app_id=?', body.appId);
      }
      if (checks === body.revokeAt) throw new NativeBuildError(401, 'FIXTURE_REVOKED');
    };
    try {
      if (body.action === 'import') return Response.json(await vault.import(body.appId, body.input, 'synthetic-owner', fence));
      if (body.action === 'disable') return Response.json(await vault.disable(body.appId, body.kind, body.version, 'synthetic-owner', fence));
      if (body.action === 'enroll') return Response.json(await store.enroll(body.appId, body.input, body.ownerEpoch ?? 1, fence));
      if (body.action === 'enqueue') return Response.json(await store.enqueue(body.appId, body.input, body.source ?? { owner: 'synthetic', repository: body.appId, ref: 'main', rootDirectory: '.', installationId: 42, connectionVersion: 1 }, fence));
      if (body.action === 'list') return Response.json(store.list(body.appId));
      if (body.action === 'cancel') return Response.json(store.cancel(body.appId, body.jobId, fence));
      if (body.action === 'revoke') return Response.json(store.revoke(body.appId, body.runnerId, fence));
      const authority = await store.authorize(body.token, body.ownerEpoch ?? 1, fence);
      const result = body.action === 'pending' ? store.pending(authority, fence)
        : body.action === 'claim' ? store.claim(authority, { jobId: body.jobId }, fence)
        : body.action === 'heartbeat' ? store.heartbeat(authority, body.lease, fence)
        : body.action === 'credentials' ? await store.credentials(authority, body.lease, fence)
        : body.action === 'complete' ? store.complete(authority, body.lease, body.artifact, fence)
        : body.action === 'fail' ? store.fail(authority, body.lease, body.code, fence)
        : store.presence(authority, fence);
      return Response.json(result);
    } catch (error) { return Response.json({ error: error instanceof NativeBuildError || error instanceof CredentialVaultError ? error.code : 'FIXTURE_REJECTED' },
      { status: error instanceof NativeBuildError || error instanceof CredentialVaultError ? error.status : 503 }); }
  }
}
export default { fetch(request: Request, env: Env) { return env.TEST_NATIVE.get(env.TEST_NATIVE.idFromName('native-fixture')).fetch(request as unknown as BindingRequest); } };
