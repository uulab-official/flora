import type {OperationsState,AutomationState} from "@app-ops/dogfood";
export interface PublicationTarget {appId:string;commitSha:string;channel:string;runtimeVersion:string;platforms:('ios'|'android')[]}
export interface GitHubStatus {configured:boolean;source?:'managed'|'environment'|null;appId?:string|null;appSlug?:string|null;installationUrl?:string|null}
export type OnboardingAutomation=Omit<AutomationState,'runners'>&{runners:Array<AutomationState['runners'][number]&{presence?:{status:'online'|'offline';lastSeenAt:number|null}}>};
export interface OnboardingInput {authenticated:boolean;appId:string|null;connection:GitHubStatus|null;operations:OperationsState|null;automation:OnboardingAutomation|null;target:PublicationTarget|null}
export interface OnboardingState {steps:Array<{id:'owner'|'github'|'sdk'|'runner'|'publication';status:'needed'|'working'|'approval'|'unknown'|'verified'|'failed';reason:string}>}
export function deriveOnboardingState(input:OnboardingInput):OnboardingState;
import type {AutomationJob,OTAPublicationView} from '@app-ops/dogfood';
export interface PublicationResult {status:'waiting'|'partial'|'published';platforms:Array<{platform:'ios'|'android';jobId:string|null;deploymentId:string|null;verified:boolean}>}
export function freezePublicationTarget(input:PublicationTarget):PublicationTarget;
export function evaluatePublications(target:PublicationTarget,jobs:AutomationJob[],publications:OTAPublicationView[]):PublicationResult;
