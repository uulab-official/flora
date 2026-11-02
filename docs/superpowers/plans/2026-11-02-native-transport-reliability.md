# Native transport reliability implementation plan

> Execute inline with superpowers:executing-plans. Test failures precede implementation.

**Goal:** Repair native heartbeat CI and bound every native management request without replaying writes.
**Architecture:** A small per-request deadline/response utility plus the existing client; same endpoints and wire shapes. The client owns scope/input, the utility owns timing and cleanup.
**Tech Stack:** TypeScript, Node HTTP/fetch/AbortController, node:test. No new dependencies.
**Spec:** docs/superpowers/specs/2026-11-02-native-transport-reliability.md

## Constraints
- Remote baseline 6873fa27e19e81e60bb32cf7d2238a2e897a0331; no main merge/deployment.
- Request budget stays 20s; successful JSON <=4MiB; no retries of mutations.
- Keep wire schemas and HTTP status diagnostics compatible.
- Local subset Node22/TypeScript5.8; remote pinned Node24 CI decides full compatibility.

## Review focus
Frozen/backwards clock at timeout; fetch/reader ignoring abort; revoked HTTP status with broken body; mutable caller credentials/scope; late response after abort.

## Tasks
- [x] Record baseline failing tests for clock classification, blocked fetch, authority and immutable config.
- [x] Implement deadline utility and strict bounded response handling; run red/green tests.
- [x] Integrate optional signals and fixed schema/error validation on all client methods.
- [x] Exercise real loopback HTTP, delayed headers/body, no-retry mutation and cleanup; repeat boundary tests.
- [x] Run artifact regression suite, selected TS strict checks and diff/self-review.
- [ ] Publish verified tree on current feature branch with expected SHA and inspect new-head CI.
- [ ] Package patch, reports, reproducible tests and limitations.
