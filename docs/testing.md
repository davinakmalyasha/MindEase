# Testing

Three suites, three languages, and one hard constraint that shapes all of them:
**the server suite runs against a real MySQL database with real Argon2
hashing.** That is deliberate, and the rest of this document is mostly about
what it costs.

## The three gates

| Gate | Command | Runs against | Count |
|---|---|---|---|
| **Server** | `cd server && npm run typecheck && npm test` | Real MySQL 8, real Argon2, Supertest over the real Express app | 456 tests, 34 files |
| **Realtime** | `cd server-realtime && go test -race -cover ./...` | In-memory, real `gorilla/websocket` connections | 31 tests, 5 files |
| **Web** | `cd client && npm run lint && npm test && npm run build` | jsdom | 46 tests, 6 files |

Counts are from `npx vitest list --run`, `go test -list` and the Vitest client
run, not from prose elsewhere in the repository. If they disagree with a README
or a diagram, that document is wrong.

The e2e suite (`client/e2e/journeys.spec.ts`, 12 Playwright tests across 10
`test.describe` blocks) is a fourth gate that is **not** required — see
[Why e2e is not required](#why-e2e-is-not-required).

## Server

### Prerequisites

- Node 22+
- MySQL 8 running and reachable, with a `mindease_test` database
- Redis is **not** required. The code degrades to in-memory and the tests assert
  the degraded behaviour.

```bash
cd server
npm install
npm run test:db          # create + sync mindease_test
npm run db:seed          # only needed for e2e, not for `npm test`
npm run typecheck
npm test
```

`npm run test:db` is `prisma db push --skip-generate` against
`mysql://root:@localhost:3306/mindease_test`. CI uses
`prisma migrate deploy` instead — see
[the drift gate](#the-drift-gate) for why that difference matters.

### Why a real database, and why SQLite is not an option

The datasource is a literal `mysql` in `schema.prisma`. That is not negotiable,
and it is worth being explicit about why, because "use an in-memory SQLite for
tests" is the obvious suggestion and it cannot work here:

- **The provider is `mysql`.** Prisma cannot switch provider per test.
- **Every migration is raw MySQL DDL.** Not generated — hand-written
  `migration.sql` files with `utf8mb4_unicode_ci`, `DATETIME(3)`, engine-specific
  index syntax and `ALTER TABLE ... ADD COLUMN` chains. None of it parses under
  SQLite, and some of it has no SQLite equivalent at all.
- **The properties under test are exactly the ones a fake destroys.** A
  unique-constraint race (`MoodEntry`'s `(userId, moodDate)`, `Appointment`'s
  `slotId`, `WaitlistEntry`'s `(doctorId, patientId)`) and an Argon2 hash round
  trip cannot be faked. Mocking the database makes the test assert nothing.
- **Transaction semantics matter to the wipe.** `DELETE` inside an interactive
  transaction with `FOREIGN_KEY_CHECKS` toggled per session is MySQL-specific.

So the suite is slow, and it wipes the database between tests. Both are the
price.

### The wipe

`tests/setup.ts` registers `beforeEach(wipeDb)` **and** `afterEach(wipeDb)` — the
same function, both hooks, on purpose. Every test starts from an empty database
and leaves one behind, so a test that commits data outside the request lifecycle
cannot contaminate its successor.

```ts
await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET FOREIGN_KEY_CHECKS = 0");
    for (const table of TABLES) await tx.$executeRawUnsafe(`DELETE FROM \`${table}\``);
    await tx.$executeRawUnsafe("SET FOREIGN_KEY_CHECKS = 1");
}, { maxWait: 15000, timeout: 60000 });
```

Three details that are load-bearing:

**`DELETE`, not `TRUNCATE`.** `TRUNCATE` implicitly commits, which would
terminate the interactive transaction mid-way. `DELETE` does not.

**One connection.** `FOREIGN_KEY_CHECKS` is a session variable, so every
statement has to share the connection the transaction is on.

**`TABLES` is derived, not listed.** It reads
`Prisma.dmmf.datamodel.models.map(m => m.name)` — the generated client, so a new
model is wiped the day it is created. It was previously a hand-maintained array
of 22 names and had already fallen behind: `PaymentOrder` was added and never
added there. The failure is silent, because FK checks are disabled for the
wipe, so a skipped table is not an error — it is an orphan row that surfaces much
later as a count that is one too high.

There is a guard on that guard: if `TABLES.length === 0` the module **throws**,
rather than turning `wipeDb` into a no-op that lets every test run against the
previous test's data. Far worse than a loud failure.

### Why the suite is serial

`vitest.config.ts` sets `pool: "forks"` and `fileParallelism: false`.

File parallelism would mean multiple Vitest workers sharing one MySQL instance,
and every one of them runs `beforeEach`/`afterEach` `DELETE FROM` across all 27
tables. The tests would delete each other's fixtures mid-run and fail in ways
that look like application bugs. The `forks` pool isolates module state per
worker — necessary because `config/env.ts` captures `process.env` at import time
and several tests mutate it.

### Why the timeouts are 120 seconds

```ts
testTimeout: 120_000,
hookTimeout: 120_000,
```

Vitest's 30 s default is sized for unit tests. Several tests perform six or more
Argon2 hashes plus a full 27-table wipe in `beforeEach` *and* `afterEach`. On a
loaded machine the 2FA backup-code test exceeded 30 s and failed **on a timeout**
rather than on anything about 2FA — two security tests failing for a reason that
had nothing to do with what they were testing, which is worse than no coverage
at all.

### How to add a test

1. **Put it in the right file.** The table below is grouped by subject and the
   boundaries are meaningful — `care-plan.test.ts` is 70 tests because the
   ownership matrix is the bulk of the safety surface, not because it is a
   general-purpose file.

2. **Use `tests/helpers.ts`.** Do not hand-roll user creation:

   ```ts
   import { createUser, createDoctor, createAdmin, setupClient } from "./helpers";

   const patient = await createUser("patient");     // registered + logged in + cookie + CSRF
   const doctor  = await createDoctor();            // and approved, so booking works
   ```

   Each returns a Supertest `agent` carrying the CSRF cookie, the matching
   `X-CSRF-Token` value, and the session cookie. The access token is read out of
   the **cookie jar**, not the response body, because the cookie is the only
   place it is delivered — `accessTokenFrom` exists to model what a browser
   does.

3. **If you touch 2FA, pin the clock.** `pinTwoFactorClock()` /
   `unpinTwoFactorClock()` put TOTP in the middle of the *current* 30-second step.
   Without it, an Argon2 round trip on a loaded machine can outlast the whole
   tolerance window, `2fa/enable` returns 400, and the failure surfaces as an
   unrelated assertion about `TOTP_REQUIRED` several tests later. Always pair
   them.

4. **If the test needs an entitlement, grant it the way the provider will.**
   `grantPaidPackage(userId, packageId)` creates a purchase with a verified
   `paidAt`. A patient-facing self-service purchase is deliberately refused — it
   used to mint unlimited free therapy packages.

5. **If the test needs mood history, use `createMoodEntry`.** It computes the
   timezone-aware day key that `MoodEntry.moodDate` now requires.

6. **Do not mock the service layer.** There is no repository pattern here to
   mock behind; tests go through HTTP.

7. **Assert on the status *and* the reason when the distinction matters.**
   `security.test.ts` has a case where the expected status is 400 rather than
   403, with a comment explaining that the patient *does* own the appointment and
   the failure is a rule they break by asking. A status-only assertion would have
   let the wrong fix pass.

### The three meta-tests

These are not tests of features. They are tests of properties of the codebase,
and they are the reason several of the invariants in
[`security.md`](security.md) hold rather than merely being intended.

**`error-status.test.ts` (5 tests)** — walks `src/` and fails if any controller
derives an HTTP status from a message substring, or any service throws a bare
`new Error` carrying a status-bearing message. It strips comments first, so a
controller *describing* the anti-pattern it was fixed for is not itself flagged.
It also asserts that a typed error is not reclassified by its wording:
`badRequest("Upstream said: patient record not found")` must stay 400.

**`realtime-contract.test.ts` (4 tests)** — the event union lives in three
implementations: the TypeScript `RealtimeEventType`, the Go JSON tags, and the
client hook. Nothing pinned them, so a renamed event type compiled cleanly and
simply stopped arriving. The test re-parses the union from source, collects every
literal passed to `publishEvent` across `src/`, and asserts both directions:

- every published type is declared (catches a renamed event)
- every declared type is published (catches an orphan left after a delete)

It also asserts the Redis envelope shape the Go `redisEvent` struct reads, and
that the Go and client agree on the field names.

**`openapi.test.ts` (7 tests)** — asserts the generated spec matches the
registered routes, so a new endpoint without a spec entry fails in CI. Among the
things it pins: uploads are declared `multipart` not JSON, and the payment
webhook is documented as having no session or CSRF security.

### The drift gate

Not a test, but it lives in the same place and matters more than several of them:

```bash
npx prisma migrate diff --from-url "$DATABASE_URL" \
  --to-schema-datamodel ./prisma/schema.prisma --exit-code
```

It fails when `schema.prisma` and the committed migrations disagree. It has
caught two real defects — a `Doctor.rating` default of `5.0` for clinicians with
no reviews, and a duplicate waitlist unique key — and it is what caught the
missing `CarePlan.userId` foreign key.

## What running the suite against a migrated database changed

This is the most useful thing this document can tell a reader, because it is a
failure mode that is invisible until it is fixed.

**The suite had never been run against a database built by `prisma migrate
deploy`.** It ran against `db push`, which builds the schema *from
`schema.prisma`* and therefore always agrees with it. CI migrated. The two paths
produce different databases whenever a migration file and the datamodel disagree,
and only one of them is what production runs.

The concrete casualty, from the header comment of
[`20260927000000_clinical_continuity/migration.sql`](../server/prisma/migrations/20260927000000_clinical_continuity/migration.sql):

> `resolvedById` was missing. The datamodel declared it and
> `riskQueue.service.ts` wrote it, but no statement here created the column, so
> against a `migrate deploy` database every queue read and every resolve threw a
> `PrismaClientValidationError`.

Under `db push` that column existed, so 25 risk-queue tests passed. Against a
migrated database, the entire triage worklist — the safety-critical feature — was
broken at runtime.

The same file records a second correction: `CarePlan.userId` had no foreign key
while `SafetyPlan` below it did, and the drift gate reported the omission on
every run.

Three generalisable lessons, and they are the reason this section exists:

1. **`db push` tests the datamodel. `migrate deploy` tests the migrations.**
   Production runs `migrate deploy` as the API start script, so that is the one
   that has to be exercised.
2. **A test that only ever saw the schema through the ORM cannot detect a
   column that the ORM believes in and the database lacks.** Every Prisma call
   that mentions the field fails at the driver, not at compile time, and if the
   field is never written on the path under test nothing surfaces.
3. **Hand-written DDL drifts silently.** The migration files are raw SQL with no
   compiler. The drift gate is the only automated check that they still describe
   the schema, and it caught both of these.

Because that migration had never been applied anywhere persistent, both
corrections were edited **in place** rather than added as a follow-up migration —
which is the right call for an unapplied file and a rewrite for an applied one.

## Realtime

```bash
cd server-realtime
go vet ./...
go test -race -cover ./...
```

26 tests across main_test.go, hub/auth_test.go, hub/client_test.go,
hub/hub_test.go and
`hub/hub_test.go`.

`-race` is the point, not a habit. `hub_test.go`'s concurrency cases exist to
catch data races in `Hub.Register`, which takes caps and registers inside a
single `Lock`. The suite was previously compiled without the flag, so those
tests ran and could not detect the thing they were written for.

`auth_test.go` covers the JWT purpose gate — the property that stops a 7-day
refresh token or a not-yet-2FA'd session opening a socket on a channel carrying
private chat.

The local Go toolchain and the cached build cache can disagree (`compile: version
"goX" does not match go tool version "goY"`); `go clean -cache` resolves it.

## Web

```bash
cd client
npm test          # Vitest + jsdom, 46 tests in 6 files
npm run lint
npm run build
```

| File | Tests | Covers |
|---|---|---|
| `tests/api-session.test.ts` | 5 | Cookie handling, token refresh, the session store |
| `tests/notifications-store.test.tsx` | 4 | Notification list state, unread tracking |
| `tests/locales.test.ts` | 5 | EN/ID message parity |
| `tests/json-ld.test.ts` | 7 | SEO structured data |

The client suite was never run in CI, so these regression tests only ever ran
locally. They run now.

`npm run build` is a separate gate from `npm test` on purpose: `NEXT_PUBLIC_*`
values are inlined at **build** time, so a build that succeeds with the wrong
ones still ships the wrong ones. `docker-compose.yml` declares them as build args
for exactly this reason.

## Why e2e is not required

`client/e2e/journeys.spec.ts` — 12 Playwright tests in 10 `test.describe` blocks:
the full patient flow, admin dashboard, forgot-password, assessments and mood
factors, the doctor follow-up and availability pattern, review reply and report,
the SOS modal, admin moderation and exports, a chat smoke test, and a review
lifecycle.

```bash
cd client && npx playwright test     # with the compose stack already running and seeded
```

It has **never been executed by any automated process.** The `docker` job's first
step was `docker compose build`, and it failed — so every later step (four health
checks, the seed, all the journeys) was permanently unreachable, and nothing in
the pipeline noticed, because a job whose first step fails just reports red and
the unreachable steps are never examined.

That same bug killed the `compose` validation job's motivation, which is why
`compose` now runs first, alone, for about ten seconds: a mis-indented key in
`docker-compose.yml` should cost ten seconds rather than a full three-job test
run.

The journeys now run on `workflow_dispatch`, or on a PR labelled `e2e`. They are
not a required check yet, on purpose: they run on selectors that have never been
exercised, and reporting a selector failure as a required-check failure on the
first attempt would be the wrong signal. Everything above them — build, boot,
four health checks, seed — *is* gated, because that part has a known-good
expectation and a red there is always a real defect. It is promoted to required
once green.

## The 34 server test files

| File | Tests | What it covers |
|---|---|---|
| `access-log-redaction.test.ts` | 5 | **Meta-test.** Access logs carry no query-string values, so `?search=<patient email>` cannot reach the log store, while the query keys and the header redactions survive |
| `ai-provenance.test.ts` | 16 | `AiResult` shape, prompt fencing reaching the model, circuit breaker states and transitions, timeout passed to the provider |
| `ai-provenance-http.test.ts` | 5 | `briefingSource` persisted and returned; provenance survives to the client over HTTP |
| `appointment.test.ts` | 9 | Booking a slot and locking it, idempotency-key replay, double-booking and overlap rejection, doctor confirmation without minting a public meeting link, slot release on cancel, reschedule to pending, ownership on cancel |
| `auth.test.ts` | 11 | Register, weak-password rejection, no self-promotion to admin, duplicate email, wrong password, lockout after 5 failures, refresh rotation, CSRF enforcement, banned users, email OTP verification, admin route gating |
| `care-plan.test.ts` | 70 | Ownership matrix, role gates, goals, steps, safety plan CRUD, clinician read side, review, validation |
| `care-plan-regressions.test.ts` | 9 | A partial safety-plan save must not erase the rest; calendar date handling; the clinician read that was missing |
| `crisis-triage.test.ts` | 17 | `detectFreeTextRisk` pattern behaviour, the third-party mention that informs an alert without suppressing it, `lastIndex` safety, patient-only gating, the message path end to end, markup stripping |h end to end |
| `doctor-directory.test.ts` | 8 | Public directory filtering, pagination, `/specialties` derived from data |
| `error-status.test.ts` | 5 | **Meta-test.** No substring-derived HTTP status anywhere in `src/` |
| `features.test.ts` | 50 | Journal, mood factors, PHQ-9/GAD-7, review replies, consultation rooms, weekly report, doctor analytics, notification prefs, availability patterns, SOS, review reports, rebook assist, AI matching, admin exports, waitlist, follow-ups, packages, referrals, chat upgrades, away mode |
| `hardening.test.ts` | 11 | Booking integrity, referral credits, package reservation integrity, 2FA backup codes, journal ownership, waitlist maintenance |
| `infra.test.ts` | 6 | Notification pagination with totals, doctor directory pagination and review counts, non-admin rejection, admin broadcast plus its audit log, GDPR data export, CORS origin allow/deny |
| `openapi.test.ts` | 7 | **Meta-test.** Spec matches registered routes; multipart uploads; webhook security model |
| `payment-config.test.ts` | 11 | Unknown provider is a boot error; production refuses the simulator without the explicit opt-in; production secret validation |
| `payments.test.ts` | 18 | Package checkout, `PaymentOrder` mapping, callback idempotency per `orderId`, entitlement integrity, `sessionsLeft` decrement |
| `phase2-integrity.test.ts` | 6 | Reschedule slot bookkeeping, away window on the public profile, honest mood re-log replacement |
| `rate-limit-store.test.ts` | 3 | **Meta-test.** No bare `rateLimit({` may exist, the helper injects a store, and the limiter count is pinned so adding one is a deliberate act |
| `rate-limit-store-isolation.test.ts` | 2 | **Meta-test.** A `Store` instance is never reused across limiters, and keys are namespaced per limiter |
| `realtime-contract.test.ts` | 9 | **Meta-test.** Event union vs Go JSON tags vs client hook, both directions |
| `reminders.test.ts` | 3 | Reminder window eligibility, one send per appointment, two runners racing sends once |
| `risk-queue.test.ts` | 25 | `priorityFor` ordering, queue scoping and counts, acknowledge/resolve transitions and their audit entries, `assertCanTriage` |
| `role-guards.test.ts` | 14 | Unauthenticated callers refused; wrong role refused; the guards are actually mounted |
| `security.test.ts` | 10 | **IDOR matrix.** Cross-patient reads, cross-doctor writes, briefing visibility |
| `support.test.ts` | 13 | Support chat, crisis routing to hotlines, the deliberate non-disclosure exception, and the SOS delivery rule: what the patient is told is derived from what was delivered |
| `trajectory.test.ts` | 21 | Screening trajectory: instrument selection, series ordering, insufficient-data threshold, limit, ownership |
| `two-factor-disable.test.ts` | 7 | Disabling two-factor needs a password *and* a current code, clears every 2FA field, revokes the refresh token and every other session, and cannot be replayed once disabled |
| `twofactor.test.ts` | 8 | TOTP enrolment, verification, replay rejection via `lastTotpStep`, backup codes |
| `verification.test.ts` | 5 | Doctor verification workflow — hidden until approved |
| `video-config.test.ts` | 5 | Provider parsing; unknown provider rejected rather than falling back; missing credentials reported |
| `video-fallback.test.ts` | 4 | Degraded jitsi reporting with a reason; half-configured livekit; no token on the jitsi path |
| `video-token.test.ts` | 12 | Room scoping, TTL bounds, refusal on a closed window, secret never in the payload, `buildGrant` shapes |
| `wave0-regressions.test.ts` | 41 | Token purpose separation, 2FA enforcement, credential lifecycle, clinical data lifecycle, slot and availability integrity, public data exposure, input validation, error disclosure, timezone-correct day boundaries, mood logging invariants |
| `wellness.test.ts` | 10 | Mood logging and stats, range rejection, a repeated same-day log as an update rather than a duplicate, streak calculation and breakage, day-window averaging, ownership, unbounded history rejection |

Total: 427.

`care-plan.test.ts` and `wave0-regressions.test.ts` are the two largest files
because they encode the two most expensive regressions this codebase has had —
care-plan ownership and the auth hardening wave. Neither is a dumping ground;
both are grouped by subject and the describes are legible.