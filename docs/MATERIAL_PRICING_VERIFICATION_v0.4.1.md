# Material pricing implementation verification — v0.4.1

Active branch: `dev/v0.4.1`. Implementation starts from
`d4577680cbbadbd53bba20192f4212e6eb3a9bf3`, confirmed as the matching GitHub
branch head before editing. The delivery commit is recorded in the handoff.

## Implemented scope

Default-disabled, dedicated service-token endpoints collect bounded Lowe's
observations for ZIP 49221/store 0088 and compare supplied candidates with the
configured local Qwen2.5 model. BuildCost owns confirmation and accepted costs.
The caller's spending ceiling is binding; the smaller caller/server ceiling is
reserved before a paid start. Durable request identities and uncertain-start
handling prevent automatic duplicate paid requests. No scheduler was added.

The user explicitly approved secure Apify/Ollama configuration and this
controlled workflow. Implemented restricted categories are new service-token
handling and optional runtime configuration/durable collection state. Existing
Core sign-in, admin authorization, safeRunner, shell:false, its environment
allowlist, deployment scripts and service ports are unchanged. No dependencies
were added, removed or upgraded. No production database, live supplier request,
model download, model invocation, release package or deployment was performed.

## Exact verification commands and results

Run locally on Windows with bundled Node v24.19.0 and the existing npm runner
`C:/Users/elija/OneDrive/Documents/w3-core/.dev-tools/npm.cmd` on PATH:

| Command | Result |
| --- | --- |
| `npm run build --prefix backend` | PASS |
| `npm test --prefix backend -- --run test/materialPricing.test.ts` | PASS: 22/22 |
| `npm test --prefix backend` | FAIL overall: 60 passed, 2 failed, 62 total |
| `npm run typecheck --prefix frontend/admin` | PASS |
| `npm run build --prefix frontend/admin` | PASS |
| `npm test --prefix frontend/admin` | PASS: 5/5 |
| `git diff --check` | PASS |

The two full-backend failures are the unchanged safeRunner Bash-fixture happy
paths. Windows Node's direct script spawn returns `EFTYPE`. No assertion,
execution restriction or test was skipped or weakened to hide those failures.
Pricing tests cover authentication, location/product identity, positive regular
prices, sale/bulk context, pending actor results, bounded transport, durable
retries, restarts, caller/server budgets, uncertain starts and malformed or
out-of-set model recommendations.

A Linux runtime was prepared in a temporary directory on the owner's Forge
host, but automatic approval review rejected copying private source there as
unauthorized code egress. No repository source was transferred. Linux
verification remains pending explicit approval for that transfer. No existing
GitHub CI workflow was present to supply that check.

The development change is available for user review, not a claim of production
readiness. Operator configuration, exact installed model tag, a small live
supplier verification, full Linux checks, and owner-controlled release remain.
See `MATERIAL_PRICING.md` for setup, bounded behavior and ledger recovery.

## Changed files
- `.env.example`
- `backend/src/index.ts`
- `backend/src/materialPricing/config.ts`
- `backend/src/materialPricing/ledger.ts`
- `backend/src/materialPricing/routes.ts`
- `backend/src/materialPricing/service.ts`
- `backend/src/materialPricing/transport.ts`
- `backend/src/materialPricing/types.ts`
- `backend/test/materialPricing.test.ts`
- `CHANGELOG.md`
- `docs/MATERIAL_PRICING_VERIFICATION_v0.4.1.md`
- `docs/MATERIAL_PRICING.md`
- `README.md`
