import type {PublicationTarget} from './onboarding-model.js';
export function probeLaunchDownload(origin:string,target:PublicationTarget,platform:'ios'|'android',deploymentId:string,deps:{fetch:typeof fetch;subtle:SubtleCrypto},signal:AbortSignal):Promise<{kind:'web-download-hash';deploymentId:string;launchHash:string;bytes:number}>;
