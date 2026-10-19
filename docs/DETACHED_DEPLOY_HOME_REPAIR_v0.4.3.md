# Approved detached deployment HOME repair — W3 Forge v0.4.3

Owner approval: 2026-10-19 (America/Chicago), for the fixed HOME=/root launcher binding and a backed-up installed launcher update. The application deployment remains an owner action in the existing pipeline.

## Confirmed failure

Request req_3ddb06423589d1fdc6c079898a94de5b launched its detached unit, then failed at the repository guard with exit code 3. The installed application stayed v0.4.2 with PID 1210 and its original start time. The configured credential-free origin is this Forge repository.

The owner ran the exact read-only Git command in three contexts: normal root environment succeeded; env -i PATH=/usr/bin:/bin failed with dubious ownership for /opt/w3forge-deploy; adding HOME=/root succeeded. The detached systemd worker omitted HOME, so Git could not read the root account's existing trust configuration.

## Change and scope

The only launcher behavior change is an explicit --setenv=HOME=/root argument to systemd-run. It does not inherit arbitrary caller HOME. Existing origin and effective fetch/push URL checks, exact Git trust configuration, launch properties, delegate arguments, deployment confirmations, backups, migrations and detached-result behavior are unchanged. No dependencies are added.

Changed files: the app-owned deployment launcher, its scripts/admin/console-provenance.json checksum, scripts/admin/tests/deploy-handoff.test.cjs, scripts/repair-detached-deploy-home-w3forge.sh, this guide and the approval record in AGENTS.md. Shared generated code is untouched.

## Owner installation command

The reviewed native operator utility verifies protected root-owned installation paths, the exact installed old SHA (16260b32042debbe108585f7e07068833d6a14c4d42b0f4bfa3e65c9c77f3478), and a protected copy of the candidate SHA (3871aeb0063e3f59b6c5f0e04f3093d3ee402653053c4acd2447dfb46a4cc274). It checks Bash syntax, saves the original with ownership/mode, installs via a same-directory atomic rename, verifies the resulting SHA and prints a checksum-guarded rollback command. A changed launcher blocks installation; the exact repaired launcher is an idempotent no-op. No application code, service restart, deployment or database command runs.

Run this from the existing Forge root Bash terminal:

```bash
install -o root -g root -m 0700 /home/forgeadmin/w3forge-deploy-home-fix/3871aeb0063e/repair-detached-deploy-home-w3forge.sh /root/w3forge-deploy-home-fix.sh &&
printf '90229c2be9fd61b99da171b53a2168599885f1c84606ca67f4a5cd008d72a15a  /root/w3forge-deploy-home-fix.sh\n' | sha256sum -c - &&
bash /root/w3forge-deploy-home-fix.sh --apply
```

The backup is under /var/lib/w3forge-test/deploy-home-fix.*. Use the printed rollback command before any later launcher update; it refuses to overwrite a subsequent update. This restores the original launcher and the HOME bug, without changing application code or data.

After successful helper installation, retry the same verified v0.4.3 deployment through the existing console pipeline. This host launcher repair does not require recreating the already verified application package solely to retry the deployment. The refreshed development branch/package includes the source fix for review; normal UI deployment does not install operational server scripts automatically, so keep this explicit helper repair separate.

The repair makes the worker read the same root Git configuration that passed the owner's diagnostic. Later deployment phases may expose another independent failure; review the worker log/trailer for the new request before retrying again.

## Validation

The focused tests execute the actual Bash launch command with systemd-run replaced by an argv recorder. They cover missing, root and unexpected caller HOME, require only the three explicit environment bindings, preserve nonblocking/timeout behavior and confirm delegate arguments with spaces remain single arguments. No system manager, guard, delegate or database operation is executed by the tests.

Passed: 350 tests with zero failures, skips or cancellations; type checking, build and the pinned 120-file shared console verification also passed.

Full validation command, run as the nonroot node user in the labelled isolated Node 22.23.3 container with no production mounts or credentials:

```sh
npm run typecheck && npm test && npm run build && npm run console:verify
```

The separate operator utility is checked with bash -n and a nonroot --apply refusal. Installation and any actual deployment require owner execution and are not claimed as complete by source validation.
