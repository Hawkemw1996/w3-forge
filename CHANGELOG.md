# Changelog

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
