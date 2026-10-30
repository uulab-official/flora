# Hosted QA → Provider execution → Artifact delivery: verification gate (2026-10-30)

> Status: acceptance specification only. No production deploy, provider execution, artifact upload, or browser pass is implied.

## 0. Immutable boundaries

- Do not touch UULab production Cloudflare Worker/D1, existing OTA releases, signing credentials or runner recovery journals.
- Single-owner UULab demo remains single-owner. Open-source adopters use their own instance and own PC/Mac runner or opted-in third-party accounts.
- Browser QA uses isolated Miniflare and synthetic app/source data, real Chrome sandbox enabled, external requests blocked.
- No silent paid resources, cross-tenant SaaS, signing-key uploads, or execution of untrusted private repos on the public Flora repository's Actions.

## 1. Restore Hosted browser QA before release claims

- Enroll a new synthetic owner: assert transition to `/onboarding`; do not wait for legacy `/`.
- Register a synthetic app with real app ID, repository scope and selected project. Navigate through the **current app-scoped Source UI**, not removed Apps/Source split tabs.
- Resolve the current app-scoped flavor list and assert the actual rendered deployment cell `선택 앱 OTA에서 확인`, not `미연결`.
- Check source import, CSRF, retries, 11 flavors, Korean glyph render, keyboard navigation and reduced-motion against the actual DOM state.
- Replace timing-only sleeps with awaited app-specific readiness and stable state indicators. Never bypass Chrome sandbox, skip browser tests, or weaken isolation checks.
- Require passing actual hosted Chrome render workflow and the entire macOS/Ubuntu/Windows baseline CI on the proposed head SHA before merging. Do not declare success based only on synthetic DOM assertions.

## 2. External Provider execution (separate opt-in feature)

- Implement server-side registered provider adapters; manifest alone never grants execution permissions.
- Per-owner/per-app grants with explicit one-time permission, provider identity, estimated personal quota/cost, idempotency key, cancellable job ID and audit trail.
- Encrypted, rotatable minimum-scope credentials via user-controlled vault; no secrets in URL, logs, D1 records, frontend state, public GitHub Actions or copied commands.
- Fixed outbound endpoint allowlist; prevent SSRF and redirects to private addresses. Bound body size, timeout, retries, status polling and reconciliation; fail closed.
- State machine `unconfigured → authorized → queued → running → succeeded|failed|cancelled|unknown`. Never equate API 2xx, artifact existence, hash match or queued status to a signed, installable build.
- Retain local-only and private caller GitHub Actions workflows with no required Provider credentials or vendor costs.

## 3. Native artifact provenance and user-owned storage

- Default `local-only`. R2/S3 user-owned options require explicit opt-in and quota/cost notice.
- Bind each artifact to immutable app ID, job ID, repository, source SHA, runner ID, platform, byte count, SHA-256, signing-report fingerprint and storage reference.
- Store binaries only on local runner or opted-in BYOC bucket; D1 receives metadata only; do not put them in OTA SDK/assets.
- Use one-time/scoped presigned download, short expiry, least-privilege app authorization and download digest recheck. `hash match ≠ platform signature verification`.
- Reject path traversal, symlink/hardlink substitution, malicious MIME, cross-app lookup, oversized upload, duplicate with mismatched digest and unexpected signer.
- Record local artifact verification, platform signature verification and real device installation/OTA/rollback as independent evidence fields; never infer them from upload success.

## 4. Release evidence checklist

- [ ] Hosted Chrome sandbox flow passing on the **current** head SHA, with links to logs/run
- [ ] All OS CI passing on the same SHA
- [ ] App A cannot read App B sources, grant, logs, job or artifact
- [ ] Permission/credential revocation stops further provider actions
- [ ] local-only build/OTA remains functional without R2/S3/API key
- [ ] BYOC download size/digest verified, separate signing verification report
- [ ] Real Android APK/AAB and Mac signed IPA on representative private test apps
- [ ] Real device OTA apply and rollback validated
- [ ] Existing production Worker/D1/OTA unchanged

References: issues #3, #4 and #13; PRs #10, #11 and #12. Implementation must be tracked by commits and passing runs, not document checkboxes alone.
