# Codex and Claude connections — v0.4.5

The Agents & AI page checks the installed Codex and Claude CLIs using the existing non-root Linux account forge-ai. Its default binding is automatic; W3_FORGE_AI_USER can select another existing non-root account in the protected service environment. Perplexity and Grok are excluded from the active service inventory. Ollama remains available for local chat and planning.

## What the page verifies

- CLI presence and a recognized version response.
- CLI-reported sign-in state, independently for each account. Sign-in checks do not invoke a model and are cached for 30 seconds, with concurrent reads shared.
- A manual **Test connection** action sends one fixed, short model request. It consumes account quota. A pass requires a successful completed response containing the expected token; nonzero exits, partial responses, unexpected output, timeouts and failed model turns fail the test.
- The last test result and its timestamp are held in the running Forge process. Restarting Forge clears them. A missing login or changed CLI/authentication method invalidates previous evidence. A previous pass is historical evidence, not a guarantee of current quota or network availability.
- Codex-labelled Docker containers are displayed separately as **Codex test environments**. They never establish provider authentication, model access or completed factory work.

The page distinguishes **Signed in**, **Sign-in needed**, **CLI not installed** and **Unavailable**. A signed-in account is not described as a running engineering worker. This update does not dispatch factory jobs or alter the request workflow.

## Host prerequisites

The owner has already installed and signed into Codex and Claude under forge-ai. Both executable entry points must exist at:

- /home/forge-ai/.local/bin/codex
- /home/forge-ai/.local/bin/claude

Forge derives the actual home from /etc/passwd. No credential contents are read by Forge, copied to root, returned to the browser, or added to environment files. The CLIs retain control of their credential stores and refresh behavior.

The existing root operational Forge service uses the fixed system runuser command to switch to the non-root account, including its group context. A service already running as that account runs directly. An unrelated non-root service account cannot impersonate it; the connection stays unavailable. No sudo grants or service-user changes are installed by this update.

Before changing any installation, the owner can check the existing login from the VM's root shell:

    su - forge-ai
    export PATH="$HOME/.local/bin:$PATH"
    codex --version
    codex login status
    claude --version
    claude auth status

Do not paste authentication files, API keys or login output containing personal details into chat or logs. Sign in again interactively when necessary; do not move the credentials into the application checkout.

## Execution boundary

Only the fixed version, status and test command argument sets are supported. The browser selects only Codex or Claude; it cannot provide a prompt, executable, Linux account, path or environment. Existing Core app-admin authorization, same-origin JSON enforcement and the standard API envelope apply to the new test endpoint.

Provider processes use an explicit scrubbed environment, shell:false, a disposable empty working directory, bounded output (128 KiB combined), and deadlines (10 seconds per local check, 60 seconds per model test). Timeout/output overflow terminates the subprocess group. One test per provider can run at a time, with a 30-second retry cooldown.

Codex's test uses read-only sandboxing, no approval escalation, ephemeral output, ignored user configuration, disabled shell tools/shell snapshots/apply-patch/apps/web search and empty configured MCP servers. Claude's test disables built-in tools, project/user/local settings, extra MCP servers, slash commands and session persistence; it requests a single turn. No permission bypass flags are used. If an installed CLI rejects these supported arguments, the test fails; Forge does not relax the restrictions. System-managed vendor policies still apply.

Raw CLI stdout/stderr, account email, model text and subprocess exceptions remain outside API responses. The response includes only recognized version/authentication categories, safe state messages and test timestamps. Tests do not accept project source or production credentials.

## Deploy and verify

Use the existing owner-operated Admin Console pipeline for dev/v0.4.5: Test Dev Branch, package and verify the selected development update, then deploy through the established backup/recovery gates.

No new application dependency, migration, database/schema change, shared-console pin change or live host configuration change is required. The standard root operational service can discover the existing forge-ai installation after deployment without adding an environment variable.

After deployment:

1. Open **Agents & AI** and confirm each provider reports its CLI version, Linux account and sign-in method.
2. Click **Test connection** for Codex, then Claude.
3. Confirm both show **Connection test passed** with current timestamps. A sign-in alone does not establish this result.

Rollback uses the previous application package through the existing pipeline. It leaves provider installations and their account logins in place. No provider data or database data should be deleted.

## Official command references

- https://developers.openai.com/codex/cli/reference
- https://developers.openai.com/codex/auth
- https://developers.openai.com/codex/config-reference
- https://code.claude.com/docs/en/cli-reference

Validation and remaining live-account checks are recorded in docs/AI_CONNECTIONS_VERIFICATION_v0.4.5.md.
