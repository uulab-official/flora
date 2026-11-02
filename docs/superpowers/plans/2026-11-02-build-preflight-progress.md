# Build preflight and progress implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Execute inline with regression evidence.

**Goal:** Connect read-only readiness and raw-log-free progress to the local build flow.
**Architecture:** Shared preflight checks, existing controller/service/audit, opt-in recipe limits, same loopback API/UI.
**Tech Stack:** Node.js builtins, SQLite, HTML/CSS/modules.
**Spec:** docs/superpowers/specs/2026-11-02-build-preflight-progress-design.md

## Global constraints
Keep default execution-off; no production changes. No credentials/paths/raw logs in public output. Recheck before execution; no readiness implies build success. Retain job version CAS and cancellation ownership. No schema migration.

## Review focus
Input mutation across await; stale job/version/app responses; subprocess error/abort and output limits; progress callbacks affecting execution; backup/audit compatibility.

## Task 1: shared preflight
- [x] Add failing real-checkout tests for ready, stale/mismatched context, dirty source, missing/nonexecutable tool, output/lock presence, no side effects, immutable input.
- [x] Extract recipe/source checks; implement read-only preflight and runner rechecks; run tests.
## Task 2: progress and durable stages
- [x] Add failing tests for byte counters, no secret content, stage ordering, observer exceptions, configurable output limit and persistent audit.
- [x] Add bounded telemetry and audit progress API; integrate runner/controller; run existing suite.
## Task 3: API/CLI/UI
- [x] Add failing HTTP auth/CSRF/scope/rate-limit tests and CLI checks.
- [x] Connect preflight route, execution dialog check, numeric activity panel and stage labels; retain stale-response guards.
- [x] Test HTTP actual execution/download, static UI and browser component interaction.
## Task 4: review and publication
- [x] Inline code review (not independent); fix and regression-test findings.
- [x] Run complete related suite, attempt monorepo command, check diff and clean patch reapplication.
- [ ] Match changed baselines/blobs to remote; publish to existing PR branch without force/merge; inspect CI.
