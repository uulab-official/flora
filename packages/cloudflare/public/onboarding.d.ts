import type {OnboardingInput} from './onboarding-model.js';
export interface OnboardingContext {
 api(path:string,body?:string,signal?:AbortSignal):Promise<unknown>;
 isCurrent():boolean;getSnapshot():OnboardingInput;
 refreshData(selection:{operations:boolean;automation:boolean},signal?:AbortSignal):Promise<void>;
 setActiveJobPolling(active:boolean):void;navigate(path:string):void;expire?():void;
}
export function createOnboarding(env:{document:Document},context:OnboardingContext):{enter(appId:string|null):Promise<void>;leave():void;expire():void};
