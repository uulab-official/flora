import type {OrgViewModel,OrgActions} from './organization.js';
export function renderAccountSecurity(root:HTMLElement,model:Pick<OrgViewModel,'status'|'principal'>,actions:OrgActions):()=>void;
