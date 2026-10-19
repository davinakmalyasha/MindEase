# Testing

Three suites and one browser suite. The browser suite exercises the whole
system; the Go API suite adds a MySQL-backed integration layer for the races a
browser only touches by luck. The old
Node integration suite was not ported — that gap is named at the end rather than
papered over.

## The suites

| Gate | Command | Runs against | Count |
|---|---|---|---|
| **Go API** | `cd server-go && TEST_DATABASE_URL=... go test ./...` | Unit in-process; integration against real MySQL 8 | 35 tests, 9 files |
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
  the sampled routes, marks authenticated routes, leaves health public, and
  carries the security schemes.
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
from a known state. The 11 integration tests pin:

- refresh rotation, replay detection and the session revocation that follows it
- the five-failure lockout
- the atomic slot claim, plus idempotent replay returning the stored row
- the payment `liveKey` claim, simulated settlement, and claim release
- care-plan optimistic concurrency: of two writers with the same version,
  exactly one wins with a 409 for the other
- review aggregates excluding hidden reviews, and one review per appointment
- role guards, account export headers and content, the internal job secret,
  one-mood-per-day, and UUIDv7 identifiers

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

Client coverage is measured and enforced in `client/vitest.config.ts` with
floors just under the read baseline (2 / 75 / 69 / 2). The statement figure is
diluted by counting every app file while a handful have unit tests; the branch
and function numbers are the ones that move with the suite.

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
| `go` (api-go) | `go vet`, golangci-lint v2.14, `go build`, `go test` — unit plus the integration suite against a MySQL service container |
| `realtime` | `go vet`, golangci-lint, build, `go test -race -cover` |
| `client` | lint, unit tests, coverage (gated), production build |
| `compose` | `docker compose config` |
| `docker` | builds the four images, boots the stack, probes health, seeds, runs the 12 Playwright tests in production mode |

Four static analyzers that scanned the Node tree — auth coverage, read-audit
markers, optimistic-write patterns and schema index acknowledgements — retired
with that tree. They analyzed source shapes (`router.get(`, `prisma.$transaction`,
`@@index`) that no longer exist. Their invariants did not disappear: the handler
code ports the checks they were forcing, and the browser suite exercises the
paths. What is gone is the static *proof* that a new route has not skipped them.

## What remains uncovered

The integration suite is 11 tests, not 519. Ported: the races and constraints
listed above, plus the browser flows. Still without a handler-level test:

- the Midtrans signature path (the in-process simulator is covered)
- TOTP replay protection and single-use backup codes
- the job claim hand-back and the weekly report's catch-up semantics
- the Redis rate-limit store's window semantics
- trajectory math, and the admin export kinds

Those are exercised by code review and partly by the journeys. Naming them is
the honest form of the coverage claim.

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
