# Native Runner transport reliability

Continue the existing approved Flora work without touching production or replacing its running Hosted/native architecture. Fix the current Linux Foundation failure in `native-client.ts`, then strengthen the same transport used by pending/claim/heartbeat/credential grant/completion/failure/presence.

The request owns immutable origin, credential, app, platform and input snapshots. One 20-second deadline covers fetch and the entire response; an earlier original lease expiry is a different failure. Timer firing records its cause, independently of wall-clock rounding. Caller cancellation, a changed wall clock, blocked response streams and ignored AbortSignals must not permit late success. Bounded successful JSON is decoded with strict UTF-8. Already observed HTTP authority rejection must not be downgraded to a transient transport error while reading its body. Nothing retries a mutation automatically or claims cancellation rolls back a remote commit.

Keep wire routes and payloads unchanged, retain `NativeHttpFailure` and existing fixed codes, add optional caller AbortSignals compatibly, no credentials in diagnostics. Preserve the existing native controller isolation policy and no secrets/production data in tests. Selected-source local verification is not full-monorepo or actual device verification.
