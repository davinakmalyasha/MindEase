# Testing

Three suites and one browser suite. The browser suite exercises the whole
system; the Go API suite adds a MySQL-backed integration layer for the races a
browser only touches by luck. The old
Node integration suite was not ported — that gap is named at the end rather than
papered over.

## The suites

| Gate | Command | Runs against | Count |
|---|---|---|---|
| **Go API** | `cd server-go && TEST_DATABASE_URL=... go test ./...` | Unit in-process; integration against real MySQL 8 | 93 tests, 13 files |
| **Realtime** | `cd server-realtime && go test -race -cover ./...` | In-memory, real `gorilla/websocket` connections | 32 tests, 5 files |
| **Web** | `cd client && npm run lint && npm test && npm run build` | jsdom | 52 tests, 8 files |

Counts are derived from the tree by `scripts/check-numbers.js`, which fails the
build if this table disagrees with the repository.

The end-to-end suite is `client/e2e/journeys.spec.ts`: 12 Playwright tests in 11 describe blocks, plus three cached sign-ins in `auth.setup.ts`. It runs against
the real stack — MySQL, Redis, the Go API, the Next client — and is a required
step in CI's `docker` job.

## The Go API

The unit tests are deliberately narrow. They pin the properties that are easy to
break silently and impossible to see in a browser:

- **Production config guards.** `internal/config/config_test.go` proves that
  `Load` refuses a missing, known-weak, template-placeholder or `dev_`-prefixed
  secret in production, that the three signing secrets must differ, that the
  payment provider must be one of the known names, and that development still
  falls back to the simulator and jitsi.
- **Token purposes.** `internal/server/tokens_test.go` proves an access token
  round-trips, and that a refresh token, a pending 2FA ticket and a websocket
  ticket are each rejected when presented as an access token — they share
  secrets with other flows by design, so the audience check is the only thing
  keeping them apart.
- **Password hashing.** `argon_test.go` proves the PHC round trip, that malformed
  hashes never verify, and that the miss-path dummy hash never returns true. The
  seeded logins are the integration proof that the hashes the seed writes and the
  hash the server verifies are the same format.
- **Mail and push.** `mail_test.go` proves the OTP template carries the code and
  that the notification template escapes user-controlled titles and messages;
  push is a no-op without VAPID keys, which is what lets it run in CI.
- **The route table.** `openapi_test.go` asserts the generated document lists
  the sampled routes, marks authenticated routes, leaves health public, carries
  the security schemes, resolves every `$ref` to a component, and binds response
  schemas to the client-critical operations.
- **Payment signatures and limiter isolation.** `payments_midtrans_test.go`
  proves the signature covers `status_code` (not `transaction_status`), maps
  the full transaction-status matrix onto the four outcomes, and rejects
  unknown states, missing fields and bad signatures; `ratelimit_test.go`
  proves stacked limiters keep separate counters, the window is fixed (a
  decrement never extends it), over-decrements clamp at zero, concurrent
  bumps are exact, the middleware emits 429 with `RateLimit-*` headers,
  `skipSuccessful` counts failures only, and health/internal paths are exempt.
- **Pool and transport settings.** `internal/db/db_test.go` proves the pool
  options are bounded and that TLS cannot be silently dropped from a raw DSN;
  `observability_test.go` covers the metrics token, route-pattern labels,
  timeout middleware and readiness failure; `config_test.go` covers the new
  pool/timeout/metrics guards.
- **The model client.** `internal/ai/client_test.go` runs against a fake
  OpenAI-compatible server: success parsing, provider errors, empty content and
  context timeouts. `ai_test.go` pins the fencing (a patient-supplied closing
  marker is neutralised), the JSON-fence stripping, and the provenance contract
  (a model result never carries a degraded reason).

```bash
cd server-go
go test ./...                                  # unit only; integration skips
TEST_DATABASE_URL=mysql://... go test ./...    # unit + integration
go vet ./...                                   # CI runs this and golangci-lint v2
```

`integration_test.go` runs the real handler chain against MySQL. `TestMain`
creates the database if needed, drops every table, and applies the embedded
migrations; each test wipes the data tables first, so every assertion starts
from a known state. The 34 integration tests pin:

- refresh rotation, replay detection and the session revocation that follows it
- the five-failure lockout
- the atomic slot claim, plus idempotent replay returning the stored row
- the payment `liveKey` claim, simulated settlement, and claim release
- care-plan optimistic concurrency: of two writers with the same version,
  exactly one wins with a 409 for the other
- review aggregates excluding hidden reviews, and one review per appointment
- the wire shapes the client reads (profile, directory, detail, mood, journal,
  notifications, appointments, plans, reviews, payment config), including that
  no credential field leaks into the profile
- TOTP verification: a replayed code inside the step window is rejected, a
  backup code is single-use, and spending one does not invalidate the others
- role guards, account export headers and content, the internal job secret,
  one-mood-per-day, and UUIDv7 identifiers
- the reminder claim: a delivered reminder stamps once, a second run is silent,
  and a forced double delivery failure hands the claim back so the retry works
- the weekly report: one report per week, and a missed week fires on the next
  daily run
- the assessment trajectory window (newest scores, not oldest) and its
  `insufficient-data` verdict
- every admin CSV export kind, including the unlisted-kind bookings fall-through
- public doctor reviews carry a pseudonym and no reviewer identity
- the patient appointments list embeds no pre-session data or briefing text
- an SOS with no assigned clinician is recorded as unassigned, pages an admin,
  and can be acknowledged and resolved by one
- profile updates persist for patients and doctors without changing verification
- a TOTP code from the +1 edge of the window cannot be replayed
- `/uploads/` answers 404, never a directory listing
- the copilot draft is doctor-only and assigned-only, writes nothing but its
  audit row, and grounds every claim: citations name real rows, an empty
  timeline reads as insufficient data
- the risk-queue scoping matrix: assigned alerts visible outright (even with a
  lapsed relationship), unassigned visible only with a live relationship,
  assigned-to-another invisible; patient 403, anonymous 401; counts, priority
  order, per-item `clinical.read` audit, and resolved alerts hidden unless
  `includeResolved`
- the acknowledge/resolve transitions: stranger 403s, malformed 400s, unknown
  404s, double-ack and double-resolve 400s, resolve-without-ack implies the
  acknowledgement (audited), and note validation (missing/empty/whitespace as
  no-note; too-long, unknown-key and null as 400)
- payment outcomes beyond settlement: `pending` records without granting and
  holds the `liveKey` claim (second checkout 409s), a replayed settlement
  grants nothing, a tampered amount is rejected, `failed`/`expired` release
  both rows so checkout works again, and unknown or malformed callbacks never
  grant
- the join-window gate (opens-in/closed minutes, non-active status, chat-only
  type, stranger 403, degraded jitsi minting no token), the ICS export
  (confirmed-only, participant-only, escaping, UID/DTSTART shape), and the
  reschedule rules (owner-only, terminal-state and past rejection, overlap
  409, reset to pending with room/reminder state cleared)
- the check-in paths: the mood-decline nudge and its `RiskAlert` (unassigned
  with `risk.raised`, or assigned with the clinician notified and stamped),
  the mood-nudge and post-session check-in firing exactly once, and the
  single-runner lock (locked-out dispatch is silent success, DB leases release
  by expiry with atomic takeover of expired rows)

Nothing in the unit files needs MySQL or Redis.

## The realtime hub

```bash
cd server-realtime
go test -race -cover ./...
```

The hub's tests exist for concurrency: authentication before the upgrade, origin
allowlisting, idempotent unregister, drop counters incremented under the correct
lock, and error propagation from the socket pumps. `-race` is the point; CI runs
it on every push.

## The web client

```bash
cd client
npm run lint
npm test
npm run build
```

The unit tests are a jsdom harness for the session store, post-login routing,
doctor mapping, JSON-LD, locale parity and the login form's handling of
credentials. The build is part of the gate: a type error or a server/client
boundary mistake fails it before a browser ever opens.

### Coverage

Coverage is measured per layer. There is no single blended number: Vitest
reports statements, branches, functions and lines, while Go reports statements
only and the browser suite has no instrumentation.

| Layer | Latest CI read (2026-10-27) | Scope | Gate |
|---|---|---|---|
| Client unit | **2.68%** statements/lines, **75.6%** branches, **69.27%** functions | Every app file (`all: true`); eight unit-test files | Floors `2 / 75 / 69 / 2` |
| Go API | **24.4%** statements | All Go packages, including the MySQL integration suite; the `cmd/*` wrappers and migration package are 0% | Reporting only |
| Go realtime | **62.2%** statements | All realtime packages; the race suite | Reporting only |
| Playwright | No code coverage | 12 journeys against the full stack | Required run |

The client's statement and line figures are diluted by `all: true` counting
every app file while only a handful have unit tests; the branch and function
numbers are the ones that move with that suite. The API's 24.4% is the next
engineering target, not a threshold: the browser suite exercises the handlers,
but no server-side handler coverage is claimed from it. The Go profiles are
deliberately reporting-only until a stable baseline is set; only the client
floors fail a run.

Produce the Go numbers locally with `make coverage-go` (API integration needs
`TEST_DATABASE_URL`); CI uploads `coverage-go-api` and
`coverage-go-realtime` for 14 days. The client report is `npm run coverage` and
the artifact is `coverage-client`.

## The browser suite

The journeys cover registration and login, the admin console, password-reset
requests, assessments and mood, the doctor's schedule and pattern creation, the
reviews section, the SOS modal, admin moderation and exports, the messages page,
and a full review lifecycle (book → accept → complete → review → reply → follow-up
→ conversation). Two of them book through the UI, which is what exercises the
atomic slot claim against a real database.

It requires seeded data:

```bash
# with the stack up (make up), or MySQL/Redis running locally
cd server-go
DATABASE_URL=mysql://... go run ./cmd/migrate
DATABASE_URL=mysql://... go run ./cmd/seed

cd ../client
npx playwright test
```

`npx playwright test` starts the Go API through `server-go/scripts/dev.sh` if
nothing is listening on `:5000` (which loads the root `.env`), and the Next dev
server on `:3000`. In CI the compose stack is already serving both.

The journeys found four product bugs that every other suite was happy with, and
two more during the port itself: a timezone comparison that made every
midnight-WIB slot look like the wrong date, and a picker race where today's chip
is enabled until the slot query lands. Both are the class of defect that only a
real client against a real server surfaces.

## CI gates

| Job | What it runs |
|---|---|
| `docs` | `check-numbers`, the encoding guard, the workflow self-test and gate, a11y ids, CSP, i18n, UI a11y, load states, stale writes |
| `go` (api-go) | `go vet`, golangci-lint v2.14, `go build`, `go test` with a coverage profile — unit plus the integration suite against a MySQL service container |
| `realtime` | `go vet`, golangci-lint, build, `go test -race` with a coverage profile |
| `client` | lint, unit tests, coverage (gated), production build |
| `compose` | `docker compose config` |
| `docker` | builds the four images, boots the stack, probes health, seeds, runs the 12 Playwright tests in production mode |

Four static analyzers that scanned the Node tree — auth coverage, read-audit
markers, optimistic-write patterns and schema index acknowledgements — retired
with that tree. They analyzed source shapes (`router.get(`, `prisma.$transaction`,
`@@index`) that no longer exist. Their invariants did not disappear: the handler
code ports the checks they were forcing, and the browser suite exercises the
paths. What is gone is the static *proof* that a new route has not skipped them.

## Performance tests

`perf/k6/` is a load suite, not part of CI: it needs a seeded, running stack and
a machine whose numbers mean something. It is runnable through the compose
`perf` profile (`docker compose --profile perf run --rm k6`) or with a local
`k6` install:

- `smoke.js` — one VU, five iterations; login, readiness, directory, detail.
- `load.js` — mixed cached and authenticated reads, 20s ramp / 60s hold; `VUS`
  overrides the target for a saturation run.
- `multi-replica.js` — sends the same session to two API processes and checks
  that both accept it.

The measured results, the pool-cap experiment and the caveats are in
[`performance.md`](performance.md). The load scripts vary `X-Forwarded-For` per
iteration so the IP limiter does not dominate the result; no limit is disabled.

## What remains uncovered

The integration suite is 34 tests, not 519. Ported: the races and constraints
listed above, plus the browser flows. Still without a handler-level test:

- the live Midtrans webhook end to end in `midtrans` mode over HTTP (the
  status matrix is unit-tested, the simulator outcomes are covered through the
  notification route; the live Snap creation and its phantom-row cleanup are
  not)
- the concurrent-acknowledgement race under true concurrency (the
  `RowsAffected` guard is pinned sequentially, not by two simultaneous writers)
- the scheduler predicates and the weekly-report WIB Monday boundary
- the waitlist maintenance paths (48-hour requeue, 90-day expiry)
- the realtime `risk:alert` fanout into the queue UI's invalidation

The first item is the one that still matters most: money must not move on an
untested path, and the live path is the one real deployments would take. The
rest are exercised by code review and partly by the journeys. Naming
them is the honest form of the coverage claim.

## Adding a test

- **Go API**: a table-driven test beside the code it pins. Handler/database
  behaviour goes in `integration_test.go` and needs `TEST_DATABASE_URL`; unit
  tests need no database.
- **Realtime**: `server-realtime/hub/*_test.go`; use real websockets and keep
  the cases concurrent where the property is a race.
- **Web**: `client/tests/*.test.tsx` with the jsdom harness; keep them behavioural
  (what the user sees) rather than implementation-detail assertions.
- **Browser**: add a journey to `journeys.spec.ts`, reuse the cached
  `storageState` per role, and keep the helpers' documented pitfalls in mind —
  the picker re-renders as data lands, and `count()` does not retry.
