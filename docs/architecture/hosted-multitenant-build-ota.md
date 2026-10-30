# Flora Hosted SaaS: multi-tenant Build + OTA migration

> Implementation plan only. Not a declaration that multi-user login or tenant-isolated OTA has shipped.

## Principle

A hosted Flora account owns a membership in one or more organizations. Each application, GitHub installation, runner, signing secret, native build, artifact, OTA deployment, rollout rule, and telemetry row must be tenant-bound. Existing owner-only self-hosted installations continue working and are never silently converted to a public organization.

## Ownership / access model

User -> Membership(role: owner/admin/developer/viewer) -> Organization -> Project -> Application -> PlatformTarget -> Build / OTA Deployment.

Hard requirements:
- Every server-side read/write includes tenant+app scope; UI-selected app IDs and runner-reported IDs are never authorization.
- GitHub Login != GitHub App repository permission. Installation tokens stay short-lived, bound to explicitly approved repositories, and are never persisted.
- CI OIDC verifies issuer, audience, repository ID, owner ID, ref, workflow SHA, run ID, and app binding. Current single-owner managed CI sessions must not become global tenant sessions.
- App artifacts are immutable and scoped to tenant, app, commit, runtime, platform, signing profile, creator, and exact hash. A result cannot be reattached by guessing an ID.
- A runner chooses an organization and approved application set, supports revoke/lease fences, has no global secret read, and logs are redactable.
- Existing OTA public download endpoints may be unauthenticated but must verify app/channel/runtime plus signed immutable manifests; private management APIs are authenticated.
- Namespaces, storage paths, quotas, vault encryption AAD, audit logs, idempotency keys and rollback state must include tenant identity.

## Delivery stages (no big-bang migration)

1. Schema and tests behind feature flags: additive tenant and membership tables, owner-only legacy mapping, read-only reconciliation. No existing table rewrite or destructive migration.
2. Identity: email/password or external login, secure account recovery and sessions, CSRF/origin guard, team roles, invitation flows, rate limits. Keep legacy self-host auth untouched until cutover is tested.
3. GitHub: customer-approved installation selection and precise repo access. Separate read permissions from optional Actions:write; no blanket personal access tokens.
4. Native build: call the reusable workflow in **each private source repository**, not in Flora's public Actions context. For users without GitHub Actions quotas allow their own Mac/Linux/Windows runner; iOS requires macOS/Xcode. Observe run/job IDs and verify artifacts before marking complete.
5. OTA: preserve existing \`@flora/ota\` engine and device rollback, then add tenant-scoped signing keys, channel/runtime compatibility, per-tenant storage and limits, BYOC adapters. No auto migration or deletion of existing releases.
6. Store delivery: explicit separately authorized Apple/Google credentials, app signing checks, idempotent review/submission transitions, human confirmation for irreversible changes.
7. Rollout: synthetic adversarial cross-tenant tests, quota and cost caps, upgrade/downgrade/rollback rehearsals, and real private-project device pilots before enabling any hosted account.

## Negative tests required before public onboarding

- User A cannot list, enqueue, cancel, download, roll back, or read diagnostics for User B's app.
- A GitHub install revoked or repository deleted invalidates admissions and user-facing actions immediately.
- A stale attempt/lease or old OIDC run cannot finalize newer artifacts; webhook replay and credential rotation are rejected.
- A malicious branch/PR cannot obtain production signing keys; the app code and Runner are explicitly trusted when compiling.
- Tenant-isolated OTA asset URLs cannot serve any other app's bytes, even when digests overlap.
- Database restore, migration retry, rate limits, runaway builds and free-tier quota exhaustion fail without silently provisioning paid infrastructure.

## Existing source boundaries

- \`packages/cloudflare/src/auth-state.ts\`, \`auth-do.ts\`: existing single owner auth/state, must be migrated carefully.
- \`packages/cloudflare/src/managed-connections.ts\`: GitHub App installation/owner assumptions.
- \`packages/cloudflare/src/managed-ci.ts\`, \`github-oidc.ts\`: owner-specific OTA CI admission.
- \`packages/ota-runner\`, \`packages/ota-sdk\`: working job and signed OTA implementations to preserve.
- \`docs/architecture/control-plane-and-runners.ko.md\`: runner trust and lease/fence architecture.
- \`docs/development/reusable-expo-build.ko.md\`: initial private-caller native Actions implementation.

## Release gate

Do not claim multi-user support, general hosted GitHub Actions build orchestration or unlimited no-cost operations until these have actually passed migration, authorization, billing and real-app acceptance tests.
