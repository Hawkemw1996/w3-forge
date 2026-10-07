# Forge foundation verification — v0.4.1

Branch: `dev/v0.4.1`. Base commit: `9cb715d319eb2b240b2240ad88ba035a0afa8569`. Ready for user review; no live deployment or service configuration changes performed.

## Verification results

Commands below ran from the Forge checkout unless noted. On Windows, the workspace's existing `.dev-tools` npm shim was added to PATH.

| Command | Result |
| --- | --- |
| `npm.cmd run build --prefix backend` | PASS — TypeScript build |
| `npm.cmd run typecheck --prefix frontend/admin` | PASS |
| `npm.cmd run build --prefix frontend/admin` | PASS — lazy terminal bundle |
| `npm.cmd test --prefix frontend/admin` | PASS — 18 tests, zero failures/skips |
| `npm.cmd test --prefix backend` | FAIL — 93 passed, 2 failed, zero skipped |
| `npm.cmd --prefix backend test -- terminalSessionManager.test.ts terminalRoutes.test.ts terminalRuntime.test.ts coreAuth.test.ts` | PASS — 28 terminal/Core tests |
| `npm.cmd test --prefix backend -- --run test/gitConnections.test.ts test/connections.test.ts` | PASS — initial 14 tests; final complete suite also passes the additional Qwen Coder test |
| `node ../outputs/01a113b1-6aab-76f1-8141-b9b3e2f3410b/forge-ui-smoke.cjs` | PASS — installed Edge, desktop/mobile fixture API |
| `node ../outputs/01a113b1-6aab-76f1-8141-b9b3e2f3410b/forge-server-smoke.cjs` | PASS — real compiled server, blank credentials, private local port |
| `git -c core.autocrlf=false diff --check` | PASS after LF normalization |

The two complete-suite failures are unchanged `safeRunner.test.ts` checks that directly execute Bash shebang scripts on Windows; Node returns `spawn EFTYPE`. Tests were not removed, skipped or weakened. Local WSL is not installed. Run the full suite on Linux before activation.

A read-only invocation of the new compiled Git runner also reached the actual Forge GitHub origin with fixed arguments `ls-remote --exit-code --heads origin refs/heads/dev/v0.4.1` and returned base commit `9cb715d...`. It did not fetch or change the repository.

## Behaviors verified

- Existing Core sign-in/admin authorization remains intact. Wrong role, expired/revoked login, Core outage, concurrent logout and separate browser-session ownership reject or terminate terminal access.
- Terminal idle revalidation and held-output-read revalidation prevent stale authorization. Root shell process arguments and environment are fixed/scrubbed; audit contains lifecycle metadata rather than input/output.
- Terminal limits, input/output/resize/close transport, resize on viewport changes, clear-screen control bytes without Enter, expand/collapse and navigation cleanup.
- Desktop and 390-pixel mobile dashboard, GitHub, settings and terminal layouts; no horizontal overflow or browser errors. Browser terminal used simulated API responses, not a real root shell.
- Git failures cannot appear as a clean workspace; protected branches and mismatched/token-bearing remotes are rejected; branch-without-upstream counts stay unknown; connection errors do not expose subprocess diagnostics. Success resets on refresh/repository identity changes.
- Settings return configuration readiness and safe links only, never Core/Apify/shared credentials. Existing pricing tests pass; installed `qwen2.5-coder:14b` tag is supported without downloading or invoking a model.
- Compiled backend startup, root redirect, built admin page, health response and unauthenticated denial for connections/Git/terminal.

## Scope, risks and outstanding work

Implemented within the requested app/admin/GitHub/terminal scope: three direct dependencies (`node-pty@1.1.0`, `@xterm/xterm@6.0.0`, `@xterm/addon-fit@0.11.0`), terminal-specific Core session reuse/revalidation, default-off interactive root terminal, optional service template, read-only Git and connection diagnostics, app entry page. Native PTY/root login and the new systemd unit still need Linux verification. Root terminal commands have host permissions; the automated control allowlist does not constrain human terminal input.

Existing package audit reports 14 backend findings outside the added PTY packages; no unrelated dependency versions were changed in this scope.

No database, schema, migrations, seeds, production data, live credential values, production network/port/proxy settings, backup/restore scripts, release packages/tags, main branch, CI, status checks or merge gates were changed. Existing pricing ledger behavior and paid-request safeguards are preserved. Production activation, Core owner pairing and credential setup remain owner-controlled. Chat, n8n API UI and other business automation screens are future work.

The host currently uses `dev/v0.4.0` and retains a local listen-host change. Preserve that change. See [activation guide](APP_FOUNDATION_v0.4.1.md) for the concrete service template, commands and rollback plan.

## Changed files
- .env.example
- backend/package-lock.json
- backend/package.json
- backend/src/admin/adminAudit.ts
- backend/src/admin/controls/safeRunner.ts
- backend/src/admin/index.ts
- backend/src/admin/routes/connectionsRoutes.ts
- backend/src/admin/routes/forgeGitRoutes.ts
- backend/src/admin/routes/overviewRoutes.ts
- backend/src/admin/routes/systemRoutes.ts
- backend/src/admin/routes/terminalRoutes.ts
- backend/src/admin/terminal/runtime.ts
- backend/src/admin/terminal/sessionManager.ts
- backend/src/auth/coreAuth.ts
- backend/src/index.ts
- backend/src/materialPricing/config.ts
- backend/test/connections.test.ts
- backend/test/gitConnections.test.ts
- backend/test/terminalFixture.ts
- backend/test/terminalRoutes.test.ts
- backend/test/terminalRuntime.test.ts
- backend/test/terminalSessionManager.test.ts
- CHANGELOG.md
- config/apps/w3forge.yml
- config/systemd/w3forge-admin.service
- docs/APP_FOUNDATION_v0.4.1.md
- docs/APP_FOUNDATION_VERIFICATION_v0.4.1.md
- docs/CORE_CONNECTION_v0.4.1.md
- docs/MATERIAL_PRICING.md
- frontend/admin/package-lock.json
- frontend/admin/package.json
- frontend/admin/src/App.tsx
- frontend/admin/src/components/AdminLayout.tsx
- frontend/admin/src/lib/connections.ts
- frontend/admin/src/lib/terminal.ts
- frontend/admin/src/lib/terminalScreen.ts
- frontend/admin/src/pages/DashboardPage.tsx
- frontend/admin/src/pages/GitHubValidationPage.tsx
- frontend/admin/src/pages/SettingsPage.tsx
- frontend/admin/src/pages/SystemStatusPage.tsx
- frontend/admin/src/pages/TerminalPage.tsx
- frontend/admin/tests/console.test.mjs
- frontend/admin/tests/terminalConnection.test.mjs
- frontend/admin/tests/terminalScreen.test.mjs
- README.md
