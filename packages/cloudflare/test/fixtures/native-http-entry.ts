import type { DurableObjectState, Request as BindingRequest } from '@cloudflare/workers-types';
import worker from '../../dist/worker.js';
import type { FloraEnv } from '../../src/contracts.js';
import { CredentialHttpFixture } from './credential-http-entry.js';
const assets = { fetch: async () => new Response('Synthetic asset') } as unknown as FloraEnv['ASSETS'];
export class NativeHttpFixture extends CredentialHttpFixture {
  private held = new Map<string, { release: () => void; result: Promise<Response> }>();
  constructor(ctx: DurableObjectState, env: FloraEnv) { super(ctx, env); }
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/__test/native-unread') {
      let reads = 0;
      const body = new ReadableStream<Uint8Array>({ pull() { reads++; throw new Error('Unexpected native secret body read'); } }, { highWaterMark: 0 });
      const r = await super.fetch(new Request(new URL('/api/native-runner/credentials', request.url), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer runner_synthetic.' + 'A'.repeat(43) }, body }));
      return Response.json({ status: r.status, reads });
    }
    if (path === '/__test/native-held') {
      const input = await request.json() as any;
      const slot = input.slot ?? 'default';
      if (input.release) { const held = this.held.get(slot)!; held.release(); const r = await held.result; this.held.delete(slot); return Response.json({ status: r.status, body: await r.json() }); }
      let started!: () => void, release!: () => void;
      const began = new Promise<void>(resolve => { started = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
      const body = new ReadableStream<Uint8Array>({ async pull(controller) { started(); await wait; controller.enqueue(new TextEncoder().encode('{}')); controller.close(); } }, { highWaterMark: 0 });
      const result = super.fetch(new Request(new URL('/api/native-runner/presence', request.url), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + input.token }, body }));
      this.held.set(slot, { release, result });
      const verdict = await Promise.race([began.then(() => null), result]);
      if (verdict) { this.held.delete(slot); return Response.json({ status: verdict.status, body: await verdict.json() }); }
      return Response.json({ held: true });
    }
    return super.fetch(request);
  }
}
export default { fetch(request: Request, env: FloraEnv) {
  if (new URL(request.url).pathname.startsWith('/__test/')) return env.FLORA_AUTH.get(env.FLORA_AUTH.idFromName('flora-owner-v1')).fetch(request as unknown as BindingRequest);
  return worker.fetch(request, { ...env, ASSETS: assets });
} };
