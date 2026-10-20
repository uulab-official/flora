import type {OrgAction} from './types.js';
export interface ManagementRequirement {action:OrgAction;appId?:string;ownerOnly:boolean}
/** Closed route inventory. Unknown routes never inherit a prefix's permissions. */
export function managementRequirement(method:string,pathname:string):ManagementRequirement {
 const owner=(action:OrgAction='org.manage',appId?:string):ManagementRequirement=>({action,ownerOnly:true,...(appId?{appId}:{})});
 if(method==='GET'&&['/api/apps','/api/projects','/api/state'].includes(pathname))return {action:'org.self',ownerOnly:false};
 if(/^\/api\/runners(?:\/[a-z][a-z0-9_-]{2,95}\/revoke)?$/.test(pathname)&&method==='POST')return owner('runner.organization');
 const match=/^\/api\/apps\/([a-z][a-z0-9_-]{2,95})\/(.+)$/.exec(pathname);
 if(!match)return owner();
 const appId=match[1]!,path=match[2]!;
 const allow=(action:OrgAction):ManagementRequirement=>({action,appId,ownerOnly:false});
 if(path==='github'&&method==='POST')return owner('org.manage',appId);
 if(/^native\/runners(?:\/[a-z][a-z0-9_-]{2,95}\/revoke)?$/.test(path)&&method==='POST')return owner('runner.organization',appId);
 if(method==='GET'){
  if(path==='credentials')return allow('credential.read');
  if(['operations','automation','native','automation/ci','ota/rollback-policy'].includes(path)||/^automation\/jobs\/[a-z][a-z0-9_-]{2,95}$/.test(path)||/^ota\/deployments\/[a-f0-9-]{36}\/(?:publication|telemetry(?:\/installations\/i1\.[A-Za-z0-9_-]{39,480}(?:\/journey)?)?)$/.test(path))return allow('app.read');
 }
 if(method==='POST'){
  if(['credentials','credentials/disable','signing-key'].includes(path))return allow('credential.manage');
  if(['settings','github/sync','automation/policy','automation/ci','ota/rollback-policy','ota/rollback-installations'].includes(path))return allow('app.manage');
  if(['ota/assets','ota/deployments','ota/rollbacks','ota/verification','automation/jobs','native/jobs'].includes(path)||/^(?:automation|native)\/jobs\/[a-z][a-z0-9_-]{2,95}\/cancel$/.test(path))return allow('app.deploy');
 }
 return owner('org.manage',appId);
}
