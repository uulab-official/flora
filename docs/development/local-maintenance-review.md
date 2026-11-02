# Local maintenance inline review

Base: d8a4e2c5cb4fac384b2dffa07cdfbe4de23b64a1. Separate independent reviewer unavailable; this is not an independent approval.

- Reproduced and fixed scope omission: doctor previously ignored appId, exposing other app counts/findings if reused by a scoped API.
- Reproduced and fixed the 100-artifact inventory cap: bounded keyset iteration now checks beyond page 1 and reports partial results.
- Reproduced and fixed read-only completion publishing a file before rejecting the ledger mutation. The service now rejects before IO.
- Reproduced and fixed empty-backup verification accepting a file where the artifacts directory should be. Validate entry types as well as names.
- Confirmed stale diagnostic UI responses are discarded on app switch; snapshots are timestamped, not live process evidence.
- Backup/restore require new private targets, preserve source, validate schema and file binding, and never include runtime credentials/locks. Unknown states are preserved; active/authorized/queued snapshots are refused.
- A digest is not publisher authentication. Restore is local-owner-only and for trusted snapshots. No ZIP extraction, arbitrary SQL import or browser-provided paths.
- Keep Draft: native build/signing/device/OTA and Hosted integration are not exercised by these tests. Actual localhost browser navigation was blocked by managed policy; offline component checks are separate.

Verification: baseline 115/0/0; final related tests 139/0/0 on Linux Node 22.16.0; actual CLI round trip and HTTP scope/CSRF/limit tests included. Remote CI must be associated with the published SHA, not an earlier head. Full local npm test stops at missing pnpm in the extracted snapshot.
