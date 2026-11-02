# Local runner control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Implement inline with tests before implementation.

**Goal:** Integrate explicit local preset execution, managed cancellation, safe retries and app-wide status into the existing console.
**Architecture:** Operator-owned preset controller wraps existing runLocalBuild; existing SQLite transactions implement retry and overview; existing authenticated HTTP layer exposes bounded operations.
**Tech Stack:** Node built-ins, node:sqlite, vanilla browser JS; no new runtime dependencies.
**Spec:** docs/superpowers/specs/2026-11-02-local-runner-control-design.md

## Global Constraints
Keep execution opt-in; no browser-supplied commands, no automatic retry; no operating cloud changes. Linux/macOS local path. Keep memory and concurrency bounded. Never infer signing or install success.

## Review Focus
Duplicate requests across async preflight; stale job versions; cancellation/completion races; session/app switching with outstanding requests; operator config mutation and malformed/private paths.

## Tasks
- [x] Test and implement `service.retry({scope,newJobId,expectedVersion,idempotencyKey})` and `service.overview({appId})` in durable-build-ledger.mjs and local-build-service.mjs. Prove restart, conflicts and immutable lineage.
- [x] Test and implement `createBuildController({directory,presets,appIds,maxConcurrent})`: list, start, stop, state, close. Snapshot presets; pin runner expectedVersion; await real process termination.
- [x] Test and integrate console HTTP `/api/presets`, `/api/overview`, job `/execute`, `/execution`, `/stop`, `/retry`; explicit CLI config, safe shutdown, no legacy behavior changes.
- [x] Extend console actions, confirmation dialog, runner status, retry linkage, scoped totals and diagnostic messages; run asset and real HTTP integration tests.
- [ ] Review changed code, run all extracted tests, attempt whole-repo check, publish verified blobs to existing PR16 branch (no main merge), document exact evidence and outstanding gates.

## Execution ledger
Baseline: 92 pass, 0 fail, 0 skip on Linux Node 22.16.0. Source snapshot from attached PR16 package; remote head confirmed 29662c37d6490b2bc8101d2015892e74457b6bff. Prior Foundation Linux/macOS/Windows passed remotely. No full repo checkout available in runtime (network DNS unavailable); do not equate extracted checks with full monorepo checks.

Ruling: added app-wide SQL search/status filters — page-local filters would be misleading beside app-wide totals — no schema change.
Review: corrected lost-claim ownership rewrite and UI lost-response request-key regeneration using failing then passing tests. 115 extracted tests pass. Live browser blocked by admin policy; synthetic component-only test passes, no external requests or page errors. Publication remains conditional on fresh head and blob verification.
