# GitHub Release OTA storage implementation

Goal: subscription-free private OTA storage with the current PC Runner, unchanged SDK URLs and preserved history. Execute the user's authorized connection/testing request; preserve dirty work and do not recursively delegate or commit Flora source.

Spec: `docs/superpowers/specs/2026-10-17-github-release-assets-design.md`.

## Backend — deep worker

- [x] Generalize undeployed0013/proof interface while keeping legacy D1 and optional R2 support.
- [x] Red/green tests for GitHub exact-reference protocol, metadata+actual binary verification, scope/redirect/size/time limits, sticky configuration and stale/revoked/expired lease failures.
- [x] Implement existing App Contents-read provider and AuthDO wiring; no new provider secrets, no binary fallback or idle polling.
- [x] Verify three app/two-platform separation, old record preservation, mixed old/new rollback and bounded requested-ID lookups.

## PC publisher — routine worker

- [x] Add optional strict host publisher configuration and exact428 negotiation in client; preserve default client/recovery behavior.
- [x] Draft→upload→publish per new asset through existing host `gh` authentication, deterministic reconciliation, safe private cache and bounded rate/deadline/error handling.
- [x] Red/green tests for claim binding, incorrect responses, unknown upload/publication outcomes, retries, no credential leakage and preserved config/recovery behavior.

## Root — provider, rollout and evidence

- [x] Compare official free-storage contracts and verify existing organization-wide read installation and host push access.
- [x] Create private dedicated repository, disable Actions, prove existing App can read without permission expansion.
- [x] Independently review implementation, build/typecheck/affected tests and deployment dry-run.
- [x] Refresh exact production identities, settings/history/chunk baselines, idle/recovery state and D1 bookmark; keep backups private.
- [x] Apply one migration and deploy preserved bindings/variables plus provider configuration; upgrade/restart existing host controller with autostart intact.
- [x] Real branch commits for Isso·Promise·Reward; observe six automatic publications, external proofs, signed manifests and verified actual downloads.
- [x] Compare preserved data/keys/history and zero new D1 chunks; verify legacy downloads, no Actions/EAS, healthy Runner and document evidence/limits.
