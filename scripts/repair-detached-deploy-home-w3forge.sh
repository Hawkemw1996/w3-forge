#!/usr/bin/env bash
# Owner-approved native operator utility; no application code or deployment runs.
set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
usage() { printf '%s\n' 'Usage: repair-detached-deploy-home-w3forge.sh --apply'; }
if [[ $# != 1 ]]; then usage >&2; exit 2; fi
if [[ "$1" == --help ]]; then usage; exit 0; fi
if [[ "$1" != --apply ]]; then usage >&2; exit 2; fi
if (( EUID != 0 )); then printf '%s\n' 'Root operator required; no changes made.' >&2; exit 3; fi
umask 077
readonly target=/opt/w3forge-scripts/pipeline-deploy-dev-package-w3forge-ui.sh
readonly candidate=/home/forgeadmin/w3forge-deploy-home-fix/3871aeb0063e/pipeline-deploy-dev-package-w3forge-ui.sh
readonly expected_old=16260b32042debbe108585f7e07068833d6a14c4d42b0f4bfa3e65c9c77f3478
readonly expected_new=3871aeb0063e3f59b6c5f0e04f3093d3ee402653053c4acd2447dfb46a4cc274
fail() { printf 'Refused: %s\n' "$1" >&2; exit 3; }
for directory in / /opt /opt/w3forge-scripts /var /var/lib /var/lib/w3forge-test; do
  [[ -d "$directory" && ! -L "$directory" ]] || fail 'Invalid installation ancestor.'
  [[ "$(readlink -f -- "$directory")" == "$directory" ]] || fail 'Linked installation ancestor.'
  [[ "$(stat -c %u -- "$directory")" == 0 ]] || fail 'Installation ancestor is not root-owned.'
  mode=$(stat -c %a -- "$directory")
  (( (8#$mode & 0022) == 0 )) || fail 'Installation ancestor is writable by another account.'
done
[[ -f "$target" && ! -L "$target" ]] || fail 'Installed launcher is not a regular unlinked file.'
[[ "$(readlink -f -- "$target")" == "$target" ]] || fail 'Installed launcher path is linked.'
[[ "$(stat -c %u:%g:%a:%h -- "$target")" == 0:0:755:1 ]] || fail 'Installed launcher ownership, mode or link count differs.'
current=$(sha256sum -- "$target"); current="${current%% *}"
if [[ "$current" == "$expected_new" ]]; then printf '%s\n' 'Approved HOME repair is already installed; no changes made.'; exit 0; fi
[[ "$current" == "$expected_old" ]] || fail 'Installed launcher differs from the reviewed original.'
backup=$(mktemp -d /var/lib/w3forge-test/deploy-home-fix.XXXXXX)
install -o root -g root -m 0600 -- "$candidate" "$backup/fixed.sh"
printf '%s  %s\n' "$expected_new" "$backup/fixed.sh" | sha256sum -c -
bash -n "$backup/fixed.sh"
cp -p -- "$target" "$backup/original.sh"
printf '%s  %s\n' "$expected_old" "$backup/original.sh" > "$backup/original.sha256"
printf '%s  %s\n' "$expected_new" "$target" > "$backup/installed.sha256"
sha256sum -c "$backup/original.sha256"
staged=$(mktemp /opt/w3forge-scripts/.deploy-home-fix.XXXXXX)
trap 'rm -f -- "$staged"' EXIT
install -o root -g root -m 0755 -- "$backup/fixed.sh" "$staged"
printf '%s  %s\n' "$expected_new" "$staged" | sha256sum -c -
printf '%s  %s\n' "$expected_old" "$target" | sha256sum -c -
mv -fT -- "$staged" "$target"
sha256sum -c "$backup/installed.sha256"
printf 'Installed HOME=/root launcher repair. Backup: %s\n' "$backup"
printf 'Rollback: sha256sum -c %q %q && cp -p -- %q %q\n' "$backup/installed.sha256" "$backup/original.sha256" "$backup/original.sh" "$target"
printf '%s\n' 'No application deployment, service restart or database operation performed.'
