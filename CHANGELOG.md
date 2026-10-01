# Changelog

All notable changes to this project. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semantic versioning](https://semver.org/).

## [Unreleased]

Everything below is unreleased and lives on
`feat/clinical-tier1-and-docs`. `main` is at the state described as `0.2.0`.

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

### Known issues

Carried forward in the README's known-limitations section: the payment
idempotency race, integer ids against a UUIDv7 requirement, `node-cron` instead
of a durable queue, and the two advisory guard scripts.

## [0.2.0] - 2026-09

First tagged release. A complete telehealth platform: booking with slot
integrity, chat gated on a clinical relationship, PHQ-9 and GAD-7 with disclosure
triage, AI provenance as a type, availability patterns, waitlists, packages and
checkout, referral credits, VAPID web push, 2FA, and a Go WebSocket service.
