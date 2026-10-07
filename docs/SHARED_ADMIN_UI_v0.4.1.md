# Forge v0.4.1 shared admin console UI

Historical pass: the [per-app UI follow-up](PER_APP_ADMIN_UI_v0.4.1.md) supersedes the disabled inventory and missing resource telemetry descriptions below.

Date: 2026-10-06. Active branch: `dev/v0.4.1`. Base commit: `e2ae597e74a322258379966035bfc456b3ec1d80`. The commit containing this report is the UI review unit.

## Shared rule

The user's requirement is recorded in the workspace `AGENTS.md`: every W3 app, including CleanBooksAI, must use the same admin console interface. BuildCost supplies this pass's standard navigation, with the shared W3 Core console supplying the visual system. App identity, runtime data, destinations and available capabilities are configuration; they must not become separate app-specific console designs.

Forge now uses the standard sidebar labels, order and icons: Dashboard, System Status, Logs, Packages, Backups, File Browser, GitHub / Releases, Terminal, Controls, Production Readiness, Settings. Packages and Backups remain visible as disabled Core-managed capabilities. The header/sidebar geometry, shared badge and control styling, environment/account footer, mobile drawer and navigation behavior follow the reference. The footer still opens Core because Forge has no separate product application route yet.

The prior app-planning dashboard is replaced by Operations Overview with the standard System Health, Version, Attention Required, Recent Logs, Memory / CPU, Disk Usage, Staged Packages, Installed Packages and Backup Summary slots. Product chat, n8n workflow editing, item pricing and future business screens remain a separate application phase.

System Status, Logs, File Browser, Controls and GitHub use the common tile/card/list/toolbar composition, connected to existing Forge APIs. Logs support the canonical search/filter/live-follow viewer. Files preserve single-root, read-only metadata access while using the shared directory/details presentation. Controls preserve their registered IDs and exact execution request. Readiness uses the standard table/mobile-card checklist and requires owner review.

## Source provenance and scope of parity

- BuildCost reference: `d0cf34c5903940337e162a90771fbe09fd056ce6` in `buildcost-v0.3.9`.
- Core reference: `c470e4ab8670dfbc0e2a20cbbc13f8903884b6ce` in `core-v0.12.22`.
- `frontend/admin/src/shared/provenance.json` pins normalized SHA-256 hashes and source paths for shared visual assets and copied helpers. The regression check fails when a copy drifts without an intentional provenance update.
- Existing shared colors, typography, spacing, card/button/table styles already matched. This pass reuses those definitions instead of adding another theme.
- BuildCost and Forge shells were rendered with identical fixture content and their full Tailwind configurations. Computed sidebar/header/card geometry, typography, colors, padding, borders and button/nav styles matched at 1440x1000 and 390x844.

This establishes the same console design and component system, not equal backend capabilities or pixel-identical data on every page. Forge still has no dashboard-layout persistence/customizer, resource/database/API/disk/exposure telemetry, package/backup inventories, multi-root file browser, file-content preview, combined recent-log stream or full release pipeline. Those slots are disabled or explicitly unavailable. Recent Logs currently lists existing log files; the Logs page reads their actual tails. Readiness reports configuration and manual-review items, not production approval. No placeholder claims a service is connected merely because its settings exist.

Only Forge application code was changed in this pass. Workspace guidance applies the requirement to the other W3 apps; their source code and live installations were not changed here.

## Verification

From the Forge repository, with the existing workspace npm shim on PATH:

| Exact command | Result |
| --- | --- |
| `npm.cmd run typecheck --prefix frontend/admin` | Passed. |
| `npm.cmd test --prefix frontend/admin` | Passed: 21 tests, no skipped tests. |
| `npm.cmd run build --prefix frontend/admin` | Passed. |
| `npm.cmd run build --prefix backend` | Passed. |
| `git -c core.autocrlf=false diff --check` | Passed. |

From the workspace root:

| Exact command | Result |
| --- | --- |
| `node outputs/01a113b1-6aab-76f1-8141-b9b3e2f3410b/compare-admin-shells.cjs` | Passed: full styled shell comparison at desktop and phone sizes, no browser errors or overflow. |
| `node outputs/01a113b1-6aab-76f1-8141-b9b3e2f3410b/forge-shared-ui-smoke.cjs` | Passed: common pages at both sizes, log search, file selection, exact control payload/output, GitHub connection/refresh, stale-success removal after failed refresh, terminal input/clear/expand/disconnect and navigation cleanup. No horizontal overflow or browser errors. |

Browser tests use fixture API responses only. Screenshots and `shared-shell-comparison.json` are in that task output directory. The frontend test log is `shared-ui-tests.log`. An initial mobile Logs overflow was fixed and the complete browser check rerun successfully. Independent review found and verified the correction for stale successful Git status after a failed refresh.

The backend test suite was not repeated for this presentation pass; its only server edit changes a navigation label in an informational message. The prior authentication report records the two Windows-only Bash-spawn test failures. Linux/live verification and owner approval remain outstanding.

## Changed files

- `CHANGELOG.md`
- `backend/src/admin/routes/overviewRoutes.ts` (display text only)
- `docs/APP_FOUNDATION_v0.4.1.md`
- `docs/CORE_CONNECTION_v0.4.1.md`
- `docs/SHARED_ADMIN_UI_v0.4.1.md`
- `frontend/admin/src/App.tsx`
- `frontend/admin/src/components/AdminLayout.tsx`
- `frontend/admin/src/components/ui/DarkSelect.tsx`
- `frontend/admin/src/components/operations/DashboardTile.tsx`
- `frontend/admin/src/components/operations/LogViewerPanel.tsx`
- `frontend/admin/src/components/operations/logParser.ts`
- `frontend/admin/src/pages/ControlsPage.tsx`
- `frontend/admin/src/pages/DashboardPage.tsx`
- `frontend/admin/src/pages/FileBrowserPage.tsx`
- `frontend/admin/src/pages/GitHubValidationPage.tsx`
- `frontend/admin/src/pages/LogsPage.tsx`
- `frontend/admin/src/pages/ProductionReadinessPage.tsx`
- `frontend/admin/src/pages/SettingsPage.tsx`
- `frontend/admin/src/pages/SystemStatusPage.tsx`
- `frontend/admin/src/shared/components/W3Sidebar.tsx`
- `frontend/admin/src/shared/provenance.json`
- `frontend/admin/tests/console.test.mjs`
- `frontend/admin/tests/sharedUi.test.mjs`

The workspace `AGENTS.md` was also updated with the user's global UI instruction. It lives outside this satellite repository.

## Review and release boundaries

No dependencies were added or proposed. Authentication, app permissions, server session handling, terminal authorization, safeRunner restrictions and control payloads are unchanged. Sign-out has the reference pending-button presentation but still invokes the existing Core logout function. Tests were updated for the requested UI and strengthened with source-parity/readiness checks; none were skipped or weakened.

No deployment/backup/restore/status scripts, service units, runtime settings, ports, secrets, database/schema/migrations/seed data, production records, CI, required status checks or merge gates were changed. No live pairing, deployment, package creation, main-branch change or release tag was performed.

The branch is ready for user review. Revert this UI commit on the development branch to restore the preceding presentation; there is no data migration. Production activation remains governed by the existing owner release process.
