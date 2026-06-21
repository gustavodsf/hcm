# ExampleHR Time-Off Microservice

A NestJS + SQLite microservice that manages the **lifecycle of time-off requests** and keeps
balances **integrity-synced** with an HCM (Workday/SAP-style) **system of record**, where either
side can change a balance independently and the HCM is unreliable and not always correct about
errors.

> 📄 **The design rationale, challenges, alternatives, and trade-offs live in
> [`docs/TRD.md`](docs/TRD.md).** Read that first — this README is the operational guide.

## The core idea (30 seconds)

HCM is the source of truth; ExampleHR is a **convergent cache with pending intent**.

- **Balances are a ledger, not a number.** `available = hcmBalance − reservedOpen − committedPending`,
  always derived (never stored), so double-spend and double-count are structurally impossible.
- **Approvals reach HCM via a transactional outbox** (written atomically with the state change),
  delivered asynchronously, idempotently, with retry/backoff + circuit breaker. The user gets
  instant local feedback; HCM uptime never blocks them.
- **A reconciliation engine** absorbs independent HCM changes (anniversary bonus, annual refresh, HR
  edits) from a **realtime webhook** and a **batch corpus**, matching our own committed debits by an
  HCM version watermark so they are never counted twice, and surfacing **over-allocations** and
  **silent-accept drift** instead of corrupting balances.

## Stack

NestJS 10 · TypeORM · SQLite (`better-sqlite3`) · Jest · Swagger/OpenAPI.

## Quick start

```bash
npm install

# Option A — run the service standalone (uses an in-process HCM simulator; no extra server needed)
npm run start:dev                 # http://localhost:3000, Swagger at /docs

# Option B — run against the deployable mock HCM over real HTTP (two terminals)
npm run start:mock-hcm            # mock HCM on :4000
HCM_BASE_URL=http://127.0.0.1:4000 npm run start:dev
```

### Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `3000` | Service port |
| `DB_PATH` | `timeoff.sqlite` | SQLite file (`:memory:` in tests) |
| `HCM_BASE_URL` | _(unset)_ | If set, use the real HTTP HCM client; else in-process simulator |
| `MOCK_HCM_PORT` | `4000` | Standalone mock HCM port |
| `OUTBOX_AUTODRAIN` | `true` | Background outbox delivery; tests set `false` for determinism |
| `OUTBOX_INTERVAL_MS` | `500` | Background drain interval |

## Try it (live lifecycle)

```bash
# seed HCM, then create→submit→approve→commit
curl -XPOST localhost:4000/control/seed -H 'content-type: application/json' \
  -d '{"employeeId":"e1","locationId":"l1","balance":10}'

curl "localhost:3000/v1/balances?employeeId=e1&locationId=l1"
# {"hcmBalance":10,"reservedOpen":0,"committedPending":0,"available":10}

REQ=$(curl -s -XPOST localhost:3000/v1/time-off-requests -H 'content-type: application/json' \
  -d '{"employeeId":"e1","locationId":"l1","startDate":"2026-07-01","endDate":"2026-07-03","days":3,"submit":true}')
ID=$(echo $REQ | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

curl -XPOST localhost:3000/v1/time-off-requests/$ID/approve
curl -XPOST localhost:3000/v1/internal/outbox/drain     # force delivery (or wait for autodrain)
curl localhost:3000/v1/time-off-requests/$ID            # status: COMMITTED

# Simulate an anniversary bonus on the HCM side, then reconcile:
curl -XPOST localhost:4000/control/adjust -H 'content-type: application/json' \
  -d '{"employeeId":"e1","locationId":"l1","delta":5}'
curl -XPOST localhost:3000/v1/sync/reconcile
curl "localhost:3000/v1/balances?employeeId=e1&locationId=l1"   # available reflects the bonus
```

## API surface (full spec in TRD §8, live at `/docs`)

| Area | Endpoints |
|------|-----------|
| Balances | `GET /v1/balances?employeeId=&locationId=`, `GET /v1/balances/:employeeId` |
| Requests | `POST /v1/time-off-requests`, `GET /v1/time-off-requests[/:id]`, `POST /v1/time-off-requests/:id/{submit,approve,reject,cancel}` |
| Sync (HCM-facing/ops) | `POST /v1/sync/hcm/balance`, `POST /v1/sync/hcm/batch`, `POST /v1/sync/reconcile`, `GET /v1/sync/events`, `POST /v1/internal/outbox/drain` |
| Health | `GET /health`, `GET /health/ready` |

Mutating endpoints accept an `Idempotency-Key` header. Errors use a stable envelope:
`{ statusCode, error, message, details? }` where `error` is a machine-readable `DomainErrorCode`.

## Mock HCM (test double + deployable server)

The same `HcmCore` simulation engine powers both the in-process test double and the standalone
server (`src/mock-hcm`). Its `/control/*` endpoints inject faults so you can reproduce every hard
scenario:

| Control | Effect |
|---------|--------|
| `POST /control/seed` / `adjust` | set / independently change a balance (anniversary, HR edit) |
| `POST /control/faults` `{failuresToInject}` | transient 503s, then recovery |
| `POST /control/faults` `{invalidDimensions}` | authoritative rejection |
| `POST /control/faults` `{silentOverdraw}` | **accept an over-draw without erroring** (HCM not reporting errors) |
| `POST /control/faults` `{ghostSuccess}` | **return 200 without applying** (silent no-op) |
| `GET /corpus` / `POST /control/emit-batch` | full-corpus batch feed |

## Tests & coverage

```bash
npm test                 # all projects: unit + integration + e2e
npm run test:unit        # pure logic (balance math, state machine, reconciliation, breaker, mutex)
npm run test:integration # full Nest app + in-memory SQLite + in-process HCM
npm run test:e2e         # HTTP via supertest, incl. the real standalone mock HCM over HTTP
npm run test:cov         # coverage report → coverage/index.html (lcov + json-summary)
```

**112 tests**, coverage thresholds enforced in `jest.config.js`
(statements ≥90, branches ≥80, functions ≥90, lines ≥90 — actual: **~97 / 80 / 98 / 99%**).

The suite is organized by the **challenge → scenario matrix** in TRD §10.2. Highlights:

- **No double-spend** under concurrent submits (per-`(emp,loc)` serialized reserve).
- **Exactly-once** HCM propagation across transient failures (idempotency key).
- **Crash/at-least-once** survivability (outbox written with the state change).
- **No double-count** when a batch corpus already reflects our committed debit.
- **Defensive** handling when HCM silently accepts an over-draw or no-ops a write (drift detected,
  over-allocation surfaced — never silent corruption).
- **Convergence** for anniversary bonus / annual refresh via realtime + batch, with stale-version
  rejection.

## Project layout

```
docs/TRD.md                 # the engineering spec (read this)
src/
  common/                   # pure logic: balance-math, reconciliation-math, state-machine,
                            #   keyed-mutex, circuit-breaker, errors, error filter
  database/entities/        # TypeORM entities (balance, ledger, request, outbox, reconcile event)
  balances/                 # ledger + derived balance service & controller
  time-off/                 # request lifecycle service & controller (+ DTOs)
  hcm/                      # HcmCore simulator, client interface, HTTP + in-process clients
  outbox/                   # transactional outbox service + delivery processor
  sync/                     # reconciliation engine + HCM-facing/ops controller
  health/ , mock-hcm/       # health checks; standalone mock HCM server
test/ unit | integration | e2e
```

## Notes & scope

Per the assignment, balances are **per-employee per-location** with a single fungible "days"
quantity, and the focus is the TRD + an exhaustive test suite. Production hardening (Postgres row
locks, a real broker, multi-instance outbox leasing, auth, metrics/tracing) is **designed but
out-of-scope**, documented in TRD §12. Open assumptions are in TRD §13.
