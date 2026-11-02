# Local build control integration

Goal: complete the owner-only loopback console's local execution flow: reviewed preset → explicit run → actual process stop → durable result → verified download. Preserve prior jobs when preparing a retry, and show app-wide totals rather than page totals.

## Approach
Continue the existing Node/SQLite local path without changing Hosted Worker/D1/OTA. Choose private operator-loaded presets over browser-supplied commands; defer remote provider credentials and unattended execution. This follows the user's request to continue implementation, not a new permission to execute real private apps or paid builds.

Execution is disabled by default. Enabling requires both `--enable-execution` and a private presets JSON file. The file is read once and copied into immutable server memory. Only preset IDs, display names and app/repository/platform/runner bindings leave the server, never paths, executable or argv. Exact source SHA is still checked by the existing runner. Web start accepts queued job/version, preset ID and idempotency key only. Concurrency is bounded. Start deduplication is process-local and bounded; durable queued→running CAS is the execution gate across processes/restarts. Restart never resumes or retries a task automatically.

Cancellation signals only a task owned by this console, returning 'stopping' until the runner closes the process and records its final state. Closing the console aborts and awaits managed builds before closing the ledger. Completion may win a cancellation race; do not overwrite a successful result. Startup/preflight errors stay visible without changing queued work into a fictitious execution failure.

Retries create a fresh unconfigured job from only failed/cancelled jobs, preserve source and runner bindings, record parentJobId and an audit event, and are transactionally idempotent. Unknown/running/succeeded jobs cannot be retried. No schema migration or production DB modification.

Overview is scoped by app, computed over all jobs, and independent of pagination. All new APIs inherit session, origin, Host, CSRF and app allow-list guards. UI uses safe text nodes and request-generation guards. No untrusted repositories, no OS/network isolation claim, no signing or OTA success claim.

## Acceptance
Actual child process launched from authenticated HTTP; duplicate start invokes once; stale versions, mismatched presets, paths/commands in HTTP rejected; managed cancellation and shutdown release locks; real file downloaded byte-identically; retry/lineage survives restart and original history is preserved; two-app summaries do not leak; baseline tests plus new tests pass. Browser evidence is distinguished from HTTP evidence.
