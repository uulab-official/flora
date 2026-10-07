type UploadRequest = { url(): string; method(): string; failure(): { errorText: string } | null };
type UploadResponse = { request(): UploadRequest };
type PageEvents = { on(event: string, listener: (...args: any[]) => void): unknown; off(event: string, listener: (...args: any[]) => void): unknown };
export function observeUpload(page: PageEvents, path: string, timeoutMs?: number): {
  result: Promise<{ kind: "response"; request: UploadRequest; response: UploadResponse } | { kind: "requestfailed"; request: UploadRequest; failure: { errorText: string } | null }>;
  cancel(): void;
};
export function uploadResetEvidence(error: unknown): null | {
  code: "ECONNRESET" | "UND_ERR_SOCKET";
  causes: { name: string; message: string; code?: string; syscall?: string; errno?: number; socket?: { bytesWritten?: number; bytesRead?: number } }[];
};
