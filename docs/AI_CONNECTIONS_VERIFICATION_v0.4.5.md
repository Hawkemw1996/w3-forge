# AI connection verification — v0.4.5

Target branch: dev/v0.4.5. Base: 60bdbe00f5f34b3bd9bf1275bee9180997885688 (dev/v0.4.4).

## Results

The complete validation gate passed in a disposable Linux container using Node 22.23.3 and npm 10.9.9 as UID/GID 1000. Only a disposable source/dependency directory was mounted. No production database, provider credentials or application configuration was mounted.

| Command | Result |
| --- | --- |
| npm run typecheck | PASS |
| npm test | PASS — 418 tests: 261 backend, 113 frontend, 28 operator-script, 12 console-integration, 4 Test Dev integration |
| npm run build | PASS |
| npm run console:verify | PASS — all 120 files at unchanged v0.3.1 revision 468e628ffaf43827c452d60371a8201c0125d3d8 |
| git diff --check | PASS |

After the final provider-card spacing/typography adjustment, frontend production build, all 113 frontend tests and console verification passed again. No tests were disabled or skipped. Initial failures in legacy service assertions were corrected to query the separately identified Codex test-environment observation rather than the new Codex account card.

New backend tests verify:

- Fixed non-root account and executable arguments, scrubbed child environment, empty working directory and cleanup.
- Independent CLI presence/sign-in states, recognized version responses, shared/cached checks and sanitized failures.
- A fixed model request requires actual successful completion; partial/error output cannot pass.
- Test cooldown and duplicate-request rejection; sign-out invalidates prior test evidence.
- Root/invalid account rejection and refusal to impersonate an account from an unrelated non-root service user.
- Real subprocess timeout and output limits, with ordinary nonzero exits treated as failed evidence.
- Core admin authorization, role revocation, cross-origin rejection, arbitrary-provider rejection and rejection of injected prompts/settings/paths/accounts before any provider test starts.

The real public Codex CLI 0.163.0 and Claude Code 2.1.307 were installed only inside a separate disposable non-root container. Their version/auth commands were recognized and correctly reported signed-out accounts. Both parsers accepted the fixed model-test argument sets with help output. No real provider credentials were supplied to these checks. This is CLI compatibility evidence, not authenticated inference evidence.

Chrome checks against the final production assets passed desktop (1440 px) and mobile (390 px): initial sign-in states, no automatic model request on page load, fixed empty POST payload, disabled duplicate button while testing, passing Codex result, failed Claude result, cooldown error, signed-out refresh invalidating a previous pass, no horizontal overflow and no page errors. Account/provider responses in this browser check were fixtures; they do not attest to the live accounts.

## Live verification remaining

SSH access as forgeadmin confirmed the forge-ai account exists. That SSH account cannot read or execute the protected forge-ai installation and cannot switch to it without a password. Access was not broadened and credentials were not copied or read.

After the owner deploys v0.4.5 through the existing pipeline, the root operational Forge service can perform the checks as forge-ai. The owner should run **Test connection** for Codex and Claude in **Agents & AI** and inspect their current results. No live provider model-access claim is made by this development pass.

## Scope

No new application dependencies, schema/migrations, Core authentication changes, shared-console pin update, production restart/deployment, release tag, main merge or live host configuration changes occurred. The new app-owned authenticated endpoint and non-root provider execution boundary are the source changes needed for these account checks. The factory's planning/development/test/review workflow remains unchanged.

Use the established pipeline to package and deploy this development branch. Rollback retains the provider installations, logins and all database data; restore the prior application package through the existing recovery process.
