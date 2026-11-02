# Inline review — preflight/progress

Not an independent code review. Reviewed the tested diff against the existing owner-only trust boundary.

- Read-only preflight uses an existing ledger and copies request primitives before IO; runtime revalidates checks instead of trusting advisory success.
- Public observations contain only allowlisted fields/codes. No stderr/stdout content, paths, args, environment or process identifiers is serialized.
- CSRF/app/session scope and post-await session check remain in the server. App/dialog changes invalidate asynchronous UI responses. Closed dialogs now clear their private context.
- Audit stages are fixed, sequential, same-version, runner-bound and transactional. No schema changes or new backup tables.
- Reproduced/fixed output-parent symlink admission, missing quiet-process heartbeat, and cancellation arriving during artifact verification.
- Fixed numeric progress rerenders so counter-only updates do not replace action buttons.
- Executor availability is advisory, not a file ownership proof. OS executable installation paths may be shared; operator-selected binaries remain trusted.
- Output cap defaults unchanged, bounded opt-in override; no raw output storage. Observers throwing/rejecting cannot fail an otherwise successful build.
- Existing limitations retained: no untrusted-code sandbox, no proof of native compile/signing/install, no process liveness after console restart. Cancellation after final commit begins may lose to a successful commit; consult the ledger.
- Tests use synthetic unsigned artifacts and actual subprocesses; browser component harness uses mocked HTTP responses and blocks all external requests. A real HTTP server is tested separately.
