# W3 Forge application foundation — v0.4.1

Development branch: `dev/v0.4.1`. This change builds on the existing Core sign-in and material-pricing service. The user owns release and live activation.

## Included

- Root URL opens the Forge workspace, using the established W3 admin layout.
- Core app-admin access protects dashboard, connections, GitHub, terminal, files, logs and controls.
- GitHub Validation shows the configured repository, local branch and commit, local tracking counts, working changes and allowed development branches. Check connection performs a bounded, noninteractive, read-only GitHub check using the host's existing credentials. Counts reflect local tracking refs, not a fetch. No credentials are entered into this UI.
- Settings & Connections shows safe configuration readiness for Core, GitHub, terminal, the existing Lowe's/Apify material-pricing service, Ollama and an optional n8n instance link.
- Terminal ports BuildCost's xterm/native PTY behavior to Forge's Core identity. It supports output, input, resizing, clear, interruption, reconnect and disconnect.
- Optional systemd service template starts the app as the existing `forgeadmin` account, keeps it running across reboots, reads a protected environment file, and kills remaining terminal children when the service stops.
- Existing pricing configuration accepts the installed `qwen2.5-coder:14b` tag as well as `qwen2.5:<tag>`. No model is selected, downloaded or invoked automatically.

The Forge chat window, embedded/API-driven n8n interface and other business automation screens are explicitly marked planned. The material-pricing backend already exists; its credentials, live collection and Forge-specific user interface remain separate activation/application work.

BuildCost's production packaging/deploy/backup pipeline is not copied. Forge's registered authority continues to disallow production deployment, release tags and production-data mutations.

## Terminal access and limits

Set `ADMIN_TERMINAL_ENABLED=true` on a Linux host to enable the terminal. Default is disabled. Requires `node-pty@1.1.0`, an active Core session and the Forge admin assignment. Requests require the terminal-specific header and same-origin checks against `FORGE_PUBLIC_URL`. Core outage, logout, expired login or revoked assignment closes access, including an idle terminal and a held output read.

One terminal per browser login, at most two per user and four total; bounded output; 15-second disconnected-client cleanup; idle/lifetime limits are inherited from BuildCost. Audit records opening/closing and request metadata, never shell input/output or root passwords. PTY children receive a minimal environment without service tokens.

The service template runs as `forgeadmin`, so terminal connection opens `su --login root` and the operator enters the host root password directly into the terminal. When an installation runs the backend as root, it opens a direct root shell instead. Interactive terminal commands have the resulting operating-system permissions and are not restricted by the automated-control allowlist. The existing `safeRunner` continues to govern registered controls.

Frontend additions: `@xterm/xterm@6.0.0`, `@xterm/addon-fit@0.11.0`. Backend addition: `node-pty@1.1.0` (and its `node-addon-api@7.1.1` dependency).

## Observed host state (October 6, 2026)

Read-only inspection of SSH host `w3forge` found:

- Checkout: `/opt/w3forge-deploy`, owned by `forgeadmin:forgeadmin`.
- Branch `dev/v0.4.0`, commit `6b3ab01`, VERSION `0.4.0`.
- One local configuration change: `admin_console.listen_host` changed from `127.0.0.1` to `0.0.0.0`. Preserve it intentionally during upgrade.
- No Forge systemd unit found and no response from `http://127.0.0.1:8765/health`.
- Ollama active, with `qwen2.5-coder:14b` installed.
- Node, npm, Git, Bash and su available.

No live files, service settings or credentials were changed.

## Owner activation sequence

1. Review the development commit and complete Linux verification, including a real PTY open/input/resize/disconnect and revoked-session check, in an isolated checkout. The Windows results and known shell-test limitation are in the verification report.
2. Back up the live checkout and its local YAML difference. Fetch `dev/v0.4.1` and move the Forge checkout to the reviewed commit, preserving the local listen-host change. Do not reset the working tree or overwrite its configuration. Stop and resolve any checkout conflict explicitly.
3. In the reviewed checkout run:

   ```bash
   npm ci --prefix backend
   npm ci --prefix frontend/admin
   npm run build --prefix backend
   npm test --prefix backend
   npm run typecheck --prefix frontend/admin
   npm test --prefix frontend/admin
   npm run build --prefix frontend/admin
   ```

4. Create a root-owned `0600` `/etc/w3forge/admin.env` based on `.env.example`, using the actual browser-visible origins. Configure a unique `FORGE_SESSION_SECRET` (32+ random characters) separate from `CORE_APP_CLIENT_SECRET` and any `CORE_SERVICE_TOKEN`. Keep any existing pairing credential and instance ID stable; if this installation has never been paired, generate them on the host. Use Core's registration approval and Forge admin assignment workflow described in `CORE_CONNECTION_v0.4.1.md`. Do not paste secrets into chat.
5. Set `ADMIN_TERMINAL_ENABLED=true` when enabling operator terminal access. Because the host YAML binds all interfaces, explicitly set `ADMIN_ALLOW_NON_LOOPBACK=1` only for the intended internal network; retain the IP allowlist. Use HTTPS with `COOKIE_SECURE=true`. The existing IP guard and sign-in rules are retained.
6. Optionally set `W3_FORGE_N8N_URL` to an existing credential-free n8n URL. This creates a link, not an n8n API integration. Set `W3_FORGE_MATERIAL_PRICING_OLLAMA_MODEL=qwen2.5-coder:14b` to select the installed model for future advisory matching. Keep material pricing disabled until its separate Apify/shared credentials, durable ledger and spending limits are configured and approved.
7. Review and install the service template (these are live activation commands, not run by this change):

   ```bash
   sudo install -m 0644 config/systemd/w3forge-admin.service /etc/systemd/system/w3forge-admin.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now w3forge-admin.service
   curl --fail --silent --show-error http://127.0.0.1:8765/health
   ```

8. Sign in through Core, confirm the paired installation and admin assignment, then exercise GitHub connection check and Terminal. Check Settings for configured vs unavailable services. Do not enable paid price collection merely to check the admin foundation.

## Rollback

Disable the terminal immediately with `ADMIN_TERMINAL_ENABLED=false` and restart the Forge service if necessary; this terminates PTYs. For code rollback, stop the new service, restore the preserved checkout/config and use the prior startup method. Do not casually revert to v0.4.0's weaker network-only admin access. The session-encryption change requires a new distinct `FORGE_SESSION_SECRET` on initial activation. Rotation/restart signs users out. No database schema/migration or production-data changes are part of this update. Keep the separate material-pricing ledger outside source checkouts and backups of pairing credentials protected.
