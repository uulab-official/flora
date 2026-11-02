# Local Build Operations Implementation Plan

> Historical baseline record for the earlier local-operations patch. The subsequent console/runner integration and its updated verification boundaries are documented in `docs/development/local-build-console.ko.md`. Statements about no HTTP/runner execution or no remote publication below describe that earlier snapshot, not the cumulative feature branch.


> **For agentic workers:** Use superpowers:executing-plans; run tests after each task.

**Goal:** Ship a locally executable build-history, artifact-finalization and export path.
**Architecture:** Reuse the artifact modules; add SQLite transactions and an owner-local CLI.
**Tech Stack:** Node ESM, node:test, node:sqlite, POSIX filesystem.
**Spec:** docs/superpowers/specs/2026-11-02-local-build-operations-design.md

## Global Constraints
No production writes, no cloud calls, no added packages, no claims of native/device validation.
Repository Node floor remains >=24.19.0 <25; local compatibility tests use 22.16.0.

## Review Focus
- Request mutation while an async lock is pending: snapshot primitives before awaiting.
- Replayed key with changed version/evidence: conflict, not a second transition.
- Process dies around file/DB commit: durable success receipt or diagnosed unreferenced file.
- Same-size artifact tampering and destination collisions: reject, leave original untouched.
- Secrets/paths in arbitrary caller fields: whitelist outputs and audit fields.

## Task 1: Repair current gates
- [x] Reproduce the existing failure and capture baseline evidence.
- [x] Add failing tests for ID coercion, unsafe version increment and input mutation.
- [x] Fix shared validation and the hardlink test's fixture lifetime.
- [x] Use real BigInt stat snapshots and immutable artifact metadata; run artifact suite.

## Task 2: Durable ledger
Files: scripts/artifacts/durable-build-ledger.mjs and .test.mjs.
- [x] Tests: reopen, independent connections, CAS conflict, replay, unsupported schema, audit.
- [x] Implement openDurableBuildLedger({directory, create}) with private SQLite storage.
- [x] Atomic transition/complete, immutable job context, scoped list/history/artifacts.
- [x] Run tests including separate-process race; no automatic destructive migrations.

## Task 3: Artifact operation integration
Files: local-build-service.mjs, local-build-service.test.mjs, private-paths.mjs,
verified-copy.mjs; existing artifact modules as needed.
- [x] Tests: finalize trusted report + real bytes, duplicate report, cross-app read,
  corrupt stored bytes, export existing-file preservation and no paths in responses.
- [x] Implement service over ledger + local artifact store; diagnose unknown/orphan state.
- [x] Run end-to-end tests with actual temporary files and reopened databases.

## Task 4: CLI, CI and evidence
Files: build-ops.mjs, build-ops.test.mjs, package.json, artifact workflow, operator guide.
- [x] CLI tests first: init/create/transition/complete/list/show/history/export/doctor.
- [x] Integrate script entrypoints and Linux/macOS pinned-Node CI matrix.
- [x] Run every available artifact test and attempt the repository test command.
- [x] Review diff, verify patch applies to exact baseline, package reproducible evidence.

## Evidence boundary
The final checklist records local execution only. GitHub push and hosted/pinned-version CI were not performed. The whole-repository command was attempted and was blocked by the missing pnpm toolchain and incomplete snapshot; it is not a passing gate.
