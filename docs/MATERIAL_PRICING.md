# Manual material pricing research

The optional material pricing service lets BuildCost ask Forge to collect supplier observations or request an advisory local-model SKU comparison. It is disabled by default. It does not write BuildCost prices or connect to a business database. BuildCost retains product confirmation, unit review, import review and accepted price-history authority.

This feature is a separately authorized, potentially paid HTTP workflow. It is not a read-only admin diagnostic. Existing admin sign-in, controls, safeRunner, its environment allowlist and shell:false remain unchanged. No scheduler, automatic discovery, deployment action or unrestricted tool execution is added.

## Configure on the Forge server

Export settings through the existing launcher/service environment; the backend does not load .env automatically. Keep credentials out of the repository, browser, logs and model input.

- W3_FORGE_MATERIAL_PRICING_ENABLED=true explicitly enables the endpoints.
- W3_FORGE_MATERIAL_PRICING_SHARED_TOKEN is a new 48–256 character base64url/hex service token, generated randomly and used only for these two endpoints. A random 32-byte hex value is suitable. Set the identical value in BuildCost's W3_FORGE_MATERIAL_PRICING_TOKEN. Never reuse the Core pairing credential or Apify token.
- W3_FORGE_MATERIAL_PRICING_APIFY_TOKEN is the Apify server token.
- W3_FORGE_MATERIAL_PRICING_DATA_DIR is an absolute, durable, service-owned directory outside the source checkout and temporary storage. Give only the Forge service account access. The directory contains request identities, reserved budgets, provider run IDs and observations, never credentials.
- W3_FORGE_MATERIAL_PRICING_OLLAMA_URL defaults to http://127.0.0.1:11434. Only literal loopback HTTP origins are accepted, with no credentials, path, query or fragment.
- W3_FORGE_MATERIAL_PRICING_OLLAMA_MODEL has no default. Set the exact installed qwen2.5:tag or qwen2.5-coder:tag shown by your local model inventory. Nothing downloads or selects a model automatically. Collection works without this setting; matching returns MATCH_NOT_CONFIGURED until set. The configured model and matching result have not been verified against a live Ollama runtime by automated tests.

Default actor limits are 10 products per request, 10 cents reserved per request, and 100 cents reserved per UTC day. The per-product Apify maxTotalChargeUsd is floor(batchCents/productCount)/100; maxItems=1, restartOnError=false and a 180-second actor runtime limit are also sent. There is no cost estimate derived from a model or a hardcoded advertised price. Each request carries a required maxTotalChargeCents integer (1–100). Forge reserves the smaller of this caller-authorized ceiling and its own configured request ceiling; a batch is rejected before any paid work if that leaves less than one cent per product. Each submitted batch reserves that full effective ceiling, even when the provider ultimately charges less. The ledger does not attempt to infer a refund.

Optional bounded settings:

| Variable suffix after W3_FORGE_MATERIAL_PRICING_ | Default | Allowed |
| --- | ---: | --- |
| MAX_PRODUCTS | 10 | 1–20 |
| MAX_REQUEST_CHARGE_CENTS | 10 | 1–100; at least MAX_PRODUCTS |
| MAX_DAILY_CHARGE_CENTS | 100 | 1–10000; at least the request ceiling |
| MAX_LEDGER_ENTRIES | 1000 | 1–10000 |
| REQUEST_TIMEOUT_MS | 25000 | 1000–45000 |
| ACTOR_TIMEOUT_SECONDS | 180 | 120–300 |

The HTTP request deadline bounds the entire batch. Actor execution can continue on Apify after the HTTP response; subsequent requests with the same request identity only poll known run IDs or start previously unstarted products. Queued products expire at the end of their reservation's UTC day. Do not configure the BuildCost timeout below the Forge request deadline.

Existing internal-network guard rules also apply. Use loopback or the existing protected network path for service traffic; use HTTPS when credentials cross hosts. This feature does not change bind addresses, ports, proxy settings, firewall rules or existing admin authentication.

## API contract

Both endpoints require Authorization: Bearer <pricing-only-token> and application/json. They reject browser Origin headers, unknown fields, oversized bodies and unsupported paths. Responses use the existing ApiEnvelope: success/data or success:false/error. The bearer grants no Core sign-in or admin capabilities.

POST /api/material-pricing/collect accepts:

```json
{
  "schemaVersion": 1,
  "requestId": "a-stable-unique-request-id",
  "maxTotalChargeCents": 10,
  "postalCode": "49221",
  "storeId": "0088",
  "products": [{"sourceId": "material-source-1", "productId": "123456789"}]
}
```

The example product ID is illustrative, not a verified supplier mapping. Request IDs are 16–80 characters from A–Z, a–z, 0–9, underscore and hyphen. Source IDs use those characters with length 1–80; product IDs are 1–20 decimal digits. Duplicate source or product IDs are rejected. ZIP 49221 and store 0088 are the only accepted location in this version.

Response data has schemaVersion, requestId, postalCode, storeId and observations. Each observation has the supplied sourceId, productId and storeId; status (priced, pending, failed, not_available); and observedAt. Optional fields are regularPriceCents, salePriceCents, bulkPriceCents, bulkQuantityRequired, quantityAvailable, productName, productUrl, apifyRunId, datasetId and a fixed error code.

Only a positive integer regular price produces priced. No zero, missing value, sale price or bulk price becomes a regular price. Discounts remain separate; bulk price requires a threshold greater than one. Product identity and store are checked against the supplier result; another store's price is never substituted. Leading zeros in supplier store IDs are normalized. Supplier URLs must be HTTPS Lowe's product URLs ending with the requested product ID; they are not fetched.

For priced observations, observedAt uses the completed Apify run timestamp, falling back to retrieval time. For pending/failed observations it describes the attempt/result timestamp and is not a current-price timestamp. BuildCost must not promote those records to an accepted price.

Apify SUCCEEDED means the actor finished, not that a price exists. Actor output status 202/206 remains pending and its asyncId is kept internally for operator investigation. This version does not start another paid actor to resolve an asyncId automatically. Invalid/missing output also remains pending for safe GET polling when possible.

POST /api/material-pricing/match accepts:

```json
{
  "schemaVersion": 1,
  "requestId": "a-stable-match-request-id",
  "material": {"materialId": "material-1", "requirements": ["2x4", "8 feet", "SPF", "grade required"]},
  "candidates": [{"productId": "123456789", "name": "Candidate title", "attributes": ["supplier-observed attributes"]}]
}
```

Limit: 10 candidates, 20 requirements/attributes per list, 500 characters per text, 16,000 serialized characters overall. The model receives only these supplied descriptions, never secrets, URLs, prices or tools. Its structured response can recommend only a supplied productId or null and provide discrepancies/reason. Forge rejects extra output fields, tool calls, malformed JSON, unknown IDs, wrong model identity and price/URL prose. Returned data includes advisory:true, model, recommendedProductId, discrepancies and reason. BuildCost must require a person to confirm an exact SKU and never treat this output as a price or engineering approval. Matching has a single-process concurrency guard and a bounded deadline.

## Retry, evidence and rollback

A single exclusive filesystem lock protects the durable request ledger. Before any paid POST, Forge writes and flushes the full request reservation, then writes and flushes the product's start intent. Identical request IDs with different bodies, including a changed spending ceiling, return 409. The ledger validates that reservations do not exceed the original caller ceiling and that per-run caps match their allocation. Identical completed requests return cached observations after a process restart. Once a start intent exists, a network timeout, redirect, invalid response or crash cannot trigger the same paid POST again.

An uncertain start without a known run ID remains pending with START_OUTCOME_UNKNOWN. Inspect Apify and reconcile manually; do not generate a new request ID merely to bypass that state. A leftover lock after an unclean shutdown blocks work until an operator verifies no Forge process owns it. Existing request IDs are never automatically evicted. Capacity exhaustion rejects new work rather than forgetting idempotency. The ledger has a 64 MiB bound.

Operational recovery: disable pricing first; stop/drain the Forge process; inspect and preserve requests.json and provider run evidence; only then remove a proven stale requests.lock or repair a ledger from a verified backup. Never delete or reset the ledger while accepting old request IDs. Back up the directory as part of the owner's existing backup process. No new backup/deployment behavior is installed by this change.

Rollback is to set the feature flag false and restart through the established owner-controlled process. Retain the ledger and evidence. This halts new requests but does not cancel an already running Apify actor. Any run cancellation is an explicit owner action in Apify. BuildCost import reversal remains a separate audited BuildCost action; historical prices are not deleted.

## Verification

Tests use injected HTTP fixtures and temporary ledgers. No test contacts Apify, launches a model or modifies business data.

Local verification on 2026-10-06 (Windows, bundled Node runtime):
- `npm run build --prefix backend` — passed.
- `npm test --prefix backend -- --run test/materialPricing.test.ts` — passed, 22/22 pricing tests.
- `npm test --prefix backend` — 60 passed, 2 failed, 62 total. The two unchanged safeRunner Bash-fixture cases fail with `spawn EFTYPE` on Windows; no tests were disabled or weakened.
- `git diff --check` — passed after the contract/documentation edits.

The existing safeRunner Bash execution cases require Linux/Bash; Windows Node cannot directly spawn the fixture shell scripts and reports spawn EFTYPE. Do not weaken those tests to conceal this platform limitation.

Protocol references checked during implementation:

- [Actor input/output](https://apify.com/maplerope44/lowes-product-lookup)
- [Apify run limits](https://docs.apify.com/api/v2/actors-runs-post)
- [Ollama structured chat](https://docs.ollama.com/api/chat)
