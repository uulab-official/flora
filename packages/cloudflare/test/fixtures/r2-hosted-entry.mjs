import {DurableObject} from 'cloudflare:workers';
import {FloraAuth} from '../../src/auth-do.js';
let clock=1800000000000;Date.now=()=>clock;
export class R2HostedAuth extends DurableObject{
 versions=new Map();getCalls=0;putCalls=0;gates=[];hold=false;
 constructor(ctx,env){super(ctx,env);this.fixtureEnv={...env,ASSETS:{fetch:async()=>new Response('asset')}};
  const standard=object=>{if(object&&String(object.storageClass)===''&&this.versions.get(object.key)===object.version)Object.defineProperty(object,'storageClass',{value:'Standard'});return object;};
  // Exact local Miniflare Standard-metadata defect normalization, only for our
  // explicitly Standard-written version. Production never accepts blank class.
  this.bucket={put:async(...args)=>{this.putCalls++;const result=await env.FLORA_OTA_ASSETS.put(...args);if(result&&args[2]?.storageClass==='Standard')this.versions.set(result.key,result.version);return standard(result);},get:async(...args)=>{this.getCalls++;if(this.hold)await new Promise(resolve=>this.gates.push(resolve));return standard(await env.FLORA_OTA_ASSETS.get(...args));}};
  this.fixtureEnv.FLORA_OTA_ASSETS=this.bucket;this.authority=new FloraAuth(ctx,this.fixtureEnv);
 }
 async fetch(request){if(new URL(request.url).pathname==='/__test/control'){const raw=await request.json();if(raw.hold!==undefined)this.hold=raw.hold;if(raw.release){this.hold=false;for(const release of this.gates.splice(0))release();}if(raw.drop){delete this.fixtureEnv.FLORA_OTA_ASSETS;this.authority=new FloraAuth(this.ctx,this.fixtureEnv);}if(raw.restore){this.fixtureEnv.FLORA_OTA_ASSETS=this.bucket;this.authority=new FloraAuth(this.ctx,this.fixtureEnv);}return Response.json({getCalls:this.getCalls,putCalls:this.putCalls,held:this.gates.length});}return this.authority.fetch(request);}
}
export default{fetch(request,env){return env.FLORA_AUTH.getByName('flora-owner-v1').fetch(request);}};
