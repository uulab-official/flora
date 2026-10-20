import type {AutomationService,RunnerEnrollment,RunnerEnrollmentInput} from '@app-ops/dogfood';
import type {NativeBuildStore} from '../native-build-store.js';
import type {NativeRunnerSummary} from '../native-types.js';
import type {RunnerGate} from './runner-gate.js';
import type {RunnerAccessRef,OrgPrincipal,RunnerRequest} from './types.js';
import {OrgFailure,orgAssert} from './types.js';
import type {RunnerAccess,RegistrationTicket} from './runner-access.js';
type Enrollment=RunnerEnrollment|{runner:NativeRunnerSummary;token:string};
/** One request-local coordinator. It never retries or rereads a raw token. */
export class RunnerRegistration {
 private check:(()=>void)|undefined;
 constructor(readonly access:RunnerAccess,private readonly gate:RunnerGate,private readonly automation:AutomationService,private readonly native:NativeBuildStore|undefined){}
 fence():void {orgAssert(this.check,503,'RUNNER_REGISTRATION_UNAVAILABLE');this.check()}
 private async issue(ticket:RegistrationTicket):Promise<Enrollment>{
  this.check=()=>this.access.assertIssuing(ticket,Date.now());
  try{
   this.fence();await this.access.store.storage.sync();this.fence();
   await this.access.verifyApplications(ticket.appIds);this.fence();const gate=await this.gate.read();this.fence();orgAssert(gate.phase==='ledger_only',503,'RUNNER_ACCESS_NOT_READY');
   let result:Enrollment;
   if(ticket.ref.kind==='ota'){
    const reservation={runnerId:ticket.ref.runnerId,operationId:ticket.operationId,appIds:ticket.appIds,generation:gate.generation};
    await this.gate.reserve(reservation);this.fence();result=await this.automation.enrollRunner({name:ticket.name,appIds:ticket.appIds},{runnerId:ticket.ref.runnerId});this.fence();
    orgAssert(result.runner.id===ticket.ref.runnerId&&JSON.stringify([...result.runner.appIds].sort())===JSON.stringify([...ticket.appIds].sort()),503,'RUNNER_ISSUANCE_UNVERIFIED');
    await this.automation.authorizeRunner(result.token);this.fence();await this.gate.verifyAllocation(reservation);this.fence();this.access.finish(ticket,Date.now());
   }else{
    orgAssert(this.native,503,'NATIVE_UNAVAILABLE');result=await this.native.enroll(ticket.appIds[0]!,{name:ticket.name,platform:ticket.platforms[0]},ticket.actor.ownerEpoch,()=>this.fence(),{runnerId:ticket.ref.runnerId,onInserted:()=>this.access.finishNative(ticket,Date.now())});
   }
   // A committed credential stays factual even if this final delivery is denied.
   const delivery=()=>{
    this.access.authorize(ticket.actor,ticket.ownerMode==='personal'?'runner.request':'runner.organization',ticket.ownerMode==='personal'?ticket.appIds[0]:undefined,Date.now());
    for(const appId of ticket.appIds)this.access.assertService(ticket.ref,appId,undefined,Date.now());
   };
   delivery();await this.access.store.storage.sync();delivery();return result;
  }catch(error){this.access.unknown(ticket,Date.now());if(error instanceof OrgFailure)throw error;throw new OrgFailure(503,'RUNNER_REGISTRATION_UNKNOWN')}
  finally{this.check=undefined}
 }
 async claim(actor:OrgPrincipal,id:string,expectedRevision:number):Promise<Enrollment>{return this.issue(this.access.startClaim(actor,id,expectedRevision,Date.now()))}
 async enrollOrganization(actor:OrgPrincipal,input:RunnerEnrollmentInput):Promise<RunnerEnrollment>{
  this.access.authorize(actor,'runner.organization',undefined,Date.now());await this.access.verifyApplications(input.appIds);this.access.authorize(actor,'runner.organization',undefined,Date.now());
  return await this.issue(this.access.startOrganization(actor,'ota',{...input,platforms:['ios','android']},Date.now())) as RunnerEnrollment;
 }
 async enrollOrganizationNative(actor:OrgPrincipal,appId:string,input:{name:string;platform:'ios'|'android'}):Promise<{runner:NativeRunnerSummary;token:string}>{
  this.access.authorize(actor,'runner.organization',undefined,Date.now());await this.access.verifyApplications([appId]);this.access.authorize(actor,'runner.organization',undefined,Date.now());
  return await this.issue(this.access.startOrganization(actor,'native',{name:input.name,appIds:[appId],platforms:[input.platform]},Date.now())) as {runner:NativeRunnerSummary;token:string};
 }
 private async physicalRevoke(actor:OrgPrincipal,ref:RunnerAccessRef):Promise<unknown>{
  const row=this.access.get(ref),appIds=JSON.parse(row.app_ids)as string[],action=row.owner_mode==='organization'?'runner.organization':'runner.approve';
  this.check=()=>this.access.authorize(actor,action,action==='runner.approve'?appIds[0]:undefined,Date.now());
  const intent=this.access.audit.begin({actor:{kind:'human',id:actor.userId},action,...(appIds.length===1?{appId:appIds[0]}:{}),membershipRevision:actor.membershipRevision},Date.now(),()=>this.fence());let submitted=false,settled=false;
  try{
   await this.access.store.storage.sync();this.fence();submitted=true;
   if(ref.kind==='native')orgAssert(this.native,503,'NATIVE_UNAVAILABLE');
   const result=ref.kind==='ota'?await this.automation.revokeRunner(ref.runnerId):this.native!.revoke(appIds[0]!,ref.runnerId,()=>this.fence());
   this.access.audit.settle(intent.id,'completed',{runnerId:ref.runnerId},Date.now());settled=true;await this.access.store.storage.sync();return result;
  }catch(error){if(!settled)this.access.audit.settle(intent.id,submitted?'unknown':'rejected',{runnerId:ref.runnerId,code:'RUNNER_REVOCATION_UNKNOWN'},Date.now());if(error instanceof OrgFailure)throw error;throw new OrgFailure(503,'RUNNER_REVOCATION_UNKNOWN')}
  finally{this.check=undefined}
 }
 async revokeRequest(actor:OrgPrincipal,id:string,expectedRevision:number):Promise<RunnerRequest>{
  const request=this.access.cancel(actor,id,expectedRevision,Date.now());if(request.runnerId)await this.physicalRevoke(actor,{kind:request.kind,runnerId:request.runnerId});return this.access.requestView(id);
 }
 async revoke(actor:OrgPrincipal,ref:RunnerAccessRef,application?:string):Promise<unknown>{if(application!==undefined)orgAssert(JSON.parse(this.access.get(ref).app_ids).includes(application),404,'NOT_FOUND');this.access.revoke(actor,ref,Date.now());return this.physicalRevoke(actor,ref)}
}
