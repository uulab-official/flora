# R2 OTA Assets Implementation Plan

> **For agentic workers:** Execute the explicitly authorized implementation through bounded backend and cache workers, with independent security review. Do not recursively delegate. Preserve unrelated dirty edits; no repository commits are requested.

**Goal:** New automatic OTA binary assets live in private R2 while existing D1 data/history and downloads remain intact.

**Architecture:** Existing owner AuthDO controls budget and authentication. D1 stores immutable metadata/proof; R2 stores new bytes. The front Worker caches verified immutable downloads.

**Tech Stack:** TypeScript, existing pinned Cloudflare Workers/D1/AuthDO/R2 APIs, Node 24.19.0, pnpm 11.19.0, PC Docker Runner.

**Spec:** `docs/superpowers/specs/2026-10-17-r2-ota-assets-design.md`

## Global Constraints

- Preserve original keys, settings, histories, D1 chunks, production resource identities and native SDK URLs.
- EAS and Actions excluded. Standard R2 only; no automatic paid upgrade or unapproved checkout agreement.
- No R2 network call before bounded persistent budget reservation; no D1 binary fallback.
- No new polling or retained-history scans during normal publication.

## Review Focus

- Lease expiration during R2 I/O must leave no unauthorized D1 completion/publication.
- Unknown upload outcomes must retain orphan reservations and remain retry-safe.
- Public/cross-app/unpublished requests must not bypass publication or consume unintended storage calls.
- Monthly reset, restart and concurrency must not reuse prepaid operation/storage credits.
- Cache key variation and errors must not mix apps or expose private/session responses.

## Task 1: Verified R2 storage and additive proof

**Files:** New R2 storage/budget modules and migration in `packages/cloudflare/`; integration in `operations-store.ts`, `automation-store.ts`, `d1-import-store.ts`, `contracts.ts`, `auth-do.ts`; bounded requested-ID asset lookup in dogfood store interface and publication services. Backend worker owns these files.

- [x] Write failing workerd/D1/R2 tests for preservation, integrity, budgets, races, partial I/O and lease fences.
- [x] Implement private binding, atomic reservation, immutable object validation and external completion proof.
- [x] Preserve legacy reads and replace list scans in publication with bounded requested-ID queries.
- [x] Pass focused new and affected existing tests, typecheck and independent review.

## Task 2: Immutable edge asset cache

**Files:** `packages/cloudflare/src/worker.ts`, focused helper if required, new cache fixture/test. Cache worker owns these files.

- [x] Demonstrate a failing real Cache API hit/isolation/error test.
- [x] Cache positive immutable published asset responses after normal request admission; bypass unsafe variants.
- [x] Preserve authoritative fallback and test actual Cache API behavior, outage handling and tenant isolation.

## Task 3: Provider connection and deployed verification

**Files:** Dedicated deployment config under ignored `dist/r2-ota-2026-10-17/`; evidence there; final operational report under `docs/development/`. Root owns these files and external actions.

- [x] Verify UULab account and current R2 activation/checkout state; capture required human gate precisely.
- [x] Prepare reviewed code, budget limits, private Standard bucket binding and production preservation baselines before requesting any required final checkout approval.
- [ ] Apply only the reviewed additive migration; deploy built Worker preserving all existing bindings/secrets.
- [ ] Trigger actual GitHub commits with a minimal JavaScript provenance marker for all three verification branches and verify six automatically published OTA bundles, hashes, signatures and app scope.
- [ ] Verify old rows/chunks/configuration unchanged, new binary chunk count zero, Runner health and free-tier usage; document remaining provider/device limits honestly.

## Current evidence (2026-10-17 08:51 KST)

Workspace build, root typecheck, final 55 tests and Wrangler 4.148.0 dry-run pass. The earlier affected regression run passed 120 tests (overlaps final selection). Independent review found no remaining source blocker. Cloudflare still returns R2-disabled code10042; the dedicated Chrome tab requires login. No remote migration, Worker deployment, bucket creation or GitHub verification commit has been performed. Actual six new R2 publications/downloads remain pending; existing six D1 manifests/signatures/downloads were verified. See `docs/development/r2-ota-storage-2026-10-17.ko.md`.

## Provider update (2026-10-17 09:05 KST)

User completed login; the correct account now shows the R2 subscription activation page. Due now is $0.00; monthly $0.00 plus additional usage. Activation also accepts terms and automatic renewal/usage billing, so action-time approval was requested before clicking. Login is no longer the blocker. No subscription or production mutation has been performed.
