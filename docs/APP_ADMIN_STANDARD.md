# W3 App Admin Standard

## Purpose

W3 apps should use a shared admin operations pattern while keeping each app isolated by configuration.

The goal is:

- one reusable admin/control standard
- one config file per app
- generic scripts that read app variables
- no hardcoded app-specific script copies
- W3 Core remains the production deployment authority

## Pattern

```text
generic script + config/apps/<app>.yml = app-aware admin behavior
```

## v0.1.1 — Modular App Admin Hardening

This section is appended for W3 Forge v0.1.1. It does not replace earlier
content; it extends the standard with hardened conventions for reusable
admin scripts.

### Validation standard

All reusable admin scripts must validate their target app's configuration
before performing any work. The reference validator is:

```text
scripts/w3-app-config-validate.sh --app <app_id>
```

The validator enforces:

- ERROR if the config file `config/apps/<app_id>.yml` is missing.
- ERROR if any required field is missing or empty:
  - `app_id`
  - `name`
  - `repo.allowed_branch_pattern`
  - `paths.deploy`
  - `paths.runtime`
  - `paths.workspaces`
  - `paths.scripts`
  - `paths.logs`
  - `paths.backups`
  - `authority.may_deploy`
  - `authority.may_tag_release`
  - `authority.may_modify_production_data`
- WARN if `paths.workspaces` does not yet exist on disk.
- ERROR if `paths.workspaces` exists but is not a git repository.
- OK if the workspace exists and is a valid git repository.

The validator must exit nonzero on any ERROR. Reusable admin scripts
should call the validator first and refuse to proceed if it fails.

### Config-driven script rules

Reusable admin scripts must:

- Be config-driven. All app-specific values must come from
  `config/apps/<app_id>.yml`, never from constants embedded in the script.
- Accept `--app <app_id>` using a consistent `while`/`case` argument parser.
- Use section-aware Bash/awk helpers for nested YAML keys such as
  `paths.*`, `repo.*`, and `authority.*`. Brittle flat `grep` against the
  whole file is not acceptable for nested fields.
- Print clear `OK:`, `WARN:`, and `ERROR:` lines.
- Stay simple Bash. No unnecessary abstraction and no new runtime
  dependencies unless clearly justified.

### No hardcoded app-specific paths

Reusable admin scripts must not hardcode app-specific paths such as
`/opt/<app>-deploy`, `/opt/<app>`, `/opt/logs/<app>`, or `/opt/backups/<app>`.
Those values belong in the per-app YAML config and must be read from it.

The single allowed hardcoded value in a reusable script is the W3 Forge
config root, which is itself overridable via environment variable (see
below).

### `W3_FORGE_ROOT` standard

Every reusable admin script must define, at the top:

```bash
W3_FORGE_ROOT="${W3_FORGE_ROOT:-/opt/w3forge-deploy}"
```

Scripts must reference `$W3_FORGE_ROOT` everywhere they would otherwise
hardcode `/opt/w3forge-deploy`, including:

- locating app configs: `$W3_FORGE_ROOT/config/apps/<app_id>.yml`
- calling sibling scripts: `$W3_FORGE_ROOT/scripts/<script>.sh`

This makes the admin layer portable across environments and easy to test
without modifying scripts.

## v0.2.0 — Workflow Control Foundation

This section is appended for W3 Forge v0.2.0. It introduces the first
workflow orchestration layer over the v0.1.1 modular admin scripts.
v0.2.0 is inspection and validation only. It does not deploy, does not
tag releases, and does not move packages.

### Workflow

```text
inspect repo  -->  validate app  -->  show git state  -->  run safe tests  -->  summarize readiness
```

### Scripts and responsibilities

`scripts/w3-app-inspect.sh --app <app_id>`

Read-only repository and app inspection. Validates config first, then
prints app identity, config path, workspace path, current branch and
commit, remotes, the 5 most recent commits, changed files, the script
inventory under `$W3_FORGE_ROOT/scripts/`, the config inventory under
`$W3_FORGE_ROOT/config/apps/`, and workspace health. Never edits files.
Never deploys.

`scripts/w3-app-test.sh --app <app_id>`

Safe validation and test runner. Runs `w3-app-config-validate.sh` and
`w3-app-branch-check.sh`, then optionally runs commands declared under
`tests.commands` in `config/apps/<app_id>.yml`. The future-friendly
config shape is:

```yaml
tests:
  validate_config: true
  commands:
    - npm run lint
    - npm run build
```

If `tests.commands` is empty or absent, the runner prints
`No app test commands configured.` and exits 0. Any command containing
`deploy`, `release`, `tag`, `/opt/update-packages`, `rm -rf`,
`hardreset`, or `hard-reset` is refused by a blocked-command guard.
The runner prints a PASS / WARN / ERROR summary and exits nonzero on
ERROR.

`scripts/w3-app-workflow-status.sh --app <app_id>`

Single-pane workflow readiness summary. Aggregates config validation,
workspace and branch checks, git cleanliness, optional Ollama model
availability, and the app test runner. The final line is one of
`READY`, `WARN`, or `ERROR`.

### READY / WARN / ERROR semantics

READY requires:

- config validation has no errors
- branch check passes
- workspace is a git repository
- the current branch is not a blocked branch
- tests pass, or no tests are configured

WARN is emitted when:

- the working tree has uncommitted changes
- the workspace path is missing but the config is otherwise valid
- no app test commands are configured
- Ollama is missing, or no local models are available

ERROR is emitted when:

- the app config is missing
- a required config field is missing
- the branch check fails
- a blocked command is detected
- a configured test command fails

Exit codes from `w3-app-workflow-status.sh` are:

- `0` = READY
- `1` = WARN
- `2` = ERROR

### Authority boundary

v0.2.0 stays inside the W3 Forge proposal/development layer. It does
not deploy, does not tag releases, does not push to `main`, does not
merge into `main`, does not move packages into `/opt/update-packages`,
and does not modify persistent production data. W3 Core remains the
production deployment authority.

## v0.2.1 — Workflow Self-Test Polish

This section is appended for W3 Forge v0.2.1. It does not replace the
v0.2.0 section; it refines the workflow self-test surface so an app can
reach READY from its own configured tests.

### Safe self-test commands

An app may declare safe self-test commands under `tests.commands` in its
`config/apps/<app_id>.yml`. Recommended self-test categories:

- script syntax validation (e.g. `bash -n scripts/*.sh`)
- config inventory validation (e.g. `./scripts/w3-app-config-validate.sh --app <app>`)
- branch guard (e.g. `./scripts/w3-app-branch-check.sh --app <app>`)

Self-test commands must never deploy, release, tag, move packages, or
modify persistent data. The `w3-app-test.sh` blocked-command guard
refuses commands containing `deploy`, `release`, `tag`,
`/opt/update-packages`, `rm -rf`, `hardreset`, or `hard-reset`.

W3 Forge's own config declares the three commands above. W3 Core
intentionally ships with an empty `tests.commands` until safe
W3-Core-specific self-tests are designed.

### `require_local_model` opt-in

The `tests:` block accepts an opt-in flag:

```yaml
tests:
  validate_config: true
  require_local_model: false
  commands:
    - ...
```

When `require_local_model` is `false` or absent, missing Ollama or
missing local models are reported as OK (advisory) by
`w3-app-workflow-status.sh`. When `true`, they downgrade the final
state to WARN. This lets an app reach READY in environments without a
local model runtime while still allowing apps that depend on Ollama
to fail closed.

### Test runner output

`w3-app-test.sh` captures stdout and stderr from each configured
command and, on failure, prints the last 10 lines prefixed with `| `
so syntax errors and other diagnostics are immediately actionable.

### Authority boundary (unchanged)

v0.2.1 stays inside the W3 Forge proposal/development layer. It does
not deploy, does not tag releases, does not push to `main`, does not
merge into `main`, does not move packages into `/opt/update-packages`,
and does not modify persistent production data. W3 Core remains the
production deployment authority.

## v0.3.0 — Review Layer

This section is appended for W3 Forge v0.3.0. It introduces the review
layer on top of the v0.2.x workflow control foundation. The review
layer produces a structured, human-readable surface for a human
approver. It does not deploy and does not modify code.

### Scripts and responsibilities

`scripts/w3-app-diff-summary.sh --app <app_id> [--base <ref>]`

Read-only git diff summary between a base ref and HEAD for the app's
configured workspace. When `--base` is not provided, the base ref is
resolved in this order:

1. `origin/dev/v0.2.1`
2. `HEAD~1`

Prints app identity, workspace, current branch, base ref, changed
files, `git diff --stat`, the commit list between base and HEAD, and
the working tree state. Never deploys, tags, pushes, or edits files.

`scripts/w3-app-review-report.sh --app <app_id> [--base <ref>] [--output <file>]`

Composes a markdown review report containing:

- app identity and config path
- branch and commit
- workflow readiness result (READY / WARN / ERROR) and full output
- changed files between base and HEAD
- recent commits between base and HEAD
- collected warnings and errors
- working tree state
- explicit safety confirmation that the report run did not touch
  `main`, did not merge, did not tag, did not deploy, did not move
  packages, and did not modify production data

By default the report is printed to stdout. With `--output <file>` it
is also written to a file. The file path must resolve inside one of:

- `$W3_FORGE_ROOT/docs/reports/`
- `$W3_FORGE_ROOT/logs/reports/`

Relative paths are resolved against `$W3_FORGE_ROOT`. The script
canonicalizes the parent directory with `realpath`-equivalent
resolution and refuses any path that escapes the allowed report
roots, including paths constructed with `..`.

`scripts/w3-app-review-ready.sh --app <app_id> [--base <ref>]`

Final-gate readiness summary. Runs config validation, branch check,
workflow status, and diff summary, then emits exactly one of:

- `READY_FOR_REVIEW` — workflow status `READY`, working tree clean,
  branch matches `dev/vX.Y.Z`, tests configured
- `REVIEW_WITH_WARNINGS` — workflow status `WARN`, working tree dirty,
  or no tests configured
- `BLOCKED` — config validation failed, branch check failed, or
  workflow status `ERROR`

Exit codes are `0`, `1`, `2` respectively. The script is the single
entry point a Forge Admin UI or CI step should call to decide whether
a dev branch is ready for human review.

### State semantics summary

| State                  | Exit | Meaning                                                  |
|------------------------|------|----------------------------------------------------------|
| `READY_FOR_REVIEW`     | 0    | safe to hand to a human reviewer                         |
| `REVIEW_WITH_WARNINGS` | 1    | safe to review, but flagged concerns                     |
| `BLOCKED`              | 2    | a precondition failed; do not surface for review yet     |

### Authority boundary (unchanged)

v0.3.0 stays inside the W3 Forge proposal/development layer. It does
not deploy, does not tag releases, does not push to `main`, does not
merge into `main`, does not move packages into `/opt/update-packages`,
and does not modify persistent production data. W3 Core remains the
production deployment authority. The user owns the final release gate.
