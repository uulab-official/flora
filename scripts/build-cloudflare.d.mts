export interface HostedBuildConfig {
  compatibility_date: string;
  compatibility_flags: string[];
  assets: { run_worker_first: boolean };
  workers_dev: boolean;
  preview_urls: boolean;
  migrations: { tag: string; new_sqlite_classes: string[] }[];
  limits?: { cpu_ms?: number };
}
export function validateExampleConfig(file?: string | URL): Promise<HostedBuildConfig>;
export function validateDeploymentConfig(file: string | URL): Promise<HostedBuildConfig>;
export function buildHosted(): Promise<void>;
