# Native Runner Session Shutdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** End native Runner HTTP activity promptly on operator shutdown without hiding ambiguous completion or starting new work.
**Architecture:** Optional immutable client lifetime plus separately testable CLI/session orchestration; reuse actual native controller unchanged.
**Tech Stack:** TypeScript, Node built-ins, existing Node24.19.0/TS5.9.3 CI.
**Spec:** docs/superpowers/specs/2026-11-02-native-session-shutdown.md

## Global constraints
No cloud writes, keys, dependencies, route formats, signing isolation, automatic retries, production deployment or main merge. Preserve unscoped library callers. Local TS5.8.3/Node22.16 checks are not whole-workspace validation.

## Review focus
Completion ACK lost during stop; per-method signals masking shutdown; late config result; pre-aborted mode/empty daemon; listener/resource leaks; cross-session interference; verified completion followed immediately by shutdown.

## Tasks
- [x] Reproduce missing default cancellation in all HTTP methods; add client lifetime and composition; run old/new transport tests.
- [x] Add failing session admission/setup/shutdown/unknown-outcome tests; implement native-command and wire native-main, with help and fixed status/exit output.
- [ ] Test real POSIX native CLI SIGINT/SIGTERM during presence/pending via isolated fixture and dedicated CI; retain existing native-controller regressions.
- [ ] Review, strict compile, regression/reapply/blob verification, deliver exact patch and current remote status.

## Rulings / execution ledger
- Continue directly under the user's repeated execution instruction; no design confirmation loop.
- Full previous Foundation run 41418570267 was cancelled. Never claim prior full success.
- Container Git networking is unavailable; use connector reads and mounted verified source, compare every modified original with remote Git blob.

- Inline review added recovery gate to one-shot mode and rechecks after presence; RED then GREEN. New selected total 90; previous artifact total 203. Actual CLI/full-repo CI not yet claimed.
