# Forge v0.4.1 shared authentication standard

Date: 2026-10-06. Branch: `dev/v0.4.1`. This follow-up is based on application-foundation commit `04d5db281824516d1d903bb500c188041dcba1af` and implements the user's shared W3 authentication requirement recorded in the workspace `AGENTS.md`. The commit containing this report is the review unit; no release or live activation was performed.

## Alignment

| Requirement | Forge behavior |
| --- | --- |
| Discovery and heartbeat | Announces at startup, every 60 seconds and before sign-in with app ID, stable instance UUID, public origin, exact callback, version and installation credential. |
| Owner pairing | A unique installation credential and visible fingerprint support Core owner approval. Pairing, enabling sign-in and assigning individual access remain separate. |
| Core identity and 2FA | Browser-bound authorization code and S256 PKCE redirect sign-in to Core. Forge adds no local passwords or user database. |
| App assignments | Every protected request validates the Core app session and explicit app role. The current administrative console requires app-admin; viewer/editor business routes remain future work. Platform roles do not substitute. |
| Session protection | Browser session tokens are hashed. Core app tokens are sealed with AES-256-GCM in bounded server memory using a distinct Forge session-encryption secret. |
| Revocation and logout | Core revocation, removed assignments and disabled/deleted apps stop access. Local logout removes state before requesting Core app logout. Core outages never permit stale authorization. |
| Rotation | Installation-secret rotation uses Core's owner workflow. A changed local encryption key makes existing seals unusable; restart clears local sessions. Existing terminals lose authorization and close. |
| Service access | Pairing, session encryption and optional scoped Core resource credentials must differ. A service token never signs a browser into the console. |

The audited protocol already matched BuildCost. This patch addresses the remaining gap: Core app-session tokens had previously been stored unencrypted in server memory. It adds authenticated encryption, rejects missing or reused secrets before sign-in, and displays an actionable setup message.

## Setup and operational effect

Set `FORGE_SESSION_SECRET` in the launcher's existing protected environment to a newly generated random value of at least 32 characters. It must differ from `CORE_APP_CLIENT_SECRET` and any `CORE_SERVICE_TOKEN`. No actual secrets were generated, copied or committed by this patch. `.env.example` is a reference; the backend does not automatically load it.

The new secret is required before signing in. A missing, invalid or reused secret deliberately disables login. Keep the same secret across normal restarts, and rotate it when all local sessions should end. Sessions remain in memory and already end on restart. No persistent session migration is required.

Do not roll back this follow-up solely to remove the configuration requirement: the preceding commit lacks encryption of in-memory Core tokens. Correct the protected configuration and restart through the established owner-operated process. Review the full Core sign-in, owner pairing, assignment removal, outage and logout flow in Linux before release.

## Verification

Commands were run from the Forge repository on Windows with the existing workspace npm shim available on PATH.

| Exact command | Result |
| --- | --- |
| `npm.cmd run build --prefix backend` | Passed. |
| `npm.cmd test --prefix backend -- sessionCrypto.test.ts coreAuth.test.ts terminalRoutes.test.ts` | Passed: 26 tests. |
| `npm.cmd test --prefix backend` | Failed: 103 passed, 2 failed, 105 total. Both failures are the existing safeRunner Bash-script spawn tests on Windows (`spawn EFTYPE`). |
| `npm.cmd run typecheck --prefix frontend/admin` | Passed. |
| `npm.cmd test --prefix frontend/admin` | Passed: 19 tests. |
| `npm.cmd run build --prefix frontend/admin` | Passed. |
| `git -c core.autocrlf=false diff --check` | Passed. |

The two backend failures are `runControl — happy path against stub scripts > runs config-validate stub` and `runControl — happy path against stub scripts > runs review-report with optional base ref as separate argv element`. The safeRunner implementation and its checks were not weakened, bypassed or skipped. Linux verification remains outstanding; the local machine has no installed WSL distribution.

New checks cover random authenticated ciphertext, malformed/tampered seals, wrong keys, cross-app key separation, distinct credentials, refusal before a Core exchange when configuration is invalid, validation/logout decryption, session invalidation after key rotation, terminal closure and the setup UI. An independent read-only review found no blocking correctness or security issue.

Full test logs are in the workspace task output directory `outputs/01a113b1-6aab-76f1-8141-b9b3e2f3410b/`: `auth-parity-backend.log` and `auth-parity-frontend.log`.

## Changed files

- `.env.example`
- `CHANGELOG.md`
- `backend/src/admin/routes/connectionsRoutes.ts`
- `backend/src/auth/coreAuth.ts`
- `backend/src/auth/sessionCrypto.ts`
- `backend/src/index.ts`
- `backend/test/connections.test.ts`
- `backend/test/coreAuth.test.ts`
- `backend/test/coreFixture.ts`
- `backend/test/sessionCrypto.test.ts`
- `backend/test/terminalRoutes.test.ts`
- `docs/APP_FOUNDATION_v0.4.1.md`
- `docs/CORE_CONNECTION_v0.4.1.md`
- `docs/SHARED_AUTH_STANDARD_v0.4.1.md`
- `frontend/admin/src/components/CoreAuthGate.tsx`
- `frontend/admin/tests/console.test.mjs`

## Scope and review status

Authentication, session/token/secret handling, readiness display and the required environment configuration were changed to implement the user's explicit shared standard. Regression tests were added. No new dependencies were added or proposed in this follow-up. No database, schema, migration, seed data, persistent business records, deployment scripts, service units, ports, backup/restore/status scripts, linting, CI, required checks or merge gates were changed by it.

Only Forge was edited; Core, BuildCost and CleanBooksAI were reference/context repositories. The earlier admin/GitHub/terminal foundation remains documented in [its verification report](APP_FOUNDATION_VERIFICATION_v0.4.1.md). Chat, the n8n interface and additional business automation screens remain the next application phase.

The development branch is ready for user review with the Windows test limitation disclosed. It is not a production-readiness claim. Main, tags, release packages, live configuration, pairing and production deployment remain owner-controlled.
