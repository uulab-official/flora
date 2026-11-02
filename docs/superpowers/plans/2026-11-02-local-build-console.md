# Local Build Console Implementation Plan

> For agentic workers: use superpowers:executing-plans. Continue inline without repeated approval prompts; the user has repeatedly requested execution.

**Goal:** working local UI/API/download/runner flow on the persistent build service.
**Architecture:** Node HTTP server + static assets + existing SQLite/file services. CLI-only trusted runner executes explicit local recipes; HTTP can queue but cannot execute arbitrary input.
**Tech Stack:** Node built-ins, SQLite, vanilla browser JS/CSS.
**Spec:** docs/superpowers/specs/2026-11-02-local-build-console-design.md

## Global constraints
No production deployment; no paid provider execution; no raw credentials/absolute paths in web responses; signing/install evidence stays false; private POSIX state; Node 24.19 target.

## Review focus
Cross-app ticket reuse; replay/concurrent actions; expired sessions; output mutation and interrupted streaming; process cancellation versus truthful state; UI XSS and stale responses.

## Tasks
- [x] 1. Write HTTP/auth/download tests, observe failures, implement scoped server and CLI startup; test real SQLite and local sockets.
  Files: scripts/artifacts/build-console.mjs, build-console-server.mjs, build-console-server.test.mjs.
  API: startBuildConsole({directory,appIds,port=0,approvalCode,now=Date.now}) -> {origin,close}; no credentials returned to HTTP.
- [x] 2. Implement accessible static console wired to API, pagination/action conflict/error states; add asset contract and browser checks.
  Files: scripts/artifacts/console/index.html, console.css, console.mjs.
- [x] 3. Write trusted runner tests, observe failures, implement one-shot explicit recipe execution with source verification and bounded process lifecycle.
  Files: scripts/artifacts/local-build-runner.mjs, local-build-runner.test.mjs.
- [x] 4. Test end-to-end queue -> actual fixture process -> persistent success -> HTTP verified download; run all related tests and attempt full repository test.
- [ ] 5. Self-review, package reproducible incremental/cumulative patches, publish exact tested source to isolated GitHub branch/PR when tool writes succeed. Check remote SHAs, do not merge or deploy.

## Execution ledger
- Baseline: 63/63 tests passed on Linux Node 22.16; extracted working tree based on cd91a87 + previous patch.
- Ruling: implement loopback console instead of claiming hosted integration; local bytes cannot be served by a remote Worker without a separate transport.
- Ruling: no subagent tool is available, so perform review and adversarial tests inline and disclose lack of independent review.

- HTTP and runner tests were observed failing before implementation, then passing. Final related suite: 92 pass, 0 fail, 0 skip on Linux Node 22.16.0. Full `npm test` attempted: pnpm unavailable.
- Live browser navigation blocked by managed URL policy (`ERR_BLOCKED_BY_ADMINISTRATOR`); sandbox not weakened. Offline Chromium component rendering with synthetic fetch fixtures passed desktop/mobile overflow, detail, audit and dialog checks. This is not live browser E2E.
- Self-review added persisted allowlisted failure codes, same-buffer-safe HTTP streaming and disconnect cleanup tests. The actual HTTP create/authorize/queue -> child process -> durable success -> verified download path passed.
- Publication is staged through Git tree objects on a new branch; branch-head/PR confirmation and file-hash comparison are recorded in the delivery evidence, not assumed from object creation.
