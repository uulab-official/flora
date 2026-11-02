# AAB signature integration review

This is inline review, not an independent code/security review. No reviewer agent was available. Keep the PR Draft.

## Reproduced and repaired
- Signed payload removal: JarFile validates surviving entries; without manifest-to-container completeness checking, deleting a payload file still passed. RED: missing expected rejection. Added exact manifest entry existence checks; GREEN.
- Orphan signature metadata: suffix-only exemptions accepted an extra unsigned .RSA entry. RED reproduced. Require one matching SF/block basename and no duplicate block; GREEN.
- Diagnostic mismatch: byte hash could be correct while persisted signing evidence was invalid. RED ready=true reproduced. Doctor now validates evidence shape and digest binding, and explicitly reports signatureRechecked=false; GREEN.
- Corrupt replay record: a changed signer in request history was returned even though bytes matched. RED reproduced. Signed replays validate evidence against the request's immutable signer expectation; GREEN.

- App switch retained hidden artifact/signature DOM after clearing selection. Browser regression failed; immediately remove previous detail nodes on switch; GREEN.

- A rejected signature still wrote the publication stage before verification. RED reproduced; record the stage only at actual publication admission. GREEN.

## Reviewed boundaries
Actual JDK-signed fixtures, expiry, mismatch, altered/unsigned entries, META-INF payload, metadata limits, abort and process-group cleanup, read-only refusal, policy snapshots, old unsigned fingerprints, source SHA/app identity, HTTP app/session/CSRF boundaries, no policy writes via browser, backup/restore shape and exact digest, safe text rendering and historical report semantics.

## Remaining limitations
JAR signing only, single pinned signer, trusted JDK/source/helper and local owner, no PKIX/OCSP/TSA, no AAB schema/bundletool or native app/device/Play verification. Staging can remain after SIGKILL; no automatic cleanup. Certificate validity is an observation at verifiedAt, not a perpetual attestation. Old versions may reject backups carrying new signing metadata. Actual browser navigation is subject to the environment's managed URL policy; synthetic component tests are not browser E2E.

## Local evidence
203 related tests pass on Linux Node 22.16.0 with JDK 21.0.12.1; no tests skipped. Five new signature UI checks and the existing nine synthetic component checks passed with the Chromium sandbox enabled and no external requests. These are synthetic browser components, not live browser E2E. The full monorepo npm test attempt stopped at missing pnpm in the extracted source workspace.
