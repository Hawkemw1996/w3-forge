# Factory execution - v0.4.7

The Requests page has a Factory execution panel. Start creates an immutable context from the queued FIFO request, project rules and all seven enabled profile/assignment revisions. Qwen/Ollama coordinates planning; the Specification Writer can request bounded repository files. The owner approves the saved specification before a developer runs. Forge applies structured text changes in a separate clone, commits the candidate, runs configured checks in Docker, then collects independent code, security, UI and UX verdicts for that commit. A failed check or CHANGES verdict can trigger two corrections, for three development attempts total.

Ready means a locally retained, tested and reviewed development commit with a downloadable text diff. It does not publish a branch, package, merge, tag or deploy. The owner reviews the candidate and uses the existing release process. Administrator-reported receipts remain separate from automated execution evidence.

## Operator activation

Deployment, migration 004 and runtime activation remain owner operations. Existing profiles stay at their current versions and assignments; startup never replaces them. No dependency was added.

1. Review config/execution.example.json and install the reviewed configuration at /etc/w3forge/execution.json. Use the exact canonical lowercase repository URL and owner-approved dev/vX.Y.Z branch configured for the project. Paths and commands cannot be supplied through the browser.
2. Provision the workspace root and a NONSECRET offline npm cache separately from application data and credential homes. Configuration, the workspace, source binding, cache roots and all parent directories must be owned by root with no group/world write access or symlinks. The source Git configuration must also be protected. Do not mount production node_modules, the Docker socket or CLI credential directories into tests.
3. Pre-pull the configured Node Bookworm image and prepare the npm cache for the exact package lock using an isolated trusted setup. Execution containers have no network access. Missing cache entries block installation; they never count as passing checks. Projects requiring generated or private build inputs must have those inputs available through an approved, nonsecret reproducible build setup before execution can succeed. W3 Forge's pinned shared console is such an input; a plain Git checkout does not contain the ignored generated console files.
4. Keep the existing forge-ai account and provider connections. Codex and Claude run with their native tools, MCP servers, slash commands and project settings disabled. Prompts travel through stdin. Forge brokers file access and changes; model text cannot become a host command. The protected runtime requires Linux, root service access to fixed Git/Docker binaries, and the existing non-root forge-ai identity.
5. Apply the additive migration through the normal reviewed migration command, deploy the development release through the existing owner gate, then restart Forge. Check AI Connections and all seven assignments. Start a small backend-only pilot request and review its specification before approval.

The service reports unavailable when configuration is missing or unprotected. Configuration changes require a restart. It reports a blocked run when repository identity, branch, dependencies, provider output or checks cannot be verified. No live installation or configuration is performed merely by deploying this source.

## Evidence and limits

A run freezes Markdown profile versions, checksums, provider/model selections, request revision, rules and base commit. Explicit model selections are used unchanged. Ollama's resolved default is recorded and reused for each role. A CLI default is labeled provider-default; its exact resolved identity is unavailable and is not guessed. Choose explicit model IDs when that reproducibility matters.

File context and edits are bounded. Traversal, Git metadata, secret-like paths, symlinks, submodules, binary changes and governance-file edits are rejected. The initial implementation supports bounded UTF-8 file replacements and deletion. A candidate diff must fit the durable evidence limit; split larger requests. Check output is bounded and sanitized. Tests use an exact commit copy without its Git metadata, non-root execution, no network, dropped capabilities, resource limits and no credentials.

Text-only UI/UX reviews cannot establish browser verification. A visual or interaction change stops for actual browser evidence and owner review even if other checks pass. The first automatic pilot should therefore change backend behavior only.

Cancel is a request until process-group and test-container cleanup is verified. A stale heartbeat fences the old worker, marks the run blocked and retains the global slot. Recovery checks recorded process identities and the deterministic container before unlocking retry; an unknown launch remains blocked for operator reconciliation. It never blindly restarts a job. Retry creates a new job and fresh specification approval using the original frozen context, while preserving the old evidence. Cancel a blocked run to release its slot after cleanup.

Candidate clones and immutable evidence are retained for review. The operator may inspect the job workspace on the protected host and fetch its development commit into a separate review checkout, or use the downloaded diff. Retention cleanup is an explicit operator task; it must not delete an active or unreviewed candidate.

## Rollback

Restore the prior application release through the normal release gate. Retain migration 004 tables, contexts, evidence and candidate workspaces. Do not reverse-migrate or delete persistent records. Stop and reconcile active workers before rollback or runtime reconfiguration. Existing manual workflows and profiles remain readable; an active automated request must be cancelled through its execution controls before manual mutation.

## Offline native-build correction - v0.4.8

The Node Bookworm execution container uses `NPM_CONFIG_NODEDIR=/usr/local`
so node-gyp builds against the headers bundled with its Node runtime rather
than trying to download headers without network access. The `/work` tmpfs
explicitly permits execution so dependency install scripts can run binaries
such as esbuild. Network isolation, non-root execution, dropped capabilities,
the read-only container root and the existing resource limits remain in place.

Operator verification must use both settings. Passing a manually corrected
container does not update the installed Forge runner: package and deploy the
corrected Forge source through the existing pipeline before starting jobs.
The selected image must contain matching Node headers, Python, make and g++.