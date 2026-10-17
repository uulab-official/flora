# Multi-app foundation implementation

The user approved implementing the multi-app foundation and testing two distinct repositories with isolated settings/history. Preserve the uncommitted authentication fix.

## Contract and scope

- Add an application registry keyed uniquely by repository identity and root directory. An app has an opaque ID, display name, creation time and versioned public CONFIG values. Source import automatically registers its app; an explicit registration API also supports an empty app.
- Preserve all existing snapshot IDs, canonical source data, digests, baseline bytes/digests, attempts and HEAD observations. Apply new additive migrations; never edit the checksummed original migrations or delete a database.
- Expose application selection, registration and settings through authenticated local and hosted APIs/UI. Filter revisions and enforce application ownership for snapshots, baselines, logs and cancellation. Shared access remains the existing single-owner boundary, not organization RBAC.
- Keep original import/profile contracts and blocked Runner behavior. Generic Expo detection, Vault, real builds/store/OTA and tenant membership are later work.

## Execution and ownership

1. Main: shared application types, service/API routing, UI/CLI integration and documentation.
2. Storage worker: local SQLite registry, additive legacy migration, request isolation and preservation tests.
3. Hosted storage worker: D1 registry, additive migration, scoped listing/cursors/log access and preservation tests.
4. Main: two-app end-to-end API/settings/history tests and UI switching/race verification; full build/typecheck/tests and independent review.

## Acceptance

- Two repositories register distinct apps in one store. Revisions, HEAD, baseline and requests remain app-scoped; settings changes in app A leave app B unchanged, including identical request keys.
- Stale settings versions and attempts to access another app's snapshots/logs/mutations are rejected.
- Legacy local/hosted rows migrate without changing payloads, identifiers, digests, receipts or terminal history. Re-running migration is safe and existing invariants/capacity accounting remain enforced.
- Switching apps clears old private selections and fences late responses. Existing single-app API clients continue working when no app ID is supplied.
- No remote deployment or private production database is touched.
