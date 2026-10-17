# Admin console pages

The hosted console uses one shared header, sidebar, main region and footer. Each management page has a canonical URL admitted by the Worker and restored by the browser controller. Page selection never writes app settings or deployment policy.

| Page | URL |
| --- | --- |
| Project list | `/projects` |
| Project registration | `/projects/new` |
| Workspace settings | `/settings` |
| App overview | `/apps/:appId` |
| GitHub source and SDK | `/apps/:appId/source` |
| OTA publication history | `/apps/:appId/ota` |
| PC Runner policy and logs | `/apps/:appId/runners` |
| Native build jobs | `/apps/:appId/builds` |
| Certificates and service keys | `/apps/:appId/credentials` |
| App public settings | `/apps/:appId/settings` |
| Source import history | `/apps/:appId/activity` |

`public/admin-routes.js` defines the shared route allowlist. The Worker authenticates every private document and asset; unknown paths return 404 instead of the console. Login accepts only a canonical internal return path. The root URL remains a project-list alias.

App-specific pages load the requested app state before their own operations. A mismatched or inaccessible app never falls back to another app. App switching preserves the page, and browser back/forward restores both app and page. Leaving a page clears credential drafts and one-time Runner tokens, with response epochs fencing delayed receipts even on a same-app return.

Below 900px the sidebar becomes a drawer with an explicit menu button, backdrop and Escape close. Under 640px project rows stack, while the shared regions remain separate. Native Runner enrollment belongs to Runner; build requests and results belong to Native builds. Credential management and app public settings have separate pages.

Verification: controller tests in `admin-navigation.test.ts`, Worker/login route tests in `admin-http.test.ts`, and existing hosted/credential/native UI regression tests. Browser verification and deployed data-preservation evidence are separate from synthetic tests.

The project list reads `GET /api/projects` once for repository identity, the latest published iOS/Android OTA across channels, and OTA PC Runner presence. The endpoint performs a fixed owner-scoped set of read-only queries; it does not call GitHub, access Vault, fetch each app's logs, or change data. Metadata is bounded to 256 Unicode code points with truncation flags; full app identity remains available on the selected app. Publishing timestamps use the same ordering as the existing OTA store, including the last inserted row when timestamps tie.

The last observation time is visible and the operator can refresh it explicitly. A failed refresh retains the last verified summary with a stale-information label; unloaded information stays unknown. Detail screens put repository, runtime, policy, platform, channel and time first. Full IDs, hashes and troubleshooting URLs remain in collapsed technical details. A publication is labelled as matching current source only after app, detection ID, commit, runtime and saved channel agree. Publication records remain separate from device download/apply evidence.
