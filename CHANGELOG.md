# Changelog

## v0.4.0

Admin Interface Foundation. v0.4.0 introduces a read-only admin
console (HTTP API + web UI) for W3 Forge. The console is a
*foundation* layer only: it inspects state, validates configs, runs
read-only diagnostics, and proposes review reports. It does not
deploy, does not tag releases, does not move packages, and does not
modify persistent production data. W3 Core remains the production
deployment authority.

### Config + scripts

- Extended `scripts/w3-app-config-validate.sh` to validate a new
  `admin_console:` block on each app config. The validator enforces:
  required `enabled`, `listen_host`, `listen_port`, `audit_log`, and
  `allowed_scripts` fields; WARN when `listen_host` is non-loopback;
  ERROR if any `allowed_scripts` entry matches a forbidden pattern
  (`deploy`, `release`, `tag`, `publish`, `apply`, `package`,
  `production`, `migrate`).
- Bumped `config/apps/w3forge.yml` to v0.4.0 and added the
  `admin_console` block: listens on `127.0.0.1:8765`, writes audit
  log to `logs/admin/audit.jsonl`, allows exactly 11 read-only
  scripts (config-validate, branch-check, git-status, app-status,
  local-model-test, inspect, test, workflow-status, diff-summary,
  review-report, review-ready).
- Added `scripts/w3-admin-console.sh` launcher. Guards against
  running on `main`/`master`, runs config validation, locates
  `backend/dist/index.js`, exports `W3_FORGE_*` env vars, and starts
  the Express server either foregrounded or backgrounded.

### Backend (`backend/`)

Express + TypeScript admin API. All routes mount at `/api/admin/*`
and return a uniform `ApiEnvelope<T>` on both success and failure.
No route ever calls `res.json` directly.

- `src/index.ts` — boot, binds loopback only unless
  `ADMIN_ALLOW_NON_LOOPBACK=1`, serves built frontend at `/admin`,
  mounts admin router at `/api/admin`.
- `src/admin/envelope.ts` — `ApiEnvelopeSuccess<T>`,
  `ApiEnvelopeFailure`, `AdminError`, `respond.ok` / `respond.err`,
  `envelopeErrorHandler`, `envelopeNotFound`.
- `src/admin/forgeConfig.ts` — loads `config/apps/<app>.yml`,
  enforces the `^[a-z0-9][a-z0-9-]{0,63}$` app-id regex, and
  resolves any script path via `fs.realpath` so symlinks cannot
  escape `W3_FORGE_ROOT`.
- `src/admin/adminGuard.ts` — IP allowlist (loopback, RFC1918 LAN,
  Tailscale CGNAT `100.64.0.0/10`). Returns `FORBIDDEN_REMOTE` on
  any other source IP. `ADMIN_ALLOWED_IPS=*` disables in dev.
- `src/admin/adminAudit.ts` — JSONL audit log. Wraps `res.json` to
  capture envelope `error.code` on failure responses.
- `src/admin/index.ts` — `buildAdminRouter`: json(64kb) → guard →
  audit → 6 sub-routers → `envelopeNotFound` → `envelopeErrorHandler`.
- Routes: `overviewRoutes`, `systemRoutes` (`/version`, `/system`),
  `logsRoutes` (`/logs`, `/logs/tail` with 256KB cap +
  path-traversal guard), `filesRoutes` (`/files`, scoped to
  `FORGE_ROOT`, hides `.git`/`.env`), `forgeGitRoutes`
  (`/git/status`, dev/v* filter, 403 `PROTECTED_BRANCH` on
  main/master), `controlsRoutes` (`GET /controls`,
  `POST /controls/:id/run`).
- Controls registry (`src/admin/controls/registry.ts`): 11 entries,
  every one `riskLevel: LOW`, `runStrategy: 'safe-direct'`,
  `readOnly: true`. Each control always passes `--app <appId>`.
- `src/admin/controls/validator.ts` — `RunBodySchema.strict()`
  accepts exactly `{ controlId, appId, inputs? }` and rejects every
  other key (`args`, `command`, `extraArgs`, `cwd`, `env`, `flags`,
  …) with `INVALID_REQUEST_BODY`.
- `src/admin/controls/safeRunner.ts` — array-form `spawn`,
  `shell: false` (hardcoded literal), env allowlist exactly
  `[PATH, HOME, LANG, W3_FORGE_ROOT]`, no `process.env` spread, no
  `exec` / `execSync`, `fs.realpath` check on the resolved script
  path.
- `src/admin/controls/actionLock.ts` — per-`appId::controlId`
  in-memory mutex; concurrent runs return `CONTROL_BUSY`.

### Frontend (`frontend/admin/`)

Adapted from the W3 Core admin console (Vite + React + Tailwind).
W3 Core's deploy/release/package/backup pages and dashboard tile
system were pruned. UI primitives (`Card`, `Badge`, `MetricTile`,
`SectionHeader`, `States`, `StatusPill`, …) were copied verbatim so
the Forge console matches the W3 Core look and feel.

- 6 routes: Dashboard, System Status, Controls, Logs, File Browser,
  Settings.
- `src/lib/api.ts` typed fetch client unwraps `ApiEnvelope<T>` and
  throws `AdminApiError` with the envelope's `code` and `message`.
- `src/components/AdminLayout.tsx` — W3 Forge brand, 6-item nav,
  footer text: "Forge Foundation · v{version}" and "W3 Core
  remains deployment authority."
- No production controls. No deploy / publish / apply / release /
  package-move affordance anywhere in the UI.

### Tests

Vitest + supertest. 30/30 tests pass.

- `test/envelope.test.ts` — 11 tests. Every route returns the
  envelope shape on success and on failure. Unknown routes return
  `404 ENDPOINT_NOT_FOUND`. Unknown control id returns
  `404 CONTROL_NOT_FOUND`.
- `test/safeRunner.test.ts` — 19 tests. Body schema lockdown
  (rejects `args`, `command`, `extraArgs`, `cwd`, `env`, `flags`
  each with `INVALID_REQUEST_BODY`), argv invariants (always
  array-form, always `--app <appId>`, no body inputs leak into
  argv), source-code audit (no `execSync`, no `shell: true`,
  hardcoded env allowlist), and a `SECRET_LEAK_CANARY` env-spread
  check.

### Authority boundary (unchanged)

v0.4.0 stays inside the W3 Forge proposal/development layer. The
admin console is read-only by construction:

- no deploy, no publish, no apply
- no release tags, no `main` writes, no `main` merges
- no package movement into `/opt/update-packages`
- no modification of persistent production data

W3 Core remains the production deployment authority.

## v0.3.2

Review artifact cleanup. v0.3.1 made the workflow and review-ready
scripts ignore generated reports as workspace dirt. v0.3.2 closes the
loop by also making git itself ignore them, so `git status` is clean
immediately after a report is generated.

- Updated `.gitignore` to ignore everything under `docs/reports/` while
  keeping `docs/reports/.gitkeep` and `docs/reports/README.md` tracked.
  Pattern mirrors the existing `logs/*` / `cache/*` / `backups/*`
  whitelisting convention.
- Added `docs/reports/README.md` explaining that generated reports are
  local artifacts and how to explicitly promote a report into version
  control if needed (copy out of `docs/reports/` and commit on a
  `dev/vX.Y.Z` branch).
- `docs/reports/.gitkeep` remains tracked so the directory exists in
  source.
- Bumped `VERSION` to `0.3.2`.
- Updated `docs/APP_ADMIN_STANDARD.md` with a v0.3.2 artifact cleanup
  note.
- No script behavior changed in v0.3.2. The v0.3.1 in-script filter
  remains as a safety net for hosts where the `.gitignore` change has
  not yet propagated.
- No deploy, no release tags, no package movement, no production data
  changes. W3 Forge remains proposal/development; W3 Core remains the
  production deployment authority.

## v0.3.1

Review readiness polish. v0.3.0 was structurally correct but flagged
generated review reports as workspace dirt, which downgraded workflow
status to WARN and propagated to `REVIEW_WITH_WARNINGS`. Root cause:
`w3-app-workflow-status.sh` and `w3-app-review-ready.sh` did not
distinguish expected review artifacts from real working-tree changes.

- Updated `scripts/w3-app-workflow-status.sh` to ignore expected
  review artifacts under `docs/reports/` and `logs/reports/` when
  judging git cleanliness. A generated report no longer triggers
  `WARN: Working tree has uncommitted changes`. Other untracked or
  modified paths continue to trigger WARN as before.
- Updated `scripts/w3-app-review-ready.sh` Step 5 to apply the same
  filter, so generated reports do not trigger
  `REVIEW_WITH_WARNINGS: working tree has uncommitted changes`.
- Hardened `w3-app-review-ready.sh` workflow-status parser. It now
  explicitly locates the `Final` section in workflow-status output and
  reads the next non-empty non-separator line, falling back to the
  previous last-non-empty-line heuristic only if the Final block
  cannot be located. This makes the parser robust against future
  trailing output.
- Updated `docs/APP_ADMIN_STANDARD.md` with a v0.3.1 polish note.
- Bumped `VERSION` to `0.3.1`.
- No deploy, no release tags, no package movement, no production data
  changes. W3 Forge remains proposal/development; W3 Core remains the
  production deployment authority.

## v0.3.0

- Introduced the W3 Forge v0.3.0 review layer: the first layer that
  produces a structured, human-readable review surface on top of the
  v0.2.x workflow control foundation.
- Added `scripts/w3-app-diff-summary.sh` to summarize git changes for
  a configured app between a base ref and HEAD. Resolves the base ref
  with the order `origin/dev/v0.2.1` -> `HEAD~1` when `--base` is not
  provided. Prints changed files, `git diff --stat`, commit list, and
  working tree state. Read-only.
- Added `scripts/w3-app-review-report.sh` to compose a markdown review
  report covering app identity, branch/commit, workflow readiness,
  diff summary, changed files, recent commits, warnings/errors, and an
  explicit safety confirmation. Prints to stdout by default; with
  `--output <file>` also writes the report to a file. Output paths are
  restricted to `$W3_FORGE_ROOT/docs/reports/` or
  `$W3_FORGE_ROOT/logs/reports/` with realpath canonicalization to
  defeat `..` traversal.
- Added `scripts/w3-app-review-ready.sh` as the final-gate readiness
  script. Runs config validation, branch check, workflow status, and
  diff summary, then emits `READY_FOR_REVIEW` (exit 0),
  `REVIEW_WITH_WARNINGS` (exit 1), or `BLOCKED` (exit 2).
- Added `docs/reports/.gitkeep` so the default report output directory
  is committed.
- Updated `docs/APP_ADMIN_STANDARD.md` with a v0.3.0 Review Layer
  section describing the three new scripts, their state semantics,
  and the output-path safety rule.
- Bumped `VERSION` to `0.3.0`.
- W3 Forge remains the proposal/development layer; W3 Core remains the
  production deployment authority. No deploy, no release tags, no
  package movement, no production data changes.

## v0.2.1

- Polished v0.2.0 workflow control so W3 Forge can produce READY from
  its own safe self-tests.
- Added safe self-test commands to `config/apps/w3forge.yml`:
  - `bash -n scripts/*.sh` (script syntax validation)
  - `./scripts/w3-app-config-validate.sh --app w3forge`
  - `./scripts/w3-app-branch-check.sh --app w3forge`
  No deploy, release, tag, or package-movement commands were added.
- Added an opt-in `tests.require_local_model` flag to per-app config.
  When `false` or absent, `w3-app-workflow-status.sh` reports missing
  Ollama or missing models as OK (advisory) instead of WARN. When
  `true`, the prior WARN behavior is preserved. Both apps are set to
  `false` for now.
- Improved `w3-app-test.sh` failure visibility: command output is now
  captured and the last 10 lines are printed on failure with a `| `
  prefix, so issues such as `bash -n` syntax errors are actionable.
- `config/apps/w3core.yml` retains an empty `tests.commands: []`. W3
  Core workflow status may still return WARN until safe commands are
  added. No W3 Core deploy or release behavior was added.
- Bumped `VERSION` to `0.2.1`.
- Updated `docs/APP_ADMIN_STANDARD.md` with a v0.2.1 self-test note.
- W3 Forge remains the proposal/development layer; W3 Core remains the
  production deployment authority. No production deploy, no release
  tags, no package movement, no production data changes.

## v0.2.0

- Introduced the W3 Forge v0.2.0 workflow control foundation: the first
  workflow orchestration layer over the modular app-admin scripts.
- Added `scripts/w3-app-inspect.sh` for read-only repository and app
  inspection (identity, branch, commit, remotes, recent commits, changed
  files, script inventory, config inventory, workspace health). Never
  modifies files.
- Added `scripts/w3-app-test.sh` as a safe validation/test runner. Runs
  config validation, branch check, and optional `tests.commands` from
  `config/apps/<app_id>.yml`. Blocks any command containing `deploy`,
  `release`, `tag`, `/opt/update-packages`, `rm -rf`, `hardreset`, or
  `hard-reset`. Prints PASS/WARN/ERROR and exits nonzero on ERROR.
- Added `scripts/w3-app-workflow-status.sh` as a single-pane workflow
  readiness summary. Aggregates config validation, workspace and branch
  checks, git cleanliness, optional Ollama model availability, and the
  app test runner. Emits READY / WARN / ERROR with exit codes 0 / 1 / 2.
- Extended `config/apps/w3forge.yml` and `config/apps/w3core.yml` with a
  `tests:` section. `commands:` is empty for both apps; no deploy
  commands are configured.
- Updated `docs/APP_ADMIN_STANDARD.md` with a v0.2.0 Workflow Control
  section describing inspect/test/workflow-status responsibilities and
  READY/WARN/ERROR semantics.
- Bumped `VERSION` to `0.2.0`.
- W3 Forge remains the proposal/development layer; W3 Core remains the
  production deployment authority. No production deploy, no release
  tags, no package movement, no production data changes.

## v0.1.1

- Added `scripts/w3-app-config-validate.sh` to validate per-app YAML configs
  with section-aware Bash/awk helpers, clear OK/WARN/ERROR output, and the
  v0.1.1 workspace validation semantics.
- Standardized `W3_FORGE_ROOT="${W3_FORGE_ROOT:-/opt/w3forge-deploy}"` across
  all reusable admin scripts and removed hardcoded `/opt/w3forge-deploy`
  references.
- Unified `--app <app_id>` parsing across scripts using a consistent
  `while`/`case` pattern.
- Refactored `w3-app-branch-check.sh`, `w3-app-git-status.sh`, and
  `w3-app-local-model-test.sh` to use section-aware YAML extraction and to
  call the new validator first where useful.
- Improved `w3-app-status.sh` service reporting to a single clean state of
  Active, Inactive, Not installed, or Not configured, guarded by
  `command -v systemctl`.
- Appended the v0.1.1 validation and `W3_FORGE_ROOT` standard to
  `docs/APP_ADMIN_STANDARD.md`.
- No changes to the modular app-admin architecture, no release automation,
  no production deploy logic.

## v0.1.0

- Initialized W3 Forge foundation repository.
- Added controlled local development rules.
- Added base runtime folders for scripts, config, logs, cache, backups, and docs.
