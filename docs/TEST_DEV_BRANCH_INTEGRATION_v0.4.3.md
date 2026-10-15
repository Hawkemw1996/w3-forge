# Test Dev Branch integration — w3forge v0.4.3

Status: isolated Linux verification complete; ready for owner review with performance limitations. Not adopted or deployed. Branch: dev/v0.4.3. Starting app commit: 5de7b1b807cda421e867ea0eabde17cdb7d175c6.

## Change and adoption boundary

The owner approved the common v0.3.0 worker/progress/cache contract and this separate consumer integration on 2026-10-14. The app wrapper retains its original argument, confirmation, branch, logging and app-policy checks, then delegates to a separately installed trusted host supervisor. The wrapper execs the supervisor so its process remains alive through cleanup. A private inherited pipe cancels across privilege-switching sessions and also cancels on connection loss; it accepts no arbitrary process target. The supervisor verifies exact committed source and the console manifest, creates a credential-free snapshot, transfers it to a separate non-login build account and invokes the common worker after dropping privilege. It never runs npm or development code as root.

The worker performs one deterministic root workspace npm ci, declared lint and the complete existing npm test, including lifecycle hooks and database/shell/frontend checks. New refusal regressions are appended to the root test command. No existing test, command or assertion was removed. Cache reuse retains npm integrity checks and fresh node_modules. No application business logic, authentication, assignments, schema, dependency or deployment/promotion workflow was changed.

The console lock remains unchanged at af16fb7535a0e848eea35e5f5e2e2b2e8a90a5fa, version 0.2.0, manifest 700fa91e6145a6279e4e118a7e5972f1b4e3a635f82de12aec6ee7e7786816e7. This integration does not update a pin. The new wrapper fails closed until the owner separately adopts a reviewed v0.3.0 source pin and provisions the required non-secret bindings. Do not install the new wrapper alone on a live host. The current pin can still typecheck the additive adapter bindings; it does not implement the new progress contract or supply the worker.

## Operator-controlled host prerequisites

All prerequisites require owner review and installation; none was applied to a live app by this task.

| Binding | Requirement |
|---|---|
| W3_TEST_INSTALLATION_ID | Stable, unique non-secret ID for this app installation; required to enable adapter bindings |
| W3_TEST_BUILD_USER | Dedicated non-root system account, non-login shell, only its own primary group; no production/data/database privileges |
| W3_TEST_PRODUCTION_USER | Actual production service/data owner; must have a different UID |
| W3_TEST_SNAPSHOT_ROOT | Dedicated root-owned parent, mode 0711, root-owned ancestors without group/other write access; outside source/data/cache |
| W3_TEST_CACHE_ROOT | Dedicated build-account-owned mode 0700 directory, protected root-owned ancestors; outside source/data/snapshots |
| W3_TEST_NPM_CLI | Canonical root-owned host npm CLI file with protected ancestors; outside the snapshot |
| W3_TEST_CACHE_EPOCH | Optional safe generation ID; increment to invalidate cached content without modifying active generations |
| W3_TEST_OWNER_PID | Supplied by the common backend for each operation, never by an HTTP path/PID parameter |

Existing W3_ENV_FILE and W3_DATA_DIR bindings remain authoritative. The supervisor checks that the build account cannot read the protected environment or traverse production data. Every installed helper and its parents must be root-owned and not writable by other accounts. The existing installer copies the separately tracked helpers; a shared source-pin update never replaces these trusted executables implicitly.

The protected stable parent contains one private per-run envelope. After verified snapshot creation, the build account owns its inner parent so it can remove its snapshot; the root supervisor checks and removes the outer envelope. A leftover envelope blocks the next run for operator recovery. Normal failure, timeout, cancellation and backend loss terminate the worker's process groups and attempt identity-checked cleanup. Forced supervisor SIGKILL, host failure, resource budgets and real filesystem/database ACLs require host acceptance; an isolated source test is not proof of production recovery. Keep any owner supervisor/cgroup protections in place. Do not delete a leftover based only on build-writable metadata.

## Source integrity

Common helper source reviewed at w3-admin-console commit cbf990db49b40ad0c69d0b85b29f8f7f5e60c03d:

- scripts/admin/test-dev-host.cjs SHA-256: 4215aba6342a79aacf6e8cd569e1bb0e7331dda9326e9c564671e5776b2c442f
- scripts/admin/test-dev-snapshot.cjs SHA-256: 9e812438db80853bb75404cfdca312389b6fabbff4ea29bf942c0c40f58b6fcb

Propagate common helper fixes deliberately to all three consumers. The public admin-console.cjs loader is retained; generated common frontend/backend files remain ignored and are not app-owned forks.

## Verification and performance evidence

Run npm ci, npm run console:verify, npm run typecheck, npm test and npm run build in credential-free disposable snapshots. Run npm run lint only where declared. The complete root test command includes node --test scripts/test-test-dev-integration.cjs. The new cases exercise required host isolation, correlated configuration failure, the actual wrapper's main-branch refusal and trusted installer inventory.

The completed isolated Linux checks and measured wrapper timings are recorded below. Tests used only synthetic disposable databases and no host mounts. Source gates and app Test Dev Branch timings are different measurements.

No main/tag/package/deployment operation is authorized. Declining adoption preserves the existing installation. Review-only rollback is reverting this app integration through its development branch; do not change persistent data or invalidate another active operation's cache lock.

## Approved Test Dev parser boundary

The owner specifically approved the root Test Dev parser trust fix on 2026-10-14. Only this operation loads the existing YAML dependency from the separate deployed runtime after verifying canonical paths, root ownership and protected permissions for the complete package and its ancestors. Missing, writable, linked or non-root-owned inputs block execution. Other scripts and non-root checks retain their original resolution. Repository/capability checks still run before logging. No dependency version or production file was changed. Two added regressions cover overlap and unsafe file metadata; the positive root path is verified in the disposable Linux fixture with an operator-owned parser copy. The operator provenance ledger records the intentional installer/wrapper changes and exact common helper hashes; its checker is unchanged.

## Final isolated verification — 2026-10-14

Tested app code: 211da772866a35be140dbc3ac2c9e83287823398. Branch: dev/v0.4.3. Shared benchmark preview code: 2459468262ebbf111199aaef06ad3ab853d06a96; manifest ae32dd65e0d9f0237495babb60a999c2793c95c659d1d3249cb45fafaba9257b. Matched disposable preview fixture: ce550425f55a36c490376fbf604d11cb4ae403f2. Latest verified operator source: 58e985503b92a0f3e9542f8c93104ce539159595. The final app documentation commit contains reports only; its exact SHA is reported at handoff. Original admin-console.lock.json remains at af16fb7535a0e848eea35e5f5e2e2b2e8a90a5fa (0.2.0). No owner adoption or host installation was executed.

The complete current-pin checks were recorded at c2417088573d94d31f8f3b570985f9cdd3d54f72. Later request/inventory fixture and trusted operator changes were checked separately. Application business code and pins did not change. The preview uses the same complete root npm test through the real new wrapper and separate type/build gates, with no hook removal, retry or reduced assertion.

| Command | Seconds | Result |
|---|---|---|
| lint not declared | N/A | Not applicable |
| npm ci --include=dev --no-audit --no-fund --prefer-offline | 2.783 | Passed |
| npm run console:verify | 0.088 | Passed |
| npm run typecheck | 4.683 | Passed |
| npm test | 14.184 | Passed |
| npm run build | 4.370 | Passed |

Preview checks at the matched fixture revision:

| Command | Seconds | Result |
|---|---|---|
| npm ci --include=dev --no-audit --no-fund --prefer-offline | 2.814 | Passed |
| npm run console:verify | 0.091 | Passed |
| npm run typecheck | 4.735 | Passed |
| npm run build | 4.443 | Passed |

The new cold and warm wrappers both passed 323 reported Node/Vitest tests, zero failed/skipped, including all existing backend/frontend/database/shell/operator gates declared by this app. The existing app repository/capability and operator-script parity checks remain. The specific root parser trust change was separately approved; protected fixture positive/writable/foreign-owner/link cases pass. The root test command retains node --test scripts/test-test-dev-integration.cjs. BuildCost/Forge request fixtures validate either the old exact payload or the required v0.3.0 request ID according to the immutable pin.

| Condition | Old wrapper seconds | New wrapper seconds | Measured change |
|---|---|---|---|
| cold | 17.409 (failed) | 20.150 | Not comparable |
| warm | Not run | 19.643 | Not comparable |

These are single-sample, sequential, credential-free Linux fixture measurements with Node 22.23.3/npm 10.9.9, four CPUs, 8 GiB and no host mounts. Before/after use the same app/preview SHA and exported original wrapper. Cold means an empty private npm cache, not flushed registry/OS caches. Books' old second run still deletes its cache. The table labels relative regressions explicitly. The old wrapper fails three existing canonical isolation assertions because its guard exports operational bindings into tests. It does not provide a passing full-suite timing baseline; warm before was not repeated to conceal that failure. A substantial app-wide speedup is not demonstrated. The shared repository source-gate timer fix is a separate 301.56-to-5.94-second result. No app test gate was weakened to improve these values.

Actual progress from all six new app runs was accepted by the backend parser with complete counts and cleanup. Representative real wrapper interruption/backend-loss checks failed nonzero, removed snapshots and left no live build descendants. All app test containers and temporary source/database files were removed after local redacted evidence collection. No production credentials/data/configuration, Core, release package, main/tag, deployment or promotion was changed. No new dependency was added. Existing current pins across apps differ; deployed console parity awaits explicit owner adoption.

Performance acceptance remains open. Remaining owner gates include distinct real build/service identities, filesystem/database ACLs, cache retention/resource budgets, private-source access, forced-kill/host-failure recovery and live service/browser acceptance. Preserve the existing installation until the owner adopts the reviewed common SHA and provisions/installs the matching trusted helpers together.

Exact benchmark command: bash <isolated-script-dir>/pipeline-test-dev-branch-w3forge-ui.sh --yes --request-id fixture-w3forge-<condition> --source cli. Full commands/exits/counts/resources and the failed diagnostic history are in the shared TEST_DEV_BRANCH_BASELINE/RESULTS/MEASUREMENTS_v0.3.0 reports and ignored local evidence.

## Changed files from the approved app base

- AGENTS.md
- CHANGELOG.md
- VERSION
- backend/package.json
- backend/src/adminConsoleAdapter.ts
- config/apps/w3forge.yml
- docs/TEST_DEV_BRANCH_INTEGRATION_v0.4.3.md
- frontend/admin/package.json
- frontend/admin/tests/pipelineOverrides.test.mjs
- package-lock.json
- package.json
- scripts/admin/_w3forge-policy.cjs
- scripts/admin/console-provenance.json
- scripts/admin/install-server-scripts.sh
- scripts/admin/pipeline-test-dev-branch-w3forge-ui.sh
- scripts/admin/test-dev-host.cjs
- scripts/admin/test-dev-snapshot.cjs
- scripts/admin/tests/testDevTrust.test.cjs
- scripts/test-test-dev-integration.cjs

The measured operator revision was 7bfb82236ccd247d84c9e04a27fdd4193dd07eaa. The final verified operator revision 58e985503b92a0f3e9542f8c93104ce539159595 adds protected-binary/offline Git reads; both use the same private cancellation pipe. The benchmark and final shared source have the identical 122-file manifest above. Final operator/current-pin inventory and parity checks passed separately; the measured timings are not relabeled as different executable bytes.
