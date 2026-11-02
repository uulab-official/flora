# Local operations recovery design

## Intent
Extend the existing owner-only local console with scoped storage diagnostics and verified, private backup/restore. Keep the tested execution/stop/retry path; never touch production Cloudflare, D1, OTA, signing keys or paid providers.

## Approach
Use SQLite's online backup API, then verify/copy exactly the artifact inventory in that snapshot. Do not copy a live database as an ordinary file. A backup is a new private directory containing a snapshot state and a digest manifest, not an arbitrary ZIP/executable import. Restore only into a NEW directory; reject existing targets. Use an incomplete marker throughout creation; neither an incomplete backup nor restored state may be opened as an operational ledger. Copy no sessions, runner locks, recipes, private keys, logs or credentials. Digest evidence is not origin authentication or code signing.

Snapshot validation rejects authorized/queued/running work. Unknown results can be preserved, clearly marked as requiring reconciliation, and never auto-run. The source may continue changing after a consistent snapshot; the backup is a point-in-time view, not a current-state promise. The source must remain owner-controlled; POSIX private-directory checks are not same-user isolation.

## Diagnostics
Expose bounded, explicit, CSRF-protected per-app diagnostics. Database structure integrity is global but counts, job IDs and storage findings are app-scoped. Hashing is not run on every UI poll. Mark incomplete scans, active jobs and uncertain outcomes honestly. Preserve files: no GC, no lock deletion, no automatic recovery mutation.

## Boundaries and alternatives
Chose offline CLI backup/restore plus web diagnostics over web full-instance export because the console app allowlist must not expose other apps or local filesystem paths. Chose fresh-target restore over in-place restore to avoid overwriting live history. Existing hosted integration and native signing are separate unverified work.

## Acceptance
Round-trip audit/idempotency/lineage and artifact bytes; non-overwrite; tamper/link/partial/schema/limit rejection; snapshot active-state rejection; app isolation; >100 artifact scan; CLI independent processes; real HTTP diagnostics; existing suite remains green. Browser proof and whole-monorepo CI are separately reported.
