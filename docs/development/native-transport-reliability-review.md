# Native transport reliability — inline review

Base: 6873fa27e19e81e60bb32cf7d2238a2e897a0331. This is an inline self-review, not independent review.

Reviewed the complete modified client and new request utility after tests. No route/server change, no mutation retry, no sandbox relaxation, no credentials in errors. Own lease data is snapshotted; configuration capture prevents identity substitution after construction. Observed HTTP rejection survives body cancellation/malformed JSON, and only exact 409/BUSY remains retryable by the pre-existing upper layer.

The request timer records its initial reason instead of deriving it from a possibly earlier wall clock. Monotonic elapsed time rejects late successful responses, and a forward wall clock reaching the original lease rejects them too. One deadline covers fetch plus every body read. Each wait handles both late resolution and rejection; its abort listener is removed. Final request cleanup removes the timer and caller listener. Body cleanup is best effort and never awaited indefinitely.

During review, replaced retained per-chunk buffers with bounded growing storage: an attacker-controlled number of tiny chunks must not multiply retained object overhead beyond the body byte budget. Existing boundary tests remained green and a fragmented UTF-8/tiny-chunk case was added.

Evidence: 12 contract failures on the original SHA-verified native-client file; 54 selected tests green after changes (including real HTTP). Artifact regression: 203 green, no failure/skip. Local selected TS compilation uses repository strict switches but an available older toolchain; pinned runtime and whole-monorepo CI remain authoritative.

Residuals: cancellation cannot prove remote rollback. An async transport ignoring abort may keep its own resource alive, though the client settles and disposes late responses. A synchronous event-loop-blocking transport cannot be preempted. Native controller/daemon methods outside heartbeat have not all been changed to pass optional signals. No native-device/OTA/Hosted-browser claim. No independent reviewer available in this session.
