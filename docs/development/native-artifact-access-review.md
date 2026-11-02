# Native artifact access inline review

No independent reviewer was available; this is a self-review, not a security audit.

Reviewed: existing receipt writer contract, app/platform/pinned certificate association, no network execution in read-only modes, descriptor identity, bounded metadata and streaming, exclusive output commit, shutdown semantics, safe reports, existing command compatibility.

Found and reproduced:
1. Failed exclusive creation could clean up a pre-existing random temporary name. New collision test failed with deleted file; ownership is now acquired only after a successful open.
2. Replacing the temporary pathname during copy could publish the replacement before noticing its size mismatch. New replacement test failed; descriptor/path inode and metadata are checked before publication, and cleanup preserves a replacement it does not own.
3. Strict test typecheck exposed contravariant generic inference in the command integration fixture. Explicit configuration type supplied; no any/casts weakening production checks.

Additional checks: same-size tamper, original receipt changed mid-copy, cancellation after temp creation, concurrent no-replace export, iOS/AAB extension handling, record and directory caps, FIFO/no-follow/privacy, private metadata omission. Native controller and cryptographic signing code unchanged.

Limitations: private-owner filesystem trust, no atomic multi-process coordinator, no fresh remote proof/signature/install, no malicious same-UID race guarantee, no hard kernel-I/O preemption, no Windows ACL support, no independent review or production deployment. Actual CLI checks run in remote full-repository CI because local extraction lacks native-controller dependencies. CI observations are reported in the PR after execution, not guessed here.
