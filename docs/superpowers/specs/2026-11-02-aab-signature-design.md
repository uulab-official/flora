# Local AAB signing verification

## Intent
Extend the existing local build path with an independently computed Android AAB JAR-signature gate, not another user-supplied success boolean. Verification is opt-in through the operator-owned recipe. The UI must distinguish byte integrity, expected upload-certificate signing, native bundle validity, Play acceptance and device installation.

## Approach
Use the installed JDK 17+ JarFile verifier against a private, digest-checked staging copy. Read every non-directory entry fully, require signatures for all payload (including non-signature META-INF content), require exactly one signer with the pinned SHA-256 leaf certificate, and check certificate validity/key use. No extraction, network, private key or keystore is used by verification. Fixed entry/expansion limits and process time/output limits fail closed.

Alternatives considered: parsing human-readable jarsigner output is brittle and can accept partially unsigned files; APK apksigner is a different format and not an AAB verifier; a new remote service conflicts with owner-local/no mandatory server costs. Chosen approach is an implementation decision under the user's continuing instruction to proceed.

## Data and integrations
Optional recipe signaturePolicy: scheme=aab-jar-v1, javaExecutable (absolute), expectedSignerSha256 (lower-case 64 hex). Supported only for android/aab. Preflight checks the configured tool's presence but does not claim a valid signature. Build completion independently runs the verifier, binds bounded evidence to exact bytes and expected certificate, then atomically stores it with artifact metadata and the job transition. Unsigned legacy completion fingerprints remain unchanged. Signed replay binds the expectation, and cannot upgrade an old unsigned receipt. Replayed completion must still validate stored bytes.

Job-level signatureVerified remains false: there is no general platform signing certification. Artifact-level signatureVerified and signatureEvidence describe only this AAB signature observation. Export, UI, HTTP detail, JSON evidence and backup/restore retain those bounds. Generic installVerified remains false.

## Non-goals and safety
No production deploy/main merge, external build account, private key handling, APK/IPA verification, certificate-chain/OCSP/TSA attestation, bundletool validity, compiled Android application or device install claim. Default recipes are unchanged. Trusted local owner tooling remains the trust boundary; neither JVM nor runner is advertised as an untrusted-code sandbox. Backup digests remain integrity, not authenticated provenance.

## Acceptance
Real temporary JDK-signed fixtures pass; unsigned, wrong signer, unsigned additions, same-size tamper, malformed paths/layout, duplicate entries, expiry, wrong policy and broken evidence are rejected. Verify -> publish -> restart -> export -> backup -> restore preserves exact evidence. Raw helper output/paths/private key material never enter the API. Tests cover failed verification and cancellation without successful artifact publication. Full existing suite remains green. CI pins Java runtime separately from Node.
