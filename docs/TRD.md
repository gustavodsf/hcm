# Technical Requirements Document — Time-Off Microservice

**Status:** Proposed
**Author:** ExampleHR Platform Eng
**Last updated:** 2026-06-21
**Reviewers:** Time-Off Squad, HCM Integrations, SRE

---

## 1. Summary

ExampleHR lets employees request time off and lets managers approve those requests. The
**Human Capital Management** system (Workday, SAP SuccessFactors, etc.) remains the **system of
record (SoR)** for employment data, including time-off balances.

This document specifies the **Time-Off Microservice**: a NestJS service backed by SQLite that

1. owns the **lifecycle of a time-off request** (draft → approved → committed to HCM, plus the
   rejection/cancellation/failure paths), and
2. maintains **balance integrity** between ExampleHR and the HCM, where _either side can change a
   balance independently and asynchronously_.

The central engineering problem is **distributed consistency between two systems that both mutate
the same quantity**, where the network and the remote system are unreliable and where the remote
system is _authoritative but not always correct in its error reporting_. We solve it with a
**local reservation ledger** (for instant, race-free feedback), a **transactional outbox** (for
reliable, idempotent propagation to HCM), and a **reconciliation engine** (for absorbing
independent HCM changes via both a realtime API and a batch corpus feed). HCM remains the source of
truth; ExampleHR is a **convergent cache with pending intent**.

---

## 2. Goals & Non-Goals

### 2.1 Goals

| #  | Goal |
|----|------|
| G1 | Employees get **instant, accurate** feedback on whether a request fits their balance. |
| G2 | Managers approve against **valid** data; an approval reliably reaches HCM exactly once. |
| G3 | **No double-spend**: concurrent requests can never drive _committed + reserved_ balance negative locally. |
| G4 | **Convergence**: independent HCM changes (anniversary bonus, annual refresh, manual HR edit) are absorbed and reflected, via realtime API and batch corpus. |
| G5 | **Defensive correctness**: the system stays correct even when HCM _fails to report an error_ it should have (e.g., silently accepts an over-draw). |
| G6 | **Reliability**: an approval is never lost on crash/restart; propagation to HCM survives transient HCM/network failure. |
| G7 | **Auditability**: every balance change has a traceable ledger entry and every HCM interaction is logged. |
| G8 | **Testability**: deterministic, fast test suite + a runnable mock HCM with fault injection. |

### 2.2 Non-Goals

- **Approval routing / org hierarchy** (who may approve whom) — assumed provided by an upstream
  identity/org service; we model a single approval step.
- **Accrual policy engine** (how many days an employee earns and when) — that logic lives in HCM;
  we consume balances, we do not compute accruals. We _do_ absorb HCM-driven balance refreshes.
- **Calendar/holiday/working-day math** — request "days" are treated as an integer/decimal quantity
  supplied by the caller; partial-day and business-day expansion is out of scope (noted in §13).
- **Multi-currency / multi-leave-type modeling** is reduced to a single fungible "days" quantity per
  `(employeeId, locationId)` per the assignment ("balances are per-employee per-location"). §13
  describes how leave-type would slot in.
- **AuthN/AuthZ** — assumed terminated at an API gateway; we accept an employee/actor identity as
  input. Endpoints are documented with the role that _would_ be enforced.

---

## 3. Domain Model & Key Concepts

### 3.1 The two systems

- **HCM (source of truth).** Owns the authoritative balance for an `(employeeId, locationId)`. It
  exposes:
  - a **realtime API** to GET a balance and to POST a debit/credit ("1 day for locationId X,
    employeeId Y");
  - a **batch endpoint** that pushes the _entire corpus_ of balances (with dimensions) to ExampleHR
    periodically.
  - It _may_ return errors for invalid dimension combinations or insufficient balance — **but this
    is not guaranteed** (G5). It can also be changed by actors other than ExampleHR.

- **ExampleHR Time-Off Service (this service).** The interface employees and managers use. It must
  feel instant and must never let the UI promise something HCM will later reject without a clear,
  reconciling correction.

### 3.2 Balance as a ledger, not a number

A single mutable integer column cannot satisfy G3 + G4 + G5 simultaneously, because it conflates
three different quantities that change on different clocks. We split them:

```
available(emp, loc) = hcmBalance(emp, loc)            # last known authoritative value from HCM
                    − Σ reserved(open requests)        # locally held, not yet committed to HCM
                    − Σ committedLocally_but_not_yet_in_hcmSnapshot
```

Concretely we keep, per `(employeeId, locationId)`:

- **`hcm_balance`** — the last authoritative value we received from HCM (realtime or batch), with a
  **version/asOf** stamp. This is our cache of the SoR.
- **A ledger** of `BalanceLedgerEntry` rows: append-only, each tied to a request and a phase
  (`RESERVE`, `COMMIT`, `RELEASE`, `HCM_ADJUSTMENT`). The **derived available balance** is computed
  from `hcm_balance` and the open ledger entries.

Why append-only ledger: it gives us (a) atomic, race-free reservation under a DB transaction, (b) a
complete audit trail (G7), and (c) a clean way to reconcile against HCM without losing in-flight
intent (G4). See §6 for the exact arithmetic, including the double-count problem and how the
`hcmRef` / idempotency key solves it.

### 3.3 Request lifecycle (state machine)

```
                ┌─────────┐  submit   ┌──────────────────┐
   create ─────▶│  DRAFT  │──────────▶│ PENDING_APPROVAL │
                └─────────┘           └──────────────────┘
                     │                   │            │
                cancel│            reject │      approve│
                     ▼                    ▼             ▼
                ┌──────────┐        ┌──────────┐  ┌──────────────┐
                │CANCELLED │        │ REJECTED │  │  APPROVED    │
                └──────────┘        └──────────┘  │ (HCM pending)│
                                                  └──────────────┘
                                                    │          │
                                       HCM commit OK│          │HCM rejects / invalid
                                                    ▼          ▼
                                              ┌──────────┐ ┌──────────┐
                                              │COMMITTED │ │  FAILED  │
                                              └──────────┘ └──────────┘
                                                    │
                                          cancel after commit
                                                    ▼
                                          ┌────────────────────┐
                                          │ CANCELLATION_PENDING│ ──▶ COMMITTED-reversed (CANCELLED)
                                          └────────────────────┘
```

State semantics and the ledger effect of each transition:

| State | Meaning | Ledger effect on entry |
|-------|---------|------------------------|
| `DRAFT` | Created, not submitted. No hold. | none |
| `PENDING_APPROVAL` | Submitted; **reservation placed**. Counts against `available`. | `RESERVE` active |
| `REJECTED` | Manager rejected. | `RESERVE` → released |
| `CANCELLED` | Employee/manager cancelled before commit. | `RESERVE` → released |
| `APPROVED` | Approved; **outbox message enqueued** to debit HCM. Still reserved. | `RESERVE` active |
| `COMMITTED` | HCM acknowledged the debit. | `RESERVE` → `COMMIT` |
| `FAILED` | HCM authoritatively rejected (insufficient/invalid), or exhausted retries. | `RESERVE` → released; request needs attention |
| `CANCELLATION_PENDING` | Cancel requested after HCM commit; outbox credit enqueued. | `COMMIT` active until credit acks |

Invariant **I1**: a request holds _at most one_ active ledger reservation at a time.
Invariant **I2**: `available(emp,loc)` is a pure function of `hcm_balance` + open ledger entries; it
is never stored, always derived (prevents skew, G3).

---

## 4. Challenges (the hard parts, enumerated)

These are the problems the design is judged against. Each maps to a mechanism in §5–§7 and a test
family in §10.

- **C1 — Dual-write / split-brain balance.** Both ExampleHR and HCM mutate the balance. Naive
  "write to both" double-writes diverge on partial failure. → _Outbox + idempotency + HCM-wins
  reconciliation_ (§5.2, §6.4).
- **C2 — Concurrent requests racing the same balance.** Two requests for the same employee submitted
  at once could both pass a check-then-write and overspend. → _Atomic reserve under DB transaction +
  derived available_ (§6.2).
- **C3 — HCM changes independently** (anniversary bonus, Jan-1 refresh, HR manual edit). Our cache
  goes stale and `available` is wrong. → _Realtime webhook + batch corpus ingestion +
  reconciliation_ (§7).
- **C4 — HCM is unreliable / slow / down.** An approval must not be lost; we must not block the user
  on a flaky downstream. → _Async outbox with retry + backoff + circuit breaker; user gets instant
  local feedback_ (§5.2).
- **C5 — HCM does not always return errors (G5).** It may silently accept an over-draw or an invalid
  dimension. We cannot trust "no error = success." → _Defensive local pre-validation (we are the
  guard HCM might not be) + post-commit verification read + drift detection that can quarantine an
  over-allocation_ (§6.5, §7.3).
- **C6 — Exactly-once propagation.** Retries must not double-debit HCM. → _Idempotency key per
  request carried on every HCM call; HCM (and our mock) dedupes_ (§5.3).
- **C7 — Reconciliation double-counting.** When the batch corpus arrives, has it already accounted
  for our in-flight commits or not? Counting both our local hold and HCM's already-applied debit
  understates the balance. → _Match by `hcmRef`/version watermark; reconcile only the unexplained
  delta_ (§7.2).
- **C8 — Ordering / staleness of HCM updates.** A late realtime event could clobber a newer batch
  snapshot. → _Monotonic `asOf`/version watermark; ignore stale updates_ (§7.1).
- **C9 — Negative available after a downward HCM correction.** HR reduces a balance below what we
  already reserved/committed. → _Allow ledger to reflect reality, surface
  `over_allocated` exceptions for manager action; never silently lose data_ (§7.3).
- **C10 — Crash consistency.** Crash between "approve" and "HCM call" must not lose the approval nor
  double-apply it. → _Outbox is written in the same DB transaction as the state change; processor is
  idempotent and restart-safe_ (§5.2).

---

## 5. Architecture

### 5.1 Components

```
                         ┌────────────────────────────────────────────────┐
   Employee / Manager ──▶│            Time-Off Microservice (Nest)         │
        (REST)           │                                                 │
                         │  TimeOffController   BalancesController         │
                         │        │                   │                    │
                         │        ▼                    ▼                    │
                         │  TimeOffService  ◀────▶ BalanceService (ledger)  │
                         │        │                   │                    │
                         │        ▼                   ▼                    │
                         │   OutboxService ───▶ OutboxProcessor (cron)      │
                         │        │                   │                    │
                         │        │                   ▼                    │
                         │        │             HcmClient (interface)       │
                         │        │                   │                    │
                         │  SyncController ◀───────────┼─── realtime webhook │
                         │  (batch + webhook ingest)   │                    │
                         │        ▼                    │                    │
                         │  ReconciliationService      │                    │
                         │                             ▼                    │
                         │                    SQLite (better-sqlite3)        │
                         └─────────────────────────────┼────────────────────┘
                                                        │ HTTP (realtime GET/POST, batch)
                                                        ▼
                                             ┌──────────────────────┐
                                             │   HCM (source of      │
                                             │   truth) — REAL or    │
                                             │   MOCK w/ fault inject │
                                             └──────────────────────┘
```

### 5.2 Transactional Outbox (reliable propagation — C4, C10)

Approving a request does **two** things that must be atomic: change the request/ledger state, and
schedule a debit to HCM. We never call HCM inside the request's HTTP transaction (that couples user
latency to HCM uptime and risks lost writes on crash). Instead:

1. In **one SQLite transaction**: set request `APPROVED`, keep the `RESERVE` ledger entry, and
   **insert an `OutboxMessage`** (`type=DEBIT`, payload, `idempotencyKey=requestId`, `status=PENDING`).
2. A **background `OutboxProcessor`** (scheduled, also triggerable) claims pending messages, calls
   `HcmClient`, and on success transitions the request to `COMMITTED` (ledger `RESERVE`→`COMMIT`).
   On a _retryable_ failure it backs off; on an _authoritative reject_ it transitions to `FAILED`
   and releases the hold.

This gives at-least-once delivery; idempotency (§5.3) upgrades it to **effectively exactly-once**.
Because the outbox row is committed with the state change, a crash at any point leaves a recoverable
record — on restart the processor resumes (C10).

### 5.3 Idempotency (exactly-once — C6)

Every HCM mutation carries `idempotencyKey = requestId` (plus an attempt-stable operation id for
reversals). HCM (and our mock) records applied keys and returns the original result on replay, so
retries never double-debit. The acknowledged `hcmRef` is stored on the request and used as the
watermark for reconciliation (§7.2).

### 5.4 HCM client abstraction

`HcmClient` is an interface (`IHcmClient`) with two implementations selected by DI/config:

- `HttpHcmClient` — real HTTP calls (realtime GET/POST balance, used in `start:dev`/prod and against
  the standalone mock server).
- `InProcessHcmClient` / test double — for fast deterministic tests, sharing the same mock balance
  logic the standalone server uses.

The interface includes a **circuit breaker** + **timeout** + **bounded retry with jittered backoff**
so a slow/dead HCM degrades gracefully (C4) rather than stalling the outbox.

---

## 6. Balance accounting (the core arithmetic)

### 6.1 Derivation

```
reservedOpen(emp,loc)  = Σ amount of ledger entries WHERE phase=RESERVE AND state=ACTIVE
committedPending(emp,loc) =
        Σ amount of ledger entries WHERE phase=COMMIT AND NOT yet reflected in hcm_balance snapshot
available(emp,loc) = hcm_balance(emp,loc) − reservedOpen − committedPending
```

`committedPending` is the subtle term: between us debiting HCM and the next HCM snapshot/version that
_includes_ that debit, we must keep subtracting it locally so we don't appear to have balance we've
already spent. Once a snapshot's version proves HCM already applied it (matched by `hcmRef`), the
`COMMIT` entry is marked `RECONCILED` and drops out of `committedPending` (§7.2). This is the precise
fix for the **double-count problem (C7)**.

### 6.2 Reserve is atomic (C2, C3 race)

`POST /time-off-requests` (submit) runs in a single transaction:

```
BEGIN IMMEDIATE                       -- writer lock; serializes racing reservations per DB
  read hcm_balance(emp,loc)
  compute available = hcm_balance − reservedOpen − committedPending
  if request.days > available  -> ROLLBACK, 409 INSUFFICIENT_BALANCE
  insert RESERVE ledger entry
  insert/advance request to PENDING_APPROVAL
COMMIT
```

SQLite's single-writer model + `BEGIN IMMEDIATE` makes the check-and-reserve a critical section, so
two concurrent submits for the same employee cannot both see the same headroom (C2). (At higher
scale this becomes a per-`(emp,loc)` row lock / `SELECT ... FOR UPDATE` on a real RDBMS — see §12.)

### 6.3 Commit / release

- **Commit** (outbox success): `RESERVE`→`COMMIT`. `available` unchanged (we already weren't
  counting it); the quantity simply moves from "reserved" to "committed-pending-reconcile."
- **Release** (reject/cancel/HCM-reject/expiry): mark `RESERVE` entry `RELEASED`; `available` rises
  back. Idempotent (releasing twice is a no-op).

### 6.4 HCM-wins conflict rule (C1)

On any disagreement between our derived view and an authoritative HCM value, **HCM wins**. We do not
overwrite HCM with our guess; we adjust our snapshot and re-derive, recording an `HCM_ADJUSTMENT`
ledger entry for audit. Our local reservations are _intent_, not truth — they survive reconciliation
unless HCM proves them satisfied (matched) or impossible (over-allocation).

### 6.5 Defensive pre- and post-validation (C5, G5)

- **Pre-validate locally** before every HCM debit even though HCM _should_ validate: we are the
  guard HCM might not be. If our ledger says insufficient, we reject locally regardless of what HCM
  would do.
- **Post-commit verification (optional, config-gated):** after a debit, optionally re-`GET` the HCM
  balance. If HCM's balance is _higher_ than our model predicts (it silently ignored our debit, or
  applied a credit), we flag a drift event and let reconciliation correct it rather than trusting the
  bare `200 OK`. "No error" is treated as _necessary but not sufficient_ evidence of success.

---

## 7. Synchronization & Reconciliation (C3, C7, C8, C9)

Two inbound channels, one engine.

### 7.1 Realtime updates (webhook) — `POST /sync/hcm/balance`

HCM (or our mock) notifies us of a single `(emp,loc)` balance change with an `asOf`/`version`. We
**accept only monotonically newer** versions (C8); stale events are ignored. We update `hcm_balance`,
then re-run reconciliation for that key (§7.2).

### 7.2 Batch corpus ingestion — `POST /sync/hcm/batch`

HCM pushes the whole corpus `[{employeeId, locationId, balance, version, asOf}]`. For each row we
run the **reconciliation algorithm**:

```
given hcmAuthoritative (balance + version) for (emp,loc):
  if version <= lastReconciledVersion: skip (stale / already applied)   # C8
  # Explain the delta. How much of HCM's number already reflects OUR commits?
  matchedCommits   = COMMIT ledger entries whose hcmRef is acknowledged
                     AND version <= hcmAuthoritative.version            # HCM already applied these
  mark matchedCommits RECONCILED                                        # they drop out of committedPending (C7)
  set hcm_balance = hcmAuthoritative.balance
  set lastReconciledVersion = hcmAuthoritative.version
  recompute available
  if available < 0:                                                     # C9 downward correction
        emit OVER_ALLOCATED reconciliation event for (emp,loc)
  emit RECONCILED event (delta, cause-inference: BONUS if balance rose unexpectedly, etc.)
```

The key idea against **double counting (C7)**: HCM's authoritative number already includes any debit
it has applied. We must therefore _stop_ subtracting locally exactly those commits HCM has absorbed —
identified by `hcmRef` + version watermark — while continuing to subtract still-in-flight reservations
and unacknowledged commits. Idempotent by `version`: replaying the same batch is a no-op (C7 test).

### 7.3 Independent increases & decreases

- **Anniversary bonus / annual refresh (increase).** Snapshot rises; `available` rises; we emit a
  `BALANCE_INCREASED` event (cause inferred). No request is affected. (C3)
- **Downward HR correction below committed (decrease).** `available` can go negative. We **do not**
  delete approved/committed requests; instead we raise an `OVER_ALLOCATED` exception listing the
  offending `(emp,loc)` and the overage, for manager/HR resolution. Surfacing beats silent data loss
  (G7, C9).

### 7.4 Scheduled safety-net reconcile

A periodic job re-pulls (realtime GET) balances for keys with recent activity or stale snapshots,
catching anything missed if a webhook was dropped or HCM was silent (C5). Triggerable via
`POST /sync/reconcile` for tests/ops.

---

## 8. API Specification (REST)

All payloads JSON. Errors use a consistent envelope `{ statusCode, error, message, details? }`.
Swagger/OpenAPI served at `/docs`.

### 8.1 Balances

| Method & Path | Role | Purpose |
|---|---|---|
| `GET /v1/balances?employeeId=&locationId=` | Employee/Manager | Derived view: `{ hcmBalance, reserved, committedPending, available, asOf }` |
| `GET /v1/balances/:employeeId` | Employee/Manager | All locations for an employee |

### 8.2 Time-off requests

| Method & Path | Role | Purpose |
|---|---|---|
| `POST /v1/time-off-requests` | Employee | Create (DRAFT or, with `submit:true`, straight to PENDING_APPROVAL with reservation). Body: `{employeeId, locationId, startDate, endDate, days, reason?, submit?}`. Returns 201 or **409 INSUFFICIENT_BALANCE**. |
| `GET /v1/time-off-requests/:id` | Employee/Manager | Fetch one (with status + ledger summary). |
| `GET /v1/time-off-requests?employeeId=&status=` | Employee/Manager | List/filter. |
| `POST /v1/time-off-requests/:id/submit` | Employee | DRAFT → PENDING_APPROVAL (reserve). |
| `POST /v1/time-off-requests/:id/approve` | Manager | PENDING_APPROVAL → APPROVED; enqueues HCM debit. 200. |
| `POST /v1/time-off-requests/:id/reject` | Manager | PENDING_APPROVAL → REJECTED; release. |
| `POST /v1/time-off-requests/:id/cancel` | Employee/Manager | Cancel before commit (release) or after commit (enqueue HCM credit reversal). |

**Idempotency:** mutating endpoints accept an optional `Idempotency-Key` header so client retries are
safe end-to-end (separate from the internal HCM idempotency key).

### 8.3 Sync (HCM-facing / ops)

| Method & Path | Purpose |
|---|---|
| `POST /v1/sync/hcm/balance` | Realtime single-key webhook from HCM. |
| `POST /v1/sync/hcm/batch` | Full corpus ingest from HCM. |
| `POST /v1/sync/reconcile` | Trigger safety-net reconcile (ops/test). |
| `GET /v1/sync/events?type=` | Inspect reconciliation/over-allocation events (audit/ops). |
| `POST /v1/internal/outbox/drain` | Force outbox processing (ops/test determinism). |

### 8.4 Health

`GET /health` (liveness), `GET /health/ready` (DB + HCM reachability/circuit state).

---

## 9. Data Model (SQLite via TypeORM)

```
balances                              time_off_requests
─────────────────────────────        ──────────────────────────────────────
PK (employee_id, location_id)        id (uuid, PK)
hcm_balance         INTEGER           employee_id, location_id
last_reconciled_version  INT          start_date, end_date, days
as_of               DATETIME          status (enum)
created_at, updated_at                idempotency_key (uniq)         -- client dedupe
                                      hcm_ref (nullable)             -- HCM ack id / watermark
balance_ledger_entries                reason, created_at, updated_at
──────────────────────────────       version (optimistic lock)
id (uuid, PK)
request_id (FK)                      outbox_messages
employee_id, location_id             ───────────────────────────────────────
amount         INTEGER                id (uuid, PK)
phase   (RESERVE|COMMIT|RELEASE|      request_id (FK)
         HCM_ADJUSTMENT)              type (DEBIT|CREDIT)
state   (ACTIVE|RELEASED|RECONCILED)  idempotency_key
hcm_version (nullable)                payload (json)
created_at                            status (PENDING|INFLIGHT|DONE|FAILED|DEAD)
                                      attempts, next_attempt_at, last_error
reconciliation_events                 created_at, updated_at
───────────────────────────────
id, type (RECONCILED|BALANCE_INCREASED|OVER_ALLOCATED|DRIFT_DETECTED)
employee_id, location_id, delta, detail (json), created_at
```

Indices on `(employee_id, location_id)` across tables; `outbox_messages(status, next_attempt_at)` for
the processor; unique on `idempotency_key`.

---

## 10. Test Strategy (the deliverable's center of gravity)

The brief states the value of agentic development lies in test rigor. Tests are organized into
families, each mapped to challenges in §4. Coverage target: **≥90% lines/statements/functions, ≥80%
branches**, enforced in `jest.config.js`.

### 10.1 Layers

- **Unit** (`test/unit`) — pure logic, no Nest/DB: balance arithmetic, the state-machine transition
  table (legal/illegal transitions), reconciliation delta math, idempotency dedupe, circuit breaker.
- **Integration** (`test/integration`) — real Nest module graph + **in-memory SQLite** + in-process
  mock HCM: full lifecycle, outbox draining, reconciliation, drift.
- **E2E** (`test/e2e`) — HTTP via supertest against a booted app: the documented endpoints, error
  envelopes, idempotency headers.

### 10.2 Scenario matrix (each row is at least one test)

| Challenge | Scenario | Expected |
|---|---|---|
| C2 | Two concurrent submits, balance only covers one | exactly one PENDING, other 409; ledger sum correct |
| C2 | N concurrent submits draining balance to 0 | no over-reserve; `available` never < 0 |
| C1/C6 | Approve → outbox retried 3× (transient HCM 503) | HCM debited **once**; request COMMITTED |
| C6 | Duplicate `Idempotency-Key` on approve | single effect |
| C4/C10 | HCM down at approve time | request APPROVED instantly, outbox PENDING; drains to COMMITTED when HCM recovers |
| C4 | HCM authoritatively rejects (insufficient) | request FAILED, hold released, balance restored |
| C5 | HCM **silently accepts** an over-draw (returns 200, no error) | post-commit verify / next reconcile detects drift → DRIFT_DETECTED / OVER_ALLOCATED, not silent corruption |
| C3 | Anniversary bonus via realtime webhook mid-flight | available rises; in-flight request unaffected; BALANCE_INCREASED event |
| C3 | Jan-1 refresh via batch corpus | snapshot replaced; available recomputed |
| C7 | Same batch corpus ingested twice | idempotent; no double count; commits matched by hcmRef |
| C7 | Batch arrives that already includes our committed debit | committedPending term drops; available correct (not double-subtracted) |
| C8 | Stale (older version) webhook after newer batch | ignored |
| C9 | HR reduces balance below committed | available negative tolerated; OVER_ALLOCATED event raised; no request deleted |
| — | Cancel after commit | CREDIT reversal enqueued; HCM credited once; balance restored |
| — | Illegal transition (approve a CANCELLED request) | 409/422; no ledger change |

### 10.3 Mock HCM & fault injection

A runnable mock HCM (standalone server + in-process double sharing one core) supports, via a control
API, simulation of: insufficient-balance rejection, invalid-dimension rejection, **silent success
(accept-and-ignore)**, latency, transient 5xx (configurable failure count then recovery), anniversary
credit, and full-corpus emit. Tests assert ExampleHR behavior under each fault.

### 10.4 Proof of coverage

`npm run test:cov` produces `text-summary` (console), `html` (`coverage/index.html`), and `lcov`
artifacts; CI fails under threshold. The README documents how to regenerate.

---

## 11. Alternatives Considered

| Decision | Chosen | Alternatives & why rejected |
|---|---|---|
| **Balance representation** | Reservation **ledger** (append-only) + cached HCM snapshot | (a) _Single mutable counter_: simplest, but cannot atomically separate "reserved" from "committed" from "authoritative," loses audit trail, and makes C7 reconciliation guess-work. (b) _Event sourcing the whole domain_: maximal auditability but heavy for the scope; ledger gives 80% of the benefit at 20% of the cost. |
| **HCM propagation** | **Transactional outbox** + idempotent processor | (a) _Synchronous call inside request txn_: couples user latency to HCM uptime, loses writes on crash (fails C4/C10). (b) _External queue (Kafka/SQS)_: great at scale but adds infra the assignment scopes out (SQLite, single service); outbox is the same guarantee in one DB. We note the migration path (§12). (c) _2-Phase Commit / XA with HCM_: HCM doesn't expose a transaction manager; impossible across a vendor boundary. |
| **Consistency model** | **HCM-authoritative, local eventual convergence** (cache + intent) | (a) _Strong sync read-through on every op_: each user action blocks on HCM; defeats "instant feedback" (G1) and dies when HCM is down. (b) _ExampleHR as source of truth_: contradicts the business reality that HCM is SoR and gets independent updates (C3). |
| **Exactly-once** | **Idempotency key + dedupe at HCM/mock** | _Distributed transactions_: not available across the vendor boundary. Idempotency is the standard, achievable guarantee. |
| **Reconciliation matching** | **`hcmRef` + monotonic version watermark** | _Timestamp-only_: clock skew and equal-timestamp races cause double counting (C7/C8). Versions are monotonic and unambiguous. |
| **DB** | **SQLite (better-sqlite3)** per brief | Postgres would give true row-level `FOR UPDATE` and concurrency; we use `BEGIN IMMEDIATE` to get correct serialization on SQLite and document the Postgres swap (§12). |
| **Trusting HCM errors** | **Defensive: never trust "no error" alone** | _Trust HCM validation_: brief explicitly warns errors "may not always be guaranteed" (G5). We pre-validate and verify/reconcile. |
| **Downward correction** | **Tolerate negative + raise OVER_ALLOCATED** | _Force-cancel newest requests to fit_: silently destroys approved time off and user trust; correction belongs to a human via a surfaced exception. |
| **API style** | **REST + OpenAPI** | GraphQL adds schema/runtime weight; webhook + batch ingestion are inherently REST-shaped; REST is simpler to test and document for this surface. |

---

## 12. Production Hardening / Path to Scale (out of scope, documented)

- **SQLite → Postgres:** replace `BEGIN IMMEDIATE` critical section with per-`(emp,loc)` row lock
  (`SELECT … FOR UPDATE`) or a Postgres advisory lock; everything else (ledger, outbox, reconcile)
  ports unchanged.
- **Outbox → real broker** (Kafka/SQS) when multi-instance: outbox becomes the relay's source,
  preserving exactly-once semantics; add a partition key of `(emp,loc)` to keep per-employee order.
- **Multi-instance safety:** outbox processor needs a claim/lease (`UPDATE … SET status=INFLIGHT,
  owner=… WHERE status=PENDING` with `SKIP LOCKED` on PG) so two instances don't double-send.
- **Observability:** structured logs already on every HCM call + reconciliation event; add metrics
  (outbox lag, drift count, circuit state) and tracing across the HCM boundary.
- **Security:** gateway-terminated authN; per-endpoint role checks; webhook signature verification on
  the HCM-facing sync endpoints.
- **Backpressure/poison messages:** outbox `DEAD` status + max-attempts + dead-letter inspection
  endpoint (modeled; alerting added in prod).

---

## 13. Open Questions / Assumptions

- **A1 — "days" granularity:** treated as an integer quantity per the assignment. Decimal/half-days
  and business-day expansion are an additive change (the ledger amount becomes decimal; math is
  unchanged).
- **A2 — Single leave type.** Per "balances are per-employee per-location," we model one fungible
  bucket. Adding leave types becomes a third dimension on `balances`/ledger keys; design is
  unchanged otherwise.
- **A3 — HCM idempotency contract.** We assume HCM honors an idempotency key (our mock does). If a
  real HCM does not, we add a client-side de-dupe/compensation guard and rely more heavily on
  post-commit verification (§6.5).
- **A4 — Version/`asOf` from HCM.** We assume HCM provides a monotonic version or `asOf` per balance.
  If only timestamps exist, we derive a synthetic monotonic counter on ingest and document the
  weaker guarantee.
- **A5 — Approval model.** Single approval step; routing/hierarchy is upstream.
```
