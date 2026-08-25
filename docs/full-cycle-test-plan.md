# APS Subscription full-cycle test plan

## Safety and execution model

The default suite is deterministic and never calls a live Shopify store, Stripe, Resend, cron, DNS, or production database. Shopify, Stripe, Resend, and time are the only mocked boundaries. Service tests exercise the production services; repository fixtures implement atomic claims, unique constraints, rollback, and transaction callbacks. Prisma schema/migration validity is checked separately. A real ephemeral PostgreSQL integration remains a live-test prerequisite, not an implicit use of `.env`.

`npm test` runs the complete local regression suite. `test:integration` selects transactional retry/order/notification integration tests; `test:contract` selects the App/API boundary; `test:full-cycle` is the CI-safe aggregate. `test:live:dry-run` only prints and validates the guarded live plan.

## Scenario matrix

| # | Scenario | Layer and automated evidence | Correlation IDs | Expected result | Live pending |
|---|---|---|---|---|---|
| 1 | Paid first order and APS mirror | Contract + service: `shopify-event.service`, Prisma initial-order tests | `webhookId`, `shopifyEventId`, contract/order/line GIDs | One tenant-scoped subscription and initial order; redelivery is duplicate | Real Shopify-origin order |
| 2 | Shopify create/update, duplicate, ordering, invalid auth, timeout | Contract: App forwarder + API ingestion | webhook/event IDs and `revisionId` | Invalid input rejected; transient failures retryable; old revisions ignored | Signed webhook from dev store |
| 3 | Successful recurring cycle | Integration: retry engine and recurring order persistence | cycle/job idempotency key, attempt/order GIDs | One atomic claim, attempt and order; money/currency/next date persisted | Test-gateway billing attempt |
| 4 | Inventory policies | Contract: App retry operation; integration: independent retry kinds | variant GID and cycle ID | DENY/CONTINUE/untracked/removed and summed lines resolve deterministically | Inventory snapshot from dev store |
| 5 | Payment failure and exhaustion | Unit + integration: retry policy/engine | cycle/job keys | Configured interval/count and final pause/cancel/skip; no failed order | Gateway-decline fixture |
| 6 | UNCERTAIN recovery | Integration: retry engine lease/reconciliation | stable idempotency key and billing attempt GID | Finite deadline/count, expired lease recovery, no duplicate effect | Timeout after real test effect |
| 7 | Lifecycle | Service + contract: lifecycle service and App GraphQL handler | lifecycle action idempotency key | Customer/merchant actions reconcile; terminal states never revive | Dev-store customer action |
| 8 | Seven notification events and provider outcomes | Integration: notification event/outbox/Resend webhook | source key, outbox ID, provider event ID | Tenant sender/recipient isolation; frequency rules; idempotent delivery state | Resend test-domain delivery |
| 9 | Multi-tenant security | Unit + service: tenant identity, middleware and notification tests | shop ID/domain plus external ID | Same external IDs do not cross shops; missing internal key is 401; secrets absent | Session-bound dev-store request |
| 10 | Concurrency | Integration: `Promise.all`, atomic updateMany claims, unique-key recovery | webhook/job/outbox keys | One winner, attempt, order, event and notification | Parallel signed delivery |
| 11 | Calendar boundaries | Unit: retry policy and Sao Paulo summary windows | fixed clock ISO value | Jan/Mar month clamp, leap-year clamp and daily/weekly rollover | None |
| 12 | Uninstall | Contract + service: App uninstall and API event ingestion | uninstall webhook ID and shop | Credentials/sessions revoked, required history retained, redelivery succeeds | Signed dev-store uninstall |

## Fixtures, preconditions, and rollback

All local fixtures use synthetic `.test`/`myshopify.com` identities, fixed clocks, BRL money, deterministic Shopify GIDs, and stable idempotency keys. External adapters return recorded response shapes only. No production secret is required. Each test owns its maps/transaction fixture and process cleanup is automatic.

The optional live runner requires all of: `ENABLE_LIVE_SUBSCRIPTION_TESTS=true`, `LIVE_SUBSCRIPTION_TEST_SHOP`, an exact entry in `LIVE_SUBSCRIPTION_TEST_ALLOWLIST`, and `LIVE_SUBSCRIPTION_TEST_GATEWAY=shopify-test|stripe-test`. Any shop containing `betterlife` is refused. It remains dry-run and performs no mutation; a future explicit executor must tag every created record and may delete only that tag.

## Evidence and open live work

CI evidence is the TAP output plus Prisma/type/build validation and `git diff --check`. Live evidence must record plan approval, store, gateway mode, webhook/event/revision IDs, billing attempt/order IDs, outbox/provider IDs, timestamps, cleanup IDs, and screenshots/log excerpts with secrets redacted.

Pending live-only assertions are the final column above. They require a disposable development store, Shopify test gateway or Stripe test mode, a Resend test domain, explicit credentials/allowlist, and separate authorization to execute external mutations. They are deliberately not run by ordinary CI.
