# Package Dev result repair — v0.4.3

The package operation for req_mvd3ktp8_pjzorgre built the fc1772d archive successfully with exit 0. Its final canonical trailer included an empty delegate_exit_code. The shared backend treats every present exit code as required evidence of numeric zero, so it correctly refused that malformed success trailer.

The app-owned emitter now omits an unset or empty optional delegate exit code. Every populated value is emitted unchanged. The shared parser, process exit, request identity, archive validation and deployment gates are unchanged. This is a result-protocol repair; packaging content, overwrite policy, service behavior, dependencies, auth and database behavior are unchanged.

## Installed helper repair

The live v0.4.2 service loads pipeline helpers from /opt/w3forge-scripts, so pulling source alone does not update this helper. The following owner command verifies a staged public helper in a protected root-owned copy, saves the installed original, and atomically replaces that one helper. It executes only native file operations and Bash syntax validation. It does not deploy application code, restart the service or run database operations.

Run from the existing root Bash terminal:

```bash
(
  set -euo pipefail
  umask 077
  target=/opt/w3forge-scripts/_w3forge-pipeline-common.sh
  for directory in /opt /opt/w3forge-scripts /var /var/lib /var/lib/w3forge-test; do
    test "$(readlink -f -- "$directory")" = "$directory"
    test "$(stat -c %u -- "$directory")" = 0
    mode=$(stat -c %a -- "$directory")
    (( (8#$mode & 0022) == 0 ))
  done
  test -f "$target" && test ! -L "$target"
  test "$(stat -c %u -- "$target")" = 0
  backup=$(mktemp -d /var/lib/w3forge-test/package-result-fix.XXXXXX)
  install -o root -g root -m 0600 /home/forgeadmin/w3forge-package-result-fix/53d57918d655/_w3forge-pipeline-common.sh "$backup/fixed.sh"
  printf '53d57918d65587fcbfef7490900b72c72f969aa6b802e96489c128b340d838a7  %s\n' "$backup/fixed.sh" | sha256sum -c -
  bash -n "$backup/fixed.sh"
  cp -p -- "$target" "$backup/original.sh"
  staged=$(mktemp /opt/w3forge-scripts/.pipeline-common.XXXXXX)
  trap 'rm -f -- "$staged"' EXIT
  install -o root -g root -m 0644 "$backup/fixed.sh" "$staged"
  mv -fT -- "$staged" "$target"
  printf 'Installed package result helper. Backup: %s\n' "$backup"
  printf 'Rollback: cp -p -- %q %q\n' "$backup/original.sh" "$target"
)
```

The command prints the exact backup and rollback paths. Rollback restores the prior helper; do it before any later owner deployment replaces the helper.

The previously reviewed Test Dev bootstrap and its immutable 9b6c13aae7ff bundle are unchanged. They continue to use their original hash-pinned common helper in a separate versioned directory. This packaging repair targets the stable installed helper only. A normal v0.4.3 application deployment also installs the repaired helper from this development branch.

## Next package

After the owner applies the helper repair, use Pull Latest on dev/v0.4.3, then Test Dev. The existing /opt/w3forge-update-packages/dev/v0.4.3/w3forge.tar.gz contains fc1772d, so creating a package for the new commit requires the existing explicit Force/overwrite option (the CLI flag is --force). Keep that existing archive if it is needed for review before choosing replacement. Then run Verify Dev Package. Do not deploy until the owner accepts those results.

## Verification

The new actual-Bash-emitter regression failed before the fix and passed afterward against the compiled shared parser. It covers two-trailer selection, absent/default/unset delegate exit codes, explicit zero, nonzero and malformed populated codes, raw empty-code rejection, failed status, nonzero process exit and request-ID mismatch.

Complete validation passed (347 tests, zero failures/skips/cancellations; type checking, build and 120-file console verification passed) in an isolated, labelled Node 22 container as the nonroot node user, with no production data or credentials mounted:

```sh
npm run typecheck && npm test && npm run build && npm run console:verify
```
