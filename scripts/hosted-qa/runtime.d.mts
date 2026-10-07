import type { RoutedResponse } from "./transport.mjs";
export function createHostedQaHarness(): Promise<{
  origin: "https://flora.example.test";
  email: string; password: string; token: string;
  source(index?: number): Buffer;
  baseline(sourceIndex?: number, attempt?: number): Promise<Buffer>;
  fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: Uint8Array | string; redirect?: "manual" }): Promise<RoutedResponse & { json(): Promise<unknown>; text(): Promise<string> }>;
  outboundRequests(): number;
  close(): Promise<void>;
}>;
