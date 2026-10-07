export const SYNTHETIC_ORIGIN: "https://flora.example.test";
export interface BrowserRequest {
  url(): string;
  method(): string;
  allHeaders(): Promise<Record<string, string>>;
  postDataBuffer(): Buffer | null;
}
export interface RoutedResponse {
  status: number;
  headers: Iterable<[string, string]> & { getSetCookie(): string[] };
  arrayBuffer(): Promise<ArrayBuffer>;
}
export function bridgeRequest(request: BrowserRequest, dispatch: (url: string, init: { method: string; headers: Record<string, string>; redirect: "manual"; body?: Buffer }) => Promise<RoutedResponse>): Promise<{ status: number; headers: Record<string, string>; body: Buffer }>;
