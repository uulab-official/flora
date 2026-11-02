# Local maintenance implementation plan

> **For agentic workers:** Use superpowers:executing-plans. Continue inline under the user's repeated execution instruction.

**Goal:** Owner-controlled recoverable local build state with safe diagnostics, verified backup and fresh-directory restore.
**Architecture:** SQLite online snapshot, bounded manifest/file validation, existing verified artifact copy; per-app service/API/UI diagnostics. Existing storage schema remains v1.
**Tech Stack:** Existing Node ESM, node:sqlite, node:test, HTTP and vanilla console.
**Spec:** ../specs/2026-11-02-local-maintenance-design.md

## Constraints / review focus
No production changes, no credential export, no remote execution. Digests are not signatures. Independent review is unavailable; perform an explicit inline review and report that boundary.
Test active snapshots, untrusted paths/symlinks, interrupted output, mutated backups, cross-app diagnosis and bounded inventories.

- [x] 1. Scoped bounded diagnostics: failing isolation/>100/budget tests; inventory pagination, scoped database counts and storage walk; read-only ledger mode/incomplete markers; retest.
- [x] 2. Backup/verify/restore: failing round-trip/non-overwrite/tamper/active-state tests; native online snapshot and verified artifact copy with fresh-target guard; retest.
- [x] 3. CLI/API/UI: failing command and HTTP scope/CSRF tests; CLI explicit maintenance commands; no HTTP path/backup import; diagnostic UI scoped epoch handling; retest.
- [ ] 4. Review, regression, package: inspect diff, test critical boundaries, run full related suite and full repo attempt; verify upload blob hashes; keep Draft and report actual CI evidence.

Execution: related suite 139 passed, 0 failed, 0 skipped. Full local npm test attempted: pnpm missing. Browser localhost blocked by policy; sandboxed offline component assertions passed separately. No independent reviewer. Remote publication and current-head CI recorded in PR comments after upload.
