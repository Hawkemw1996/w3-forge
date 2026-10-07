# Forge v0.4.1 per-app admin UI follow-up

Date: 2026-10-06. Active branch: `dev/v0.4.1`. Base commit: `769b02abec5ff3fe1c75f6d742a24bfe2b2e1f64`. The commit containing this report is the review unit.

This pass applies the user's clarification that every app has its own GitHub repository. It supersedes the Core-managed inventory assumptions in the earlier shared UI report. Forge uses the shared BuildCost/Core console design with its own repository, host data, packages and backups. Only Forge source was changed; the workspace guidance records the same rule for the other apps.

## Completed behavior

- All standard navigation destinations are enabled, including Packages and Backups. They use the same shared cards, desktop tables and mobile cards.
- Inventory pages distinguish missing configuration, missing directories, inaccessible storage, empty directories, partial listings and failed requests. Refresh/Retry works; cached rows disappear after failed refreshes.
- Read-only inventory adapters inspect explicitly configured paths only. No directories or archives are created, opened for content, restored, installed, moved or deleted. Scans stop after 2,000 entries, skip symbolic-link entries and direct symlink roots, and filter filenames to the configured app identity.
- Package layouts supported: `<root>/vX.Y.Z/<appId>.tar.gz` and legacy `<root>/<appId>-vX.Y.Z.tar.gz`. Malformed own-app filenames are labeled nonstandard. Names and location do not verify package contents or successful deployment.
- Backups list own-app archive/database filenames and metadata; they do not verify backup completeness or restore readiness.
- GitHub links always identify the app's configured repository. A different workspace origin is shown separately and blocks connection checks. The check pins the validated remote address. The browser rejects results for a different app, workspace, branch or repository and discards abandoned checks.
- System Status and the dashboard show process memory, host memory, host CPU count/load and filesystem capacity. Missing/invalid measurements remain unavailable; Windows load average is unavailable. Disk capacity covers the filesystem containing Forge root, not directory size.
- Settings/readiness use this app's resources and distinguish configured settings from verified connections.
- File Browser, Controls, Terminal and Settings recover from failed requests without reusing stale success states. Mobile navigation supports focus trapping, Escape and focus return, and closed links are removed from keyboard navigation.
- Route failures, including a failed terminal download, remain inside the console with explicit Reload and Back to dashboard recovery.

## Host connection handoff

Forge's configured repository remains `https://github.com/Hawkemw1996/w3-forge.git`. BuildCost's repository is not reused. Existing Core discovery, owner pairing, sign-in/2FA handoff, app assignment checks, session validation and revocation remain intact.

Optional `paths.packages_staged` and `paths.packages_installed` are documented in `config/apps/w3forge.yml` but intentionally unset until the actual host directories are selected. `paths.backups` remains the existing Forge path. The UI is ready to report those connections when configured. No guessed Core storage root is used.

Live Core pairing, SSH aliases/credentials, terminal service activation, inventory directories and service reachability still need host connection debugging. Browser tests used fixtures and do not certify live connections. Existing database/API latency, folder-size and exposure metrics, dashboard customization, file-content previews and release execution remain unavailable. Forge Chat, n8n workflow editing, item-cost screens and business automations remain the next product phase.

## Verification

All commands below were actually run with the existing workspace npm shim on PATH. Shell-only visual tests used the full Tailwind configuration.

| Working directory | Exact command | Result |
| --- | --- | --- |
| `frontend/admin` | `npm.cmd run typecheck` | Passed. |
| `frontend/admin` | `npm.cmd test` | Passed: 25 tests; none skipped. |
| `frontend/admin` | `npm.cmd run build` | Passed. |
| `backend` | `npm.cmd run build` | Passed. |
| `backend` | `npm.cmd test -- test/systemStatus.test.ts` | Passed: 17 telemetry tests. |
| `backend` | `npm.cmd test -- test/inventory.test.ts` | Passed: 13 inventory/access tests. |
| `backend` | `npm.cmd test` | 144 passed; 2 existing Windows failures in safeRunner's direct Bash-script spawn (`EFTYPE`). No tests skipped or disabled. Linux verification remains outstanding. |
| Task output directory | `node compare-admin-shells.cjs` | Passed: BuildCost/Forge shell geometry, typography, colors, spacing, cards, buttons and navigation match at 1440x1000 and 390x844. |
| Workspace root | `node outputs/01a113b1-6aab-76f1-8141-b9b3e2f3410b/forge-shared-ui-smoke.cjs` | Passed: every operational route, Git identity/race/error cases, stale data, retries, terminal lifecycle, mobile keyboard navigation and lazy-module recovery; no unexpected browser errors or overflow. |
| Task output directory | `node forge-inventory-ui-smoke.cjs` | Passed: inventory states/retry/stale-row removal, telemetry fallbacks, settings recovery and mobile layouts. |
| Forge repository | `git -c core.autocrlf=false diff --check` | Passed after normalizing changed text files to LF. |

Initial UI assertions still expected disabled inventories and an older Git fixture. They were updated to assert the requested enabled navigation and complete identity contract, with additional isolation/disconnection coverage. An intermediate mobile action-wrap markup error was corrected before the final successful typecheck/build and browser runs.

Local evidence is in `../outputs/01a113b1-6aab-76f1-8141-b9b3e2f3410b/`: frontend/backend test logs, browser scripts, screenshots and shared-shell comparison JSON. Parent and delegated reviewers inspected screenshots.

## Scope and review

No dependencies added or proposed. Authentication, authorization, session/secret handling, terminal execution, safeRunner, control payloads, database/schema/migrations, production data, deployment/backup/restore/status scripts, service units, ports, CI and merge gates were not changed. New read-only routes inherit the existing admin and same-origin guards. Runtime diagnostics and optional inventory path configuration were added; archive execution/storage behavior was not.

The user-authorized UI and app connections were implemented. No release, deployment, service restart, live pairing, package creation, main-branch mutation or tag was performed. This development branch is ready for user review and connection testing; production approval remains with the owner.

Rollback: revert this follow-up commit on the development branch. No data migration or cleanup is needed.

## Changed files

- `CHANGELOG.md`
- `backend/src/admin/forgeConfig.ts`
- `backend/src/admin/index.ts`
- `backend/src/admin/routes/connectionsRoutes.ts`
- `backend/src/admin/routes/forgeGitRoutes.ts`
- `backend/src/admin/routes/inventoryRoutes.ts`
- `backend/src/admin/routes/systemRoutes.ts`
- `backend/test/gitConnections.test.ts`
- `backend/test/inventory.test.ts`
- `backend/test/systemStatus.test.ts`
- `config/apps/w3forge.yml`
- `docs/PER_APP_ADMIN_UI_v0.4.1.md`
- `docs/SHARED_ADMIN_UI_v0.4.1.md`
- `frontend/admin/src/App.tsx`
- `frontend/admin/src/components/AdminLayout.tsx`
- `frontend/admin/src/components/RouteErrorBoundary.tsx`
- `frontend/admin/src/lib/connections.ts`
- `frontend/admin/src/lib/inventory.ts`
- `frontend/admin/src/lib/runtime.ts`
- `frontend/admin/src/pages/BackupsPage.tsx`
- `frontend/admin/src/pages/ControlsPage.tsx`
- `frontend/admin/src/pages/DashboardPage.tsx`
- `frontend/admin/src/pages/FileBrowserPage.tsx`
- `frontend/admin/src/pages/GitHubValidationPage.tsx`
- `frontend/admin/src/pages/PackagesPage.tsx`
- `frontend/admin/src/pages/ProductionReadinessPage.tsx`
- `frontend/admin/src/pages/SettingsPage.tsx`
- `frontend/admin/src/pages/SystemStatusPage.tsx`
- `frontend/admin/src/pages/TerminalPage.tsx`
- `frontend/admin/tests/console.test.mjs`

Workspace `../AGENTS.md` also records the per-app repository/resources rule outside this satellite repository.
