# App Credential Registry Implementation Plan

> **For agentic workers:** Use the current approved automatic routing with bounded workers and no recursive delegation. Implement the tasks below with TDD; root integrates, reviews and deploys.

**Goal:** Register and manage app-scoped certificates, Google and push credentials securely in Flora, preserving existing keys/data and publishing the verified UI/API to Cloudflare.

**Architecture:** Existing owner DO adds envelope-encrypted immutable credential versions, independently versioned app/kind bindings and metadata-only audit events. Root integrates session/CSRF/fences and the hosted management UI. Existing OTA Runner credentials gain no new authority.

**Tech Stack:** TypeScript, Cloudflare Worker/SQLite DO, native Web Crypto, existing Node 24.19.0 and pnpm 11.19.0/workerd test harness; no new dependency.

**Spec:** ../specs/2026-10-14-app-credentials-design.md

## Global Constraints

- EAS/Actions absent; use existing Cloudflare resources and PC Runner.
- Existing keys, certificates, app settings, connections, automation policies and history remain intact.
- No credentials in public settings, logs, list/history responses or browser storage; no raw export endpoint.
- Request <=1,500,000 bytes; file <=1MiB; PEM/Google JSON <=64KiB; stored encrypted payload accounting <=4MiB/app, <=16MiB/owner; <=20 versions/app/kind.
- Metadata status represents actual validation only, never provider authorization or a successful build/push.

## Review Focus

- Other-app credential IDs and stale expectedVersion fail without changing the original binding.
- Session revocation during asynchronous read/crypto cannot commit a candidate.
- Malformed/oversized/password-bearing files leave no raw material in responses/history.
- Late responses and file-reading completion after app switch cannot render or submit to the wrong app.
- A missing/wrong KEK or disabled credential fails closed while existing OTA/GitHub remain usable.

---

### Task 1: Typed credential import validation

Files: create credential-types.ts, credential-validation.ts and credential-validation.test.ts in packages/cloudflare.

Interface: validateCredentialImport(unknown):Promise<ValidatedCredential>; parseCredentialKind(unknown):CredentialKind. ValidatedCredential contains kind,label,safe metadata,payloadJson,byteLength,verification,fingerprint,expiresAt. Root/registry consume it; payloadJson never leaves the owner authority.

- [x] Write/observe failing tests for generated APNs/ASC keys, Google service account identity conflicts, binary pending validation, strict unknown fields/limits and Firebase public configuration.
- [x] Implement bounded exact-schema parsing and crypto validation; no provider calls.
- [x] Run focused tests and report RED/GREEN evidence.

### Task 2: Envelope encryption and immutable registry

Files: create credential-vault.ts and credential-vault.test.ts. Root owns contracts/env integration.

Interface: CredentialVault(storage,keyring,config); list(appId,fence); import(appId,input,actor,fence); disable(appId,kind,expectedVersion,actor,fence). Public result matches the spec. Root verifies D1 application ownership before these calls.

- [x] Write/observe failing storage tests: two apps/rotation histories, CAS, corrupted AAD/ciphertext, missing KEK, fixed payload accounting and transaction/fence failures.
- [x] Implement additive tables, per-version envelope encryption, metadata-only lists/history and atomic binding updates.
- [x] Verify ciphertext contains no private key/password; retained legacy tables unchanged and restart persists new records.

### Task 3: API admission and UI

Root files: http.ts, auth-do.ts, contracts.ts; credential HTTP workerd tests/fixture. UI worker files: public/index.html, public/app.js, public/app.css and focused credential-ui.test.ts.

- [x] Add failing HTTP tests for unauth/CSRF/other-app denial, isolated imports/rotation/disable, missing KEK and existing Runner denial.
- [x] Integrate explicit app existence/authority fence and bounded body handling; map fixed safe errors only.
- [x] UI worker adds file upload/type metadata/password fields, separate version/history cards, clearing on app switch/logout and stale-response guards.
- [x] Verify UI tests for pending file read, unknown outcomes requiring refresh, app isolation and no secret persistence.

### Task 4: Verification and existing-host deployment

- [x] Root reviews security boundaries, runs focused workerd and full pnpm check, and confirms diff check.
- [x] Capture existing production app state/operations/automation and key trust metadata via read-only APIs.
- [x] Generate a KEK key ring without printing it; store protected operator backup outside checkout and upload through documented Wrangler secret input preserving all existing bindings.
- [x] Dry-run and deploy existing flora-uulab Worker; no D1 migration/resource replacement.
- [x] Check actual HTTPS/production UI registry for two existing apps and compare preserved state/history/trust metadata. Production imports only owner-supplied real keys; synthetic isolation/rotation is verified locally.
- [x] Record completed tests/deployment and distinguish stored credentials from real native signing/provider/push verification.
