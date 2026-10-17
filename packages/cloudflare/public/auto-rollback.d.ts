export interface AutoRollbackCancellationSnapshot {
  checkedAt: number;
  attemptedInstallations: number;
  failedInstallations: number;
  confirmedHealthyInstallations: number;
  failureRatePercent: number | null;
}
export function validateRollbackPolicy(value: unknown, appId: string): boolean;
export function validateAutomaticRollbackDecision(value: unknown, appId: string): boolean;
export function renderAutomaticRollbackDecision(document: any, appId: string, decision: any): any;
export function eligibleRollbackTargets(values: any[], appId: string, channel: string, platform: string): any[];
export function createAutoRollback(env: any, options: any): {open(appId: string, deployments: any[]): Promise<void>; leave(): void; clear(): void};
