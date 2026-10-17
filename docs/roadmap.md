# Roadmap

Direction, not a list of tickets. Each theme below is tied to something real in
the [README's known limitations](../README.md#known-limitations) — the point is
to say what the gap is, why it is a gap, and what fixing it would cost, so that
the next person can decide rather than rediscover.

Where something is deliberately **not** going to be built, that is stated too,
and it is the most important section in this document.

## Where this is going

The product has reached a point where the clinical surface is the differentiator
and the generic telehealth surface is not. Booking polish, more filters, a
prettier dashboard — none of it changes what this product is for. Every theme
below is either a correctness or safety gap, or a piece of infrastructure the
clinical surface is standing on top of and will keep leaning on.

The two things I would defend hardest as the next six months:

1. **Identifiers.** Every API response exposes a sequential integer. This is the
   single largest security gap in the system and it is a rewrite, which is
   exactly why it needs to be planned rather than discovered.
2. **Durable background work.** Three scheduled jobs run inside the API process
   and can be missed without trace. Nothing about the clinical surface depends on
   them today, which is precisely when it is cheap to fix.

## Themes

### 1. External identifiers

**The gap.** `prd.md` requires UUIDv7 in every external identifier and prohibits
leaking internal ids. Neither is met. Every response exposes
`{ id: 42 }`, and anyone who reads their own record learns the primary-key
sequence and can enumerate.

**Why it is not just "add a column".** Retrofitting means touching 27 models,
every route, every cache key, every export, the `.ics` payload, the GDPR export,
and the three places the realtime contract carries ids. It is a rewrite rather
than a change, and it is recorded in `ARCHITECTURE.md` rather than left for a
reader to discover.

**The direction.** A separate `publicId String @unique @db.Char(36)` alongside
the existing `Int` primary key, with the internal id never leaving the service
layer. That preserves every join, every index and every existing foreign key
while making the public surface opaque. The trap is doing it halfway — a
`publicId` on some models and not others is worse than none, because a reader
cannot tell which is which.

**The cost to be honest about.** It doubles the key surface on every table that
gets it, and it is a two-way mapping that must be correct in the API layer for
every route. It is the right change and it should be a deliberate piece of work
with its own branch, not a side-effect of a feature.

### 2. ~~The payment race~~ — done

**The gap.** Checkout is read-before-create. `PaymentService.createCheckout`
does a `findFirst` for an existing pending purchase, then a `create`. Two
concurrent requests both pass the check and both create, and a callback that
lands for both grants twice. Real, known, and documented in
[ADR-0003](adr/0003-payment-abstraction.md).

**What was done.** Option 1, atomically: `PackagePurchase.liveKey` holds
`userId:packageId` while the purchase is pending and unpaid, and the unique index
over it is the claim. Two concurrent creates cannot both succeed; the service
maps the constraint violation to the same 409 the old pre-check returned, and
settlement clears the key so the patient may buy the same package again later.
A single nullable column rather than a partial unique index, because MySQL has
no partial unique index and a generated column would be invisible to Prisma.

The old guard was a `findFirst` followed by a `create`, which is the race: both
requests read "none" and both inserted. The new test pins the constraint
directly — two inserts with the same key, one P2002 — because a serialized HTTP
sequence would satisfy the read-before-create version too.

The migration backfills the claim for the newest live checkout per (user,
package); older duplicates from the race keep a NULL key and cannot block a
legitimate checkout.

**What does not change.** The `paidAt` invariant. Nothing about fixing the race
relaxes "an entitlement is legitimate only with a verified `paidAt` or an
explicit `grantedByUserId`".

### 3. Durable background work — partly closed

**The gap.** All three scheduled jobs are `node-cron` inside the API process
(`reminders.ts`, `checkins.ts`). A restart, a crash, a deploy or a
scale-to-zero during the scheduled minute means that tick does not happen. See
[`operations.md`](operations.md#the-cron-jobs-and-what-is-durable-about-them).

**What is closed.** A lost tick is now a delay rather than a loss, because every
job's eligibility is a window or a sentinel instead of the tick itself:
reminders re-check the 0–24h window on every run, the check-in nudges and the
post-session check-in are sentinel-based, and the weekly report moved from
`0 7 * * 1` with one six-hour lock to a **daily check claimed per patient**
through `User.lastWeeklyReportAt` — so a Monday lost to a deploy goes out the
next morning, and a crash halfway through the loop retries the remainder without
re-mailing anyone it already reached. A failed send now hands its claim back in
all three jobs; previously the sentinel stayed set and the nudge disappeared
until the next period, or forever for a post-session check-in. The
`acquireLock` fallback no longer "reads as a lock and is not": without Redis it
is a `JobLock` row, and the documentation claiming otherwise is corrected.
Every run logs what it sent, because a silent zero is the signature of a broken
job.

**What remains is deployment, not code.** `src/worker.ts` now runs the same
registry on the same schedules (`npm run worker`), and the API forwards its cron
ticks to it when `JOBS_WEBHOOK_URL`/`JOBS_SECRET` are set - so the schedule can
outlive an API deploy without another line of code. What is not done is running
it: that is a second service and a deploy-shape decision, carried as an optional
item in the README's deploying checklist. The sentinel columns already are the
durable job table; a `SELECT ... FOR UPDATE SKIP LOCKED` loop inside the jobs
remains a possible later refinement, not a prerequisite.

It also stays Tier 2 rather than Tier 1 for a reason that must survive any
refactor: nothing safety-relevant runs on this schedule - `raiseRiskAlert` is
synchronous inside the request that observes the risk - and it becomes Tier 1
the moment anything safety-relevant moves off the request path.

### 4. ~~Advisory guard scripts~~ — done

**The gap.** Two repo guards were wired into CI with `continue-on-error: true`
and neither worked.

`check-operators.js` looked for a typographic dash between two code tokens. It
declared a `CODE_POSITION` regex and never used it; what it actually checked was
"does any typographic dash survive stripping", and it stripped only `//`
comments, not `/* */` block comments — so every finding was prose in a doc
comment, JSX text, or an email template.

`check-dependencies.js` reported `@eslint/js` and `typescript-eslint` as unused
because it did not scan `eslint.config.mjs`, where they are used, and it did not
know that jsdom and testing-library arrive via Vitest's config rather than an
import.

**What was done.** `check-operators.js` was **deleted rather than fixed**,
because the thing it looked for is already caught, better, by two gates that
were already required: an em dash in a TypeScript expression is `TS1127: Invalid
character` from `tsc --noEmit` — which is how all three historical incidents
were actually found — and the one that landed in `schema.prisma` is caught by
`prisma validate`. In `const x = a — b` and in the JSX text `most people wait
months — or years`, nothing distinguishes prose from code except meaning, which
is what the compiler has and a regex does not.

`check-dependencies.js` was **fixed and promoted**. It now walks the whole
package, which brings `eslint.config.mjs` and `tests/` into scope — the two
blind spots that produced every false positive — matches configuration
conventions by rule (`environment: "jsdom"`, `coverage: { provider: "v8" }`
resolves `@vitest/coverage-v8`), keeps a short `INDIRECT` list with a reason per
entry for runtime-only packages (Prisma's `mysql2` driver, `@testing-library/dom`
as RTL's peer), exits non-zero on a finding, and carries a self-test in each
package pinning every case from its own history. Both steps are required now and
both packages report clean. `check-encoding.js` was the only green guard of the
three and is no longer the only one.

### 5. Coverage reporting

**The gap.** `go test -race -cover ./...` printed a number nobody collected, and
the Node suites produced none at all — `@vitest/coverage-v8` was a dependency
referenced by no config or script, so the number could not be produced even
locally. There was no way to tell from a build whether an untested branch in a
service that gates a disclosure queue is untested. The `db push` versus
`migrate deploy` episode described in
[`testing.md`](testing.md#what-running-the-suite-against-a-migrated-database-changed)
is the same problem in a different form: the suite passed and the thing it did
not exercise was invisible.

**What was done.** Both vitest configs produce coverage (`npm run coverage`
writes an HTML report) and CI collects it:

- **client** — a step in the existing `client` job, on every run. The suite is
  seconds, so the instrumentation is free. Baseline read: **2.75% statements,
  75.77% branches, 69.51% functions, 2.75% lines**. The statement figure is
  diluted by `all: true` counting every app file while a handful have unit
  tests; branches and functions are the numbers that move with the suite.
- **server** — its own job on `main` and the weekly run rather than on pull
  requests, because v8 instrumentation on top of the whole suite is not
  something to pay on every push. Baseline read: **73.99% statements, 55.64%
  branches, 76.55% functions, 76.8% lines**.
- both upload their report as a build artifact with a 14-day retention, so a
  weekly number can be compared with the previous one.

**Done: it is a gate.** The baselines above were read and floors set just under
them in each `vitest.config.ts`; the CI steps no longer pass
`continue-on-error`. A regression below a floor is a merge-time failure on
`main`; only the artifact upload stays best-effort, because an artifact-store
hiccup is not a coverage finding. The floors are floors, not targets — raise
them when the number is earned, never lower them to make a run pass.

**Still open.** The realtime service prints `-cover` in the `realtime` job but
collects nothing; piping that into the same artifact treatment is this step at a
smaller scale.

**Also worth adding.** The e2e suite is the fourth gate
([`testing.md`](testing.md#the-end-to-end-journeys)). Getting it green and
promoting it to required was worth more than any coverage number, because it is
the only thing that exercises the three processes together.

**Done: it runs green and it is required.** Fifteen tests — three cached
sign-ins and twelve journeys — run in the `docker` job after the seed, with no
gate. It paid for itself several times before promotion, on bugs that reading had
not found: every public page bounced a logged-out visitor to `/login?expired=1`
(registration was unreachable), a hydration mismatch in the push-prompt banner,
a cookie banner that covered the booking wizard's Back button, and a date picker
that offered days the clinician had no slots on. It also showed that the review
journey had never worked at all — its selectors named controls that do not exist
("Rate", not "Review"; an inline reply form, not a dialog), it booked whichever
clinician happened to sort second on a rating every seeded clinician ties at
zero, and it read a paginated response as a bare array. The rate-limit pressure
that shaped the suite is answered with Playwright's `storageState`: three
sign-ins in a setup project, reused, instead of roughly thirty.

### 6. ~~Editor concurrency on the care plan and safety plan~~ — done

**The gap.** `CarePlan` and `SafetyPlan` were single-row-per-owner documents with
no version column, no `updatedAt` precondition and no last-write-wins detection.
Two people editing the same plan concurrently — the normal case, since the plan is
*patient-owned* and a clinician may contribute to it — meant the second save
silently overwrote the first, and answered `200`.

**What was done.** Both models carry `version Int @default(0)`, and the content
write is a conditional `UPDATE`:

    updateMany({ where: { id, version: <the version shown> },
                 data: { ..., version: { increment: 1 } } })

Of two simultaneous saves exactly one matches a row, so the loser gets a 409
instead of a lost document. The condition is *inside* the write rather than
checked before it; a read-then-check-then-write lets both writers pass the check,
which is the race this closes. Prisma's `update` takes a unique `where` and cannot
express "and the version still matches", hence `updateMany`.

`version` is **required** on `UpdateCarePlanSchema`. Optional would mean an
un-updated client keeps writing and keeps overwriting — the guard would apply or
not depending on the shape of the request rather than on what happened to the
data, which is the same mistake as the 2FA enrolment guard keyed off a nullable
`password`. The safety plan's save takes it optionally because a first save
creates the row and there is nothing to be stale about.

**The client half, which was the open question.** A 409 the client ignores is a
half-fix, so `/dashboard/safety-plan` now sends the version its draft was based
on, and on 409 shows a persistent conflict panel offering two honest choices:
load the newer version, or keep the draft. It does **not** attempt a merge —
merging prose from two people automatically would be inventing text for a
document about someone's reasons to live. While the panel is up, Save is
disabled, because the text on screen cannot be saved and pretending otherwise
would invite the same failing save repeatedly.

Two details that are easy to get wrong and are pinned by tests:

- the version must advance after a successful save, or the *second* save
  conflicts with its own previous write;
- goals, steps and `lastReviewedAt` deliberately do **not** move the plan
  version, so a patient with an open editor does not get a spurious 409 for a
  document they never conflicted over.

`scripts/check-optimistic-writes.js` holds the mechanism, because the tests
cannot: a check-then-write still returns 409 in a serial suite, and only two
truly simultaneous writers expose the difference.

### 7. Smaller correctness items

Worth listing because they are cheap and real, not because they are interesting.

- **The specialty filter taxonomy** — already fixed. The sidebar now derives the
  list from `GET /api/doctors/specialties` rather than a hardcoded array of seven
  names against a seed that creates eight different ones. It was in the README's
  known limitations and no longer belongs there.
- **Two large client files.** `app/dashboard/profile/page.tsx` (635 lines) and
  `components/doctors/DoctorProfile.tsx` (706 lines). Decomposition was declined
  as low value relative to the regression risk, and that judgement still holds.
  It would be revisited if either grew much further, or if a defect in one proved
  hard to localise.
- **No read audit trail for clinical records.** ~~`AuditLog` records writes and
  admin actions; a clinician *opening* a disclosure, a journal or a briefing is
  not recorded.~~ **Done.** `AuditService.logRead` records the reader and the
  patient as separate fields — they are not derivable from each other, and an
  access trail that cannot answer "who has seen *this person*" is not an access
  trail. It covers the disclosure queue, the briefing, the message thread, and
  both plan documents, and deliberately does **not** record a patient opening
  their own record, because a log that fires on self-service is a log people stop
  reading.

  The rule that matters is that a failed audit write must not deny the read. If
  logging a read could reject, a database hiccup would become a clinician unable
  to open a crisis disclosure — so the failure mode of an access log is "a gap in
  the record", logged at `error` with the actor and subject, never "a patient does
  not get help". That trade is real and `clinical-read-audit.test.ts` asserts both
  halves of it.

  `scripts/check-read-audit.js` holds it in place, because a test cannot: the
  audit tests still pass if a `logRead` call is deleted from one method while the
  others remain instrumented.
- **Screening re-denial prompts.** Nothing currently reminds a patient that a
  trajectory is stale. Low risk, ordinary product work.
- **`GET /api/health/db` under-reported.** ~~It runs `SELECT 1`, so it proves
  MySQL is reachable and nothing about whether the schema matches.~~ **Done.** It
  now compares `INFORMATION_SCHEMA.TABLES` against the generated client's model
  list, so it catches the deploy failure that actually happens — the migration
  step is skipped, the probe goes green, and the first request touching a new
  column 500s. The comparison is case-insensitive because `lower_case_table_names`
  differs between Windows and Linux, and the missing names go to the log rather
  than to an unauthenticated response.

## Deliberately not planned

### Automated escalation of crisis phrases will not be built

**This is the most important line in this document.** Every disclosure in this
product prompts a human. No code path contacts an emergency service, no path
escalates to an on-call rota without a human in the loop, and the queue labels
every match as a keyword match rather than a clinical assessment. That will not
change.

The reasoning, in the order it mattered:

**A false positive in this direction costs a patient's privacy.** If the product
decides by itself that a patient is in danger, it has to act on something — call
someone, lock an account, alert a service. Every one of those is a disclosure of
a mental-health disclosure, made by software, on a signal that is explicitly not
a clinical assessment. The cost of a false positive here is not a clinician
spending thirty seconds.

**The signal is not good enough to act on.** The free-text matcher over-matches
by design and does not handle negation or euphemisms. `"I want to die"` and
`"I don't want to die"` produce the same alert. A system that over-matches can be
tuned toward precision — and the moment it is tuned toward precision it starts
missing the disclosures it exists to catch, which is the failure mode with no
recovery.

**The people in the loop are the safety property.** A clinician who reads an
alert decides what it means in the context of a person they may know. Software
cannot ask the patient what they meant, and cannot judge whether a disclosure was
a statement of intent, a quotation, a grief, or a metaphor. The whole design —
raise, page a human, record who responded and what they did — is built so that
judgment stays where it belongs.

**Escalation is also not something this product can do well.** There is no
on-call rota, no clinical coverage outside Indonesian hotlines, no SLA, and no
legal or regulatory basis for an automated notification to a third party on the
strength of a regex match.

If this is ever revisited, the preconditions are not technical: a clinical
governance review, a defined escalation path with human ownership, evidence that
the signal's precision supports acting on it, and a legal position on automated
disclosure. All four, before any code.

### Other things that will not be built

**A diagnosis engine.** `prd.md` asks for "suggested diagnostic routes". This
contradicts the disclaimer, and the disclaimer is the position taken here. The
AI briefing is advisory, is labelled as advisory, and is prompted not to state a
conclusion the data does not support.

**A model-based crisis classifier.** A regex has three properties that matter more
than recall: it cannot be unavailable, it never sends the most sensitive text a
patient can write to a third-party processor, and a clinician being paged can be
told exactly which phrase matched. "A model flagged this" is close to worthless
as a clinical justification. See
[ADR-0002](adr/0002-ai-provenance.md#why-crisis-triage-is-not-a-model).

**A generated safety plan or care plan.** A plan of goals is a clinical judgement
made with the person in front of you; a crisis plan may be read alone at the
worst possible moment and has to be in their own words. There is no endpoint to
call and none will be added.

**Confidence scores on triage.** A phrase either matches or it does not. A "low
confidence" tier implies a calibration that does not exist and gives clinicians a
number to over-trust.

**Refunds, proration, tax, invoicing or subscriptions for therapy packages.**
Prepaid integer-IDR blocks only. A therapist who leaves after a patient has paid
for five sessions is a real operational problem and it needs a product answer
about the money, not a Stripe-shaped API.

**Euphemism and negation handling in crisis triage.** Left unhandled on purpose.
Reliable negation detection needs semantics a regex does not have, and the failure
would be silent and in the dangerous direction. See
[ADR-0002](adr/0002-ai-provenance.md#what-we-deliberately-did-not-build).

## How to read the README's known limitations against this

| README says | Status |
|---|---|
| Checkout is read-before-create | **Already fixed.** The live-checkout claim is a unique `liveKey`, cleared on settlement. The README entry is stale. |
| Sequential integer ids exposed | Open. Theme 1. The largest security gap in the system. |
| Specialty filter taxonomy mismatch | **Already fixed.** The list is now derived from the server. The README entry is stale. |
| No payment gateway wired | Accurate and intentional. The interface and its invariants are complete; `getPaymentProvider` returns a stub. |
| Crisis triage is keyword matching | Accurate, and will stay that way. Deliberate, not a gap. |
| Clinical AI briefings are advisory | Accurate and intentional. |
| Two large client files | Accurate. Decomposition declined on cost/benefit. |
| e2e is opt-in and has not run in CI | **Already fixed.** It runs green as a required step in the `docker` job. The README entry is stale. |
| Two guard scripts do not work | **Already fixed.** `check-operators.js` is deleted (the compiler and `prisma validate` catch what it looked for) and `check-dependencies.js` is required. The README entry is stale. |

There is no entry here for `node-cron` not being a durable queue, because it is
no longer simply true: a lost tick is caught up rather than lost, and what
remains — the API process owning the schedule — is described in the README's
deploying section and in [`operations.md`](operations.md#the-cron-jobs-and-what-is-durable-about-them).

## Sequencing, roughly

Not a plan. An ordering, with the reasoning:

1. **Read auditing on clinical records.** It is the smallest gap with the largest
   clinical consequence, and it needs no schema work.
2. **Concurrency on the plan editors.** Twenty lines of server-side versioning
   for a data-loss bug in a patient-owned document.
3. ~~**Coverage reporting, non-blocking.**~~ Done: both baselines were read and
   the thresholds are gated, just below the measurements.
4. ~~**The guard scripts, then e2e to required.**~~ Both are "make CI mean what it
   claims to mean", and both are done: the guard scripts are required steps and
   the journeys run on every `docker` job, after the seed.
5. **Durable background work.** Needs a deployment shape decision (where does the
   worker run), so it follows rather than leads.
6. **A real payment provider**, then the race fix once the product has answered
   the double-purchase question. The two belong in the same conversation.
7. **UUIDv7.** Last, and on its own branch. It is the largest change, it touches
   everything, and doing it while other work is in flight multiplies the risk of
   a half-migrated identifier surface.