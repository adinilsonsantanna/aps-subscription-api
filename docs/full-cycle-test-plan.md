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

## Executable evidence index

The exact names below are stable test IDs. `AUTOMATED` means the behavior is asserted locally/CI; `LIVE_PENDING` is an additional platform-level assertion and does not negate the automated evidence.

| Scenario | Exact automated test name | File | Script | Layer | Evidence | Status |
|---|---|---|---|---|---|---|
| 1 First order | `production modules preserve one correlation chain from first order through delivered renewal` | `src/full-cycle/__tests__/full-cycle.production.test.ts` | `test:full-cycle` | E2E simulated/production modules | origin order, contract, line, product, variant and selling-plan IDs share one correlation | AUTOMATED |
| 2 Shopify events | `returns success without processing a duplicate event twice`; `Shopify revision ID rejects out-of-order non-terminal updates` | `src/shopify/events/__tests__/shopify-event.service.test.ts` | `test:contract` | service/repository contract | duplicate count and revision transition | AUTOMATED |
| 3 Successful recurrence | `payment success idempotently upserts attempt and real order`; `rerunning cron does not duplicate charge, attempt, order, job, or notification` | `src/retry/__tests__/retry-engine.service.test.ts` | `test:full-cycle` | service/transaction | one attempt/order and next billing state | AUTOMATED |
| 4 Inventory | `failure and next job are persisted in one transaction with independent counter` | `src/retry/__tests__/retry-engine.service.test.ts` | `test:integration` | service/transaction | inventory failure creates only the independent next job | AUTOMATED |
| 5 Payment failure | `zero retries schedules recoverable skip and NEVER creates no outbox`; `pause is recovered idempotently after exhaustion`; `cancel is recovered idempotently after exhaustion` | `src/retry/__tests__/retry-engine.service.test.ts` | `test:full-cycle` | policy/service | zero retry and configured terminal action | AUTOMATED |
| 6 UNCERTAIN | `UNCERTAIN is reconciled with the stored attempt id`; `finite UNCERTAIN reconciliation exhausts into the configured action` | `src/retry/__tests__/retry-engine.service.test.ts` | `test:full-cycle` | service/lease | stable attempt ID, deadline and finite reconciliation | AUTOMATED |
| 7 Lifecycle | `routes pause, resume and cancel only to Stripe for historical subscriptions`; `recovered final action never revives or rewrites terminal subscription` | `src/services/__tests__/subscription-lifecycle.service.test.ts`; `src/retry/__tests__/retry-engine.service.test.ts` | `test:full-cycle` | service/policy | pause/resume/cancel routing and terminality | AUTOMATED |
| 8 Notifications | `429 and 5xx retry finitely while permanent errors terminate`; `Resend webhook maps bounced complained and suppressed terminal states` | `src/notifications/__tests__/notifications.test.ts` | `test:full-cycle` | outbox/adapter | provider retry and terminal delivery states | AUTOMATED |
| 9 Multi-tenant security | `same source and recipient remain isolated between tenants`; `returns unauthorized from the middleware when x-api-key is absent` | `src/notifications/__tests__/notification-event.test.ts`; `src/shopify/events/__tests__/shopify-event.service.test.ts` | `npm test`; `test:contract` | identity/controller | tenant keys differ and missing key is 401 | AUTOMATED |
| 10 Concurrency | `worker that loses the atomic claim never performs the external operation`; `PostgreSQL commits, rolls back, enforces uniqueness, isolates tenants and atomically claims once` | `src/retry/__tests__/retry-engine.service.test.ts`; `src/integration/__tests__/postgres-transaction.integration.test.ts` | `test:integration` | service/PostgreSQL | losing worker has zero external calls; real update claims once | AUTOMATED when `TEST_DATABASE_URL` is set |
| 11 Dates | `month recurrence clamps January 31 to February last day`; `month recurrence clamps March 31 to April 30`; `year recurrence clamps leap day to February 28`; `lifecycle recovery uses the injected clock instead of Date.now` | `src/retry/__tests__/retry-policy.test.ts`; `src/services/__tests__/subscription-lifecycle.service.test.ts` | `npm test`; `test:full-cycle` | policy/service | fixed ISO results and injected lifecycle clock | AUTOMATED |
| 12 Uninstall | `uninstall durably queues active pending previous and orphaned credential IDs`; `marks a shop inactive without deleting its mirrored data` | `src/shopify/events/__tests__/shopify-notification-integration.test.ts`; `src/shopify/events/__tests__/shopify-event.service.test.ts` | `test:integration`; `test:contract` | service/transaction | credential cleanup is queued and history retained | AUTOMATED |
| 1-12 platform proof | Signed first order through delivered provider event in a disposable store | future live evidence artifact | guarded live executor, not ordinary CI | Shopify/test gateway/Resend | real platform IDs and exact tagged cleanup manifest | LIVE_PENDING |

## PostgreSQL harness and mutation sanity

`TEST_DATABASE_URL` is the only accepted database input for the real transaction test. It must be PostgreSQL and must differ from `DATABASE_URL`. The test creates `scope9_<pid>_<timestamp>`, proves commit, forced rollback, tenant-scoped uniqueness and concurrent conditional claim, then drops only that exact schema. Without the variable, TAP reports one explicit skip; no configured application database is touched.

Mutation sanity evidence: changing the missing-key response from 401 to 403 makes `internal endpoint without x-api-key returns 401` fail. Inverting the retry claim-winner condition makes `worker that loses the atomic claim never performs the external operation` fail. Disabling the successful-payment branch makes `payment success idempotently upserts attempt and real order` fail. All mutations are restored before commit.
