# Native session shutdown — inline review

Review scope: native-command.ts, native-main.ts, optional native-client lifetime, command aliases, regression tests and CI. This is a self-review, not independent security review.

- Preserved existing signing sandbox, controller, wire formats, legacy explicit claim IDs and no-replay behavior. No server routes, database migrations, provider calls or credentials changed.
- Added client default signal rather than enumerating controller call sites. Per-method cancellation composes with the session and never overrides it.
- Verified 17 missing-lifetime failures before the fix; method cancellation alone already passed. Both caller signals remain unmodified.
- Found single-job startup did not use unresolved-completion protection. Added three failing command tests, then applied the existing check before HTTP in both modes.
- Found an async gap after initial presence. Added a failing test and a second recovery check immediately before single-job dispatch. These checks do not claim an atomic multi-process lock.
- Completion-unknown and reconciliation-required retain precedence over concurrent operator stop. Confirmed controller success is not rewritten as failure.
- Argument errors/help perform no config/network I/O; output projects only public result fields. Parent and process listeners are cleaned on exit.
- Local selected strict source/test compilation and 90 tests passed. Existing 203 artifact tests passed with concurrency=2. Actual native-main subprocess tests require the full built repository and are included in POSIX CI, not claimed locally.
- No new native-controller source or compiler stubs were introduced. Local extraction does not contain the full native build/signing implementation; full-repository build/typecheck and actual CLI integration belong to CI.
- Stop cannot roll back a request already accepted by a server. Claim expiry and existing completion-unknown quarantine semantics remain necessary. Configuration filesystem/tool reads are checked before/after rather than force-preempted. Internal per-job abort is distinct from the new CLI session lifetime.
