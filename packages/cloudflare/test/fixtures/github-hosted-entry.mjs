import {DurableObject} from 'cloudflare:workers';
import {FloraAuth} from '../../src/auth-do.js';
let clock=1800000000000;Date.now=()=>clock;
export class GitHubHostedAuth extends DurableObject{
 constructor(ctx,env){super(ctx,env);this.fixtureEnv={...env,ASSETS:{fetch:async()=>new Response('asset')}};this.initial={FLORA_OTA_ASSET_STORAGE:env.FLORA_OTA_ASSET_STORAGE,FLORA_OTA_ASSET_REPOSITORY:env.FLORA_OTA_ASSET_REPOSITORY,FLORA_OTA_ASSET_REPOSITORY_ID:env.FLORA_OTA_ASSET_REPOSITORY_ID,FLORA_OTA_ASSET_INSTALLATION_ID:env.FLORA_OTA_ASSET_INSTALLATION_ID};this.authority=new FloraAuth(ctx,this.fixtureEnv);}
 async fetch(request){if(new URL(request.url).pathname==='/__test/control'){const raw=await request.json();if(raw.now!==undefined)clock=raw.now;if(raw.drop){for(const key of Object.keys(this.initial))delete this.fixtureEnv[key];this.authority=new FloraAuth(this.ctx,this.fixtureEnv);}if(raw.restore){Object.assign(this.fixtureEnv,this.initial);this.authority=new FloraAuth(this.ctx,this.fixtureEnv);}return Response.json({ok:true});}return this.authority.fetch(request);}
}
export default{fetch(request,env){return env.FLORA_AUTH.getByName('flora-owner-v1').fetch(request);}};
