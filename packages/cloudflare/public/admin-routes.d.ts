export type AdminPage = "projects" | "register" | "overview" | "source" | "ota" | "ota-detail" | "runners" | "builds" | "credentials" | "app-settings" | "activity" | "settings";
export interface AdminRoute { page: AdminPage; appId: string | null; path: string; deploymentId?: string; filter?: "issues" | "unresolved" | "resolved" }
export const ADMIN_PAGES: Readonly<Record<AdminPage, { title: string; description: string; section: string; legacy: string }>>;
export function adminPath(page: string, appId?: string | null, deploymentId?: string | null): string | null;
export function parseAdminPath(pathname: unknown): AdminRoute | null;
