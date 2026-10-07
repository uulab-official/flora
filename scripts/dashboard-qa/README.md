# Synthetic dashboard render gate

This is a development-only browser check for the authenticated local dashboard. It is not a deployment, private pilot, customer execution or isolated Runner certification. The product default provider stays blocked. The single seeded queued record exists only to exercise polling, cancellation and keyboard interaction without running source.

## Cost and execution boundary

The controller verified that Flora is public. `dashboard-rendered.yml` requires the repository's public visibility, uses only standard GitHub-hosted `ubuntu-22.04`, and has a 10-minute job timeout. Standard hosted runners on public repositories are free under [GitHub's Actions billing documentation](https://docs.github.com/en/billing/concepts/product-billing/github-actions). It does not use larger runners or upload Actions artifacts. Screenshots contain only generated synthetic fixtures and are emitted in bounded job-log chunks.

The [official Ubuntu 22.04 runner manifest](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2204-Readme.md#browsers-and-drivers) lists Google Chrome. This harness uses that installed Chrome through Playwright 1.58.2, pinned and installed only in the job's temporary tooling directory, with lifecycle scripts and browser downloads disabled. [Playwright's launch contract](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-chromium-sandbox) requires explicitly enabling Chromium sandboxing; the harness does so and checks the actual command line for disabling flags. Browser availability is not proof that a particular CI launch will succeed.

There is no sandbox fallback, kernel/AppArmor adjustment, system reconfiguration, tunneling or public binding. A sandbox launch failure fails the gate. Runtime requests outside the ephemeral `127.0.0.1` origin are aborted and fail the check. The harness is CI-only and accepts no supplied repository source or fixture path.

The separate workflow runs for reviewed `verify/flora-dogfood-*` branches and `main` when relevant paths change. Manual dispatch is also constrained to those refs. Publishing a branch or triggering a run remains the controller's action; preparing these files does not execute CI.

## What it checks

Desktop (1440 × 1050) and mobile (390 × 844) captures cover missing session, bootstrap loading, empty state, input error, imported source/baseline and blocked history, and active-state disclosures/focus. Additional mobile captures cover past-revision history and session loss. The driver checks bootstrap removal, skip-link cookie reload, 11 flavors, normal source/baseline uploads, no horizontal overflow, provider/log open state, summary/cancel focus across actual polls, cancellation, history restoration, private-content clearing, and absence of page errors or external requests.

A successful browser run establishes those interaction checks and produces images. It does not establish that their visual design is acceptable until the decoded pixels are inspected. A locally syntax-checked script or passing fake DOM test is not rendered evidence.

## Evidence transport and private decoding

The browser prints evidence only after all interaction checks finish. The framing prefix is `FLORA_QA_V1 `; each JSON line is at most 8192 bytes. Base64 payload chunks are 4096 characters. The manifest binds the exact Git commit, unique safe filenames, sizes, chunk counts and SHA-256 digest of each file; the terminal frame binds the manifest SHA-256. Caps: 16 files, 512 KiB each, 4 MiB total decoded bytes, 8 MiB complete raw log input. Bootstrap, session cookie, CSRF token, request objects and Playwright error details are never printed. Only a fixed failure phase and an allowlisted diagnostic category are logged if a check fails.

Retrieve the complete raw log for the exact successful job using the GitHub job-log API/connector, saving the actual text rather than copying a truncated preview. The decoder checks every frame, count, canonical base64 encoding, byte bound and digest before writing anything:

```
node scripts/dashboard-qa/decode.mjs /path/to/raw-job-log.txt EXPECTED_40_CHARACTER_COMMIT
```

It writes a newly created private directory under ignored `.superpowers/`, using mode 0600 files. Filenames permit only synthetic PNG/JSON evidence, without paths. Missing/truncated/duplicate/corrupt/wrong-commit input fails closed. If the connector cannot return the full bounded log, report that exact retrieval limit; do not infer screenshot success from a run summary. These hashes prove transported byte consistency, not the authenticity of an arbitrary log; the controller must verify the GitHub job and its commit independently.

No remote run or screenshot retrieval is implied by this harness's presence. Keep the required rendered acceptance gate pending until an authorized run succeeds, logs decode, and desktop/mobile images are inspected.
