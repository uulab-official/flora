# Local build operations: execution and review record

> Historical baseline record for the earlier local-operations patch. The subsequent console/runner integration and its updated verification boundaries are documented in `docs/development/local-build-console.ko.md`. Statements about no HTTP/runner execution or no remote publication below describe that earlier snapshot, not the cumulative feature branch.


Base: cd91a87d8fb8223127f2a2011417296ba3c58cc7 (PR #15). Date: 2026-11-02.
All 12 selected baseline file blobs were matched against GitHub-reported SHA-1 blob IDs.
This is a targeted file snapshot, not a complete repository clone.

## Observed before implementation
- Existing artifact suite: 14 tests, 13 pass, 1 failure. The file test retained its hardlink
  fixture, so its subsequent corruption assertion observed a non-regular-file error.
- Added seven regressions: all failed before fixes (ID coercion, version overflow,
  request mutation, changed replay version, metadata mutation before asynchronous IO).
- Number-based Stats did not provide the nanosecond fields compared by the old verifier.
  The verifier now requests BigInt Stats, checks before/after and protects descriptor consumption.

## Decisions and boundaries
- Chose local SQLite instead of modifying production D1. No new dependencies; no cloud calls.
- Preserve the memory implementation as a reference. Durable operations require a private owner-local directory.
- Keep a separate trusted-runner reporting boundary. No claim of automatic compilation or physical-device proof.
- Binaries and SQLite cannot commit atomically together. Register metadata only after verified publication;
  known rolled-back duplicates are removed; ambiguous orphaned files are diagnosed without automatic deletion.
- A proposed trailing-newline defect did NOT reproduce in JavaScript. Kept the additional tests;
  reverted the unnecessary production-code edit. The existing metadata implementation already rejects these inputs.
- No independent subagent/reviewer was available. Performed implementation-level self-review plus regression tests;
  an independent review, pinned-Node CI and platform/browser/device gates remain required before release.

## Review checks
- Query values use prepared statements; context and outgoing metadata are whitelisted.
- SQLite state, idempotency response, artifact metadata and audit row commit in one short transaction.
- Actual separate-process CAS race and SIGKILL before COMMIT are tested.
- CLI lifecycle uses fresh processes rather than only calls to a memory instance.
- Cancellation during file publication wins; duplicate completions do not duplicate committed files.
- Export is new-file-only; same-size corruption, symlink output, partial file cleanup and restored-mtime
  mutation are tested. Root ownership is local-operator trust, not adversarial multi-tenant isolation.
- Doctor reports partial scans, unknown outcomes, unreferenced files and byte-integrity failures explicitly.

## Not verified / not delivered
- GitHub push, PR modification, merge or production deployment.
- Full monorepo build and typecheck; browser rendering; Cloudflare bindings/migrations.
- Existing production Runner wiring, provider billing/credentials, external build execution.
- Pinned Node 24.19.0 runtime or macOS/Windows execution in this sandbox.
- APK/AAB/IPA signing, structural validation, real installation or OTA/rollback.
