# Forge v0.4.1 verification

Branch: `dev/v0.4.1`. Baseline: `6b3ab01fe74cdcdc4aca4d817249b96400c6d653` (`dev/v0.4.0`).

## Changes and scope

Implemented the user-approved Core app pairing, browser sign-in, session/authorization and latest applicable admin-console updates. Forge requires an explicit app admin assignment for all administrative APIs and keeps the existing network guard, safe runner and engineering-only authority. Current Core shared sidebar/styles, sticky navigation, account footer and a Forge GitHub Validation page are included. Settings explain Core-owned app permissions.

No dependency additions, upgrades or removals. No schema, persistent business-data, production ports, launcher/deployment/backup/restore scripts, CI or protected-branch changes. Tests remain enabled and assertions retain their original safety expectations; existing tests now authenticate through the real app auth layer using a simulated Core transport. The log-path test exposed a dot-segment validation omission, fixed in the guard without weakening the test. A source-audit test now accepts Windows line endings.

## Exact verification commands

Local Windows, Node 24.19.0:

- `npm ci --prefix backend --no-audit --no-fund` — passed.
- `npm ci --prefix frontend/admin --no-audit --no-fund` — passed.
- `npm run build --prefix backend` — passed.
- `node frontend/admin/node_modules/typescript/bin/tsc --noEmit -p frontend/admin/tsconfig.json` — passed.
- `npm run build --prefix frontend/admin` — passed.
- `npm test --prefix backend` — final local run: 38 passed, 2 failed because Windows cannot spawn the Bash stub executables (`EFTYPE`). No skips.
- `npm test --prefix frontend/admin` — 5 passed, no failures/skips. React's server-render useLayoutEffect warnings are expected in the render harness.

Isolated Linux on w3forge, Node 22.14.0:

- `npm ci --prefix backend --no-audit --no-fund` and `npm ci --prefix frontend/admin --no-audit --no-fund` — passed.
- `npm run build --prefix backend` — passed.
- `npm run typecheck --prefix frontend/admin` — passed.
- `npm run build --prefix frontend/admin` — passed.
- `npm test --prefix backend` — **40 passed**, no failures/skips (11 envelope, 19 safe-runner, 10 identity/access).
- `npm test --prefix frontend/admin` — **5 passed**, no failures/skips.
- `for script in scripts/*.sh; do bash -n "$script" || exit; done` — passed for every shell script.
- `git -c core.autocrlf=false diff --cached --check` — required before commit; passed.

Source only was copied to `/home/forgeadmin/.cache/w3-dev-review/forge-v0.4.1`, excluding real environment files, credentials, installed dependencies and Git history. Executable modes and repository LF line endings were preserved. Logs live in the parent isolated review directory. No running app, service configuration or production data changed.

## Limits and review state

Ready for user review. Live browser pairing, operator-managed deployment and end-to-end validation against a deployed Core v0.12.16 are still release steps. Tests simulate Core responses while exercising the actual Forge client, PKCE, cookies, callbacks and admin guards. Sessions are intentionally memory-only and end on process restart; every request needs Core availability. Controls already running when access is revoked finish under the existing safe-runner limits.

No production package, release tag, main-branch change or deployment. Rollback and configuration instructions are in `docs/CORE_CONNECTION_v0.4.1.md`. Reverting to Forge v0.4.0 restores network-only console access and needs explicit review of that weaker policy.

## Changed files

- `.env.example`
- `.gitignore`
- `CHANGELOG.md`
- `README.md`
- `VERSION`
- `backend/package-lock.json`
- `backend/package.json`
- `backend/src/admin/adminAudit.ts`
- `backend/src/admin/index.ts`
- `backend/src/admin/routes/logsRoutes.ts`
- `backend/src/auth/coreAuth.ts`
- `backend/src/auth/coreClient.ts`
- `backend/src/index.ts`
- `backend/test/coreAuth.test.ts`
- `backend/test/coreFixture.ts`
- `backend/test/envelope.test.ts`
- `backend/test/safeRunner.test.ts`
- `config/apps/w3forge.yml`
- `docs/CORE_CONNECTION_v0.4.1.md`
- `frontend/admin/package-lock.json`
- `frontend/admin/package.json`
- `frontend/admin/src/App.tsx`
- `frontend/admin/src/components/AdminLayout.tsx`
- `frontend/admin/src/components/CoreAuthGate.tsx`
- `frontend/admin/src/lib/api.ts`
- `frontend/admin/src/pages/GitHubValidationPage.tsx`
- `frontend/admin/src/pages/SettingsPage.tsx`
- `frontend/admin/src/shared/components/W3Badge.tsx`
- `frontend/admin/src/shared/components/W3Sidebar.tsx`
- `frontend/admin/src/shared/lib/cn.ts`
- `frontend/admin/src/shared/styles/primitives.css`
- `frontend/admin/src/shared/styles/tokens.css`
- `frontend/admin/src/styles.css`
- `frontend/admin/tests/console.test.mjs`
- `docs/VERIFICATION_v0.4.1.md`
