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

### 2. The payment race

**The gap.** Checkout is read-before-create. `PaymentService.createCheckout`
does a `findFirst` for an existing pending purchase, then a `create`. Two
concurrent requests both pass the check and both create, and a callback that
lands for both grants twice. Real, known, and documented in
[ADR-0003](adr/0003-payment-abstraction.md).

**Why it is still open.** The fix is not purely technical. A unique constraint on
in-flight orders means a patient who genuinely wants to buy the same package
twice cannot until the first order settles — arguably correct, and
nonetheless a product decision rather than an engineering one. That is why it was
documented rather than fixed in the same change as the rest of the payment work.

**The direction.** The options in order of preference:

1. **A unique constraint on `(userId, packageId)` for in-flight orders**, released
   once settled. Correct, cheap, and needs a product answer to the "buying three
   sessions twice by accident" support burden.
2. **Client-supplied idempotency keys**, the standard answer.
   `Appointment.idempotencyKey` already exists and works; the client does not
   generate one, and `PaymentOrder` has no equivalent column.
3. **`SELECT ... FOR UPDATE` on the package row.** Correct, most contention, for
   a case that is rare.

Option 2 is the one with the best cost/benefit if the product answer to option 1
is unclear — the mechanism is already in the codebase and tested.

**What does not change.** The `paidAt` invariant. Nothing about fixing the race
relaxes "an entitlement is legitimate only with a verified `paidAt` or an
explicit `grantedByUserId`".

### 3. Durable background work

**The gap.** All three scheduled jobs are `node-cron` inside the API process
(`reminders.ts`, `checkins.ts`). A restart, a crash, a deploy or a
scale-to-zero during the scheduled minute means that tick does not happen, and
there is no record that it was missed. See
[`operations.md`](operations.md#the-cron-jobs-and-why-they-are-not-durable).

**Why it has not been urgent.** The jobs send reminders and nudges. A missed
reminder is embarrassing; a missed *risk escalation* would not be. Today the two
are separate — `raiseRiskAlert` runs synchronously inside a request — which is
the correct design and is the main reason this is a Tier 2 item rather than
Tier 1. It becomes Tier 1 the moment anything safety-relevant is moved off the
request path.

**The direction.** A real queue. `Appointment.reminderSentAt` and friends already
work as a durable job table — a `SELECT ... FOR UPDATE SKIP LOCKED` loop over
rows whose sentinel is `NULL` is the standard MySQL 8 pattern and needs no new
infrastructure, only a process that is not the HTTP handler. The trigger would be
a webhook the API calls instead of a timer it owns.

**Also worth doing while in there.** The `acquireLock` `GET_LOCK` fallback in
`lib/cache.ts` cannot work as written, so the single-runner optimisation is
best-effort and silently stops working when Redis is down. It is documented as
such and the claims carry correctness, but it is the kind of thing that reads as
a lock and is not.

### 4. Advisory guard scripts

**The gap.** Two repo guards are wired into CI with `continue-on-error: true`
and neither works.

`check-operators.js` reports **195** findings, all of them false positives. It
declares a `CODE_POSITION` regex and never uses it; what it actually checks is
"does any typographic dash survive stripping", and it strips only `//` comments,
not `/* */` block comments. Every finding is prose in a doc comment, JSX text, or
an email template.

`check-dependencies.js` reports `@eslint/js` and `typescript-eslint` as unused
because it does not scan `eslint.config.mjs`, where they are used. It also does
not know that jsdom and testing-library arrive via Vitest's config rather than an
import.

**Why they are not simply fixed.** A required check that fails on its first run
is worse than an unwired one — it reddens `main` for no real finding and trains
everyone to ignore red. Both need real work (strip block comments and use
`CODE_POSITION`; scan config files and resolve framework-injected packages), and
until then advisory is the honest setting. `check-encoding.js` is green and
gating, and is the only one of the three that can be.

**The direction.** Fix the two scripts, run them, land whatever real findings
exist, then promote them. Worth doing properly because the *category* is right —
a platform holding mental-health data should not be able to accumulate an
unenumerated dependency or a typographic operator silently.

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

**What was done.** Both vitest configs now produce coverage (`npm run coverage`
writes an HTML report), with no thresholds, and CI collects it:

- **client** — a step in the existing `client` job, on every run. The suite is
  seconds, so the instrumentation is free. Baseline: **1.94% statements, 77%
  branches**, which is itself the argument against a threshold — the branch
  figure is high because it only counts loaded modules, while the statement
  figure counts everything, and neither has been read by anyone yet.
- **server** — its own advisory job, gated to `main` and the weekly run rather
  than to pull requests, because v8 instrumentation on top of the whole suite is
  not something to pay on every push. Both upload their report as a build
  artifact with a 14-day retention, so a weekly number can be compared with the
  previous one.

**Why it still cannot fail.** There are no thresholds, and the steps are
`continue-on-error`, so a coverage-tool regression cannot redden `main` either. A
threshold introduced at the same moment as the first measurement is a number
nobody has read yet, and this codebase would fail it by a wide margin — which
would then be "fixed" by adding exclusions until it passed. A number that appears
and is ignored is worth more than no number.

**Still open.** Promoting coverage to a gate, once someone has read the baseline.
The realtime service already prints `-cover` in the `realtime` job; collecting it
as an artifact would be a smaller version of the same step.

**Also worth adding.** The e2e suite is the fourth gate and it has never run in
automation ([`testing.md`](testing.md#why-e2e-is-not-required)). Getting it green
and promoting it to required is worth more than any coverage number, because it
is the only thing that exercises the three processes together.

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
- **`GET /api/health/db` under-reports.** It runs `SELECT 1`, so it proves
  MySQL is reachable and nothing about whether the schema matches.

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
| Checkout is read-before-create | Open. Theme 2. Needs a product decision, not an engineering one. |
| Sequential integer ids exposed | Open. Theme 1. The largest security gap in the system. |
| Specialty filter taxonomy mismatch | **Already fixed.** The list is now derived from the server. The README entry is stale. |
| No payment gateway wired | Accurate and intentional. The interface and its invariants are complete; `getPaymentProvider` returns a stub. |
| Crisis triage is keyword matching | Accurate, and will stay that way. Deliberate, not a gap. |
| Clinical AI briefings are advisory | Accurate and intentional. |
| Two large client files | Accurate. Decomposition declined on cost/benefit. |
| e2e is opt-in and has not run in CI | Accurate. Theme 5. |
| Two guard scripts do not work | Accurate. Theme 4. The operator count is now 195, not 190. |

There is no entry here for `node-cron` not being a durable queue. It belongs in
the README's known limitations, because it is a real operational gap with a
known failure mode rather than a deferred feature — see theme 3.

## Sequencing, roughly

Not a plan. An ordering, with the reasoning:

1. **Read auditing on clinical records.** It is the smallest gap with the largest
   clinical consequence, and it needs no schema work.
2. **Concurrency on the plan editors.** Twenty lines of server-side versioning
   for a data-loss bug in a patient-owned document.
3. **Coverage reporting, non-blocking.** Without a baseline, every later
   threshold is a guess.
4. **The guard scripts, then e2e to required.** Both are "make CI mean what it
   claims to mean", and both are cheap once green.
5. **Durable background work.** Needs a deployment shape decision (where does the
   worker run), so it follows rather than leads.
6. **A real payment provider**, then the race fix once the product has answered
   the double-purchase question. The two belong in the same conversation.
7. **UUIDv7.** Last, and on its own branch. It is the largest change, it touches
   everything, and doing it while other work is in flight multiplies the risk of
   a half-migrated identifier surface.