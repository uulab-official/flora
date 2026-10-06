import type { JobKind, JobStatus } from "./schema.js";
export function afterInterruption(
  kind: JobKind,
  count: number,
  expired: boolean,
  retryable: boolean,
): { status: JobStatus; reason: string | null } {
  if (kind !== "build")
    return { status: "waiting", reason: "reconciliation_required" };
  if (retryable && count < 3) return { status: "queued", reason: null };
  return { status: expired ? "expired" : "failed", reason: null };
}
