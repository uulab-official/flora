# Native Artifact Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Connect native output listing, byte verification and safe export to the existing CLI.
**Architecture:** Isolated typed filesystem service consumed by the command/session orchestrator; existing execution clients and controller unchanged.
**Tech Stack:** TypeScript, Node fs/crypto/test, existing CI.
**Spec:** docs/superpowers/specs/2026-11-02-native-artifact-access.md

## Global Constraints
No production deployment, no remote mutation or new dependencies; pinned repository toolchain unchanged. Local source is an extracted subset, not the full workspace.

## Review Focus
- Unconfirmed or foreign-app receipt must never authorize export.
- Malformed metadata and unexpected directory contents must not leak private data or look healthy.
- File/receipt changes during inspection must reject; no pathname-only hash/copy gap.
- Existing destination, cancellation, failure after publication must preserve correct ownership and uncertainty.
- Artifact command must not trigger presence, recovery mutation, claim, compiler, or signer.

## Task 1: Artifact catalogue and byte access
- [x] Write failing tests for typed service API and filesystem boundaries.
- [x] Implement packages/ota-runner/src/native-artifact-access.ts.
- [x] Run dedicated tests and add edge regressions.

## Task 2: Real native CLI integration
- [x] Write failing command tests before modifying native-command.ts.
- [x] Add closed parse modes, result union and safe errors; wire native-main.ts.
- [x] Add actual native CLI subprocess tests and extend fast CI.
- [x] Preserve existing90 transport/session/command tests and203 artifact tests.

## Task 3: Delivery
- [x] Inline code review (no independent reviewer tool available), fix findings.
- [ ] Reapply exact patch to clean baseline, verify changed blob hashes.
- [ ] Push feature branch with expected previous SHA, retain Draft PR.
- [ ] Record actual CI and environment limitations; package patch and evidence.

Execution note: local extracted source compile and tests passed; actual native CLI/full-repository runs are delegated to CI, not claimed as local executions. No independent review tool is available.
