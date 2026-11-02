# Native Runner session shutdown

The native transport supports per-request cancellation but native-main constructs clients without a process lifetime. The existing controller omits the signal on pending/presence/claim/credentials/complete/fail. SIGINT/SIGTERM can therefore leave requests in progress and configuration reads can proceed after shutdown.

## Chosen approach
Bind one optional lifetime signal at createNativeClient construction and compose it with (never replace) each method's optional signal. Keep the native controller, signing isolation, wire formats and retry rules unchanged. Extract argument admission and session orchestration into native-command.ts so its phases can be exercised through the real native HTTP client without loading native signing tools. native-main stays the actual executable and injects the existing readNativeConfig/runNativeDaemon/runNativeJob.

Alternatives: editing every controller call risks missing future methods; replacing the controller or adding another daemon duplicates existing execution/isolation. A client lifetime protects old and future call sites while preserving library callers that omit it.

## Contracts
- One fixed session lifetime covers all seven HTTP methods, including calls with no local signal.
- Neither the session nor method signal may mask the other. Late results cannot revive cancelled requests.
- Configuration read is not preempted; check the signal before/after it and before subsequent I/O. No claim or signing starts after observed cancellation.
- Completion unknown/reconciliation-required always outrank a concurrent shutdown. No automatic replay, rollback claim, artifact deletion, changed isolation or remote mutations added.
- A confirmed runNativeJob result remains confirmed if shutdown arrives after confirmation; do not rewrite committed success as unknown.
- Shutdown observed before/during setup/presence is stopped, not build success; CLI stopped exit 0, unknown/error exit 1, invalid arguments exit 2.
- Help performs no configuration or network I/O. Maximum 32 config paths, one mode, no duplicate paths/flags/control characters.
- Remove SIGINT/SIGTERM listeners in a finally block and abort the session on every exit path.

- Apply existing unresolved-completion checks to single-job mode before any HTTP, and recheck after asynchronous presence. Never delete or repair marker files automatically.

## Verification boundary
New tests use real loopback HTTP, simulated controller callbacks for command orchestration, and the real compiled native CLI for prebuild SIGTERM/SIGINT on POSIX CI. They do not prove Gradle/Xcode, native signing, installation or OTA success. Local workspace is an exact related-code extraction, not a full monorepo.
