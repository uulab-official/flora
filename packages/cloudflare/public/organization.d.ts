import type {OrgSelfView,OrgDisplayView,OrgMemberView,OrgPage,RunnerRequest} from '../src/org/types.js';
export interface OrgViewModel {status:'loading'|'ready'|'error';principal:OrgSelfView;organization:OrgDisplayView;members:OrgPage<OrgMemberView>;requests:OrgPage<RunnerRequest>;appNames?:Record<string,string>;appId?:string|null;serverOrigin?:string;migration?:{revision:number;linked:number;nextCursor:string|null;gate:{phase:string}|null}|null}
export interface OrgActions {request:(method:'GET'|'POST',path:string,body?:unknown)=>Promise<any>;invalidate:()=>void;page?:(kind:'members'|'requests',cursor:string)=>void}
export const ROLE_LABELS:Readonly<Record<string,string>>;
export const REQUEST_LABELS:Readonly<Record<string,string>>;
export function renderOrganization(root:HTMLElement,model:OrgViewModel,actions:OrgActions):()=>void;
export function createOrgUi(root:HTMLElement,actions:OrgActions):any;
