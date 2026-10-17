# R2 OTA asset storage

The user authorized separating OTA assets into R2, retaining existing data and history, and proving automatic GitHub/PC Runner publication and downloads for Isso, Promise and Reward on iOS and Android. EAS and GitHub Actions are excluded.

## Storage and authority

- Keep every existing D1 asset, chunk, deployment, application setting, credential and history row unchanged. Legacy published URLs continue to serve verified D1 bytes.
- New assets use the private `FLORA_OTA_ASSETS` R2 binding, with immutable owner/application/SHA-256 object keys. No public bucket, S3 credential, new SDK URL or signing-key change is needed.
- An additive D1 migration records bounded immutable R2 completion proofs. Asset metadata and proof are committed in the existing lease-guarded transaction only after R2 checksum/size verification. Publication completeness accepts complete legacy chunks or the exact external proof.
- Configured R2 failures never fall back to D1 binary uploads. Missing, corrupt, unpublished and cross-application assets fail closed. Retry cannot overwrite a different object or claim an unconfirmed publication.
- Old app-local D1 byte/count limits must not reintroduce the same small R2 history limit. New R2 reservations have their own bounded global storage/object limits; normal publication uses requested asset-ID lookups rather than scanning a retained asset list.

## Free-tier and query protection

Use Standard storage only. Before R2 calls, persist atomic reservations in the existing owner AuthDO: at most 8GiB of stored/reserved bytes, 4096 objects, 100,000 Class A operations and 1,000,000 Class B operations per UTC calendar month. Failed/unknown calls consume operation credits; possible orphan objects retain storage reservations. No refund based on an ambiguous timeout. Budget exhaustion blocks calls rather than changing billing plans.

These limits govern Flora-controlled access, not other account buckets, console/S3 writers or manual billing changes. Check the dedicated bucket and account context before activation. Cloudflare's initial subscription/checkout is a provider gate; do not accept new legal/payment terms without the required user action-time approval.

Cache only verified immutable public asset responses at the existing Worker edge. Admit origin, method and route first; keep app/digest keys isolated. Never cache manifests, private pages, errors or session-dependent responses. Budget enforcement remains authoritative on misses; caches introduce no polling.

## Verification

Use Node 24.19.0 and pnpm 11.19.0. Test actual workerd/D1/R2/Cache API behavior: legacy reads, complete new uploads, corruption, idempotency, concurrent reservations, monthly rollover, restart persistence, stale lease/auth, orphan accounting, publication completeness and app isolation. Test failures before implementation. Review the security and cost boundaries independently.

Before production changes capture account/Worker/D1/DO identities, bindings, recovery state, application configuration and immutable history. Apply only the additive migration and preserve existing bindings and secrets. After activation/deploy, issue minimal JavaScript provenance-marker commits on the three existing verification branches, verify six webhook-created jobs and OTA manifest/bundle hashes, and prove zero new D1 binary chunks. Compare old raw rows unchanged. Do not report new native device application or restart from publication/download evidence.

Unchanged-tree commits can reuse existing D1 digests and therefore do not prove new R2 storage. Use an inert app-specific diagnostic marker in each verification branch entrypoint so all six launch bundles require new verified R2 objects. Keep native configuration, dependencies, app features, production branches and credentials unchanged.

## References

- https://developers.cloudflare.com/r2/pricing/
- https://developers.cloudflare.com/r2/get-started/
- https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- https://developers.cloudflare.com/r2/reference/consistency/
