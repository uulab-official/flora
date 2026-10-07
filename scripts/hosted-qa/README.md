# Synthetic hosted render gate

This development-only gate composes the production frontend, front Worker,
`FloraAuth` SQLite Durable Object and D1 import store. Its source and baseline
envelopes come only from the repository's synthetic fixtures. It does not contact
a Cloudflare account, create resources, deploy code, execute imported source, or
read private app data. A passing run is not a claim of a deployed service.

## Transport and security boundary

The browser sees `https://flora.example.test`, a reserved synthetic origin.
Playwright intercepts every page request, forwards its original byte buffer and
headers through the harness's ordinary local HTTP method into Miniflare's real
listener, then fulfills the production response status, headers and bytes.
The harness alone sets Miniflare's original-URL metadata to the synthetic HTTPS
URL. Redirects are not followed by the bridge. All other
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

## Ordinary HTTP acceptance and unresolved runtime gate

The non-browser composition test uses `httpFetch`: Node's ordinary `fetch` to
Miniflare's actual loopback HTTP listener. The harness validates both the exact
synthetic input origin and the `http://127.0.0.1:<port>` runtime destination,
overwrites Miniflare's exported original-URL metadata itself, preserves original
request bytes, and always uses manual redirects. It does not create a custom
connection pool, force a fresh socket, delay, or retry a request. The production
Worker, auth DO, D1, admission rules, and response attributes are unchanged.

That acceptance test sends the complete CSRF-rejected source followed by a valid
source and baseline upload. It also deliberately loses delivery after a real
committed HTTP write, checks that existing records remain intact, and verifies
that an explicit same-envelope retry returns the same receipt without another
record. This deliberate delivery failure is separate from a runtime reset. The
browser already checks its corresponding uncertain-result notice, explicit
reload/reupload, receipt identity, and two-record count without another capture.

The former `dispatchFetch` composition remains executable as a separate
characterization, with the same real API sequence and response-consumption gate:

```sh
FLORA_HOSTED_QA_TRANSPORT=dispatch node --test --test-name-pattern=composition tests/hosted-qa.test.ts
node scripts/hosted-qa/characterize-rejected-upload.mjs dispatch default do
node scripts/hosted-qa/characterize-rejected-upload.mjs direct default do
node scripts/hosted-qa/characterize-rejected-upload.mjs native default do
```

The small characterization contains no Flora code or D1. Each invocation sends
at most 100 rejected/accepted/accepted sequences, stops at the first error, and
prints only synthetic request/socket metadata and dependency versions. `direct`
uses Miniflare's installed undici directly; `native` uses Node's built-in fetch.
It is not a retry-until-green gate. A passing sample leaves the upstream risk open.

On 2026-10-07, Linux x64 with Node 24.19.0, Miniflare 5.20261006.0-alpha,
workerd 1.20261006.1, and Miniflare's undici 7.29.1 reproduced `ECONNRESET`
without Flora or D1. In one bounded eight-process comparison, four dispatch
cases failed after 13, 46, 34, and 19 completed requests; four direct HTTP cases
completed 300 requests each. A trace shows a fully received 403, then an accepted
POST reusing the same socket before a peer reset. Direct HTTP controls also
observed socket closure after DO rejection, so their pass does not fix workerd.
Node 24.19.0's native fetch uses undici 7.29.0; no dependency version was changed.

[workerd issue #7634](https://github.com/cloudflare/workerd/issues/7634) independently
reports the same class of unread-body/service-binding reset and remains open.
The actual hosted composition also failed on Linux and macOS. Reading its 18
previously unread response bodies was necessary cleanup, but did not eliminate
this reset. Do not remove the characterization, weaken pre-auth admission, drain
denied production uploads, or label an HTTP acceptance pass as a runtime fix.

The upstream transport risk and undeployed Free-edge behavior remain separate,
unresolved release gates. Source review and local/CI HTTP passes cannot close
them. An authorized real-account deployment must repeat rejected full upload →
valid upload, honest failure feedback, and same-envelope recovery while checking
that pre-existing records and receipt identity survive. No deployment is part of
this gate.

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
  logs, keyboard focus, measured 44px mobile targets and 2× CDP page scaling
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

## Mobile target and page-scale evidence

At 390×844, the browser measures actual bounding boxes for displayed, enabled
controls and requires at least 44 CSS pixels in both dimensions. Each target is
scrolled into view and checked with Playwright's trial click for real pointer
actionability. Coverage includes every visible Source and History disclosure,
snapshot selection, source/baseline import labels, app search/filter/sort, all
rendered app-row buttons and arrows, bottom navigation, and enabled forward/back
buttons on the app, source and history pages. Disabled controls are excluded;
each requested selector must still yield at least one measured target. The JSON
summary records selector, index and measured dimensions without adding images.

The existing CDP session also calls
[`Emulation.setPageScaleFactor`](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setPageScaleFactor)
with factor 2. Both `window.visualViewport.scale` and
[`Page.getLayoutMetrics`](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-getLayoutMetrics)
must report the observed scale, and the visual viewport must shrink accordingly.
At that scale, the browser searches for a flavor, opens/closes its detail and
clears the search using ordinary actionable controls. A finally block restores
factor 1, and every reference screenshot independently requires scale 1.

This exercises CDP visual page scaling. It does not prove native pinch gestures,
OS text zoom or browser-toolbar zoom; those remain explicitly unverified in the
summary. The viewport meta tag is checked separately as metadata. No CSS zoom,
transform, security flag or forced click substitutes for observed scaling. If
the runner's Chrome cannot perform the CDP operation or the controls are not
usable at 2×, the gate fails instead of claiming a zoom pass. Source contract
tests alone do not establish measured targets or zoom; actual CI remains the
required execution evidence.

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
