# Native artifact access design

Continue the existing native Runner product: after a build, an owner must list recorded outputs, inspect exact bytes and export a verified copy without manually trusting filenames or deleting recovery markers.

## Decision
Add offline `--artifacts`, `--inspect FILE_NAME`, and `--export FILE_NAME --output /absolute/private/file` modes to the real native CLI. Reuse the existing private native configuration reader. Do not instantiate an HTTP client, run recovery mutations, or invoke compilers/signers for these modes. These modes remain available while unresolved completions block new builds.

A bounded directory catalogue projects only validated app/platform/pinned-signer receipt data. Metadata is explicitly historical and integrity is not checked by listing. Inspection and export stream a private regular source file from one descriptor, bound to a stable private receipt, verify size/SHA256, and recheck file identity. Export publishes an exclusive private temporary copy by a no-replace link, never overwriting a destination. A post-publication durability error is an unconfirmed export, not cancellation or rollback.

## Limits / trust
Node runtime and TS versions remain repository-pinned; no new dependencies. POSIX owner/mode semantics only; Windows rejects these filesystem operations explicitly. Directories canonical 0700, files canonical owner 0600, no symlinks/hardlinks/special files. Maximum receipt128KiB, binary512MiB, directory1024 entries, catalogue200 receipts. Truncation and invalid/pending records remain visible, not falsely healthy. Source and destination parents must already exist; no implicit chmod, mkdir, deletion or recovery. Parent path must be canonical; private directory ownership is the trust boundary against other users, not a sandbox against this same OS user. Reports exclude config paths, token, raw receipts and entitlements. Local completion receipt is not cryptographic or current remote confirmation; SHA256 is not fresh code-signature verification or installation evidence.

## Acceptance
Actual CLI modes, strict parse before I/O, zero control-plane HTTP even with pending files, malformed metadata fail closed, all scope/hash/link/permissions/size tests, no-overwrite/cancellation cleanup, existing native session tests retained. Run fast multi-OS build/typecheck with POSIX filesystem tests. Preserve main, cloud deployments and signing credentials.
