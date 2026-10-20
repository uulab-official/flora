/** Shared admission metadata, without auth state or HTTP side effects. */
export type OrgRouteAction='self'|'organization'|'members'|'audit'|'issue'|'revoke'|'access'|'disable'|'preview'|'accept';
export interface OrgRoute {action:OrgRouteAction;method:'GET'|'POST';public:boolean;id?:string;query:string[]}
export function organizationRoute(path:string):OrgRoute|null {
 const fixed:Record<string,[OrgRouteAction,'GET'|'POST',boolean,string[]]>={
  '/api/me':['self','GET',false,[]],'/api/organization':['organization','GET',false,[]],
  '/api/organization/members':['members','GET',false,['cursor','limit']],'/api/organization/audit':['audit','GET',false,['cursor','limit']],
  '/api/organization/invitations':['issue','POST',false,[]],'/api/auth/member/preview':['preview','POST',true,[]],'/api/auth/member/accept':['accept','POST',true,[]]
 };
 const f=Object.hasOwn(fixed,path)?fixed[path]:undefined;if(f)return {action:f[0],method:f[1],public:f[2],query:f[3]};
 const m=/^\/api\/organization\/(members|invitations)\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,255})\/(access|disable|revoke)$/.exec(path);
 if(!m||!(m[1]==='members'&&m[3]!=='revoke'||m[1]==='invitations'&&m[3]==='revoke'))return null;
 return {action:m[3] as 'access'|'disable'|'revoke',method:'POST',public:false,id:m[2]!,query:[]};
}
