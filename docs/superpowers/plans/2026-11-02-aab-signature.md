# AAB signature verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Execute each task with red/green evidence.

**Goal:** Bind actual AAB signature verification to local build completion and expose independent evidence.
**Architecture:** Existing Node local service + operator-owned recipe + fixed Java JarFile helper; SQLite artifact JSON metadata, no schema migration.
**Tech Stack:** Node 22/24 ESM, node:test, JDK 17+ standard APIs; no new npm dependencies.
**Spec:** docs/superpowers/specs/2026-11-02-aab-signature-design.md

## Global Constraints
Keep default execution/verification opt-in; no cloud credentials/production changes; no raw logs; no metadata-only success; preserve old unsigned replays and backup readability.

## Review Focus
Partial signing (including META-INF payload), stale/forged evidence, process timeout/abort, legacy replay compatibility, certificate mismatch and backup tampering.

## Tasks
- [x] Policy, fixed helper and bounded staging verifier. Tests first against real keytool/jarsigner fixtures; confirm failures, implement, rerun.
- [x] Integrate completion, recipe/preflight/runner and durable bound evidence. Test original fingerprint replay, wrong evidence and failed publication first.
- [x] Connect output/export/backup/UI and documentation. Test read-only evidence report and safe rendering; retain existing generic checks.
- [x] Fresh full artifact suite: 203 passed, no failures/skips. Five signature browser components and the existing nine checks passed.
- [ ] Publication gate: patch reapply and source/tree equality; CI/PR results recorded on the pull request. Keep Draft and report unverified full-monorepo/native/device gates.

## Execution ledger
- Baseline: extracted source from ddb51b6, 164 tests pass, Node 22.16.0/Linux.
- Full repository clone attempted: container DNS could not resolve github.com. Live reads/writes use connected GitHub; local changes stay in isolated extracted work branch.

- Real signing tests use ephemeral test keys only; no user signing key was accessed.
- Ruling: implement AAB JAR verification only; APK/IPA remain unverified rather than advertising adapters not exercised with platform tools.
- Review fixes: missing manifest entries, orphan signature metadata, diagnostic proof corruption and replay evidence mutation were reproduced RED then corrected GREEN.
- Browser regression: previous app artifact nodes were hidden rather than removed; test reproduced, handler now clears them immediately.
