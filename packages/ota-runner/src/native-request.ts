/** One budget covers headers and the entire body. Never retries a request. */
const REQUEST_MS = 20_000;
export const NATIVE_RESPONSE_BYTES = 4 * 1024 * 1024;
export type NativeRequestCode = "NATIVE_CANCELLED" | "NATIVE_LEASE_EXPIRED" | "NATIVE_TRANSPORT_UNAVAILABLE";

export function discardNativeBody(response: Response): void {
  // Disposal must not keep a cancelled operation alive or surface provider text.
  try { void response.body?.cancel().catch(() => {}); } catch { /* already locked/closed */ }
}

export class NativeRequestDeadline {
  readonly #controller = new AbortController();
  readonly #caller: AbortSignal | undefined;
  readonly #leaseExpiry: number | undefined;
  readonly #started = performance.now();
  readonly #budget: number;
  readonly #timerCode: NativeRequestCode;
  readonly #timer: ReturnType<typeof setTimeout>;
  #code: NativeRequestCode | undefined;
  readonly #cancel = () => this.#stop("NATIVE_CANCELLED");

  constructor(leaseExpiry?: number, caller?: AbortSignal) {
    this.#caller = caller;
    this.#leaseExpiry = leaseExpiry;
    const remaining = leaseExpiry === undefined ? Infinity : leaseExpiry - Date.now();
    this.#budget = Math.max(0, Math.min(REQUEST_MS, remaining));
    this.#timerCode = remaining <= REQUEST_MS ? "NATIVE_LEASE_EXPIRED" : "NATIVE_TRANSPORT_UNAVAILABLE";
    // Save why this timer was armed. Date.now() may still precede the deadline
    // because of timer rounding or a wall-clock adjustment when it fires.
    this.#timer = setTimeout(() => this.#stop(this.#timerCode), Math.max(1, Math.ceil(this.#budget)));
    caller?.addEventListener("abort", this.#cancel, { once: true });
    if (caller?.aborted) this.#cancel();
    else if (remaining <= 0) this.#stop("NATIVE_LEASE_EXPIRED");
  }

  get signal(): AbortSignal { return this.#controller.signal; }

  #stop(code: NativeRequestCode): void {
    if (this.#code) return;
    this.#code = code;
    this.#controller.abort(); // Never propagate a caller-supplied secret reason.
  }

  failure(): NativeRequestCode | undefined {
    if (this.#caller?.aborted) this.#stop("NATIVE_CANCELLED");
    else if (this.#leaseExpiry !== undefined && Date.now() >= this.#leaseExpiry) this.#stop("NATIVE_LEASE_EXPIRED");
    else if (performance.now() - this.#started >= this.#budget) this.#stop(this.#timerCode);
    return this.#code;
  }

  assertLive(): void {
    const code = this.failure();
    if (code) throw new Error(code);
  }

  /** Bound even an injected fetch/read that ignores AbortSignal. */
  async wait<T>(operation: () => Promise<T>, disposeLate?: (value: T) => void): Promise<T> {
    this.assertLive();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const dispose = (value: T) => { try { disposeLate?.(value); } catch { /* best effort */ } };
      const finish = () => { settled = true; this.signal.removeEventListener("abort", abort); };
      const abort = () => {
        if (settled) return;
        finish();
        reject(new Error(this.failure() ?? "NATIVE_TRANSPORT_UNAVAILABLE"));
      };
      this.signal.addEventListener("abort", abort, { once: true });
      if (this.signal.aborted) { abort(); return; }
      let pending: Promise<T>;
      try { pending = operation(); } catch (error) { finish(); reject(error); return; }
      Promise.resolve(pending).then(value => {
        if (settled) { dispose(value); return; }
        const code = this.failure();
        if (code) {
          dispose(value);
          if (!settled) { finish(); reject(new Error(code)); }
          return;
        }
        finish(); resolve(value);
      }, error => {
        // Installing both handlers also consumes late transport rejections.
        if (!settled) { const code = this.failure(); if (!settled) { finish(); reject(code ? new Error(code) : error); } }
      });
    });
  }

  close(): void {
    clearTimeout(this.#timer);
    this.#caller?.removeEventListener("abort", this.#cancel);
  }
}

export async function readNativeJson(response: Response, deadline: NativeRequestDeadline, maximum = NATIVE_RESPONSE_BYTES): Promise<unknown> {
  const invalid = () => new Error("NATIVE_RESPONSE_INVALID");
  const size = response.headers.get("content-length");
  if (size !== null && (!/^[0-9]+$/.test(size) || !Number.isSafeInteger(Number(size)) || Number(size) > maximum)) {
    discardNativeBody(response); throw invalid();
  }
  if (!response.body) throw invalid();
  const reader = response.body.getReader();
  // Bound allocation by bytes, not by the number of streamed chunks. Millions
  // of one-byte chunks must not create millions of retained buffer objects.
  let storage = new Uint8Array(Math.min(65536, maximum));
  let bytes = 0;
  const cancel = () => { try { void reader.cancel().catch(() => {}); } catch { /* closed */ } };
  deadline.signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const part = await deadline.wait(() => reader.read());
      if (part.done) break;
      const length = part.value.byteLength;
      if (length > maximum - bytes) throw invalid();
      if (bytes + length > storage.length) {
        const grown = new Uint8Array(Math.min(maximum, Math.max(bytes + length, storage.length * 2)));
        grown.set(storage.subarray(0, bytes));
        storage = grown;
      }
      storage.set(part.value, bytes);
      bytes += length;
    }
    deadline.assertLive();
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(storage.subarray(0, bytes))); }
    catch { throw invalid(); }
  } finally {
    deadline.signal.removeEventListener("abort", cancel);
    cancel();
    try { reader.releaseLock(); } catch { /* late read still pending */ }
  }
}
