import type { RoutedResponse } from "./transport.mjs";
export function createHostedQaHarness(): Promise<{
  origin: "https://flora.example.test";
  email: string; password: string; token: string;
  sourceEvidence: { workerSha256: string; assetSha256: Record<string, string> };
  source(index?: number): Buffer;
  baseline(sourceIndex?: number, attempt?: number): Promise<Buffer>;
  dispatchFetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: Uint8Array | string; redirect?: "manual" }): Promise<RoutedResponse & { readonly body: ReadableStream<Uint8Array> | null; readonly bodyUsed: boolean; json(): Promise<unknown>; text(): Promise<string> }>;
  httpFetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: Uint8Array | string; redirect?: "manual" }): Promise<RoutedResponse & { readonly body: ReadableStream<Uint8Array> | null; readonly bodyUsed: boolean; json(): Promise<unknown>; text(): Promise<string> }>;
  outboundRequests(): number;
  close(): Promise<void>;
}>;
