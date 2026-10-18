import worker,{FloraAuth} from "../../packages/cloudflare/dist/worker.js";
import type {FloraEnv} from "../../packages/cloudflare/src/contracts.js";
const assets={fetch:async()=>new Response("PRIVATE_ASSET")} as unknown as FloraEnv["ASSETS"];
/** Local-only static assets; real auth/D1/routes and wall clock are unchanged. */
export class OnboardingAuth {
 private readonly authority:FloraAuth;
 constructor(ctx:ConstructorParameters<typeof FloraAuth>[0],env:FloraEnv){this.authority=new FloraAuth(ctx,{...env,ASSETS:assets});}
 fetch(request:Request){return this.authority.fetch(request);}
}
export default {fetch(request:Request,env:FloraEnv){return worker.fetch(request,{...env,ASSETS:assets});}};
