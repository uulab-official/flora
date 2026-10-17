export type D1FailureCode = "D1_DAILY_READ_LIMIT" | "D1_DAILY_WRITE_LIMIT" | "D1_ACCOUNT_STORAGE_LIMIT" | "D1_DATABASE_SIZE_LIMIT" | "D1_OVERLOADED";

/** Only documented D1 dependency messages map to public constants. Nothing
 * from the exception, SQL, bindings or headers is returned or logged. */
export function d1FailureCode(error: unknown): D1FailureCode | null {
  const seen = new Set<object>();
  for (let depth = 0; depth < 4; depth++) {
    try {
      if (error === null || typeof error !== "object" || Array.isArray(error) || seen.has(error)) return null;
      seen.add(error);
      // Binding exceptions may cross realms or lose their Error prototype.
      // Read only own data fields: no accessor, prototype, stack or coercion.
      // A matching structural wrapper changes only this fixed 503 code; it
      // never supplies authority, changes data or authorizes a retry.
      const message = Object.getOwnPropertyDescriptor(error, "message")?.value as unknown;
      if (typeof message === "string" && message.length <= 4096) {
        const detail = message.trim().replace(/^D1_ERROR:\s*/, "");
        if (/^Your account has exceeded D1's free tier daily row read limit(?:[.\s]|$)/.test(detail)) return "D1_DAILY_READ_LIMIT";
        if (/^Your account has exceeded D1's free tier daily row write limit(?:[.\s]|$)/.test(detail)) return "D1_DAILY_WRITE_LIMIT";
        if (/^Your account has exceeded D1's maximum account storage limit(?:[,\.\s]|$)/.test(detail)) return "D1_ACCOUNT_STORAGE_LIMIT";
        if (/^Exceeded maximum DB size(?:[.\s]|$)/.test(detail)) return "D1_DATABASE_SIZE_LIMIT";
        if (/^D1 DB is overloaded\. (?:Requests queued for too long|Too many requests queued)(?:[.\s]|$)/.test(detail)) return "D1_OVERLOADED";
      }
      error = Object.getOwnPropertyDescriptor(error, "cause")?.value as unknown;
    } catch { return null; }
  }
  return null;
}
