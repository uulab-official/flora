import type { DashboardState } from "@app-ops/dashboard/service";
export interface DashboardElement {
  id: string;
  firstElementChild: DashboardElement | null;
  open: boolean;
  textContent: string | null;
  value: string;
  disabled: boolean;
  hidden: boolean;
  className: string;
  type: string;
  focus(): void;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  append(...children: DashboardElement[]): void;
  replaceChildren(...children: DashboardElement[]): void;
  addEventListener(name: string, listener: (event: { target: { value: string; files?: readonly { size: number; text(): Promise<string> }[]; getAttribute?(name: string): string | null } }) => void): void;
}
export interface DashboardDocument {
  activeElement?: DashboardElement | null;
  createElement(tag: string): DashboardElement;
  getElementById(id: string): DashboardElement;
}
export interface ClientEnvironment {
  document: DashboardDocument;
  location: { hash: string; pathname: string; search: string };
  history: { replaceState(data: unknown, unused: string, url?: string): void };
  fetch(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
  crypto: { randomUUID(): string };
}
export function renderDashboard(document: DashboardDocument, state: DashboardState): void;
export function renderStatus(document: DashboardDocument, status: "ready" | "loading" | "session" | "error" | "saving", code?: string): void;
export function startClient(environment: ClientEnvironment): Promise<{
  close(): void;
  refresh(): Promise<boolean>;
  run(): Promise<void>;
  cancel(recordId: string): Promise<void>;
  importFile(kind: "source" | "baseline", file?: { size: number; text(): Promise<string> }): Promise<void>;
  chooseSnapshot(snapshotId: string): Promise<void>;
}>;
