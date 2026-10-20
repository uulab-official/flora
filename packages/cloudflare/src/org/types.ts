import type {DurableObjectStorage} from '@cloudflare/workers-types';
import type {AuthGrant} from '../contracts.js';
export type OrgStorage=DurableObjectStorage;
export type OrgMode='owner_only'|'preparing'|'active'|'paused';
export type OrgRole='owner'|'admin'|'deployer'|'viewer';
export type OrgAction='org.self'|'org.manage'|'app.read'|'app.deploy'|'app.manage'|'credential.read'|'credential.manage'|'runner.request'|'runner.approve'|'runner.organization';
export const orgActions:readonly OrgAction[]=Object.freeze(['org.self','org.manage','app.read','app.deploy','app.manage','credential.read','credential.manage','runner.request','runner.approve','runner.organization']);
export type RunnerKind='ota'|'native';
export interface ActorRef {kind:'human'|'runner'|'webhook'|'system';id:string}
export interface OrgState {id:string;ownerId:string;dbIdentity:string;origin:string;mode:OrgMode;revision:number;orgAccessEpoch:number;minProtocol:number}
export interface OrgBinding {ownerId:string;ownerEmail:string;dbIdentity:string;origin:string;workspaceName?:string}
export interface OrgLimits {metadataBytes:number;auditBytes:number}
export interface OrgPrincipal {organizationId:string;userId:string;membershipId:string;role:OrgRole;authSource:'legacy_owner'|'member';authEpoch:number;membershipRevision:number;ownerEpoch:number;sessionHash:string;expiresAt:number}
export interface OrgGrant extends AuthGrant {principal:OrgPrincipal}
export interface OrgMemberState {authSource:'legacy_owner'|'member';userId:string;membershipId:string;role:OrgRole;userStatus:'active'|'disabled';membershipStatus:'active'|'disabled';authEpoch:number;membershipRevision:number}
export interface OrgPage<T>{items:T[];nextCursor:string|null}
export interface MembershipInput {expectedRevision:number;role:Exclude<OrgRole,'owner'>;addAppIds:string[];removeAppIds:string[]}
export interface InvitationInput {purpose:'invite'|'reset'|'reactivate';email:string;targetUserId?:string;expectedRevision:number;role?:Exclude<OrgRole,'owner'>;appIds?:string[]}
export interface AuditIntent {id:string;actor:ActorRef;action:OrgAction;appId?:string;membershipRevision?:number;requestId?:string;state:'pending'|'completed'|'rejected'|'unknown'}
export class OrgFailure extends Error {constructor(readonly status:number,readonly code:string,readonly retryAfter?:number){super(code)}}
export const defaultOrgLimits:Readonly<OrgLimits>=Object.freeze({metadataBytes:67_108_864,auditBytes:268_435_456});
export function orgAssert(condition:unknown,status=403,code='FORBIDDEN'):asserts condition {if(!condition)throw new OrgFailure(status,code)}
export function safeInteger(value:unknown,minimum=1):asserts value is number {orgAssert(typeof value==='number'&&Number.isSafeInteger(value)&&value>=minimum,400,'INVALID_REQUEST')}
export function orgId(value:unknown):asserts value is string {orgAssert(typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value),400,'INVALID_REQUEST')}
export function normalizeEmail(value:unknown):string {orgAssert(typeof value==='string',400,'INVALID_REQUEST');const email=value.trim().toLowerCase();orgAssert(email.length<=254&&/^[\x21-\x7e]+$/.test(email)&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),400,'INVALID_REQUEST');return email}
export function orgLabel(value:unknown):asserts value is string {orgAssert(typeof value==='string'&&[...value].length>=1&&[...value].length<=80&&!/[\u0000-\u001f\u007f-\u009f]/.test(value),400,'INVALID_REQUEST')}
export function utf8Bytes(value:unknown):number{return new TextEncoder().encode(JSON.stringify(value)).byteLength}

/** Legacy Owner syntax is validated by readConfig; do not impose new-member ASCII rules. */
export function normalizeOwnerEmail(value:string):string {return value.trim().toLowerCase()}

/** Preserve the exact pre-organization deployment identifier syntax from readConfig. */
export function storageIdentity(value:unknown):asserts value is string {orgAssert(typeof value==='string'&&/^[A-Za-z0-9._:-]{1,256}$/.test(value),400,'INVALID_REQUEST')}

export interface RunnerAccessRef {kind:RunnerKind;runnerId:string}
export interface RunnerRequest {id:string;appId:string;kind:RunnerKind;name:string;platforms:('ios'|'android')[];requesterUserId:string;approverUserId:string|null;state:'pending'|'approved'|'issuing'|'claimed'|'revoked'|'unknown';revision:number;requestedAt:number;expiresAt:number;claimExpiresAt:number|null;runnerId:string|null}

/** Browser DTOs exclude storage identity, hashes, epochs and verifier material. */
export interface OrgSelfView {organizationId:string;userId:string;membershipId:string;displayName:string;role:OrgRole;permissionRevision:number;appIds:string[];nextAppCursor:string|null;capabilities:OrgAction[]}
export interface OrgDisplayView {id:string;name:string;mode:OrgMode;revision:number}
export interface OrgMemberView {userId:string;membershipId:string;displayName:string;email:string;role:OrgRole;status:'active'|'disabled';revision:number;appIds:string[];hasMoreApps:boolean}
