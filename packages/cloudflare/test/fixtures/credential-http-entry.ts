import type { DurableObjectState, Request as BindingRequest } from '@cloudflare/workers-types';
import worker, {FloraAuth} from '../../dist/worker.js';
import type {FloraEnv} from '../../src/contracts.js';
const assets={fetch:async()=>new Response('Synthetic asset')} as unknown as FloraEnv['ASSETS'];

const logs: unknown[][]=[];
for(const level of ['log','info','warn','error','debug'] as const) console[level]=(...args:unknown[])=>{logs.push(args);};
export class CredentialHttpFixture {
  private authority:FloraAuth;
  private env:FloraEnv;
  private hold=false;
  private started:Promise<void>|null=null;
  private begin:(()=>void)|null=null;
  private release:(()=>void)|null=null;
  constructor(private ctx:DurableObjectState,env:FloraEnv){this.env={...env,ASSETS:assets};this.authority=new FloraAuth(ctx,this.env);}
  async fetch(request:Request):Promise<Response>{
    const path=new URL(request.url).pathname;
    if(path==='/__test/control'){
      const input=await request.json() as {restart?:boolean;withoutKeys?:boolean;sql?:string;hold?:boolean;wait?:boolean;release?:boolean;revoke?:boolean};
      if(input.withoutKeys)delete this.env.FLORA_VAULT_KEYS;
      if(input.restart)this.authority=new FloraAuth(this.ctx,this.env);
      if(input.hold){this.hold=true;this.started=new Promise(resolve=>{this.begin=resolve;});}
      if(input.wait)await this.started;
      if(input.revoke)this.ctx.storage.sql.exec('DELETE FROM flora_auth_sessions');
      if(input.release)this.release?.();
      if(input.sql)return Response.json(this.ctx.storage.sql.exec(input.sql).toArray());
      return Response.json({ok:true});
    }
    if(path==='/__test/logs')return Response.json(logs);
    if(path==='/__test/unread'){
      let reads=0;const body=new ReadableStream<Uint8Array>({pull(){reads++;throw new Error('Unexpected secret body read');}},{highWaterMark:0});
      const appId=new URL(request.url).searchParams.get('appId');
      const response=await this.authority.fetch(new Request(this.env.FLORA_ORIGIN+`/api/apps/${appId}/credentials`,{method:'POST',headers:{Origin:this.env.FLORA_ORIGIN,'Content-Type':'application/json'},body}));
      return Response.json({status:response.status,reads});
    }
    if(this.hold&&request.method==='POST'&&path.endsWith('/credentials')){
      this.hold=false;const bytes=new Uint8Array(await request.arrayBuffer());
      const wait=new Promise<void>(resolve=>{this.release=resolve;});
      const body=new ReadableStream<Uint8Array>({pull:async controller=>{this.begin?.();await wait;controller.enqueue(bytes);controller.close();}},{highWaterMark:0});
      return this.authority.fetch(new Request(request.url,{method:'POST',headers:request.headers,body}));
    }
    return this.authority.fetch(request);
  }
}
export default {async fetch(request:Request,env:FloraEnv){
  if(new URL(request.url).pathname==='/__test/oversized'){
    // Keep the HTTP envelope small. Exercise the real Worker/body admission
    // inside workerd instead of racing a giant upload against an early 413 close.
    const input=await request.json() as {appId:string;mode:'header'|'stream'};
    if(!/^[a-z][a-z0-9_-]{2,95}$/.test(input.appId)||!['header','stream'].includes(input.mode))return new Response('Invalid fixture input',{status:400});
    const limit=1_500_000;let reads=0,bytes=0;
    const body=new ReadableStream<Uint8Array>({pull(controller){
      reads++;
      // Deliver the exact boundary first, then one final byte beyond it.
      const size=bytes<limit?Math.min(65_536,limit-bytes):1;
      controller.enqueue(new Uint8Array(size).fill(120));bytes+=size;
      if(bytes===limit+1)controller.close();
    }},{highWaterMark:0});
    const headers=new Headers(request.headers);headers.delete('Content-Length');headers.delete('Transfer-Encoding');
    if(input.mode==='header')headers.set('Content-Length',String(limit+1));
    const target=new Request(new URL(`/api/apps/${input.appId}/credentials`,request.url),{method:'POST',headers,body});
    const response=await worker.fetch(target,{...env,ASSETS:assets});
    return Response.json({status:response.status,result:await response.json(),reads,bytes});
  }
  if(new URL(request.url).pathname.startsWith('/__test/'))return env.FLORA_AUTH.get(env.FLORA_AUTH.idFromName('flora-owner-v1')).fetch(request as unknown as BindingRequest);
  return worker.fetch(request,{...env,ASSETS:assets});
}};
