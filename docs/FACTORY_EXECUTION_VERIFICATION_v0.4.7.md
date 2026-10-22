# v0.4.7 verification

Verified 2026-10-22 on dev/v0.4.7, based on v0.4.6 commit 0bc92bc397539e422df67002a86539dfb787ff2f.

- npm ci completed in a disposable Node 22.23.3 Bookworm container without production data or credential mounts. Dependency versions were preserved.
- npm run typecheck, npm test, npm run build and npm run console:verify passed.
- Automated tests: 291 backend, 113 frontend, 28 admin-script, 12 console-loader and 4 Test Dev integration tests: 448 total, zero failures.
- Added regressions cover global/FIFO concurrency, immutable profile context, expected revisions, owner specification approval, exact/latest commit evidence, two-correction bound, manual/automated control exclusion, cancellation, stale leases, retry history, Core authorization, same-origin enforcement, malformed provider output, path/credential rejection, offline prerequisite failures and reboot-safe identity comparison.
- Chrome checks against the production build passed for missing runtime, Start, explicit approval, safe Markdown, seven frozen profiles, cancellation pending cleanup, retry/new history, recovery lock, conflict refresh and exact diff download. Desktop 1440px and mobile 390px layouts had no horizontal document overflow or JavaScript errors. Existing Agents and AI Connections browser checks also passed.
- A separate real Docker pilot passed two isolation checks with network disabled, UID 1000, dropped capabilities, no-new-privileges, no Git metadata, no credential homes and no Docker socket. Its zero-dependency npm ci completed offline.
- Shared console remains v0.3.1 at 468e628ffaf43827c452d60371a8201c0125d3d8; all 120 generated files verified. The seven original v0.1.0 profile files and migration 003 remain unchanged.

## Verification boundaries

Execution engine tests use controlled model and workspace adapters; browser interaction tests use API fixtures. They prove workflow and UI behavior, not a live subscription-provider implementation run. The Docker pilot verifies the actual isolation policy separately. No live worker job, runtime configuration installation, migration or application deployment was performed.

Operator activation requires migration 004, the protected execution configuration, a suitable source binding, installed provider connections, a local test image and complete nonsecret offline build inputs. W3 Forge's ignored pinned shared-console source is an additional build prerequisite; a plain Git checkout alone cannot supply it. See [factory execution](factory-execution.md). Start with a small backend-only pilot. Visual work requires actual browser evidence and owner review.

Candidate source, model selections, test results and review verdicts remain inspectable in the execution history. Provider defaults whose actual model identity is unavailable stay explicitly labeled. Recovery records Linux boot identity alongside process identity and never signals a process from a previous boot. Unknown launches retain the worker slot until cleanup is verified.
