# Forge v0.4.1 — Core access and current admin console

Forge now requires Core v0.12.16's app-bound sign-in contract in addition to its existing network guard. All admin routes, including logs, files and controls, require an explicit **admin** assignment for `w3forge`. Core platform roles do not substitute for that assignment. Viewer/editor assignments do not open this administrative console; Forge has no separate business-user interface.

## Connection setup (owner operated)

Review/deploy Core v0.12.16 and its additive registry migration first. Set `CORE_API_URL` to the server-reachable Core origin, `CORE_PUBLIC_URL` to Core's browser-visible origin and `FORGE_PUBLIC_URL` to Forge's browser-visible origin. Origins cannot contain path prefixes, credentials, queries or fragments. Use HTTPS with secure cookies for browser access.

Generate one stable installation credential with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` and one instance UUID with `node -e "console.log(require('crypto').randomUUID())"`. Set `CORE_APP_CLIENT_SECRET` and `CORE_APP_INSTANCE_ID` in the existing launcher/service environment. The backend does not load `.env` automatically; `.env.example` is a configuration reference only. These secrets are excluded from the safe runner's child-process environment.

Forge announces on startup, every minute and before sign-in. The Core owner must compare the pending candidate's fingerprint with the one shown on Forge's login screen, approve it, enable **Allow W3 sign-in**, and assign a user the Forge **admin** role. Discovery does not authorize the app. The exact callback is `<FORGE_PUBLIC_URL>/api/auth/callback`. Credentials must remain stable across restarts; changing them requires owner-managed rotation/re-pairing. Deleted registrations do not return automatically.

The browser signs in on Core, including password and 2FA. Forge exchanges a one-use code using S256 PKCE, exact callback and its server credential. Core returns an opaque app session and the minimal identity (ID, username and app role); optional email is not exposed by Forge. This is a custom app-bound handoff, not a full OIDC implementation. A separate API service token or resource grant cannot authenticate this console.

## Session behavior

A five-minute HttpOnly/SameSite=Lax cookie binds pending login to one browser. The browser then receives only an opaque Forge session cookie, with its hash held server-side. Core app tokens stay in bounded server memory, never in the browser or on disk. Sessions last at most eight hours and all end when Forge restarts. `COOKIE_SECURE` defaults to true; false is for a deliberate local HTTP test only.

Every protected request verifies the app session against Core. Core outage returns 503 with no stale-authority fallback. Removing the app/user assignment, disabling sign-in or rotating the credential stops access on the next request. An already-started control is not retroactively canceled. Sign-out destroys only the app session; the Core browser login remains independent. Mutations require same-origin JSON. Auth callback queries and credentials are not written to the admin audit; admin audit entries include the verified actor.

## Console parity

Source reference: Core `dev/v0.12.16`, commit `b4770a51dc2a25e78f5b6e6ec3d577cbd6f334f7`.

- Current shared W3 sidebar, badge, design tokens and primitive styles copied with provenance under `frontend/admin/src/shared`.
- Current pinned desktop sidebar/header, mobile drawer, environment badges, signed-in username and sign-out footer.
- Forge GitHub Validation view displays its existing configured workspace/branch status and links to the existing registered Controls checks. This is local workspace validation, not a new remote GitHub checks API.
- Existing Controls, File Browser, logs, system and settings remain Forge-specific. Safe-runner allowlists, argument validation, `shell:false` and authority limits are retained.

Core's production package/deploy/backup/setup/Command Center features and terminal are not added to Forge: these need separate backend capabilities/authority, and the terminal would add dependencies. This update brings the applicable current admin interface while preserving Forge's engineering scope.

## Rollout, risks and rollback

No live deployment, migration or pairing was performed. Configure and pair before directing users to the updated console; missing configuration intentionally prevents administrative access. Keep operator access to the existing service configuration so an origin/credential mismatch can be corrected outside the locked console.

Review browser sign-in, admin access, a removed assignment, an outage and sign-out before release. Reverting code to v0.4.0 restores network-only administrative access; review that weaker policy before any rollback. There is no Forge schema or persistent business-data change. Source builds use the existing separate backend and frontend/admin package layout and existing launcher.
