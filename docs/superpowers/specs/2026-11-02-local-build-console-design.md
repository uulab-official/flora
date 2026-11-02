# Local build console and trusted runner design

Goal: make the previously delivered local ledger and artifact services usable through a loopback web console, with scoped browsing, lifecycle actions, verified downloads, and a CLI-only trusted command runner. Preserve hosted production and native OTA/signing boundaries.

Approaches: (1) patch the hosted Cloudflare UI before local byte delivery exists; (2) connect the existing local service to a loopback console first; (3) require an external cloud build/storage provider. Choice for this continuation: (2), since bytes and SQLite are local and no paid services or new credentials are needed. This is an implementation choice, not a new user requirement. Hosted UI integration remains separate.

Constraints: Node built-ins, existing Node 24.19 target; Linux/macOS private paths; no production Worker/D1/OTA mutation; no external HTTP from the console; no automatic public deployment. Use the existing state directory and SQLite ledger without schema reset.

Console: bind only 127.0.0.1 with an OS-selected port. Explicit app allowlist at startup. Private approval-code file with 10-minute, single-use code, HTTP-only SameSite=Strict cookie, 30-minute fixed session lifetime, separate CSRF header. Exact Host and Origin checks, Fetch Metadata filtering, bounded JSON requests, CSP, no credentials in URLs or localStorage. Restart/log out revokes capabilities. Local OS owner is trusted; this is not a multi-user SaaS or local-user security boundary.

Operations: list/detail/paginated audit; create immutable job records; authorize/queue only explicit eligible transitions; cancel only queued work, never falsely claim a running process stopped. Do not accept completion evidence, arbitrary paths or commands from HTTP. Actions use optimistic versions and idempotency keys.

Download: POST a same-origin CSRF-protected request bound to app/job/artifact; short-lived single-use random capability with server limits. Consume atomically, export to an exclusive private staging directory with the existing double-hash copy path, verify before streaming from an open descriptor, cap concurrent downloads, delete temporary files on success/disconnect/failure. A failed or interrupted transfer requires a new ticket; no implicit range/resume support.

Runner: CLI-only --execute; fixed local recipe with absolute executable, argv array, cwd, output path, app/runner/platform binding. No shell, no user-supplied browser command. Validate Git HEAD against job source SHA before and after and reject tracked changes. Run in an isolated trusted checkout; no sandbox claim. CAS claim of queued work, bounded runtime/output, process-group termination on timeout/abort, explicit failed/unknown handling, successful exit plus verified output to complete. No signature/installation claim.

Evidence: red/green unit+HTTP tests, actual child-process fixture, CLI integration, browser check if a browser can run with its sandbox intact. No weakening a sandbox for a screenshot. New branch/PR rather than merging existing conflicted draft.
