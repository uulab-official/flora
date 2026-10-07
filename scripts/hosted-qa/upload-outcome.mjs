import { SYNTHETIC_ORIGIN } from "./transport.mjs";

/** Observe one explicitly selected file; this helper never sends a request. */
export function observeUpload(page, path, timeoutMs = 15_000) {
  let timer, finish;
  const matches = request => {
    const url = new URL(request.url());
    return url.origin === SYNTHETIC_ORIGIN && url.pathname === path && request.method() === "POST";
  };
  const response = value => { if (matches(value.request())) finish({ kind: "response", request: value.request(), response: value }); };
  const failed = request => { if (matches(request)) finish({ kind: "requestfailed", request, failure: request.failure() }); };
  const cancel = () => { clearTimeout(timer); page.off("response", response); page.off("requestfailed", failed); };
  const result = new Promise((resolve, reject) => {
    finish = outcome => { cancel(); resolve(outcome); };
    page.on("response", response); page.on("requestfailed", failed);
    timer = setTimeout(() => { cancel(); reject(new Error("UPLOAD_OUTCOME_TIMEOUT: " + path)); }, timeoutMs);
  });
  // File selection may itself still be pending when the deadline fires. Keep
  // that cleanup safe without replacing the rejecting promise the caller awaits.
  result.catch(() => {});
  return { result, cancel };
}

/** Classification only; callers must restrict this to the characterized POST. */
export function uploadResetEvidence(error) {
  const seen = new Set(), causes = []; let code;
  while (error instanceof Error && !seen.has(error) && causes.length < 8) {
    seen.add(error);
    const item = { name: error.name, message: error.message };
    for (const key of ["code", "syscall"]) if (typeof error[key] === "string") item[key] = error[key];
    if (Number.isSafeInteger(error.errno)) item.errno = error.errno;
    if (error.socket) {
      const counters = {};
      for (const key of ["bytesWritten", "bytesRead"]) if (Number.isSafeInteger(error.socket[key])) counters[key] = error.socket[key];
      if (Object.keys(counters).length) item.socket = counters;
    }
    causes.push(item);
    if (["ECONNRESET", "UND_ERR_SOCKET"].includes(error.code)) code ??= error.code;
    error = error.cause;
  }
  return code ? { code, causes } : null;
}
