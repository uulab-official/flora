# Subscription-free OTA storage

The user declined R2 subscription activation and explicitly authorized finding and connecting a free alternative, optionally PC storage, preserving existing data/history and verifying real GitHub/PC Runner automatic exports/publication/downloads for Isso, Promise and Reward on both platforms. EAS and Actions are excluded. This authorizes implementation and provider setup; no global Codex configuration edits or Flora repository commits are requested.

## Selection

Use a dedicated private GitHub repository, `uulab-official/flora-ota-assets`, with Actions disabled and no workflows. GitHub Releases explicitly supports software binaries with no total release-size/bandwidth limit (each file <2GiB, <=1000 assets/release). The PC builds and uploads using its existing host GitHub authentication. Existing GitHub App Contents-read access reads private release assets; its installation already covers all organization repositories. No App write permission, PAT creation, R2 subscription, PC public port, Tunnel or new billing plan is required.

Public Cloudflare Tunnel is unsuitable as the default free binary delivery contract: official public-hostname routing documentation requires a specific paid service for video and other large files. PC disk remains an optional private upload cache; downloads survive PC shutdown once GitHub storage is confirmed. Existing Cloudflare request/D1 limits and GitHub rate limits still apply.

Sources: https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases ; https://docs.github.com/en/rest/releases/assets ; https://developers.cloudflare.com/tunnel/concepts/routing/ .

## Preservation and authority

- Never rewrite/delete old D1 chunks, app settings, keys, deployment/jobs/transitions or recovery journals. SDK URLs/signing trust stay unchanged.
- The R2-only 0013 has never been applied. Generalize that pending migration to `0013_external_ota_assets.sql` and `ota_external_assets`, supporting provider-specific bounded completion proofs while retaining optional R2 adapter compatibility. Prove old 0001–0012 records/counters/schema preservation and atomic failure. No R2-only migration is applied first.
- New GitHub binary data never falls back to D1. A sticky configured storage mode fails closed if required configuration disappears. Legacy D1 downloads remain available.
- The Worker validates the current lease before storage verification; after asynchronous provider calls it rechecks identity and commits proof/metadata/attempt reference in the existing guard-first atomic D1 batch, accounting for elapsed time.
- Pin repository ID/name/owner, installation, release/asset IDs and deterministic tag in the proof. Later downloads use the pinned location, not a newly connected source repository. Never accept caller-supplied URLs or expose tokens/signed CDN redirects to SDK clients.

## Frozen upload protocol

Existing raw upload API remains. Existing D1/external digests return the normal asset response. Only a new digest without a provider reference returns HTTP428 `ASSET_STORAGE_REFERENCE_REQUIRED` after authorization. Only that exact response permits the optional host publisher to run; no fallback after unrelated errors.

After draft creation, one binary upload and release publication, the Runner repeats the original raw upload with `X-Flora-Asset-Reference`: base64url canonical JSON of EXACT `{schemaVersion:1,releaseId:<positive safe integer>,assetId:<positive safe integer>}`, bounded to1024 bytes. No URLs, credentials or repository selectors enter this header.

Release body is canonical JSON of `{schemaVersion:1,origin,appId,jobId,attemptId,commitSha,platform,asset:{digest,hash,key,contentType,fileExtension,size}}`; `hash` is SHA256 base64url. Tag is `flora-ota-v1-` + SHA256(canonical body), using existing `automationDigest`. Asset filename is `flora-<digest>.bin`, provider MIME `application/octet-stream`. Release targets the dedicated repository's own default commit, not the app commit; publish as prerelease with `make_latest:false`. Existing repository immutability is respected; Flora does not enable/change global repository immutability policy. Full content verification remains mandatory even if the provider release is mutable.

The host publisher uses no shell, fixed allowlisted GitHub endpoints, bounded subprocess deadlines/output, >=1050ms between mutations, deterministic reconciliation after lost replies, and no delete/overwrite/clobber. Claim/job/attempt/bytes are frozen and validated. Host GitHub credentials never enter Docker, source checkout, config output or logs. Private cache files use atomic safe writes and do not evict old application/user data.

The Worker independently checks private repository/release/asset membership, exact body/tag/name/digest/size and actual downloaded SHA256. It handles200 or302 with a manually validated GitHub CDN hop and removes Authorization across origins. Body length, time, in-flight reads and errors are bounded. Only verified published immutable OTA responses use the existing edge cache; no extra idle polling.

## Evidence

Separate local workerd/domain tests from actual deployment and downloads. After readiness/review, pause idle Runner intake, preserve private configuration/journals and D1 recovery bookmark, apply the single additive migration and deploy without R2 binding. Upgrade the host controller while retaining Docker image, existing tokens/policies, checkpoints and autostart.

Use minimal diagnostic JavaScript changes on the three existing verification branches (unchanged bytes would reuse D1 and fail to prove external storage). Verify six webhook-created jobs, new GitHub proofs with zero new D1 binary chunks, RSA manifest signatures and actual bundle SHA256 downloads. Compare every old raw metadata/history row and legacy download, and existing app/key/policy values. Verify zero Actions runs and no EAS invocation. Native application/restart is not inferred from download success.
