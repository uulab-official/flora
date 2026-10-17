export function validateDeploymentDevices(value: unknown, appId: string, deploymentId: string, installationId?: string | null, expectedFilter?: "all" | "issues" | "unresolved" | "resolved"): boolean;
export function createDeploymentDevices(env: any, options: any): {open(route: any): Promise<void>; leave(): void; clear(): void};

export function validateDeploymentJourney(value: unknown, appId: string, deploymentId: string, installationId: string, expectedDeployment?: any): boolean;
