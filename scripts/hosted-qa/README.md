# Synthetic hosted render gate

This development-only gate composes the production frontend, front Worker,
`FloraAuth` SQLite Durable Object and D1 import store. Its source and baseline
envelopes come only from the repository's synthetic fixtures. It does not contact
a Cloudflare account, create resources, deploy code, execute imported source, or
read private app data. A passing run is not a claim of a deployed service.

## Transport and security boundary

The browser sees `https://flora.example.test`, a reserved synthetic origin.
Playwright intercepts every page request, forwards its original byte buffer and
headers to local Miniflare `dispatchFetch`, then fulfills the production response
status, headers and bytes. Redirects are not followed by the bridge. All other
page origins are blocked, service workers are blocked, and workerd's outbound
service rejects and counts external attempts. Any such attempt fails the gate.

Only the static-assets binding is a test adapter, serving the exact checked-in
hosted HTML/JS/CSS, generic Flora mark and licensed icon sprite. The console CSS
comes from `packages/cloudflare/public/app.css`; legacy dashboard CSS is not used.
Only exact `/brand.png` and `/icons.svg` routes join the public auth assets.
Private HTML, JavaScript and CSS retain the production Worker's live session
check, strict routing, no-store headers and unchanged CSP. A local D1 database is migrated
and receives a synthetic deployment identity. There are no test auth routes,
success-response stubs, authority subclass, forced session inserts, direct data
imports, or manual browser cookie injection. Enrollment and login run native
scrypt; all app records enter through the production API and UI.

The bridge preserves both original Set-Cookie values, including Secure,
HttpOnly, SameSite=Strict and host-only Path=/ restrictions. Playwright 1.58.2's
[Chromium implementation](https://github.com/microsoft/playwright/blob/v1.58.2/packages/playwright-core/src/server/chromium/crNetworkManager.ts#L587-L636)
splits newline-separated cookie values into individual protocol headers. The
bridge uses that behavior rather than comma-joining or parsing cookies itself.
The browser must prove that both real cookies were accepted with the expected
attributes, remain inaccessible to document.cookie, survive navigation, and
authenticate two independent contexts. A real request with missing CSRF must
fail. If the installed browser rejects these response semantics, the gate fails;
it has no security fallback.

This interception validates frontend/router/auth/storage composition and browser
pixels. It does not exercise public DNS, a certificate chain, network TLS,
Cloudflare routing/static-asset infrastructure, Workers Free activation or
account quotas, deployed CPU/memory/latency, or a real one-hour session wait.
Browser clock advancement checks the frontend's absolute-expiry DOM clearing;
server expiry is covered separately by authority tests.

## CI and cost boundary

The workflow only runs on a public repository, standard GitHub-hosted
ubuntu-22.04, and main or reviewed verify/flora-hosted-* branches. It uses the
repository's exact checkout/setup-node pins, contents:read, disabled checkout
credential persistence, Node 24.19.0, pnpm 11.19.0, a frozen lockfile and disabled
dependency lifecycle scripts. Playwright 1.58.2 is installed only in job-temporary
tooling; it uses the runner's installed Chrome without browser downloads.

Chrome is launched with its sandbox explicitly enabled. Actual command-line
arguments are checked for sandbox/web-security/certificate bypass flags. There
is no certificate trust modification, OS security change, paid/larger runner,
provider account use, deployment or Actions artifact upload. Standard public
GitHub-hosted runner usage is free under [GitHub's billing rules](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
The job has a 10-minute timeout and capture has a 6-minute deadline. Publishing
or running a reviewed branch belongs to the controller; merely preparing this
workflow does not run it.

Korean glyphs use the same pinned official Ubuntu font package and temporary
Fontconfig setup as [dashboard-qa](../dashboard-qa/README.md#korean-glyph-prerequisite).
Each image verifies the Korean heading's actual platform font and glyph use
through Chrome DevTools, then checks horizontal overflow.

## What the browser checks

- Public login, rejected setup token, real enrollment, private empty state
- Cleared auth fields, unchanged Unicode/whitespace password, real cookies and CSRF
- Invalid JSON upload followed by successful original source/baseline file imports
- Eleven declared flavors from one source; searchable and sortable ten-row table,
  source filtering, empty search, paging, selected-flavor detail and close
- Real desktop/sidebar and mobile/bottom Apps, Source and History navigation;
  declared version with explicitly unconnected deployment, error and revenue
- Original upload byte equality, exact original-baseline envelope digest, lazy
  logs, keyboard focus, 44px mobile targets and unrestricted system zoom
- A dropped response after a real committed baseline write, reload, and duplicate retry preserving the receipt
- Twenty-entry history pages with 21 baseline records and 21 source snapshots; selected snapshot retained across pages
- A consumed setup token rejected in a second independent browser context, password login, and revisiting the same D1 records/log
- Private DOM clearing while actual logout and earlier private-log responses are held behind bounded gates; late private response cannot refill the DOM
- Real browser-cookie revocation and the other session still authorized
- Absolute-expiry DOM clearing using only the second browser's test clock
- No page exceptions, bridge failures, app outbound network or run/cancel/bootstrap calls

Fifteen bounded viewport PNGs are captured: desktop login and app detail;
desktop/mobile empty, upload error, Apps, Source, logout and expiry; mobile
History. Invalid setup and independent-session revisit remain full interaction
checks without extra images. Desktop is 1487×1058 and mobile is 390×844, both at
device scale factor 1. No full-page capture can inflate long paginated records.

The Apps pair matches the selected reference interaction state: eleven declared
flavors, one source, one source-scoped baseline, Sample App 4 selected, closed
detail, empty search, ascending app name, first page. The first import must land
in this default name order before the harness exercises other sorts. This keeps
the actual landing view aligned with Sample App 1, 2 and 3 in the reference;
the parser's canonical flavor identifier order remains unchanged. The mobile 853×1844 reference
normalizes proportionally to 390×843; the runtime viewport adds one pixel of
height. The approved refinement deliberately uses 13–14px body text, auxiliary
text of at least 12px, 20–22px headings and more rows/comparison columns than the
original reference. This is a density refinement, not fabricated operational
metrics. Source SHA-256 values identify both approved reference images in the
JSON summary; the review must open those exact images alongside this Apps pair.

## Evidence and review

The existing dashboard-qa evidence encoder/decoder is reused without changes:
at most 16 files including the JSON summary, 512 KiB per file, 4 MiB total,
4096-character base64 chunks, and at most 8 MiB raw log input. SHA-256 manifest
checks bind every file and the exact commit. The summary also records SHA-256
of every served asset, the Worker bundle, and each original uploaded envelope.
Evidence is emitted only after all
interaction checks pass. Failures print only an allowlisted phase/category;
passwords, setup tokens, cookies, CSRF values, request bodies and raw browser
errors are never printed. Do not enable Playwright debug logging or traces.

Retrieve the complete successful job log and verify its exact commit, then run:

```sh
node scripts/dashboard-qa/decode.mjs /path/to/full-hosted-job.log EXPECTED_40_CHARACTER_COMMIT
```

The decoder writes a new private evidence directory under the ignored local QA
directory. Inspect all decoded desktop/mobile pixels before giving visual
approval. Missing/truncated logs or a local syntax/typecheck pass do not satisfy
the browser gate. A local environment with a denied OS sandbox capability must
not launch Chrome by disabling security; wait for the reviewed standard CI run.

Local non-browser verification after the production Worker is available:

```sh
pnpm build
pnpm typecheck
node scripts/test.mjs tests/hosted-qa.test.ts tests/dashboard-qa.test.ts
pnpm check
```

The capture driver is intentionally CI-only. No successful CI run, screenshot
retrieval, pixel review, deployed HTTPS check or performance result is implied by
the presence of these scripts.
