# Local build operations: integrated, durable, owner-controlled

> Historical baseline record for the earlier local-operations patch. The subsequent console/runner integration and its updated verification boundaries are documented in `docs/development/local-build-console.ko.md`. Statements about no HTTP/runner execution or no remote publication below describe that earlier snapshot, not the cumulative feature branch.


## Intent
Turn the artifact/ledger prototypes in PR #15 into a usable local operations path:
register an immutable job, record transitions, finalize a trusted runner result,
publish verified bytes, inspect durable history, and export verified artifacts.
No cloud credentials, server charges, deployment, or native compiler execution.

## Constraints
- Work from verified file blobs at `cd91a87d8fb8223127f2a2011417296ba3c58cc7`.
- The main repository still requires Node >=24.19.0 <25. This sandbox has Node 22.16.0;
  its test results are compatibility evidence, not the project's pinned-version gate.
- No new runtime dependencies. SQLite through `node:sqlite`; Linux/macOS local owner.
- Do not mutate production Worker, D1, OTA, keys, or existing runner recovery journals.
- Local metadata is NOT authorization for a public API or a multitenant service.
- Actual signing, installation, cloud provider calls, browser QA and device OTA remain unverified.

## Approaches
1. Extend the memory ledger: cheap, but cannot preserve state across processes.
2. Add cloud D1 endpoints first: integration and credentials risk, no safe runtime here.
3. Local SQLite plus existing artifact helpers and a CLI: chosen implementation direction;
   provides restart/crash-safe metadata and testable end-to-end operations without deployments.
This is an implementation choice under the user's instruction to continue, not a newly approved product scope.

## Design
- Share strict event/scope validation and guard version overflow. Snapshot input before awaits.
- Keep the memory ledger for dry runs; add a durable SQLite ledger. A single transaction
  updates job state, idempotency receipt, audit event, and completed artifact metadata.
- Bind repository/SHA/platform/runner ID at job creation. Success requires a zero-exit
  result from the trusted local runner boundary AND a verified stored artifact. It does
  not prove the caller's honesty, signing, native build correctness, or installation.
- Stream artifacts using bounded buffers, actual BigInt timestamps and private directories.
  Hash copied bytes; publish/export without overwriting existing files. Never trust a stored
  absolute path from request data. Source and destination remain under the local owner's control.
- Keep filesystem and SQL boundaries explicit: a process kill before SQL commit may leave
  an unreferenced file. Diagnose it; never advertise it as a successful build or delete it automatically.
- CLI uses explicit init, structured JSON, bounded JSON input, app/job scoped queries,
  and new-file-only exports. Normal responses and errors do not expose private paths or raw provider logs.

## Acceptance
Existing tests run; every observed failure is identified. New tests exercise restart,
CAS, conflicting replay, concurrent processes, corruption, private path checks, same-size
mutations, unsafe IDs, CLI operations, missing state and export overwrite protection.
Deliver a patch, source snapshot, and raw test evidence. No remote push claim.
