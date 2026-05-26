# W3 Forge — Review Reports

This directory holds review reports produced by the W3 Forge v0.3.x
review layer:

- `scripts/w3-app-review-report.sh --app <app_id> --output docs/reports/<name>.md`

## These are local artifacts

Reports written here are **local artifacts**, not source. They are
ignored by git via `.gitignore`:

```text
docs/reports/*
!docs/reports/.gitkeep
!docs/reports/README.md
```

Only this `README.md` and the `.gitkeep` placeholder are tracked.
Anything else generated into this directory will not appear in
`git status` and will not dirty the working tree.

This is by design. v0.2.x workflow control and v0.3.x review readiness
explicitly treat report artifacts under `docs/reports/` and
`logs/reports/` as expected output. They never downgrade workflow
status to `WARN` or review readiness to `REVIEW_WITH_WARNINGS`.

## Promoting a report

If you want to commit a specific report into version control — for
example, to attach it to a release notes branch or share it through
the repo — do **not** force-add it from `docs/reports/`. Instead:

1. Copy or move the file out of `docs/reports/` to a tracked
   location, such as `docs/releases/<vX.Y.Z>/review.md`.
2. Add and commit it in the normal way on a `dev/vX.Y.Z` branch.

This keeps the default `docs/reports/` directory disposable while
still allowing intentional, explicit promotion.

## Safety reminder

Generating a report is read-only and does not deploy, tag, push, or
modify production data. The output-path guard in
`w3-app-review-report.sh` restricts `--output` to
`docs/reports/` and `logs/reports/` under `$W3_FORGE_ROOT`, with
realpath canonicalization to defeat `..` traversal.
