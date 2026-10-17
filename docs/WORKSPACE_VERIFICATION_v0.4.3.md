# Forge workspace verification — v0.4.3

Branch: dev/v0.4.3. Base commit: 55ff3d80277d8c1d0f99f3ccc548b896fc132fce.
Shared Admin Console: v0.3.1, immutable revision 468e628ffaf43827c452d60371a8201c0125d3d8.
Manifest SHA-256: 15c6279a0f6306bdd11b538ba01bbae047254db1e623cf0fe88e2c5032713d85 (120 files).

## Result

The complete declared application gate passed in a disposable Node 22.23.3 Bookworm Linux container on the Forge test host. Tests ran as the non-root node account with dropped capabilities, no added privileges, bounded CPU/memory/processes, a disposable source directory, and no production mounts or application credentials. Existing locked dependencies were installed with npm ci --no-audit --no-fund.

| Check | Result |
| --- | --- |
| npm run typecheck | Passed |
| npm test: backend | 210 passed, 18 files |
| npm test: frontend | 105 passed |
| npm test: app policy/service scripts | 13 passed |
| npm test: shared consumer contracts | 11 passed |
| npm test: trusted test-host integration | 4 passed |
| Total tests | 343 passed; zero failed, cancelled or skipped |
| Console parity check | Passed |
| npm run build | Passed |
| npm run console:verify | Passed; all 120 pinned files verified |
| git diff --check | Passed |

The initial adoption run exposed two obsolete consumer tests for the shared console's removed manual source-update panel. The exact v0.3.1 canonical consumer regressions replace those retired workflows with source-removal and guarded-404 checks. Unrelated assertions and gates remain enabled.

Real browser testing exposed stream-cleanup races that unit-only closed-stream fixtures missed. The final implementation releases completed generations before announcing completion, does not wait on stalled cancellation promises, explicitly cancels an admitted user-owned request, releases the browser UI immediately, and ignores late chunks from stopped generations. New regressions cover stalled cancellation, active-read abort, disconnection, concurrent generation refusal, request ownership, and subsequent model reuse.

## Browser and real-host checks

A fresh headless Chromium review session used the actual built product assets, a temporary loopback-only test identity, the real local Ollama server, and the actual bounded Docker inventory. The temporary identity exists only in the disposable review helper; product Core authentication remains unchanged.

- Installed model discovered: qwen2.5-coder:14b, approximately 9 GB, reporting 14.8B parameters.
- Real initial chat completed with the requested response.
- Real consecutive replies completed without a stuck busy slot.
- A long real generation was stopped while streaming; the UI immediately marked its partial reply incomplete.
- Immediate retry and a subsequent follow-up completed with the requested responses.
- Actual labeled test containers appeared with their real image, state, timestamps, branch and container ID. Dirty snapshots correctly omitted commit attribution.
- Desktop 1440 × 1000: both panels visible, no horizontal overflow.
- Mobile 390 × 844: chat/environment navigation switched panels, no horizontal overflow.
- No browser JavaScript errors were observed.
- Inventory failure/empty distinction and escaped container metadata are covered by frontend/backend regressions.

Core session, role, origin, revocation, migration/audit semantics, operator-script policy, private-source parity and all existing app suites remained in the full test command. No live production user session, deployment, backup/restore acceptance or privileged test-helper installation was performed.

## Scope and release boundary

The live Forge service was observed at v0.4.2 and was not modified or restarted. No production environment file, secret, database, schema, data, service definition or installed operator helper changed. No new dependency was added. No main branch, tag or production package was created.

The active Forge pipeline view uses the existing bounded in-process progress protocol. Docker discovery covers labeled Codex test containers on this host. It does not discover arbitrary laptop/cloud environments, retain removed-container history, or infer test success from container exit state.

The upgraded privileged Test Dev Branch integration still requires the owner's reviewed helper installation and protected host provisioning described in docs/TEST_DEV_BRANCH_INTEGRATION_v0.4.3.md. Source verification does not perform that operational acceptance.

See FORGE_WORKSPACE_v0.4.3.md for configuration, label registration, release and rollback details.

## Host pipeline path-alias regression

The owner pipeline at commit 76ea63a reported three failures in canonicalConsole.test.ts while all 105 frontend tests passed. The fixture set W3_SCRIPTS_DIR and W3_LOG_ROOT but inherited higher-priority W3_SCRIPT_DIR and W3_LOG_DIR from the running console. Controls resolved the host script directory and the recent-log route inspected the host log root.

A disposable non-root container reproduced all three failures with injected script/log aliases and a synthetic pipeline log. Adding both aliases, plus the legacy W3LOG_ROOT alias, to the existing fixture setup made the same focused command pass all 22 tests. The existing vi.unstubAllEnvs cleanup restores the caller environment; no assertion, test, product path precedence or host configuration changed.

The complete gate was then repeated with W3_SCRIPT_DIR=/opt/w3forge-scripts, W3_LOG_DIR=/opt/logs/w3forge and W3LOG_ROOT=/opt/logs/w3forge injected into a disposable Node 22.23.3 Bookworm container (non-root, no production mounts/credentials). Command: npm run typecheck && npm test && npm run build && npm run console:verify. Result: all 343 tests passed, plus type checks, build, parity and all 120 pinned console files. The deliberate pre-fix reproduction failed three of 22 focused tests; the fixed focused run passed 22 of 22.
