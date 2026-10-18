import type {RunnerSummary} from '@app-ops/dogfood';
import type {PublicRunnerBinding} from '../../cli/src/setup/contracts.js';
export interface PublicFilesInput {appId:string;origin:string;channel:string;runtimeVersion:string;platforms:('ios'|'android')[];bundler:'metro'|'expo';entryFile:string;nodeVersion:string;packageManager:{name:'npm'|'pnpm'|'yarn';version:string}}
export function buildPublicFiles(input:PublicFilesInput,signing:{appId:string;keyId:string;certificate:string}):{connection:string;config:string};
export function buildRunnerBinding(origin:string,appId:string,runner:RunnerSummary):PublicRunnerBinding;
