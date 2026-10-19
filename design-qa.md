# Flora project gallery design QA — 2026-10-19

final result: passed

## Visual truth and evidence

- User selected **the first displayed generated design**, the light app-card gallery.
- Source: `/Users/uulab/.codex/generated_images/01a12de3-0fdb-7180-a2a9-5572f00181d7/exec-c60cbf68-56f9-411f-afa5-5482d0911d2a.png`.
- Implementation: `dist/gallery-preview/desktop-final.png`, `mobile-final.png`, `tablet-final.png`.
- Combined full-view comparison: `dist/gallery-preview/comparison-final.png`. Focused app-card comparison: `dist/gallery-preview/card-comparison-final.png`.
- Source pixels: 1487 × 1058. Desktop browser viewport and implementation pixels: 1488 × 1058, density 1. No stretching; one-pixel frame-width difference is immaterial. Focused comparisons use native 391 × 346 regions side by side. Mobile: 390 × 844; tablet: 1024 × 768, density 1.
- State: five existing applications, all-project filter, search empty, reports collapsed, light theme, authenticated read-only local preview. The final desktop capture intentionally shows expired presence as unknown; the concept shows illustrative fresh presence. Layout/identity comparisons use the same interaction state; dynamic status differences are preserved as data semantics, not forced to match the concept. The preview uses an explicitly labeled production metadata snapshot; it has no production credentials and rejects writes. Snapshot freshness expires normally; stale presence is shown as unknown rather than invented online state.

## Findings and iteration history

1. **[P2, fixed] Oversized card content and overlapping Runner metadata.** Initial cards were 478px high, with last-seen text colliding with app names and the second row clipped. Detailed device and issue evidence is now preserved under one disclosure. The final three-column cards are 345px high, with explicit Runner badges; all five cards fit the desktop reference height. Last-seen time remains in the report/issue disclosure.
2. **[P1, fixed] Expanding a report selected its containing app.** Browser interaction demonstrated navigation to app overview. Delegation now accepts the explicit app button only. The regression test observed RED and GREEN; browser readback showed `/projects` with `open: true`, without an added state request.
3. **[P2, fixed] Tablet filter lost its selected label.** At 1024px, the filter squeezed into a narrow arrow. The tablet toolbar now wraps search to its own row. Final measured filter width is 539.6px, full selected text visible, document width equals viewport width.
4. **[P2, fixed] Imported Android platform symbol did not render.** Library import initially included a nested root element. Both unchanged Tabler 3.49.0 paths now sit inside well-formed symbols. XML parsing passed and both platform icons render in the final browser screenshot.
5. Preview-only asset serving initially stopped on an absent favicon. The isolated preview server now reads asset bytes before sending headers and handles missing files without stopping. Flora also uses its existing brand image as its favicon.

No actionable P0/P1/P2 finding remains.

## Required fidelity surfaces

- **Fonts and typography:** the existing Inter / system / Noto Sans KR stack is retained. Computed base font is 14px, heading 29px, project names 17px. Korean glyphs render correctly. Metadata uses smaller secondary text; long repositories wrap. No identifier strings dominate the project list.
- **Spacing and layout:** sidebar216px, desktop main padding32px, 3/2/1 columns. Five real apps and their distinct Runner/device states remain visible. No horizontal overflow at desktop, tablet or mobile. The secondary usage disclosure sits below the gallery and operational guide; its position is intentionally lower than the concept to retain existing refresh/status controls.
- **Colors and tokens:** neutral light surfaces, restrained Flora violet, amber offline and green online with explicit text. Stale/unknown data is gray and labeled. No status relies on color alone. Keyboard Tab visibly produces a 3px violet focus outline on the primary button.
- **Image quality and assets:** actual repository app icons are used for Isso, Promise and Reward in the installation-specific preview overlay. The generic OSS build contains no operator images/repository mapping. Unconfigured QA apps use the actual name's first-letter fallback. Platform icons reuse licensed Tabler geometry. No approximated app logos or generated decorative assets are used.
- **Copy and content:** real timestamps and per-platform SDK report counts replace illustrative concept data. `게시됨` remains distinct from device application. Missing reports remain waiting/unknown. Original recovered failure reports and app-scoped links remain available; stale Cloudflare usage retains its warning and sample date. The text does not promise unlimited technical capacity.

## Functional browser verification

- Search `reward`: one exact project; clearing restores five.
- Runner-attention filter: the original three apps; unresolved OTA filter: honest empty state for this snapshot.
- Report expansion: same project-list route, actual per-platform download/apply/restart/failure/recovery counts visible, no card-navigation bubbling.
- Reward `배포·이력 보기`: navigates to Reward's exact OTA route and selected-app identity. No new OTA publication or device execution is claimed.
- Mobile menu: opens and closes; choosing projects restores top-of-page navigation.
- Cloudflare usage expands and retains old measurement numbers plus explicit stale warning. Expansion state is retained across renders.
- Browser Runtime/Log collection during final gallery interactions: no exception or error events. Two existing verbose DOM form-organization recommendations were observed; they are not runtime failures and were outside the changed gallery.
- Preview viewport override reset after QA; the visible local preview stays open.

## Verification scope and residual polish

- Focused UI/navigation/HTTP/build checks: 99 passed, zero failures.
- Full repository `pnpm check`: build and typecheck passed; 1467 tests, 1464 passed, 0 failed, 3 conditional skips, exit0 (497577.7ms). Evidence: `dist/gallery-frozen-check.log`. Final focused UI/navigation/HTTP/build checks also passed 99/99 after the presentation adjustments.
- Original source preservation: 559 files unchanged; original HEAD, index, staging and untracked status preserved (`dist/gallery-preview/preservation.json`). All remote calls in this UI task were GET; production data, keys and history were not mutated.
- This is source implementation and local browser QA. It is **not a Cloudflare deployment**, new native app build or real-device OTA verification.
- P3: a future icon-management form could replace the installation-owned static branding overlay. This iteration deliberately retains the existing data/API/query model.
