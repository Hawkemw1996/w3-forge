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
