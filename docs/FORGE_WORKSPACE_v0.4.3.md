# Forge workspace and shared console v0.3.1

Development branch: dev/v0.4.3 (the existing approved next patch after the observed v0.4.2 runtime).

The product entry point is /forge/ and the root URL redirects there. /admin/ retains the canonical shared Admin Console. The console pin is 468e628ffaf43827c452d60371a8201c0125d3d8, version 0.3.1, manifest SHA-256 15c6279a0f6306bdd11b538ba01bbae047254db1e623cf0fe88e2c5032713d85. Generated console files are verified and ignored; no shared source is forked into Forge.

## Chat

GET /api/forge/models discovers installed models through Ollama /api/tags. qwen2.5-coder:14b is preferred when installed; otherwise the first installed model is selected. An empty model list and unavailable Ollama are distinct states. Models are never pulled or installed by the UI.

POST /api/forge/chat forwards bounded user/assistant conversation text to /api/chat and returns newline-delimited success/error envelopes. It requires an installed model, accepts at most 40 messages and 32,000 characters, permits one generation per backend, limits output to 65,536 characters/4,096 predicted tokens, and aborts after five minutes or a disconnected client. The stream first announces a server-generated request ID. Stop submits POST /api/forge/chat/:requestId/cancel, which cancels only that signed-in Core user’s current generation, and also aborts the browser stream. The UI exits immediately and ignores late chunks; the server aborts the upstream request independently of stream settlement. A missing final done event is an incomplete response. Partial replies are labeled incomplete and excluded from subsequent context.

Conversation history stays in the current browser tab's React state. No chat database, local storage, tool calls or executable actions were added. No credentials or application database content are added to the model prompt.

Optional server environment, read through the existing service environment loader:

- W3_FORGE_OLLAMA_URL: defaults to http://127.0.0.1:11434; only a credential-free HTTP(S) origin is accepted.
- W3_FORGE_OLLAMA_MODEL: defaults to qwen2.5-coder:14b.

The existing Core app-admin, network and same-origin guards protect all workspace APIs. Existing sign-in, roles, sessions and admin operations remain unchanged. Viewer/editor users receive the existing app-admin denial.

## Codex test environments

GET /api/forge/environments makes one bounded, read-only Docker Engine request through the existing host socket. W3_FORGE_DOCKER_SOCKET optionally selects a server-configured socket; the default is /var/run/docker.sock. The app does not provision socket permissions, change Docker configuration, install Docker, execute Docker commands or expose container management APIs.

Only containers with BOTH labels below are shown:

- w3forge.managed-by=codex
- w3forge.environment=test

Available metadata labels:

| Label | Meaning |
| --- | --- |
| w3forge.app | App under test |
| w3forge.branch | Source development branch |
| w3forge.commit | Exact source commit; omit for an uncommitted snapshot |
| w3forge.run-id | Optional correlated test run ID |
| w3forge.purpose | Short description of the check |

The dashboard displays container ID/name, image, creation time, state/status, port mappings and the labels above. It never returns container environment variables, commands, mounts, unrestricted labels or logs. It also displays active Forge pipeline-test progress from the existing shared action lock and sanitized progress protocol. Pipeline evidence remains scoped to this backend and is unavailable after restart; no durable test-success claim is inferred.

The browser refreshes every five seconds; the backend coalesces/cache-bounds Docker polls for three seconds. Failed refreshes suppress stale rows. Reachable empty inventory, Docker unavailable, and unregistered/other-host environments remain distinct. No current container does not mean no previous tests occurred, and a running/exited container does not prove tests passed.

### Requirements for Codex test runners

When Codex starts a disposable Docker environment on this Forge host, add the two required labels and source metadata at creation. Use a non-root container account, a disposable source directory, no production mounts or credentials, and a unique name. Omit the commit label for a dirty source snapshot; do not attribute uncommitted changes to a clean commit.

Example arguments for a runner already using docker run:

~~~sh
--label w3forge.managed-by=codex
--label w3forge.environment=test
--label w3forge.app=w3forge
--label w3forge.branch=dev/v0.4.3
--label w3forge.commit=<exact-committed-source-sha>
--label w3forge.run-id=<run-id>
--label w3forge.purpose=development-verification
~~~

Existing unlabeled containers and Codex cloud/laptop environments cannot be discovered through this local inventory. Register future local test containers as above. Do not broaden discovery to production containers. Removed ephemeral containers disappear from the inventory; reports and logs must be retained separately when historical evidence is needed.

## Release and rollback

This source change does not install privileged host helpers or deploy Forge. The observed production service was v0.4.2 and stayed untouched. Before the owner releases the v0.3.x Test Dev Branch integration, follow docs/TEST_DEV_BRANCH_INTEGRATION_v0.4.3.md and the shared host contract to provision distinct identities, protected roots and reviewed installed helpers. A new console pin alone is insufficient for upgraded privileged test wrappers. Do not enable a mismatched wrapper/worker pair.

Use the existing owner-controlled release/package/backup/deploy workflow after reviewing the development commit. No database migration or data backfill is introduced. Rollback is the previous reviewed Forge package and console pin through the existing recovery process. Optional workspace environment variables can be removed; there is no new persistent product data to undo.

Verification results are recorded in WORKSPACE_VERIFICATION_v0.4.3.md.
