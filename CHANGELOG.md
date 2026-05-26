# Changelog

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
