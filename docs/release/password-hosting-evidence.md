# Password hosting release evidence

Evidence date: 2026-10-07 UTC. This record distinguishes local implementation checks from a working hosted service. No production account access, resource creation, deployment, DNS/TLS change, enrollment or private upload was performed for these checks.

## Reproducible local evidence

- Task baseline: `4faddf499bd5bb4266da173aba120b9e97d2c5b9`
- Backend integration source commit: `c5c831c5af1b23065ae15e1d341f7897cf8b2a2f` (tree `23a1a6cc8ed36802c342bc5dad2f680894280fc7`), plus this revision's limits test and documentation
- Final integrated release commit/tree, exact-SHA CI/render receipts and whole-change independent review: **unverified here**; record them in the external release evidence, without a self-referential SHA in this file
- Runtime: Linux, Node `24.19.0`, pnpm `11.19.0`, TypeScript `5.9.3`
- Pinned tools: Wrangler `4.148.0`, Miniflare `5.20261006.0-alpha`, esbuild `0.28.2`, Workers types `5.20261007.1`; transitive pins are in `pnpm-lock.yaml`

| Command / gate | Actual result |
| --- | --- |
| `pnpm build` | Passed; local bundle/config validation, no deployment |
| `node --test packages/cloudflare/test/limits.test.ts` | 7/7 passed; 26.27s emulator wall time |
| `pnpm check` | Passed; 321 tests, 320 pass, 1 existing Windows-only skip, 0 fail; 39.02s test wall time |
| `pnpm verify:clean` | Passed; 176 tracked files, isolated store, original source unchanged; 320 pass / 1 skip / 0 fail |
| `git diff --check` and `git diff --cached --check` | Passed |
| Final candidate Linux/macOS/Windows CI | Unverified here; retain required three-OS gates |
| Final candidate rendered-browser review | Unverified here; retain the separate render gate |

The test corpus is generated from `tests/dogfood-fixtures.ts`. Source envelopes of exactly 752,158 and 1,048,576 bytes contain valid per-file SHA-1/SHA-256 and base64 content; at most three trailing JSON spaces complete the exact size. Baselines of exactly 6,122 and 131,072 bytes contain a valid report and synthetic log. Tests use original bytes through the HTTP import path and compare persisted evidence digests. One-byte-over source/baseline/HEAD cases and HEAD 4,096-byte admission are separate probes. Matching the supplied pilot sizes establishes synthetic admission only; no private pilot contents were opened.

Observed synthetic metrics: largest source row 17,031 bytes; largest baseline row 203,087 bytes; first 20-entry history/state page 31,090 JSON bytes; lazy ASCII log 65,536 bytes / 65,627 JSON bytes. At 100 snapshots and 500 baselines, this small-record corpus used 7,586,806 accounted payload bytes and recovered the unchanged receipt after a lost response. These are measured sample sizes, not worst-case production allocations; separate SQL tests exercise the exact 524,288-byte row and 134,217,728-byte payload boundaries.

Resource assertions cover the 524,288-byte stored row ceiling, 1,048,576-byte response ceiling, 20-item keyset pages, lazily loaded 65,536-byte logs, 100 snapshot / 500 baseline count caps and 134,217,728-byte payload cap. Detailed SQL boundary coverage remains in `d1-import-store.test.ts`. Authentication tests cover native scrypt, cold/warm authority state, five live sessions, persistent rate windows, replay/eviction and failure sanitization. HTTP limits checks must use the real Worker/DO/D1 path, with test-only faults at dependency boundaries.

Local elapsed time is emulator wall time, not deployed front-Worker CPU, DO CPU, isolate memory or account capacity. No production performance gate is passed by these checks.

The initial expected RED was the missing hosted source route. After integration, six cases passed and the timeout test returned 403 because its test-only GET-to-POST probe omitted CSRF; supplying the required header produced the final 7/7 pass. The console test includes a positive capture control and retains enrollment output before checking for leaks. The install's first process-status poll timed out in automatic review; one bounded retry using the populated store completed successfully. Pinned supply-chain checks and Wrangler emitted network/proxy warnings; no versions, crypto parameters or transport security were weakened. The skipped test was `Windows preparation inherits profile access and rejects junctions`, which still needs the required Windows gate.

## Explicit upload-recovery acceptance scope

The synthetic HTTP and browser gates now evaluate an honest upload failure
followed by explicit user recovery. The full original source POST without CSRF,
consumed 403, and immediate valid POST remain the characterized boundary. Only
its `ECONNRESET` / `UND_ERR_SOCKET` cause can enter one history reload and one
same-file resubmission in HTTP acceptance. Every other transport error, and any
failed recovery step, still fails. Strict `dispatchFetch` characterization still
fails on its original error. A successful initial POST explicitly reports that
natural-reset recovery was not exercised.

Deterministic browser abort before dispatch proves no write and exact unchanged
state. Delivery loss after real source and baseline commits instead proves that
explicit reload/reselection preserves the complete committed receipt, original
record timestamps/provenance/digests and duplicate-free state. Post-dispatch
failure alone never proves that no write occurred. The existing production UI
supplies the uncertain-result alert, releases busy state, clears the selected file
and waits for user action; its retry control only reloads history. Separate
network / 403 / 401 UI tests preserve permission guidance and valid-session state
on 403, and require private clearing, late-response fencing and a fresh session
on 401. A 401 can follow a submitted D1 write; existing Worker tests retain that
boundary. Request-outcome QA evidence is separate from stored baseline results.

This is an acceptance-contract change, not an auth/runtime repair. It adds no
production retry, socket override, delay, denied-body draining or dependency
change. Initial-reset characterization, exact-candidate OS/browser receipts,
visual review, deployed rejection/retry, and actual Free-edge behavior remain
open until separately verified. Browser evidence stays within fifteen PNGs plus
one JSON file and the existing 4 MiB total cap. See the
[synthetic gate contract](../../scripts/hosted-qa/README.md#ordinary-http-acceptance-and-unresolved-runtime-gate).

## Ordered production gates

All unchecked items are **unverified**. Record the observed result, UTC time, exact deployed version and a non-secret evidence reference before marking a gate complete. Do not paste credentials, setup tokens, private payloads or real resource identifiers into this public document.

1. [ ] Verify the owner's account, actual Workers/DO/D1 Free activation and current shared usage/capacity. Include Worker-first asset request consumption. Stop if payment, a paid plan or unavailable Free capacity is required; do not enable billing or a paid fallback.
2. [ ] Confirm the exact reviewed commit/tree and reproducible bundle. Record its deployment version in the private release record. Resolve the intended `FLORA_AUTH`, `FLORA_DB`, `ASSETS`, owner/origin/DB marker and stable `flora-owner-v1` namespace. Preserve the `FloraAuth` class and initial `v1` SQLite migration on redeploy. No default owner or database; requests must not provision missing identity.
3. [ ] Handle specific new resource, domain and security changes under their applicable authorization. Existing free hosting/address intent does not authorize unrelated access expansion or automatic production deployment after future pushes. Disclose any new mandatory agreement before acceptance and link it. Never commit provider credentials.
4. [ ] Verify configuration with the pinned official tools: compatibility date `2026-10-07`, `nodejs_compat`, Worker-first assets for all routes, disabled workers.dev and preview URLs, correct migration and bindings. Omit `limits.cpu_ms` in the combined Worker/DO script: it also changes the DO budget, so it is not a front-only 10ms setting. Verify the actual Free front plan cap and default 30s DO budget separately. Confirm HTTPS/TLS at the configured origin and reject alternate hostnames, asset aliases, malformed paths and unauthorized requests without exposing private assets.
5. [ ] On the exact deployed Free bundle, use synthetic, non-secret vectors to verify native scrypt correctness and cold/warm login/import. Record separate front CPU (<10ms with headroom), DO CPU (<30s with headroom), and memory behavior within the shared 128MiB isolate budget. Record measurement coverage and limitations; unavailable critical metrics keep this gate open. Emulator timings and `maxmem=64MiB` are not memory proofs.
6. [ ] Verify deployed overload/admission, bounded Retry-After, D1/DO failures, original-byte digest/idempotency including lost responses, enrollment race/replay, and immediate revocation before the next D1 submission. An already-submitted write may finish. Avoid deliberately exhausting the shared account. Failures require reassessment, without lowering crypto or replacing password login.
7. [ ] After the synthetic gates, arrange the user's direct setup token and password creation/confirmation/submission on verified HTTPS. The assistant must not retrieve, generate for the user, observe, repeat or store credentials. Confirm default locked setup, one-use increasing generation and recovery revocation. Preserve the [authentication DB restore runbook](../development/password-hosting.ko.md#인증-db-복원-절차): public auth stays offline until the claimed-owner backup, external highest-issued-generation ledger, complete session invalidation and strictly newer recover-only generation are verified. Pre-enrollment or unknown backups remain offline and must never reopen enrollment. Handle credentials only through the supported direct-user handoff.
8. [ ] Obtain explicit authorization for the specific private original-envelope upload. Verify its immutable receipt/provenance, then a fresh second-browser login and the same stored facts/history. Record a verified working URL before calling hosting complete. If supported account/browser access or authorization is unavailable, leave this gate open with the exact blocker.

Deployment identity/version: **unverified**. Working URL/TLS: **unverified**. Actual Free CPU/memory/capacity: **unverified**. Owner enrollment: **unverified**. Private-file import and second-browser confirmation: **unverified**.

Published platform constraints must be rechecked at release against [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/). This checklist's numerical budgets are the implementation's proposed hard limits, not a claim that a specific account currently qualifies or has sufficient remaining resources.
