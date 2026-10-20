import {orgAssert,safeInteger} from './types.js';
export const organizationAccessProtocol=1;
export function assertProtocol(current:number,candidate:number):void {safeInteger(current);orgAssert(current===organizationAccessProtocol&&candidate===organizationAccessProtocol&&candidate>=current,409,'ORG_PROTOCOL_INCOMPATIBLE')}
export interface OrgCheckpoint {schemaVersion:1;organizationId:string;ownerId:string;dbIdentity:string;origin:string;minProtocol:number;revision:number;orgAccessEpoch:number;auditSequence:number;mode:'owner_only'|'preparing'|'active'|'paused';generation:number}
