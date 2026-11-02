# Local runner control review record

Scope: PR16 follow-up, based on 29662c37d6490b2bc8101d2015892e74457b6bff.

Review performed inline; no independent reviewer/subagent was available. This is not an external approval.

## Findings and corrections

1. New admission controller initially marked another runner's `running` job unknown if it lost the claim race. A regression test reproduced `unknown` instead of `running`; removed that state rewrite. A losing controller cannot infer ownership from job status.
2. Browser action retry initially created a new idempotency key after a synthetic lost response. Sandboxed Chromium component test reproduced it; request key now belongs to the confirmation intent and is retained across resubmission.
3. Full-app totals would have conflicted with page-local filters. Added scoped SQL search/status predicates with literal substring matching, cursor bounds, explicit allowed status values, and >one-page tests.
4. Private preset JSON admission now checks ownership and mode on the opened file snapshot; general input read compares mode/uid before and after as well as inode/size/timestamps.

## Checked boundaries

Default process execution stays disabled. HTTP rejects command/argv/path fields. Presets are copied and immutable; public summaries contain no local paths. Session/CSRF/Origin/Host/app scope applies to all new routes. Controller cache is bounded; SQLite CAS prevents a second runner claim. Cancellation is a request, not a success report; unknown outcome is never retried. Retry creates an atomic unapproved child without editing original job/history. Console shutdown awaits its process tasks. There is no cloud deployment, credential upload, OS sandbox or signature-validation claim.

## Evidence

Linux Node 22.16.0 extracted snapshot: 115 tests passed, 0 failed, 0 skipped. Actual process/HTTP tests are separate from offline component tests. Sandboxed Chromium offline component interaction checks passed with 0 external requests / 0 page errors; live localhost navigation was blocked by ERR_BLOCKED_BY_ADMINISTRATOR. `npm test` was attempted, but pnpm was not installed and this runtime has only a source extraction. Prior remote Foundation success applies to 29662c3, not automatically to these changes. New-head CI must be checked separately before merge.
