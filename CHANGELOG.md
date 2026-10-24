# Changelog

All notable changes to this project. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semantic versioning](https://semver.org/).

## [0.5.0] - 2026-10-24

Observability, measured scaling evidence, and a recorded demo.

### Added

- **Configurable connection pool.** `DB_MAX_OPEN_CONNS`, `DB_MAX_IDLE_CONNS`,
  `DB_CONN_MAX_LIFETIME` and `DB_CONN_MAX_IDLE_TIME` replace the hard-coded
  values; invalid or unsafe combinations are a boot error. `DATABASE_TLS`
  selects MySQL TLS (`true`, `preferred`, `skip-verify`).
- **Observability on a private listener.** `/metrics` exposes HTTP latency,
  in-flight requests, the `database/sql` pool, job runs and limiter fallbacks.
  pprof is an additional opt-in, and production refuses to start with a metrics
  address and no token.
- **`/api/readyz`.** MySQL is required; Redis is reported as degraded without
  removing the replica from rotation.
- **Request deadlines.** `REQUEST_TIMEOUT` (45s by default) bounds every handler
  on top of the existing HTTP server timeouts.
- **Load and multi-process evidence.** `perf/k6` contains smoke, mixed-read and
  two-replica scripts, plus a compose `perf` profile. Two API processes accept
  each other's sessions (153/153 checks). Results and methodology are in
  [`docs/performance.md`](docs/performance.md).
- **A recorded demo.** [`docs/screenshots/demo.gif`](docs/screenshots/demo.gif)
  is a 58-second tour of the seeded app: patient sign-in, clinician discovery,
  a booking review, then the clinician risk queue. `client/scripts/demo.js`
  reproduces it and writes the GIF.
- **A scaling decision record.** [`docs/scaling.md`](docs/scaling.md) and
  [ADR-0004](docs/adr/0004-scaling-model.md) cover pool arithmetic, replication,
  sharding, multiple processes and the provider map. The least-privilege MySQL
  split is in [`docs/sql/least-privilege.sql`](docs/sql/least-privilege.sql).

### Changed

- `server-go/scripts/dev.sh` preserves an explicitly exported `PORT`, so a
  second replica runs without editing the shared `.env`.
- Tests grew to 93 (18 files), including pool/TLS configuration,
  the metrics token, timeout middleware and readiness. The MySQL integration
  suite grew to 16: the previously uncovered reminder claim hand-back, weekly
  report catch-up, trajectory window and admin export kinds now have tests.
- Client dependencies moved to React 19.3.1, Next 16.4.3, Playwright 1.64.1 and
  the grouped TanStack Query, zod and next-intl patches. The API moved to
  Prometheus 1.25.0; the realtime module now matches the API's JWT and Redis
  versions.

### Security

- **Next.js 16.4.3** for GHSA-2464-fhr4-w9xw, a critical image-optimization
  RCE, plus the accompanying App Router advisories fixed in 16.4.1.
  `eslint-config-next` was aligned to the same version. React was aligned to
  19.3.1 when react-dom moved, because that package requires it.

## [0.4.0] - 2026-10-20

The backend is Go, and the schema workflow moved with it.

### Changed

- **The API is `server-go/`.** Express, Prisma and the Node test suite are gone.
  The same HTTP contract now runs on chi and `database/sql` over the same MySQL
  schema; the twelve Playwright journeys against the composed Go stack hold it
  in place.
- **Schema and seed are Go.** The 20 migrations are embedded `golang-migrate`
  files with a one-time baseline for databases built by the old runner;
  `cmd/migrate` is the only migration runner and `cmd/seed` replaces the Node
  seed.
- **CI, Compose and the dispatch-only CD workflow build the Go services.**
  Migration is a separate one-shot container and deploy step; the serving image
  never touches the schema.
- **AI calls Command Code's OpenAI-compatible gateway** (DeepSeek V4.1 Flash)
  on all six surfaces, with deterministic fallbacks, prompt fencing, a circuit
  breaker and typed provenance.
- **OpenAPI is generated from the live chi router**, with request paths,
  security metadata and response schemas for the client-critical endpoints.
- **SMTP mail, web push, S3-compatible uploads and Sentry** are wired.
  Scheduled jobs deliver in-app notifications only; transactional mail from
  request handlers works independently.
- **Tests and gates re-established against Go**: 75 tests, including a 12-case
  MySQL integration suite for refresh rotation and reuse, login lockout, slot
  claims, payment settlement, care-plan versioning, review aggregates, TOTP
  replay and backup codes, export/job secrets, mood upserts and UUIDv7.

### Fixed

- Midtrans signature verification now covers `status_code`; chargebacks and
  `partial_refund` map to the states they describe. The Node implementation
  checked `transaction_status` instead.
- Development seed slots are anchored at UTC midnight of the WIB day, so a
  browser running in UTC sees the weekday slots the seed intended.
- The migration SQL files are no longer caught by the repository's blanket
  `*.sql` ignore rule.

## [0.3.0] - 2026-10-17

The clinical-differentiation and hardening work that shipped between 0.2.0 and
0.3.0.

### Added

**Clinical differentiation**

- **Disclosure triage queue** (`GET /api/wellness/risk-alerts`). A worklist rather
  than a log: acknowledging and resolving are separate acts, so an alert picked
  up on Monday and still owed an outcome on Friday no longer looks identical to
  one nobody has seen. Resolution records who and what; the row is kept, because
  "we raised this and dealt with it" is the record a clinician needs when a
  patient returns.
- **Free-text crisis triage.** Deterministic English and Indonesian pattern
  matching on patient-to-clinician messages, with third-party mentions filtered
  out so a message about somebody else does not page anyone. It prompts a human
  and nothing else — there is no code path from a message to an external service.
  SOS now raises the same kind of alert, so there is one queue rather than two
  mechanisms.
- **Care plan** (`CarePlan` / `CareGoal` / `CareStep`). A plan that outlives a
  session, with goals that can be `achieved` or `dropped` — dropped is a real
  state and not a synonym for deleted. Patient-owned, with a treating clinician
  able to contribute what was agreed in a session.
- **Patient-owned safety plan** (`SafetyPlan`). Written by the patient, never
  generated. Separating "reviewed together with a clinician" from "written alone"
  is the point, and that is what `lastReviewedAt` records.
- **Screening trajectory** (`GET /api/wellness/assessments/trajectory`). A scored
  series with an explicit direction, and an `insufficient-data` state rather
  than a confident verdict drawn from two points.
- **LiveKit video.** Room-scoped, short-lived, participant-bound tokens minted by
  the API. A link is no longer sufficient to join a consultation, which it was
  for every previous session on a public `meet.jit.si` embed. The jitsi path
  remains as a documented, disclosed fallback.
- **Access transparency.** Clinician profiles surface real availability patterns,
  licence details and credentials, labelled as the clinician's own statement,
  rather than a fabricated `Mon – Fri 09:00–17:00` when no schedule existed.
- **OpenAPI document** with a drift gate, and `GET /api/docs` in development.

**Platform**

- **CD on merge to `main`**, gated on a `production` environment requiring
  approval. Migrations are applied by the API image's own entrypoint, so the
  command in CI and the command in production are the same one.
- **Compose validated in CI** as a fast first job. A ten-second YAML error was
  previously taking a full test run with it, silently.
- **Repository-wide encoding guard** as a required check.
- **GitHub issue and PR templates**, Dependabot, CodeQL, gitleaks, Trivy,
  least-privilege workflow permissions, job timeouts.
- **Coverage reporting** and badges.
- `LICENSE` (MIT), `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `SUPPORT.md`, `docs/`, an ADR index and template, and a `Makefile` for a
  single-command bootstrap.

### Fixed

**Clinical safety**

- The triage queue dropped an alert assigned to a clinician the moment the
  relationship that created it lapsed. The list query ANDed the relationship
  filter with the assignment filter while the comment above it claimed the
  opposite, and the acknowledge/resolve guard disagreed with the list — so an
  open disclosure of thoughts of self-harm was invisible in the queue and in the
  badge, while remaining resolvable by direct id.
- Editing one section of a safety plan erased the other five. Every field in the
  schema is optional, so a single-section form sent the rest as `null` and the
  update wrote `null` over them. Data loss on a crisis document.
- The screening trajectory showed the **oldest** sittings in its window as
  "Latest score". MySQL applies `LIMIT` after `ORDER BY`, so past the window
  size a patient's headline score and their improving/stable/worsening verdict
  froze at their earliest sittings — while the raw history on the same screen
  showed the real current score.
- `VIDEO_PROVIDER` was a bare type cast. One typo booted cleanly, fell through to
  the unauthenticated jitsi branch and reported `degraded: false`, so a
  deployment served therapy sessions through a public third-party room while
  telling the client — and the on-screen banner — that the session was fine. It
  is validated at boot now, like `PAYMENT_PROVIDER` before it.
- The LiveKit room never attached remote **audio**. The subscription handler only
  matched video and the SDK auto-attaches nothing, so a consultation was visible
  and silent. Unreachable in practice because the token path was never exercised
  by a test.

**Schema and data integrity**

- `RiskAlert.resolvedById` was declared and written but created by no migration,
  so the queue threw against any `migrate deploy` database.
- `CarePlan.userId` had no foreign key. `SafetyPlan` had one; `CarePlan` did not.
- A migration addressed `doctor` and `waitlistentry` unquoted and lowercase while
  the baseline creates `Doctor` and `WaitlistEntry`. Invisible on Windows, fatal
  with `ER_NO_SUCH_TABLE` on Linux — which is where CI runs.
- Calendar dates were shape-checked, not calendar-checked: `2026-02-31` was
  accepted and silently stored as 3 March, and `2026-13-45` returned a 500.

**Security**

- The public doctor directory returned every clinician's `phone_number`, and —
  because the query used `include` with no `select` — their `bankName`,
  `bankAccount` and `bankHolder` on every page load. The detail endpoint had
  deliberately omitted the phone number; the directory never got the same
  treatment.
- A patient's `User.name` is free text and reached a clinician's notification and
  WebSocket payload verbatim, so it was possible to register with an `onerror`
  handler and have it render in a clinician's session. Six free-text fields
  across the codebase had the same gap; all are sanitised at one choke point
  now.
- A chat `attachment.url` was any string, stored and returned to the
  counterpart — a phishing link or a tracking pixel, from a patient to a
  clinician. Constrained to the two shapes the upload route actually produces.
- The chat upload route was missing the multipart field limits its sibling route
  already had, so thousands of 1 MB text fields alongside a 1-byte file buffered
  hundreds of megabytes in process RAM.
- Rate limits were per-process and one bucket served login, password reset and
  2FA, so twenty anonymous requests could deny a victim the ability to log in,
  reset a password, or complete 2FA for fifteen minutes. The per-account limiter
  never applied to 2FA at all, because that route has no `email` field to key on.
- Swagger UI was public *and* exempt from rate limiting.
- `@types/multer` was a runtime dependency, shipping TypeScript declarations into
  the production image.
- The specialty filter offered seven hardcoded names with **zero overlap** with
  the eight the seed creates, so every filter button returned an empty directory.

**Correctness**

- `prisma.appointment.create` in two test helpers mixed Prisma's checked and
  unchecked input forms, which throws "Argument `user` is missing" — 22 tests
  failed before reaching an assertion.
- `openapi.test.ts` read `operation.request`. The generator emits `requestBody`,
  so every read returned `undefined` and the assertion failed looking like a
  missing schema.
- Six routes turned a non-numeric path parameter into a 500.
- The directory cache key ignored the page size, so the 20-per-page directory and
  the 50-per-page booking page shared one entry and whichever landed first
  dictated the other's row count and page count for 60 seconds.
- `_count: { select: { reviews: true } }` counted moderated-away reviews on
  public cards, disagreeing with the rating beside it.
- "Open conversation" on the triage queue linked to `/messages/{id}`, which is
  not a route. The highest-stakes link in the product returned 404.
- The triage queue rendered its reassuring empty state on a 403, a 500 and a
  dropped connection alike, because there was no error branch — so a clinician
  who could not load the queue was told there was nothing in it.

**Performance**

- The admin dashboard loaded every completed appointment into Node heap, each row
  carrying a full `Doctor` object, to sum one integer column. Now aggregated in
  SQL.
- `distinct` in Prisma is applied after the fetch, so the "unique patients"
  count still loaded the doctor's whole booking history.
- Twelve indexes for queries doing full table scans, including the message
  keyset pagination that the client polls every five seconds.
- The care check-in job ran on every replica, unlocked, doing ~120k queries a run
  to produce the same notifications.

## [0.2.0] - 2026-09

First tagged release. A complete telehealth platform: booking with slot
integrity, chat gated on a clinical relationship, PHQ-9 and GAD-7 with disclosure
triage, AI provenance as a type, availability patterns, waitlists, packages and
checkout, referral credits, VAPID web push, 2FA, and a Go WebSocket service.
