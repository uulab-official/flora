# Local build readiness and progress

## Intent
Extend the existing owner-only console with non-mutating preflight checks and truthful live progress. The user delegated continued implementation; use the existing Node/SQLite/loopback architecture, not a second management service.

## Decisions and alternatives
Prefer a shared preflight library and numeric-only process observations over exposing raw logs (credentials/path leakage) or speculative progress percentages. Reuse the existing audit table for a bounded fixed stage vocabulary; no schema migration is necessary. Live byte counters are explicitly ephemeral; durable stage events survive restart/backup but do not attest process liveness.

Preflight checks the registered job/version, preset scope, checkout permissions, executable availability, existing output, checkout lock, and Git commit/dirty state. It does not run a build, install dependencies, access providers, modify a job, reserve capacity, or assert native signing readiness. Revalidate at actual execution because preflight is a point-in-time observation, not authorization.

The console requires explicit preflight in its execution dialog; APIs remain protected by the runner's rechecks. Check responses are path/argument/log-free, app/session-scoped, concurrency-bounded, and invalidated on version/app/session changes. Report skipped checks distinctly from passing checks.

Live observations contain only a fixed stage, elapsed time, stdout/stderr byte counts, last output timestamp, and configured limits. No output text, command args, paths, env, or PID goes into web state. Output limit remains 256 KiB by default for compatibility and may be operator-configured up to 64 MiB; never unlimited. No fake completion percentage.

## Boundaries
Only local trusted operator code. This is not an OS sandbox. No production Worker/D1/OTA/provider/signing changes, no merge. Actual native builds/device installation remain separate gates. Root snapshot is 5180bc9; local execution uses a partial repository and Node 22.16.0; pinned Node 24.19/macOS evidence requires CI.
